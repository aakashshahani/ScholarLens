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
    paper_count = len(db.list_papers(limit=1000))
    embedding_count = agent.vector_store.count()
    return {
        "status": "ok" if not errors else "degraded",
        "errors": errors,
        "papers": paper_count,
        "embeddings": embedding_count,
    }


# ── Papers ───────────────────────────────────────────────────

@app.get("/api/papers")
def list_papers(limit: int = 50, offset: int = 0):
    papers = db.list_papers(limit=limit, offset=offset)
    results = []
    for p in papers:
        analyses = db.get_analyses_for_paper(p.id)
        results.append({
            "id": p.id,
            "title": p.title,
            "authors": p.authors,
            "abstract": p.abstract[:300] if p.abstract else "",
            "year": p.year,
            "source": p.source,
            "page_count": p.page_count,
            "created_at": p.created_at,
            "analysis_types": [a.analysis_type for a in analyses],
        })
    return results


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
                "content": a.content,
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

    # Analyze in background (6 LLM calls, takes ~30s)
    background_tasks.add_task(_analyze_paper_bg, paper.id)

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
    results = agent.vector_store.search(
        query=req.query,
        n_results=req.n_results,
        paper_id=req.paper_id,
    )

    response = []
    for r in results:
        paper = db.get_paper(r.paper_id)
        relevance = max(0, min(100, int((1 - r.score) * 100)))
        response.append({
            "paper_id": r.paper_id,
            "paper_title": paper.title if paper else "Unknown",
            "section": r.section,
            "text": r.text[:500],
            "relevance": relevance,
        })
    return response


@app.post("/api/ask")
def ask_question(req: AskRequest):
    answer = agent.ask(req.question, paper_id=req.paper_id)
    return {"answer": answer}


# ── Contradictions ───────────────────────────────────────────

@app.post("/api/contradictions")
def run_contradictions(req: ContradictionRequest):
    results = contradiction_agent.run_contradiction_scan(
        paper_ids=req.paper_ids,
        similarity_threshold=req.similarity_threshold,
        max_pairs=req.max_pairs,
    )

    return [
        {
            "id": r.id,
            "relationship": r.relationship,
            "category": r.category,
            "explanation": r.explanation,
            "resolution": r.resolution,
            "stronger_evidence": r.stronger_evidence,
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
    hypotheses = hypothesis_agent.generate(
        research_question=req.research_question,
        paper_ids=req.paper_ids,
        num_hypotheses=req.num_hypotheses,
    )

    return [
        {
            "id": h.id,
            "statement": h.statement,
            "rationale": h.rationale,
            "supporting_papers": h.supporting_papers,
            "methodology": h.methodology,
            "challenges": h.challenges,
            "novelty": h.novelty,
            "novelty_explanation": h.novelty_explanation,
            "impact": h.impact,
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
            "abstract": r.abstract[:300] if r.abstract else "",
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
        "abstract": result.abstract[:300] if result.abstract else "",
        "year": result.year,
        "source": result.source,
        "source_id": result.source_id,
        "doi": result.doi,
        "pdf_url": result.pdf_url,
        "citation_count": result.citation_count,
        "url": result.url,
    }


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
        (req.title, json.dumps(req.authors), req.abstract, req.year,
         req.source, req.doi, arxiv_id, paper.id),
    )
    conn.commit()
    conn.close()

    # Analyze in background
    background_tasks.add_task(_analyze_paper_bg, paper.id)

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

    results = monitor.run_full_scan(
        topics=topics,
        recipient=req.email,
        max_per_source=req.max_per_source,
        relevance_threshold=req.relevance_threshold,
    )

    return [
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
                    "abstract": sp.paper.abstract[:300] if sp.paper.abstract else "",
                    "url": sp.paper.url,
                    "pdf_url": sp.paper.pdf_url,
                    "relevance_score": sp.relevance_score,
                    "relevance_reason": sp.relevance_reason,
                }
                for sp in r.scored_papers
            ],
        }
        for r in results
    ]


# ── Knowledge Graph ──────────────────────────────────────────

class GraphRequest(BaseModel):
    paper_ids: Optional[list[str]] = None
    similarity_threshold: float = 0.5
    max_pairs: int = 30


