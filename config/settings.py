"""
ScholarLens configuration — all secrets via env vars.
Copy .env.example to .env and fill in your keys.
"""

import os
from pathlib import Path
from dataclasses import dataclass, field

BASE_DIR = Path(__file__).resolve().parent.parent
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
    
    # Embedding model — runs locally via sentence-transformers as a starter,
    # swap to API embeddings when you're ready to scale
    embedding_model: str = "all-MiniLM-L6-v2"
    
    # Chunking params
    chunk_size: int = 500          # tokens per chunk
    chunk_overlap: int = 50        # overlap tokens
    
    # ChromaDB
    chroma_collection: str = "papers"
    
    # External APIs (Phase 3 — leave blank for now)
    semantic_scholar_key: str = field(
        default_factory=lambda: os.getenv("SEMANTIC_SCHOLAR_KEY", "")
    )

    def validate(self) -> list[str]:
        errors = []
        if not self.anthropic_api_key:
            errors.append("ANTHROPIC_API_KEY not set")
        return errors


settings = Settings()
