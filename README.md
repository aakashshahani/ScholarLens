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

The core is an agent loop with tool use. Instead of a fixed pipeline (extract → summarize → done), the agent is given a set of tools and a goal, and it decides which tools to call, in what order, and when it's finished:

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

## Roadmap

**Done**
- Agentic PDF analysis with six structured report types
- Section-aware chunking with overlap
- Semantic search and per-paper Q&A
- Two-stage cross-paper contradiction detection
- Hypothesis generation from cross-paper gaps
- Knowledge graph of claims and relationships
- Insight feed
- arXiv + Semantic Scholar import with deduplication
- Claim and relationship caching for cost control
- Migration from Streamlit to a FastAPI + Next.js stack

**Next**
- Persisted, scheduled insight generation
- Multi-paper synthesis reports
- Deployed hosted demo
- Auth and multi-user libraries

## About

Built by Aakash Shahani, CS graduate from the University of South Florida (Dec 2025). Research assistant at the USF CSSAI lab studying whether LLMs can improve negotiation skills in humans. ScholarLens started after spending weeks manually reading and comparing dozens of papers for that research — the work of analyzing, searching, and cross-referencing papers seemed like exactly the kind of thing that should be automated.
