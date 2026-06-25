"""
Contradiction Detection Agent

Two-stage pattern used in production RAG systems:
  Stage 1: Vector similarity finds claims about the SAME topic across papers
  Stage 2: LLM judges whether those claims contradict, support, or are unrelated

This is the most technically interesting feature in ScholarLens and the one
most likely to generate conversation in an interview.

Persistence notes (session change):
- extract_claims now reads from the DB first (stable IDs across runs).
  LLM extraction only fires when no cached claims exist for a paper.
  Newly extracted claims are persisted immediately via db.insert_claims.
- judge_pair writes through to db.upsert_relationship after every LLM call.
  The in-memory _judgment_cache stays as a hot path to skip repeat DB reads
  within a single scan batch — the DB is the durable source of truth.
- This makes the insight feed and hypothesis agent read real, persisted data
  rather than an always-empty relationships table.

Stage 1 hybrid retrieval (added):
  find_claim_pairs now runs two passes and takes their union:
  1. Dense pass  — cosine similarity via MiniLM embeddings (existing behaviour)
  2. BM25 pass   — keyword overlap via rank_bm25 (new)
  BM25 catches vocabulary-distant pairs that dense retrieval misses: two claims
  can describe the same finding with completely different words but share rare
  terms (dataset names, metric names, method abbreviations, numbers) that BM25
  scores highly. The union of both passes reaches the LLM judge; duplicates
  are collapsed and pairs are sorted by their best score across both passes.
"""

import hashlib
import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone

from anthropic import Anthropic

from config import settings
from db import Database, StoredClaim, StoredRelationship
from utils import VectorStore
from utils.bm25_index import BM25Index


@dataclass
class Claim:
    """A single extractable claim from a paper (runtime representation)."""
    id: str
    paper_id: str
    paper_title: str
    text: str
    section: str        # which analysis it came from
    confidence: str     # "high", "medium", "low"


@dataclass
class ClaimPair:
    """Two claims from different papers that may relate."""
    claim_a: Claim
    claim_b: Claim
    similarity: float
    retrieval_source: str = "dense"  # "dense" | "bm25" | "both"


@dataclass
class ContradictionResult:
    """The LLM's judgment on a claim pair."""
    id: str
    claim_a: Claim
    claim_b: Claim
    relationship: str   # "contradiction", "support", "nuance", "unrelated"
    category: str       # "methodological", "findings", "theoretical", "scope"
    explanation: str
    stronger_evidence: str  # "paper_a", "paper_b", or "neither"
    resolution: str     # how future research could resolve it
    similarity: float = 0.0  # best similarity score from Stage 1
    retrieval_source: str = "dense"  # which retrieval pass surfaced this pair
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


def _stored_to_claim(sc: StoredClaim, paper_title: str) -> Claim:
    """Convert a DB-persisted StoredClaim to the runtime Claim dataclass."""
    return Claim(
        id=sc.id,
        paper_id=sc.paper_id,
        paper_title=paper_title,
        text=sc.text,
        section=sc.section or "unknown",
        confidence=sc.confidence or "medium",
    )


