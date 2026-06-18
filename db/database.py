"""
SQLite data layer for ScholarLens.

Schema is designed to migrate cleanly to PostgreSQL later:
- Uses TEXT for IDs (UUIDs)
- Avoids SQLite-specific features
- All timestamps are ISO-8601 strings
"""

import sqlite3
import uuid
from datetime import datetime, timezone
from dataclasses import dataclass, field
from pathlib import Path

from config import SQLITE_PATH


# ── Data Models ──────────────────────────────────────────────

@dataclass
class Paper:
    id: str
    title: str
    authors: list[str]
    abstract: str
    year: int | None
    source: str                    # "upload", "arxiv", "pubmed", "semantic_scholar"
    doi: str | None = None
    arxiv_id: str | None = None
    filename: str | None = None
    full_text: str | None = None
    page_count: int | None = None
    user_id: str | None = None     # owner; NULL = legacy/unowned (pre-auth)
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    @staticmethod
    def new_id() -> str:
        return str(uuid.uuid4())


@dataclass
class Chunk:
    id: str
    paper_id: str
    text: str
    chunk_index: int
    section: str | None = None     # "abstract", "introduction", "methods", etc.
    page_number: int | None = None
    embedding_id: str | None = None  # ChromaDB doc ID

    @staticmethod
    def new_id() -> str:
        return str(uuid.uuid4())


@dataclass
class AnalysisResult:
    id: str
    paper_id: str
    analysis_type: str             # "summary", "methods", "findings", "limitations"
    content: str
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    @staticmethod
    def new_id() -> str:
        return str(uuid.uuid4())


@dataclass
class StoredClaim:
    """A cached, extracted claim from a paper.

    Grounded claims (Task 2) are extracted directly from source text and
    have evidence populated. Legacy claims (extracted from summaries) have
    evidence=None. Use the .grounded property to distinguish them.
    """
    id: str
    paper_id: str
    text: str
    section: str | None = None
    confidence: str | None = None
    evidence: str | None = None      # e.g. "n=142, p<0.01, between-subjects RCT"
    conditions: str | None = None    # e.g. "MBA negotiation scenario, single-session"
    source_quote: str | None = None  # short verbatim anchor from paper text
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    @property
    def grounded(self) -> bool:
        """True iff this claim was extracted from source text with evidence."""
        return self.evidence is not None

    @staticmethod
    def new_id() -> str:
        return str(uuid.uuid4())


@dataclass
class StoredRelationship:
    """A cached judgment between two claims."""
    id: str
    claim_lo: str
    claim_hi: str
    paper_a: str
    paper_b: str
    relationship: str
    category: str | None = None
    explanation: str | None = None
    stronger_evidence: str | None = None
    resolution: str | None = None
    similarity: float | None = None
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    @staticmethod
    def new_id() -> str:
        return str(uuid.uuid4())


@dataclass
class User:
    """An account. password_hash is bcrypt. api_key_encrypted is a Fernet
    token (the tenant's Anthropic key, encrypted at rest) — never plaintext."""
    id: str
    email: str
    password_hash: str
    api_key_encrypted: str | None = None
    model: str = "claude-haiku-4-5-20251001"
    digest_email: str | None = None
    library_name: str = "My Library"
    free_actions_used: int = 0
    free_sonnet_used: int = 0
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    @staticmethod
    def new_id() -> str:
        return str(uuid.uuid4())


@dataclass
class Session:
    """A login session. token is an opaque random string stored in an
    httpOnly cookie; expires_at is an ISO-8601 UTC timestamp."""
    token: str
    user_id: str
    created_at: str
    expires_at: str


# Columns the settings endpoint is allowed to update — whitelist guards the
# dynamic UPDATE below so no caller-supplied key can reach the SQL.
_ALLOWED_SETTING_COLS = {"model", "digest_email", "library_name", "api_key_encrypted"}

