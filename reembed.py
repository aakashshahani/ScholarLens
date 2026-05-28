"""
One-shot re-embedding script — Task 3 (MiniLM → BGE-base).

WHY THIS IS DESTRUCTIVE AND NECESSARY
-------------------------------------
The old collection holds 384-dim MiniLM vectors. BGE-base produces 768-dim
vectors. ChromaDB collections are fixed-dimension, so you cannot mix them —
querying a 384-dim collection with a 768-dim vector errors or silently returns
garbage. We therefore DELETE the collection and rebuild it from SQLite, which
is the durable source of truth for chunk text (the `chunks` table).

WHAT IT DOES NOT TOUCH
----------------------
- SQLite: read-only here. Chunk rows, their ids, and embedding_id links are
  preserved; we re-key ChromaDB to the SAME ids so nothing downstream breaks.
- Claims / relationships cache: untouched. (Contradiction judgments are cached
  by claim TEXT, not by embedding, so re-embedding doesn't invalidate them —
  but the PAIRS that reach the judge may change, which is exactly what Task 3
  measures.)

USAGE
-----
    python -m scripts.reembed            # rebuild everything
    python -m scripts.reembed --dry-run  # report what would happen, embed nothing

Run from the project root with the venv active and config.py already pointed
at the new model. Verify the model name before running:
"""

import argparse
import sys
import time

from config import settings
from db import Database
from utils import VectorStore


def main():
    parser = argparse.ArgumentParser(description="Re-embed all chunks with the configured model.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Report counts and exit without re-embedding.")
    parser.add_argument("--batch", type=int, default=128,
                        help="Embedding batch size (default 128).")
    args = parser.parse_args()

    db = Database()
    store = VectorStore()

    papers = db.list_papers(limit=10_000)
    total_chunks = sum(len(db.get_chunks_for_paper(p.id)) for p in papers)

    print(f"Model in config : {settings.embedding_model}")
    print(f"Papers          : {len(papers)}")
    print(f"Chunks to embed : {total_chunks}")
    print(f"Current ChromaDB count: {store.count()}")

    if args.dry_run:
        print("\n[dry-run] No changes made.")
        return

    if total_chunks == 0:
        print("\nNo chunks in SQLite — nothing to embed. (Did you point at the right DB?)")
        return

    # ── Drop and recreate the collection (dimension change requires this) ──
    print(f"\nDeleting collection '{settings.chroma_collection}' ...")
    store.client.delete_collection(name=settings.chroma_collection)
    store.collection = store.client.get_or_create_collection(
        name=settings.chroma_collection,
        metadata={"hnsw:space": "cosine"},
    )
    print("Collection recreated (empty).")

    # ── Rebuild from SQLite, paper by paper, batched ──────────────────────
    t0 = time.time()
    embedded = 0
    for p in papers:
        chunks = db.get_chunks_for_paper(p.id)
        if not chunks:
            continue
        for i in range(0, len(chunks), args.batch):
            batch = chunks[i:i + args.batch]
            store.add_chunks(
                # Reuse the existing ChromaDB doc id so SQLite linkage holds.
                chunk_ids=[c.embedding_id or c.id for c in batch],
                texts=[c.text for c in batch],
                paper_ids=[c.paper_id for c in batch],
                sections=[c.section for c in batch],
            )
            embedded += len(batch)
            print(f"  {embedded}/{total_chunks} chunks ...", end="\r", flush=True)

    dt = time.time() - t0
    print(f"\nDone. Re-embedded {embedded} chunks in {dt:.1f}s.")
    print(f"ChromaDB count now: {store.count()}")
    if store.count() != total_chunks:
        print(f"WARNING: ChromaDB count ({store.count()}) != chunk count "
              f"({total_chunks}). Check for duplicate embedding_ids.")


if __name__ == "__main__":
    sys.exit(main())
