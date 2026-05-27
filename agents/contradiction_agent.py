"""
Contradiction Detection Agent

Two-stage pattern used in production RAG systems:
  Stage 1: Vector similarity finds claims about the SAME topic across papers
  Stage 2: LLM judges whether those claims contradict, support, or are unrelated

This is the most technically interesting feature in ScholarLens and the one
most likely to generate conversation in an interview.

TASK 2 changes:
  - Claim dataclass gains an evidence field
  - extract_claims() is now a pure cache read — no LLM call inside it.
    Falls back to calling extract_grounded_claims() if nothing is cached.
  - judge_pair() prompt includes evidence when present so stronger_evidence
    is based on actual methodology, not guessed from claim text.
"""

import hashlib
import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone

from anthropic import Anthropic

from config import settings
from db import Database, Paper, AnalysisResult
from utils import VectorStore


@dataclass
class Claim:
    """A single extractable claim from a paper."""
    id: str
    paper_id: str
    paper_title: str
    text: str
    section: str        # which section it came from
    confidence: str     # "high", "medium", "low"
    evidence: str | None = None  # TASK 2: empirical support from source text


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
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class ContradictionAgent:
    def __init__(self):
        self.client = Anthropic()
        self.db = Database()
        self.vector_store = VectorStore()
        self._judgment_cache: dict[str, ContradictionResult] = {}

    @staticmethod
    def _cache_key(claim_a_text: str, claim_b_text: str) -> str:
        texts = sorted([claim_a_text.strip(), claim_b_text.strip()])
        combined = f"{texts[0]}|||{texts[1]}"
        return hashlib.sha256(combined.encode()).hexdigest()[:16]

    # ── Stage 1: Retrieve claims from cache ──────────────────

    def extract_claims(self, paper_id: str) -> list[Claim]:
        """
        Return claims for a paper. Pure cache read — no LLM call here.

        Priority:
          1. Grounded claims (evidence IS NOT NULL) — extracted from source text
          2. Legacy ungrounded claims (evidence IS NULL) — extracted from summaries
          3. Nothing cached → trigger extract_grounded_claims() now

        This replaces the old path that called the LLM inside extract_claims
        to pull claims out of stored summaries (the telephone-game problem).
        """
        paper = self.db.get_paper(paper_id)
        if not paper:
            return []

        stored = self.db.get_claims_for_paper(paper_id)

        # Prefer grounded claims
        grounded = [c for c in stored if c.evidence is not None]
        source = grounded if grounded else stored

        if source:
            return [
                Claim(
                    id=sc.id,
                    paper_id=sc.paper_id,
                    paper_title=paper.title,
                    text=sc.text,
                    section=sc.section or "unknown",
                    confidence=sc.confidence or "medium",
                    evidence=sc.evidence,
                )
                for sc in source
            ]

        # Nothing cached — trigger grounded extraction
        try:
            from agents.pdf_analyst import PDFAnalysisAgent
            new_claims = PDFAnalysisAgent().extract_grounded_claims(paper_id)
            return [
                Claim(
                    id=sc.id,
                    paper_id=sc.paper_id,
                    paper_title=paper.title,
                    text=sc.text,
                    section=sc.section or "unknown",
                    confidence=sc.confidence or "medium",
                    evidence=sc.evidence,
                )
                for sc in new_claims
            ]
        except Exception as e:
            print(f"[extract_claims] grounded extraction fallback failed for {paper_id}: {e}")
            return []

    # ── Stage 1b: Find similar claims across papers ───────────

    def find_claim_pairs(
        self,
        all_claims: list[Claim],
        similarity_threshold: float = 0.6,
    ) -> list[ClaimPair]:
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

        TASK 2 upgrade: when evidence is present on a claim it is included
        in the prompt so stronger_evidence is based on actual methodology
        (n, design, p-value) rather than guessed from claim text alone.
        Legacy claims (evidence=None) are flagged so the model doesn't
        fabricate methodology details.
        """
        if use_cache:
            key = self._cache_key(pair.claim_a.text, pair.claim_b.text)
            if key in self._judgment_cache:
                return self._judgment_cache[key]

        # Build claim blocks — include evidence when present
        def _claim_block(label: str, claim: Claim) -> str:
            lines = [
                f"{label} (paper: \"{claim.paper_title}\")",
                f"  Claim: {claim.text}",
            ]
            if claim.evidence:
                lines.append(f"  Evidence: {claim.evidence}")
            else:
                lines.append(
                    "  Evidence: not available (legacy claim — set stronger_evidence "
                    "to \"neither\" unless one claim is clearly better supported)"
                )
            return "\n".join(lines)

        both_grounded = pair.claim_a.evidence is not None and pair.claim_b.evidence is not None
        evidence_instruction = (
            "Both claims include empirical evidence. Use the evidence fields to "
            "determine stronger_evidence — do not guess from claim text alone."
            if both_grounded else
            "One or both claims lack empirical evidence. Set stronger_evidence to "
            "\"neither\" unless the available evidence clearly favours one side."
        )

        try:
            response = self.client.messages.create(
                model=settings.anthropic_model,
                max_tokens=1024,
                messages=[{
                    "role": "user",
                    "content": (
                        "You are analyzing two claims from different research papers "
                        "to determine their relationship.\n\n"
                        f"{_claim_block('Claim A', pair.claim_a)}\n\n"
                        f"{_claim_block('Claim B', pair.claim_b)}\n\n"
                        f"{evidence_instruction}\n\n"
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
            )

        if use_cache:
            self._judgment_cache[key] = result

        return result

    # ── Full pipeline ────────────────────────────────────────

    def run_contradiction_scan(
        self,
        paper_ids: list[str] | None = None,
        similarity_threshold: float = 0.6,
        max_pairs: int = 20,
    ) -> list[ContradictionResult]:
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