class Database:
    def __init__(self, db_path: Path = SQLITE_PATH):
        self.db_path = db_path
        self._init_db()

    def _get_conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def _init_db(self):
        conn = self._get_conn()
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS papers (
                id              TEXT PRIMARY KEY,
                title           TEXT NOT NULL,
                authors         TEXT NOT NULL,       -- JSON array
                abstract        TEXT NOT NULL DEFAULT '',
                year            INTEGER,
                source          TEXT NOT NULL,
                doi             TEXT,
                arxiv_id        TEXT,
                filename        TEXT,
                full_text       TEXT,
                page_count      INTEGER,
                user_id         TEXT REFERENCES users(id) ON DELETE CASCADE,
                created_at      TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS chunks (
                id              TEXT PRIMARY KEY,
                paper_id        TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                text            TEXT NOT NULL,
                chunk_index     INTEGER NOT NULL,
                section         TEXT,
                page_number     INTEGER,
                embedding_id    TEXT
            );

            CREATE TABLE IF NOT EXISTS analysis_results (
                id              TEXT PRIMARY KEY,
                paper_id        TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                analysis_type   TEXT NOT NULL,
                content         TEXT NOT NULL,
                created_at      TEXT NOT NULL
            );

            -- claims table includes evidence/conditions/source_quote
            -- for fresh installs. Existing DBs get these columns via ALTER below.
            CREATE TABLE IF NOT EXISTS claims (
                id              TEXT PRIMARY KEY,
                paper_id        TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                text            TEXT NOT NULL,
                section         TEXT,
                confidence      TEXT,
                evidence        TEXT,
                conditions      TEXT,
                source_quote    TEXT,
                created_at      TEXT NOT NULL
            );

            -- Cached judged relationships between two claims.
            -- claim_lo / claim_hi are the two claim IDs sorted lexically so each
            -- unordered pair has exactly one row (idempotent upsert key).
            CREATE TABLE IF NOT EXISTS relationships (
                id              TEXT PRIMARY KEY,
                claim_lo        TEXT NOT NULL,
                claim_hi        TEXT NOT NULL,
                paper_a         TEXT NOT NULL,
                paper_b         TEXT NOT NULL,
                relationship    TEXT NOT NULL,
                category        TEXT,
                explanation     TEXT,
                stronger_evidence TEXT,
                resolution      TEXT,
                similarity      REAL,
                created_at      TEXT NOT NULL,
                UNIQUE(claim_lo, claim_hi)
            );

            -- Hypothesis output cache.
            -- Keyed on a hash of (paper scope + relationships watermark + question).
            -- Avoids re-running 5-8 LLM calls when inputs haven't changed.
            CREATE TABLE IF NOT EXISTS hypothesis_cache (
                cache_key       TEXT PRIMARY KEY,
                payload         TEXT NOT NULL,   -- JSON array of serialised Hypothesis objects
                grounding       TEXT NOT NULL,   -- "detected_conflicts" | "single_paper_gaps"
                created_at      TEXT NOT NULL
            );

            -- Accounts. password_hash is bcrypt; api_key_encrypted is a Fernet
            -- token (tenant Anthropic key, encrypted at rest — never plaintext).
            CREATE TABLE IF NOT EXISTS users (
                id                TEXT PRIMARY KEY,
                email             TEXT NOT NULL UNIQUE,
                password_hash     TEXT NOT NULL,
                api_key_encrypted TEXT,
                model             TEXT NOT NULL DEFAULT 'claude-haiku-4-5-20251001',
                digest_email      TEXT,
                library_name      TEXT NOT NULL DEFAULT 'My Library',
                free_actions_used INTEGER NOT NULL DEFAULT 0,
                free_sonnet_used  INTEGER NOT NULL DEFAULT 0,
                created_at        TEXT NOT NULL
            );

            -- Login sessions. token lives in an httpOnly cookie; rows are
            -- removed on logout or when expired.
            CREATE TABLE IF NOT EXISTS sessions (
                token       TEXT PRIMARY KEY,
                user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at  TEXT NOT NULL,
                expires_at  TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_chunks_paper ON chunks(paper_id);
            CREATE INDEX IF NOT EXISTS idx_analysis_paper ON analysis_results(paper_id);
            CREATE INDEX IF NOT EXISTS idx_papers_source ON papers(source);
            CREATE INDEX IF NOT EXISTS idx_claims_paper ON claims(paper_id);
            CREATE INDEX IF NOT EXISTS idx_rel_lo ON relationships(claim_lo);
            CREATE INDEX IF NOT EXISTS idx_rel_hi ON relationships(claim_hi);
            CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
        """)

        # Idempotent migration for existing DBs that have the old claims table
        # without evidence/conditions/source_quote columns.
        existing_cols = {
            row[1] for row in conn.execute("PRAGMA table_info(claims)").fetchall()
        }
        for col in ("evidence", "conditions", "source_quote"):
            if col not in existing_cols:
                conn.execute(f"ALTER TABLE claims ADD COLUMN {col} TEXT")

        # Idempotent migration: add papers.user_id (owner) to existing DBs.
        # Added without a REFERENCES clause here (SQLite ALTER limitation);
        # fresh DBs get the FK via CREATE TABLE above. Existing rows stay NULL
        # (unowned) until adopted by the first registered user.
        paper_cols = {
            row[1] for row in conn.execute("PRAGMA table_info(papers)").fetchall()
        }
        if "user_id" not in paper_cols:
            conn.execute("ALTER TABLE papers ADD COLUMN user_id TEXT")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_papers_user ON papers(user_id)")

        # Idempotent migration: free-tier Sonnet usage counter on existing DBs.
        user_cols = {
            row[1] for row in conn.execute("PRAGMA table_info(users)").fetchall()
        }
        if "free_actions_used" not in user_cols:
            conn.execute("ALTER TABLE users ADD COLUMN free_actions_used INTEGER NOT NULL DEFAULT 0")
        if "free_sonnet_used" not in user_cols:
            conn.execute("ALTER TABLE users ADD COLUMN free_sonnet_used INTEGER NOT NULL DEFAULT 0")

        conn.commit()
        conn.close()

    # ── Paper CRUD ───────────────────────────────────────────

    def insert_paper(self, paper: Paper) -> str:
        import json
        conn = self._get_conn()
        conn.execute(
            """INSERT INTO papers
               (id, title, authors, abstract, year, source, doi, arxiv_id,
                filename, full_text, page_count, user_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                paper.id, paper.title, json.dumps(paper.authors),
                paper.abstract, paper.year, paper.source, paper.doi,
                paper.arxiv_id, paper.filename, paper.full_text,
                paper.page_count, paper.user_id, paper.created_at,
            ),
        )
        conn.commit()
        conn.close()
        return paper.id

    def get_paper(self, paper_id: str) -> Paper | None:
        import json
        conn = self._get_conn()
        row = conn.execute("SELECT * FROM papers WHERE id = ?", (paper_id,)).fetchone()
        conn.close()
        if not row:
            return None
        return Paper(
            id=row["id"], title=row["title"],
            authors=json.loads(row["authors"]),
            abstract=row["abstract"], year=row["year"],
            source=row["source"], doi=row["doi"],
            arxiv_id=row["arxiv_id"], filename=row["filename"],
            full_text=row["full_text"], page_count=row["page_count"],
            user_id=row["user_id"],
            created_at=row["created_at"],
        )

    def list_papers(self, limit: int = 50, offset: int = 0,
                    user_id: str | None = None) -> list[Paper]:
        """List papers. When user_id is given, only that owner's papers are
        returned (the multi-user scoping path); when None, all papers (used by
        legacy/internal callers during the transition)."""
        import json
        conn = self._get_conn()
        if user_id is not None:
            rows = conn.execute(
                "SELECT * FROM papers WHERE user_id = ? "
                "ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (user_id, limit, offset),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM papers ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()
        conn.close()
        return [
            Paper(
                id=r["id"], title=r["title"],
                authors=json.loads(r["authors"]),
                abstract=r["abstract"], year=r["year"],
                source=r["source"], doi=r["doi"],
                arxiv_id=r["arxiv_id"], filename=r["filename"],
                full_text=r["full_text"], page_count=r["page_count"],
                user_id=r["user_id"],
                created_at=r["created_at"],
            )
            for r in rows
        ]

    def delete_paper(self, paper_id: str) -> bool:
        conn = self._get_conn()
        cursor = conn.execute("DELETE FROM papers WHERE id = ?", (paper_id,))
        conn.commit()
        deleted = cursor.rowcount > 0
        conn.close()
        return deleted

    # ── Ownership helpers (multi-user scoping) ───────────────

    def set_paper_owner(self, paper_id: str, user_id: str) -> None:
        """Stamp ownership on a paper (called right after ingest/import)."""
        conn = self._get_conn()
        conn.execute("UPDATE papers SET user_id = ? WHERE id = ?", (user_id, paper_id))
        conn.commit()
        conn.close()

    def list_paper_ids_for_user(self, user_id: str) -> list[str]:
        """All paper IDs owned by a user. Endpoints pass this set into the
        aggregate features (search / contradictions / hypotheses / graph) so
        cross-paper reasoning never reaches another user's library."""
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT id FROM papers WHERE user_id = ?", (user_id,)
        ).fetchall()
        conn.close()
        return [r["id"] for r in rows]

    def count_users(self) -> int:
        conn = self._get_conn()
        n = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        conn.close()
        return int(n)

    def adopt_orphan_papers(self, user_id: str) -> int:
        """Assign all currently-unowned papers to a user. Used once, when the
        first account registers, so pre-auth test data isn't stranded.
        Returns the number of rows adopted."""
        conn = self._get_conn()
        cur = conn.execute(
            "UPDATE papers SET user_id = ? WHERE user_id IS NULL", (user_id,)
        )
        conn.commit()
        n = cur.rowcount
        conn.close()
        return n

    # ── Chunk CRUD ───────────────────────────────────────────

    def insert_chunks(self, chunks: list[Chunk]):
        conn = self._get_conn()
        conn.executemany(
            """INSERT INTO chunks
               (id, paper_id, text, chunk_index, section, page_number, embedding_id)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            [
                (c.id, c.paper_id, c.text, c.chunk_index, c.section,
                 c.page_number, c.embedding_id)
                for c in chunks
            ],
        )
        conn.commit()
        conn.close()

    def get_chunks_for_paper(self, paper_id: str) -> list[Chunk]:
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT * FROM chunks WHERE paper_id = ? ORDER BY chunk_index",
            (paper_id,),
        ).fetchall()
        conn.close()
        return [
            Chunk(
                id=r["id"], paper_id=r["paper_id"], text=r["text"],
                chunk_index=r["chunk_index"], section=r["section"],
                page_number=r["page_number"], embedding_id=r["embedding_id"],
            )
            for r in rows
        ]

    # ── Analysis CRUD ────────────────────────────────────────

    def insert_analysis(self, result: AnalysisResult) -> str:
        conn = self._get_conn()
        conn.execute(
            """INSERT INTO analysis_results (id, paper_id, analysis_type, content, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            (result.id, result.paper_id, result.analysis_type,
             result.content, result.created_at),
        )
        conn.commit()
        conn.close()
        return result.id

    def get_analyses_for_paper(self, paper_id: str) -> list[AnalysisResult]:
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT * FROM analysis_results WHERE paper_id = ? ORDER BY created_at",
            (paper_id,),
        ).fetchall()
        conn.close()
        return [
            AnalysisResult(
                id=r["id"], paper_id=r["paper_id"],
                analysis_type=r["analysis_type"],
                content=r["content"], created_at=r["created_at"],
            )
            for r in rows
        ]

    # ── Dedup ────────────────────────────────────────────────

    @staticmethod
    def _title_key(title: str) -> str:
        """Normalized key for duplicate detection — lowercased, alphanumeric only."""
        import re
        return re.sub(r"[^a-z0-9]", "", (title or "").lower())[:80]

    def find_duplicate(self, title: str, doi: str | None = None,
                       arxiv_id: str | None = None) -> Paper | None:
        """
        Return an existing paper that appears to be the same as the incoming one.
        Matches on DOI, then arXiv ID, then a normalized title key.
        """
        import json
        conn = self._get_conn()
        try:
            if doi:
                row = conn.execute("SELECT * FROM papers WHERE doi = ?", (doi,)).fetchone()
                if row:
                    return self._row_to_paper(row, json)
            if arxiv_id:
                row = conn.execute("SELECT * FROM papers WHERE arxiv_id = ?", (arxiv_id,)).fetchone()
                if row:
                    return self._row_to_paper(row, json)
            key = self._title_key(title)
            if key:
                rows = conn.execute("SELECT * FROM papers").fetchall()
                for row in rows:
                    if self._title_key(row["title"]) == key:
                        return self._row_to_paper(row, json)
            return None
        finally:
            conn.close()

    @staticmethod
    def _row_to_paper(row, json) -> Paper:
        return Paper(
            id=row["id"], title=row["title"], authors=json.loads(row["authors"]),
            abstract=row["abstract"], year=row["year"], source=row["source"],
            doi=row["doi"], arxiv_id=row["arxiv_id"], filename=row["filename"],
            full_text=row["full_text"], page_count=row["page_count"],
            created_at=row["created_at"],
        )

    # ── Claims cache ─────────────────────────────────────────

    def insert_claims(self, claims: list[StoredClaim]):
        conn = self._get_conn()
        conn.executemany(
            """INSERT INTO claims
               (id, paper_id, text, section, confidence,
                evidence, conditions, source_quote, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                (c.id, c.paper_id, c.text, c.section, c.confidence,
                 c.evidence, c.conditions, c.source_quote, c.created_at)
                for c in claims
            ],
        )
        conn.commit()
        conn.close()

    def get_claims_for_paper(self, paper_id: str) -> list[StoredClaim]:
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT * FROM claims WHERE paper_id = ?", (paper_id,)
        ).fetchall()
        conn.close()
        return [
            StoredClaim(
                id=r["id"], paper_id=r["paper_id"], text=r["text"],
                section=r["section"], confidence=r["confidence"],
                evidence=r["evidence"], conditions=r["conditions"],
                source_quote=r["source_quote"], created_at=r["created_at"],
            )
            for r in rows
        ]

    def delete_claims_for_paper(self, paper_id: str):
        conn = self._get_conn()
        conn.execute("DELETE FROM claims WHERE paper_id = ?", (paper_id,))
        conn.commit()
        conn.close()

    # ── Relationships cache ──────────────────────────────────

    def upsert_relationship(self, rel: "StoredRelationship"):
        """Insert or replace a judged relationship (idempotent on the claim pair)."""
        lo, hi = sorted([rel.claim_lo, rel.claim_hi])
        conn = self._get_conn()
        conn.execute(
            """INSERT INTO relationships
               (id, claim_lo, claim_hi, paper_a, paper_b, relationship, category,
                explanation, stronger_evidence, resolution, similarity, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(claim_lo, claim_hi) DO UPDATE SET
                 relationship=excluded.relationship, category=excluded.category,
                 explanation=excluded.explanation, stronger_evidence=excluded.stronger_evidence,
                 resolution=excluded.resolution, similarity=excluded.similarity,
                 created_at=excluded.created_at""",
            (rel.id, lo, hi, rel.paper_a, rel.paper_b, rel.relationship, rel.category,
             rel.explanation, rel.stronger_evidence, rel.resolution, rel.similarity, rel.created_at),
        )
        conn.commit()
        conn.close()

    def get_relationship(self, claim_a: str, claim_b: str) -> "StoredRelationship | None":
        lo, hi = sorted([claim_a, claim_b])
        conn = self._get_conn()
        row = conn.execute(
            "SELECT * FROM relationships WHERE claim_lo = ? AND claim_hi = ?", (lo, hi)
        ).fetchone()
        conn.close()
        if not row:
            return None
        return self._row_to_rel(row)

    def list_relationships(
        self,
        paper_ids: list[str] | None = None,
        relationships: list[str] | None = None,
    ) -> list["StoredRelationship"]:
        """
        List cached relationships, optionally filtered.

        Args:
            paper_ids: If given, only return relationships where paper_a OR
                       paper_b is in this set.
            relationships: If given, only return rows whose relationship field
                           is in this list. e.g. ["contradiction", "nuance"]
        """
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT * FROM relationships ORDER BY created_at DESC"
        ).fetchall()
        conn.close()
        rels = [self._row_to_rel(r) for r in rows]

        if paper_ids:
            pid_set = set(paper_ids)
            rels = [r for r in rels if r.paper_a in pid_set or r.paper_b in pid_set]

        if relationships:
            rel_set = set(relationships)
            rels = [r for r in rels if r.relationship in rel_set]

        return rels

    def relationships_watermark(self, paper_ids: list[str] | None = None) -> str:
        """
        Return the max created_at timestamp over relationships in scope.
        Used as a cache invalidation signal: if this changes, the hypothesis
        cache for those papers is stale.
        Returns empty string when no relationships exist yet.
        """
        rels = self.list_relationships(paper_ids=paper_ids)
        if not rels:
            return ""
        return max(r.created_at for r in rels)

    @staticmethod
    def _row_to_rel(r) -> "StoredRelationship":
        return StoredRelationship(
            id=r["id"], claim_lo=r["claim_lo"], claim_hi=r["claim_hi"],
            paper_a=r["paper_a"], paper_b=r["paper_b"], relationship=r["relationship"],
            category=r["category"], explanation=r["explanation"],
            stronger_evidence=r["stronger_evidence"], resolution=r["resolution"],
            similarity=r["similarity"], created_at=r["created_at"],
        )

    # ── Hypothesis cache ─────────────────────────────────────

    def get_hypothesis_cache(self, cache_key: str) -> dict | None:
        """
        Return cached hypothesis payload for this key, or None if missing.
        Payload is a dict with keys: "hypotheses" (list), "grounding" (str).
        """
        conn = self._get_conn()
        row = conn.execute(
            "SELECT payload, grounding FROM hypothesis_cache WHERE cache_key = ?",
            (cache_key,),
        ).fetchone()
        conn.close()
        if not row:
            return None
        import json
        return {"hypotheses": json.loads(row["payload"]), "grounding": row["grounding"]}

    def set_hypothesis_cache(self, cache_key: str, hypotheses: list, grounding: str):
        """
        Persist a hypothesis generation result.
        hypotheses is a list of dicts (serialisable Hypothesis objects).
        grounding is "detected_conflicts" or "single_paper_gaps".
        """
        import json
        conn = self._get_conn()
        conn.execute(
            """INSERT INTO hypothesis_cache (cache_key, payload, grounding, created_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(cache_key) DO UPDATE SET
                 payload=excluded.payload, grounding=excluded.grounding,
                 created_at=excluded.created_at""",
            (cache_key, json.dumps(hypotheses), grounding,
             datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()
        conn.close()

    def invalidate_hypothesis_cache(self, cache_key: str):
        """Explicitly delete one cache entry (used by force_refresh path)."""
        conn = self._get_conn()
        conn.execute(
            "DELETE FROM hypothesis_cache WHERE cache_key = ?", (cache_key,)
        )
        conn.commit()
        conn.close()

    # ── Users / Auth ─────────────────────────────────────────

    def _row_to_user(self, row) -> User:
        return User(
            id=row["id"],
            email=row["email"],
            password_hash=row["password_hash"],
            api_key_encrypted=row["api_key_encrypted"],
            model=row["model"],
            digest_email=row["digest_email"],
            library_name=row["library_name"],
            free_actions_used=row["free_actions_used"],
            free_sonnet_used=row["free_sonnet_used"],
            created_at=row["created_at"],
        )

    def create_user(self, email: str, password_hash: str) -> User:
        """Insert a new account. Email is normalised lower/stripped by the
        caller. Raises sqlite3.IntegrityError if the email already exists
        (the UNIQUE constraint), which the endpoint maps to a 409."""
        user = User(id=User.new_id(), email=email, password_hash=password_hash)
        conn = self._get_conn()
        conn.execute(
            """INSERT INTO users
               (id, email, password_hash, api_key_encrypted, model,
                digest_email, library_name, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (user.id, user.email, user.password_hash, user.api_key_encrypted,
             user.model, user.digest_email, user.library_name, user.created_at),
        )
        conn.commit()
        conn.close()
        return user

    def get_user_by_email(self, email: str) -> User | None:
        conn = self._get_conn()
        row = conn.execute(
            "SELECT * FROM users WHERE email = ?", (email,)
        ).fetchone()
        conn.close()
        return self._row_to_user(row) if row else None

    def get_user_by_id(self, user_id: str) -> User | None:
        conn = self._get_conn()
        row = conn.execute(
            "SELECT * FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        conn.close()
        return self._row_to_user(row) if row else None

    def increment_usage(self, user_id: str, is_sonnet: bool) -> tuple[int, int]:
        """Bump the total free-action counter (and the Sonnet sub-counter when
        the action used Sonnet). Returns (free_actions_used, free_sonnet_used)."""
        conn = self._get_conn()
        if is_sonnet:
            conn.execute(
                "UPDATE users SET free_actions_used = free_actions_used + 1, "
                "free_sonnet_used = free_sonnet_used + 1 WHERE id = ?",
                (user_id,),
            )
        else:
            conn.execute(
                "UPDATE users SET free_actions_used = free_actions_used + 1 WHERE id = ?",
                (user_id,),
            )
        conn.commit()
        row = conn.execute(
            "SELECT free_actions_used, free_sonnet_used FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
        conn.close()
        return (row["free_actions_used"], row["free_sonnet_used"]) if row else (0, 0)

    def update_user_settings(self, user_id: str, **fields) -> None:
        """Update only the whitelisted settings columns that were passed.
        The column names are validated against _ALLOWED_SETTING_COLS so the
        dynamic SET clause can never contain caller-supplied identifiers;
        values are always bound as parameters."""
        cols = {k: v for k, v in fields.items() if k in _ALLOWED_SETTING_COLS}
        if not cols:
            return
        set_clause = ", ".join(f"{c} = ?" for c in cols)
        values = list(cols.values()) + [user_id]
        conn = self._get_conn()
        conn.execute(f"UPDATE users SET {set_clause} WHERE id = ?", values)
        conn.commit()
        conn.close()

    # ── Sessions ─────────────────────────────────────────────

    def create_session(self, user_id: str, token: str, expires_at: str) -> Session:
        sess = Session(
            token=token,
            user_id=user_id,
            created_at=datetime.now(timezone.utc).isoformat(),
            expires_at=expires_at,
        )
        conn = self._get_conn()
        # Purge expired sessions for this user on login to prevent unbounded table growth.
        conn.execute(
            "DELETE FROM sessions WHERE user_id = ? AND expires_at < datetime('now')",
            (user_id,),
        )
        conn.execute(
            "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (sess.token, sess.user_id, sess.created_at, sess.expires_at),
        )
        conn.commit()
        conn.close()
        return sess

    def get_session(self, token: str) -> Session | None:
        conn = self._get_conn()
        row = conn.execute(
            "SELECT * FROM sessions WHERE token = ?", (token,)
        ).fetchone()
        conn.close()
        if not row:
            return None
        return Session(
            token=row["token"],
            user_id=row["user_id"],
            created_at=row["created_at"],
            expires_at=row["expires_at"],
        )

    def delete_session(self, token: str) -> None:
        conn = self._get_conn()
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
        conn.commit()
        conn.close()

    def delete_sessions_for_user(self, user_id: str) -> None:
        """Log out everywhere — used on password change or explicit 'log out
        all sessions'."""
        conn = self._get_conn()
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        conn.commit()
        conn.close()
