"""
ScholarLens API — FastAPI Backend

Exposes all agent functionality as REST endpoints.
The existing agent code stays exactly the same.
This is just a thin API layer on top.

Run: uvicorn api:app --reload --port 8000
"""

import sys
from pathlib import Path

# Ensure project root is on path
sys.path.insert(0, str(Path(__file__).resolve().parent))

import json
from fastapi import FastAPI, UploadFile, File, HTTPException, BackgroundTasks, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional

from config import settings, UPLOAD_DIR
from db import Database, Paper
from agents import (
    PDFAnalysisAgent,
    ContradictionAgent,
    HypothesisAgent,
    PaperImporter,
    MonitoringAgent,
    MonitorTopic,
)

# ── App Setup ────────────────────────────────────────────────

app = FastAPI(
    title="ScholarLens API",
    description="Research intelligence platform — agentic paper analysis, "
                "cross-paper contradiction detection, and hypothesis generation.",
    version="1.0.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
)

# Allow Next.js frontend (localhost:3000) to call the API
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Services (initialized once at startup) ───────────────────

db = Database()
agent = PDFAnalysisAgent()
contradiction_agent = ContradictionAgent()
hypothesis_agent = HypothesisAgent()
importer = PaperImporter()
monitor = MonitoringAgent()


# ── Insight feed cache ───────────────────────────────────────
# Simple in-process TTL cache — no new DB table needed.
# The feed is pure DB reads so it's cheap to recompute, but repeated
# page loads from the frontend shouldn't re-run the same queries on
# every request. Cache holds the last assembled result and its timestamp.
# Invalidated explicitly whenever a paper is added or deleted.

import time as _time

_INSIGHT_CACHE_TTL = 2 * 60 * 60  # 2 hours in seconds

_insight_cache: dict = {
    "payload": None,       # list[dict] — the last assembled insight list
    "ts": 0.0,             # unix timestamp of last population
}


def _invalidate_insight_cache():
    """Call this any time the library changes so the feed reflects it immediately."""
    _insight_cache["payload"] = None
    _insight_cache["ts"] = 0.0


# ── Request/Response Models ──────────────────────────────────

class SearchRequest(BaseModel):
    query: str
    n_results: int = 10
    paper_id: Optional[str] = None


class AskRequest(BaseModel):
    question: str
    paper_id: Optional[str] = None


class ContradictionRequest(BaseModel):
    paper_ids: Optional[list[str]] = None
    similarity_threshold: float = 0.5
    max_pairs: int = 15


class HypothesisRequest(BaseModel):
    research_question: Optional[str] = None
    paper_ids: Optional[list[str]] = None
    num_hypotheses: int = 5
    # Pass refresh=true to bypass the output cache and force regeneration.
    # Useful when you've added papers or run a new contradiction scan and
    # want hypotheses that reflect the updated conflict set immediately
    # (the cache would normally auto-invalidate via the watermark, but
    # explicit refresh is available as an escape hatch).
    refresh: bool = False


class ImportSearchRequest(BaseModel):
    query: str
    sources: list[str] = ["arxiv", "semantic_scholar"]
    max_per_source: int = 5


class ImportAddRequest(BaseModel):
    title: str
    authors: list[str]
    abstract: str
    year: Optional[int] = None
    source: str
    source_id: str
    doi: Optional[str] = None
    pdf_url: Optional[str] = None
    url: str


class ImportLookupRequest(BaseModel):
    identifier: str  # arXiv ID, DOI, or URL


class MonitorRequest(BaseModel):
    topics: list[dict]  # [{name, keywords, sources}]
    email: Optional[str] = None
    relevance_threshold: float = 0.3
    max_per_source: int = 5


# ── Background task helper ───────────────────────────────────

def _analyze_paper_bg(paper_id: str):
    """Background task for paper analysis."""
    try:
        agent.analyze_paper(paper_id)
    except Exception as e:
        print(f"Background analysis failed for {paper_id}: {e}")


def _extract_claims_bg(paper_id: str, force: bool = False):
    """Background task: extract grounded claims for a single paper."""
    try:
        agent.extract_grounded_claims(paper_id, force=force)
    except Exception as e:
        print(f"[bg] extract_grounded_claims failed for {paper_id}: {e}")


# ── Health Check ─────────────────────────────────────────────

@app.get("/api/health")
def health():
    errors = settings.validate()
    papers = db.list_papers(limit=1000)
    paper_count = len(papers)
    embedding_count = agent.vector_store.count()
    # Library fingerprint: changes whenever papers are added or removed.
    # Frontend uses this as a cache-bust key for contradiction results.
    latest_paper = papers[0].created_at if papers else ""
    fingerprint = f"{paper_count}:{latest_paper}"
    return {
        "status": "ok" if not errors else "degraded",
        "errors": errors,
        "papers": paper_count,
        "embeddings": embedding_count,
        "library_fingerprint": fingerprint,
    }


