"""
Hypothesis Generator Agent

Given a research question or the full library, generates specific testable
hypotheses grounded in existing literature.

Session changes:
  1a. REAL PROVENANCE — the agent now reads persisted ContradictionResult
      data (relationships + claims tables) as its primary input instead of
      dumping raw paper text into one prompt. The model is handed pre-identified
      conflict IDs and told to cite them; cited IDs are validated against the
      actual set passed in — confabulated IDs are dropped before returning.
      When no conflicts exist, falls back to research_gaps analyses and labels
      grounding honestly as "single_paper_gaps".

  1b. OUTPUT CACHE — results are stored in the hypothesis_cache table, keyed
      on (sorted paper IDs + relationships watermark + question hash). Cache is
      read on every call and written on every successful generation. Pass
      force_refresh=True to bypass the cache.

  2.  NOVELTY VIA COSINE DISTANCE — after generation, each hypothesis statement
      is embedded and compared against the nearest library chunk. novelty_score
      is the cosine distance (higher = more novel relative to corpus). A tier
      label (high / medium / low) replaces the LLM self-assessment. The model
      is no longer asked to rate its own novelty.

      IMPACT REMOVED — was LLM-generated with no ground truth. citation_count
      is not persisted in the DB so there is no defensible signal. Removed
      from prompt, dataclass, and API response. Noted in README as future work.
"""

import hashlib
import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone

from anthropic import Anthropic

from config import settings
from db import Database, StoredRelationship, StoredClaim
from utils import VectorStore


# ── Novelty thresholds ───────────────────────────────────────
# Cosine distance in [0, 1] where higher = more different from corpus.
# Tuned for voyage-3.5-lite on narrow-domain academic text.
# Voyage embeddings cluster tighter than MiniLM — similar academic content
# lands in the 0.10–0.45 range rather than MiniLM's wider spread.
# Recalibrate after regenerating hypotheses if the distribution shifts.
NOVELTY_HIGH = 0.30    # distance > 0.30 → explores genuinely new territory
NOVELTY_LOW  = 0.12    # distance < 0.12 → very close to existing library coverage
# 0.12–0.30 → medium


@dataclass
class Hypothesis:
    """A generated research hypothesis with supporting context."""
    id: str
    statement: str
    rationale: str
    source_conflicts: list[str]     # validated relationship IDs from the DB
    supporting_papers: list[dict]   # [{paper_id, title, relevant_finding}]
    methodology: str
    challenges: list[str]
    novelty_score: float            # cosine distance from nearest library chunk
    novelty_tier: str               # "high", "medium", "low"
    grounding: str                  # "detected_conflicts" | "single_paper_gaps"
    research_question: str
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "statement": self.statement,
            "rationale": self.rationale,
            "source_conflicts": self.source_conflicts,
            "supporting_papers": self.supporting_papers,
            "methodology": self.methodology,
            "challenges": self.challenges,
            "novelty_score": self.novelty_score,
            "novelty_tier": self.novelty_tier,
            "grounding": self.grounding,
            "research_question": self.research_question,
            "created_at": self.created_at,
        }

    @staticmethod
    def from_dict(d: dict) -> "Hypothesis":
        return Hypothesis(**{k: d[k] for k in Hypothesis.__dataclass_fields__})


