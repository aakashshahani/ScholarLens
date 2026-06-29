# ScholarLens — 10/10 Polish Audit

A feature-by-feature audit (frontend **and** backend) with current behavior, a
rating, and a concrete path to 10/10. The goal: make every tab feel complete,
fast, and honest — and surface every backend signal the UI currently ignores.

**Overall:** the app is already a strong 8/10. The frontend is genuinely
high-quality (SWR caching, staged polling, custom force-sim graph, glass HUD,
real empty/error states). The gap to 10/10 is mostly: (a) surfacing backend
signals the UI drops on the floor, (b) a few real bugs, and (c) stale copy.

Ratings are calibrated, not inflated. 7 = good. 8 = polished. 9 = portfolio-grade.
10 = nothing a reviewer would ding.

---

## Cross-cutting issues (fix once, helps everywhere)

| # | Issue | Where | Severity | Status |
|---|-------|-------|----------|--------|
| X1 | **Orphaned signal:** `rerank_score` returned by `/api/search` is never shown | Search | med | ✅ done — `rerank_score` typed, "Top match" cue, honest copy |
| X2 | **Orphaned signal:** `evidence_strength` + `evidence_gap` on contradictions never rendered | Conflict Map | high | ✅ done — per-claim chips + better-supported indicator + sort by gap |
| X3 | **Bug:** monitor papers have a similarity *score* but no `relevance_tier`, so every result falls to "Broader field" | Monitor | high | ✅ done — similarity→tier mapping in payload |
| X4 | **Orphaned endpoint:** `GET /api/monitor/results` unused; monitor only reads localStorage | Monitor | med | ✅ done — SWR load from DB on mount |
| X5 | **Bug:** Ask defines `SourceCard` but never renders sources | Ask | high | ✅ done — backend returns sources, rendered in Ask + paper detail |
| X6 | **Stale copy:** Monitor "06:00 UTC" vs Settings "09:00 UTC" | Monitor | low | ✅ done — unified on 09:00 UTC |
| X7 | **Feedback not persisted:** hypothesis 👍/👎 localStorage-only | Generative Bench | low | ✅ done — new table + endpoints, server-persisted |
| X8 | **Validation hole:** accepts any string with `@` as an email | Auth / Settings | med | ◑ partial — digest email now validated; login/register validation lands with Clerk |

Additional fixes in this pass: import pages now include **OpenAlex** (was arXiv+S2 only) and replace `alert()` with inline errors; Library bulk-delete parallelized + in-app confirm; Dashboard stats deep-link; Graph force-sim settles (stops the O(n²) loop) and drops the `window` global; command palette now searches papers (closing its placeholder promise).

---

## 1. Dashboard — "Situation room"  ·  **8 / 10**

**Frontend:** Cache-first load, all six data sources fired in parallel via
`Promise.allSettled`. Count-up stat cards, coverage ring, spotlight row (top
contradiction / gap / hypothesis / most-connected topics), recent papers,
action cards. Grain overlay, staggered entrance. Data-honesty comment block —
every number is real.

**Backend:** `/api/health`, `/api/insights` (pure DB read), `/api/contradictions/count`,
`/api/hypotheses` (cached), `/api/graph?compute=false`.

**To 10/10:**
- "Research gap" and "Most-connected topics" cells both link to `/contradictions`
  — the gap cell should deep-link to a gaps view (or filter), not the conflict map.
- Add lightweight skeletons for the first cold load (cache-first hides this for
  return visits, but first paint shows empty cells).
- "Cross-paper links" and "Contradictions" stats could animate/deep-link to a
  filtered Conflict Map (e.g. clicking "Contradictions" opens the map pre-filtered).
- Show a tiny "last scan" timestamp so the numbers feel live, not stale.

---

## 2. Library — "The corpus"  ·  **8.5 / 10**

**Frontend:** Search (title/author/abstract), filter chips (all/analyzed/source/tags),
4 sort keys, bulk-select + delete, per-paper tags (add/remove), inspector rail
with stats, abstract truncation, 5-format citation export (BibTeX/RIS/APA/Chicago/MLA),
progress ring per paper. Skeleton loaders. Genuinely excellent.

**Backend:** `/api/papers`, `/api/papers/{id}`, delete, `/api/tags`, tag add/remove,
`/api/papers/{id}/export`.

**To 10/10:**
- Bulk delete is a sequential `await` loop — parallelize with `Promise.allSettled`
  and show per-row progress for large selections.
- Replace `confirm()` with an in-app confirm modal (consistent styling, not a
  browser dialog).
- Add "Re-analyze" and a per-paper analysis status/poll directly from the rail
  (currently you must open the paper).
- Keyboard: arrow-key navigation through the list, `/` to focus search.

---

## 3. Paper detail  ·  *not yet deep-audited*