@app.post("/api/admin/fix-abstracts")
def fix_abstracts():
    """
    Re-fetch full abstracts for arXiv papers whose stored abstract is short
    (under 400 chars) — these were truncated at import time by the [:300] slice
    that previously existed in the search/lookup response serializers.

    Safe to run multiple times — only updates papers where the new abstract
    is longer than what's stored.
    """
    import sqlite3
    papers = db.list_papers(limit=200)
    updated = 0
    for p in papers:
        if p.source != "arxiv":
            continue
        if p.abstract and len(p.abstract) >= 400:
            continue
        # Re-fetch from arXiv using the stored arxiv_id or title lookup
        try:
            result = importer.lookup(p.title)
            if result and result.abstract and len(result.abstract) > len(p.abstract or ""):
                clean = _normalize_abstract(result.abstract)
                conn = sqlite3.connect(str(db.db_path))
                conn.execute("UPDATE papers SET abstract=? WHERE id=?", (clean, p.id))
                conn.commit()
                conn.close()
                updated += 1
                print(f"Fixed abstract for: {p.title[:60]}")
        except Exception as e:
            print(f"Failed to fix abstract for {p.title[:40]}: {e}")
    return {"updated": updated, "checked": sum(1 for p in papers if p.source == "arxiv")}



def normalize_abstracts():
    """
    One-time migration: normalize abstracts already in the DB.

    arXiv and Semantic Scholar return abstracts with embedded newlines
    (line-wrapped at ~80 chars). This cleans all existing records so
    the UI truncates at sentence boundaries rather than mid-word.

    Safe to run multiple times — idempotent.
    """
    import sqlite3
    conn = sqlite3.connect(str(db.db_path))
    papers = conn.execute("SELECT id, abstract FROM papers WHERE abstract IS NOT NULL").fetchall()
    updated = 0
    for paper_id, abstract in papers:
        cleaned = _normalize_abstract(abstract)
        if cleaned != abstract:
            conn.execute("UPDATE papers SET abstract=? WHERE id=?", (cleaned, paper_id))
            updated += 1
    conn.commit()
    conn.close()
    return {"updated": updated, "total": len(papers)}


# ── Papers ───────────────────────────────────────────────────

@app.get("/api/papers")
def list_papers(limit: int = 50, offset: int = 0):
    papers = db.list_papers(limit=limit, offset=offset)
    results = []
    for p in papers:
        analyses = db.get_analyses_for_paper(p.id)
        claims = db.get_claims_for_paper(p.id)
        results.append({
            "id": p.id,
            "title": p.title,
            "authors": p.authors,
            "abstract": p.abstract or "",
            "year": p.year,
            "source": p.source,
            "page_count": p.page_count,
            "created_at": p.created_at,
            "analysis_types": [a.analysis_type for a in analyses],
            "chunk_count": len(claims),  # extracted claims count — meaningful to display
        })
    return results


import re as _re

def _strip_scaffolding(text: str) -> str:
    """Remove prompt-scaffolding labels and unrendered markdown syntax from
    stored analysis content. The UI renders this as plain text, so leftover
    ## headers and **bold** markers from the LLM's output show up raw."""
    # Strip lines that are purely uppercase labels (TITLE:, OBJECTIVE:, etc.)
    lines = text.split("\n")
    cleaned = []
    for line in lines:
        stripped = line.strip()
        # Skip standalone scaffolding header lines
        if _re.match(r"^(TITLE|OBJECTIVE|APPROACH|FINDINGS|METHODS|LIMITATIONS|KEY CLAIMS|RESEARCH GAPS|SUMMARY|SECTION)\s*:", stripped, _re.IGNORECASE):
            continue
        # Strip leading ## / ### markdown headers (keep the text after)
        line = _re.sub(r"^#{1,6}\s+", "", line)
        # Convert **bold** and *italic* markdown to plain text
        line = _re.sub(r"\*\*(.+?)\*\*", r"\1", line)
        line = _re.sub(r"(?<!\*)\*(?!\*)(.+?)\*(?!\*)", r"\1", line)
        cleaned.append(line)
    return "\n".join(cleaned).strip()


