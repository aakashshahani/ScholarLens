# ScholarLens 🔬

**Agentic Research Intelligence Platform**

ScholarLens uses Claude with tool use to autonomously analyze, synthesize, and discover research papers. Upload a PDF and get structured analysis, semantic search across your library, and intelligent question answering — all powered by an agentic loop where Claude decides what to analyze and how.

## What Makes This Agentic (Not Just a Pipeline)

Most "AI paper analyzers" are pipelines: extract → summarize → done. ScholarLens is different:

- **Claude drives the analysis.** The agent loop gives Claude tools and a goal. Claude decides which tools to call, in what order, and when it's done. It might call `extract_pdf_text`, realize the methods section is unclear, search for related chunks, and then produce a more nuanced analysis.
- **Tool use, not prompt chaining.** Each tool (PDF extraction, semantic search, analysis storage) is a real function Claude can invoke. This is the same pattern used in production AI systems.
- **Persistent knowledge.** Papers aren't just analyzed and forgotten — chunks are embedded and stored for cross-paper search and future synthesis.

## Architecture

```
┌─────────────────────────────────────────┐
│            Streamlit Frontend            │
│   Upload · Library · Search · Detail    │
└──────────────────┬──────────────────────┘
                   │
┌──────────────────▼──────────────────────┐
│           PDF Analysis Agent            │
│  Claude + Tool Use (agentic loop)       │
│  ┌─────────┐ ┌──────────┐ ┌─────────┐  │
│  │ Extract  │ │  Search  │ │  Store  │  │
│  │   PDF    │ │  Chunks  │ │Analysis │  │
│  └─────────┘ └──────────┘ └─────────┘  │
└──────────────────┬──────────────────────┘
                   │
┌──────────────────▼──────────────────────┐
│             Data Layer                  │
│  SQLite (papers, chunks, analyses)      │
│  ChromaDB (embeddings, similarity)      │
└─────────────────────────────────────────┘
```

## Quick Start

```bash
# 1. Clone and enter the project
cd scholarlens

# 2. Create virtual environment
python -m venv venv
source venv/bin/activate  # or venv\Scripts\activate on Windows

# 3. Install dependencies
pip install -r requirements.txt

# 4. Set your API key
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY

# 5. Run the app
export ANTHROPIC_API_KEY=sk-ant-xxxxx
streamlit run app.py
```

## Project Structure

```
scholarlens/
├── app.py                  # Streamlit frontend
├── requirements.txt
├── .env.example
├── config/
│   ├── __init__.py
│   └── settings.py         # All configuration
├── agents/
│   ├── __init__.py
│   └── pdf_analyst.py      # Core agent with tool use
├── db/
│   ├── __init__.py
│   └── database.py         # SQLite schema + data models
├── utils/
│   ├── __init__.py
│   ├── pdf_parser.py       # PDF extraction + chunking
│   └── vector_store.py     # ChromaDB wrapper
└── data/                   # Auto-created at runtime
    ├── uploads/
    ├── chroma/
    └── scholarlens.db
```

## Phase Roadmap

### Phase 1 ✅ (Current)
- PDF upload and structured analysis
- Section-aware chunking with embeddings
- Semantic search across library
- Per-paper question answering

### Phase 2 (Next)
- Multi-paper synthesis agent
- Contradiction detection (vector filter → Claude judge)
- Hypothesis generation from cross-paper patterns

### Phase 3
- arXiv/PubMed/Semantic Scholar auto-import
- Research gap identification
- Daily monitoring agent (APScheduler)

### Phase 4
- Team collaboration
- React frontend migration
- PostgreSQL + pgvector migration

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Embedding model | sentence-transformers (MiniLM) | Zero cost, runs locally. Swap to API embeddings for production quality. |
| Vector store | ChromaDB | Zero infrastructure, persists to disk, cosine similarity built in. Migrates to pgvector. |
| Database | SQLite | Single file, zero setup, WAL mode for concurrency. Schema is PostgreSQL-compatible. |
| Agent pattern | Claude tool use loop | Claude decides analysis strategy, not a hardcoded pipeline. More flexible, better results. |
| Chunking | 500 tokens, 50 overlap, section-aware | Balances context size with granularity. Section breaks prevent cross-section contamination. |

## Built By

Built as a portfolio project demonstrating agentic AI, RAG systems, and research tooling.