`/api/papers/{id}` returns analyses (scaffolding stripped), chunk count, status
polling. **Action:** deep-audit when we reach this tab — verify the 6 analyses
render cleanly, status polling for in-progress papers, and "find source" linking
back to Search.

---

## 4. Search  ·  **7.5 / 10**

**Frontend:** Hero empty state, suggestion chips, query-term highlight, results
grouped by paper with expand/collapse, relevance-tier badges, conversation-style
history with localStorage cache, auto-submit from `?q=`.

**Backend:** `/api/search` → pgvector cosine + **new Voyage reranking** (top-30 →
rerank → top-k), HNSW index, honest relevance tiers.

**To 10/10:**
- **Surface the reranker (X1).** Results are now ordered by `rerank_score` but the
  UI shows only the distance-based tier. Show a subtle "best match" indicator or a
  rerank-confidence cue, and update copy from "ranked by semantic similarity" to
  reflect the cross-encoder rerank.
- Suggestion chips are hardcoded to the negotiation domain — derive them from the
  user's actual papers (titles/keywords) so they're relevant to any library.
- Relevance tier is computed from cosine distance only; consider deriving the tier
  from `rerank_score` when present (it's the better signal).
- Search vs Ask overlap — see Ask.

---

## 5. Ask (RAG Q&A)  ·  **7 / 10**

**Frontend:** Multi-turn chat, per-message scope selector (whole library / one
paper), suggestion chips, streaming-style polling, markdown rendering, history
passed back (last 8 turns). Clean.

**Backend:** `/api/ask` → background job → answer grounded in retrieved passages.

**To 10/10:**
- **Render sources (X5).** `SourceCard` is defined but never used — the retrieved
  passages that ground each answer are not shown. This is the single biggest gap:
  surface the grounding under each answer (collapsible passages with paper + section).
- True token streaming (SSE) instead of poll-for-final — dramatically better feel.
- Resolve the **Search/Ask overlap**: they share suggestions and both "search your
  library." Consider merging into one surface (retrieve + optional synthesized
  answer) or clearly differentiating ("Search = passages, Ask = answers").

---

## 6. Conflict Map (contradictions)  ·  **8.5 / 10**  ← crown jewel

**Frontend:** Scan-depth presets, per-paper scope, staged progress ticker, SWR
cache, count tiles (filterable), per-paper filter chips, tension-pair list +
adjudication rail (resolution, stronger evidence, explanation, feedback 👍/👎/flag),
markdown explanation renderer, markdown/JSON export, "library changed" banner.

**Backend:** two-stage pipeline (BM25+dense → LLM judge), persisted relationships,
**new evidence-strength scoring**, feedback persisted to DB.

**To 10/10:**
- **Render evidence strength (X2).** Each claim now carries `evidence_strength`
  (score/label/design/signals) and the pair carries `evidence_gap`. Show per-claim
  strength chips (e.g. "RCT · n=312 · d=0.4 → strong") and a "better-supported side"
  indicator that corroborates or contrasts the LLM's `stronger_evidence`. This makes
  the differentiator *visibly* stronger and is the highest-ROI single change.
- Sort/secondary-rank contradictions by `evidence_gap` (biggest asymmetry first).
- Empty/first-run: the config prompt is good; add an example of what a conflict
  looks like so a brand-new user understands the output before scanning.

---

## 7. Knowledge Graph + Clusters  ·  **9 / 10**

**Frontend:** Custom force-directed simulation (no D3), glass HUD, relationship-type
toggles, node search with highlight, zoom/pan, zoom-to-fit, PNG export, node
inspector with connected edges, paper legend, **clusters view** (debate clusters
with conflict-density bars + detail). Genuinely portfolio-grade.

**Backend:** `/api/graph` (read-only default, gated compute), `/api/graph/clusters`.

**To 10/10:**
- **Perf:** repulsion is O(n²) recomputed every animation frame — fine for ~50
  nodes, will jank past ~150. Add a Barnes-Hut quadtree or cap/alpha-cool the sim.
- Replace the `window.__slEdges` global hack with a ref (stale-closure workaround
  that leaks onto `window`).
- Edge hover → show the relationship explanation inline (currently only via the
  inspector). Optional edge labels on hover.
- Freeze/settle the layout after cool-down to stop perpetual micro-motion.

---

## 8. Generative Bench (hypotheses)  ·  **8.5 / 10**

**Frontend:** Run history chips (permanent records), novelty rail (relative bars,
no raw cosine), source-paper lineage timeline, grounded-vs-gap badges, links to
source conflict IDs, methodology + challenges, feedback 👍/👎, print/PDF export.

**Backend:** conflict-grounded synthesis, batch novelty scoring, run persistence,
cached `GET /api/hypotheses`.

**To 10/10:**
- **Persist feedback (X7):** hypothesis votes are localStorage-only; contradiction
  feedback hits the DB. Add an endpoint and persist, so votes survive devices and
  can inform generation.
