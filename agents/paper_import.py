"""
Paper Import Agent

Searches academic databases and imports papers into ScholarLens.
Supports:
- arXiv (free, no auth needed)
- Semantic Scholar (free, API key recommended)

Uses the requests library with built-in retry and backoff.
"""

import json
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from config import UPLOAD_DIR, settings


# ── HTTP Session with Retry ──────────────────────────────────

def _make_session() -> requests.Session:
    """Create a session with automatic retry on 429/500/502/503."""
    session = requests.Session()
    retry = Retry(
        total=3,
        connect=3,              # retry on connection failures
        read=3,                 # retry on read timeouts (the arXiv failure mode)
        backoff_factor=2,       # waits 2s, 4s, 8s between attempts
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET"],
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    session.headers.update({
        "User-Agent": "ScholarLens/1.0 (research-tool; github.com/aakashshahani/ScholarLens)",
    })
    return session


_session = _make_session()

# Rate limiter
_last_request = {"arxiv": 0.0, "s2": 0.0}

# Search cache
_cache: dict[str, list] = {}


def _wait(source: str, seconds: float = 3.0):
    elapsed = time.time() - _last_request[source]
    if elapsed < seconds:
        time.sleep(seconds - elapsed)
    _last_request[source] = time.time()


# ── Data Model ───────────────────────────────────────────────

class SourceUnavailable(Exception):
    """Raised when an external source fails after retries (e.g. timeout)."""

@dataclass
class ImportResult:
    title: str
    authors: list[str]
    abstract: str
    year: int | None
    source: str             # "arxiv", "semantic_scholar"
    source_id: str
    doi: str | None
    pdf_url: str | None
    citation_count: int | None
    url: str


# ── arXiv ────────────────────────────────────────────────────

class ArxivSource:
    BASE = "https://export.arxiv.org/api/query"

    def search(self, query: str, max_results: int = 10) -> list[ImportResult]:
        _wait("arxiv", 5.0)
        try:
            resp = _session.get(self.BASE, params={
                "search_query": f"all:{query}",
                "start": 0,
                "max_results": max_results,
                "sortBy": "relevance",
                "sortOrder": "descending",
            }, timeout=30)
            resp.raise_for_status()
        except Exception as e:
            print(f"arXiv search failed: {e}")
            raise SourceUnavailable(str(e)) from e
        return self._parse(resp.text)

    def fetch_by_id(self, arxiv_id: str) -> ImportResult | None:
        arxiv_id = arxiv_id.strip()
        arxiv_id = re.sub(r"^https?://arxiv\.org/abs/", "", arxiv_id)
        arxiv_id = re.sub(r"^arXiv:", "", arxiv_id, flags=re.IGNORECASE)

        _wait("arxiv", 5.0)
        try:
            resp = _session.get(self.BASE, params={"id_list": arxiv_id}, timeout=15)
            resp.raise_for_status()
        except Exception as e:
            print(f"arXiv fetch failed: {e}")
            return None

        results = self._parse(resp.text)
        return results[0] if results else None

    def _parse(self, xml_text: str) -> list[ImportResult]:
        import xml.etree.ElementTree as ET
        ns = {"a": "http://www.w3.org/2005/Atom"}
        root = ET.fromstring(xml_text)
        results = []

        for entry in root.findall("a:entry", ns):
            title = (entry.findtext("a:title", "", ns) or "").strip()
            title = re.sub(r"\s+", " ", title)
            if not title or title.startswith("Error"):
                continue

            authors = [
                a.findtext("a:name", "", ns).strip()
                for a in entry.findall("a:author", ns)
                if a.findtext("a:name", "", ns).strip()
            ]

            abstract = re.sub(r"\s+", " ", entry.findtext("a:summary", "", ns) or "").strip()

            entry_id = entry.findtext("a:id", "", ns) or ""
            aid = entry_id.split("/abs/")[-1] if "/abs/" in entry_id else entry_id

            published = entry.findtext("a:published", "", ns) or ""
            year = int(published[:4]) if published[:4].isdigit() else None

            pdf_url = None
            for link in entry.findall("a:link", ns):
                if link.get("title") == "pdf":
                    pdf_url = link.get("href")
            if not pdf_url and aid:
                pdf_url = f"https://arxiv.org/pdf/{aid}"

            results.append(ImportResult(
                title=title, authors=authors, abstract=abstract,
                year=year, source="arxiv", source_id=aid,
                doi=None, pdf_url=pdf_url, citation_count=None,
                url=f"https://arxiv.org/abs/{aid}",
            ))
        return results

    def download_pdf(self, result: ImportResult) -> Path | None:
        if not result.pdf_url:
            return None
        safe = re.sub(r"[^\w\s-]", "", result.title)[:80].strip()
        path = UPLOAD_DIR / f"{safe}.pdf"
        if path.exists():
            return path
        try:
            _wait("arxiv", 5.0)
            resp = _session.get(result.pdf_url, timeout=30)
            resp.raise_for_status()
            path.write_bytes(resp.content)
            return path
        except Exception as e:
            print(f"arXiv PDF download failed: {e}")
            return None


# ── Semantic Scholar ─────────────────────────────────────────

class SemanticScholarSource:
    BASE = "https://api.semanticscholar.org/graph/v1"
    FIELDS = "title,authors,abstract,year,externalIds,citationCount,openAccessPdf,url"

    def _headers(self) -> dict:
        headers = {}
        key = settings.semantic_scholar_key
        if key:
            headers["x-api-key"] = key
        return headers

    def search(self, query: str, max_results: int = 10) -> list[ImportResult]:
        _wait("s2", 1.5)
        try:
            resp = _session.get(
                f"{self.BASE}/paper/search",
                params={"query": query, "limit": max_results, "fields": self.FIELDS},
                headers=self._headers(),
                timeout=15,
            )
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            print(f"Semantic Scholar search failed: {e}")
            raise SourceUnavailable(str(e)) from e

        return [self._to_result(p) for p in data.get("data", []) if p.get("title")]

    def fetch_by_doi(self, doi: str) -> ImportResult | None:
        _wait("s2", 1.5)
        try:
            resp = _session.get(
                f"{self.BASE}/paper/DOI:{doi}",
                params={"fields": self.FIELDS},
                headers=self._headers(),
                timeout=15,
            )
            resp.raise_for_status()
            paper = resp.json()
        except Exception as e:
            print(f"Semantic Scholar DOI lookup failed: {e}")
            return None
        return self._to_result(paper) if paper.get("title") else None

    def _to_result(self, paper: dict) -> ImportResult:
        authors = [a.get("name", "") for a in paper.get("authors", []) if a.get("name")]
        ext = paper.get("externalIds") or {}
        pdf_info = paper.get("openAccessPdf") or {}
        return ImportResult(
            title=paper["title"],
            authors=authors,
            abstract=paper.get("abstract") or "",
            year=paper.get("year"),
            source="semantic_scholar",
            source_id=paper.get("paperId", ""),
            doi=ext.get("DOI"),
            pdf_url=pdf_info.get("url"),
            citation_count=paper.get("citationCount"),
            url=paper.get("url") or f"https://www.semanticscholar.org/paper/{paper.get('paperId', '')}",
        )

    def download_pdf(self, result: ImportResult) -> Path | None:
        if not result.pdf_url:
            return None
        safe = re.sub(r"[^\w\s-]", "", result.title)[:80].strip()
        path = UPLOAD_DIR / f"{safe}.pdf"
        if path.exists():
            return path
        try:
            _wait("s2", 1.5)
            resp = _session.get(result.pdf_url, timeout=30)
            resp.raise_for_status()
            path.write_bytes(resp.content)
            return path
        except Exception as e:
            print(f"S2 PDF download failed: {e}")
            return None


# ── Unified Interface ────────────────────────────────────────

class PaperImporter:
    def __init__(self):
        self.arxiv = ArxivSource()
        self.s2 = SemanticScholarSource()

    # Friendly names for surfacing failures to the user.
    SOURCE_LABELS = {"arxiv": "arXiv", "semantic_scholar": "Semantic Scholar"}

    def search(
        self,
        query: str,
        sources: list[str] | None = None,
        max_per_source: int = 5,
    ) -> list[ImportResult]:
        """Back-compat: returns just the deduped results (drops status)."""
        results, _failed = self.search_with_status(query, sources, max_per_source)
        return results

    def search_with_status(
        self,
        query: str,
        sources: list[str] | None = None,
        max_per_source: int = 5,
    ) -> tuple[list[ImportResult], list[str]]:
        """
        Search across sources and report which sources failed.

        Returns (deduped_results, failed_source_labels). A source that raises
        (e.g. arXiv read-timeout after retries) is recorded as failed so the
        caller can tell the user a source was unavailable rather than silently
        returning a thinner result set. An empty-but-successful source is NOT
        a failure.
        """
        if sources is None:
            sources = ["arxiv", "semantic_scholar"]

        cache_key = f"{query}|{'_'.join(sorted(sources))}|{max_per_source}"
        if cache_key in _cache:
            return _cache[cache_key], []

        all_results: list[ImportResult] = []
        failed: list[str] = []

        if "arxiv" in sources:
            try:
                all_results.extend(self.arxiv.search(query, max_per_source))
            except SourceUnavailable:
                failed.append(self.SOURCE_LABELS["arxiv"])

        if "semantic_scholar" in sources:
            try:
                all_results.extend(self.s2.search(query, max_per_source))
            except SourceUnavailable:
                failed.append(self.SOURCE_LABELS["semantic_scholar"])

        # Deduplicate by title
        seen = set()
        deduped = []
        for r in all_results:
            key = r.title.lower().strip()[:60]
            if key not in seen:
                seen.add(key)
                deduped.append(r)

        # Only cache a fully-successful scan; a partial failure shouldn't be
        # cached as if it were the complete result for this query.
        if not failed:
            _cache[cache_key] = deduped
        return deduped, failed

    def lookup(self, identifier: str) -> ImportResult | None:
        identifier = identifier.strip()

        if "arxiv" in identifier.lower() or re.match(r"^\d{4}\.\d{4,5}", identifier):
            return self.arxiv.fetch_by_id(identifier)

        if identifier.startswith("10.") or "doi.org" in identifier:
            doi = re.sub(r"^https?://doi\.org/", "", identifier)
            return self.s2.fetch_by_doi(doi)

        try:
            results = self.s2.search(identifier, max_results=1)
        except SourceUnavailable:
            return None
        return results[0] if results else None

    def download_pdf(self, result: ImportResult) -> Path | None:
        if result.source == "arxiv":
            return self.arxiv.download_pdf(result)
        return self.s2.download_pdf(result)
