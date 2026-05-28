# ScholarLens

**An AI reasoning system for scientific literature.**

Researchers juggle Google Scholar, Zotero, NotebookLM, and spreadsheets just to stay on top of a single literature review. ScholarLens replaces that workflow with something that actually reasons over a body of papers. Upload a paper and an AI agent extracts its methodology, findings, limitations, and open questions. Then — and this is the part most tools skip — ScholarLens reasons *across* papers: it finds where they contradict each other, where they form consensus, and what hypotheses live in the gaps between them.

It's not a wrapper around an LLM. The system builds persistent, claim-level knowledge that grows with your library — extracted once, reasoned over indefinitely.

![Python](https://img.shields.io/badge/Python-3.12-blue) ![Next.js](https://img.shields.io/badge/Next.js-16-black) ![FastAPI](https://img.shields.io/badge/FastAPI-0.115-009688) ![License](https://img.shields.io/badge/License-MIT-green)

> **Live demo:** *coming soon*

---

## What makes it different

Most "chat with your PDF" tools treat the **paper** as the atomic unit. ScholarLens treats the **claim** as the atomic unit. Every paper is decomposed into discrete, testable claims. Those claims are embedded, compared across papers, and judged by an LLM that decides whether two claims contradict, support, or nuance each other — with an explanation and a proposed resolution path.

This claim-level architecture means the product can do things that paper-level RAG fundamentally cannot: detect a contradiction between a specific finding in Paper A and a specific finding in Paper B, trace a generated hypothesis back to the exact claim pairs that motivated it, and build a knowledge graph where the nodes are claims and the edges are verified relationships.

---

## Technical architecture

### 1. PDF ingestion and chunking

Papers are ingested via `pdfplumber` with layout-aware extraction. The extractor applies several post-processing steps to improve text quality from academic PDFs:

- Hyphenation repair across line breaks (`re.sub(r"-\n\s*", "", text)`)
- Letter/number boundary insertion to fix common concatenation artifacts
- Section detection via regex patterns matching standard academic headings (Abstract, Introduction, Methods, Results, Discussion, Conclusion, References)
- Overlap-preserving chunking at ~500 tokens with 50-token overlap, flushing on section boundaries so chunks don't span major structural divides

Each chunk is stored in SQLite with its paper ID, section label, page number, and token count. Chunks are also embedded and stored in ChromaDB for semantic retrieval.

**Known limitation:** pdfplumber handles single-column PDFs well but degrades on two-column academic layouts, occasionally reading across columns instead of down them. This is the primary quality bottleneck — it propagates through every downstream feature since extraction quality sets the ceiling on everything else.

---

### 2. Parallel analysis pipeline

When a paper is uploaded, six structured analyses are produced concurrently via a `ThreadPoolExecutor`. Each is a single targeted LLM call with a specific system prompt:

| Analysis type | What it extracts |
|--------------|-----------------|
| `summary` | Objective, approach, and key results in structured prose |
| `methods` | Study design, sample characteristics, measures, statistical approach |
| `findings` | Quantitative results with effect sizes and confidence levels where reported |
| `limitations` | Author-acknowledged and inferred constraints on generalizability |
| `key_claims` | 4–6 falsifiable claims stated or strongly implied by the paper |
| `research_gaps` | Open questions and directions explicitly or implicitly identified |

Running these concurrently gives approximately 5× faster wall-clock time at identical API cost compared to sequential execution. Results are persisted to SQLite immediately — if a run fails mid-way, completed analyses survive.

Analysis content is stripped of LLM scaffolding artifacts (markdown headers, bold markers, uppercase label lines) before being returned to the frontend, so the UI renders clean prose rather than raw prompt structure.

---

### 3. Claim extraction from source text

The contradiction pipeline requires atomic, falsifiable claims. Extracting these from a paper's own summary analyses (the "telephone game" approach) degrades quality because you're comparing the model's paraphrase of a paraphrase. ScholarLens extracts claims directly from the paper's source text instead.

The extraction prompt asks the model to identify claims as self-contained, evidence-grounded statements — each one should be falsifiable in principle and include its supporting evidence where available (effect size, sample size, p-value, experimental conditions).

**Cache behavior:** Claims are extracted once per paper and persisted to a `claims` table. Subsequent contradiction scans, graph builds, and hypothesis generations read from the cache — no re-extraction, no redundant API calls. Cache is invalidated when a paper is re-analyzed or deleted.

---

### 4. Two-stage contradiction detection

Naïvely comparing every claim against every other claim is O(n²) in LLM calls. With 10 papers and 10 claims each, that's 4,500 potential calls. ScholarLens uses a two-stage pipeline that reduces this to a small fraction.

#### Stage 1: Vector pre-filter (cheap)

All claims are embedded using `sentence-transformers` (MiniLM-L6-v2). Cosine similarity is computed between every cross-paper claim pair. Only pairs exceeding a configurable threshold survive to Stage 2.

The threshold is exposed as three presets in the UI:
- **Quick** (threshold 0.55): fast, may miss vocabulary-distant but conceptually related claims
- **Balanced** (threshold 0.50, default): good coverage for most libraries
- **Deep** (threshold 0.40): catches more distant relationships, takes longer

**Why MiniLM over BGE-base:** BGE-base was evaluated as a replacement. Its retrieval-tuned training compresses similarity scores upward, reducing the separation between related and unrelated pairs on narrow-domain academic text (delta dropped from +0.274 to +0.141 on our eval set). MiniLM's general-purpose similarity distribution better separates the claim pairs that need LLM judgment from those that don't. BGE infrastructure (the `embed_query`/`embed_texts` asymmetric split) remains in the codebase for future experiments.

**Known limitation:** Two claims using different vocabulary for the same concept may not be adjacent in embedding space and will be filtered out before reaching the LLM. This is a fundamental limitation of dense retrieval. A BM25 keyword retrieval pass alongside the embedding pass would catch vocabulary-distant but conceptually related pairs — planned but not yet implemented.

#### Stage 2: LLM judgment (expensive, rare)

Surviving pairs are sent to Claude with a structured prompt that asks for a 4-way classification:

- **contradiction** — the claims make incompatible assertions about the same phenomenon
- **nuance** — the claims partially agree but differ in scope, conditions, or population
- **support** — the claims independently converge on the same finding
- **unrelated** — the surface similarity was misleading; the claims address different things

For each pair the model also produces:
- `category`: methodological / findings / theoretical / scope
- `explanation`: 2–3 sentences on the nature of the relationship
- `stronger_evidence`: which claim has more robust support, or "neither"
- `resolution`: one sentence on how future research could resolve the conflict

**Prompt engineering:** The contradiction judge went through four iterations tracked against a formal eval set (see Evaluation section). The current prompt uses a decision tree structure that first distinguishes proxy vs. orthogonal measurements before asking for the contradiction classification, and includes six few-shot examples targeting the nuance/contradiction boundary — the hardest case for the model.

**Cache behavior:** Judged relationships are persisted to a `relationships` table keyed on the sorted pair of claim IDs (`claim_lo`, `claim_hi`). Re-running a scan on the same papers costs zero judgment calls for pairs already seen. The upsert is idempotent — running the scan twice produces one row, not two.

---

### 5. Formal evaluation harness

The contradiction engine has a formal eval harness that runs independently of the production database.

**Gold set:** 30 hand-labeled claim pairs drawn from 5 real papers in the negotiation AI literature:
- Duddu et al. (2025) — LLM-based negotiation coaching
- Shea et al. (2024) — ACE coaching system
- Ma et al. (2025) — ChatGPT context analysis in humanitarian negotiations
- Johnson et al. (2017) — autonomous negotiation feedback agents
- Shaikh et al. (2024) — AI coaching effectiveness

The set deliberately oversamples nuance cases (the hardest class) and includes boundary pairs that a careless model would misclassify.

**Isolation:** The eval script calls `judge_pair(pair, use_cache=False)`, bypassing both the in-memory judgment cache and the DB read/write path. Eval runs never contaminate production data and always hit the LLM fresh, ensuring results measure current behavior rather than cached verdicts from a previous prompt version.

**Metrics:** 4-way macro-F1 (treats all classes equally regardless of frequency), Cohen's kappa (agreement corrected for chance), and binary tension F1 collapsing {contradiction, nuance} vs. {support, unrelated}.

| Version | Macro-F1 | Kappa | Binary Tension F1 |
|---------|----------|-------|-------------------|
| Baseline (summary-based claims) | 0.690 | 0.552 | 0.774 |
| Task 2 (grounded claims, evidence fields) | 0.648 | 0.513 | 0.733 |
| Task 2b (nuance prompt v1) | 0.644 | 0.500 | 0.857 |
| **Task 2c (nuance prompt v2, current)** | **0.788** | **0.683** | **0.857** |

Key improvements in Task 2c:
- Contradiction F1: 0.400 → 0.833 (decision tree + proxy-vs-orthogonal distinction)
- Nuance F1: 0.286 → 0.696 (6 few-shot examples targeting boundary cases)
- Kappa 0.683 = substantial agreement on a genuinely hard 4-class problem

**Note on Task 2 regression:** Moving from summary-based to source-text claim extraction initially hurt performance (0.690 → 0.648). The extracted claims were more precise but also more verbose and statistically dense, making the nuance/contradiction boundary harder to navigate without targeted prompt engineering. Tasks 2b and 2c address this — the final result outperforms the summary-based baseline on all metrics.

---

### 6. Hypothesis generation with conflict grounding

The hypothesis agent reads directly from the persisted contradiction results rather than re-reading the papers. This is what makes provenance traceable: a hypothesis cites specific conflict IDs that are verifiable in the database, not inferred from raw text.

**Conflict context preparation:** Relationships are fetched from the `relationships` table and formatted for the model using short sequential labels (`[CONFLICT_1]`, `[CONFLICT_2]`) rather than UUIDs. This prevents UUID strings from bleeding into the model's prose output — a real failure mode where the model echoes identifier strings into its generated rationale. A `label_to_real` mapping converts labels back to real IDs after parsing.

**Post-parse validation:** Cited conflict labels are validated against the actual set of labels passed in. The model occasionally fabricates label references — these are silently dropped. Only verified conflict IDs survive into the stored hypothesis.

**Novelty scoring:** Rather than asking the model to self-assess novelty (unreliable — it tends toward high), novelty is computed as cosine distance between the hypothesis embedding and the nearest chunk in the library. A hypothesis very close to existing library content scores low novelty; one in unexplored territory scores high. The impact score was removed entirely — without citation data or field-level context, no reliable signal exists and fake precision is worse than no score.

**Cache:** Hypothesis results are cached keyed on the set of paper IDs, any research question, and a relationships watermark (count of relationships in DB at generation time). Cache is invalidated when the library changes or a new scan adds relationships.

---

### 7. Knowledge graph

The knowledge graph endpoint assembles nodes and edges from the claims and relationships tables — no new LLM calls. Nodes are claims filtered to only those with at least one edge; isolated claims are excluded since they add visual noise without conveying information. Edges are persisted relationships colored by type (red = contradiction, green = support, amber = nuance).

The frontend runs a custom JavaScript force simulation with centering, repulsion, spring, and damping forces. No D3 dependency — the simulation runs entirely in the browser against the JSON payload the backend returns.

---

### 8. Semantic search and relevance tiers

Search queries are embedded using MiniLM (bare document embedding, no instruction prefix). ChromaDB returns the top-k nearest chunks by cosine distance. Relevance is reported as a tier rather than a percentage:

- **Highly relevant** — cosine similarity ≥ 0.6
- **Related** — 0.4 ≤ similarity < 0.6
- **Tangential** — similarity < 0.4

The previous implementation showed `(1 - cosine_distance) * 100` as a percentage. This implies calibrated precision that doesn't exist — tiers are honest about what the model actually knows.

---

### 9. Research monitoring

The monitoring agent searches arXiv and Semantic Scholar for papers matching configured keywords, filters out papers already in the library by title-key deduplication, and scores each candidate by embedding its abstract against the library's existing chunks. Results are grouped by topic with relevance tiers. If a Resend API key is configured, it sends an HTML digest email after each scan. Topics and results are cached in localStorage so they survive page reloads.

---

### 10. Persistence and cost control

The cost model for a naive implementation is brutal: every page load re-extracts claims, re-judges relationships, re-generates hypotheses. ScholarLens uses a two-table SQLite cache (`claims`, `relationships`) with these guarantees:

- A claim is extracted at most once per paper
- A relationship is judged at most once per claim pair (idempotent upsert keyed on sorted claim ID pair)
- The insight feed is a pure DB read — zero LLM calls per load regardless of library size
- The knowledge graph reads from cache — no new LLM calls on re-render

Cache invalidation: deleting a paper cascades its claims (FK) and manually purges their relationships; re-analyzing a paper explicitly clears stale claims and relationships before re-running.

The frontend mirrors this with localStorage caching (24-hour TTL, version-based busting) for contradiction results, graph payloads, and hypothesis outputs — results survive tab switches and full page reloads.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Next.js Frontend (App Router, TypeScript)           │
│                                                       │
│  Situation room  · The corpus  · Knowledge field     │
│  Conflict map    · Generative bench · Research wire  │
│  Research monitor · ⌘K command palette               │
│                                                       │
│  localStorage cache (contradictions, graph, hypo)    │
└─────────────────────────┬───────────────────────────┘
                          │  REST/JSON
┌─────────────────────────┴───────────────────────────┐
│  FastAPI Backend                                      │
│                                                       │
│  PDFAnalysisAgent   — 6 parallel LLM calls/paper     │
│  ContradictionAgent — 2-stage pipeline (vec → LLM)   │
│  HypothesisAgent    — conflict-grounded synthesis     │
│  PaperImporter      — arXiv + Semantic Scholar       │
│  MonitoringAgent    — topic watch + email digest     │
└──────────┬──────────────────────┬───────────────────┘
           │                      │
┌──────────┴──────────┐  ┌────────┴─────────────────┐
│  SQLite (WAL mode)  │  │  ChromaDB                 │
│                     │  │                           │
│  papers             │  │  chunk embeddings         │
│  analyses           │  │  (MiniLM-L6-v2)           │
│  chunks             │  │                           │
│  claims  ← cache    │  │                           │
│  relationships ← cache  │                          │
└─────────────────────┘  └───────────────────────────┘
```

---

## Tech stack

| Component | Choice | Why |
|-----------|--------|-----|
| LLM | Claude Haiku (Anthropic API) | Tool use support, strong structured extraction, cost-effective |
| Backend | FastAPI | Async, typed, automatic OpenAPI docs at `/api/docs` |
| Frontend | Next.js 16 + TypeScript | App Router, server components, fast iteration |
| Embeddings | sentence-transformers MiniLM-L6-v2 | Runs locally, no API cost, better score separation than BGE on narrow-domain text |
| Vector DB | ChromaDB | Zero setup, persistent, cosine similarity, migrates to pgvector |
| Database | SQLite (WAL mode) | Single file, FK cascades, PostgreSQL-compatible schema |
| PDF parsing | pdfplumber | Layout-aware extraction with section detection heuristics |
| Email | Resend | HTML digest delivery for monitoring agent |

---

## Quick start

You'll need Python 3.12+, Node.js 18+, and an Anthropic API key.

### Backend

```bash
git clone https://github.com/aakashshahani/ScholarLens.git
cd ScholarLens

python -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt

# Create .env:
# ANTHROPIC_API_KEY=sk-ant-xxxxx
# SEMANTIC_SCHOLAR_KEY=...       (optional — higher rate limits)
# RESEND_API_KEY=re_...          (optional — for email digests)

uvicorn api:app --reload --port 8000
```

API docs at `http://localhost:8000/api/docs`.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

App at `http://localhost:3000`.

---

## Project structure

```
scholarlens/
  api.py                  FastAPI — all REST endpoints
  config/
    settings.py           Config, env vars, relevance tier thresholds
  db/
    database.py           SQLite data layer: papers, claims, relationships
  agents/
    pdf_analyst.py        Parallel 6-type analysis pipeline
    contradiction_agent.py  Two-stage pipeline with eval harness support
    hypothesis_agent.py   Conflict-grounded hypothesis synthesis
    paper_import.py       arXiv + Semantic Scholar import + dedup
    monitoring_agent.py   Topic monitoring + Resend email digest
  pdf_parser.py           PDF extraction and section-aware chunking
  vector_store.py         ChromaDB wrapper (embed_query / embed_texts split)
  eval/
    gold_claims.json      30 hand-labeled claim pairs
    run_eval.py           Scoring script (macro-F1, kappa, binary tension F1)
  frontend/
    src/
      app/                Next.js pages
      components/         Left rail, command palette, shared UI
      lib/
        api.ts            Typed API client
        cache.ts          localStorage cache with TTL + version busting
  data/                   Runtime (SQLite + ChromaDB — gitignored)
```

---

## API reference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | System status, paper count, embedding count |
| GET | `/api/papers` | List papers with analysis types and claim count |
| GET | `/api/papers/{id}` | Paper detail, analyses (scaffolding stripped), chunk count |
| POST | `/api/papers/upload` | Upload PDF — deduplication before ingest |
| DELETE | `/api/papers/{id}` | Delete paper, cascade claims + relationships |
| POST | `/api/papers/{id}/reanalyze` | Re-run analyses, invalidate claim/relationship cache |
| GET | `/api/papers/{id}/status` | Analysis completion status for polling |
| POST | `/api/search` | Semantic search, returns relevance tiers |
| POST | `/api/ask` | RAG Q&A grounded in retrieved passages |
| GET | `/api/contradictions/count` | Cached relationship counts — zero LLM calls |
| POST | `/api/contradictions` | Run two-stage contradiction scan |
| POST | `/api/hypotheses` | Generate conflict-grounded hypotheses |
| POST | `/api/graph` | Build claim knowledge graph from cache |
| POST | `/api/insights` | Synthesized insight feed — pure DB read |
| POST | `/api/import/search` | Search arXiv / Semantic Scholar |
| POST | `/api/import/lookup` | Lookup by arXiv ID, DOI, or URL |
| POST | `/api/import/add` | Import paper — dedup check before PDF download |
| POST | `/api/monitor/scan` | Run monitoring scan with optional email digest |

Full interactive docs at `/api/docs`.

---

## Evaluation

The contradiction detection engine has a formal eval harness — see Section 5 above for full methodology.

| Version | Macro-F1 | Kappa | Binary Tension F1 |
|---------|----------|-------|-------------------|
| Baseline (summary-based claims) | 0.690 | 0.552 | 0.774 |
| Task 2 (grounded claims) | 0.648 | 0.513 | 0.733 |
| Task 2b (nuance prompt v1) | 0.644 | 0.500 | 0.857 |
| **Task 2c (current)** | **0.788** | **0.683** | **0.857** |

---

## Demo screenshots

<img width="1545" height="847" alt="Situation room" src="https://github.com/user-attachments/assets/b189bc55-00a7-4caa-8c27-6d2cc64fbb18" />
<img width="1549" height="769" alt="Conflict map" src="https://github.com/user-attachments/assets/b77a8218-947e-46f2-bd19-99340097c417" />
<img width="1538" height="833" alt="Generative bench" src="https://github.com/user-attachments/assets/0c3be7f2-9f9b-4278-a810-64acaa398d24" />
<img width="1589" height="770" alt="Knowledge field" src="https://github.com/user-attachments/assets/2c5301b4-0400-4ee4-92e9-fcae883f97c9" />
<img width="1355" height="834" alt="Research wire" src="https://github.com/user-attachments/assets/749ad6a2-7092-4287-89d1-04d0ca192a6a" />
<img width="1108" height="824" alt="The corpus" src="https://github.com/user-attachments/assets/ade9c797-b98c-43b9-811b-96a82c24d331" />
<img width="1020" height="786" alt="Paper detail" src="https://github.com/user-attachments/assets/f9b6f888-e0b2-4e9b-8e71-bb7ae834b5bd" />

---

## Roadmap

**Done**
- Agentic PDF analysis — 6 structured report types per paper
- Section-aware chunking with configurable size and overlap
- Semantic search and per-paper Q&A (RAG)
- Two-stage contradiction detection with formal eval harness (macro-F1 0.788, kappa 0.683)
- Evidence-grounded claim extraction from source text
- Prompt-engineered contradiction judge with decision tree + few-shot boundary examples
- BGE-base embedding evaluation — kept MiniLM on principled grounds
- Parallel analysis pipeline (~5x faster upload, same API cost)
- Claim + relationship SQLite cache (extracted once, judged once, reused indefinitely)
- Hypothesis generation grounded in persisted conflict IDs with post-parse validation
- Hypothesis output cache with library watermark invalidation
- Novelty scoring via corpus cosine distance (replaced LLM self-assessment)
- Impact score removed (no reliable signal without citation data)
- Semantic search relevance tiers (replaced fake percentage precision)
- Insight feed as pure DB read (zero LLM calls per load)
- Knowledge graph from claim/relationship cache
- Research monitor with arXiv + Semantic Scholar + Resend email digest
- Automatic deduplication on upload and import (DOI → arXiv ID → normalized title key)
- Dark UI — left rail nav, ⌘K command palette, localStorage result caching
- FastAPI + Next.js migration from original Streamlit prototype

**Next**
- GROBID or PyMuPDF for better multi-column PDF parsing
- BM25 keyword retrieval pass alongside dense retrieval
- Deployed hosted demo
- Auth and multi-user libraries

---

## About

Built by Aakash Shahani, CS graduate from the University of South Florida (Dec 2025). Research assistant at the USF CSSAI lab studying whether LLMs can improve negotiation skills in humans. ScholarLens started after spending weeks manually reading and comparing dozens of papers for that research — the work of analyzing, searching, and cross-referencing papers seemed like exactly the kind of thing that should be automated.
