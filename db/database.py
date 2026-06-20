"""
PostgreSQL data layer for ScholarLens (migrated from SQLite).

Uses psycopg2 with a simple connection-per-call pattern matching the
original SQLite style. Connection string read from DATABASE_URL env var
(set to Supabase URI in production).
"""

import json
import re
import uuid
from datetime import datetime, timezone
from dataclasses import dataclass, field

import psycopg2
import psycopg2.extras
from psycopg2.extras import RealDictCursor

from config import settings


# â”€â”€ Data Models â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _clean(val):
    """Strip NUL bytes from strings — Postgres rejects them in string literals.
    PDFs often contain embedded NUL bytes from binary data or encoding artifacts."""
    if isinstance(val, str):
        return val.replace("\x00", "")
    return val


@dataclass
class Paper:
    id: str
    title: str
    authors: list[str]
    abstract: str
    year: int | None
    source: str
    doi: str | None = None
    arxiv_id: str | None = None
    filename: str | None = None
    full_text: str | None = None
    page_count: int | None = None
    user_id: str | None = None
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
    section: str | None = None
    page_number: int | None = None
    embedding_id: str | None = None

    @staticmethod
    def new_id() -> str:
        return str(uuid.uuid4())


@dataclass
class AnalysisResult:
    id: str
    paper_id: str
    analysis_type: str
    content: str
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    @staticmethod
    def new_id() -> str:
        return str(uuid.uuid4())


@dataclass
class StoredClaim:
    id: str
    paper_id: str
    text: str
    section: str | None = None
    confidence: str | None = None
    evidence: str | None = None
    conditions: str | None = None
    source_quote: str | None = None
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    @property
    def grounded(self) -> bool:
        return self.evidence is not None

    @staticmethod
    def new_id() -> str:
        return str(uuid.uuid4())


@dataclass
class StoredRelationship:
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
    token: str
    user_id: str
    created_at: str
    expires_at: str


_ALLOWED_SETTING_COLS = {"model", "digest_email", "library_name", "api_key_encrypted"}


