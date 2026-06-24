"""
Paper Import Agent

Searches academic databases and imports papers into ScholarLens.
Supports:
- Semantic Scholar (primary — reliable, structured JSON, citation counts)
- OpenAlex (secondary — 250M+ works, free, no key, fast with polite pool)
- arXiv (fallback — preprints only, flaky, but catches very new work)

Source priority: S2 → OpenAlex → arXiv. arXiv is last because it's the most
unreliable; OpenAlex indexes most arXiv preprints anyway with better reliability.

Uses the requests library with built-in retry and backoff.
"""

import json
import os
import re
import threading
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
        connect=3,
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

# Per-source rate limiters — lock serializes concurrent callers so the
# check-and-sleep is atomic (prevents the TOCTOU race where two threads
# both pass the elapsed check and fire simultaneously).
_last_request: dict[str, float] = {"arxiv": 0.0, "s2": 0.0, "openalex": 0.0}
_source_locks: dict[str, threading.Lock] = {
    "arxiv": threading.Lock(),
    "s2": threading.Lock(),
    "openalex": threading.Lock(),
}

# In-memory search cache
_cache: dict[str, list] = {}
_cache_lock = threading.Lock()


def _wait(source: str, seconds: float = 3.0):
    with _source_locks[source]:
        elapsed = time.time() - _last_request.get(source, 0.0)
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
    source: str             # "arxiv" | "semantic_scholar" | "openalex"
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
            # Separate connect timeout (10s) from read timeout (45s).
            # arXiv's API is slow to respond but usually delivers if given time.
            resp = _session.get(self.BASE, params={
                "search_query": f"all:{query}",
                "start": 0,
                "max_results": max_results,
                "sortBy": "submittedDate",
                "sortOrder": "descending",
            }, timeout=(10, 45))
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
            resp = _session.get(self.BASE, params={"id_list": arxiv_id}, timeout=(10, 30))
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
            resp = _session.get(result.pdf_url, timeout=(10, 60))
            resp.raise_for_status()
            path.write_bytes(resp.content)
            return path
        except Exception as e:
            print(f"arXiv PDF download failed: {e}")
            return None


# ── OpenAlex ─────────────────────────────────────────────────

