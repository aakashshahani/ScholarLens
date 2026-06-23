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

import html as _html
import json
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
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
    sources: list[str] = field(default_factory=lambda: ["semantic_scholar", "openalex", "arxiv"])


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
        self._failed_sources: set[str] = set()

        # Email via Gmail SMTP — credentials from GMAIL_USER + GMAIL_APP_PASSWORD env vars

    def _anthropic(self, api_key: str | None = None):
        """Per-request Anthropic client: the caller's BYOK key when provided,
        else the shared server client. Built per call, never stored on self,
        so it is safe under concurrent (threadpool) use."""
        return Anthropic(api_key=api_key) if api_key else self.client

    def scan_topic(
        self,
        topic: MonitorTopic,
        max_per_source: int = 5,
        relevance_threshold: float = 0.3,
        lib_ids: list[str] | None = None,
        lib_titles: set[str] | None = None,
    ) -> DigestResult:
        """
        Scan a single topic for new relevant papers.

        1. Search external sources
        2. Filter out papers already in library
        3. Score relevance against library embeddings
        4. Return scored results
        """
        # Search for papers. Use the status-aware variant so we can report
        # which external sources were unavailable rather than silently
        # returning a thinner set.
        all_results = []
        for kw in topic.keywords:
            # Sanitise: collapse whitespace, strip chars that break API
            # query strings. Keeps alphanumerics, spaces, hyphens.
            # Catches sloppy-typing failure mode, no spell library needed.
            kw = " ".join(
                ch if (ch.isalnum() or ch in "-_") else " "
                for ch in kw
            )
            kw = " ".join(kw.split())  # collapse whitespace
            if not kw:
                continue
            results, failed = self.importer.search_with_status(
                kw, sources=topic.sources, max_per_source=max_per_source
            )
            all_results.extend(results)
            for label in failed:
                self._failed_sources.add(label)
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
        existing_titles = lib_titles if lib_titles is not None else {t.lower().strip()[:60] for t in self.db.paper_title_map().values()}
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
        scored = self._score_relevance(new_papers, relevance_threshold, lib_ids=lib_ids)

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
        lib_ids: list[str] | None = None,
    ) -> list[ScoredPaper]:
        """
        Score each paper's relevance to the existing library.
        Uses embedding similarity between paper abstracts and library content.
        """
        # If the user's library is empty, all papers are relevant
        empty_library = (
            (lib_ids is not None and len(lib_ids) == 0)
            or (lib_ids is None and self.vector_store.count() == 0)
        )
        if empty_library:
            return [
                ScoredPaper(paper=p, relevance_score=0.5, relevance_reason="No library to compare against")
                for p in papers
            ]

        # Cap at 5 papers — reduced from 8 to further lower peak memory.
        # Batch embed all abstracts in one Voyage API call instead of one
        # call per paper — eliminates N sequential HTTP round trips and
        # reduces memory by releasing all embedding arrays together after
        # the batch rather than holding each in memory during a loop.
        papers = [p for p in papers[:5] if p.abstract]
        if not papers:
            return []

        scored = []
        try:
            # One Voyage call for all abstracts — batch is more memory-efficient
            # than N sequential calls because the HTTP response is parsed once
            # and the embedding list is released as a unit after use.
            abstracts = [p.abstract[:400] for p in papers]
            embeddings = self.vector_store.embed_texts(abstracts)

            for paper, embedding in zip(papers, embeddings):
                try:
                    # Use the pre-computed embedding directly for pgvector search
                    # instead of re-embedding inside vector_store.search()
                    results = self.vector_store.search_by_embedding(
                        embedding=embedding,
                        n_results=3,
                        paper_ids=lib_ids,
                    )
                    if results:
                        avg_sim = 1 - (sum(r.score for r in results) / len(results))
                        avg_sim = max(0, min(1, avg_sim))
                        if avg_sim >= threshold:
                            try:
                                top_match = self.db.get_paper(results[0].paper_id)
                                match_title = top_match.title if top_match else "unknown"
                            except Exception:
                                match_title = "unknown"
                            scored.append(ScoredPaper(
                                paper=paper,
                                relevance_score=round(avg_sim, 3),
                                relevance_reason=f"Related to: {match_title}",
                            ))
                except Exception as e:
                    print(f"[monitor] scoring failed for '{paper.title[:40]}': {e}")
                    continue
        except Exception as e:
            print(f"[monitor] batch embed failed: {e}")
            # Fallback: skip scoring, return all papers as mildly relevant
            return [ScoredPaper(paper=p, relevance_score=0.4,
                               relevance_reason="Relevance scoring unavailable")
                    for p in papers]

        # Sort by relevance (highest first)
        scored.sort(key=lambda s: s.relevance_score, reverse=True)
        return scored

    def generate_digest_summary(self, results: list[DigestResult], api_key: str | None = None, model: str | None = None) -> str:
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
            response = self._anthropic(api_key).messages.create(
                model=(model or settings.anthropic_model),
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
        """Send the digest via Gmail SMTP."""
        gmail_user = os.getenv("GMAIL_USER", "")
        gmail_password = os.getenv("GMAIL_APP_PASSWORD", "")
        if not gmail_user or not gmail_password:
            print("GMAIL_USER or GMAIL_APP_PASSWORD not set, skipping email")
            return False

        total_papers = sum(r.papers_relevant for r in results)
        topics = ", ".join(r.topic for r in results if r.scored_papers)

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
                    {_html.escape(summary).replace(chr(10), '<br>')}
                </div>
        """
        for result in results:
            if result.scored_papers:
                html += f'<h3 style="color: #1e3a5f; margin-top: 24px; font-size: 15px;">{result.topic}</h3>'
                for sp in result.scored_papers[:5]:
                    pdf_badge = '📄' if sp.paper.pdf_url else ''
                    title_safe = _html.escape(sp.paper.title)
                    authors_safe = _html.escape(', '.join(sp.paper.authors[:3]))
                    abstract_safe = _html.escape(sp.paper.abstract[:200])
                    reason_safe = _html.escape(sp.relevance_reason)
                    ellipsis = '...' if len(sp.paper.abstract) > 200 else ''
                    html += f"""
                    <div style="background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 16px; margin-bottom: 8px;">
                        <div style="font-weight: 600; font-size: 14px; color: #0f172a;">{pdf_badge} {title_safe}</div>
                        <div style="font-size: 12px; color: #64748b; margin-top: 4px;">
                            {authors_safe} · {sp.paper.year or '?'}
                            {f' · {sp.paper.citation_count} citations' if sp.paper.citation_count else ''}
                        </div>
                        <div style="font-size: 12px; color: #06b6d4; margin-top: 4px;">
                            Relevance: {sp.relevance_score:.0%} · {reason_safe}
                        </div>
                        <div style="font-size: 13px; color: #475569; margin-top: 8px; line-height: 1.5;">
                            {abstract_safe}{ellipsis}
                        </div>
                        <a href="{sp.paper.url}" style="font-size: 12px; color: #3b82f6; text-decoration: none;">View paper →</a>
                    </div>
                    """
        html += """
                <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8;">
                    Sent by ScholarLens · Research Intelligence Platform
                </div>
            </div>
        </div>
        """
        msg = MIMEMultipart("alternative")
        msg["Subject"] = f"ScholarLens: {total_papers} new paper{'s' if total_papers != 1 else ''} in {topics}"
        msg["From"] = f"ScholarLens <{gmail_user}>"
        msg["To"] = recipient
        msg.attach(MIMEText(html, "html"))
        try:
            with smtplib.SMTP("smtp.gmail.com", 587) as server:
                server.ehlo()
                server.starttls()
                server.login(gmail_user, gmail_password)
                server.sendmail(gmail_user, recipient, msg.as_string())
            print(f"Digest email sent via Gmail to {recipient}")
            return True
        except Exception as e:
            print(f"Gmail send failed: {e}")
            return False


    def run_full_scan(
        self,
        topics: list[MonitorTopic],
        recipient: str | None = None,
        max_per_source: int = 5,
        relevance_threshold: float = 0.3,
        user_id: str | None = None,
        api_key: str | None = None,
        model: str | None = None,
    ) -> tuple[list[DigestResult], bool, str | None, list[str]]:
        """
        Full monitoring pipeline:
        1. Scan all topics
        2. Generate summary
        3. Send email digest (if recipient provided)

        Returns (results, email_sent, email_error). email_sent is True only when
        an email was actually delivered; email_error carries a short reason when
        a requested send failed (e.g. no API key, or unverified-domain sandbox
        limits) so the UI never claims a send that didn't happen.
        """
        self._failed_sources: set[str] = set()
        # Fetch only id+title — avoids loading full_text for every paper in the library.
        title_map = self.db.paper_title_map(user_id=user_id)
        lib_ids = list(title_map.keys())
        lib_titles = {t.lower().strip()[:60] for t in title_map.values()}
        results = []
        for topic in topics:
            result = self.scan_topic(
                topic, max_per_source, relevance_threshold,
                lib_ids=lib_ids, lib_titles=lib_titles,
            )
            results.append(result)

        # Only generate LLM summary when actually sending an email.
        # Manual scans show a paper list in the UI — the summary is never
        # displayed there, so generating it wastes RAM and burns an action.
        if recipient and any(r.scored_papers for r in results):
            summary = self.generate_digest_summary(results, api_key=api_key, model=model)
        elif recipient:
            summary = "No new relevant papers found in today's scan."
        else:
            summary = ""

        # Send email if configured, and report what actually happened.
        email_sent = False
        email_error: str | None = None
        if recipient:
            if not os.getenv("GMAIL_USER") or not os.getenv("GMAIL_APP_PASSWORD"):
                email_error = "Email is not configured on the server (GMAIL_USER / GMAIL_APP_PASSWORD missing)."
            else:
                try:
                    email_sent = self.send_digest_email(recipient, results, summary)
                    if not email_sent:
                        email_error = "Email send failed — check GMAIL_USER and GMAIL_APP_PASSWORD in server config."
                except Exception as e:  # noqa: BLE001
                    email_error = f"Email failed: {e}"

        return results, email_sent, email_error, sorted(self._failed_sources)
