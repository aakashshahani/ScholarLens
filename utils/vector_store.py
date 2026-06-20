"""
pgvector-backed vector store for ScholarLens (migrated from ChromaDB).

Stores embeddings in Supabase Postgres using the pgvector extension.
Requires: CREATE EXTENSION IF NOT EXISTS vector; in Supabase.
"""

from dataclasses import dataclass

import psycopg2
import psycopg2.extras
from psycopg2.extras import RealDictCursor

from config import settings


@dataclass
class SearchResult:
    chunk_id: str
    paper_id: str
    text: str
    section: str | None
    score: float  # cosine distance, lower = more similar


class VectorStore:
    def __init__(self):
        self._dsn = settings.database_url
        self._model = None
        self._init_table()

    def _get_conn(self):
        return psycopg2.connect(self._dsn, cursor_factory=RealDictCursor)

    def _init_table(self):
        conn = self._get_conn()
        cur = conn.cursor()
        # Enable pgvector extension (idempotent)
        cur.execute("CREATE EXTENSION IF NOT EXISTS vector")
        # Embeddings table — 384 dims for all-MiniLM-L6-v2
        cur.execute("""
            CREATE TABLE IF NOT EXISTS embeddings (
                chunk_id    TEXT PRIMARY KEY,
                paper_id    TEXT NOT NULL,
                text        TEXT NOT NULL,
                section     TEXT,
                embedding   vector(384) NOT NULL
            )
        """)
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_embeddings_paper ON embeddings(paper_id)"
        )
        conn.commit()
        cur.close()
        conn.close()

    @property
    def embedding_model(self):
        """Lazy-load the embedding model."""
        if self._model is None:
            from sentence_transformers import SentenceTransformer
            self._model = SentenceTransformer(settings.embedding_model)
        return self._model

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        embeddings = self.embedding_model.encode(texts, show_progress_bar=False)
        return embeddings.tolist()

    def embed_query(self, query: str) -> list[float]:
        prefix = getattr(settings, "embedding_query_prefix", "")
        embeddings = self.embedding_model.encode([prefix + query], show_progress_bar=False)
        return embeddings[0].tolist()

    def add_chunks(
        self,
        chunk_ids: list[str],
        texts: list[str],
        paper_ids: list[str],
        sections: list[str | None],
    ):
        embeddings = self.embed_texts(texts)
        conn = self._get_conn()
        cur = conn.cursor()
        psycopg2.extras.execute_batch(
            cur,
            """INSERT INTO embeddings (chunk_id, paper_id, text, section, embedding)
               VALUES (%s, %s, %s, %s, %s::vector)
               ON CONFLICT (chunk_id) DO UPDATE SET
                 paper_id=EXCLUDED.paper_id, text=EXCLUDED.text,
                 section=EXCLUDED.section, embedding=EXCLUDED.embedding""",
            [
                (cid, pid, text, sec or "unknown", str(emb))
                for cid, pid, text, sec, emb
                in zip(chunk_ids, paper_ids, texts, sections, embeddings)
            ],
        )
        conn.commit()
        cur.close()
        conn.close()

    def search(
        self,
        query: str,
        n_results: int = 10,
        paper_id: str | None = None,
        section: str | None = None,
        exclude_sections: list[str] | None = None,
        paper_ids: list[str] | None = None,
    ) -> list[SearchResult]:
        if exclude_sections is None:
            exclude_sections = ["references", "appendix"]

        if paper_ids is not None and len(paper_ids) == 0:
            return []

        query_embedding = self.embed_query(query)
        query_vec_str = str(query_embedding)

        # Build WHERE clause
        conditions = ["1=1"]
        params: list = []

        if paper_id:
            conditions.append("paper_id = %s")
            params.append(paper_id)
        if paper_ids:
            conditions.append("paper_id = ANY(%s)")
            params.append(paper_ids)
        if section:
            conditions.append("section = %s")
            params.append(section)
        if exclude_sections:
            conditions.append("section != ALL(%s)")
            params.append(exclude_sections)

        where = " AND ".join(conditions)

        # Fetch more than needed to allow post-filter headroom
        fetch_n = n_results * 3
        params.extend([query_vec_str, fetch_n])

        sql = f"""
            SELECT chunk_id, paper_id, text, section,
                   (embedding <=> %s::vector) AS score
            FROM embeddings
            WHERE {where}
            ORDER BY score
            LIMIT %s
        """
        params_full = params[:-2] + [query_vec_str, fetch_n]

        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(sql, params_full)
        rows = cur.fetchall()
        cur.close()
        conn.close()

        results = []
        for r in rows:
            if len(results) >= n_results:
                break
            results.append(SearchResult(
                chunk_id=r["chunk_id"],
                paper_id=r["paper_id"],
                text=r["text"],
                section=r["section"],
                score=float(r["score"]),
            ))

        return results

    def delete_paper_chunks(self, paper_id: str):
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("DELETE FROM embeddings WHERE paper_id = %s", (paper_id,))
        conn.commit()
        cur.close()
        conn.close()

    def count(self) -> int:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) as count FROM embeddings")
        n = cur.fetchone()["count"]
        cur.close()
        conn.close()
        return int(n)