class OpenAlexSource:
    """
    OpenAlex: 250M+ scholarly works, completely free, no API key required.
    Include mailto in requests to get into the "polite pool" for faster,
    more consistent responses (recommended by OpenAlex).

    Key quirk: abstracts come as an inverted index {word: [positions]}.
    _reconstruct_abstract converts this to plain text.

    Docs: https://docs.openalex.org/api-entities/works/search-works
    """
    BASE = "https://api.openalex.org/works"

    def _mailto(self) -> str:
        """Return mailto param for polite pool — uses CONTACT_EMAIL env var."""
        return os.getenv("CONTACT_EMAIL", "")

    def _params(self, extra: dict) -> dict:
        params = {**extra}
        email = self._mailto()
        if email:
            params["mailto"] = email
        return params

    @staticmethod
    def _reconstruct_abstract(inv_index: dict | None) -> str:
        """Convert OpenAlex inverted abstract index to plain text."""
        if not inv_index:
            return ""
        try:
            # Each entry: word → [position, position, ...]
            positions = []
            for word, pos_list in inv_index.items():
                for pos in pos_list:
                    positions.append((pos, word))
            positions.sort(key=lambda x: x[0])
            return " ".join(word for _, word in positions)
        except Exception:
            return ""

    def _to_result(self, work: dict) -> ImportResult | None:
        title = (work.get("title") or "").strip()
        if not title:
            return None

        # Authors
        authors = []
        for authorship in work.get("authorships", []):
            name = authorship.get("author", {}).get("display_name", "")
            if name:
                authors.append(name)

        # Abstract
        abstract = self._reconstruct_abstract(work.get("abstract_inverted_index"))

        # Year
        year = work.get("publication_year")

        # IDs
        ids = work.get("ids", {})
        doi = ids.get("doi", "").replace("https://doi.org/", "") if ids.get("doi") else None
        openalex_id = work.get("id", "").split("/")[-1]  # W1234567890

        # PDF
        oa = work.get("open_access", {})
        pdf_url = oa.get("oa_url")

        # URL
        url = work.get("doi") or f"https://openalex.org/{openalex_id}"

        # Citation count
        citation_count = work.get("cited_by_count")

        return ImportResult(
            title=title,
            authors=authors,
            abstract=abstract,
            year=year,
            source="openalex",
            source_id=openalex_id,
            doi=doi,
            pdf_url=pdf_url,
            citation_count=citation_count,
            url=url,
        )

    def search(self, query: str, max_results: int = 10) -> list[ImportResult]:
        _wait("openalex", 1.0)
        try:
            resp = _session.get(
                self.BASE,
                params=self._params({
                    "search": query,
                    "per-page": min(max_results, 25),
                    "sort": "publication_date:desc",
                    # Only return works with abstracts — empty abstracts aren't useful
                    "filter": "has_abstract:true",
                    "select": "id,title,authorships,abstract_inverted_index,"
                              "publication_year,ids,open_access,cited_by_count,doi",
                }),
                timeout=(8, 20),
            )
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            print(f"OpenAlex search failed: {e}")
            raise SourceUnavailable(str(e)) from e

        results = []
        for work in data.get("results", []):
            r = self._to_result(work)
            if r:
                results.append(r)
        return results

    def download_pdf(self, result: ImportResult) -> Path | None:
        if not result.pdf_url:
            return None
        safe = re.sub(r"[^\w\s-]", "", result.title)[:80].strip()
        path = UPLOAD_DIR / f"{safe}.pdf"
        if path.exists():
            return path
        try:
            _wait("openalex", 1.0)
            resp = _session.get(result.pdf_url, timeout=(10, 60))
            resp.raise_for_status()
            path.write_bytes(resp.content)
            return path
        except Exception as e:
            print(f"OpenAlex PDF download failed: {e}")
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
            resp = _session.get(result.pdf_url, timeout=(10, 60))
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
        self.openalex = OpenAlexSource()
        self.s2 = SemanticScholarSource()

    # Friendly names for surfacing failures to the user.
    SOURCE_LABELS = {
        "arxiv": "arXiv",
        "semantic_scholar": "Semantic Scholar",
        "openalex": "OpenAlex",
    }

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
        Search across sources in priority order and report which failed.

        Priority: Semantic Scholar → OpenAlex → arXiv
        arXiv is last — it's the most flaky and OpenAlex indexes most arXiv
        preprints anyway with better reliability.

        Returns (deduped_results, failed_source_labels). A source that raises
        is recorded as failed so the caller can surface an honest banner.
        An empty-but-successful source is NOT a failure.
        """
        if sources is None:
            sources = ["semantic_scholar", "openalex", "arxiv"]

        cache_key = f"{query}|{'_'.join(sorted(sources))}|{max_per_source}"
        with _cache_lock:
            if cache_key in _cache:
                return _cache[cache_key], []

        all_results: list[ImportResult] = []
        failed: list[str] = []

        # Priority order: S2 first, OpenAlex second, arXiv last
        for source in ["semantic_scholar", "openalex", "arxiv"]:
            if source not in sources:
                continue
            try:
                if source == "semantic_scholar":
                    all_results.extend(self.s2.search(query, max_per_source))
                elif source == "openalex":
                    all_results.extend(self.openalex.search(query, max_per_source))
                elif source == "arxiv":
                    all_results.extend(self.arxiv.search(query, max_per_source))
            except SourceUnavailable:
                failed.append(self.SOURCE_LABELS[source])

        # Deduplicate by title (cross-source)
        seen: set[str] = set()
        deduped: list[ImportResult] = []
        for r in all_results:
            key = r.title.lower().strip()[:60]
            if key not in seen:
                seen.add(key)
                deduped.append(r)

        if not failed:
            with _cache_lock:
                _cache[cache_key] = deduped
        return deduped, failed

    def _fetch_by_doi(self, doi: str) -> ImportResult | None:
        """Try S2 first, then OpenAlex as fallback for DOI lookup."""
        result = self.s2.fetch_by_doi(doi)
        if result:
            return result
        # OpenAlex DOI lookup
        _wait("openalex", 1.0)
        try:
            resp = _session.get(
                "https://api.openalex.org/works",
                params=self.openalex._params({"filter": f"doi:{doi}", "select":
                    "id,title,authorships,abstract_inverted_index,"
                    "publication_year,ids,open_access,cited_by_count,doi"}),
                timeout=(8, 20),
            )
            resp.raise_for_status()
            works = resp.json().get("results", [])
            if works:
                return self.openalex._to_result(works[0])
        except Exception:
            pass
        return None

    def lookup(self, identifier: str) -> ImportResult | None:
        identifier = identifier.strip()

        # arXiv: URL, "arXiv:" prefix, or bare NNNN.NNNNN id
        if re.search(r"arxiv\.org", identifier, re.IGNORECASE) or \
           re.match(r"^arxiv:", identifier, re.IGNORECASE) or \
           re.match(r"^\d{4}\.\d{4,5}(v\d+)?$", identifier):
            return self.arxiv.fetch_by_id(identifier)

        # DOI: starts with "10." or contains doi.org
        if re.match(r"^10\.\d{4,}/", identifier) or "doi.org" in identifier:
            doi = re.sub(r"^https?://(dx\.)?doi\.org/", "", identifier).strip()
            return self._fetch_by_doi(doi)

        # Semantic Scholar paper ID (40-char hex or CorpusId:NNN)
        if re.match(r"^[0-9a-f]{40}$", identifier) or \
           re.match(r"^CorpusId:\d+$", identifier, re.IGNORECASE):
            _wait("s2", 1.5)
            try:
                resp = _session.get(
                    f"{self.s2.BASE}/paper/{identifier}",
                    params={"fields": self.s2.FIELDS},
                    headers=self.s2._headers(),
                    timeout=15,
                )
                if resp.ok:
                    paper = resp.json()
                    if paper.get("title"):
                        return self.s2._to_result(paper)
            except Exception:
                pass
            return None

        # Title / keyword fallback: try S2 + OpenAlex, validate top result
        # by requiring the returned title to share at least one significant
        # word with the query (guards against completely off-topic results).
        query_words = {w.lower() for w in re.findall(r"\w{4,}", identifier)}

        def _title_matches(title: str) -> bool:
            if not query_words:
                return True
            result_words = {w.lower() for w in re.findall(r"\w{4,}", title)}
            return bool(query_words & result_words)

        try:
            results = self.s2.search(identifier, max_results=3)
            for r in results:
                if _title_matches(r.title):
                    return r
        except SourceUnavailable:
            pass

        try:
            results = self.openalex.search(identifier, max_results=3)
            for r in results:
                if _title_matches(r.title):
                    return r
        except SourceUnavailable:
            pass

        return None

    def download_pdf(self, result: ImportResult) -> Path | None:
        if result.source == "arxiv":
            return self.arxiv.download_pdf(result)
        if result.source == "openalex":
            return self.openalex.download_pdf(result)
        return self.s2.download_pdf(result)
