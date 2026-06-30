# ScholarLens

![Python](https://img.shields.io/badge/Python-3.12-blue) ![Next.js](https://img.shields.io/badge/Next.js-16-black) ![FastAPI](https://img.shields.io/badge/FastAPI-0.136-009688) ![License](https://img.shields.io/badge/License-MIT-green) [![Live Demo](https://img.shields.io/badge/Live%20Demo-scholarlens--research.vercel.app-6366f1)](https://scholarlens-research.vercel.app)

> **[Live demo →](https://scholarlens-research.vercel.app)**

Most tools that let you "chat with your PDFs" treat the **paper** as the unit of analysis. ScholarLens treats the **claim**. Every paper is decomposed into discrete, falsifiable claims — embedded, compared across papers, and judged by an LLM that classifies whether two claims contradict, support, or nuance each other. The result is a persistent, claim-level knowledge graph that compounds as your library grows: extracted once, reasoned over indefinitely.

Built because I was spending weeks manually cross-referencing papers for my own lab research and got tired of it.

---

## Features

- **Parallel paper analysis** — Six structured analyses per paper (summary, methods, findings, limitations, key claims, research gaps) run concurrently via `ThreadPoolExecutor`, ~5× faster than sequential
- **Two-stage contradiction detection** — BM25 + dense hybrid retrieval pre-filters candidate claim pairs; LLM judge classifies surviving pairs (macro-F1 **0.788**, kappa **0.683**; gold set now 42 pairs across 3 domains with a train/test split)
- **Evidence-strength scoring** — each claim is scored on the empirical cues it states (study design, sample size, effect size, p-value, hedging) to compute which side of a contradiction is better supported — a transparent second opinion alongside the LLM's verdict
- **Conflict-grounded hypothesis generation** — Hypotheses cite specific contradiction IDs from the database; novelty scored via cosine distance against the library (no LLM self-assessment)
- **Interactive knowledge graph** — Custom JS force simulation (no D3), paper-colored nodes, degree-scaled, hover tooltips, zero LLM calls on re-render
- **Search + answer in one surface** — pgvector cosine retrieval (HNSW-indexed) feeds a Voyage cross-encoder reranker that re-scores `(query, passage)` relevance; calibrated relevance tiers, no fake percentage scores. Returns passages instantly, with an optional synthesized answer grounded in those same passages (scope to the whole library or one paper). Reranking is API-based, so it adds no local model weight
- **Research monitoring** — Watches Semantic Scholar, OpenAlex, and arXiv for new papers matching configured topics (per-topic cadence: daily/weekly/paused); scores candidates against library embeddings; persists results per topic and sends a Gmail digest, as a standalone memory-bounded cron worker. Beyond keyword topics it surfaces **citation alerts** (new papers citing your library) and **author-follow** (new papers by authors you track) via the Semantic Scholar graph — alerts a corpus-wide search engine structurally can't give, because they're native to *your* collection
- **Insight feed** — Pure DB read on every load; zero LLM calls regardless of library size
- **Multi-user + BYOK** — Per-user library isolation, per-user Anthropic keys encrypted at rest with Fernet. Auth is pluggable via `AUTH_PROVIDER`: built-in bcrypt + httpOnly session cookies (default), or Clerk (JWT verification with link-by-identity that preserves an existing library)

---

## Screenshots

> *Add screenshots or a GIF here — dashboard, contradiction map, knowledge graph*

---

## Technical architecture

### 1. PDF ingestion and chunking

Papers are ingested via **PyMuPDF** (`fitz`) with column-aware extraction. The extractor applies several post-processing steps to improve text quality from academic PDFs:

- **Dynamic two-column detection** — word x-positions are bucketed to locate the actual column gutter on each page, then words are ordered down the left column before the right. This replaced a fixed 50%-page split that broke on papers with off-center or single-column layouts.
- Hyphenation repair across line breaks
- Letter/number boundary insertion to fix common concatenation artifacts
- Section detection via regex patterns matching standard academic headings (Abstract, Introduction, Methods, Results, Discussion, Conclusion, References)
- **References and appendix sections are excluded** from indexing and search — they add citation noise and dilute retrieval quality without carrying claims
- Overlap-preserving chunking at ~500 tokens with 50-token overlap, flushing on section boundaries so chunks don't span major structural divides

Each chunk is stored in Postgres with its paper ID, section label, page number, and token count. Chunks are embedded and stored in pgvector for semantic retrieval.

Extraction quality sets the ceiling on every downstream feature, so the column-detection work was prioritized accordingly — it propagates through chunking, embeddings, claim extraction, and contradiction detection.

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

Running these concurrently gives approximately 5× faster wall-clock time at identical API cost compared to sequential execution. Results are persisted to Postgres immediately — if a run fails mid-way, completed analyses survive.

Analysis content is stripped of LLM scaffolding artifacts (markdown headers, bold markers, uppercase label lines) before being returned to the frontend, so the UI renders clean prose rather than raw prompt structure.

---

### 3. Claim extraction from source text

The contradiction pipeline requires atomic, falsifiable claims. Extracting these from a paper's own summary analyses (the "telephone game" approach) degrades quality because you're comparing the model's paraphrase of a paraphrase. ScholarLens extracts claims directly from the paper's source text instead.

The extraction prompt asks the model to identify claims as self-contained, evidence-grounded statements — each one should be falsifiable in principle and include its supporting evidence where available (effect size, sample size, p-value, experimental conditions).

**Cache behavior:** Claims are extracted once per paper and persisted to a `claims` table. Subsequent contradiction scans, graph builds, and hypothesis generations read from the cache — no re-extraction, no redundant API calls. Cache is invalidated when a paper is re-analyzed or deleted.

---

### 4. Two-stage contradiction detection

Naïvely comparing every claim against every other claim is O(n²) in LLM calls. With 10 papers and 10 claims each, that's 4,500 potential calls. ScholarLens uses a two-stage pipeline that reduces this to a small fraction.

#### Stage 1: Hybrid retrieval pre-filter (cheap)

All claims are embedded using **Voyage AI** (`voyage-3.5-lite`, 1024 dims). Stage 1 runs **two retrievers in parallel** and unions their candidate pairs:

- **Dense (Voyage AI):** cosine similarity between every cross-paper claim pair, computed via numpy matrix multiply then filtered by threshold; pairs above the threshold survive.
- **BM25 (`rank-bm25`):** lexical retrieval over the same claim set, catching pairs that share key terms but sit far apart in embedding space.

Each surviving pair is tagged with a `retrieval_source` (`dense`, `bm25`, or `both`) so coverage from each retriever is measurable. The dense pass alone misses vocabulary-distant but conceptually related claims; BM25 recovers them (e.g. "transformer attention degrades on long sequences" vs "BERT fails beyond 512 tokens"). The two together feed Stage 2.

The dense threshold is exposed as three presets in the UI:
- **Quick** (0.55): fast, may miss conceptually related but vocabulary-distant claims
- **Balanced** (0.50, default): good coverage for most libraries
- **Deep** (0.40): catches more distant relationships, takes longer

**Embedding model history:** The system was originally built with local `sentence-transformers` (MiniLM-L6-v2), then evaluated BGE-base as a potential upgrade (BGE-base compressed similarity scores upward, reducing class separation on the narrow-domain corpus — separation dropped from +0.274 to +0.141 — so MiniLM was retained). The current model is **Voyage AI** (`voyage-3.5-lite`), migrated to eliminate the ~400MB torch RAM overhead that caused OOM crashes on Render's free tier. Voyage produces higher-quality embeddings and runs as an API call, removing the local model dependency entirely.

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

**Computed evidence strength.** Alongside the model's `stronger_evidence` verdict, a deterministic score is computed for each claim from the empirical cues it states — study design (RCT > cohort > case study), sample size, effect size, p-value, confidence intervals, and hedging language. It yields a 0–1 strength plus the named signals that produced it, and an `evidence_gap` indicating which side is better supported. This is a transparent second opinion (no model call), surfaced as chips in the Conflict Map; see `utils/evidence_strength.py`.

**Prompt engineering:** The contradiction judge went through four iterations tracked against a formal eval set (see Evaluation section). The current prompt uses a decision tree structure that first distinguishes proxy vs. orthogonal measurements before asking for the contradiction classification, and includes six few-shot examples targeting the nuance/contradiction boundary — the hardest case for the model.

**Cache behavior:** Judged relationships are persisted to a `relationships` table keyed on the sorted pair of claim IDs (`claim_lo`, `claim_hi`). Re-running a scan on the same papers costs zero judgment calls for pairs already seen. The upsert is idempotent — running the scan twice produces one row, not two.

---

### 5. Formal evaluation harness

The contradiction engine has a formal eval harness that runs independently of the production database.

**Gold set:** 42 hand-labeled claim pairs across three domains — the original 30 from the negotiation-AI literature plus 12 cross-domain pairs (information-retrieval and LLM-reasoning). The negotiation set is balanced across all four classes and deliberately oversamples nuance (the hardest class); the cross-domain pairs exist to test generalization beyond the domain the prompt was tuned on. A deterministic hash-based train/test split lets you tune prompts on `train` and report on a held-out `test` split, and `run_eval.py` takes `--split` and `--domain` flags, printing per-domain macro-F1 so generalization is visible rather than hidden in one pooled number.

**Harnesses:**
- `eval/run_eval.py` scores **Stage 2** (the LLM judge) by feeding gold pairs straight to `judge_pair(pair, use_cache=False)`, bypassing both the in-memory cache and the DB read/write path. Eval runs never contaminate production data and always hit the LLM fresh.
- `eval/stage1_separation.py` scores **Stage 1 retrieval separation** independently. This split exists because the Stage 2 harness feeds gold pairs directly to the judge, so any retrieval-threshold sweep measured against Stage 2 macro-F1 would produce a flat line — retrieval has to be measured on its own.
- `eval/rerank_eval.py` scores the **search reranker** (nDCG/MRR over a separate graded gold set) — see the Semantic search section.

**Metrics:** 4-way macro-F1 (treats all classes equally regardless of frequency), Cohen's kappa (agreement corrected for chance), and binary tension F1 collapsing {contradiction, nuance} vs. {support, unrelated}. The table below was measured on the negotiation-AI set (the cross-domain pairs were added afterward to test generalization, not to move these numbers).

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

**Novelty scoring:** Rather than asking the model to self-assess novelty (unreliable — it tends toward high), novelty is computed as cosine distance between the hypothesis embedding and the nearest chunk in the library via pgvector. All hypothesis statements are batch-embedded in a single Voyage API call, then each is scored against the library using the pre-computed vector. A hypothesis very close to existing library content scores low novelty; one in unexplored territory scores high.

**Cache:** Hypothesis results are cached keyed on the set of paper IDs, any research question, and a relationships watermark (`MAX(created_at)` aggregate over the relationships table — no full-table scan). Cache is invalidated when the library changes or a new scan adds relationships. A `GET /api/hypotheses` endpoint returns the most recent cached result (zero LLM calls) — the frontend uses this as a fallback when localStorage expires.

---

### 7. Knowledge graph

The knowledge graph endpoint assembles nodes and edges from the claims and relationships tables. It is **read-only by default** (`compute=false`): edges come straight from the persisted relationships table — zero LLM calls, no writes, and the relationships watermark never moves, so viewing the graph never invalidates the hypothesis cache. Passing `compute=true` runs the live two-stage pipeline to expand coverage deliberately.

Nodes are claims filtered to only those with at least one edge; isolated claims are excluded since they add visual noise without conveying information. Edges are persisted relationships colored by type (red = contradiction, green = support, amber = nuance).

The frontend runs a custom JavaScript force simulation with centering, repulsion, spring, and damping forces — paper-colored rings, degree-scaled nodes, hover tooltips, and a contextual inspector rail. No D3 dependency; the simulation runs entirely in the browser against the JSON payload the backend returns.

---

### 8. Semantic search and relevance tiers

Search runs in two stages. **Stage 1 (retrieve):** the query is embedded via **Voyage AI** (`voyage-3.5-lite`, `input_type="query"`) and pgvector returns a wide candidate pool by **cosine distance** using the `<=>` operator, accelerated by an **HNSW index** (`vector_cosine_ops`) so lookups stay sub-linear as the corpus grows. **Stage 2 (rerank):** those candidates are re-scored by a **Voyage cross-encoder reranker** (`rerank-2.5-lite`), which reads each `(query, passage)` pair jointly — a far better relevance signal than cosine distance for jargon-dense academic text. The reranker is an API call (no local cross-encoder weights, so it stays within the free-tier memory budget) and degrades gracefully to pure vector ordering if unavailable. A self-contained eval (`eval/rerank_eval.py`) measures the lift over a 25-query, ~150-passage graded gold set spanning ~10 research domains with deliberate hard negatives (passages that share the query's terms but answer the wrong question): reranking raises **nDCG@5 from 0.959 to 0.982** and **MRR from 0.980 to 1.000**.

Relevance is still reported as a tier rather than a percentage, using thresholds calibrated for voyage-3.5-lite on narrow-domain academic text:

- **Highly relevant** — distance < 0.35
- **Related** — 0.35 ≤ distance < 0.55
- **Tangential** — distance ≥ 0.55

The previous implementation showed `(1 - cosine_distance) * 100` as a percentage. This implied calibrated precision that doesn't exist — tiers are honest about what the model actually knows. The raw distance is still returned (`relevance_score`) so the frontend can sort or filter, but it isn't shown as a headline number.

**One surface, two depths.** A query first returns ranked passages (fast, no LLM); an *Answer this* action then synthesizes a short answer over those passages via the single-pass RAG endpoint, with the sources shown as grounding. A scope selector restricts both retrieval and the answer to the whole library or a single paper. (Search and the former separate Ask tab are now one surface — a researcher has a question, not a mode to pick.)

---

### 9. Research monitoring

The monitoring agent searches Semantic Scholar, OpenAlex, and arXiv (in that priority order) for papers matching configured keywords, filters out papers already in the library by title-key deduplication, and scores each candidate by embedding its abstract against the library's existing chunks via pgvector. Candidate abstracts are batch-embedded in one Voyage API call per topic scan. Results are grouped by topic with relevance tiers. Per-source failures are reported honestly (a `SourceUnavailable` exception and a `sources_failed` field surface an arXiv-down banner rather than silently returning empty results), and queries are sanitised before dispatch. When Gmail credentials are configured, the agent sends an HTML digest email via SMTP after each scan, with honest `email_sent`/`email_error` status reporting.

**Bounded, off-process execution.** The scan streams through topics one at a time, persisting each topic's results to a `monitor_results` table before moving on — so peak memory never holds every topic's results at once, and the page loads instantly from the DB (`GET /api/monitor/results`) rather than re-scanning. The whole scan runs as a standalone, memory-bounded cron worker (`python -m jobs.run_monitor`) so the heavy work stays off the web process — the source of the original OOM kills on Render's free tier. An in-process APScheduler fallback exists for single-dyno deploys, gated by `ENABLE_INPROCESS_MONITOR`. Each saved topic carries a **cadence** (daily / weekly / paused) that the worker honors, so high-traffic topics don't flood the digest.

**Citation alerts & author-follow.** Beyond keyword topics, the monitor surfaces two alerts that are native to a *personal* library and have no equivalent in a corpus-wide search tool: papers that newly **cite** the user's library (each library paper with a DOI or arXiv id is resolved on the Semantic Scholar citation graph, then its citers are pulled and deduped against the library) and new papers by **followed authors** (resolved by name via S2 author search). Both run as background jobs and feed the same one-click "add to library" path.

---

### 10. Persistence and cost control

The cost model for a naive implementation is brutal: every page load re-extracts claims, re-judges relationships, re-generates hypotheses. ScholarLens uses a two-table Postgres cache (`claims`, `relationships`) with these guarantees:

- A claim is extracted at most once per paper
- A relationship is judged at most once per claim pair (idempotent upsert keyed on sorted claim ID pair)
- The insight feed is a pure DB read — zero LLM calls per load regardless of library size
- The knowledge graph reads from cache by default — no new LLM calls on re-render
- Cached hypotheses are returned via `GET /api/hypotheses` — zero LLM calls on revisit

Cache invalidation: deleting a paper cascades its claims (FK) and purges their relationships; re-analyzing a paper explicitly clears stale claims and relationships before re-running.

The frontend mirrors this with localStorage caching (24-hour TTL, version-based busting, library-fingerprint cache-busting) for contradiction results, graph payloads, and hypothesis outputs — results survive tab switches and full page reloads. Every data-fetching tab uses a stale-while-revalidate pattern: cached data renders instantly, a background fetch updates it silently. The dashboard fires all API calls in parallel via `Promise.allSettled`.

---

### 11. Security, authentication, and multi-tenancy

ScholarLens is multi-user: every account has its own private library, and the backend is hardened against the common web-app attack classes.

**Authentication.** Pluggable via `AUTH_PROVIDER`. The default is **email + password**: passwords hashed with **bcrypt** (never plaintext); on login the server issues an opaque 256-bit session token in an **httpOnly + Secure + SameSite** cookie — httpOnly so JavaScript can't read it (defangs token theft via XSS), Secure so it's only sent over HTTPS, SameSite configurable via env var (`none` in production for cross-origin Vercel→Render requests). Sessions live server-side in a `sessions` table and rotate on each login. Setting `AUTH_PROVIDER=clerk` instead verifies a **Clerk** session JWT (RS256 via the JWKS endpoint, issuer-checked) and resolves it to the internal user — linking by clerk-id first, then **verified** email, so an existing library is preserved across the switch and an unverified address can never inherit another user's data. Either way a single FastAPI dependency (`get_current_user`) gates every protected endpoint, and the internal `user_id` stays the durable key for all data, so the provider can change without re-keying anything.

**Per-user data isolation.** Every paper carries a `user_id`; claims and relationships inherit ownership through their paper. Direct-object endpoints (`GET`/`DELETE /api/papers/{id}`) verify ownership and return `404` (not `403`) for another user's resource, so the API never reveals that an id exists. Aggregate features — search, contradictions, hypotheses, graph, insights, monitor — are scoped to the caller's paper IDs, closing the IDOR (insecure direct object reference) bug class.

**BYOK (bring-your-own-key).** Each user can store their own Anthropic key, encrypted at rest with **Fernet** (the encryption key lives in the environment, never the database). That user's LLM calls then run on their key; users without one fall back to the server key. The plaintext key is never returned to the client (settings shows a boolean + mask) and is validated without spending tokens via `models.list()`.

**Abuse protection.** Expensive endpoints carry per-IP **rate limits** (`slowapi`) — uploads, contradiction/hypothesis generation, search, monitor, and login (brute-force defense) — plus a global backstop. Uploads are validated by **magic bytes** (`%PDF-`), size-capped via a bounded read, and written under a generated UUID filename so a hostile client filename can't escape the upload directory (**path-traversal** defense). Admin endpoints are gated behind an environment token and fail closed when unset. All DB queries are parameterized (no SQL injection); rendered text relies on React's default escaping (no XSS); the localStorage cache is namespaced per user and cleared on logout.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Next.js 16 Frontend (App Router, TypeScript)           │
│                                                         │
│  Dashboard  ·  Library  ·  Knowledge graph             │
│  Conflict map  ·  Generative bench  ·  Monitor         │
│  ⌘K command palette                                     │
│                                                         │
│  localStorage cache (stale-while-revalidate pattern)   │
└─────────────────────────────┬───────────────────────────┘
                              │  REST/JSON
┌─────────────────────────────┴───────────────────────────┐
│  FastAPI Backend                                        │
│                                                         │
│  PDFAnalysisAgent   — 6 parallel LLM calls/paper       │
│  ContradictionAgent — 2-stage pipeline (BM25+dense→LLM)│
│  HypothesisAgent    — conflict-grounded synthesis      │
│  PaperImporter      — S2 + OpenAlex + arXiv (priority) │
│  MonitoringAgent    — topic watch + cron digest worker │
└──────────────┬──────────────────────────────────────────┘
               │
┌──────────────┴──────────────────────────────────────────┐
│  Supabase (Postgres + pgvector)                         │
│                                                         │
│  users · sessions · papers (user_id)                   │
│  analysis_results · chunks · claims                    │
│  relationships · hypothesis_cache                      │
│  embeddings (vector(1024), voyage-3.5-lite)             │
└─────────────────────────────────────────────────────────┘
```

---

## Tech stack

| Component | Choice | Why |
|-----------|--------|-----|
| LLM | Claude (Anthropic API) | Tool use support, strong structured extraction, cost-effective; BYOK for per-user keys |
| Backend | FastAPI | Async, typed, automatic OpenAPI docs at `/api/docs` |
| Frontend | Next.js 16 + TypeScript + Tailwind v4 | App Router, server components, Turbopack |
| Embeddings | Voyage AI voyage-3.5-lite (1024 dims) | API-based, eliminates ~400MB torch RAM overhead on Render free tier, higher retrieval quality than MiniLM or BGE on narrow-domain text |
| Reranker | Voyage rerank-2.5-lite | Cross-encoder second stage on search; API-based so it adds no local model weight |
| Vector index | pgvector HNSW (`vector_cosine_ops`) | Sub-linear nearest-neighbour lookups; falls back to exact scan on older pgvector |
| Lexical retrieval | rank-bm25 | Hybrid Stage-1 pass alongside dense retrieval; recovers vocabulary-distant claim pairs |
| Vector store | pgvector (Supabase) | Native Postgres extension, `<=>` cosine operator, no separate vector DB process |
| Database | Postgres via psycopg2 (Supabase) | Persistent, FK cascades, scales beyond SQLite |
| Auth | bcrypt + httpOnly sessions, or Clerk | Pluggable via `AUTH_PROVIDER`; Clerk adds passkeys / email-passcodes / OAuth and verifies a JWT, linking to the existing user row so libraries are preserved |
| Key encryption | cryptography (Fernet) | Encrypts per-user Anthropic keys at rest |
| Rate limiting | slowapi | Per-IP limits on expensive endpoints + login brute-force defense |
| PDF parsing | PyMuPDF (`fitz`) | Fast, column-aware extraction with dynamic gutter detection |
| Email | Gmail SMTP | HTML digest delivery for monitoring agent |
| Deploy | Render (backend) + Vercel (frontend) + Supabase (DB) | Free tier stack, persistent DB survives redeployments |

---

## Quick start

You'll need Python 3.12+, Node.js 18+, an Anthropic API key, and a Supabase project (free tier).

### Backend

```bash
git clone https://github.com/aakashshahani/ScholarLens.git
cd ScholarLens

python -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt

# Create .env:
# ANTHROPIC_API_KEY=sk-ant-xxxxx
# DATABASE_URL=postgresql://postgres:[password]@[host]:5432/postgres
# FERNET_KEY=<generate: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())">
# VOYAGE_API_KEY=pa-...          (required — get from voyageai.com)
# SEMANTIC_SCHOLAR_KEY=...       (optional — higher rate limits)
# CONTACT_EMAIL=you@example.com  (optional — OpenAlex "polite pool" for faster imports)
# GMAIL_USER=...                 (optional — for email digests)
# GMAIL_APP_PASSWORD=...         (optional — Gmail app password)
# AUTH_PROVIDER=password         (optional — "password" default, or "clerk")
# CLERK_ISSUER=...               (only if AUTH_PROVIDER=clerk — see docs/CLERK_SETUP.md)
# CLERK_JWKS_URL=...             (only if AUTH_PROVIDER=clerk)
# ENABLE_INPROCESS_MONITOR=true  (optional — false to use the standalone cron worker)

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
  api.py                    FastAPI — all REST endpoints (auth-gated, per-user scoped)
  auth.py                   Auth: bcrypt passwords, sessions, Fernet key encryption, get_current_user
  clerk_auth.py             Clerk JWT verification + identity linking (used when AUTH_PROVIDER=clerk)
  config/
    settings.py             Config, env vars, relevance tiers, security / auth / rate-limit settings
  db/
    database.py             Postgres data layer (psycopg2): users, sessions, papers, claims, relationships, caches
  agents/
    pdf_analyst.py          Parallel 6-type analysis pipeline + single-pass RAG (ask)
    contradiction_agent.py  Two-stage pipeline (BM25+dense → LLM judge), eval harness support
    hypothesis_agent.py     Conflict-grounded hypothesis synthesis with batch novelty scoring
    paper_import.py         Semantic Scholar + OpenAlex + arXiv import + dedup + retry
    monitoring_agent.py     Topic monitoring + Gmail email digest
  jobs/
    run_monitor.py          Standalone monitor worker (Render Cron Job — off the web process)
    link_account.py         One-shot helper to link a pre-Clerk account without losing papers
  utils/
    pdf_parser.py           PyMuPDF extraction, dynamic column detection, section-aware chunking
    vector_store.py         pgvector wrapper — embed/search/rerank, HNSW index, cosine via <=>
    bm25_index.py           Lexical retrieval index for the hybrid Stage-1 pass
    evidence_strength.py    Computed evidence-strength scoring from a claim's stated cues
  eval/
    gold_claims.json        42 claim pairs across 3 domains, train/test split (contradiction judge)
    run_eval.py             Stage 2 scoring (macro-F1, kappa, binary tension); --split / --domain
    stage1_separation.py    Stage 1 retrieval-separation harness
    gold_search.json        25-query graded set with hard negatives (search reranker)
    rerank_eval.py          Search reranking eval (nDCG / MRR), standalone (no DB)
  frontend/
    src/
      app/                  Next.js pages
      components/           Left rail, command palette, shared UI
      lib/
        api.ts              Typed API client
        cache.ts            localStorage cache — per-user namespaced, TTL + version busting
  data/                     Runtime uploads (gitignored)
```

---

## API reference

All endpoints except `/api/health` and the `/api/auth/{register,login,logout}` routes require an authenticated session cookie. Library/aggregate endpoints are scoped to the authenticated user.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Bare health check for Render probe |
| GET | `/api/health` | System status, paper count, library fingerprint |
| POST | `/api/auth/register` | Create account, set session cookie |
| POST | `/api/auth/login` | Authenticate, rotate + set session cookie |
| POST | `/api/auth/logout` | Clear the current session |
| POST | `/api/auth/logout-all` | Revoke every session for the user |
| GET | `/api/auth/me` | Current authenticated user |
| GET | `/api/settings` | User settings (model, digest email, library name, masked key) |
| PUT | `/api/settings` | Update settings / store BYOK key (Fernet-encrypted) |
| POST | `/api/settings/test-key` | Validate an Anthropic key without spending tokens |
| GET | `/api/papers` | List papers with analysis types and claim count |
| GET | `/api/papers/{id}` | Paper detail, analyses (scaffolding stripped), chunk count |
| POST | `/api/papers/upload` | Upload PDF — deduplication before ingest, background analysis |
| DELETE | `/api/papers/{id}` | Delete paper, cascade claims + relationships |
| POST | `/api/papers/{id}/reanalyze` | Re-run analyses, invalidate claim/relationship cache |
| GET | `/api/papers/{id}/status` | Analysis completion status for polling |
| GET | `/api/papers/{id}/export` | Export a citation (BibTeX / RIS / APA / Chicago / MLA) |
| GET | `/api/tags` | List the user's paper tags |
| POST/DELETE | `/api/papers/{id}/tags` | Add or remove a tag on a paper |
| GET | `/api/jobs/{id}` | Poll a background job (scan / hypotheses / monitor / ask) |
| POST | `/api/search` | Semantic search — pgvector retrieve + cross-encoder rerank, relevance tiers |
| POST | `/api/ask` | RAG Q&A grounded in retrieved passages (returns the sources) |
| GET | `/api/contradictions/count` | Cached relationship counts — zero LLM calls |
| GET | `/api/contradictions` | List persisted contradiction results (with evidence-strength) — zero LLM calls |
| POST | `/api/contradictions` | Run two-stage contradiction scan |
| POST | `/api/contradictions/{id}/feedback` | Record agree / disagree / flag on a relationship |
| GET | `/api/contradictions/export` | Export contradiction report (markdown / json) |
| GET | `/api/hypotheses` | Return most recent cached hypotheses — zero LLM calls |
| POST | `/api/hypotheses` | Generate conflict-grounded hypotheses |
| GET | `/api/hypotheses/runs` | List past generation runs (and `/runs/{id}` for one) |
| GET/POST | `/api/hypotheses/feedback` | Read / persist 👍👎 votes per hypothesis |
| GET | `/api/hypotheses/export` | Export hypotheses (markdown / json) |
| POST | `/api/graph` | Build claim knowledge graph (`compute=false` read-only by default) |
| GET/POST | `/api/graph/clusters` | List or detect debate clusters |
| POST | `/api/insights` | Synthesized insight feed — pure DB read |
| POST | `/api/import/search` | Search Semantic Scholar / OpenAlex / arXiv |
| POST | `/api/import/lookup` | Lookup by arXiv ID, DOI, or URL |
| POST | `/api/import/add` | Import paper — dedup check before PDF download |
| POST | `/api/monitor/scan` | Run monitoring scan (background job) with optional email digest |
| GET | `/api/monitor/results` | Latest persisted scan results — pure DB read |
| GET/POST/DELETE | `/api/monitor/topics` | List, create, or delete saved monitor topics |
| PATCH | `/api/monitor/topics/{id}` | Update a topic's cadence (daily/weekly/paused) or active state |
| GET/POST/DELETE | `/api/monitor/authors` | List, follow, or unfollow authors |
| POST | `/api/monitor/citations` | Find recent papers citing your library *(background job)* |
| POST | `/api/monitor/author-scan` | Find new papers by followed authors *(background job)* |
| POST | `/api/monitor/test-digest` | Trigger an immediate scan + send a test digest |
| POST | `/api/admin/fix-abstracts` | Re-fetch truncated abstracts *(admin — token-gated)* |

Full interactive docs at `/api/docs`.

---

## Roadmap

**Done**

Core pipeline: 6-type parallel analysis, two-stage contradiction detection (macro-F1 0.788, kappa 0.683 on the negotiation-AI set; gold set expanded to 42 pairs across 3 domains with a train/test split), computed evidence-strength scoring, evidence-grounded claim extraction, BM25+dense hybrid retrieval, hypothesis generation with batch novelty scoring and persisted feedback, research monitor (keyword topics + citation alerts + author-follow, per-topic cadence) with Gmail digest, unified search-and-answer with HNSW-indexed retrieval + cross-encoder reranking and on-demand synthesis, insight feed as a pure DB read, read-only knowledge graph with debate clusters and gated compute path, Semantic Scholar + OpenAlex + arXiv import with dedup.

Security and multi-user: pluggable auth — email + password (bcrypt, httpOnly session cookies) or Clerk JWT verification with verified-email linking — per-user library scoping and IDOR-safe ownership checks, BYOK with Fernet key encryption, model selection with server-side ceiling, upload hardening (magic-byte check, size cap, path-traversal-safe UUID filenames), per-IP rate limiting, parameterized queries throughout.

Frontend: dashboard with parallel API loading, login/register gate, settings panel (BYOK key management, model picker), per-user localStorage cache namespacing, stale-while-revalidate across all tabs.

Infrastructure: migrated from SQLite + ChromaDB to Supabase Postgres + pgvector (HNSW index, self-healing connection pool). Deployed on Render (backend) + Vercel (frontend). Daily monitor as a standalone, memory-bounded cron worker (9am UTC, per-user topics, Gmail digest), with an in-process APScheduler fallback.

**Later**
- Apply the cross-encoder reranker to the contradiction Stage-1 candidate pairs (search reranking is already shipped)
- Inline PDF viewer with passage highlighting; "lit-review export" composing conflicts + evidence-strength + hypotheses
- Demo video

---

## About

Built by Aakash Shahani, CS graduate from the University of South Florida (December 2025). Research assistant at the USF CSSAI lab studying whether LLMs can improve negotiation skills in humans. ScholarLens started after spending weeks manually reading and comparing dozens of papers for that research — the work of analyzing, searching, and cross-referencing papers seemed like exactly the kind of thing that should be automated.
