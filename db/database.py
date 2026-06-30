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
import psycopg2.pool
from psycopg2.extras import RealDictCursor

from config import settings

# ── Shared connection pool ────────────────────────────────────────────────────
# ThreadedConnectionPool is safe for concurrent use across FastAPI's threadpool.
# minconn=2: keep two connections alive to avoid cold-connect latency.
# maxconn=10: cap at 10 simultaneous connections — Supabase free tier allows 60
# through the session pooler, but we only need a small slice. Keeps TCP buffer
# overhead low on Render's 512MB free tier.
# Initialised lazily on first use so import doesn't fail if DATABASE_URL is unset.
_pool: psycopg2.pool.ThreadedConnectionPool | None = None


def _get_pool() -> psycopg2.pool.ThreadedConnectionPool:
    global _pool
    if _pool is None or _pool.closed:
        from config import settings as _s
        _pool = psycopg2.pool.ThreadedConnectionPool(
            minconn=2,
            maxconn=10,
            dsn=_s.database_url,
        )
    return _pool


def _reset_pool() -> None:
    """Drop the pool so the next _get_pool() rebuilds it. Self-heals from the one
    structural weakness in the connection-per-call style: a method that raised
    between getconn() and putconn() leaks its connection. After enough leaks the
    pool would exhaust and every query would hang. Rebuilding on exhaustion turns
    that hang into a transient recovery instead."""
    global _pool
    p = _pool
    _pool = None
    if p is not None:
        try:
            p.closeall()
        except Exception:
            pass


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
    # External identity (Clerk) when auth is delegated. The internal `id` stays
    # the durable key everything else (papers, claims) references — clerk_user_id
    # is just the link, so swapping auth providers never re-keys user data.
    clerk_user_id: str | None = None

    @staticmethod
    def new_id() -> str:
        return str(uuid.uuid4())


@dataclass
class HypothesisRun:
    id: str
    user_id: str | None
    paper_ids: list[str]
    research_question: str | None
    hypotheses: list[dict]
    grounding: str
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    @staticmethod
    def new_id() -> str:
        return str(uuid.uuid4())


@dataclass
class Cluster:
    id: str
    user_id: str | None
    name: str
    research_question: str | None
    description: str | None
    claim_ids: list[str]
    relationship_ids: list[str]
    contradiction_count: int
    support_count: int
    nuance_count: int
    paper_count: int
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    @staticmethod
    def new_id() -> str:
        return str(uuid.uuid4())


