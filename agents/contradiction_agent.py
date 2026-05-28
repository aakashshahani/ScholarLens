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
    similarity: float = 0.0  # cosine similarity from Stage 1 (carried through for display)
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

    def extract_claims(self, paper_id: str) -> list[Claim]:
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

        # ── Cache miss: extract via LLM, then persist ───────────
        analyses = self.db.get_analyses_for_paper(paper_id)
        if not analyses:
            return []

        claim_sources = []
        for a in analyses:
            if a.analysis_type in ("key_claims", "findings", "summary"):
                claim_sources.append((a.analysis_type, a.content))

        if not claim_sources:
            return []

        source_text = "\n\n".join(
            f"[{atype}]\n{content}" for atype, content in claim_sources
        )

        try:
            response = self.client.messages.create(
                model=settings.anthropic_model,
                max_tokens=2048,
                messages=[{
                    "role": "user",
                    "content": (
                        "Extract specific, testable claims from this paper analysis. "
                        "Each claim should be a single factual assertion the paper makes. "
                        "Return ONLY valid JSON: a list of objects with fields: "
                        '"text" (the claim), "section" (where it came from: key_claims/findings/summary), '
                        '"confidence" (high/medium/low based on how strongly the paper states it).\n\n'
                        "Return 5-10 of the most important claims. No preamble, no markdown fences.\n\n"
                        f"Paper: {paper.title}\n\n{source_text}"
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

    # ── Stage 1b: Find similar claims across papers ──────────

    def find_claim_pairs(
        self,
        all_claims: list[Claim],
        similarity_threshold: float = 0.6,
    ) -> list[ClaimPair]:
        """
        Compare claims across papers using vector similarity.
        Only pairs from DIFFERENT papers are returned.
        """
        if len(all_claims) < 2:
            return []

        texts = [c.text for c in all_claims]
        embeddings = self.vector_store.embed_texts(texts)

        pairs = []
        for i in range(len(all_claims)):
            for j in range(i + 1, len(all_claims)):
                if all_claims[i].paper_id == all_claims[j].paper_id:
                    continue

                sim = self._cosine_similarity(embeddings[i], embeddings[j])

                if sim >= similarity_threshold:
                    pairs.append(ClaimPair(
                        claim_a=all_claims[i],
                        claim_b=all_claims[j],
                        similarity=sim,
                    ))

        pairs.sort(key=lambda p: p.similarity, reverse=True)
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

    def judge_pair(self, pair: ClaimPair, use_cache: bool = True) -> ContradictionResult:
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
                    created_at=db_hit.created_at,
                )
                self._judgment_cache[key] = result
                return result

        # ── LLM call ─────────────────────────────────────────
        try:
            response = self.client.messages.create(
                model=settings.anthropic_model,
                max_tokens=1024,
                messages=[{
                    "role": "user",
                    "content": (
                        "You are analyzing two claims from different research papers. "
                        "Determine their relationship.\n\n"
                        f'Paper A: "{pair.claim_a.paper_title}"\n'
                        f'Claim A: "{pair.claim_a.text}"\n\n'
                        f'Paper B: "{pair.claim_b.paper_title}"\n'
                        f'Claim B: "{pair.claim_b.text}"\n\n'
                        "Return ONLY valid JSON with these fields:\n"
                        '- "relationship": one of "contradiction", "support", "nuance", "unrelated"\n'
                        '  (use "nuance" when claims partially agree but differ in scope or conditions)\n'
                        '- "category": one of "methodological", "findings", "theoretical", "scope"\n'
                        '- "explanation": 2-3 sentences explaining the relationship\n'
                        '- "stronger_evidence": "paper_a", "paper_b", or "neither"\n'
                        '- "resolution": one sentence on how future research could resolve this\n\n'
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

            result = ContradictionResult(
                id=str(uuid.uuid4()),
                claim_a=pair.claim_a,
                claim_b=pair.claim_b,
                relationship=parsed.get("relationship", "unrelated"),
                category=parsed.get("category", "findings"),
                explanation=parsed.get("explanation", ""),
                stronger_evidence=parsed.get("stronger_evidence", "neither"),
                resolution=parsed.get("resolution", ""),
                similarity=pair.similarity,
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
        max_pairs: int = 20,
    ) -> list[ContradictionResult]:
        """
        Run the full contradiction detection pipeline:
        1. Extract claims from all papers (DB-first, LLM on cache miss)
        2. Find similar claim pairs across papers
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
            claims = self.extract_claims(paper.id)
            all_claims.extend(claims)

        if len(all_claims) < 2:
            return []

        pairs = self.find_claim_pairs(all_claims, similarity_threshold)
        pairs = pairs[:max_pairs]

        if not pairs:
            return []

        results = []
        for pair in pairs:
            result = self.judge_pair(pair)
            results.append(result)

        priority = {"contradiction": 0, "nuance": 1, "support": 2, "unrelated": 3, "error": 4}
        results.sort(key=lambda r: priority.get(r.relationship, 5))

        return results