class ContradictionAgent:
    def __init__(self):
        self.client = Anthropic()
        self.db = Database()
        self.vector_store = VectorStore()
        # In-session hot cache: avoids repeat DB reads within one scan batch.
        # Keys are text-hash strings; values are ContradictionResult objects.
        # Does NOT persist across restarts — the relationships table is truth.
        self._judgment_cache: dict[str, ContradictionResult] = {}

    def _anthropic(self, api_key: str | None = None):
        """Per-request Anthropic client: the caller's BYOK key when provided,
        else the shared server client. Built per call, never stored on self,
        so it is safe under concurrent (threadpool) use."""
        return Anthropic(api_key=api_key) if api_key else self.client

    @staticmethod
    def _cache_key(claim_a_text: str, claim_b_text: str) -> str:
        """
        Deterministic cache key from two claim texts.
        Sorted so (A,B) and (B,A) hit the same entry.
        """
        texts = sorted([claim_a_text.strip(), claim_b_text.strip()])
        combined = f"{texts[0]}|||{texts[1]}"
        return hashlib.sha256(combined.encode()).hexdigest()[:16]

    # ── Stage 1: Extract claims — DB-first ───────────────────

    def extract_claims(self, paper_id: str, api_key: str | None = None, model: str | None = None) -> list[Claim]:
        """
        Return claims for a paper. DB is checked first so claim IDs are
        stable across requests. LLM extraction only runs when the paper has
        no cached claims; results are persisted immediately.

        Stable IDs are the prerequisite for real hypothesis provenance:
        the hypothesis agent cites relationship IDs, which reference claim IDs.
        """
        paper = self.db.get_paper(paper_id)
        if not paper:
            return []

        # ── Cache hit: return persisted claims with stable IDs ──
        cached = self.db.get_claims_for_paper(paper_id)
        if cached:
            return [_stored_to_claim(sc, paper.title) for sc in cached]

        # ── Cache miss: extract from source text, then persist ──────
        if not paper.full_text:
            return []

        source_text = paper.full_text[:32000]
        if len(paper.full_text) > 32000:
            source_text += "\n\n[text truncated — only the first 32 000 characters were processed]"

        try:
            response = self._anthropic(api_key).messages.create(
                model=(model or settings.anthropic_model),
                max_tokens=2048,
                messages=[{
                    "role": "user",
                    "content": (
                        "Extract specific, falsifiable claims from the full text of this academic paper. "
                        "Each claim must come directly from what the paper reports — not from inference or summary — "
                        "and must be narrow enough that another paper could plausibly disagree with it.\n\n"
                        "HARD RULES — violating any of these makes a claim useless:\n"
                        "1. Name the exact system/method (never 'it', 'the approach', 'the authors')\n"
                        "2. Name the exact outcome variable or metric being measured\n"
                        "3. Include numbers where they exist (accuracy, effect size, p-value, sample size, "
                        "percentage change). If no numbers, state the direction and magnitude qualitatively.\n"
                        "4. State the population, task, or conditions the result holds under\n"
                        "5. Claims must be about SPECIFIC findings, not general capabilities. "
                        "'System X can do Y' is too broad. "
                        "'System X achieved Z% accuracy on task T in condition C' is correct.\n\n"
                        "CLAIM TYPES TO PRIORITIZE (roughly in order):\n"
                        "- Measurement claims: what metric was used and what it found\n"
                        "- Causal claims: what intervention produced what effect and under what conditions\n"
                        "- Comparative claims: how this approach differs from baseline or prior work in measurable terms\n"
                        "- Scope/boundary claims: where the method works and where it breaks down\n\n"
                        "REJECT these as too vague to be useful:\n"
                        "- 'Paper X demonstrates that automated systems can measure Y' (topic description, not a claim)\n"
                        "- 'The results show the approach is effective' (no specifics)\n"
                        "- 'This work contributes to the field of Z' (meta-statement)\n\n"
                        "BAD: 'ACE improves negotiation outcomes.'\n"
                        "GOOD: 'ACE feedback produced significantly greater deal prices than human or no feedback "
                        "(F(2,371)=10.79, p<0.001) in a 374-participant two-used-car negotiation task.'\n\n"
                        "BAD: 'The system uses automated metrics to evaluate negotiation.'\n"
                        "GOOD: 'Dialogue-annotation-based metrics predicted actual negotiation outcomes with r=0.67 "
                        "in the Johnson et al. dataset, outperforming human rater agreement on the same task.'\n\n"
                        "Return ONLY valid JSON: a list of objects with fields:\n"
                        '"text" (the self-contained claim — must satisfy all 5 rules above),\n'
                        '"section" (the paper section this claim comes from: abstract/introduction/methods/results/discussion/conclusion),\n'
                        '"confidence" (high=quantitative evidence with numbers, medium=qualitative with clear direction, '
                        'low=speculative or indirect).\n\n'
                        "Return 6-10 claims. Fewer high-quality claims beat many vague ones. "
                        "No preamble, no markdown fences.\n\n"
                        f"Paper: {paper.title}\n\n<document>\n{source_text}\n</document>"
                    ),
                }],
            )

            raw = response.content[0].text.strip()
            if raw.startswith("```"):
                raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
                if raw.endswith("```"):
                    raw = raw[:-3]
                raw = raw.strip()

            parsed = json.loads(raw)

            # Build StoredClaim objects with stable UUIDs and persist
            stored_claims = []
            for item in parsed:
                sc = StoredClaim(
                    id=StoredClaim.new_id(),
                    paper_id=paper_id,
                    text=item.get("text", ""),
                    section=item.get("section", "unknown"),
                    confidence=item.get("confidence", "medium"),
                    # evidence/conditions/source_quote left None — legacy extraction
                )
                stored_claims.append(sc)

            if stored_claims:
                self.db.insert_claims(stored_claims)

            return [_stored_to_claim(sc, paper.title) for sc in stored_claims]

        except Exception as e:
            print(f"Claim extraction failed for {paper_id}: {e}")
            return []

    # ── Stage 1b: Find similar claim pairs — hybrid retrieval ─

    def find_claim_pairs(
        self,
        all_claims: list[Claim],
        similarity_threshold: float = 0.6,
        bm25_top_k: int = 5,
        bm25_min_score: float = 0.25,
    ) -> list[ClaimPair]:
        """
        Find cross-paper claim pairs using hybrid retrieval: dense + BM25.

        Two passes are run and their results are unioned:

        Dense pass (existing):
            Embed all claims with MiniLM, compute pairwise cosine similarity.
            Pairs above similarity_threshold are kept.
            Good at: semantic similarity regardless of vocabulary.
            Misses: claims describing the same finding with different words.

        BM25 pass (new):
            Build a BM25 index over all claim texts. For each claim, retrieve
            top-k matches from other papers by keyword overlap. Pairs above
            bm25_min_score are kept.
            Good at: shared rare terms — dataset names, metric names, method
            abbreviations, numbers — that appear verbatim in both claims.
            Misses: paraphrased claims with no shared keywords.

        Union + dedup:
            A pair already found by the dense pass keeps its cosine similarity.
            A pair found only by BM25 carries the normalised BM25 score as its
            similarity value (so Stage 2 always has a usable score).
            A pair found by both is tagged "both" and keeps the cosine score
            (cosine is better calibrated for display).

        Args:
            all_claims:          flat list of claims from all papers in scope
            similarity_threshold: cosine threshold for dense pass
            bm25_top_k:          how many BM25 candidates to retrieve per claim
            bm25_min_score:      minimum normalised BM25 score (0-1) to keep a pair

        Returns:
            List of ClaimPair sorted descending by similarity score.
            Only cross-paper pairs are returned.
        """
        if len(all_claims) < 2:
            return []

        texts = [c.text for c in all_claims]

        # ── Dense pass ────────────────────────────────────────
        embeddings = self.vector_store.embed_texts(texts)

        # pair_key → ClaimPair; used for dedup across passes
        pair_map: dict[tuple[str, str], ClaimPair] = {}

        # O(n²) cosine via numpy matrix multiply — ~100x faster than the pure
        # Python nested loop it replaces. With 200 claims at 1024 dims this
        # takes ~5ms instead of ~30s. Falls back to pure Python if numpy is
        # unavailable (shouldn't happen on Render but safe to guard).
        try:
            import numpy as np
            emb_matrix = np.array(embeddings, dtype=np.float32)
            # L2-normalize each row so dot product == cosine similarity
            norms = np.linalg.norm(emb_matrix, axis=1, keepdims=True)
            norms = np.where(norms == 0, 1e-9, norms)
            emb_matrix = emb_matrix / norms
            # Full pairwise cosine matrix — shape (n, n)
            sim_matrix = emb_matrix @ emb_matrix.T

            for i in range(len(all_claims)):
                for j in range(i + 1, len(all_claims)):
                    if all_claims[i].paper_id == all_claims[j].paper_id:
                        continue
                    sim = float(sim_matrix[i, j])
                    if sim >= similarity_threshold:
                        key = (all_claims[i].id, all_claims[j].id)
                        pair_map[key] = ClaimPair(
                            claim_a=all_claims[i],
                            claim_b=all_claims[j],
                            similarity=sim,
                            retrieval_source="dense",
                        )
        except ImportError:
            # Pure Python fallback — correct but slow at scale
            for i in range(len(all_claims)):
                for j in range(i + 1, len(all_claims)):
                    if all_claims[i].paper_id == all_claims[j].paper_id:
                        continue
                    sim = self._cosine_similarity(embeddings[i], embeddings[j])
                    if sim >= similarity_threshold:
                        key = (all_claims[i].id, all_claims[j].id)
                        pair_map[key] = ClaimPair(
                            claim_a=all_claims[i],
                            claim_b=all_claims[j],
                            similarity=sim,
                            retrieval_source="dense",
                        )

        # ── BM25 pass ─────────────────────────────────────────
        # Build one index over all claim texts. For each claim query the
        # index and keep cross-paper matches above the score threshold.
        bm25 = BM25Index(texts)

        for i, claim in enumerate(all_claims):
            matches = bm25.query(claim.text, n=bm25_top_k + 1)  # +1 to skip self
            for match in matches:
                j = match.doc_index
                if j == i:
                    continue
                if all_claims[j].paper_id == claim.paper_id:
                    continue
                if match.score < bm25_min_score:
                    continue

                # Canonical key: smaller index first so (i,j) == (j,i)
                lo, hi = (i, j) if i < j else (j, i)
                key = (all_claims[lo].id, all_claims[hi].id)

                if key in pair_map:
                    # Already found by dense — upgrade tag, keep cosine score
                    existing = pair_map[key]
                    pair_map[key] = ClaimPair(
                        claim_a=existing.claim_a,
                        claim_b=existing.claim_b,
                        similarity=existing.similarity,
                        retrieval_source="both",
                    )
                else:
                    # New pair from BM25 only — use normalised BM25 score
                    pair_map[key] = ClaimPair(
                        claim_a=all_claims[lo],
                        claim_b=all_claims[hi],
                        similarity=match.score,
                        retrieval_source="bm25",
                    )

        n_dense   = sum(1 for p in pair_map.values() if p.retrieval_source == "dense")
        n_bm25    = sum(1 for p in pair_map.values() if p.retrieval_source == "bm25")
        n_both    = sum(1 for p in pair_map.values() if p.retrieval_source == "both")
        print(f"[hybrid] dense={n_dense}  bm25_only={n_bm25}  both={n_both}  total={len(pair_map)}")

        pairs = sorted(pair_map.values(), key=lambda p: p.similarity, reverse=True)
        return pairs

    @staticmethod
    def _cosine_similarity(a: list[float], b: list[float]) -> float:
        dot = sum(x * y for x, y in zip(a, b))
        norm_a = sum(x * x for x in a) ** 0.5
        norm_b = sum(x * x for x in b) ** 0.5
        if norm_a == 0 or norm_b == 0:
            return 0.0
        return dot / (norm_a * norm_b)

    # ── Stage 2: LLM judges each pair ────────────────────────

    def judge_pair(self, pair: ClaimPair, use_cache: bool = True, api_key: str | None = None, model: str | None = None) -> ContradictionResult:
        """
        The LLM decides if two claims contradict, support, or are unrelated.

        Cache behaviour:
        - In-memory _judgment_cache: hot path within one scan batch.
        - DB relationships table: durable store across restarts.
          Every new judgment is written through via upsert_relationship so the
          insight feed and hypothesis agent read real data.
        - use_cache=False: always calls LLM, never reads or writes either cache.
          Used by the eval harness to avoid polluting production data.
        """
        if use_cache:
            key = self._cache_key(pair.claim_a.text, pair.claim_b.text)
            if key in self._judgment_cache:
                return self._judgment_cache[key]

            # Also check the DB before calling the LLM
            db_hit = self.db.get_relationship(pair.claim_a.id, pair.claim_b.id)
            if db_hit:
                result = ContradictionResult(
                    id=db_hit.id,
                    claim_a=pair.claim_a,
                    claim_b=pair.claim_b,
                    relationship=db_hit.relationship,
                    category=db_hit.category or "findings",
                    explanation=db_hit.explanation or "",
                    stronger_evidence=db_hit.stronger_evidence or "neither",
                    resolution=db_hit.resolution or "",
                    similarity=pair.similarity,
                    retrieval_source=pair.retrieval_source,
                    created_at=db_hit.created_at,
                )
                self._judgment_cache[key] = result
                return result

        # ── LLM call ─────────────────────────────────────────
        try:
            response = self._anthropic(api_key).messages.create(
                model=(model or settings.anthropic_model),
                max_tokens=1024,
                messages=[{
                    "role": "user",
                    "content": (
                        "You are analyzing two claims from different research papers.\n\n"
                        f"Paper A: {pair.claim_a.paper_title}\n"
                        f"Claim A: {pair.claim_a.text}\n\n"
                        f"Paper B: {pair.claim_b.paper_title}\n"
                        f"Claim B: {pair.claim_b.text}\n\n"
                        "DECISION GUIDE:\n"
                        "- contradiction: the claims make incompatible assertions — if both are true, "
                        "one must be wrong, or they predict opposite outcomes under the same conditions.\n"
                        "- nuance: they partially agree but differ in scope, population, method, or "
                        "conditions. Neither is wrong — the difference reveals a boundary condition.\n"
                        "- support: they make compatible, mutually reinforcing assertions about the same phenomenon.\n"
                        "- unrelated: they address different phenomena and comparison adds no insight.\n\n"
                        "HARD RULES FOR THE EXPLANATION FIELD:\n"
                        "1. Name the specific point of agreement or conflict — not just the topic area.\n"
                        "2. Reference the actual measurements, methods, or conditions from each claim.\n"
                        "3. Do NOT write a general description of what the papers are about.\n"
                        "4. Do NOT use 'Claim A' or 'Claim B' labels.\n"
                        f"5. Refer to papers by their names: {pair.claim_a.paper_title} and {pair.claim_b.paper_title}.\n\n"
                        "BAD explanation (topic description, not analysis):\n"
                        "Both papers demonstrate that automated systems can measure negotiation performance.\n\n"
                        "GOOD explanation (names the specific agreement/conflict):\n"
                        f"{pair.claim_a.paper_title} measures performance via error classification with GPT-4 "
                        f"(>=0.90 accuracy), while {pair.claim_b.paper_title} uses dialogue-annotation metrics "
                        "that predict actual outcomes. These are different measurement philosophies - "
                        "one defines error categories top-down, the other derives signal bottom-up from behavior - "
                        "making their accuracy figures non-comparable despite both claiming validity.\n\n"
                        "Return ONLY valid JSON with these fields:\n"
                        '- "relationship": "contradiction", "support", "nuance", or "unrelated"\n'
                        '- "category": "methodological", "findings", "theoretical", or "scope"\n'
                        '- "explanation": 2-3 sentences. Must name the specific point of difference, '
                        "not just the subject area. Must reference actual details from each claim.\n"
                        '- "stronger_evidence": "paper_a", "paper_b", or "neither"\n'
                        '- "resolution": one concrete sentence on what experiment or data would resolve this\n\n'
                        "No preamble, no markdown fences."
                    ),
                }],
            )

            raw = response.content[0].text.strip()
            if raw.startswith("```"):
                raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
                if raw.endswith("```"):
                    raw = raw[:-3]
                raw = raw.strip()

            parsed = json.loads(raw)

            VALID_RELATIONSHIPS = {"contradiction", "support", "nuance", "unrelated"}
            raw_rel = parsed.get("relationship", "unrelated")
            relationship = raw_rel if raw_rel in VALID_RELATIONSHIPS else "unrelated"

            result = ContradictionResult(
                id=str(uuid.uuid4()),
                claim_a=pair.claim_a,
                claim_b=pair.claim_b,
                relationship=relationship,
                category=parsed.get("category", "findings"),
                explanation=parsed.get("explanation", ""),
                stronger_evidence=parsed.get("stronger_evidence", "neither"),
                resolution=parsed.get("resolution", ""),
                similarity=pair.similarity,
                retrieval_source=pair.retrieval_source,
            )

        except Exception as e:
            print(f"Judgment failed: {e}")
            result = ContradictionResult(
                id=str(uuid.uuid4()),
                claim_a=pair.claim_a,
                claim_b=pair.claim_b,
                relationship="error",
                category="unknown",
                explanation=f"Analysis failed: {str(e)}",
                stronger_evidence="neither",
                resolution="",
                similarity=pair.similarity,
                retrieval_source=pair.retrieval_source,
            )

        # ── Write through to DB (skip errors and eval mode) ──
        if use_cache and result.relationship != "error":
            self.db.upsert_relationship(StoredRelationship(
                id=result.id,
                claim_lo=pair.claim_a.id,
                claim_hi=pair.claim_b.id,
                paper_a=pair.claim_a.paper_id,
                paper_b=pair.claim_b.paper_id,
                relationship=result.relationship,
                category=result.category,
                explanation=result.explanation,
                stronger_evidence=result.stronger_evidence,
                resolution=result.resolution,
                similarity=pair.similarity,
                created_at=result.created_at,
            ))
            self._judgment_cache[key] = result

        return result

    # ── Full pipeline ────────────────────────────────────────

    def run_contradiction_scan(
        self,
        paper_ids: list[str] | None = None,
        similarity_threshold: float = 0.6,
        max_pairs: int = 50,
        api_key: str | None = None,
        model: str | None = None,
    ) -> list[ContradictionResult]:
        """
        Run the full contradiction detection pipeline:
        1. Extract claims from all papers (DB-first, LLM on cache miss)
        2. Find similar claim pairs across papers (hybrid: dense + BM25)
        3. Judge each pair (DB-first, LLM on cache miss)
        4. Persist every new judgment to the relationships table

        Returns results sorted: contradictions → nuance → support → unrelated.
        """
        if paper_ids:
            papers = [self.db.get_paper(pid) for pid in paper_ids]
            papers = [p for p in papers if p is not None]
        else:
            papers = self.db.list_papers(limit=50)

        if len(papers) < 2:
            return []

        all_claims = []
        for paper in papers:
            claims = self.extract_claims(paper.id, api_key=api_key, model=model)
            all_claims.extend(claims)

        if len(all_claims) < 2:
            return []

        pairs = self.find_claim_pairs(all_claims, similarity_threshold)

        # Skip pairs already in the DB — incremental scanning: never recompute
        # relationships that exist, only evaluate truly new pairs.
        # This allows the graph to grow without redundant LLM calls.
        already_seen: set[tuple[str, str]] = set()
        new_pairs: list[ClaimPair] = []
        existing_pairs: list[ClaimPair] = []
        for pair in pairs:
            lo, hi = sorted([pair.claim_a.id, pair.claim_b.id])
            if (lo, hi) in already_seen:
                continue
            already_seen.add((lo, hi))
            if self.db.get_relationship(pair.claim_a.id, pair.claim_b.id) is not None:
                existing_pairs.append(pair)
            else:
                new_pairs.append(pair)

        # Evaluate new pairs up to max_pairs; existing ones are returned from DB.
        pairs_to_judge = new_pairs[:max_pairs]

        if not pairs_to_judge and not existing_pairs:
            return []

        # Judge new pairs via LLM
        new_results = []
        for pair in pairs_to_judge:
            result = self.judge_pair(pair, api_key=api_key, model=model)
            new_results.append(result)

        # Load existing pairs from DB cache (no LLM call)
        existing_results = []
        for pair in existing_pairs[:max_pairs]:
            result = self.judge_pair(pair, use_cache=True, api_key=api_key, model=model)
            existing_results.append(result)

        results = new_results + existing_results
        priority = {"contradiction": 0, "nuance": 1, "support": 2, "unrelated": 3, "error": 4}
        results.sort(key=lambda r: priority.get(r.relationship, 5))

        return results

    # ── Cluster detection ─────────────────────────────────────

    def detect_clusters(
        self,
        paper_ids: list[str] | None = None,
        user_id: str | None = None,
        api_key: str | None = None,
        model: str | None = None,
    ) -> list:
        """
        Find connected components in the claim-relationship graph and name each one.

        Algorithm:
          1. Load all non-unrelated relationships for these papers
          2. Build adjacency list: claim_id → list[StoredRelationship]
          3. BFS to find connected components (claim clusters)
          4. For each component ≥ 2 claims: ask LLM to name the cluster
          5. Persist to clusters table and return

        Returns a list of Cluster dataclass instances.
        """
        from db.database import Cluster
        from datetime import datetime, timezone

        rels = self.db.list_relationships(
            paper_ids=paper_ids,
            relationships=["contradiction", "nuance", "support"],
            strict=bool(paper_ids),
        )
        if not rels:
            return []

        # Build adjacency list
        adjacency: dict[str, list] = {}
        for rel in rels:
            for cid in (rel.claim_lo, rel.claim_hi):
                adjacency.setdefault(cid, [])
            adjacency[rel.claim_lo].append(rel)
            adjacency[rel.claim_hi].append(rel)

        # BFS to find connected components
        visited: set[str] = set()
        components: list[list[str]] = []
        for start in adjacency:
            if start in visited:
                continue
            component: list[str] = []
            queue = [start]
            while queue:
                node = queue.pop(0)
                if node in visited:
                    continue
                visited.add(node)
                component.append(node)
                for rel in adjacency.get(node, []):
                    other = rel.claim_hi if rel.claim_lo == node else rel.claim_lo
                    if other not in visited:
                        queue.append(other)
            if len(component) >= 2:
                components.append(component)

        if not components:
            return []

        # Load claim texts + paper info in batch
        paper_ids_needed = list({r.paper_a for r in rels} | {r.paper_b for r in rels})
        claims_by_paper = self.db.get_claims_for_papers(paper_ids_needed)
        claim_by_id = {}
        claim_paper_id: dict[str, str] = {}
        for pid, claims in claims_by_paper.items():
            for c in claims:
                claim_by_id[c.id] = c
                claim_paper_id[c.id] = pid

        # Build set of all relationship IDs for fast lookup
        rel_set: dict[tuple[str, str], str] = {
            (r.claim_lo, r.claim_hi): r.id for r in rels
        }

        clusters = []
        for comp in components:
            comp_set = set(comp)
            comp_rels = [
                r for r in rels
                if r.claim_lo in comp_set and r.claim_hi in comp_set
            ]
            contra_count = sum(1 for r in comp_rels if r.relationship == "contradiction")
            support_count = sum(1 for r in comp_rels if r.relationship == "support")
            nuance_count = sum(1 for r in comp_rels if r.relationship == "nuance")
            paper_ids_in = list({claim_paper_id[cid] for cid in comp if cid in claim_paper_id})

            claim_texts = [claim_by_id[cid].text for cid in comp if cid in claim_by_id]
            name, rq, desc = self._name_cluster(claim_texts, contra_count, api_key, model)

            clusters.append(Cluster(
                id=str(uuid.uuid4()),
                user_id=user_id,
                name=name,
                research_question=rq,
                description=desc,
                claim_ids=comp,
                relationship_ids=[r.id for r in comp_rels],
                contradiction_count=contra_count,
                support_count=support_count,
                nuance_count=nuance_count,
                paper_count=len(paper_ids_in),
                created_at=datetime.now(timezone.utc).isoformat(),
            ))

        if clusters and user_id:
            self.db.save_clusters(clusters)

        return clusters

    def _name_cluster(
        self,
        claim_texts: list[str],
        contradiction_count: int,
        api_key: str | None = None,
        model: str | None = None,
    ) -> tuple[str, str | None, str | None]:
        """Ask LLM to produce a short cluster name, research question, and description."""
        if not claim_texts:
            return "Research Cluster", None, None
        sample = claim_texts[:6]
        formatted = "\n".join(f"- {t}" for t in sample)
        try:
            response = self._anthropic(api_key).messages.create(
                model=(model or settings.anthropic_model),
                max_tokens=256,
                messages=[{
                    "role": "user",
                    "content": (
                        "These research claims are connected through support/contradiction/nuance "
                        "relationships and form a cluster around a shared scientific question.\n\n"
                        f"Claims:\n{formatted}\n\n"
                        "Return ONLY valid JSON with:\n"
                        '- "name": 4-7 word topic label (noun phrase, title case)\n'
                        '- "research_question": the specific question these claims address\n'
                        '- "description": one sentence summarizing this research debate\n\n'
                        "No preamble, no markdown fences."
                    ),
                }],
            )
            raw = response.content[0].text.strip()
            if raw.startswith("```"):
                raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
                if raw.endswith("```"):
                    raw = raw[:-3]
                raw = raw.strip()
            parsed = json.loads(raw)
            return (
                parsed.get("name", "Research Cluster"),
                parsed.get("research_question"),
                parsed.get("description"),
            )
        except Exception as e:
            print(f"Cluster naming failed: {e}")
            first = claim_texts[0][:50] if claim_texts else "Research"
            return f"Cluster: {first}…", None, None
