"""
ScholarLens configuration — all secrets via env vars.
Copy .env.example to .env and fill in your keys.
"""

import os
from pathlib import Path
from dataclasses import dataclass, field

# Auto-load .env file if it exists
BASE_DIR = Path(__file__).resolve().parent.parent
_env_file = BASE_DIR / ".env"
if _env_file.exists():
    from dotenv import load_dotenv
    load_dotenv(_env_file)
DATA_DIR = BASE_DIR / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
CHROMA_DIR = DATA_DIR / "chroma"
SQLITE_PATH = DATA_DIR / "scholarlens.db"

# Ensure dirs exist
for d in [DATA_DIR, UPLOAD_DIR, CHROMA_DIR]:
    d.mkdir(parents=True, exist_ok=True)


@dataclass
class Settings:
    anthropic_api_key: str = field(
        default_factory=lambda: os.getenv("ANTHROPIC_API_KEY", "")
    )
    anthropic_model: str = "claude-haiku-4-5-20251001"

    # Embedding model — all-MiniLM-L6-v2 (384-dim, general-purpose).
    # BGE-base was tested and rejected: score compression on narrow-domain
    # negotiation/AI text made distance thresholds unreliable.
    # NOTE: changing this model requires re-embedding the full library.
    embedding_model: str = "all-MiniLM-L6-v2"

    # MiniLM does not require a query instruction prefix (unlike BGE retrieval
    # models). This field is intentionally absent — embed_query() in
    # VectorStore uses the text as-is.

    # Chunking params
    chunk_size: int = 500          # tokens per chunk
    chunk_overlap: int = 50        # overlap tokens

    # ChromaDB
    chroma_collection: str = "papers"

    # Semantic search relevance tiers (cosine distance, lower = more similar).
    # Calibrated for MiniLM on narrow-domain academic text.
    # Tighter than general-purpose thresholds because the corpus vocabulary
    # is narrow and MiniLM compresses that space.
    relevance_highly_relevant: float = 0.20   # distance < 0.20
    relevance_related: float = 0.40           # 0.20 <= distance < 0.40
    # distance >= 0.40 → "tangential"

    # External APIs
    semantic_scholar_key: str = field(
        default_factory=lambda: os.getenv("SEMANTIC_SCHOLAR_KEY", "")
    )

    def validate(self) -> list[str]:
        errors = []
        if not self.anthropic_api_key:
            errors.append("ANTHROPIC_API_KEY not set")
        return errors

    def relevance_tier(self, cosine_distance: float) -> str:
        """
        Map a cosine distance to a human-readable relevance tier.

        Args:
            cosine_distance: Value in [0, 1] from ChromaDB (lower = more similar).

        Returns:
            "highly_relevant", "related", or "tangential"
        """
        if cosine_distance < self.relevance_highly_relevant:
            return "highly_relevant"
        if cosine_distance < self.relevance_related:
            return "related"
        return "tangential"


settings = Settings()
