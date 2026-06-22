"""
pgvector-backed vector store for ScholarLens using Voyage AI embeddings.

Replaces local sentence-transformers (MiniLM) with Voyage AI API calls,
eliminating the ~400MB torch RAM overhead on Render free tier.

Model: voyage-3.5-lite — 512 dims, improved retrieval quality over voyage-3-lite
at the same price ($0.02/M tokens). Requires: VOYAGE_API_KEY in environment.
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
        self._client = None
        self._init_table()

    def _get_conn(self):
        return psycopg2.connect(self._dsn, cursor_factory=RealDictCursor)

    @property
    def client(self):
        """Lazy-load the Voyage AI client."""
        if self._client is None:
            import voyageai
            self._client = voyageai.Client(api_key=settings.voyage_api_key)
        return self._client

    def _init_table(self):
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("CREATE EXTENSION IF NOT EXISTS vector")
        # 512 dims — voyage-3.5-lite native output dimension
        cur.execute("""
            CREATE TABLE IF NOT EXISTS embeddings (
                chunk_id    TEXT PRIMARY KEY,
                paper_id    TEXT NOT NULL,
                text        TEXT NOT NULL,
                section     TEXT,
                embedding   vector(512) NOT NULL
            )
        """)
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_embeddings_paper ON embeddings(paper_id)"
        )
        conn.commit()
        cur.close()
        conn.close()

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        """Embed a batch of document texts."""
        # Voyage API has a max batch size of 128
        all_embeddings = []
        batch_size = 128
        for i in range(0, len(texts), batch_size):
            batch = texts[i:i + batch_size]
            result = self.client.embed(batch, model="voyage-3.5-lite", input_type="document")
            all_embeddings.extend(result.embeddings)
        return all_embeddings

    def embed_query(self, query: str) -> list[float]:
        """Embed a single search query."""
        result = self.client.embed([query], model="voyage-3.5-lite", input_type="query")
        return result.embeddings[0]

    def add_chunks(
        self,
        chunk_ids: list[str],
        texts: list[str],
        paper_ids: list[str],
        sections: list[str | None],
    ):
        # Strip NUL bytes — Postgres rejects them in string literals
        texts = [t.replace("\x00", "") if t else t for t in texts]
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
        fetch_n = n_results * 3

        sql = f"""
            SELECT chunk_id, paper_id, text, section,
                   (embedding <=> %s::vector) AS score
            FROM embeddings
            WHERE {where}
            ORDER BY score
            LIMIT %s
        """
        params_full = params + [query_vec_str, fetch_n]

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
