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

            CREATE INDEX IF NOT EXISTS idx_chunks_paper ON chunks(paper_id);
            CREATE INDEX IF NOT EXISTS idx_analysis_paper ON analysis_results(paper_id);
            CREATE INDEX IF NOT EXISTS idx_papers_source ON papers(source);
        """)
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