@app.get("/api/papers/{paper_id}")
def get_paper(paper_id: str):
    paper = db.get_paper(paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")
    analyses = db.get_analyses_for_paper(paper_id)
    chunks = db.get_chunks_for_paper(paper_id)
    return {
        "id": paper.id,
        "title": paper.title,
        "authors": paper.authors,
        "abstract": paper.abstract,
        "year": paper.year,
        "source": paper.source,
        "page_count": paper.page_count,
        "created_at": paper.created_at,
        "chunk_count": len(chunks),
        "analyses": [
            {
                "id": a.id,
                "type": a.analysis_type,
                "content": _strip_scaffolding(a.content),
                "created_at": a.created_at,
            }
            for a in analyses
        ],
    }


@app.delete("/api/papers/{paper_id}")
def delete_paper(paper_id: str):
    paper = db.get_paper(paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")
    # Capture this paper's claim IDs before the cascade removes them,
    # so we can also purge relationships that reference them.
    claim_ids = [c.id for c in db.get_claims_for_paper(paper_id)]
    # Remove from vector store first, then DB (cascade deletes chunks, analyses, claims)
    agent.vector_store.delete_paper_chunks(paper_id)
    db.delete_paper(paper_id)
    # Purge relationships referencing this paper's claims (no FK cascade on those)
    if claim_ids:
        import sqlite3
        conn = sqlite3.connect(str(db.db_path))
        placeholders = ",".join("?" * len(claim_ids))
        conn.execute(
            f"DELETE FROM relationships WHERE claim_lo IN ({placeholders}) OR claim_hi IN ({placeholders})",
            claim_ids + claim_ids,
        )
        conn.commit()
        conn.close()
    _invalidate_insight_cache()
    return {"status": "deleted", "id": paper_id}


@app.get("/api/papers/{paper_id}/status")
def paper_status(paper_id: str):
    """Check analysis completion status."""
    paper = db.get_paper(paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")
    analyses = db.get_analyses_for_paper(paper_id)
    analysis_types = [a.analysis_type for a in analyses]
    all_types = {"summary", "methods", "findings", "limitations", "key_claims", "research_gaps"}
    return {
        "id": paper_id,
        "title": paper.title,
        "analysis_count": len(analyses),
        "analysis_types": analysis_types,
        "complete": all_types.issubset(set(analysis_types)),
        "missing": list(all_types - set(analysis_types)),
    }


# ── Upload & Analyze ─────────────────────────────────────────

@app.post("/api/papers/upload")
async def upload_paper(
    file: UploadFile = File(...),
    background_tasks: BackgroundTasks = BackgroundTasks(),
):
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files accepted")

    # Save file
    save_path = UPLOAD_DIR / file.filename
    content = await file.read()
    save_path.write_bytes(content)

    # Ingest (extract + chunk + embed) — this is fast enough to do inline
    paper = agent.ingest_pdf(save_path, filename=file.filename)

    # Dedup: if a paper with the same title/DOI already exists, roll back
    existing = db.find_duplicate(paper.title, doi=paper.doi, arxiv_id=paper.arxiv_id)
    if existing and existing.id != paper.id:
        agent.vector_store.delete_paper_chunks(paper.id)
        db.delete_paper(paper.id)
        return {
            "id": existing.id,
            "title": existing.title,
            "status": "duplicate",
            "message": f"This paper is already in your library: \"{existing.title}\".",
        }

    # Analyze in background (parallel — ~5x faster than sequential loop)
    background_tasks.add_task(_analyze_paper_bg, paper.id)
    _invalidate_insight_cache()

    return {
        "id": paper.id,
        "title": paper.title,
        "authors": paper.authors,
        "year": paper.year,
        "page_count": paper.page_count,
        "status": "analyzing",
        "message": "Paper uploaded and ingested. Analysis running in background. "
                   "Poll /api/papers/{id}/status to check progress.",
    }


@app.post("/api/papers/{paper_id}/reanalyze")
def reanalyze_paper(paper_id: str, background_tasks: BackgroundTasks = BackgroundTasks()):
    """Re-run analysis on an already-ingested paper."""
    paper = db.get_paper(paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")
    # Invalidate cached claims + their relationships so they're freshly derived
    claim_ids = [c.id for c in db.get_claims_for_paper(paper_id)]
    db.delete_claims_for_paper(paper_id)
    if claim_ids:
        import sqlite3
        conn = sqlite3.connect(str(db.db_path))
        placeholders = ",".join("?" * len(claim_ids))
        conn.execute(
            f"DELETE FROM relationships WHERE claim_lo IN ({placeholders}) OR claim_hi IN ({placeholders})",
            claim_ids + claim_ids,
        )
        conn.commit()
        conn.close()
    background_tasks.add_task(_analyze_paper_bg, paper_id)
    return {"id": paper_id, "status": "analyzing"}


# ── TASK 2: Grounded Claim Extraction ───────────────────────

@app.post("/api/papers/{paper_id}/extract-claims")
def extract_claims(
    paper_id: str,
    background_tasks: BackgroundTasks,
    force: bool = Query(False, description="Re-extract even if grounded claims already exist."),
):
    """
    Extract evidence-grounded claims directly from a paper's source text.

    Unlike the old path (summary -> claim extraction), this goes to the raw
    stored text so every claim carries: evidence (n, p-value, effect size,
    design), conditions (scope), and a verbatim source_quote anchor.

    Returns cached grounded claims immediately if they exist (force=False).
    Pass force=True to delete existing claims and re-extract from scratch.
    """
    paper = db.get_paper(paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")
    if not paper.full_text:
        raise HTTPException(
            status_code=422,
            detail="Paper has no stored text. Re-upload the PDF to ingest it first.",
        )

    claims = agent.extract_grounded_claims(paper_id, force=force)
    grounded = [c for c in claims if c.evidence is not None]

    return {
        "paper_id": paper_id,
        "total": len(claims),
        "grounded": len(grounded),
        "legacy": len(claims) - len(grounded),
        "claims": [
            {
                "id": c.id,
                "text": c.text,
                "section": c.section,
                "confidence": c.confidence,
                "evidence": c.evidence,
                "conditions": c.conditions,
                "source_quote": c.source_quote,
                "grounded": c.evidence is not None,
            }
            for c in claims
        ],
    }


@app.post("/api/papers/backfill-claims")
def backfill_claims(
    background_tasks: BackgroundTasks,
    force: bool = Query(False, description="Re-extract even papers that already have grounded claims."),
    limit: int = Query(50, description="Max papers to backfill."),
):
    """
    Queue grounded claim extraction for every paper in the library that
    lacks grounded claims. Runs each paper as a background task.
    Use after upgrading from legacy (summary-based) extraction, or after
    a prompt change with force=True.
    """
    papers = db.list_papers(limit=limit)
    queued = []

    for paper in papers:
        if not paper.full_text:
            continue
        existing = db.get_claims_for_paper(paper.id)
        already_grounded = any(c.evidence is not None for c in existing)
        if already_grounded and not force:
            continue
        background_tasks.add_task(_extract_claims_bg, paper.id, force)
        queued.append(paper.id)

    return {
        "queued": len(queued),
        "paper_ids": queued,
        "message": f"Grounded extraction queued for {len(queued)} papers.",
    }


# ── Search & QA ──────────────────────────────────────────────

@app.post("/api/search")
def search_papers(req: SearchRequest):
    """
    Semantic search across the paper library.

    Relevance fields returned per result:
      relevance_tier  — "highly_relevant" | "related" | "tangential"
                        Defined thresholds on cosine distance, calibrated for
                        MiniLM on narrow-domain academic text. Honest and
                        explainable; replaces the previous fake-precise percentage.
      relevance_score — raw cosine distance in [0, 1] (lower = more similar).
                        Exposed so the frontend can sort or filter if needed,
                        but not intended for display to end users.

    Thresholds (from settings):
      < 0.20  → highly_relevant
      < 0.40  → related
      >= 0.40 → tangential
    """
    results = agent.vector_store.search(
        query=req.query,
        n_results=req.n_results,
        paper_id=req.paper_id,
    )

    response = []
    for r in results:
        paper = db.get_paper(r.paper_id)
        response.append({
            "paper_id": r.paper_id,
            "paper_title": paper.title if paper else "Unknown",
            "section": r.section,
            "text": r.text[:800],
            "relevance_tier": settings.relevance_tier(r.score),
            "relevance_score": round(r.score, 4),
        })
    return response


@app.post("/api/ask")
def ask_question(req: AskRequest):
    answer = agent.ask(req.question, paper_id=req.paper_id)
    return {"answer": answer}


# ── Contradictions ───────────────────────────────────────────

@app.get("/api/contradictions/count")
def contradiction_count():
    """Lightweight endpoint — returns cached relationship counts with no LLM calls."""
    rels = db.list_relationships()
    counts = {"contradiction": 0, "support": 0, "nuance": 0, "unrelated": 0}
    for r in rels:
        if r.relationship in counts:
            counts[r.relationship] += 1
    last = max((r.created_at for r in rels), default=None) if rels else None
    return {"counts": counts, "total": len(rels), "last_scanned": last}


@app.get("/api/contradictions")
def list_contradictions():
    """
    Return the full persisted relationship set — every relationship ever
    judged, reconstructed into the same shape the scan POST returns.

    This is the source of truth for the conflict map: it shows accumulated
    knowledge across all scans, keeping it consistent with the dashboard's
    /api/contradictions/count (which reads the same table). Pure DB read,
    zero LLM calls. "unrelated" and "error" rows are excluded from the main
    view but still counted by the count endpoint.
    """
    rels = db.list_relationships()

    # Build a claim-id -> claim object map once (DB read, no LLM).
    claim_by_id = {}
    claim_paper_title = {}
    for p in db.list_papers(limit=200):
        for c in db.get_claims_for_paper(p.id):
            claim_by_id[c.id] = c
            claim_paper_title[c.id] = p.title

    out = []
    for r in rels:
        if r.relationship in ("error", "unrelated"):
            continue
        a = claim_by_id.get(r.claim_lo)
        b = claim_by_id.get(r.claim_hi)
        if not a or not b:
            continue  # claim was deleted; skip orphaned relationship
        out.append({
            "id": r.id,
            "relationship": r.relationship,
            "category": r.category,
            "explanation": r.explanation,
            "resolution": r.resolution,
            "stronger_evidence": r.stronger_evidence,
            "similarity": round(r.similarity, 3),
            "claim_a": {
                "paper_id": a.paper_id,
                "paper_title": claim_paper_title.get(a.id, "Unknown paper"),
                "text": a.text,
                "confidence": a.confidence,
            },
            "claim_b": {
                "paper_id": b.paper_id,
                "paper_title": claim_paper_title.get(b.id, "Unknown paper"),
                "text": b.text,
                "confidence": b.confidence,
            },
            "created_at": r.created_at,
        })

    # Sort: contradictions first, then nuance, then support; newest within each.
    order = {"contradiction": 0, "nuance": 1, "support": 2}
    out.sort(key=lambda x: (order.get(x["relationship"], 9), x["created_at"] or ""), reverse=False)
    return out


@app.post("/api/contradictions")
def run_contradictions(req: ContradictionRequest):
    results = contradiction_agent.run_contradiction_scan(
        paper_ids=req.paper_ids,
        similarity_threshold=req.similarity_threshold,
        max_pairs=req.max_pairs,
    )
    # Invalidate insight cache so research wire reflects new relationships immediately
    _invalidate_insight_cache()

    return [
        {
            "id": r.id,
            "relationship": r.relationship,
            "category": r.category,
            "explanation": r.explanation,
            "resolution": r.resolution,
            "stronger_evidence": r.stronger_evidence,
            "similarity": round(r.similarity, 3),
            "claim_a": {
                "paper_id": r.claim_a.paper_id,
                "paper_title": r.claim_a.paper_title,
                "text": r.claim_a.text,
                "confidence": r.claim_a.confidence,
            },
            "claim_b": {
                "paper_id": r.claim_b.paper_id,
                "paper_title": r.claim_b.paper_title,
                "text": r.claim_b.text,
                "confidence": r.claim_b.confidence,
            },
            "created_at": r.created_at,
        }
        for r in results
    ]


# ── Hypotheses ───────────────────────────────────────────────

@app.post("/api/hypotheses")
def generate_hypotheses(req: HypothesisRequest):
    """
    Generate testable hypotheses from the library.

    Response changes from previous version:
      - source_conflicts: list of validated relationship IDs the hypothesis draws from
      - grounding: "detected_conflicts" | "single_paper_gaps"
      - novelty_score: cosine distance from nearest library chunk (0–1, higher = more novel)
      - novelty_tier: "high" | "medium" | "low" | "unknown"
      - impact: REMOVED (no reliable signal — no citation data in DB)
      - novelty_explanation: REMOVED (replaced by novelty_score + novelty_tier)

    Pass refresh=true to bypass the output cache.
    Cache auto-invalidates when a new contradiction scan runs.
    """
    hypotheses = hypothesis_agent.generate(
        research_question=req.research_question,
        paper_ids=req.paper_ids,
        num_hypotheses=req.num_hypotheses,
        force_refresh=req.refresh,
    )

    return [
        {
            "id": h.id,
            "statement": h.statement,
            "rationale": h.rationale,
            "source_conflicts": h.source_conflicts,
            "supporting_papers": h.supporting_papers,
            "methodology": h.methodology,
            "challenges": h.challenges,
            "novelty_score": h.novelty_score,
            "novelty_tier": h.novelty_tier,
            "grounding": h.grounding,
            "research_question": h.research_question,
            "created_at": h.created_at,
        }
        for h in hypotheses
    ]


# ── Import ───────────────────────────────────────────────────

@app.post("/api/import/search")
def import_search(req: ImportSearchRequest):
    results = importer.search(
        query=req.query,
        sources=req.sources,
        max_per_source=req.max_per_source,
    )

    return [
        {
            "title": r.title,
            "authors": r.authors,
            "abstract": r.abstract or "",
            "year": r.year,
            "source": r.source,
            "source_id": r.source_id,
            "doi": r.doi,
            "pdf_url": r.pdf_url,
            "citation_count": r.citation_count,
            "url": r.url,
        }
        for r in results
    ]


@app.post("/api/import/lookup")
def import_lookup(req: ImportLookupRequest):
    """Look up a paper by arXiv ID, DOI, or URL."""
    result = importer.lookup(req.identifier)
    if not result:
        raise HTTPException(status_code=404, detail="Paper not found")
    return {
        "title": result.title,
        "authors": result.authors,
        "abstract": result.abstract or "",
        "year": result.year,
        "source": result.source,
        "source_id": result.source_id,
        "doi": result.doi,
        "pdf_url": result.pdf_url,
        "citation_count": result.citation_count,
        "url": result.url,
    }


def _normalize_abstract(text: str | None) -> str:
    """
    Clean abstracts from arXiv / Semantic Scholar before storing.

    External APIs return abstracts with:
    - Embedded newlines mid-sentence (arXiv wraps at ~80 chars)
    - Multiple consecutive spaces
    - Leading/trailing whitespace

    We replace newlines with spaces and collapse runs so the abstract reads
    as a single clean paragraph. This fixes mid-word truncation in the UI
    that occurred when the truncation point landed on a newline.
    """
    if not text:
        return ""
    import re as _re
    text = text.replace("\r\n", " ").replace("\n", " ").replace("\r", " ")
    text = _re.sub(r"[ \t]+", " ", text)
    return text.strip()


@app.post("/api/import/add")
def import_add(
    req: ImportAddRequest,
    background_tasks: BackgroundTasks = BackgroundTasks(),
):
    from agents.paper_import import ImportResult

    result = ImportResult(
        title=req.title,
        authors=req.authors,
        abstract=req.abstract,
        year=req.year,
        source=req.source,
        source_id=req.source_id,
        doi=req.doi,
        pdf_url=req.pdf_url,
        citation_count=None,
        url=req.url,
    )

    # Dedup BEFORE downloading — we already have title/DOI/arXiv ID from the source
    arxiv_id = req.source_id if req.source == "arxiv" else None
    existing = db.find_duplicate(req.title, doi=req.doi, arxiv_id=arxiv_id)
    if existing:
        return {
            "id": existing.id,
            "title": existing.title,
            "status": "duplicate",
            "message": f"This paper is already in your library: \"{existing.title}\".",
        }

    # Download PDF
    pdf_path = importer.download_pdf(result)
    if not pdf_path:
        raise HTTPException(
            status_code=400,
            detail="PDF download failed. The paper may not have an open-access PDF.",
        )

    # Ingest into library
    paper = agent.ingest_pdf(pdf_path, filename=pdf_path.name)

    # Update metadata from the source (better than what PDF extraction finds)
    import sqlite3
    conn = sqlite3.connect(str(db.db_path))
    conn.execute(
        "UPDATE papers SET title=?, authors=?, abstract=?, year=?, source=?, doi=?, arxiv_id=? WHERE id=?",
        (req.title, json.dumps(req.authors), _normalize_abstract(req.abstract), req.year,
         req.source, req.doi, arxiv_id, paper.id),
    )
    conn.commit()
    conn.close()

    # Analyze in background
    background_tasks.add_task(_analyze_paper_bg, paper.id)
    _invalidate_insight_cache()

    return {
        "id": paper.id,
        "title": req.title,
        "status": "analyzing",
        "message": "Paper imported and queued for analysis.",
    }


# ── Monitor ──────────────────────────────────────────────────

@app.post("/api/monitor/scan")
def monitor_scan(req: MonitorRequest):
    topics = [
        MonitorTopic(
            name=t["name"],
            keywords=t["keywords"],
            sources=t.get("sources", ["arxiv", "semantic_scholar"]),
        )
        for t in req.topics
    ]

    results, email_sent, email_error, sources_failed = monitor.run_full_scan(
        topics=topics,
        recipient=req.email,
        max_per_source=req.max_per_source,
        relevance_threshold=req.relevance_threshold,
    )

    digests = [
        {
            "topic": r.topic,
            "papers_found": r.papers_found,
            "papers_relevant": r.papers_relevant,
            "scan_time": r.scan_time,
            "papers": [
                {
                    "title": sp.paper.title,
                    "authors": sp.paper.authors,
                    "year": sp.paper.year,
                    "source": sp.paper.source,
                    "abstract": sp.paper.abstract or "",
                    "url": sp.paper.url,
                    "pdf_url": sp.paper.pdf_url,
                    "relevance_score": sp.relevance_score,
                    "relevance_tier": settings.relevance_tier(sp.relevance_score)
                                       if hasattr(settings, "relevance_tier") else None,
                    "relevance_reason": sp.relevance_reason,
                }
                for sp in r.scored_papers
            ],
        }
        for r in results
    ]

    # Wrap digests with truthful email status so the UI never claims a send
    # that didn't actually happen. email_requested lets the UI distinguish
    # "no email entered" from "email entered but failed".
    return {
        "digests": digests,
        "email_requested": bool(req.email),
        "email_sent": email_sent,
        "email_error": email_error,
        "sources_failed": sources_failed,
    }


# ── Knowledge Graph ──────────────────────────────────────────

class GraphRequest(BaseModel):
    paper_ids: Optional[list[str]] = None
    similarity_threshold: float = 0.40
    max_pairs: int = 120
    # Default False = read-only. Edges are read straight from the persisted
    # `relationships` table (zero LLM calls, no new writes, watermark stays
    # put so viewing the graph never invalidates the hypothesis cache).
    # Pass True to run the live two-stage pipeline, which judges new pairs
    # and writes them through — use only to deliberately expand coverage.
    compute: bool = False


def _build_graph_readonly(papers):
    """
    Assemble the graph from the persisted relationships table — no agent
    calls, no LLM, no writes. This is the same data the conflict map and
    hypothesis grounding read, so all three stay consistent.

    Claims come from db.get_claims_for_paper (pure DB read). Edges come from
    db.list_relationships scoped to the selected papers. Every paper that has
    a relationship is represented; papers with no detected relationships
    simply have no nodes (same as before — isolated claims are hidden).
    """
    scope_ids = [p.id for p in papers]

    # Claim lookup: id -> (claim object, paper title). Pure DB read.
    claim_by_id = {}
    for p in papers:
        for c in db.get_claims_for_paper(p.id):
            claim_by_id[c.id] = (c, p.title)

    rels = db.list_relationships(paper_ids=scope_ids)

    edges = []
    connected_claim_ids = set()
    for r in rels:
        if r.relationship in ("error", "unrelated"):
            continue
        # Both endpoints must resolve to claims inside our scope.
        if r.claim_lo not in claim_by_id or r.claim_hi not in claim_by_id:
            continue
        edges.append({
            "source": r.claim_lo,
            "target": r.claim_hi,
            "relationship": r.relationship,
            "category": r.category,
            "similarity": round(r.similarity, 3),
            "explanation": r.explanation,
        })
        connected_claim_ids.add(r.claim_lo)
        connected_claim_ids.add(r.claim_hi)

    degree: dict[str, int] = {}
    for e in edges:
        degree[e["source"]] = degree.get(e["source"], 0) + 1
        degree[e["target"]] = degree.get(e["target"], 0) + 1

    nodes = []
    for cid in connected_claim_ids:
        c, title = claim_by_id[cid]
        nodes.append({
            "id": c.id,
            "claim": c.text,
            "paper_id": c.paper_id,
            "paper_title": title,
            "section": c.section,
            "confidence": c.confidence,
            "degree": degree.get(c.id, 0),
        })

    return {
        "nodes": nodes,
        "edges": edges,
        "papers": [{"id": p.id, "title": p.title} for p in papers],
    }


def _build_graph_compute(req, papers):
    """
    Live pipeline: judge pairs and write them through to the relationships
    table. This is the original behaviour, preserved behind compute=true.

    Coverage guarantee: after selecting the top-N pairs by similarity, we
    check which papers have zero representation and inject their single best
    pair regardless of score, so every paper with claims appears.

    Cost note: judge_pair() reads from the DB cache first. Pairs already
    judged by a previous scan are cache hits; only genuinely new pairs fire
    the LLM judge (and get persisted, moving the relationships watermark).
    """
    # Extract claims (DB-first, zero LLM if already cached)
    all_claims = []
    for paper in papers:
        all_claims.extend(contradiction_agent.extract_claims(paper.id))

    if len(all_claims) < 2:
        return {"nodes": [], "edges": [], "papers": [{"id": p.id, "title": p.title} for p in papers]}

    # Find cross-paper pairs sorted by similarity descending
    all_pairs = contradiction_agent.find_claim_pairs(all_claims, req.similarity_threshold)

    # Select top-N pairs, then apply per-paper fairness guarantee:
    # any paper not yet represented gets its single best pair added back in.
    selected = list(all_pairs[: req.max_pairs])
    represented_papers = set()
    for pair in selected:
        represented_papers.add(pair.claim_a.paper_id)
        represented_papers.add(pair.claim_b.paper_id)

    # All pairs sorted by similarity (best first) for fairness injection
    all_pairs_by_paper: dict[str, list] = {}
    for pair in all_pairs:
        for pid in [pair.claim_a.paper_id, pair.claim_b.paper_id]:
            all_pairs_by_paper.setdefault(pid, []).append(pair)

    # Inject the best pair for any unrepresented paper — only if a cross-paper
    # pair exists for it at all (some papers may have no similar claims to others)
    for paper in papers:
        if paper.id not in represented_papers:
            candidates = all_pairs_by_paper.get(paper.id, [])
            if candidates:
                best = candidates[0]
                if best not in selected:
                    selected.append(best)
                    represented_papers.add(best.claim_a.paper_id)
                    represented_papers.add(best.claim_b.paper_id)

    # Judge each selected pair (DB cache hit for most; LLM only for new pairs)
    edges = []
    connected_claim_ids = set()
    for pair in selected:
        result = contradiction_agent.judge_pair(pair)
        if result.relationship == "error":
            continue
        edges.append({
            "source": pair.claim_a.id,
            "target": pair.claim_b.id,
            "relationship": result.relationship,
            "category": result.category,
            "similarity": round(pair.similarity, 3),
            "explanation": result.explanation,
        })
        connected_claim_ids.add(pair.claim_a.id)
        connected_claim_ids.add(pair.claim_b.id)

    # The compute path may have written new relationships via judge_pair.
    # Invalidate the insight cache so the dashboard and research wire reflect
    # them immediately — same contract as the contradiction scan endpoint.
    # Without this, expanding the graph can surface contradictions that the
    # dashboard's "top contradiction" card never sees (stale cache).
    _invalidate_insight_cache()

    # Degree count for node sizing
    degree: dict[str, int] = {}
    for e in edges:
        degree[e["source"]] = degree.get(e["source"], 0) + 1
        degree[e["target"]] = degree.get(e["target"], 0) + 1

    nodes = [
        {
            "id": c.id,
            "claim": c.text,
            "paper_id": c.paper_id,
            "paper_title": c.paper_title,
            "section": c.section,
            "confidence": c.confidence,
            "degree": degree.get(c.id, 0),
        }
        for c in all_claims
        if c.id in connected_claim_ids
    ]

    return {
        "nodes": nodes,
        "edges": edges,
        "papers": [{"id": p.id, "title": p.title} for p in papers],
    }


@app.post("/api/graph")
def build_graph(req: GraphRequest):
    """
    Assemble a claim-level knowledge graph.

    Nodes  = claims extracted from papers (the atomic unit).
    Edges  = relationships between claims (contradiction/support/nuance).

    Read-only by default (compute=false): edges come straight from the
    persisted relationships table — zero LLM calls, no writes, and the
    relationships watermark never moves, so viewing the graph will not
    invalidate the hypothesis cache. This keeps the graph, the conflict
    map, and the hypothesis grounding consistent with one another.

    Pass compute=true to run the live two-stage pipeline (judges new pairs,
    writes them through, applies the per-paper fairness guarantee). Use that
    only when deliberately expanding coverage.
    """
    if req.paper_ids:
        papers = [db.get_paper(pid) for pid in req.paper_ids]
        papers = [p for p in papers if p is not None]
    else:
        papers = db.list_papers(limit=50)

    if len(papers) < 2:
        return {"nodes": [], "edges": [], "papers": []}

    if req.compute:
        return _build_graph_compute(req, papers)
    return _build_graph_readonly(papers)


# ── Insight Feed ─────────────────────────────────────────────

class InsightRequest(BaseModel):
    paper_ids: Optional[list[str]] = None
    limit: int = 30


@app.post("/api/insights")
def insight_feed(req: InsightRequest):
    """
    Synthesize a stream of typed insights from existing agent outputs.

    Sources:
      - newest papers         → new_paper insights
      - research_gaps analyses → gap insights
      - relationships table   → contradiction / consensus insights (zero LLM calls)

    Cache: assembled list is cached in-process for _INSIGHT_CACHE_TTL seconds
    (default 2 hours). Invalidated immediately on any paper add or delete so
    the feed always reflects the current library state after writes.
    """
    import uuid

    # ── Cache read ────────────────────────────────────────────
    now = _time.time()
    if (
        _insight_cache["payload"] is not None
        and (now - _insight_cache["ts"]) < _INSIGHT_CACHE_TTL
    ):
        return _insight_cache["payload"][: req.limit]

    # ── Assemble insights (all DB reads, zero LLM calls) ─────
    insights = []

    # Newest papers
    papers = db.list_papers(limit=10)
    for p in papers[:5]:
        insights.append({
            "id": str(uuid.uuid4()),
            "type": "new_paper",
            "headline": p.title,
            "claim": "",
            "detail": (p.abstract or "")[:400],
            "papers": [p.title],
            "created_at": p.created_at,
        })

    def _truncate(s: str, n: int) -> str:
        """Word-boundary truncation — avoids cutting headlines mid-word."""
        if len(s) <= n:
            return s
        cut = s[:n].rsplit(" ", 1)[0]
        return cut + "…"

    # Track papers already surfaced by a cross-paper relationship insight, so a
    # single dominant paper does not headline both a contradiction AND a gap.
    # Cross-paper relationships are higher-value signal than single-paper gaps,
    # so they claim their papers first and gaps fill in only what is left.
    papers_in_relationships: set[str] = set()

    # Contradiction / consensus / nuance insights — from the relationships table.
    try:
        cached_rels = db.list_relationships()
        claim_paper: dict[str, str] = {}
        for p in db.list_papers(limit=200):
            for c in db.get_claims_for_paper(p.id):
                claim_paper[c.id] = p.title

        def _strip_paper_prefix(sentence: str, title_a: str, title_b: str) -> str:
            """
            The explanation's first sentence usually leads with a paper title
            ("<Paper> reports that ..."). The paper names are already shown in
            the papers chip, so repeating them in the headline is redundant.
            Strip a leading paper-title prefix (plus a reporting verb) so the
            headline leads with the actual finding.
            """
            s = sentence
            for title in (title_a, title_b):
                if title and title != "Unknown paper" and s.startswith(title):
                    s = s[len(title):].lstrip(" :—-")
                    # Drop a leading reporting verb so it reads cleanly.
                    for verb in ("reports that ", "documents that ", "establishes that ",
                                 "finds that ", "shows that ", "demonstrates that ",
                                 "identifies that ", "reports ", "documents ", "finds ",
                                 "shows ", "establishes "):
                        if s.lower().startswith(verb):
                            s = s[len(verb):]
                            break
                    break
            # Capitalise first letter if we stripped into a lowercase start.
            return s[:1].upper() + s[1:] if s else sentence

        for rel in cached_rels:
            if rel.relationship in ("error", "unrelated"):
                continue

            ta = claim_paper.get(rel.claim_lo, "Unknown paper")
            tb = claim_paper.get(rel.claim_hi, "Unknown paper")
            explanation = rel.explanation or ""
            first_sentence = explanation.split(".")[0].strip() if explanation else ""
            first_sentence = _strip_paper_prefix(first_sentence, ta, tb)

            if rel.relationship == "contradiction":
                headline = _truncate(first_sentence, 120) if first_sentence else f"Conflicting findings between {ta[:40]} and {tb[:40]}"
                insights.append({
                    "id": rel.id, "type": "contradiction", "headline": headline,
                    "claim": "", "detail": explanation,
                    "papers": [ta, tb], "created_at": rel.created_at,
                })
                papers_in_relationships.add(ta); papers_in_relationships.add(tb)
            elif rel.relationship == "support":
                headline = _truncate(first_sentence, 120) if first_sentence else f"Converging evidence across {ta[:40]} and {tb[:40]}"
                insights.append({
                    "id": rel.id, "type": "consensus", "headline": headline,
                    "claim": "", "detail": explanation,
                    "papers": [ta, tb], "created_at": rel.created_at,
                })
                papers_in_relationships.add(ta); papers_in_relationships.add(tb)
            elif rel.relationship == "nuance":
                if len(explanation) > 80:
                    headline = _truncate(first_sentence, 120) if first_sentence else f"Boundary condition between {ta[:40]} and {tb[:40]}"
                    insights.append({
                        "id": rel.id, "type": "gap", "headline": headline,
                        "claim": "", "detail": explanation,
                        "papers": [ta, tb], "created_at": rel.created_at,
                    })
                    papers_in_relationships.add(ta); papers_in_relationships.add(tb)
    except Exception as e:
        print(f"Insight relationship read skipped: {e}")

    # Gap insights from research_gaps analyses — but ONLY for papers that aren't
    # already represented by a relationship insight above. This is the dedup
    # that stops one paper from headlining multiple cells on the dashboard.
    for p in papers[:8]:
        if p.title in papers_in_relationships:
            continue
        analyses = db.get_analyses_for_paper(p.id)
        for a in analyses:
            if a.analysis_type == "research_gaps" and a.content:
                lines = [l.strip() for l in a.content.strip().split("\n") if l.strip()]
                first = lines[0][:180] if lines else ""
                insights.append({
                    "id": str(uuid.uuid4()),
                    "type": "gap",
                    "headline": first,
                    "claim": "",
                    "detail": a.content[:600],
                    "papers": [p.title],
                    "created_at": p.created_at,
                })
                break

    # Order the feed by signal priority, newest-first within each type.
    # Contradictions are the highest-value signal and must never be buried by a
    # large volume of lower-signal nuance/gap insights — otherwise a limit-
    # capped consumer (e.g. the dashboard's top-contradiction card) misses them.
    #
    # Two stable sorts: first by recency (newest first), then by type priority.
    # Python's sort is stable, so the recency order is preserved within each
    # priority group.
    _TYPE_PRIORITY = {
        "contradiction": 0,
        "consensus": 1,
        "hypothesis": 2,
        "gap": 3,
        "new_paper": 4,
    }
    insights.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    insights.sort(key=lambda x: _TYPE_PRIORITY.get(x.get("type", ""), 9))

    # ── Cache write ───────────────────────────────────────────
    _insight_cache["payload"] = insights
    _insight_cache["ts"] = _time.time()

    return insights[: req.limit]