class HypothesisAgent:
    def __init__(self):
        self.client = Anthropic()
        self.db = Database()
        self.vector_store = VectorStore()

    # ── Cache key ────────────────────────────────────────────

    def _cache_key(
        self,
        paper_ids: list[str] | None,
        research_question: str | None,
    ) -> str:
        """
        Deterministic cache key from three inputs:
          - sorted paper IDs in scope (or all library paper IDs)
          - relationships watermark: max created_at over scoped relationships
            — changes when a new contradiction scan runs, which invalidates
            hypotheses that were grounded in the old conflict set
          - normalized question hash

        Changing any of these three things means the cached result is stale.
        """
        scoped_ids = sorted(paper_ids) if paper_ids else []

        watermark = self.db.relationships_watermark(
            paper_ids=paper_ids  # None → all papers
        )
        question_hash = hashlib.sha256(
            (research_question or "").strip().lower().encode()
        ).hexdigest()[:8]

        raw = f"{'|'.join(scoped_ids)}||{watermark}||{question_hash}"
        return hashlib.sha256(raw.encode()).hexdigest()[:24]

    # ── Conflict context (primary grounding input) ───────────

    def _gather_conflict_context(
        self,
        paper_ids: list[str] | None,
    ) -> tuple[str, list[str], str]:
        """
        Build a structured conflict block from persisted relationships.

        Returns:
            context_text  — formatted string fed into the prompt
            conflict_ids  — list of relationship IDs handed to the model
            grounding     — "detected_conflicts" or "single_paper_gaps"

        Only contradiction and nuance relationships are included — these are
        the gaps between papers that good hypotheses come from. Support and
        unrelated relationships are not useful grounding material here.
        """
        conflicts = self.db.list_relationships(
            paper_ids=paper_ids,
            relationships=["contradiction", "nuance"],
        )

        if conflicts:
            # Load claim texts for each relationship so the model sees
            # actual claim content, not just abstract IDs
            claim_cache: dict[str, StoredClaim | None] = {}

            def _get_claim(claim_id: str) -> StoredClaim | None:
                if claim_id not in claim_cache:
                    # StoredClaim doesn't have a get-by-id method; we look it up
                    # via paper_id stored on the relationship
                    claim_cache[claim_id] = None  # default miss
                    for rel in conflicts:
                        for cid, pid in [
                            (rel.claim_lo, rel.paper_a),
                            (rel.claim_hi, rel.paper_b),
                        ]:
                            if cid == claim_id:
                                claims = self.db.get_claims_for_paper(pid)
                                for c in claims:
                                    claim_cache[c.id] = c
                                break
                return claim_cache.get(claim_id)

            # Pre-populate claim cache to avoid N+1 DB calls
            paper_ids_needed = list({r.paper_a for r in conflicts} | {r.paper_b for r in conflicts})
            for pid in paper_ids_needed:
                for c in self.db.get_claims_for_paper(pid):
                    claim_cache[c.id] = c

            # Also build paper title lookup
            paper_titles: dict[str, str] = {}
            for pid in paper_ids_needed:
                p = self.db.get_paper(pid)
                if p:
                    paper_titles[pid] = p.title

            parts = []
            conflict_ids = []
            # label_to_real maps the short label the model sees → real DB ID
            # This prevents UUIDs from leaking into model-generated prose.
            label_to_real: dict[str, str] = {}

            for idx, rel in enumerate(conflicts):
                label = f"CONFLICT_{idx + 1}"
                claim_lo = claim_cache.get(rel.claim_lo)
                claim_hi = claim_cache.get(rel.claim_hi)
                title_a = paper_titles.get(rel.paper_a, "Unknown paper")
                title_b = paper_titles.get(rel.paper_b, "Unknown paper")

                block = (
                    f"[{label}]\n"
                    f"  Type: {rel.relationship} ({rel.category or 'unknown'})\n"
                    f"  Paper A: \"{title_a}\"\n"
                    f"  Claim A: \"{claim_lo.text if claim_lo else '(claim text unavailable)'}\"\n"
                    f"  Paper B: \"{title_b}\"\n"
                    f"  Claim B: \"{claim_hi.text if claim_hi else '(claim text unavailable)'}\"\n"
                    f"  Explanation: {rel.explanation or '(none)'}\n"
                    f"  Resolution path: {rel.resolution or '(none)'}\n"
                )
                parts.append(block)
                label_to_real[label] = rel.id
                conflict_ids.append(rel.id)

            return "\n\n".join(parts), conflict_ids, "detected_conflicts", label_to_real

        # ── Fallback: use research_gaps from stored analyses ──
        if paper_ids:
            papers = [self.db.get_paper(pid) for pid in paper_ids]
            papers = [p for p in papers if p is not None]
        else:
            papers = self.db.list_papers(limit=50)

        gap_parts = []
        for paper in papers:
            analyses = self.db.get_analyses_for_paper(paper.id)
            for a in analyses:
                if a.analysis_type in ("research_gaps", "findings", "key_claims"):
                    gap_parts.append(
                        f"## {paper.title}\n"
                        f"### {a.analysis_type.replace('_', ' ').title()}\n"
                        f"{a.content}\n"
                    )
                    break  # one section per paper is enough for the fallback

        return "\n\n---\n\n".join(gap_parts), [], "single_paper_gaps", {}

    # ── Novelty scoring ──────────────────────────────────────

    def _score_novelty(self, statement: str) -> tuple[float, str]:
        """
        Compute novelty as cosine distance between the hypothesis statement
        and the nearest chunk in the library.

        Higher distance = more novel relative to the current corpus.
        Returns (score, tier) where tier is "high" / "medium" / "low".

        This replaces the LLM self-assessment, which had no ground truth.
        The score is corpus-relative and honest: it answers "how different
        is this statement from anything already in your library?"
        """
        try:
            results = self.vector_store.search(statement, n_results=3)
            if not results:
                # Nothing in the library to compare against — can't score
                return 0.0, "unknown"
            # VectorStore returns cosine distance (lower = more similar)
            # Take the minimum distance (nearest neighbour)
            min_distance = min(r.score for r in results)
            score = round(min_distance, 4)
            if score > NOVELTY_HIGH:
                tier = "high"
            elif score < NOVELTY_LOW:
                tier = "low"
            else:
                tier = "medium"
            return score, tier
        except Exception as e:
            print(f"Novelty scoring failed for statement: {e}")
            return 0.0, "unknown"

    # ── Paper map helper ─────────────────────────────────────

    def _build_paper_map(self, paper_ids: list[str] | None) -> dict[str, str]:
        """Return {title: paper_id} with both exact and lowercase-normalized keys
        so LLM-generated titles that differ in case/whitespace still resolve."""
        if paper_ids:
            id_to_title = self.db.get_paper_titles(paper_ids)
        else:
            id_to_title = self.db.paper_title_map()
        result = {}
        for pid, title in id_to_title.items():
            result[title.lower().strip()] = pid  # normalized (lower priority)
            result[title] = pid                  # exact (wins on collision)
        return result

    # ── Main entry point ─────────────────────────────────────

    def _anthropic(self, api_key: str | None = None):
        """Per-request Anthropic client: the caller's BYOK key when provided,
        else the shared server client. Built per call, never stored on self,
        so it is safe under concurrent (threadpool) use."""
        return Anthropic(api_key=api_key) if api_key else self.client

    def generate(
        self,
        research_question: str | None = None,
        paper_ids: list[str] | None = None,
        num_hypotheses: int = 5,
        force_refresh: bool = False,
        api_key: str | None = None,
        model: str | None = None,
        user_id: str | None = None,
    ) -> list[Hypothesis]:
        """
        Generate testable hypotheses from the library.

        Cache behaviour:
          - Computes a cache key from (paper scope, relationships watermark,
            question hash). Returns cached result when key matches unless
            force_refresh=True.
          - Cache auto-invalidates when a new contradiction scan runs (the
            watermark changes), so hypotheses always reflect the latest
            conflict data.

        Grounding:
          - Primary: detected contradictions/nuances from the relationships
            table. The model is given pre-identified conflict IDs and must
            cite them. Cited IDs are validated post-parse — fabricated IDs
            are dropped.
          - Fallback: research_gaps analyses when no conflicts exist yet.
            Output is labelled grounding="single_paper_gaps".

        Novelty:
          - Computed post-generation via cosine distance to nearest library
            chunk. The model is not asked to self-assess novelty.

        Impact: removed — no reliable signal available.
        """
        cache_key = self._cache_key(paper_ids, research_question)

        # ── Cache read ────────────────────────────────────────
        if not force_refresh:
            cached = self.db.get_hypothesis_cache(cache_key)
            if cached:
                try:
                    return [Hypothesis.from_dict(h) for h in cached["hypotheses"]]
                except Exception as e:
                    print(f"Hypothesis cache deserialisation failed: {e}")
                    # Fall through to regeneration

        # ── Gather grounding inputs ───────────────────────────
        context_text, conflict_ids, grounding, label_to_real = self._gather_conflict_context(paper_ids)
        if not context_text:
            return []

        paper_map = self._build_paper_map(paper_ids)

        # ── Build prompt ──────────────────────────────────────
        question_block = ""
        if research_question:
            question_block = (
                f"\nThe researcher's specific question: {research_question}\n"
                f"Focus hypotheses on this question, grounded in the conflicts above.\n"
            )
        else:
            question_block = (
                "\nNo specific question given. Identify the most promising "
                "research directions from the conflicts and gaps above.\n"
            )

        if grounding == "detected_conflicts":
            grounding_instruction = (
                "You are given DETECTED CONFLICTS between claims in a research library. "
                "Each conflict has a short label like [CONFLICT_1], [CONFLICT_2], etc. "
                "Generate hypotheses that explain, resolve, or exploit these tensions. "
                "For each hypothesis, include a 'source_conflict_ids' field listing the "
                "conflict labels (e.g. ['CONFLICT_1', 'CONFLICT_3']) that the hypothesis "
                "draws from. Only cite labels that appear in the conflict list — do not "
                "invent labels. Do NOT reference conflict labels in your rationale prose — "
                "refer to the papers and claims by their actual titles and content instead.\n\n"
                "DETECTED CONFLICTS:\n\n"
            )
        else:
            grounding_instruction = (
                "No cross-paper conflicts have been detected yet (run a contradiction scan "
                "to enable conflict-grounded hypotheses). Using single-paper research gaps "
                "as the grounding input instead.\n\n"
                "RESEARCH GAPS FROM LIBRARY:\n\n"
            )

        try:
            response = self._anthropic(api_key).messages.create(
                model=(model or settings.anthropic_model),
                max_tokens=4096,
                messages=[{
                    "role": "user",
                    "content": (
                        "You are a research hypothesis generator.\n\n"
                        + grounding_instruction
                        + context_text
                        + question_block
                        + f"\nGenerate exactly {num_hypotheses} hypotheses.\n\n"
                        "Return ONLY valid JSON: a list of objects with these fields:\n"
                        '- "statement": the hypothesis in one clear sentence\n'
                        '- "rationale": 2-3 sentences explaining why this hypothesis is '
                        "worth testing, referencing specific papers or conflicts\n"
                        '- "source_conflict_ids": list of conflict ID strings this '
                        "hypothesis draws from (empty list if grounding is single_paper_gaps)\n"
                        '- "supporting_papers": list of {"title": "paper title", '
                        '"relevant_finding": "what from this paper supports the hypothesis"}\n'
                        '- "methodology": 2-3 sentences describing how to test this\n'
                        '- "challenges": list of 2-3 predicted obstacles\n\n'
                        "No preamble, no markdown fences, no text outside the JSON.\n"
                        "Do NOT include novelty or impact fields — those are computed separately."
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

        except Exception as e:
            print(f"Hypothesis generation failed: {e}")
            return []

        # ── Post-parse: validate, score, assemble ─────────────
        valid_conflict_ids = set(conflict_ids)
        rq = research_question or "Generated from library analysis"

        # Batch-embed all hypothesis statements in one Voyage call instead of
        # one call per hypothesis inside _score_novelty.
        statements = [item.get("statement", "") for item in parsed]
        novelty_embeddings: list[list[float] | None] = [None] * len(statements)
        try:
            if statements and any(statements):
                embeddings = self.vector_store.embed_texts(statements)
                novelty_embeddings = embeddings  # type: ignore[assignment]
        except Exception as e:
            print(f"Batch novelty embedding failed (will fall back per-item): {e}")

        hypotheses = []
        for idx, item in enumerate(parsed):
            # Validate cited conflict labels — convert CONFLICT_N → real UUID,
            # drop any the model fabricated or that don't map to real IDs
            cited = []
            for ref in item.get("source_conflict_ids", []):
                # Model may cite as "CONFLICT_1" or just "1" — normalise
                label = ref if ref.startswith("CONFLICT_") else f"CONFLICT_{ref}"
                real_id = label_to_real.get(label)
                if real_id and real_id in valid_conflict_ids:
                    cited.append(real_id)

            # Map paper titles to IDs — try exact then lowercase-normalized
            supporting = []
            for sp in item.get("supporting_papers", []):
                title = sp.get("title", "")
                pid = paper_map.get(title) or paper_map.get(title.lower().strip(), "")
                supporting.append({
                    "paper_id": pid,
                    "title": title,
                    "relevant_finding": sp.get("relevant_finding", ""),
                })

            # Score novelty using pre-computed embedding when available
            statement = statements[idx]
            emb = novelty_embeddings[idx] if idx < len(novelty_embeddings) else None
            if emb is not None:
                try:
                    results = self.vector_store.search_by_embedding(emb, n_results=3)
                    if results:
                        min_distance = min(r.score for r in results)
                        score = round(min_distance, 4)
                        if score > NOVELTY_HIGH:
                            tier = "high"
                        elif score < NOVELTY_LOW:
                            tier = "low"
                        else:
                            tier = "medium"
                        novelty_score, novelty_tier = score, tier
                    else:
                        novelty_score, novelty_tier = 0.0, "unknown"
                except Exception:
                    novelty_score, novelty_tier = self._score_novelty(statement)
            else:
                novelty_score, novelty_tier = self._score_novelty(statement)

            hypotheses.append(Hypothesis(
                id=str(uuid.uuid4()),
                statement=statement,
                rationale=item.get("rationale", ""),
                source_conflicts=cited,
                supporting_papers=supporting,
                methodology=item.get("methodology", ""),
                challenges=item.get("challenges", []),
                novelty_score=novelty_score,
                novelty_tier=novelty_tier,
                grounding=grounding,
                research_question=rq,
            ))

        # ── Cache write ───────────────────────────────────────
        if hypotheses:
            try:
                self.db.set_hypothesis_cache(
                    cache_key,
                    [h.to_dict() for h in hypotheses],
                    grounding,
                    user_id=user_id,
                )
            except Exception as e:
                print(f"Hypothesis cache write failed (non-fatal): {e}")

        return hypotheses
