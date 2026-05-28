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


# ── Database Manager ─────────────────────────────────────────

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

            CREATE INDEX IF NOT EXISTS idx_chunks_paper ON chunks(paper_id);
            CREATE INDEX IF NOT EXISTS idx_analysis_paper ON analysis_results(paper_id);
            CREATE INDEX IF NOT EXISTS idx_papers_source ON papers(source);
            CREATE INDEX IF NOT EXISTS idx_claims_paper ON claims(paper_id);
            CREATE INDEX IF NOT EXISTS idx_rel_lo ON relationships(claim_lo);
            CREATE INDEX IF NOT EXISTS idx_rel_hi ON relationships(claim_hi);
        """)

        # Idempotent migration for existing DBs that have the old claims table
        # without evidence/conditions/source_quote columns.
        existing_cols = {
            row[1] for row in conn.execute("PRAGMA table_info(claims)").fetchall()
        }
        for col in ("evidence", "conditions", "source_quote"):
            if col not in existing_cols:
                conn.execute(f"ALTER TABLE claims ADD COLUMN {col} TEXT")

        conn.commit()
        conn.close()

    # ── Paper CRUD ───────────────────────────────────────────

    def insert_paper(self, paper: Paper) -> str:
        import json
        conn = self._get_conn()
        conn.execute(
            """INSERT INTO papers
               (id, title, authors, abstract, year, source, doi, arxiv_id,
                filename, full_text, page_count, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                paper.id, paper.title, json.dumps(paper.authors),
                paper.abstract, paper.year, paper.source, paper.doi,
                paper.arxiv_id, paper.filename, paper.full_text,
                paper.page_count, paper.created_at,
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
            created_at=row["created_at"],
        )

    def list_papers(self, limit: int = 50, offset: int = 0) -> list[Paper]:
        import json
        conn = self._get_conn()
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
