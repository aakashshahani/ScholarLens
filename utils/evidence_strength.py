"""
Evidence-strength scoring for claims.

A contradiction between two claims is not symmetric: a finding from a 600-person
randomized trial reporting an effect size and confidence interval carries more
weight than an unquantified assertion from a single case study. This module
turns the cues a claim already states — study design, sample size, effect size,
statistical detail — into a transparent 0..1 strength score plus the list of
signals that produced it, so the UI can show *why* one side outweighs the other
instead of asking the user to take an LLM's word for it.

Design notes:
  - Pure and deterministic: regex/keyword matching, no model call, no I/O. That
    makes it free to run on every claim and trivially unit-testable.
  - Explainable by construction: every point added is tied to a named signal
    returned in `signals`, so a score is auditable.
  - Inspired by the evidence-quality reranking that established research search
    engines use, but the scoring scheme here is its own — built around the
    fields ScholarLens extracts, not copied from any product.
"""

import re
from dataclasses import dataclass, field

# Study-design tiers, strongest first. The first pattern that matches wins, so
# more specific / stronger designs are listed above weaker ones.
_DESIGN_TIERS: list[tuple[str, float, str]] = [
    (r"meta[- ]analy|systematic review", 1.00, "meta-analysis / systematic review"),
    (r"randomi[sz]ed controlled|\bRCT\b|randomi[sz]ed.{0,20}trial", 0.90, "randomized controlled trial"),
    (r"\blongitudinal\b|\bcohort\b|prospective study", 0.70, "longitudinal / cohort design"),
    (r"\bquasi[- ]experiment|\bcontrolled (?:study|experiment)|within[- ]subjects?|between[- ]subjects?", 0.60, "controlled experiment"),
    (r"\bobservational\b|cross[- ]sectional|\bsurvey\b|correlational", 0.40, "observational / cross-sectional"),
    (r"case study|case report|anecdot|\bpilot\b|preliminary", 0.20, "case study / pilot"),
]

# Quantitative-evidence signals. Each contributes once; weights reflect how much
# each cue raises confidence that the claim is empirically grounded.
_QUANT_SIGNALS: list[tuple[str, float, str]] = [
    (r"\bp\s*[<=>]\s*0?\.\d+|\bp[- ]value", 0.18, "p-value"),
    (r"cohen'?s\s*d|effect size|odds ratio|\bOR\s*=|\bRR\s*=|hazard ratio|\bβ\s*=|\bbeta\s*=|\br\s*=\s*0?\.\d+", 0.20, "effect size"),
    (r"95%\s*(?:ci|confidence interval)|confidence interval|\bCI\b", 0.14, "confidence interval"),
    (r"\bn\s*=\s*\d|\bN\s*=\s*\d|\d+\s*(?:participants|subjects|respondents|patients|samples)", 0.20, "sample size"),
    (r"\d+(?:\.\d+)?\s*%", 0.10, "reported percentage"),
    (r"\bSD\b|standard deviation|standard error|\bSE\b|variance", 0.08, "dispersion reported"),
    (r"significan|statistically", 0.06, "significance stated"),
]

# Hedging language caps the score: a heavily qualified claim is, by its own
# admission, weakly supported.
_HEDGES = re.compile(
    r"\bmay\b|\bmight\b|\bcould\b|suggests?\b|\bappears?\b|\bpreliminary\b|"
    r"\bunclear\b|\blimited evidence\b|\bnot conclusive\b",
    re.IGNORECASE,
)


@dataclass
class EvidenceStrength:
    score: float                       # 0..1, higher = stronger support
    label: str                         # "strong" | "moderate" | "weak"
    design: str | None                 # named design tier, if detected
    signals: list[str] = field(default_factory=list)  # human-readable cues

    def as_dict(self) -> dict:
        return {
            "score": round(self.score, 3),
            "label": self.label,
            "design": self.design,
            "signals": self.signals,
        }


def _label(score: float) -> str:
    if score >= 0.66:
        return "strong"
    if score >= 0.33:
        return "moderate"
    return "weak"


def score_claim(text: str, *, evidence: str | None = None, conditions: str | None = None) -> EvidenceStrength:
    """Score how strongly a claim is empirically supported, from its own stated
    cues. `evidence` / `conditions` are the optional extracted fields; when
    present they are folded into the same text so quantitative detail recorded
    separately still counts."""
    blob = " ".join(p for p in (text, evidence, conditions) if p)
    if not blob.strip():
        return EvidenceStrength(score=0.0, label="weak", design=None, signals=[])

    signals: list[str] = []

    # Design tier — take the strongest match, contributing up to ~0.45.
    design_name: str | None = None
    design_score = 0.0
    for pattern, weight, name in _DESIGN_TIERS:
        if re.search(pattern, blob, re.IGNORECASE):
            design_name = name
            design_score = weight * 0.45
            signals.append(name)
            break

    # Quantitative signals — additive, each counted once.
    quant_score = 0.0
    for pattern, weight, name in _QUANT_SIGNALS:
        if re.search(pattern, blob, re.IGNORECASE):
            quant_score += weight
            signals.append(name)

    raw = design_score + quant_score
    score = max(0.0, min(1.0, raw))

    # Hedging penalty: cap an otherwise-confident score for qualified language.
    if _HEDGES.search(blob):
        score = min(score, 0.6)
        signals.append("hedged language")

    return EvidenceStrength(score=score, label=_label(score), design=design_name, signals=signals)


def evidence_gap(a: EvidenceStrength, b: EvidenceStrength) -> dict:
    """Compare two claims' strength. Returns the signed gap and which side is
    better supported — a computed second opinion alongside the LLM's
    `stronger_evidence` verdict."""
    diff = round(a.score - b.score, 3)
    if abs(diff) < 0.1:
        stronger = "neither"
    else:
        stronger = "claim_a" if diff > 0 else "claim_b"
    return {"gap": diff, "stronger": stronger}


if __name__ == "__main__":
    # Self-check: stronger designs / more quantitative detail must score higher.
    strong = score_claim(
        "A randomized controlled trial (N=312) found a large effect (Cohen's d=0.8, "
        "p<0.001, 95% CI [0.6, 1.0]) of AI coaching on negotiation surplus."
    )
    weak = score_claim(
        "A case study suggests AI coaching may improve negotiation outcomes."
    )
    print("strong:", strong.as_dict())
    print("weak:  ", weak.as_dict())
    print("gap:   ", evidence_gap(strong, weak))
    assert strong.score > weak.score, "stronger evidence must outscore weaker"
    assert strong.label == "strong" and weak.label == "weak"
    assert evidence_gap(strong, weak)["stronger"] == "claim_a"
    print("evidence_strength self-check OK")
