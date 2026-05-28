"""
ChromaDB vector store for semantic search over paper chunks.

Wraps ChromaDB with a clean interface for:
- Storing chunk embeddings with paper metadata
- Semantic similarity search
- Filtering by paper_id or section
"""

from dataclasses import dataclass

import chromadb
from chromadb.config import Settings as ChromaSettings

from config import CHROMA_DIR, settings


@dataclass
class SearchResult:
    chunk_id: str
    paper_id: str
    text: str
    section: str | None
    score: float  # lower = more similar (L2 distance)


class VectorStore:
    def __init__(self):
        self.client = chromadb.PersistentClient(
            path=str(CHROMA_DIR),
            settings=ChromaSettings(anonymized_telemetry=False),
        )
        self.collection = self.client.get_or_create_collection(
            name=settings.chroma_collection,
            metadata={"hnsw:space": "cosine"},
        )
        self._model = None

    @property
    def embedding_model(self):
        """Lazy-load the embedding model (heavy import)."""
        if self._model is None:
            from sentence_transformers import SentenceTransformer
            self._model = SentenceTransformer(settings.embedding_model)
        return self._model

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        """
        Embed a batch of texts as DOCUMENTS (no instruction prefix).

        Used for indexing chunks (add_chunks) and for claim-vs-claim
        similarity in the contradiction agent, where every text is a
        passage being compared, not a search query.
        """
        embeddings = self.embedding_model.encode(texts, show_progress_bar=False)
        return embeddings.tolist()

    def embed_query(self, query: str) -> list[float]:
        """
        Embed a single search QUERY.

        BGE retrieval models expect an instruction prefix on the query side
        only; documents are embedded bare. settings.embedding_query_prefix is
        "" for models that don't need it, so this is safe for any model.
        """
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
        """Embed and store chunks in ChromaDB."""
        embeddings = self.embed_texts(texts)

        metadatas = [
            {
                "paper_id": pid,
                "section": sec or "unknown",
            }
            for pid, sec in zip(paper_ids, sections)
        ]

        self.collection.add(
            ids=chunk_ids,
            embeddings=embeddings,
            documents=texts,
            metadatas=metadatas,
        )

    def search(
        self,
        query: str,
        n_results: int = 10,
        paper_id: str | None = None,
        section: str | None = None,
    ) -> list[SearchResult]:
        """
        Semantic search across stored chunks.

        Args:
            query: Natural language search query
            n_results: Max results to return
            paper_id: Filter to a specific paper
            section: Filter to a specific section type
        """
        query_embedding = self.embed_query(query)

        where_filter = {}
        if paper_id and section:
            where_filter = {
                "$and": [
                    {"paper_id": paper_id},
                    {"section": section},
                ]
            }
        elif paper_id:
            where_filter = {"paper_id": paper_id}
        elif section:
            where_filter = {"section": section}

        results = self.collection.query(
            query_embeddings=[query_embedding],
            n_results=n_results,
            where=where_filter if where_filter else None,
            include=["documents", "metadatas", "distances"],
        )

        search_results = []
        if results["ids"] and results["ids"][0]:
            for i, chunk_id in enumerate(results["ids"][0]):
                search_results.append(SearchResult(
                    chunk_id=chunk_id,
                    paper_id=results["metadatas"][0][i]["paper_id"],
                    text=results["documents"][0][i],
                    section=results["metadatas"][0][i].get("section"),
                    score=results["distances"][0][i],
                ))

        return search_results

    def delete_paper_chunks(self, paper_id: str):
        """Remove all chunks for a paper from the vector store."""
        # ChromaDB requires IDs to delete; query first
        results = self.collection.get(
            where={"paper_id": paper_id},
            include=[],
        )
        if results["ids"]:
            self.collection.delete(ids=results["ids"])

    def count(self) -> int:
        return self.collection.count()