- Source-conflict chips link to `/contradictions` generically — deep-link to the
  specific relationship (filter/scroll to it).
- Export uses `window.open` + print — offer a Markdown/PDF download consistent with
  the other tabs' export buttons.

---

## 9. Research Monitor  ·  **6.5 / 10**  ← weakest tab, biggest upside

**Frontend:** Saved topics (DB-backed), add/remove, run-now scan with polling,
per-topic results grouped strong/tangential, add-to-library, source-failure banner,
"last scanned" timestamps.

**Backend:** **rewritten** — bounded streaming, per-topic persistence to
`monitor_results`, standalone cron worker (`jobs/run_monitor`), `ENABLE_INPROCESS_MONITOR`
flag, **new `GET /api/monitor/results`**.

**To 10/10:**
- **Fix the tier bug (X3).** Monitor papers carry a similarity `relevance_score`
  (0–1, higher = better) but no `relevance_tier`. The UI groups by tier → everything
  lands in "tangential" → it permanently shows "No close matches — showing broader
  field." Fix: compute a tier from the *similarity* (high score = highly relevant),
  not the distance-based `settings.relevance_tier` (which expects the opposite).
- **Use the persisted endpoint (X4).** Load `GET /api/monitor/results` on mount so
  results render instantly from the DB and survive restarts/devices — not just
  localStorage.
- **Fix stale copy (X6):** "06:00 UTC" → 09:00 UTC (or read it from config).
- Show which sources responded per scan, and dedupe "add to library" against the
  current library before showing the button.

---

## 10. Settings / BYOK / model  ·  **8.5 / 10**

**Frontend:** BYOK key (test without spending tokens, save, remove, masked display),
model picker with free-tier ceiling + optimistic update, free-tier usage bars,
library name, digest email + send-test-digest, sign-out / sign-out-everywhere.

**Backend:** `/api/settings`, Fernet-encrypted key at rest, model allowlist + ceiling.

**To 10/10:**
- Inline validation on the digest email field (ties into X8 — enforce real emails).
- Surface a tiny "where do I get a key?" link to the Anthropic console.
- After Clerk migration, this is where "manage account" / SSO lives.

---

## 11. Auth  ·  *functional, deferred to Clerk*

**Current:** bcrypt + httpOnly session cookie + Bearer fallback, IDOR-safe scoping.
**Issues:** email validation accepts non-emails (X8); password reset / email
verification absent (Clerk will provide both). **Plan:** Clerk migration, resolving
`clerk_user_id` first then email, with the fake-email account handled by an explicit
link-by-id backfill. Deferred until tabs are polished.

---

## 12. Command palette / shell / nav  ·  *not yet deep-audited*

`⌘K` palette, left rail, app shell exist. **Action:** deep-audit when reached —
verify keyboard coverage, active-route highlighting, and that the palette can reach
every tab + action.

---

## 13. Eval harness (backend, portfolio asset)  ·  **9 / 10**

**Current:** gold set now 42 pairs across 3 domains (negotiation / IR / LLM-reasoning),
train/test split with deterministic hash fallback, Stage-2 judge eval (macro-F1,
kappa, binary tension), Stage-1 separation harness, new search-rerank eval
(nDCG/MRR), per-domain generalization report, `--split`/`--domain` filters.

**To 10/10:**
- Run the rerank eval live (needs `VOYAGE_API_KEY`) and record the nDCG lift in the
  README, the same way the contradiction metrics table is presented.
- `stage1_separation.py` still references MiniLM/BGE via `sentence_transformers`
  (no longer a dependency) — update to Voyage or mark it explicitly historical.

---

## 14. Ingestion (upload / import / add-papers)  ·  **8 / 10** (group)

Multi-source import (Semantic Scholar → OpenAlex → arXiv), dedup, SSRF-guarded PDF
download, magic-byte upload validation, batch upload. **Action:** deep-audit the
three pages when reached — verify progress feedback, duplicate messaging, and error
states on flaky sources.

---

## Suggested implementation order (by differentiation × current-gap)

1. **Conflict Map** — render evidence strength (X2). Highest ROI; makes the
   differentiator visibly stronger and closes the loop on backend work already done.
2. **Monitor** — fix tier bug (X3) + wire persisted results (X4) + copy (X6).
   Biggest single-tab quality jump (6.5 → 9).
3. **Ask** — render sources (X5) + consider streaming. Closes the "grounded" promise.
4. **Search** — surface reranking (X1) + dynamic suggestions.
5. **Graph** — perf (quadtree) + remove the `window` global.
6. **Generative Bench** — persist feedback (X7), deep-link conflicts.
7. **Library / Dashboard / Settings** — the smaller polish items above.
8. **Paper detail / palette / ingestion** — deep-audit + polish.
9. **Auth → Clerk** — after tabs are 10/10.
