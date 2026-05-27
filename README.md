# ScholarLens

**An AI reasoning system for scientific literature.**

Researchers juggle Google Scholar, Zotero, NotebookLM, and spreadsheets just to stay on top of a single literature review. ScholarLens replaces that workflow with something that actually reasons over a body of papers. Upload a paper and an AI agent extracts its methodology, findings, limitations, and open questions. Then — and this is the part most tools skip — ScholarLens reasons *across* papers: it finds where they contradict each other, where they form consensus, and what hypotheses live in the gaps between them.

It's not a wrapper around an LLM. The analysis agent decides what to examine, calls its own tools, and builds persistent, claim-level knowledge that grows with your library.

![Python](https://img.shields.io/badge/Python-3.12-blue) ![Next.js](https://img.shields.io/badge/Next.js-16-black) ![FastAPI](https://img.shields.io/badge/FastAPI-0.115-009688) ![License](https://img.shields.io/badge/License-MIT-green)



---

## What makes it different

Most "chat with your PDF" tools treat the paper as the atomic unit. ScholarLens treats the **claim** as the atomic unit. Every paper is decomposed into discrete, testable claims, and those claims become nodes in a reasoning layer that can:

- detect **contradictions** between papers and adjudicate which has stronger evidence
- surface **consensus** forming across independent studies
- identify **research gaps** and generate **testable hypotheses** grounded in the literature
- map the whole field as a **knowledge graph** of claims and their relationships

## Core features

- **Agentic paper analysis** — an LLM agent with tool use produces six structured reports per paper (summary, methods, findings, limitations, key claims, research gaps)
- **Cross-paper contradiction detection** — a two-stage pipeline (vector pre-filter → LLM judgment) that finds and explains conflicts
- **Hypothesis generation** — synthesizes testable hypotheses from the gaps between papers, with provenance back to source claims
- **Knowledge graph** — a force-directed map of claims, colored by relationship type, with semantic clustering
- **Insight feed** — a chronological stream of machine-generated insights (new contradictions, consensus shifts, gaps)
- **Semantic search & Q&A** — query the whole library by meaning; ask questions grounded in retrieved passages
- **Paper import** — pull papers directly from arXiv and Semantic Scholar, with automatic deduplication
- **Research monitoring** — watch topics for new papers, scored by relevance to your existing library, with email digests

## How it works

### The analysis agent

The analysis pipeline fires all six report types concurrently via a thread pool — each is a targeted single-turn LLM call with a specific prompt. Same API cost as sequential, ~5x faster wall-clock time. The agentic pattern is reserved for contradiction detection and Q&A, where the model genuinely needs to discover what to examine rather than execute a known set of tasks.



```
extract_pdf_text     →  pull and structure the paper's text
search_paper_chunks  →  semantic search over stored passages
store_analysis       →  persist a structured analysis result
get_paper_metadata   →  check what's already been analyzed
list_library         →  see the whole corpus
```

The agent runs this loop until it has produced all six analysis types, deciding for itself when each is complete.

### The two-stage contradiction pipeline

Comparing every claim against every other claim with an LLM would be quadratic and expensive. Instead ScholarLens uses two stages:

1. **Vector pre-filter (cheap)** — every claim is embedded; cosine similarity finds pairs that are *about the same thing* across different papers. Only sufficiently similar pairs survive.
2. **LLM judgment (expensive, but rare)** — only the surviving pairs are sent to the model, which classifies the relationship (contradiction / support / nuance / unrelated), assigns a category, judges which claim has stronger evidence, and proposes how future research could resolve the conflict.

This is the pattern that makes the feature tractable: the embedding step throws away the irrelevant majority for almost nothing, so the model only reasons about pairs that actually matter.

Extracted claims and judged relationships are persisted to SQLite with stable IDs on every scan. The hypothesis agent reads directly from these persisted conflicts as its grounding input — provenance is traceable to specific claim pairs, not inferred from raw paper text.



### Persistence & caching

Extracted claims and judged relationships are cached in SQLite. A claim is only ever extracted once per paper; a relationship is only ever judged once per claim pair. The contradiction scan, knowledge graph, and insight feed all read from this cache, so re-running them costs no additional API calls. The insight feed in particular is a pure database read.

## Architecture

```
┌─────────────────────────────────────────────┐
│  Next.js Frontend (App Router, TypeScript)   │
│  Dashboard · Library · Graph · Contradictions │
│  Hypotheses · Feed · ⌘K command palette       │
└───────────────────────┬─────────────────────┘
                        │  REST (JSON)
┌───────────────────────┴─────────────────────┐
│  FastAPI Backend                              │
│                                               │
│  PDFAnalysisAgent     — agent loop + tool use │
│  ContradictionAgent   — two-stage pipeline    │
│  HypothesisAgent      — gap-based synthesis   │
│  PaperImporter        — arXiv + Semantic Sch. │
│  MonitoringAgent      — topic watch + digest  │
└───────────────────────┬─────────────────────┘
                        │
┌───────────────────────┴─────────────────────┐
│  Data Layer                                   │
│  SQLite   — papers, analyses, claims,         │
│             relationships (cached)            │
│  ChromaDB — chunk embeddings, similarity      │
└───────────────────────────────────────────────┘
```

## Tech stack

| Component | Choice | Why |
|-----------|--------|-----|
| LLM | Claude (Anthropic API) | Tool use support, strong at structured extraction and judgment |
| Backend | FastAPI | Async, typed, automatic OpenAPI docs |
| Frontend | Next.js 16 + TypeScript | App Router, server components, fast iteration |
| Embeddings | sentence-transformers (MiniLM) | Runs locally, no API cost |
| Vector DB | ChromaDB | Zero setup, persistent, migrates to pgvector |
| Database | SQLite (WAL) | Single file, PostgreSQL-compatible schema |
| PDF parsing | pdfplumber | Best open-source option for academic papers |
| Email | Resend | Digest delivery for monitoring |

## Quick start

You'll need Python 3.12+, Node.js 18+, and an Anthropic API key.

### Backend

```bash
git clone https://github.com/aakashshahani/ScholarLens.git
cd ScholarLens

python -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt

# Create a .env file with your keys:
#   ANTHROPIC_API_KEY=sk-ant-xxxxx
#   SEMANTIC_SCHOLAR_KEY=...       (optional)
#   RESEND_API_KEY=re_...          (optional, for email digests)

uvicorn api:app --reload --port 8000
```

API docs available at `http://localhost:8000/api/docs`.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

The app runs at `http://localhost:3000`.

## Project structure

```
scholarlens/
  api.py                 FastAPI backend — all REST endpoints
  config.py              Configuration and env vars
  db.py                  SQLite data layer (papers, claims, relationships)
  utils.py               Re-exports for the agents
  pdf_parser.py          PDF extraction and section-aware chunking
  vector_store.py        ChromaDB wrapper
  test_api.py            API tests
  requirements.txt
  agents/
    pdf_analyst.py        Core agent with tool use
    contradiction_agent.py Two-stage contradiction detection (cached)
    hypothesis_agent.py   Hypothesis generation from cross-paper gaps
    paper_import.py       arXiv + Semantic Scholar import + dedup
    monitoring_agent.py   Topic monitoring + email digests
  frontend/
    src/
      app/                Next.js pages (dashboard, library, graph, etc.)
      components/         Shared UI, left rail, command palette
      lib/api.ts          Typed API client
  data/                   Created at runtime (SQLite + ChromaDB)
```

## API overview

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | System status |
| GET | `/api/papers` | List papers |
| GET | `/api/papers/{id}` | Paper detail + analyses |
| POST | `/api/papers/upload` | Upload a PDF (with dedup) |
| POST | `/api/search` | Semantic search |
| POST | `/api/ask` | Question answering (RAG) |
| POST | `/api/contradictions` | Run the two-stage scan |
| POST | `/api/hypotheses` | Generate hypotheses |
| POST | `/api/graph` | Build the claim knowledge graph |
| POST | `/api/insights` | Synthesized insight feed |
| POST | `/api/import/search` | Search arXiv / Semantic Scholar |
| POST | `/api/monitor/scan` | Run a monitoring scan |

Full interactive docs at `/api/docs` when the server is running.

## Evaluation

The contradiction detection engine has a formal eval harness:

- **Gold set:** 30 hand-labeled claim pairs from 5 real papers in negotiation AI
  literature (Duddu et al. 2025, Shea et al. 2024, Ma et al. 2025,
  Johnson et al. 2017, Shaikh et al. 2024)
- **Metrics:** 4-way macro-F1, Cohen's kappa, binary tension F1
  ({contradiction, nuance} vs {support, unrelated})
- Eval bypasses production cache entirely (`use_cache=False`) and never
  writes to the production DB — runs are fully isolated

-Evaluated BGE-base as a replacement for MiniLM-L6. BGE's retrieval tuning compresses similarity scores upward, reducing separation between related and unrelated pairs on narrow-domain text from +0.274 to +0.141. MiniLM's general-purpose similarity handles domain-specific vocabulary distinctions better at Stage 1. Kept MiniLM; the BGE infrastructure (embed_query/embed_texts split) remains for future model experiments

### Results

| Version | Macro-F1 | Kappa | Binary Tension F1 |
|---------|----------|-------|-------------------|
| Baseline (summary-based claims) | 0.690 | 0.552 | 0.774 |
| Task 2 (grounded claims, evidence fields) | 0.648 | 0.513 | 0.733 |
| Task 2b (nuance prompt v1) | 0.644 | 0.500 | 0.857 |
| **Task 2c (nuance prompt v2, current)** | **0.788** | **0.683** | **0.857** |

Key improvements in Task 2c:
- Contradiction F1: 0.400 → 0.833 (decision tree + proxy-vs-orthogonal distinction)
- Nuance F1: 0.286 → 0.696 (6 few-shot examples targeting boundary cases)
- Kappa 0.683 = substantial agreement on a 4-class problem with genuinely ambiguous boundary cases

## Roadmap

**Done**
- Agentic PDF analysis with six structured report types
- Section-aware chunking with overlap
- Semantic search and per-paper Q&A
- Two-stage cross-paper contradiction detection with formal eval harness
- Hypothesis generation from cross-paper gaps
- Knowledge graph of claims and relationships
- Insight feed
- arXiv + Semantic Scholar import with deduplication
- Claim and relationship caching for cost control
- Migration from Streamlit to a FastAPI + Next.js stack
- Evidence-grounded claim extraction from source text (current extraction is summary-based; moving to passage-level with
  evidence attached — effect size, sample size, conditions)
- Prompt-engineered contradiction judge with formal eval: macro-F1 0.788, kappa 0.683, binary tension F1 0.857
- Parallel analysis pipeline (~5x faster upload experience, same API cost)
- Contradiction agent wired to SQLite persistence (claims + relationships survive restarts)
- Hypothesis grounding in detected conflicts with validated provenance (cited conflict IDs checked against DB)
- Hypothesis output cache keyed on paper scope + relationships watermark + question hash
- Novelty scoring via cosine distance to nearest library chunk (replaces LLM self-assessment)
- Impact score removed (no reliable signal — citation data not persisted)
- Semantic search relevance tiers (highly_relevant / related / tangential) replacing fake percentage
- Insight feed in-process TTL cache (2hr), invalidated on any library write

**Next**
- Persisted scheduled insight generation
- Deployed hosted demo
- Auth and multi-user libraries

  Demo Screenshots:
  <img width="1545" height="847" alt="image" src="https://github.com/user-attachments/assets/b189bc55-00a7-4caa-8c27-6d2cc64fbb18" />
  <img width="1549" height="769" alt="image" src="https://github.com/user-attachments/assets/b77a8218-947e-46f2-bd19-99340097c417" />
<img width="1538" height="833" alt="image" src="https://github.com/user-attachments/assets/0c3be7f2-9f9b-4278-a810-64acaa398d24" />
<img width="1589" height="770" alt="image" src="https://github.com/user-attachments/assets/2c5301b4-0400-4ee4-92e9-fcae883f97c9" />
<img width="1355" height="834" alt="image" src="https://github.com/user-attachments/assets/749ad6a2-7092-4287-89d1-04d0ca192a6a" />
<img width="1108" height="824" alt="image" src="https://github.com/user-attachments/assets/ade9c797-b98c-43b9-811b-96a82c24d331" />
<img width="1020" height="786" alt="image" src="https://github.com/user-attachments/assets/f9b6f888-e0b2-4e9b-8e71-bb7ae834b5bd" />






## About

Built by Aakash Shahani, CS graduate from the University of South Florida (Dec 2025). Research assistant at the USF CSSAI lab studying whether LLMs can improve negotiation skills in humans. ScholarLens started after spending weeks manually reading and comparing dozens of papers for that research — the work of analyzing, searching, and cross-referencing papers seemed like exactly the kind of thing that should be automated.
