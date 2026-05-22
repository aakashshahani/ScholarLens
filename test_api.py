"""
ScholarLens API Tests

Run:  pytest test_api.py -v
      pytest test_api.py -v -k "test_health"  (single test)

These tests use FastAPI's TestClient (no real server needed).
Tests that hit the Claude API or external services are marked with @pytest.mark.slow.
"""

import json
import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient

# ── Fixture: test client ─────────────────────────────────────

@pytest.fixture(scope="module")
def client():
    """Create a test client. This imports api.py which initializes services."""
    from api import app
    with TestClient(app) as c:
        yield c


@pytest.fixture
def sample_pdf(tmp_path):
    """Create a minimal valid PDF for upload tests."""
    # Minimal PDF 1.0 — just enough for pdfplumber to open
    pdf_content = b"""%PDF-1.0
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>>>endobj
4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
xref
0 5
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000250 00000 n 
trailer<</Size 5/Root 1 0 R>>
startxref
325
%%EOF"""
    pdf_path = tmp_path / "test_paper.pdf"
    pdf_path.write_bytes(pdf_content)
    return pdf_path


# ── Health ───────────────────────────────────────────────────

class TestHealth:
    def test_health_returns_200(self, client):
        resp = client.get("/api/health")
        assert resp.status_code == 200
        data = resp.json()
        assert "status" in data
        assert "papers" in data
        assert "embeddings" in data
        assert isinstance(data["papers"], int)

    def test_health_status_values(self, client):
        data = client.get("/api/health").json()
        assert data["status"] in ("ok", "degraded")
        assert isinstance(data["errors"], list)


# ── Papers CRUD ──────────────────────────────────────────────

class TestPapers:
    def test_list_papers_empty(self, client):
        resp = client.get("/api/papers")
        assert resp.status_code == 200
        assert isinstance(resp.json(), list)

    def test_list_papers_with_params(self, client):
        resp = client.get("/api/papers?limit=5&offset=0")
        assert resp.status_code == 200

    def test_get_paper_not_found(self, client):
        resp = client.get("/api/papers/nonexistent-id-12345")
        assert resp.status_code == 404
        assert "not found" in resp.json()["detail"].lower()

    def test_delete_paper_not_found(self, client):
        resp = client.delete("/api/papers/nonexistent-id-12345")
        assert resp.status_code == 404

    def test_paper_status_not_found(self, client):
        resp = client.get("/api/papers/nonexistent-id/status")
        assert resp.status_code == 404


# ── Upload ───────────────────────────────────────────────────

class TestUpload:
    def test_upload_rejects_non_pdf(self, client):
        resp = client.post(
            "/api/papers/upload",
            files={"file": ("notes.txt", b"hello world", "text/plain")},
        )
        assert resp.status_code == 400
        assert "PDF" in resp.json()["detail"]

    @pytest.mark.slow
    def test_upload_pdf(self, client, sample_pdf):
        """Requires working PDF extraction + Claude API."""
        with open(sample_pdf, "rb") as f:
            resp = client.post(
                "/api/papers/upload",
                files={"file": ("test_paper.pdf", f, "application/pdf")},
            )
        assert resp.status_code == 200
        data = resp.json()
        assert "id" in data
        assert data["status"] == "analyzing"


# ── Search ───────────────────────────────────────────────────

class TestSearch:
    def test_search_empty_library(self, client):
        resp = client.post(
            "/api/search",
            json={"query": "machine learning methods", "n_results": 5},
        )
        assert resp.status_code == 200
        assert isinstance(resp.json(), list)

    def test_search_requires_query(self, client):
        resp = client.post("/api/search", json={})
        assert resp.status_code == 422  # validation error

    def test_ask_requires_question(self, client):
        resp = client.post("/api/ask", json={})
        assert resp.status_code == 422


# ── Contradictions ───────────────────────────────────────────

class TestContradictions:
    def test_contradictions_with_defaults(self, client):
        """Should return empty list when library has <2 papers."""
        resp = client.post("/api/contradictions", json={})
        assert resp.status_code == 200
        assert isinstance(resp.json(), list)

    def test_contradictions_with_params(self, client):
        resp = client.post(
            "/api/contradictions",
            json={
                "similarity_threshold": 0.7,
                "max_pairs": 5,
            },
        )
        assert resp.status_code == 200


# ── Hypotheses ───────────────────────────────────────────────

class TestHypotheses:
    def test_hypotheses_empty_library(self, client):
        resp = client.post(
            "/api/hypotheses",
            json={"num_hypotheses": 3},
        )
        assert resp.status_code == 200
        # Empty library → empty list (no error)
        assert isinstance(resp.json(), list)

    def test_hypotheses_with_question(self, client):
        resp = client.post(
            "/api/hypotheses",
            json={
                "research_question": "How does LLM feedback affect negotiation skill?",
                "num_hypotheses": 3,
            },
        )
        assert resp.status_code == 200


# ── Import ───────────────────────────────────────────────────

class TestImport:
    def test_import_search_validation(self, client):
        resp = client.post("/api/import/search", json={})
        assert resp.status_code == 422

    @pytest.mark.slow
    def test_import_search_arxiv(self, client):
        """Hits real arXiv API."""
        resp = client.post(
            "/api/import/search",
            json={
                "query": "transformer attention mechanism",
                "sources": ["arxiv"],
                "max_per_source": 3,
            },
        )
        assert resp.status_code == 200
        results = resp.json()
        assert isinstance(results, list)
        if results:
            assert "title" in results[0]
            assert "authors" in results[0]
            assert "source" in results[0]

    def test_import_lookup_validation(self, client):
        resp = client.post("/api/import/lookup", json={})
        assert resp.status_code == 422

    @pytest.mark.slow
    def test_import_lookup_arxiv_id(self, client):
        """Hits real arXiv API."""
        resp = client.post(
            "/api/import/lookup",
            json={"identifier": "1706.03762"},  # Attention Is All You Need
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "attention" in data["title"].lower()


# ── Monitor ──────────────────────────────────────────────────

class TestMonitor:
    def test_monitor_validation(self, client):
        resp = client.post("/api/monitor/scan", json={})
        assert resp.status_code == 422

    @pytest.mark.slow
    def test_monitor_scan(self, client):
        resp = client.post(
            "/api/monitor/scan",
            json={
                "topics": [
                    {
                        "name": "LLM Coaching",
                        "keywords": ["LLM negotiation coaching"],
                        "sources": ["arxiv"],
                    }
                ],
                "relevance_threshold": 0.3,
                "max_per_source": 3,
            },
        )
        assert resp.status_code == 200
        results = resp.json()
        assert isinstance(results, list)
        if results:
            assert "topic" in results[0]
            assert "papers_found" in results[0]


# ── API Docs ─────────────────────────────────────────────────

class TestDocs:
    def test_openapi_schema(self, client):
        resp = client.get("/api/docs")
        assert resp.status_code == 200

    def test_redoc(self, client):
        resp = client.get("/api/redoc")
        assert resp.status_code == 200


# ── Reanalyze ────────────────────────────────────────────────

class TestReanalyze:
    def test_reanalyze_not_found(self, client):
        resp = client.post("/api/papers/nonexistent-id/reanalyze")
        assert resp.status_code == 404


# ── Run with: pytest test_api.py -v ──────────────────────────

if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short", "-m", "not slow"])
