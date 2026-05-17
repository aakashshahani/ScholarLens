"""
Hypothesis Generator Agent

Given a research question or the full library, generates specific testable
hypotheses grounded in existing literature. Each hypothesis includes:
- The hypothesis statement
- Supporting evidence from papers in the library
- Suggested methodology to test it
- Predicted challenges
- Novelty assessment relative to existing work

The key insight: good hypotheses come from GAPS BETWEEN papers, not from
any single paper. This agent looks for what the combination of papers
suggests but no individual paper proposes.
"""

import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone

from anthropic import Anthropic

from config import settings
from db import Database


@dataclass
class Hypothesis:
    """A generated research hypothesis with supporting context."""
    id: str
    statement: str
    rationale: str
    supporting_papers: list[dict]   # [{paper_id, title, relevant_finding}]
    methodology: str
    challenges: list[str]
    novelty: str                    # "high", "medium", "low"
    novelty_explanation: str
    impact: str                     # "high", "medium", "low"
    research_question: str          # the question that prompted this
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class HypothesisAgent:
    def __init__(self):
        self.client = Anthropic()
        self.db = Database()

    def _gather_library_context(self, paper_ids: list[str] | None = None) -> str:
        """
        Pull findings, research gaps, and key claims from papers.
        This is what the hypothesis generator reasons over.
        """
        if paper_ids:
            papers = [self.db.get_paper(pid) for pid in paper_ids]
            papers = [p for p in papers if p is not None]
        else:
            papers = self.db.list_papers(limit=50)

        if not papers:
            return ""

        context_parts = []
        for paper in papers:
            analyses = self.db.get_analyses_for_paper(paper.id)
            paper_context = f"## {paper.title}\n"
            if paper.authors:
                paper_context += f"Authors: {', '.join(paper.authors[:4])}\n"
            if paper.year:
                paper_context += f"Year: {paper.year}\n"

            for a in analyses:
                if a.analysis_type in ("findings", "research_gaps", "key_claims", "summary", "limitations"):
                    paper_context += f"\n### {a.analysis_type.replace('_', ' ').title()}\n{a.content}\n"

            context_parts.append(paper_context)

        return "\n\n---\n\n".join(context_parts)

    def generate(
        self,
        research_question: str | None = None,
        paper_ids: list[str] | None = None,
        num_hypotheses: int = 5,
    ) -> list[Hypothesis]:
        """
        Generate testable hypotheses from the library.

        If a research question is provided, hypotheses focus on that question.
        If not, the agent identifies the most promising research directions
        from gaps and patterns across all papers.
        """
        context = self._gather_library_context(paper_ids)
        if not context:
            return []

        # Build paper ID/title mapping for the response
        if paper_ids:
            papers = [self.db.get_paper(pid) for pid in paper_ids]
        else:
            papers = self.db.list_papers(limit=50)
        papers = [p for p in papers if p is not None]
        paper_map = {p.title: p.id for p in papers}

        question_prompt = ""
        if research_question:
            question_prompt = (
                f"\nThe researcher is specifically interested in: {research_question}\n"
                f"Focus hypotheses around this question, but ground them in the papers.\n"
            )
        else:
            question_prompt = (
                "\nNo specific question was given. Identify the most promising "
                "research directions based on gaps, contradictions, and unexplored "
                "combinations across these papers.\n"
            )

        try:
            response = self.client.messages.create(
                model=settings.anthropic_model,
                max_tokens=4096,
                messages=[{
                    "role": "user",
                    "content": (
                        "You are a research hypothesis generator. Given the following papers "
                        "from a research library, generate specific, testable hypotheses.\n\n"
                        "Good hypotheses come from GAPS BETWEEN papers, not from restating "
                        "what any single paper already found. Look for:\n"
                        "- Contradictions that suggest a moderating variable\n"
                        "- Methods from one paper that could be applied to another's question\n"
                        "- Findings that combine in unexpected ways\n"
                        "- Limitations in one paper that another paper's approach could address\n"
                        f"{question_prompt}\n"
                        f"Generate exactly {num_hypotheses} hypotheses.\n\n"
                        "Return ONLY valid JSON: a list of objects with these fields:\n"
                        '- "statement": the hypothesis in one clear sentence\n'
                        '- "rationale": 2-3 sentences explaining why this hypothesis is worth testing, referencing specific papers\n'
                        '- "supporting_papers": list of {"title": "paper title", "relevant_finding": "what from this paper supports the hypothesis"}\n'
                        '- "methodology": 2-3 sentences describing how to test this\n'
                        '- "challenges": list of 2-3 predicted obstacles\n'
                        '- "novelty": "high", "medium", or "low"\n'
                        '- "novelty_explanation": one sentence on why this novelty level\n'
                        '- "impact": "high", "medium", or "low"\n\n'
                        "No preamble, no markdown fences, no text outside the JSON.\n\n"
                        "PAPERS IN LIBRARY:\n\n"
                        f"{context}"
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

            hypotheses = []
            rq = research_question or "Generated from library analysis"

            for item in parsed:
                # Map paper titles to IDs
                supporting = []
                for sp in item.get("supporting_papers", []):
                    title = sp.get("title", "")
                    pid = paper_map.get(title, "")
                    supporting.append({
                        "paper_id": pid,
                        "title": title,
                        "relevant_finding": sp.get("relevant_finding", ""),
                    })

                hypotheses.append(Hypothesis(
                    id=str(uuid.uuid4()),
                    statement=item.get("statement", ""),
                    rationale=item.get("rationale", ""),
                    supporting_papers=supporting,
                    methodology=item.get("methodology", ""),
                    challenges=item.get("challenges", []),
                    novelty=item.get("novelty", "medium"),
                    novelty_explanation=item.get("novelty_explanation", ""),
                    impact=item.get("impact", "medium"),
                    research_question=rq,
                ))

            return hypotheses

        except Exception as e:
            print(f"Hypothesis generation failed: {e}")
            return []
