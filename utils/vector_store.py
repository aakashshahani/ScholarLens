"""
pgvector-backed vector store for ScholarLens using Voyage AI embeddings.

Replaces local sentence-transformers (MiniLM) with Voyage AI API calls,
eliminating the ~400MB torch RAM overhead on Render free tier.

Model: voyage-3.5-lite — 1024 dims, improved retrieval quality over voyage-3-lite
at the same price ($0.02/M tokens). Requires: VOYAGE_API_KEY in environment.
"""

from dataclasses import dataclass

import psycopg2
import psycopg2.extras
from psycopg2.extras import RealDictCursor

from config import settings
from db.database import _get_pool


@dataclass
class SearchResult:
    chunk_id: str
    paper_id: str
    text: str
    section: str | None
    score: float  # cosine distance, lower = more similar
    # Cross-encoder relevance from the Voyage reranker, in [0, 1] (higher =
    # more relevant). None when reranking is disabled or unavailable, in which
    # case ordering falls back to `score` (cosine distance).
    rerank_score: float | None = None


class VectorStore:
    def __init__(self):
        self._dsn = settings.database_url
        self._client = None
        self._init_table()

    def _get_conn(self):
        """Borrow a connection from the shared pool."""
        conn = _get_pool().getconn()
        conn.cursor_factory = RealDictCursor
        return conn

    def _put_conn(self, conn, *, close: bool = False):
        try:
            _get_pool().putconn(conn, close=close)
        except Exception:
            pass

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
        # 1024 dims — voyage-3.5-lite default output dimension
        cur.execute("""
            CREATE TABLE IF NOT EXISTS embeddings (
                chunk_id    TEXT PRIMARY KEY,
                paper_id    TEXT NOT NULL,
                text        TEXT NOT NULL,
                section     TEXT,
                embedding   vector(1024) NOT NULL
            )
        """)
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_embeddings_paper ON embeddings(paper_id)"
        )
        # Commit the table + btree index before attempting the ANN index, so a
        # failure there can be rolled back in isolation without discarding the
        # schema we just created.
        conn.commit()

        # Approximate-nearest-neighbour index for cosine distance. Without it,
        # every `<=>` query is a sequential scan over the whole table — slow and
        # memory-spiky as the corpus grows. HNSW gives sub-linear lookups; the
        # `vector_cosine_ops` opclass matches the `<=>` operator used in search.
        # IF NOT EXISTS keeps this a no-op on every boot after the first.
        try:
            cur.execute(
                "CREATE INDEX IF NOT EXISTS idx_embeddings_hnsw "
                "ON embeddings USING hnsw (embedding vector_cosine_ops)"
            )
            conn.commit()
        except psycopg2.Error as exc:
            # Older pgvector (<0.5.0) lacks HNSW. Roll back just this statement;
            # search falls back to the exact sequential scan — correct, slower.
            conn.rollback()
            print(f"[vector_store] HNSW index unavailable, using exact scan: {exc}")
        cur.close()
        self._put_conn(conn)

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

    def rerank(
        self,
        query: str,
        documents: list[str],
        top_k: int | None = None,
    ) -> list[tuple[int, float]]:
        """Re-score (query, document) pairs with the Voyage cross-encoder.

        Returns (original_index, relevance_score) tuples sorted best-first.
        relevance_score is in [0, 1], higher = more relevant. The index refers
        back into `documents` so the caller can re-order its own objects.

        API-based by design: no local cross-encoder weights, so this adds zero
        resident memory — the whole point of staying on the Voyage stack.
        """
        if not documents:
            return []
        result = self.client.rerank(
            query=query,
            documents=documents,
            model=settings.rerank_model,
            top_k=top_k,
        )
        return [(r.index, r.relevance_score) for r in result.results]

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
        self._put_conn(conn)

    def search(
        self,
        query: str,
        n_results: int = 10,
        paper_id: str | None = None,
        section: str | None = None,
        exclude_sections: list[str] | None = None,
        paper_ids: list[str] | None = None,
        rerank: bool | None = None,
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

        do_rerank = settings.search_rerank_enabled if rerank is None else rerank
        # When reranking, pull a wider candidate pool so the cross-encoder can
        # promote relevant passages the embedding ranked just outside the top-k.
        # Without reranking, the old 3x overshoot is enough.
        fetch_n = max(settings.search_rerank_fetch, n_results * 3) if do_rerank else n_results * 3

        sql = f"""
            SELECT chunk_id, paper_id, text, section,
                   (embedding <=> %s::vector) AS score
            FROM embeddings
            WHERE {where}
            ORDER BY score
            LIMIT %s
        """
        params_full = [query_vec_str] + params + [fetch_n]

        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(sql, params_full)
        rows = cur.fetchall()
        cur.close()
        self._put_conn(conn)

        # All candidates, still in cosine-distance order from SQL.
        candidates = [
            SearchResult(
                chunk_id=r["chunk_id"],
                paper_id=r["paper_id"],
                text=r["text"],
                section=r["section"],
                score=float(r["score"]),
            )
            for r in rows
        ]

        # Stage 2: cross-encoder rerank. Reorders by true (query, passage)
        # relevance and attaches rerank_score. Any failure (model unavailable,
        # quota, network) degrades gracefully to the vector ordering — search
        # never goes down because the reranker did.
        if do_rerank and len(candidates) > 1:
            try:
                order = self.rerank(
                    query, [c.text for c in candidates], top_k=n_results
                )
                reranked = []
                for idx, rscore in order:
                    c = candidates[idx]
                    c.rerank_score = float(rscore)
                    reranked.append(c)
                if reranked:
                    return reranked[:n_results]
            except Exception as exc:  # noqa: BLE001 — fall back, never fail search
                print(f"[vector_store] rerank unavailable, using vector order: {exc}")

        return candidates[:n_results]

    def search_by_embedding(
        self,
        embedding: list[float],
        n_results: int = 3,
        paper_ids: list[str] | None = None,
    ) -> list[SearchResult]:
        """Search using a pre-computed embedding vector.
        Used by the monitoring agent to avoid re-embedding abstracts
        that were already embedded in a batch call."""
        if paper_ids is not None and len(paper_ids) == 0:
            return []

        query_vec_str = str(embedding)
        conditions = ["1=1"]
        params: list = []

        if paper_ids:
            conditions.append("paper_id = ANY(%s)")
            params.append(paper_ids)

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
        params_full = [query_vec_str] + params + [fetch_n]

        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute(sql, params_full)
        rows = cur.fetchall()
        cur.close()
        self._put_conn(conn)

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
        self._put_conn(conn)

    def count(self) -> int:
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) as count FROM embeddings")
        n = cur.fetchone()["count"]
        cur.close()
        self._put_conn(conn)
        return int(n)

    def count_for_papers(self, paper_ids: list[str]) -> int:
        if not paper_ids:
            return 0
        conn = self._get_conn()
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) as count FROM embeddings WHERE paper_id = ANY(%s)", (paper_ids,))
        n = cur.fetchone()["count"]
        cur.close()
        self._put_conn(conn)
        return int(n)