class Database:
    def __init__(self):
        self._dsn = settings.database_url
        self._init_db()

    def _get_conn(self):
        return psycopg2.connect(self._dsn, cursor_factory=RealDictCursor)

    def _init_db(self):
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("""
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
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS papers (
                id              TEXT PRIMARY KEY,
                title           TEXT NOT NULL,
                authors         TEXT NOT NULL,
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
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS chunks (
                id              TEXT PRIMARY KEY,
                paper_id        TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                text            TEXT NOT NULL,
                chunk_index     INTEGER NOT NULL,
                section         TEXT,
                page_number     INTEGER,
                embedding_id    TEXT
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS analysis_results (
                id              TEXT PRIMARY KEY,
                paper_id        TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                analysis_type   TEXT NOT NULL,
                content         TEXT NOT NULL,
                created_at      TEXT NOT NULL
            )
        """)
        cur.execute("""
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
            )
        """)
        cur.execute("""
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
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS hypothesis_cache (
                cache_key       TEXT PRIMARY KEY,
                payload         TEXT NOT NULL,
                grounding       TEXT NOT NULL,
                created_at      TEXT NOT NULL
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                token       TEXT PRIMARY KEY,
                user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at  TEXT NOT NULL,
                expires_at  TEXT NOT NULL
            )
        """)
        # Indexes
        for idx_sql in [
            "CREATE INDEX IF NOT EXISTS idx_chunks_paper ON chunks(paper_id)",
            "CREATE INDEX IF NOT EXISTS idx_analysis_paper ON analysis_results(paper_id)",
            "CREATE INDEX IF NOT EXISTS idx_papers_source ON papers(source)",
            "CREATE INDEX IF NOT EXISTS idx_claims_paper ON claims(paper_id)",
            "CREATE INDEX IF NOT EXISTS idx_rel_lo ON relationships(claim_lo)",
            "CREATE INDEX IF NOT EXISTS idx_rel_hi ON relationships(claim_hi)",
            "CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)",
            "CREATE INDEX IF NOT EXISTS idx_papers_user ON papers(user_id)",
        ]:
            cur.execute(idx_sql)
        conn.commit()
        cur.close()
        conn.close()

    # â”€â”€ Paper CRUD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    def insert_paper(self, paper: Paper) -> str:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO papers
               (id, title, authors, abstract, year, source, doi, arxiv_id,
                filename, full_text, page_count, user_id, created_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (_clean(paper.id), _clean(paper.title), json.dumps(paper.authors),
             _clean(paper.abstract), paper.year, _clean(paper.source), _clean(paper.doi),
             _clean(paper.arxiv_id), _clean(paper.filename), _clean(paper.full_text),
             paper.page_count, paper.user_id, paper.created_at),
        )
        conn.commit()
        cur.close()
        conn.close()
        return paper.id

    def get_paper(self, paper_id: str) -> Paper | None:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("SELECT * FROM papers WHERE id = %s", (paper_id,))
        row = cur.fetchone()
        cur.close()
        conn.close()
        return self._row_to_paper(row) if row else None

    def list_papers(self, limit: int = 50, offset: int = 0,
                    user_id: str | None = None) -> list[Paper]:
        conn = self._get_conn()
        cur = conn.cursor()
        if user_id is not None:
            cur.execute(
                "SELECT * FROM papers WHERE user_id = %s "
                "ORDER BY created_at DESC LIMIT %s OFFSET %s",
                (user_id, limit, offset),
            )
        else:
            cur.execute(
                "SELECT * FROM papers ORDER BY created_at DESC LIMIT %s OFFSET %s",
                (limit, offset),
            )
        rows = cur.fetchall()
        cur.close()
        conn.close()
        return [self._row_to_paper(r) for r in rows]

    def delete_paper(self, paper_id: str) -> bool:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("DELETE FROM papers WHERE id = %s", (paper_id,))
        deleted = cur.rowcount > 0
        conn.commit()
        cur.close()
        conn.close()
        return deleted

    # â”€â”€ Ownership helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    def set_paper_owner(self, paper_id: str, user_id: str) -> None:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("UPDATE papers SET user_id = %s WHERE id = %s", (user_id, paper_id))
        conn.commit()
        cur.close()
        conn.close()

    def list_paper_ids_for_user(self, user_id: str) -> list[str]:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("SELECT id FROM papers WHERE user_id = %s", (user_id,))
        rows = cur.fetchall()
        cur.close()
        conn.close()
        return [r["id"] for r in rows]

    def count_users(self) -> int:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) as count FROM users")
        n = cur.fetchone()["count"]
        cur.close()
        conn.close()
        return int(n)

    def adopt_orphan_papers(self, user_id: str) -> int:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("UPDATE papers SET user_id = %s WHERE user_id IS NULL", (user_id,))
        n = cur.rowcount
        conn.commit()
        cur.close()
        conn.close()
        return n

    # â”€â”€ Chunk CRUD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    def insert_chunks(self, chunks: list[Chunk]):
        conn = self._get_conn()
        cur = conn.cursor()
        psycopg2.extras.execute_batch(
            cur,
            """INSERT INTO chunks
               (id, paper_id, text, chunk_index, section, page_number, embedding_id)
               VALUES (%s, %s, %s, %s, %s, %s, %s)""",
            [(c.id, c.paper_id, _clean(c.text), c.chunk_index, _clean(c.section),
              c.page_number, c.embedding_id) for c in chunks],
        )
        conn.commit()
        cur.close()
        conn.close()

    def get_chunks_for_paper(self, paper_id: str) -> list[Chunk]:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            "SELECT * FROM chunks WHERE paper_id = %s ORDER BY chunk_index", (paper_id,)
        )
        rows = cur.fetchall()
        cur.close()
        conn.close()
        return [
            Chunk(id=r["id"], paper_id=r["paper_id"], text=r["text"],
                  chunk_index=r["chunk_index"], section=r["section"],
                  page_number=r["page_number"], embedding_id=r["embedding_id"])
            for r in rows
        ]

    # â”€â”€ Analysis CRUD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    def insert_analysis(self, result: AnalysisResult) -> str:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO analysis_results (id, paper_id, analysis_type, content, created_at)
               VALUES (%s, %s, %s, %s, %s)""",
            (result.id, result.paper_id, result.analysis_type,
             _clean(result.content), result.created_at),
        )
        conn.commit()
        cur.close()
        conn.close()
        return result.id

    def get_analyses_for_paper(self, paper_id: str) -> list[AnalysisResult]:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            "SELECT * FROM analysis_results WHERE paper_id = %s ORDER BY created_at",
            (paper_id,),
        )
        rows = cur.fetchall()
        cur.close()
        conn.close()
        return [
            AnalysisResult(id=r["id"], paper_id=r["paper_id"],
                           analysis_type=r["analysis_type"],
                           content=r["content"], created_at=r["created_at"])
            for r in rows
        ]

    # â”€â”€ Dedup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    @staticmethod
    def _title_key(title: str) -> str:
        return re.sub(r"[^a-z0-9]", "", (title or "").lower())[:80]

    def find_duplicate(self, title: str, doi: str | None = None,
                       arxiv_id: str | None = None) -> Paper | None:
        conn = self._get_conn()
        cur = conn.cursor()
        try:
            if doi:
                cur.execute("SELECT * FROM papers WHERE doi = %s", (doi,))
                row = cur.fetchone()
                if row:
                    return self._row_to_paper(row)
            if arxiv_id:
                cur.execute("SELECT * FROM papers WHERE arxiv_id = %s", (arxiv_id,))
                row = cur.fetchone()
                if row:
                    return self._row_to_paper(row)
            key = self._title_key(title)
            if key:
                cur.execute("SELECT * FROM papers")
                for row in cur.fetchall():
                    if self._title_key(row["title"]) == key:
                        return self._row_to_paper(row)
            return None
        finally:
            cur.close()
            conn.close()

    @staticmethod
    def _row_to_paper(row) -> Paper:
        return Paper(
            id=row["id"], title=row["title"],
            authors=json.loads(row["authors"]),
            abstract=row["abstract"], year=row["year"],
            source=row["source"], doi=row["doi"],
            arxiv_id=row["arxiv_id"], filename=row["filename"],
            full_text=row["full_text"], page_count=row["page_count"],
            user_id=row.get("user_id"), created_at=row["created_at"],
        )

    # â”€â”€ Claims cache â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    def insert_claims(self, claims: list[StoredClaim]):
        conn = self._get_conn()
        cur = conn.cursor()
        psycopg2.extras.execute_batch(
            cur,
            """INSERT INTO claims
               (id, paper_id, text, section, confidence,
                evidence, conditions, source_quote, created_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            [(c.id, c.paper_id, _clean(c.text), _clean(c.section), _clean(c.confidence),
              _clean(c.evidence), _clean(c.conditions), _clean(c.source_quote), c.created_at)
             for c in claims],
        )
        conn.commit()
        cur.close()
        conn.close()

    def get_claims_for_paper(self, paper_id: str) -> list[StoredClaim]:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("SELECT * FROM claims WHERE paper_id = %s", (paper_id,))
        rows = cur.fetchall()
        cur.close()
        conn.close()
        return [
            StoredClaim(id=r["id"], paper_id=r["paper_id"], text=r["text"],
                        section=r["section"], confidence=r["confidence"],
                        evidence=r["evidence"], conditions=r["conditions"],
                        source_quote=r["source_quote"], created_at=r["created_at"])
            for r in rows
        ]

    def delete_claims_for_paper(self, paper_id: str):
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("DELETE FROM claims WHERE paper_id = %s", (paper_id,))
        conn.commit()
        cur.close()
        conn.close()

    # â”€â”€ Relationships cache â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    def upsert_relationship(self, rel: "StoredRelationship"):
        lo, hi = sorted([rel.claim_lo, rel.claim_hi])
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO relationships
               (id, claim_lo, claim_hi, paper_a, paper_b, relationship, category,
                explanation, stronger_evidence, resolution, similarity, created_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT(claim_lo, claim_hi) DO UPDATE SET
                 relationship=EXCLUDED.relationship, category=EXCLUDED.category,
                 explanation=EXCLUDED.explanation,
                 stronger_evidence=EXCLUDED.stronger_evidence,
                 resolution=EXCLUDED.resolution, similarity=EXCLUDED.similarity,
                 created_at=EXCLUDED.created_at""",
            (rel.id, lo, hi, rel.paper_a, rel.paper_b, rel.relationship, rel.category,
             rel.explanation, rel.stronger_evidence, rel.resolution, rel.similarity,
             rel.created_at),
        )
        conn.commit()
        cur.close()
        conn.close()

    def get_relationship(self, claim_a: str, claim_b: str) -> "StoredRelationship | None":
        lo, hi = sorted([claim_a, claim_b])
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            "SELECT * FROM relationships WHERE claim_lo = %s AND claim_hi = %s", (lo, hi)
        )
        row = cur.fetchone()
        cur.close()
        conn.close()
        return self._row_to_rel(row) if row else None

    def list_relationships(
        self,
        paper_ids: list[str] | None = None,
        relationships: list[str] | None = None,
    ) -> list["StoredRelationship"]:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("SELECT * FROM relationships ORDER BY created_at DESC")
        rows = cur.fetchall()
        cur.close()
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

    # â”€â”€ Hypothesis cache â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    def get_hypothesis_cache(self, cache_key: str) -> dict | None:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            "SELECT payload, grounding FROM hypothesis_cache WHERE cache_key = %s",
            (cache_key,),
        )
        row = cur.fetchone()
        cur.close()
        conn.close()
        if not row:
            return None
        return {"hypotheses": json.loads(row["payload"]), "grounding": row["grounding"]}

    def set_hypothesis_cache(self, cache_key: str, hypotheses: list, grounding: str):
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO hypothesis_cache (cache_key, payload, grounding, created_at)
               VALUES (%s, %s, %s, %s)
               ON CONFLICT(cache_key) DO UPDATE SET
                 payload=EXCLUDED.payload, grounding=EXCLUDED.grounding,
                 created_at=EXCLUDED.created_at""",
            (cache_key, json.dumps(hypotheses), grounding,
             datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()
        cur.close()
        conn.close()

    def list_hypothesis_cache(self, user_paper_ids: list[str]) -> list[dict]:
        """Return all hypothesis cache entries that reference any of the user's papers."""
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            "SELECT cache_key, payload, grounding, created_at FROM hypothesis_cache ORDER BY created_at DESC"
        )
        rows = cur.fetchall()
        cur.close()
        conn.close()
        results = []
        pid_set = set(user_paper_ids)
        import json as _json
        for r in rows:
            try:
                hyps = _json.loads(r["payload"])
                # Check if any hypothesis references user's papers
                for h in hyps:
                    papers = [sp.get("paper_id", "") for sp in h.get("supporting_papers", [])]
                    if any(p in pid_set for p in papers) or not pid_set:
                        results.append({
                            "cache_key": r["cache_key"],
                            "hypotheses": hyps,
                            "grounding": r["grounding"],
                            "created_at": r["created_at"],
                        })
                        break
            except Exception:
                continue
        return results

    def invalidate_hypothesis_cache(self, cache_key: str):
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("DELETE FROM hypothesis_cache WHERE cache_key = %s", (cache_key,))
        conn.commit()
        cur.close()
        conn.close()

    # â”€â”€ Users / Auth â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    def _row_to_user(self, row) -> User:
        return User(
            id=row["id"], email=row["email"], password_hash=row["password_hash"],
            api_key_encrypted=row["api_key_encrypted"], model=row["model"],
            digest_email=row["digest_email"], library_name=row["library_name"],
            free_actions_used=row["free_actions_used"],
            free_sonnet_used=row["free_sonnet_used"], created_at=row["created_at"],
        )

    def create_user(self, email: str, password_hash: str) -> User:
        """Raises psycopg2.errors.UniqueViolation if email already exists."""
        user = User(id=User.new_id(), email=email, password_hash=password_hash)
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO users
               (id, email, password_hash, api_key_encrypted, model,
                digest_email, library_name, free_actions_used, free_sonnet_used, created_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (user.id, user.email, user.password_hash, user.api_key_encrypted,
             user.model, user.digest_email, user.library_name,
             user.free_actions_used, user.free_sonnet_used, user.created_at),
        )
        conn.commit()
        cur.close()
        conn.close()
        return user

    def get_user_by_email(self, email: str) -> User | None:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("SELECT * FROM users WHERE email = %s", (email,))
        row = cur.fetchone()
        cur.close()
        conn.close()
        return self._row_to_user(row) if row else None

    def get_user_by_id(self, user_id: str) -> User | None:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("SELECT * FROM users WHERE id = %s", (user_id,))
        row = cur.fetchone()
        cur.close()
        conn.close()
        return self._row_to_user(row) if row else None

    def increment_usage(self, user_id: str, is_sonnet: bool) -> tuple[int, int]:
        conn = self._get_conn()
        cur = conn.cursor()
        if is_sonnet:
            cur.execute(
                "UPDATE users SET free_actions_used = free_actions_used + 1, "
                "free_sonnet_used = free_sonnet_used + 1 WHERE id = %s "
                "RETURNING free_actions_used, free_sonnet_used",
                (user_id,),
            )
        else:
            cur.execute(
                "UPDATE users SET free_actions_used = free_actions_used + 1 WHERE id = %s "
                "RETURNING free_actions_used, free_sonnet_used",
                (user_id,),
            )
        row = cur.fetchone()
        conn.commit()
        cur.close()
        conn.close()
        return (row["free_actions_used"], row["free_sonnet_used"]) if row else (0, 0)

    def update_user_settings(self, user_id: str, **fields) -> None:
        cols = {k: v for k, v in fields.items() if k in _ALLOWED_SETTING_COLS}
        if not cols:
            return
        set_clause = ", ".join(f"{c} = %s" for c in cols)
        values = list(cols.values()) + [user_id]
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(f"UPDATE users SET {set_clause} WHERE id = %s", values)
        conn.commit()
        cur.close()
        conn.close()

    # â”€â”€ Sessions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    def create_session(self, user_id: str, token: str, expires_at: str) -> Session:
        sess = Session(
            token=token, user_id=user_id,
            created_at=datetime.now(timezone.utc).isoformat(),
            expires_at=expires_at,
        )
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM sessions WHERE user_id = %s AND expires_at < %s",
            (user_id, datetime.now(timezone.utc).isoformat()),
        )
        cur.execute(
            "INSERT INTO sessions (token, user_id, created_at, expires_at) "
            "VALUES (%s, %s, %s, %s)",
            (sess.token, sess.user_id, sess.created_at, sess.expires_at),
        )
        conn.commit()
        cur.close()
        conn.close()
        return sess

    def get_session(self, token: str) -> Session | None:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("SELECT * FROM sessions WHERE token = %s", (token,))
        row = cur.fetchone()
        cur.close()
        conn.close()
        if not row:
            return None
        return Session(token=row["token"], user_id=row["user_id"],
                       created_at=row["created_at"], expires_at=row["expires_at"])

    def delete_session(self, token: str) -> None:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("DELETE FROM sessions WHERE token = %s", (token,))
        conn.commit()
        cur.close()
        conn.close()

    def delete_sessions_for_user(self, user_id: str) -> None:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("DELETE FROM sessions WHERE user_id = %s", (user_id,))
        conn.commit()
        cur.close()
        conn.close()
