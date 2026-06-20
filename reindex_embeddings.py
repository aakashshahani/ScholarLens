"""
One-time reindex: rebuild pgvector embeddings from migrated chunks.

Run after migrate_to_supabase.py:
    python reindex_embeddings.py

Takes ~2-3 minutes for 652 chunks (MiniLM loads once, then batches).
"""

import os
import sys
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

# Add project root to path
sys.path.insert(0, str(Path(__file__).resolve().parent))

from utils.vector_store import VectorStore
from db.database import Database

print("Loading database...")
db = Database()

print("Loading vector store (MiniLM loads here, takes ~30s first time)...")
vs = VectorStore()

print("Fetching all papers...")
papers = db.list_papers(limit=1000)
print(f"Found {len(papers)} papers")
print()

total_chunks = 0
for i, paper in enumerate(papers):
    chunks = db.get_chunks_for_paper(paper.id)
    if not chunks:
        print(f"  [{i+1}/{len(papers)}] {paper.title[:50]}: no chunks, skipping")
        continue

    chunk_ids = [c.id for c in chunks]
    texts = [c.text for c in chunks]
    paper_ids = [c.paper_id for c in chunks]
    sections = [c.section for c in chunks]

    vs.add_chunks(chunk_ids, texts, paper_ids, sections)
    total_chunks += len(chunks)
    print(f"  [{i+1}/{len(papers)}] {paper.title[:50]}: {len(chunks)} chunks indexed")

print()
print(f"Reindex complete. {total_chunks} chunks indexed in pgvector.")
print(f"Verify: {vs.count()} embeddings in DB")
