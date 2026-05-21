"""
Daily Monitoring Agent

Runs on demand or on a schedule. For each configured research topic:
1. Searches arXiv and Semantic Scholar for recent papers
2. Filters out papers already in the library
3. Scores relevance against the user's existing library using embeddings
4. Summarizes the most relevant new papers
5. Sends an email digest via Resend

This is the feature that turns ScholarLens from a tool into infrastructure.
A researcher configures their topics once, and ScholarLens watches the field for them.
"""

import json
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

import resend
from anthropic import Anthropic

from config import settings
from db import Database
from utils import VectorStore
from agents.paper_import import PaperImporter, ImportResult


@dataclass
class MonitorTopic:
    """A research topic to monitor."""
    name: str
    keywords: list[str]
    sources: list[str] = field(default_factory=lambda: ["arxiv", "semantic_scholar"])


@dataclass
class ScoredPaper:
    """A discovered paper with a relevance score."""
    paper: ImportResult
    relevance_score: float      # 0-1, higher = more relevant to library
    relevance_reason: str


@dataclass
class DigestResult:
    """Results from a monitoring scan."""
    topic: str
    papers_found: int
    papers_relevant: int
    scored_papers: list[ScoredPaper]
    scan_time: str


class MonitoringAgent:
    def __init__(self):
        self.client = Anthropic()
        self.db = Database()
        self.vector_store = VectorStore()
        self.importer = PaperImporter()

        # Configure Resend
        resend_key = os.getenv("RESEND_API_KEY", "")
        if resend_key:
            resend.api_key = resend_key

    def scan_topic(
        self,
        topic: MonitorTopic,
        max_per_source: int = 5,
        relevance_threshold: float = 0.3,
    ) -> DigestResult:
        """
        Scan a single topic for new relevant papers.

        1. Search external sources
        2. Filter out papers already in library
        3. Score relevance against library embeddings
        4. Return scored results
        """
        # Search for papers
        all_results = []
        for kw in topic.keywords:
            results = self.importer.search(kw, sources=topic.sources, max_per_source=max_per_source)
            all_results.extend(results)
            time.sleep(2)  # Rate limit between keyword searches

        # Deduplicate
        seen = set()
        unique = []
        for r in all_results:
            key = r.title.lower().strip()[:60]
            if key not in seen:
                seen.add(key)
                unique.append(r)

        # Filter out papers already in library (by title similarity)
        existing_titles = {p.title.lower().strip()[:60] for p in self.db.list_papers(limit=500)}
        new_papers = [r for r in unique if r.title.lower().strip()[:60] not in existing_titles]

        if not new_papers:
            return DigestResult(
                topic=topic.name,
                papers_found=len(unique),
                papers_relevant=0,
                scored_papers=[],
                scan_time=datetime.now(timezone.utc).isoformat(),
            )

        # Score relevance against library
        scored = self._score_relevance(new_papers, relevance_threshold)

        return DigestResult(
            topic=topic.name,
            papers_found=len(unique),
            papers_relevant=len(scored),
            scored_papers=scored,
            scan_time=datetime.now(timezone.utc).isoformat(),
        )

    def _score_relevance(
        self,
        papers: list[ImportResult],
        threshold: float,
    ) -> list[ScoredPaper]:
        """
        Score each paper's relevance to the existing library.
        Uses embedding similarity between paper abstracts and library content.
        """
        # If library is empty, all papers are relevant
        if self.vector_store.count() == 0:
            return [
                ScoredPaper(paper=p, relevance_score=0.5, relevance_reason="No library to compare against")
                for p in papers
            ]

        scored = []
        for paper in papers:
            if not paper.abstract:
                continue

            # Search library for similar content
            results = self.vector_store.search(
                query=paper.abstract[:500],
                n_results=3,
            )

            if results:
                # Average similarity of top 3 matches (convert distance to similarity)
                avg_sim = 1 - (sum(r.score for r in results) / len(results))
                avg_sim = max(0, min(1, avg_sim))

                if avg_sim >= threshold:
                    # Get the most similar paper's title for context
                    top_match = self.db.get_paper(results[0].paper_id)
                    match_title = top_match.title if top_match else "unknown"

                    scored.append(ScoredPaper(
                        paper=paper,
                        relevance_score=round(avg_sim, 3),
                        relevance_reason=f"Related to: {match_title}",
                    ))

        # Sort by relevance (highest first)
        scored.sort(key=lambda s: s.relevance_score, reverse=True)
        return scored

    def generate_digest_summary(self, results: list[DigestResult]) -> str:
        """Use the LLM to write a brief digest summary."""
        if not any(r.scored_papers for r in results):
            return "No new relevant papers found today."

        papers_text = ""
        for result in results:
            if result.scored_papers:
                papers_text += f"\n## Topic: {result.topic}\n"
                for sp in result.scored_papers[:5]:
                    papers_text += (
                        f"\n**{sp.paper.title}**\n"
                        f"Authors: {', '.join(sp.paper.authors[:3])}\n"
                        f"Year: {sp.paper.year or '?'}\n"
                        f"Relevance: {sp.relevance_score:.0%}\n"
                        f"Abstract: {sp.paper.abstract[:300]}\n"
                    )

        try:
            response = self.client.messages.create(
                model=settings.anthropic_model,
                max_tokens=1024,
                messages=[{
                    "role": "user",
                    "content": (
                        "Write a brief research digest email (3-5 paragraphs) summarizing these "
                        "newly discovered papers. For each paper, explain in 1-2 sentences why "
                        "it matters and how it connects to the researcher's existing work. "
                        "Be concise and specific. No greetings or sign-offs.\n\n"
                        f"{papers_text}"
                    ),
                }],
            )
            return response.content[0].text
        except Exception as e:
            print(f"Digest summary failed: {e}")
            return papers_text

    def send_digest_email(
        self,
        recipient: str,
        results: list[DigestResult],
        summary: str,
    ) -> bool:
        """Send the digest via Resend."""
        if not os.getenv("RESEND_API_KEY"):
            print("No RESEND_API_KEY set, skipping email")
            return False

        total_papers = sum(r.papers_relevant for r in results)
        topics = ", ".join(r.topic for r in results if r.scored_papers)

        # Build HTML email
        html = f"""
        <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; color: #1a1a1a;">
            <div style="background: linear-gradient(135deg, #1e3a5f, #0d1b2a); padding: 24px; border-radius: 12px 12px 0 0;">
                <h1 style="color: #06b6d4; margin: 0; font-size: 20px;">ScholarLens Daily Digest</h1>
                <p style="color: #94a3b8; margin: 8px 0 0 0; font-size: 13px;">
                    {total_papers} new relevant paper{'s' if total_papers != 1 else ''} found
                </p>
            </div>
            <div style="background: #f8fafc; padding: 24px; border: 1px solid #e2e8f0; border-top: none;">
                <div style="line-height: 1.7; font-size: 14px; color: #334155;">
                    {summary.replace(chr(10), '<br>')}
                </div>
        """

        for result in results:
            if result.scored_papers:
                html += f'<h3 style="color: #1e3a5f; margin-top: 24px; font-size: 15px;">{result.topic}</h3>'
                for sp in result.scored_papers[:5]:
                    pdf_badge = '📄' if sp.paper.pdf_url else ''
                    html += f"""
                    <div style="background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 16px; margin-bottom: 8px;">
                        <div style="font-weight: 600; font-size: 14px; color: #0f172a;">
                            {pdf_badge} {sp.paper.title}
                        </div>
                        <div style="font-size: 12px; color: #64748b; margin-top: 4px;">
                            {', '.join(sp.paper.authors[:3])} · {sp.paper.year or '?'}
                            {f' · {sp.paper.citation_count} citations' if sp.paper.citation_count else ''}
                        </div>
                        <div style="font-size: 12px; color: #06b6d4; margin-top: 4px;">
                            Relevance: {sp.relevance_score:.0%} · {sp.relevance_reason}
                        </div>
                        <div style="font-size: 13px; color: #475569; margin-top: 8px; line-height: 1.5;">
                            {sp.paper.abstract[:200]}{'...' if len(sp.paper.abstract) > 200 else ''}
                        </div>
                        <a href="{sp.paper.url}" style="font-size: 12px; color: #3b82f6; text-decoration: none;">
                            View paper →
                        </a>
                    </div>
                    """

        html += """
                <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8;">
                    Sent by ScholarLens · Research Intelligence Platform
                </div>
            </div>
        </div>
        """

        try:
            response = resend.Emails.send({
                "from": "ScholarLens <onboarding@resend.dev>",
                "to": [recipient],
                "subject": f"ScholarLens: {total_papers} new paper{'s' if total_papers != 1 else ''} in {topics}",
                "html": html,
            })
            print(f"Digest email sent: {response}")
            return True
        except Exception as e:
            print(f"Email send failed: {e}")
            return False

    def run_full_scan(
        self,
        topics: list[MonitorTopic],
        recipient: str | None = None,
        max_per_source: int = 5,
        relevance_threshold: float = 0.3,
    ) -> list[DigestResult]:
        """
        Full monitoring pipeline:
        1. Scan all topics
        2. Generate summary
        3. Send email digest (if recipient provided)
        """
        results = []
        for topic in topics:
            result = self.scan_topic(topic, max_per_source, relevance_threshold)
            results.append(result)

        # Generate digest summary if there are relevant papers
        if any(r.scored_papers for r in results):
            summary = self.generate_digest_summary(results)
        else:
            summary = "No new relevant papers found in today's scan."

        # Send email if configured
        if recipient:
            self.send_digest_email(recipient, results, summary)

        return results