@dataclass
class MonitorTopicRow:
    """Persisted monitor topic (DB representation)."""
    id: str
    user_id: str
    name: str
    keywords: list[str]
    sources: list[str]
    is_active: bool
    last_scanned_at: str | None
    created_at: str

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
        """Borrow a connection from the shared pool. Recovers automatically if
        the pool was exhausted by leaked connections from earlier query errors."""
        try:
            conn = _get_pool().getconn()
        except psycopg2.pool.PoolError:
            _reset_pool()
            conn = _get_pool().getconn()
        # Ensure RealDictCursor is used for all queries
        conn.cursor_factory = RealDictCursor
        return conn

    def _put_conn(self, conn, *, close: bool = False):
        """Return a connection to the pool. Pass close=True on error."""
        try:
            _get_pool().putconn(conn, close=close)
        except Exception:
            pass

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
        # Migration: add user_id column if upgrading from older schema
        cur.execute(
            "ALTER TABLE hypothesis_cache ADD COLUMN IF NOT EXISTS user_id TEXT"
        )
        cur.execute("""
            CREATE TABLE IF NOT EXISTS hypothesis_runs (
                id              TEXT PRIMARY KEY,
                user_id         TEXT REFERENCES users(id) ON DELETE CASCADE,
                paper_ids       TEXT NOT NULL,
                research_question TEXT,
                hypotheses      TEXT NOT NULL,
                grounding       TEXT NOT NULL,
                created_at      TEXT NOT NULL
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS clusters (
                id                  TEXT PRIMARY KEY,
                user_id             TEXT REFERENCES users(id) ON DELETE CASCADE,
                name                TEXT NOT NULL,
                research_question   TEXT,
                description         TEXT,
                claim_ids           TEXT NOT NULL,
                relationship_ids    TEXT NOT NULL,
                contradiction_count INTEGER NOT NULL DEFAULT 0,
                support_count       INTEGER NOT NULL DEFAULT 0,
                nuance_count        INTEGER NOT NULL DEFAULT 0,
                paper_count         INTEGER NOT NULL DEFAULT 0,
                created_at          TEXT NOT NULL
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
        cur.execute("""
            CREATE TABLE IF NOT EXISTS monitor_topics (
                id              TEXT PRIMARY KEY,
                user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name            TEXT NOT NULL,
                keywords        JSONB NOT NULL DEFAULT '[]',
                sources         JSONB NOT NULL DEFAULT '["arxiv","semantic_scholar"]',
                is_active       BOOLEAN NOT NULL DEFAULT true,
                created_at      TEXT NOT NULL,
                last_scanned_at TEXT
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS paper_tags (
                id          TEXT PRIMARY KEY,
                paper_id    TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                tag         TEXT NOT NULL,
                created_at  TEXT NOT NULL,
                UNIQUE(paper_id, tag)
            )
        """)
        # Latest monitor scan per (user, topic). The scan worker upserts one row
        # per topic and moves on, so peak memory never holds every topic's
        # results at once. Reading these is a pure DB read — the monitor page
        # renders instantly and results survive restarts, the same persistence
        # contract the rest of the app follows.
        cur.execute("""
            CREATE TABLE IF NOT EXISTS monitor_results (
                id              TEXT PRIMARY KEY,
                user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                topic_name      TEXT NOT NULL,
                payload         JSONB NOT NULL DEFAULT '[]',
                papers_found    INTEGER NOT NULL DEFAULT 0,
                papers_relevant INTEGER NOT NULL DEFAULT 0,
                scanned_at      TEXT NOT NULL,
                UNIQUE(user_id, topic_name)
            )
        """)
        # Per-hypothesis 👍/👎 feedback, one row per (user, hypothesis). Persisted
        # server-side (not localStorage) so votes survive devices and can inform
        # future generation — matching how contradiction feedback is stored.
        cur.execute("""
            CREATE TABLE IF NOT EXISTS hypothesis_feedback (
                id            TEXT PRIMARY KEY,
                user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                hypothesis_id TEXT NOT NULL,
                verdict       TEXT NOT NULL,
                created_at    TEXT NOT NULL,
                UNIQUE(user_id, hypothesis_id)
            )
        """)
        # Migrations: add columns to existing tables
        cur.execute(
            "ALTER TABLE relationships ADD COLUMN IF NOT EXISTS user_feedback TEXT"
        )
        # External identity link for Clerk auth. Nullable so password-auth rows
        # are untouched; partial unique index lets many NULLs coexist while
        # guaranteeing one internal user per Clerk id.
        cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS clerk_user_id TEXT")
        cur.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_clerk "
            "ON users(clerk_user_id) WHERE clerk_user_id IS NOT NULL"
        )
        # Enable RLS on all tables so PostgREST has no public access.
        # The app connects as the postgres superuser via psycopg2, which bypasses
        # RLS entirely, so these statements have no effect on app behaviour.
        for tbl in [
            "users", "papers", "chunks", "analysis_results", "claims",
            "relationships", "hypothesis_cache", "sessions",
            "monitor_topics", "paper_tags", "monitor_results",
            "hypothesis_feedback",
        ]:
            cur.execute(f"ALTER TABLE {tbl} ENABLE ROW LEVEL SECURITY")
        # Indexes
        for idx_sql in [
            "CREATE INDEX IF NOT EXISTS idx_chunks_paper ON chunks(paper_id)",
            "CREATE INDEX IF NOT EXISTS idx_analysis_paper ON analysis_results(paper_id)",
            "CREATE INDEX IF NOT EXISTS idx_papers_source ON papers(source)",
            "CREATE INDEX IF NOT EXISTS idx_claims_paper ON claims(paper_id)",
            "CREATE INDEX IF NOT EXISTS idx_rel_lo ON relationships(claim_lo)",
            "CREATE INDEX IF NOT EXISTS idx_rel_hi ON relationships(claim_hi)",
            "CREATE INDEX IF NOT EXISTS idx_rel_paper_a ON relationships(paper_a)",
            "CREATE INDEX IF NOT EXISTS idx_rel_paper_b ON relationships(paper_b)",
            "CREATE INDEX IF NOT EXISTS idx_rel_created ON relationships(created_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)",
            "CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)",
            "CREATE INDEX IF NOT EXISTS idx_papers_user ON papers(user_id)",
            "CREATE INDEX IF NOT EXISTS idx_monitor_topics_user ON monitor_topics(user_id)",
            "CREATE INDEX IF NOT EXISTS idx_paper_tags_paper ON paper_tags(paper_id)",
            "CREATE INDEX IF NOT EXISTS idx_paper_tags_user ON paper_tags(user_id)",
            "CREATE INDEX IF NOT EXISTS idx_hyp_runs_user ON hypothesis_runs(user_id)",
            "CREATE INDEX IF NOT EXISTS idx_hyp_runs_created ON hypothesis_runs(created_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_clusters_user ON clusters(user_id)",
        ]:
            cur.execute(idx_sql)
        conn.commit()
        cur.close()
        self._put_conn(conn)

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
        self._put_conn(conn)
        return paper.id

    def get_paper(self, paper_id: str) -> Paper | None:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("SELECT * FROM papers WHERE id = %s", (paper_id,))
        row = cur.fetchone()
        cur.close()
        self._put_conn(conn)
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
        self._put_conn(conn)
        return [self._row_to_paper(r) for r in rows]

    def paper_title_map(self, user_id: str | None = None) -> dict[str, str]:
        """Return {paper_id: title} for papers owned by user_id (or all papers if None).
        Cheaper than list_papers() — fetches only id and title columns."""
        conn = self._get_conn()
        cur = conn.cursor()
        if user_id is not None:
            cur.execute(
                "SELECT id, title FROM papers WHERE user_id = %s",
                (user_id,),
            )
        else:
            cur.execute("SELECT id, title FROM papers")
        rows = cur.fetchall()
        cur.close()
        self._put_conn(conn)
        return {r["id"]: r["title"] for r in rows}

    def paper_stats(self, user_id: str | None = None) -> tuple[int, str]:
        """Return (count, latest_created_at) without loading paper content.
        Used by the health endpoint to avoid fetching full_text for 1000 rows."""
        conn = self._get_conn()
        cur = conn.cursor()
        if user_id is not None:
            cur.execute(
                "SELECT COUNT(*) AS cnt, MAX(created_at) AS latest FROM papers WHERE user_id = %s",
                (user_id,),
            )
        else:
            cur.execute("SELECT COUNT(*) AS cnt, MAX(created_at) AS latest FROM papers")
        row = cur.fetchone()
        cur.close()
        self._put_conn(conn)
        return (int(row["cnt"]), row["latest"] or "")

    def delete_paper(self, paper_id: str) -> bool:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("DELETE FROM papers WHERE id = %s", (paper_id,))
        deleted = cur.rowcount > 0
        conn.commit()
        cur.close()
        self._put_conn(conn)
        return deleted

    # â”€â”€ Ownership helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    def set_paper_owner(self, paper_id: str, user_id: str) -> None:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("UPDATE papers SET user_id = %s WHERE id = %s", (user_id, paper_id))
        conn.commit()
        cur.close()
        self._put_conn(conn)

    def list_paper_ids_for_user(self, user_id: str) -> list[str]:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("SELECT id FROM papers WHERE user_id = %s", (user_id,))
        rows = cur.fetchall()
        cur.close()
        self._put_conn(conn)
        return [r["id"] for r in rows]

    def count_users(self) -> int:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) as count FROM users")
        n = cur.fetchone()["count"]
        cur.close()
        self._put_conn(conn)
        return int(n)

    def adopt_orphan_papers(self, user_id: str) -> int:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("UPDATE papers SET user_id = %s WHERE user_id IS NULL", (user_id,))
        n = cur.rowcount
        conn.commit()
        cur.close()
        self._put_conn(conn)
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
        self._put_conn(conn)

    def get_chunks_for_paper(self, paper_id: str) -> list[Chunk]:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            "SELECT * FROM chunks WHERE paper_id = %s ORDER BY chunk_index", (paper_id,)
        )
        rows = cur.fetchall()
        cur.close()
        self._put_conn(conn)
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
        self._put_conn(conn)
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
        self._put_conn(conn)
        return [
            AnalysisResult(id=r["id"], paper_id=r["paper_id"],
                           analysis_type=r["analysis_type"],
                           content=r["content"], created_at=r["created_at"])
            for r in rows
        ]

    # â”€â”€ Dedup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    def get_analyses_for_papers(self, paper_ids: list[str]) -> dict[str, list]:
        """Batch fetch analyses for multiple papers — one DB call instead of N.
        Returns dict: paper_id → list of AnalysisResult."""
        if not paper_ids:
            return {}
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            "SELECT * FROM analysis_results WHERE paper_id = ANY(%s) ORDER BY created_at",
            (paper_ids,),
        )
        rows = cur.fetchall()
        cur.close()
        self._put_conn(conn)
        result: dict[str, list] = {pid: [] for pid in paper_ids}
        for r in rows:
            result[r["paper_id"]].append(
                AnalysisResult(id=r["id"], paper_id=r["paper_id"],
                               analysis_type=r["analysis_type"],
                               content=r["content"], created_at=r["created_at"])
            )
        return result

    def get_claim_counts_for_papers(self, paper_ids: list[str]) -> dict[str, int]:
        """Batch fetch claim counts for multiple papers — one DB call instead of N.
        Returns dict: paper_id → claim count."""
        if not paper_ids:
            return {}
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            "SELECT paper_id, COUNT(*) as cnt FROM claims WHERE paper_id = ANY(%s) GROUP BY paper_id",
            (paper_ids,),
        )
        rows = cur.fetchall()
        cur.close()
        self._put_conn(conn)
        result = {pid: 0 for pid in paper_ids}
        for r in rows:
            result[r["paper_id"]] = int(r["cnt"])
        return result


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
                cur.execute("SELECT id, title FROM papers")
                for row in cur.fetchall():
                    if self._title_key(row["title"]) == key:
                        cur2 = conn.cursor()
                        cur2.execute("SELECT * FROM papers WHERE id = %s", (row["id"],))
                        full = cur2.fetchone()
                        cur2.close()
                        return self._row_to_paper(full) if full else None
            return None
        finally:
            cur.close()
            self._put_conn(conn)

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
        self._put_conn(conn)

    def get_claims_for_paper(self, paper_id: str) -> list[StoredClaim]:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("SELECT * FROM claims WHERE paper_id = %s", (paper_id,))
        rows = cur.fetchall()
        cur.close()
        self._put_conn(conn)
        return [
            StoredClaim(id=r["id"], paper_id=r["paper_id"], text=r["text"],
                        section=r["section"], confidence=r["confidence"],
                        evidence=r["evidence"], conditions=r["conditions"],
                        source_quote=r["source_quote"], created_at=r["created_at"])
            for r in rows
        ]

    def get_claims_for_papers(self, paper_ids: list[str]) -> dict[str, list]:
        """Batch fetch: returns {paper_id: [StoredClaim, ...]} in one query."""
        if not paper_ids:
            return {}
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("SELECT * FROM claims WHERE paper_id = ANY(%s)", (list(paper_ids),))
        rows = cur.fetchall()
        cur.close()
        self._put_conn(conn)
        result: dict[str, list] = {}
        for r in rows:
            c = StoredClaim(id=r["id"], paper_id=r["paper_id"], text=r["text"],
                            section=r["section"], confidence=r["confidence"],
                            evidence=r["evidence"], conditions=r["conditions"],
                            source_quote=r["source_quote"], created_at=r["created_at"])
            result.setdefault(r["paper_id"], []).append(c)
        return result

    def get_paper_titles(self, paper_ids: list[str]) -> dict[str, str]:
        """Return {paper_id: title} for the given IDs in one query."""
        if not paper_ids:
            return {}
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("SELECT id, title FROM papers WHERE id = ANY(%s)", (list(paper_ids),))
        rows = cur.fetchall()
        cur.close()
        self._put_conn(conn)
        return {r["id"]: r["title"] for r in rows}

    def delete_relationships_for_claims(self, claim_ids: list[str]):
        """Remove all relationships that reference any of the given claim IDs."""
        if not claim_ids:
            return
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM relationships WHERE claim_lo = ANY(%s) OR claim_hi = ANY(%s)",
            (list(claim_ids), list(claim_ids)),
        )
        conn.commit()
        cur.close()
        self._put_conn(conn)

    def delete_claims_for_paper(self, paper_id: str):
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("DELETE FROM claims WHERE paper_id = %s", (paper_id,))
        conn.commit()
        cur.close()
        self._put_conn(conn)

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
        self._put_conn(conn)

    def get_relationship(self, claim_a: str, claim_b: str) -> "StoredRelationship | None":
        lo, hi = sorted([claim_a, claim_b])
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            "SELECT * FROM relationships WHERE claim_lo = %s AND claim_hi = %s", (lo, hi)
        )
        row = cur.fetchone()
        cur.close()
        self._put_conn(conn)
        return self._row_to_rel(row) if row else None

    def list_relationships(
        self,
        paper_ids: list[str] | None = None,
        relationships: list[str] | None = None,
        strict: bool = False,
        exclude_feedback: list[str] | None = None,
    ) -> list["StoredRelationship"]:
        """
        Fetch stored relationships, optionally scoped to a set of papers.

        strict=False (default): OR logic — return relationships where either
            paper is in paper_ids. Used by graph/insights where you want all
            edges touching any selected paper.
        strict=True: AND logic — return relationships where BOTH papers are in
            paper_ids. Used by hypothesis generation and contradiction scan
            result fetching, where pulling in out-of-scope papers causes
            hypotheses to reference papers the user never selected.

        exclude_feedback: skip rows whose user_feedback is in this list.
            Pass ["disagree"] when building hypothesis context to exclude
            contradictions the user marked as mislabeled.
        """
        conn = self._get_conn()
        cur = conn.cursor()
        conditions: list[str] = []
        params: list = []
        if paper_ids:
            pid_arr = list(paper_ids)
            if strict:
                conditions.append("(paper_a = ANY(%s) AND paper_b = ANY(%s))")
                params.extend([pid_arr, pid_arr])
            else:
                conditions.append("(paper_a = ANY(%s) OR paper_b = ANY(%s))")
                params.extend([pid_arr, pid_arr])
        if relationships:
            conditions.append("relationship = ANY(%s)")
            params.append(list(relationships))
        if exclude_feedback:
            conditions.append("(user_feedback IS NULL OR user_feedback != ALL(%s))")
            params.append(list(exclude_feedback))
        where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
        cur.execute(
            f"SELECT * FROM relationships {where} ORDER BY created_at DESC",
            params or None,
        )
        rows = cur.fetchall()
        cur.close()
        self._put_conn(conn)
        return [self._row_to_rel(r) for r in rows]

    def relationships_watermark(self, paper_ids: list[str] | None = None, strict: bool = False) -> str:
        """
        Returns the max created_at timestamp over the scoped relationships.
        Used as a cache-bust key for hypothesis generation.
        strict should match whatever list_relationships call the caller uses.
        """
        conn = self._get_conn()
        cur = conn.cursor()
        if paper_ids:
            pid_arr = list(paper_ids)
            if strict:
                cond = "WHERE paper_a = ANY(%s) AND paper_b = ANY(%s)"
            else:
                cond = "WHERE paper_a = ANY(%s) OR paper_b = ANY(%s)"
            cur.execute(
                f"SELECT COALESCE(MAX(created_at), '') FROM relationships {cond}",
                [pid_arr, pid_arr],
            )
        else:
            cur.execute("SELECT COALESCE(MAX(created_at), '') FROM relationships")
        row = cur.fetchone()
        cur.close()
        self._put_conn(conn)
        return row[0] if row else ""

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
        self._put_conn(conn)
        if not row:
            return None
        return {"hypotheses": json.loads(row["payload"]), "grounding": row["grounding"]}

    def set_hypothesis_cache(self, cache_key: str, hypotheses: list, grounding: str,
                             user_id: str | None = None):
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO hypothesis_cache (cache_key, payload, grounding, created_at, user_id)
               VALUES (%s, %s, %s, %s, %s)
               ON CONFLICT(cache_key) DO UPDATE SET
                 payload=EXCLUDED.payload, grounding=EXCLUDED.grounding,
                 created_at=EXCLUDED.created_at, user_id=EXCLUDED.user_id""",
            (cache_key, json.dumps(hypotheses), grounding,
             datetime.now(timezone.utc).isoformat(), user_id),
        )
        conn.commit()
        cur.close()
        self._put_conn(conn)

    def list_hypothesis_cache(self, user_paper_ids: list[str],
                              user_id: str | None = None) -> list[dict]:
        """Return hypothesis cache entries for this user, most recent first."""
        conn = self._get_conn()
        cur = conn.cursor()
        import json as _json

        results = []
        pid_set = set(user_paper_ids)

        if user_id:
            # Primary path: entries saved after user_id column was added
            cur.execute(
                "SELECT cache_key, payload, grounding, created_at FROM hypothesis_cache "
                "WHERE user_id = %s ORDER BY created_at DESC",
                (user_id,),
            )
            for r in cur.fetchall():
                try:
                    results.append({
                        "cache_key": r["cache_key"],
                        "hypotheses": _json.loads(r["payload"]),
                        "grounding": r["grounding"],
                        "created_at": r["created_at"],
                    })
                except Exception:
                    continue

        # Legacy path: entries saved before user_id column was added — match by paper_id.
        # Only include if at least one source paper is positively in this user's library.
        # Entries with 0 source papers are excluded — we cannot verify ownership.
        if pid_set:
            cur.execute(
                "SELECT cache_key, payload, grounding, created_at FROM hypothesis_cache "
                "WHERE user_id IS NULL ORDER BY created_at DESC"
            )
            for r in cur.fetchall():
                try:
                    hyps = _json.loads(r["payload"])
                    for h in hyps:
                        papers = [sp.get("paper_id", "") for sp in h.get("supporting_papers", [])]
                        non_empty = [p for p in papers if p]
                        if non_empty and any(p in pid_set for p in non_empty):
                            results.append({
                                "cache_key": r["cache_key"],
                                "hypotheses": hyps,
                                "grounding": r["grounding"],
                                "created_at": r["created_at"],
                            })
                            break
                except Exception:
                    continue

        cur.close()
        self._put_conn(conn)
        # Sort combined results newest-first
        results.sort(key=lambda x: x.get("created_at") or "", reverse=True)
        return results

    def invalidate_hypothesis_cache(self, cache_key: str):
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("DELETE FROM hypothesis_cache WHERE cache_key = %s", (cache_key,))
        conn.commit()
        cur.close()
        self._put_conn(conn)

    # ── Hypothesis runs (permanent, never invalidated) ────────────────────────

    def save_hypothesis_run(self, run) -> str:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO hypothesis_runs
               (id, user_id, paper_ids, research_question, hypotheses, grounding, created_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s)""",
            (run.id, run.user_id, json.dumps(run.paper_ids), run.research_question,
             json.dumps(run.hypotheses), run.grounding, run.created_at),
        )
        conn.commit()
        cur.close()
        self._put_conn(conn)
        return run.id

    def list_hypothesis_runs(self, user_id: str, limit: int = 20) -> list:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            "SELECT * FROM hypothesis_runs WHERE user_id = %s ORDER BY created_at DESC LIMIT %s",
            (user_id, limit),
        )
        rows = cur.fetchall()
        cur.close()
        self._put_conn(conn)
        return [self._row_to_hypothesis_run(r) for r in rows]

    def get_hypothesis_run(self, run_id: str):
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("SELECT * FROM hypothesis_runs WHERE id = %s", (run_id,))
        row = cur.fetchone()
        cur.close()
        self._put_conn(conn)
        return self._row_to_hypothesis_run(row) if row else None

    def get_recent_hypothesis_run(self, user_id: str, question_hash: str, paper_ids_hash: str, max_age_minutes: int = 5):
        """Return most recent matching run within max_age_minutes, or None."""
        import hashlib as _hl
        from datetime import timedelta
        cutoff = (datetime.now(timezone.utc) - timedelta(minutes=max_age_minutes)).isoformat()
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            "SELECT * FROM hypothesis_runs WHERE user_id = %s AND created_at > %s ORDER BY created_at DESC LIMIT 10",
            (user_id, cutoff),
        )
        rows = cur.fetchall()
        cur.close()
        self._put_conn(conn)
        for row in rows:
            run = self._row_to_hypothesis_run(row)
            rph = _hl.sha256(json.dumps(sorted(run.paper_ids)).encode()).hexdigest()[:12]
            rqh = _hl.sha256((run.research_question or "").strip().lower().encode()).hexdigest()[:8]
            if rph == paper_ids_hash and rqh == question_hash:
                return run
        return None

    @staticmethod
    def _row_to_hypothesis_run(r):
        return HypothesisRun(
            id=r["id"], user_id=r["user_id"],
            paper_ids=json.loads(r["paper_ids"]) if r["paper_ids"] else [],
            research_question=r["research_question"],
            hypotheses=json.loads(r["hypotheses"]) if r["hypotheses"] else [],
            grounding=r["grounding"],
            created_at=r["created_at"],
        )

    # ── Clusters ──────────────────────────────────────────────────────────────

    def save_clusters(self, clusters: list) -> None:
        if not clusters:
            return
        user_id = clusters[0].user_id
        conn = self._get_conn()
        cur = conn.cursor()
        if user_id:
            cur.execute("DELETE FROM clusters WHERE user_id = %s", (user_id,))
        psycopg2.extras.execute_batch(
            cur,
            """INSERT INTO clusters
               (id, user_id, name, research_question, description, claim_ids,
                relationship_ids, contradiction_count, support_count, nuance_count,
                paper_count, created_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            [(c.id, c.user_id, c.name, c.research_question, c.description,
              json.dumps(c.claim_ids), json.dumps(c.relationship_ids),
              c.contradiction_count, c.support_count, c.nuance_count,
              c.paper_count, c.created_at)
             for c in clusters],
        )
        conn.commit()
        cur.close()
        self._put_conn(conn)

    def list_clusters(self, user_id: str) -> list:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            "SELECT * FROM clusters WHERE user_id = %s ORDER BY contradiction_count DESC, paper_count DESC",
            (user_id,),
        )
        rows = cur.fetchall()
        cur.close()
        self._put_conn(conn)
        return [self._row_to_cluster(r) for r in rows]

    def get_cluster(self, cluster_id: str):
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("SELECT * FROM clusters WHERE id = %s", (cluster_id,))
        row = cur.fetchone()
        cur.close()
        self._put_conn(conn)
        return self._row_to_cluster(row) if row else None

    @staticmethod
    def _row_to_cluster(r):
        return Cluster(
            id=r["id"], user_id=r["user_id"], name=r["name"],
            research_question=r["research_question"], description=r["description"],
            claim_ids=json.loads(r["claim_ids"]) if r["claim_ids"] else [],
            relationship_ids=json.loads(r["relationship_ids"]) if r["relationship_ids"] else [],
            contradiction_count=r["contradiction_count"],
            support_count=r["support_count"],
            nuance_count=r["nuance_count"],
            paper_count=r["paper_count"],
            created_at=r["created_at"],
        )


    # â”€â”€ Users / Auth â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    def _row_to_user(self, row) -> User:
        return User(
            id=row["id"], email=row["email"], password_hash=row["password_hash"],
            api_key_encrypted=row["api_key_encrypted"], model=row["model"],
            digest_email=row["digest_email"], library_name=row["library_name"],
            free_actions_used=row["free_actions_used"],
            free_sonnet_used=row["free_sonnet_used"], created_at=row["created_at"],
            clerk_user_id=row.get("clerk_user_id"),
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
        self._put_conn(conn)
        return user

    def get_user_by_email(self, email: str) -> User | None:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("SELECT * FROM users WHERE email = %s", (email,))
        row = cur.fetchone()
        cur.close()
        self._put_conn(conn)
        return self._row_to_user(row) if row else None

    def get_user_by_id(self, user_id: str) -> User | None:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("SELECT * FROM users WHERE id = %s", (user_id,))
        row = cur.fetchone()
        cur.close()
        self._put_conn(conn)
        return self._row_to_user(row) if row else None

    # ── Clerk identity linking ────────────────────────────────
    # The internal `id` stays the durable key for all user data; clerk_user_id
    # is only the link. This is what lets the migration preserve existing papers
    # — we attach Clerk to the existing row rather than re-keying anything.

    def get_user_by_clerk_id(self, clerk_id: str) -> User | None:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("SELECT * FROM users WHERE clerk_user_id = %s", (clerk_id,))
        row = cur.fetchone()
        cur.close()
        self._put_conn(conn)
        return self._row_to_user(row) if row else None

    def link_clerk_id(self, user_id: str, clerk_id: str) -> None:
        """Attach a Clerk id to an existing internal user (link-by-email path)."""
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            "UPDATE users SET clerk_user_id = %s WHERE id = %s",
            (clerk_id, user_id),
        )
        conn.commit()
        cur.close()
        self._put_conn(conn)

    def create_user_for_clerk(self, email: str, clerk_id: str) -> User:
        """Create a fresh internal user backed by Clerk (no local password).
        password_hash is an unusable sentinel so the password path can never
        authenticate this row."""
        user = User(id=User.new_id(), email=email, password_hash="!clerk-managed",
                    clerk_user_id=clerk_id)
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO users
               (id, email, password_hash, api_key_encrypted, model,
                digest_email, library_name, free_actions_used, free_sonnet_used,
                created_at, clerk_user_id)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (user.id, user.email, user.password_hash, user.api_key_encrypted,
             user.model, user.digest_email, user.library_name,
             user.free_actions_used, user.free_sonnet_used, user.created_at,
             user.clerk_user_id),
        )
        conn.commit()
        cur.close()
        self._put_conn(conn)
        return user

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
        self._put_conn(conn)
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
        self._put_conn(conn)

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
        self._put_conn(conn)
        return sess

    def get_session(self, token: str) -> Session | None:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("SELECT * FROM sessions WHERE token = %s", (token,))
        row = cur.fetchone()
        cur.close()
        self._put_conn(conn)
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
        self._put_conn(conn)

    def delete_sessions_for_user(self, user_id: str) -> None:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("DELETE FROM sessions WHERE user_id = %s", (user_id,))
        conn.commit()
        cur.close()
        self._put_conn(conn)

    # ── Monitor topics ────────────────────────────────────────────────────────

    def _row_to_monitor_topic(self, r) -> MonitorTopicRow:
        return MonitorTopicRow(
            id=r["id"],
            user_id=r["user_id"],
            name=r["name"],
            keywords=json.loads(r["keywords"]) if isinstance(r["keywords"], str) else r["keywords"],
            sources=json.loads(r["sources"]) if isinstance(r["sources"], str) else r["sources"],
            is_active=r["is_active"],
            last_scanned_at=r.get("last_scanned_at"),
            created_at=r["created_at"],
        )

    def create_monitor_topic(
        self,
        user_id: str,
        name: str,
        keywords: list[str],
        sources: list[str],
    ) -> MonitorTopicRow:
        topic_id = MonitorTopicRow.new_id()
        now = datetime.now(timezone.utc).isoformat()
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO monitor_topics
               (id, user_id, name, keywords, sources, is_active, created_at)
               VALUES (%s, %s, %s, %s::jsonb, %s::jsonb, true, %s)
               RETURNING *""",
            (topic_id, user_id, name,
             json.dumps(keywords), json.dumps(sources), now),
        )
        row = cur.fetchone()
        conn.commit()
        cur.close()
        self._put_conn(conn)
        return self._row_to_monitor_topic(row)

    def list_monitor_topics(self, user_id: str) -> list[MonitorTopicRow]:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            "SELECT * FROM monitor_topics WHERE user_id = %s ORDER BY created_at ASC",
            (user_id,),
        )
        rows = cur.fetchall()
        cur.close()
        self._put_conn(conn)
        return [self._row_to_monitor_topic(r) for r in rows]

    def delete_monitor_topic(self, topic_id: str, user_id: str) -> bool:
        """Delete a topic. Checks ownership — returns False if not found/owned."""
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM monitor_topics WHERE id = %s AND user_id = %s RETURNING id",
            (topic_id, user_id),
        )
        deleted = cur.fetchone() is not None
        conn.commit()
        cur.close()
        self._put_conn(conn)
        return deleted

    def update_topic_scanned_at(self, topic_id: str) -> None:
        """Record when a topic was last scanned by the scheduler."""
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            "UPDATE monitor_topics SET last_scanned_at = %s WHERE id = %s",
            (datetime.now(timezone.utc).isoformat(), topic_id),
        )
        conn.commit()
        cur.close()
        self._put_conn(conn)

    def save_monitor_result(
        self,
        user_id: str,
        topic_name: str,
        payload: list,
        papers_found: int,
        papers_relevant: int,
    ) -> None:
        """Upsert the latest scan for one topic. Replaces the previous row for
        this (user, topic) so storage stays bounded to one row per topic and
        the worker can persist-then-release as it streams through topics."""
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO monitor_results
                 (id, user_id, topic_name, payload, papers_found,
                  papers_relevant, scanned_at)
               VALUES (%s, %s, %s, %s::jsonb, %s, %s, %s)
               ON CONFLICT (user_id, topic_name) DO UPDATE SET
                 payload=EXCLUDED.payload,
                 papers_found=EXCLUDED.papers_found,
                 papers_relevant=EXCLUDED.papers_relevant,
                 scanned_at=EXCLUDED.scanned_at""",
            (str(uuid.uuid4()), user_id, topic_name, json.dumps(payload),
             papers_found, papers_relevant,
             datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()
        cur.close()
        self._put_conn(conn)

    def get_monitor_results(self, user_id: str) -> list[dict]:
        """Return the latest persisted scan results for every topic, newest
        first. Pure DB read — no external calls, no recompute."""
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            """SELECT topic_name, payload, papers_found, papers_relevant, scanned_at
               FROM monitor_results WHERE user_id = %s
               ORDER BY scanned_at DESC""",
            (user_id,),
        )
        rows = cur.fetchall()
        cur.close()
        self._put_conn(conn)
        out = []
        for r in rows:
            payload = r["payload"]
            if isinstance(payload, str):
                payload = json.loads(payload)
            out.append({
                "topic": r["topic_name"],
                "scored_papers": payload,
                "papers_found": r["papers_found"],
                "papers_relevant": r["papers_relevant"],
                "scan_time": r["scanned_at"],
            })
        return out

    def list_users_with_active_topics(self) -> list[User]:
        """Return all users who have at least one active monitor topic.
        Used by the monitor worker to know who to scan for."""
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            """SELECT DISTINCT u.*
               FROM users u
               INNER JOIN monitor_topics mt ON mt.user_id = u.id
               WHERE mt.is_active = true"""
        )
        rows = cur.fetchall()
        cur.close()
        self._put_conn(conn)
        return [self._row_to_user(r) for r in rows]

    # ── Paper tags ────────────────────────────────────────────────────────────

    def add_paper_tag(self, paper_id: str, user_id: str, tag: str) -> bool:
        """Add a tag to a paper. Returns True if new, False if already existed."""
        tag = tag.strip().lower()[:50]
        if not tag:
            return False
        conn = self._get_conn()
        cur = conn.cursor()
        try:
            cur.execute(
                """INSERT INTO paper_tags (id, paper_id, user_id, tag, created_at)
                   VALUES (%s, %s, %s, %s, %s)
                   ON CONFLICT(paper_id, tag) DO NOTHING""",
                (str(uuid.uuid4()), paper_id, user_id, tag,
                 datetime.now(timezone.utc).isoformat()),
            )
            created = cur.rowcount > 0
            conn.commit()
            return created
        finally:
            cur.close()
            self._put_conn(conn)

    def remove_paper_tag(self, paper_id: str, user_id: str, tag: str) -> bool:
        conn = self._get_conn()
        cur = conn.cursor()
        try:
            cur.execute(
                "DELETE FROM paper_tags WHERE paper_id = %s AND user_id = %s AND tag = %s",
                (paper_id, user_id, tag.strip().lower()),
            )
            deleted = cur.rowcount > 0
            conn.commit()
            return deleted
        finally:
            cur.close()
            self._put_conn(conn)

    def get_tags_for_paper(self, paper_id: str) -> list[str]:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            "SELECT tag FROM paper_tags WHERE paper_id = %s ORDER BY tag",
            (paper_id,),
        )
        rows = cur.fetchall()
        cur.close()
        self._put_conn(conn)
        return [r["tag"] for r in rows]

    def get_tags_for_papers(self, paper_ids: list[str]) -> dict[str, list[str]]:
        """Batch fetch tags: returns {paper_id: [tag, ...]}."""
        if not paper_ids:
            return {}
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            "SELECT paper_id, tag FROM paper_tags WHERE paper_id = ANY(%s) ORDER BY tag",
            (list(paper_ids),),
        )
        rows = cur.fetchall()
        cur.close()
        self._put_conn(conn)
        result: dict[str, list[str]] = {pid: [] for pid in paper_ids}
        for r in rows:
            result[r["paper_id"]].append(r["tag"])
        return result

    def get_all_user_tags(self, user_id: str) -> list[str]:
        """Return all distinct tags used by a user, sorted alphabetically."""
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            "SELECT DISTINCT tag FROM paper_tags WHERE user_id = %s ORDER BY tag",
            (user_id,),
        )
        rows = cur.fetchall()
        cur.close()
        self._put_conn(conn)
        return [r["tag"] for r in rows]

    def list_paper_ids_by_tag(self, user_id: str, tag: str) -> list[str]:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            "SELECT paper_id FROM paper_tags WHERE user_id = %s AND tag = %s",
            (user_id, tag.strip().lower()),
        )
        rows = cur.fetchall()
        cur.close()
        self._put_conn(conn)
        return [r["paper_id"] for r in rows]

    # ── Relationship feedback ─────────────────────────────────────────────────

    def set_relationship_feedback(self, rel_id: str, user_id: str, verdict: str) -> bool:
        """Store user feedback on a relationship (agree/disagree/flag).
        Returns False if the relationship doesn't exist or isn't owned."""
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            """UPDATE relationships SET user_feedback = %s
               WHERE id = %s AND (paper_a = ANY(
                   SELECT id FROM papers WHERE user_id = %s
               ))""",
            (verdict, rel_id, user_id),
        )
        updated = cur.rowcount > 0
        conn.commit()
        cur.close()
        self._put_conn(conn)
        return updated

    def set_hypothesis_feedback(self, user_id: str, hyp_id: str, verdict: str | None) -> None:
        """Upsert a 👍/👎 vote on a hypothesis. verdict=None clears the vote
        (toggling the same button off)."""
        conn = self._get_conn()
        cur = conn.cursor()
        if verdict is None:
            cur.execute(
                "DELETE FROM hypothesis_feedback WHERE user_id = %s AND hypothesis_id = %s",
                (user_id, hyp_id),
            )
        else:
            cur.execute(
                """INSERT INTO hypothesis_feedback (id, user_id, hypothesis_id, verdict, created_at)
                   VALUES (%s, %s, %s, %s, %s)
                   ON CONFLICT (user_id, hypothesis_id) DO UPDATE SET
                     verdict = EXCLUDED.verdict, created_at = EXCLUDED.created_at""",
                (str(uuid.uuid4()), user_id, hyp_id, verdict,
                 datetime.now(timezone.utc).isoformat()),
            )
        conn.commit()
        cur.close()
        self._put_conn(conn)

    def get_hypothesis_feedback(self, user_id: str) -> dict[str, str]:
        """Return {hypothesis_id: verdict} for all of a user's votes."""
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(
            "SELECT hypothesis_id, verdict FROM hypothesis_feedback WHERE user_id = %s",
            (user_id,),
        )
        rows = cur.fetchall()
        cur.close()
        self._put_conn(conn)
        return {r["hypothesis_id"]: r["verdict"] for r in rows}