@app.post("/api/graph")
def build_graph(req: GraphRequest):
    """
    Assemble a claim-level knowledge graph.

    Nodes  = claims extracted from papers (the atomic unit).
    Edges  = relationships between claims (contradiction/support/nuance),
             reusing the contradiction agent's two-stage pipeline.

    This shapes data the contradiction agent already produces into a
    graph payload the frontend force-simulation can render.
    """
    # Pick papers
    if req.paper_ids:
        papers = [db.get_paper(pid) for pid in req.paper_ids]
        papers = [p for p in papers if p is not None]
    else:
        papers = db.list_papers(limit=50)

    if len(papers) < 2:
        return {"nodes": [], "edges": [], "papers": []}

    # Stage 1: extract claims from each paper
    all_claims = []
    for paper in papers:
        all_claims.extend(contradiction_agent.extract_claims(paper.id))

    if len(all_claims) < 2:
        return {"nodes": [], "edges": [], "papers": [{"id": p.id, "title": p.title} for p in papers]}

    # Stage 1b: find similar pairs across papers
    pairs = contradiction_agent.find_claim_pairs(all_claims, req.similarity_threshold)
    pairs = pairs[: req.max_pairs]

    # Stage 2: judge each pair → becomes an edge
    edges = []
    connected_claim_ids = set()
    for pair in pairs:
        result = contradiction_agent.judge_pair(pair)
        if result.relationship in ("error",):
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

    # Degree count for node sizing
    degree: dict[str, int] = {}
    for e in edges:
        degree[e["source"]] = degree.get(e["source"], 0) + 1
        degree[e["target"]] = degree.get(e["target"], 0) + 1

    # Only include claims that ended up connected (keeps the graph legible)
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


# ── Insight Feed ─────────────────────────────────────────────

class InsightRequest(BaseModel):
    paper_ids: Optional[list[str]] = None
    limit: int = 30


@app.post("/api/insights")
def insight_feed(req: InsightRequest):
    """
    Synthesize a stream of typed insights from existing agent outputs.

    Sources:
      - contradiction scan → contradiction / consensus / nuance insights
      - newest papers       → new_paper insights
      - research_gaps analyses → gap insights

    This is a read-only synthesis over data the other agents already
    produce; nothing new is persisted.
    """
    import uuid
    from datetime import datetime, timezone

    insights = []

    # Newest papers
    papers = db.list_papers(limit=10)
    for p in papers[:5]:
        insights.append({
            "id": str(uuid.uuid4()),
            "type": "new_paper",
            "headline": f"Added to library: {p.title}",
            "claim": "",
            "detail": (p.abstract or "")[:280],
            "papers": [p.title],
            "created_at": p.created_at,
        })

    # Gap insights from stored research_gaps analyses
    for p in papers[:8]:
        analyses = db.get_analyses_for_paper(p.id)
        for a in analyses:
            if a.analysis_type == "research_gaps" and a.content:
                first = a.content.strip().split("\n")[0][:200]
                insights.append({
                    "id": str(uuid.uuid4()),
                    "type": "gap",
                    "headline": f"Open question in {p.title[:60]}",
                    "claim": first,
                    "detail": a.content[:400],
                    "papers": [p.title],
                    "created_at": p.created_at,
                })
                break

    # Contradiction/consensus insights — read from the CACHED relationships
    # table. This makes the feed a pure DB read (zero LLM calls). Run a
    # contradiction scan from the Contradictions page to populate it.
    try:
        cached_rels = db.list_relationships()
        # Build a quick claim_id -> paper title map for headlines
        claim_paper: dict[str, str] = {}
        for p in db.list_papers(limit=200):
            for c in db.get_claims_for_paper(p.id):
                claim_paper[c.id] = p.title

        for rel in cached_rels:
            ta = claim_paper.get(rel.claim_lo, "a paper")
            tb = claim_paper.get(rel.claim_hi, "another paper")
            if rel.relationship == "contradiction":
                insights.append({
                    "id": rel.id, "type": "contradiction",
                    "headline": f"Conflict: {ta[:40]} vs {tb[:40]}",
                    "claim": "", "detail": rel.explanation or "",
                    "papers": [ta, tb], "created_at": rel.created_at,
                })
            elif rel.relationship == "support":
                insights.append({
                    "id": rel.id, "type": "consensus",
                    "headline": f"Consensus forming across {ta[:40]} and others",
                    "claim": "", "detail": rel.explanation or "",
                    "papers": [ta, tb], "created_at": rel.created_at,
                })
    except Exception as e:
        print(f"Insight relationship read skipped: {e}")

    # Sort newest first, cap
    insights.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    return insights[: req.limit]
