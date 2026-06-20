"""
ScholarLens API â€” FastAPI Backend

Exposes all agent functionality as REST endpoints.
The existing agent code stays exactly the same.
This is just a thin API layer on top.

Run: uvicorn api:app --reload --port 8000
"""

import sys
from pathlib import Path

# Ensure project root is on path
sys.path.insert(0, str(Path(__file__).resolve().parent))

import json
import os
import re
import uuid
import secrets

from fastapi import (
    FastAPI, UploadFile, File, HTTPException, BackgroundTasks, Query,
    Request, Header, Depends, Response,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, EmailStr
from typing import Optional

from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from config import settings, UPLOAD_DIR
from db import Database, Paper
from db.database import User
import auth as authlib
from agents import (
    PDFAnalysisAgent,
    ContradictionAgent,
    HypothesisAgent,
    PaperImporter,
    MonitoringAgent,
    MonitorTopic,
)

# â”€â”€ App Setup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app = FastAPI(
    title="ScholarLens API",
    description="Research intelligence platform â€” agentic paper analysis, "
                "cross-paper contradiction detection, and hypothesis generation.",
    version="1.0.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
)

# â”€â”€ Rate limiting â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Per-IP, keyed on the remote address. Storage is in-memory by default
# (correct for a single instance); set RATE_LIMIT_STORAGE_URI=redis://...
# in settings to share counters across instances. The global default is a
# coarse backstop â€” the meaningful limits are per-endpoint decorators below.
limiter = Limiter(
    key_func=get_remote_address,
    default_limits=[settings.rl_default],
    storage_uri=settings.rate_limit_storage_uri,
)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Middleware order note: add_middleware prepends, so the LAST added runs
# outermost. SlowAPI is added first and CORS last, so CORS wraps SlowAPI and
# preflight OPTIONS requests get CORS headers without being rate-limited.
app.add_middleware(SlowAPIMiddleware)

# Allowed origins: localhost for dev, plus the deployed frontend from env.
# allow_credentials=True forbids the "*" wildcard, so origins stay explicit.
_allowed_origins = ["http://localhost:3000", "http://127.0.0.1:3000"]
if settings.frontend_origin:
    _allowed_origins.append(settings.frontend_origin)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# â”€â”€ Generic error handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Unhandled exceptions return a clean message instead of leaking internals
# (stack traces, file paths) to the client. HTTPException and RateLimitExceeded
# have their own more-specific handlers and are unaffected.
@app.exception_handler(Exception)
async def _unhandled_exception_handler(request: Request, exc: Exception):
    print(f"[unhandled] {request.method} {request.url.path}: {type(exc).__name__}: {exc}")
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


# â”€â”€ Admin gate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Guards expensive maintenance endpoints. When ADMIN_TOKEN is unset the gate
# fails closed (403) â€” so these are dead in prod unless deliberately enabled.
def require_admin(x_admin_token: Optional[str] = Header(default=None)):
    expected = settings.admin_token
    if not expected or not x_admin_token or not secrets.compare_digest(x_admin_token, expected):
        raise HTTPException(status_code=403, detail="Admin access required")
    return True


# â”€â”€ Upload helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
def _safe_display_name(name: Optional[str]) -> str:
    """Sanitize a client-supplied filename for DISPLAY/storage only â€” never for
    the on-disk path. Strips any directory components and disallowed chars."""
    if not name:
        return "upload.pdf"
    base = os.path.basename(name.replace("\\", "/"))
    base = re.sub(r"[^A-Za-z0-9._ -]", "_", base).strip()
    base = base[:120]
    return base or "upload.pdf"

# â”€â”€ Services (initialized once at startup) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

db = Database()
agent = PDFAnalysisAgent()
contradiction_agent = ContradictionAgent()
hypothesis_agent = HypothesisAgent()
importer = PaperImporter()
monitor = MonitoringAgent()


# â”€â”€ Insight feed cache â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Simple in-process TTL cache â€” no new DB table needed.
# The feed is pure DB reads so it's cheap to recompute, but repeated
# page loads from the frontend shouldn't re-run the same queries on
# every request. Cache holds the last assembled result and its timestamp.
# Invalidated explicitly whenever a paper is added or deleted.

import time as _time

_INSIGHT_CACHE_TTL = 2 * 60 * 60  # 2 hours in seconds

# Per-user insight cache: user_id -> {"payload": list, "ts": float}. Keyed by
# user so one account's feed is never served to another.
_insight_cache: dict[str, dict] = {}


def _invalidate_insight_cache():
    """Call this any time the library changes so the feed reflects it
    immediately. Clears every user's entry (cheap to rebuild)."""
    _insight_cache.clear()


# â”€â”€ Request/Response Models â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

class SearchRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=settings.max_query_len)
    n_results: int = Field(10, ge=1, le=50)
    paper_id: Optional[str] = None


class AskRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=settings.max_query_len)
    paper_id: Optional[str] = None


class ContradictionRequest(BaseModel):
    paper_ids: Optional[list[str]] = None
    similarity_threshold: float = Field(0.5, ge=0.0, le=1.0)
    max_pairs: int = Field(15, ge=1, le=50)


class HypothesisRequest(BaseModel):
    research_question: Optional[str] = Field(None, max_length=settings.max_query_len)
    paper_ids: Optional[list[str]] = None
    num_hypotheses: int = Field(5, ge=1, le=10)
    # Pass refresh=true to bypass the output cache and force regeneration.
    # Useful when you've added papers or run a new contradiction scan and
    # want hypotheses that reflect the updated conflict set immediately
    # (the cache would normally auto-invalidate via the watermark, but
    # explicit refresh is available as an escape hatch).
    refresh: bool = False


class ImportSearchRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=500)
    sources: list[str] = ["arxiv", "semantic_scholar"]
    max_per_source: int = Field(5, ge=1, le=20)


class ImportAddRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=1000)
    authors: list[str]
    abstract: str
    year: Optional[int] = None
    source: str
    source_id: str
    doi: Optional[str] = None
    pdf_url: Optional[str] = None
    url: str


class ImportLookupRequest(BaseModel):
    identifier: str = Field(..., min_length=1, max_length=500)  # arXiv ID, DOI, or URL


class MonitorRequest(BaseModel):
    topics: list[dict]  # [{name, keywords, sources}]
    email: Optional[str] = None
    relevance_threshold: float = Field(0.3, ge=0.0, le=1.0)
    max_per_source: int = Field(5, ge=1, le=20)


# â”€â”€ Background task helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _analyze_paper_bg(paper_id: str, api_key: str | None = None, model: str | None = None):
    """Background task for paper analysis. Runs on the caller's BYOK key when
    provided, else the server key; `model` is the resolved, tier-capped model."""
    try:
        agent.analyze_paper(paper_id, api_key=api_key, model=model)
    except Exception as e:
        print(f"Background analysis failed for {paper_id}: {e}")


# â”€â”€ Auth & Settings (BYOK) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=8, max_length=200)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=1, max_length=200)


class SettingsUpdateRequest(BaseModel):
    # All optional â€” only provided fields change. For api_key and digest_email,
    # an empty string "" means "clear it"; omitting the field means "leave it".
    model: Optional[str] = Field(None, max_length=80)
    digest_email: Optional[str] = Field(None, max_length=320)
    library_name: Optional[str] = Field(None, max_length=120)
    api_key: Optional[str] = Field(None, max_length=200)


class TestKeyRequest(BaseModel):
    # If omitted, the stored key is tested instead.
    api_key: Optional[str] = Field(None, max_length=200)


def _set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=settings.session_cookie_name,
        value=token,
        httponly=True,                      # JS can't read it
        secure=settings.cookie_secure,      # https-only in prod (env-toggled)
        samesite=settings.cookie_samesite,  # "lax" â€” blocks cross-site CSRF
        max_age=settings.session_ttl_days * 24 * 3600,
        path="/",
    )


def _public_user(user: User) -> dict:
    """User shape safe to return to the client â€” never the password hash or
    the encrypted/decrypted API key. has_api_key is a boolean only."""
    return {
        "id": user.id,
        "email": user.email,
        "model": user.model,
        "digest_email": user.digest_email,
        "library_name": user.library_name,
        "has_api_key": bool(user.api_key_encrypted),
        "free_actions_used": user.free_actions_used,
        "free_action_limit": settings.free_action_limit,
        "free_sonnet_used": user.free_sonnet_used,
        "free_sonnet_limit": settings.free_sonnet_limit,
    }


def _resolve_model_and_meter(user: User) -> str:
    """Resolve the model for this request and enforce the free-tier limits on
    the SERVER key (BYOK is uncapped):
      â€¢ a total of free_action_limit actions (Haiku + Sonnet combined), then 402
      â€¢ of those, at most free_sonnet_limit may be Sonnet, then 402 (Haiku stays
        available until the total is reached)
    The 402 is raised BEFORE any LLM call, so hitting a limit costs no tokens.
    Opus on the server key was already floored to Haiku by resolve_user_model."""
    model = authlib.resolve_user_model(user)
    if authlib.user_has_own_key(user):
        return model
    if user.free_actions_used >= settings.free_action_limit:
        raise HTTPException(
            status_code=402,
            detail=(f"Free limit reached ({settings.free_action_limit} actions). "
                    "Add your own Anthropic API key in Settings to keep going."),
        )
    is_sonnet = authlib.model_tier(model) == "sonnet"
    if is_sonnet and user.free_sonnet_used >= settings.free_sonnet_limit:
        raise HTTPException(
            status_code=402,
            detail=(f"Free Sonnet limit reached ({settings.free_sonnet_limit}). "
                    "Add your own Anthropic API key for more â€” Haiku stays available."),
        )
    db.increment_usage(user.id, is_sonnet)
    return model


def _require_owned_paper(paper_id: str, user: User) -> Paper:
    """Fetch a paper and enforce ownership. Returns 404 (not 403) on a missing
    paper OR one owned by someone else, so the API never reveals that a given
    paper id exists in another user's library."""
    paper = db.get_paper(paper_id)
    if not paper or paper.user_id != user.id:
        raise HTTPException(status_code=404, detail="Paper not found")
    return paper


def _owned_ids(user: User) -> list[str]:
    return db.list_paper_ids_for_user(user.id)


def _scope_ids(user: User, requested: list[str] | None) -> list[str]:
    """Effective paper scope for an aggregate request: the user's papers,
    narrowed to any requested subset. Empty means 'nothing accessible' â€” and
    callers MUST short-circuit on empty rather than pass it down, since the
    agents treat a falsy paper_ids as 'the whole library'."""
    owned = _owned_ids(user)
    if not requested:
        return owned
    owned_set = set(owned)
    return [pid for pid in requested if pid in owned_set]


@app.post("/api/auth/register")
@limiter.limit(settings.rl_register)
def register(request: Request, response: Response, req: RegisterRequest):
    email = req.email.lower().strip()
    if db.get_user_by_email(email):
        raise HTTPException(status_code=409, detail="An account with this email already exists.")
    user = db.create_user(email, authlib.hash_password(req.password))
    # The very first account adopts any pre-auth (unowned) papers, so existing
    # test data isn't stranded once scoping turns on. Fires exactly once.
    if db.count_users() == 1:
        db.adopt_orphan_papers(user.id)
    token = authlib.new_session_token()
    db.create_session(user.id, token, authlib.session_expiry_iso())
    _set_session_cookie(response, token)
    return {**_public_user(user), "session_token": token}


@app.post("/api/auth/login")
@limiter.limit(settings.rl_login)
def login(request: Request, response: Response, req: LoginRequest):
    email = req.email.lower().strip()
    user = db.get_user_by_email(email)
    # Same error whether the email is unknown or the password is wrong â€” don't
    # leak which emails have accounts.
    if not user or not authlib.verify_password(req.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password.")
    token = authlib.new_session_token()  # fresh token on every login (rotation)
    db.create_session(user.id, token, authlib.session_expiry_iso())
    _set_session_cookie(response, token)
    return {**_public_user(user), "session_token": token}


@app.post("/api/auth/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get(settings.session_cookie_name)
    if token:
        db.delete_session(token)
    response.delete_cookie(settings.session_cookie_name, path="/")
    return {"status": "logged_out"}


@app.post("/api/auth/logout-all")
def logout_all(response: Response, user: User = Depends(authlib.get_current_user)):
    """Invalidate every session for this user (e.g. after a suspected leak)."""
    db.delete_sessions_for_user(user.id)
    response.delete_cookie(settings.session_cookie_name, path="/")
    return {"status": "all_sessions_revoked"}


@app.get("/api/auth/me")
def auth_me(user: User = Depends(authlib.get_current_user)):
    return _public_user(user)


@app.get("/api/settings")
def get_settings(user: User = Depends(authlib.get_current_user)):
    data = _public_user(user)
    # Show only a masked placeholder when a key is stored â€” never decrypt for
    # display, so the plaintext key is never sent back to the client.
    data["api_key_masked"] = "â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢" if user.api_key_encrypted else None
    data["allowed_models"] = [
        {"id": mid, "label": info["label"], "tier": info["tier"]}
        for mid, info in settings.ALLOWED_MODELS.items()
    ]
    return data


@app.put("/api/settings")
def update_settings(req: SettingsUpdateRequest, user: User = Depends(authlib.get_current_user)):
    updates: dict = {}
    if req.model is not None:
        if req.model not in settings.ALLOWED_MODELS:
            raise HTTPException(status_code=400, detail="Unknown model.")
        updates["model"] = req.model
    if req.library_name is not None:
        updates["library_name"] = req.library_name
    if req.digest_email is not None:
        updates["digest_email"] = req.digest_email.strip() or None
    if req.api_key is not None:
        key = req.api_key.strip()
        updates["api_key_encrypted"] = authlib.encrypt_api_key(key) if key else None

    db.update_user_settings(user.id, **updates)
    refreshed = db.get_user_by_id(user.id)
    return _public_user(refreshed)


@app.post("/api/settings/test-key")
def test_api_key(req: TestKeyRequest, user: User = Depends(authlib.get_current_user)):
    """Validate an Anthropic key WITHOUT spending tokens: models.list() is an
    auth check, not an inference call. Never echoes the key back."""
    key = (req.api_key or "").strip()
    if not key:
        if not user.api_key_encrypted:
            raise HTTPException(status_code=400, detail="No API key provided or stored.")
        key = authlib.decrypt_api_key(user.api_key_encrypted)
    try:
        from anthropic import Anthropic
        Anthropic(api_key=key).models.list(limit=1)
        return {"valid": True}
    except Exception:
        # Don't leak the upstream error verbatim.
        return {"valid": False, "error": "Key was rejected by Anthropic."}


# â”€â”€ Health Check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

@app.get("/health")
@limiter.exempt
def health_root():
    """Bare /health for Render's default health check probe."""
    return {"status": "ok"}


@app.get("/api/health")
@limiter.exempt
def health():
    errors = settings.validate()
    papers = db.list_papers(limit=1000)
    paper_count = len(papers)
    embedding_count = agent.vector_store.count()
    # Library fingerprint: changes whenever papers are added or removed.
    # Frontend uses this as a cache-bust key for contradiction results.
    latest_paper = papers[0].created_at if papers else ""
    fingerprint = f"{paper_count}:{latest_paper}"
    return {
        "status": "ok" if not errors else "degraded",
        "errors": errors,
        "papers": paper_count,
        "embeddings": embedding_count,
        "library_fingerprint": fingerprint,
    }


@app.post("/api/admin/fix-abstracts", dependencies=[Depends(require_admin)])
def fix_abstracts():
    """
    Re-fetch full abstracts for arXiv papers whose stored abstract is short
    (under 400 chars) â€” these were truncated at import time by the [:300] slice
    that previously existed in the search/lookup response serializers.

    Safe to run multiple times â€” only updates papers where the new abstract
    is longer than what's stored.
    """
    papers = db.list_papers(limit=200)
    updated = 0
    for p in papers:
        if p.source != "arxiv":
            continue
        if p.abstract and len(p.abstract) >= 400:
            continue
        # Re-fetch from arXiv using the stored arxiv_id or title lookup
        try:
            result = importer.lookup(p.title)
            if result and result.abstract and len(result.abstract) > len(p.abstract or ""):
                clean = _normalize_abstract(result.abstract)
                import psycopg2
                conn = psycopg2.connect(db._dsn)
                cur = conn.cursor()
                cur.execute("UPDATE papers SET abstract=%s WHERE id=%s", (clean, p.id))
                conn.commit()
                cur.close()
                conn.close()
                updated += 1
                print(f"Fixed abstract for: {p.title[:60]}")
        except Exception as e:
            print(f"Failed to fix abstract for {p.title[:40]}: {e}")
    return {"updated": updated, "checked": sum(1 for p in papers if p.source == "arxiv")}



def normalize_abstracts():
    """
    One-time migration: normalize abstracts already in the DB.

    arXiv and Semantic Scholar return abstracts with embedded newlines
    (line-wrapped at ~80 chars). This cleans all existing records so
    the UI truncates at sentence boundaries rather than mid-word.

    Safe to run multiple times â€” idempotent.
    """
    import psycopg2
    from psycopg2.extras import RealDictCursor
    conn = psycopg2.connect(db._dsn, cursor_factory=RealDictCursor)
    cur = conn.cursor()
    cur.execute("SELECT id, abstract FROM papers WHERE abstract IS NOT NULL")
    papers = cur.fetchall()
    updated = 0
    for row in papers:
        cleaned = _normalize_abstract(row["abstract"])
        if cleaned != row["abstract"]:
            cur.execute("UPDATE papers SET abstract=%s WHERE id=%s", (cleaned, row["id"]))
            updated += 1
    conn.commit()
    cur.close()
    conn.close()
    return {"updated": updated, "total": len(papers)}


# â”€â”€ Papers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

@app.get("/api/papers")
def list_papers(limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0),
                user: User = Depends(authlib.get_current_user)):
    papers = db.list_papers(limit=limit, offset=offset, user_id=user.id)
    results = []
    for p in papers:
        analyses = db.get_analyses_for_paper(p.id)
        claims = db.get_claims_for_paper(p.id)
        results.append({
            "id": p.id,
            "title": p.title,
            "authors": p.authors,
            "abstract": p.abstract or "",
            "year": p.year,
            "source": p.source,
            "page_count": p.page_count,
            "created_at": p.created_at,
            "analysis_types": [a.analysis_type for a in analyses],
            "chunk_count": len(claims),  # extracted claims count â€” meaningful to display
        })
    return results


import re as _re

def _strip_scaffolding(text: str) -> str:
    """Remove prompt-scaffolding labels and unrendered markdown syntax from
    stored analysis content. The UI renders this as plain text, so leftover
    ## headers and **bold** markers from the LLM's output show up raw."""
    # Strip lines that are purely uppercase labels (TITLE:, OBJECTIVE:, etc.)
    lines = text.split("\n")
    cleaned = []
    for line in lines:
        stripped = line.strip()
        # Skip standalone scaffolding header lines
        if _re.match(r"^(TITLE|OBJECTIVE|APPROACH|FINDINGS|METHODS|LIMITATIONS|KEY CLAIMS|RESEARCH GAPS|SUMMARY|SECTION)\s*:", stripped, _re.IGNORECASE):
            continue
        # Strip leading ## / ### markdown headers (keep the text after)
        line = _re.sub(r"^#{1,6}\s+", "", line)
        # Convert **bold** and *italic* markdown to plain text
        line = _re.sub(r"\*\*(.+?)\*\*", r"\1", line)
        line = _re.sub(r"(?<!\*)\*(?!\*)(.+?)\*(?!\*)", r"\1", line)
        cleaned.append(line)
    return "\n".join(cleaned).strip()


@app.get("/api/papers/{paper_id}")
def get_paper(paper_id: str, user: User = Depends(authlib.get_current_user)):
    paper = _require_owned_paper(paper_id, user)
    analyses = db.get_analyses_for_paper(paper_id)
    chunks = db.get_chunks_for_paper(paper_id)
    return {
        "id": paper.id,
        "title": paper.title,
        "authors": paper.authors,
        "abstract": paper.abstract,
        "year": paper.year,
        "source": paper.source,
        "page_count": paper.page_count,
        "created_at": paper.created_at,
        "chunk_count": len(chunks),
        "analyses": [
            {
                "id": a.id,
                "type": a.analysis_type,
                "content": _strip_scaffolding(a.content),
                "created_at": a.created_at,
            }
            for a in analyses
        ],
    }


@app.delete("/api/papers/{paper_id}")
def delete_paper(paper_id: str, user: User = Depends(authlib.get_current_user)):
    _require_owned_paper(paper_id, user)
    # Capture this paper's claim IDs before the cascade removes them,
    # so we can also purge relationships that reference them.
    claim_ids = [c.id for c in db.get_claims_for_paper(paper_id)]
    # Remove from vector store first, then DB (cascade deletes chunks, analyses, claims)
    agent.vector_store.delete_paper_chunks(paper_id)
    db.delete_paper(paper_id)
    # Purge relationships referencing this paper's claims (no FK cascade on those)
    if claim_ids:
        import psycopg2
        conn = psycopg2.connect(db._dsn)
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM relationships WHERE claim_lo = ANY(%s) OR claim_hi = ANY(%s)",
            (claim_ids, claim_ids),
        )
        conn.commit()
        cur.close()
        conn.close()
    _invalidate_insight_cache()
    return {"status": "deleted", "id": paper_id}


@app.get("/api/papers/{paper_id}/status")
def paper_status(paper_id: str, user: User = Depends(authlib.get_current_user)):
    """Check analysis completion status."""
    paper = _require_owned_paper(paper_id, user)
    analyses = db.get_analyses_for_paper(paper_id)
    analysis_types = [a.analysis_type for a in analyses]
    all_types = {"summary", "methods", "findings", "limitations", "key_claims", "research_gaps"}
    return {
        "id": paper_id,
        "title": paper.title,
        "analysis_count": len(analyses),
        "analysis_types": analysis_types,
        "complete": all_types.issubset(set(analysis_types)),
        "missing": list(all_types - set(analysis_types)),
    }


# â”€â”€ Upload & Analyze â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

@app.post("/api/papers/upload")
@limiter.limit(settings.rl_upload)
async def upload_paper(
    request: Request,
    file: UploadFile = File(...),
    background_tasks: BackgroundTasks = BackgroundTasks(),
    user: User = Depends(authlib.get_current_user),
):
    # Cheap first gate: extension.
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files accepted")

    # Bounded read â€” never pull an unbounded upload into memory. Abort as soon
    # as the running total crosses the cap rather than reading the whole thing.
    max_bytes = settings.max_upload_bytes
    buf = bytearray()
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        buf.extend(chunk)
        if len(buf) > max_bytes:
            raise HTTPException(
                status_code=413,
                detail=f"File exceeds the {max_bytes // (1024 * 1024)} MB limit.",
            )
    content = bytes(buf)

    # Validate it is actually a PDF, not arbitrary bytes renamed .pdf.
    if b"%PDF-" not in content[:1024]:
        raise HTTPException(status_code=400, detail="File is not a valid PDF.")

    # NEVER trust the client filename for the on-disk path (path traversal:
    # "../../api.py" would escape the upload dir). Write under a generated name
    # and keep a sanitized original only as a display string.
    display_name = _safe_display_name(file.filename)
    save_path = UPLOAD_DIR / f"{uuid.uuid4().hex}.pdf"

    # Defense in depth: confirm the resolved path stays inside UPLOAD_DIR.
    if UPLOAD_DIR.resolve() not in save_path.resolve().parents:
        raise HTTPException(status_code=400, detail="Invalid upload path.")

    save_path.write_bytes(content)

    # Ingest (extract + chunk + embed) â€” this is fast enough to do inline
    user_key = authlib.resolve_user_api_key(user)
    model = _resolve_model_and_meter(user)
    paper = agent.ingest_pdf(save_path, filename=display_name, api_key=user_key, model=model)

    # Dedup is per-user: a paper already in THIS user's library is a duplicate;
    # the same paper in another user's library is not (each owner keeps a copy).
    existing = db.find_duplicate(paper.title, doi=paper.doi, arxiv_id=paper.arxiv_id)
    if existing and existing.id != paper.id and existing.user_id == user.id:
        agent.vector_store.delete_paper_chunks(paper.id)
        db.delete_paper(paper.id)
        try:
            save_path.unlink(missing_ok=True)  # drop the redundant file copy
        except OSError:
            pass
        return {
            "id": existing.id,
            "title": existing.title,
            "status": "duplicate",
            "message": f"This paper is already in your library: \"{existing.title}\".",
        }

    # Stamp ownership before analysis kicks off.
    db.set_paper_owner(paper.id, user.id)

    # Analyze in background (parallel â€” ~5x faster than sequential loop)
    background_tasks.add_task(_analyze_paper_bg, paper.id, user_key, model)
    _invalidate_insight_cache()

    return {
        "id": paper.id,
        "title": paper.title,
        "authors": paper.authors,
        "year": paper.year,
        "page_count": paper.page_count,
        "status": "analyzing",
        "message": "Paper uploaded and ingested. Analysis running in background. "
                   "Poll /api/papers/{id}/status to check progress.",
    }


@app.post("/api/papers/{paper_id}/reanalyze")
def reanalyze_paper(paper_id: str, background_tasks: BackgroundTasks = BackgroundTasks(),
                    user: User = Depends(authlib.get_current_user)):
    """Re-run analysis on an already-ingested paper."""
    paper = _require_owned_paper(paper_id, user)
    # Invalidate cached claims + their relationships so they're freshly derived
    claim_ids = [c.id for c in db.get_claims_for_paper(paper_id)]
    db.delete_claims_for_paper(paper_id)
    if claim_ids:
        import psycopg2
        conn = psycopg2.connect(db._dsn)
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM relationships WHERE claim_lo = ANY(%s) OR claim_hi = ANY(%s)",
            (claim_ids, claim_ids),
        )
        conn.commit()
        cur.close()
        conn.close()
    background_tasks.add_task(_analyze_paper_bg, paper_id, authlib.resolve_user_api_key(user), _resolve_model_and_meter(user))
    return {"id": paper_id, "status": "analyzing"}


# â”€â”€ Search & QA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

@app.post("/api/search")
@limiter.limit(settings.rl_search)
def search_papers(request: Request, req: SearchRequest,
                  user: User = Depends(authlib.get_current_user)):
    """
    Semantic search across the paper library.

    Relevance fields returned per result:
      relevance_tier  â€” "highly_relevant" | "related" | "tangential"
                        Defined thresholds on cosine distance, calibrated for
                        MiniLM on narrow-domain academic text. Honest and
                        explainable; replaces the previous fake-precise percentage.
      relevance_score â€” raw cosine distance in [0, 1] (lower = more similar).
                        Exposed so the frontend can sort or filter if needed,
                        but not intended for display to end users.

    Thresholds (from settings):
      < 0.20  â†’ highly_relevant
      < 0.40  â†’ related
      >= 0.40 â†’ tangential
    """
    # Scope to the user's own papers. A passed paper_id is $and'd with this set,
    # so requesting another user's paper id simply returns nothing.
    owned_ids = db.list_paper_ids_for_user(user.id)
    results = agent.vector_store.search(
        query=req.query,
        n_results=req.n_results,
        paper_id=req.paper_id,
        paper_ids=owned_ids,
    )

    response = []
    for r in results:
        paper = db.get_paper(r.paper_id)
        response.append({
            "paper_id": r.paper_id,
            "paper_title": paper.title if paper else "Unknown",
            "section": r.section,
            "text": r.text[:800],
            "relevance_tier": settings.relevance_tier(r.score),
            "relevance_score": round(r.score, 4),
        })
    return response


@app.post("/api/ask")
@limiter.limit(settings.rl_ask)
def ask_question(request: Request, req: AskRequest,
                 user: User = Depends(authlib.get_current_user)):
    answer = agent.ask(req.question, paper_id=req.paper_id, paper_ids=_owned_ids(user), api_key=authlib.resolve_user_api_key(user), model=_resolve_model_and_meter(user))
    return {"answer": answer}


# â”€â”€ Contradictions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

@app.get("/api/contradictions/count")
def contradiction_count(user: User = Depends(authlib.get_current_user)):
    """Lightweight endpoint â€” returns cached relationship counts with no LLM calls."""
    owned = _owned_ids(user)
    rels = db.list_relationships(paper_ids=owned) if owned else []
    counts = {"contradiction": 0, "support": 0, "nuance": 0, "unrelated": 0}
    for r in rels:
        if r.relationship in counts:
            counts[r.relationship] += 1
    last = max((r.created_at for r in rels), default=None) if rels else None
    return {"counts": counts, "total": len(rels), "last_scanned": last}


@app.get("/api/contradictions")
def list_contradictions(user: User = Depends(authlib.get_current_user)):
    """
    Return the full persisted relationship set â€” every relationship ever
    judged, reconstructed into the same shape the scan POST returns.

    This is the source of truth for the conflict map: it shows accumulated
    knowledge across all scans, keeping it consistent with the dashboard's
    /api/contradictions/count (which reads the same table). Pure DB read,
    zero LLM calls. "unrelated" and "error" rows are excluded from the main
    view but still counted by the count endpoint.
    """
    owned = _owned_ids(user)
    if not owned:
        return []
    rels = db.list_relationships(paper_ids=owned)

    # Build a claim-id -> claim object map once (DB read, no LLM).
    claim_by_id = {}
    claim_paper_title = {}
    for p in db.list_papers(limit=200, user_id=user.id):
        for c in db.get_claims_for_paper(p.id):
            claim_by_id[c.id] = c
            claim_paper_title[c.id] = p.title

    out = []
    for r in rels:
        if r.relationship in ("error", "unrelated"):
            continue
        a = claim_by_id.get(r.claim_lo)
        b = claim_by_id.get(r.claim_hi)
        if not a or not b:
            continue  # claim was deleted; skip orphaned relationship
        out.append({
            "id": r.id,
            "relationship": r.relationship,
            "category": r.category,
            "explanation": r.explanation,
            "resolution": r.resolution,
            "stronger_evidence": r.stronger_evidence,
            "similarity": round(r.similarity, 3),
            "claim_a": {
                "paper_id": a.paper_id,
                "paper_title": claim_paper_title.get(a.id, "Unknown paper"),
                "text": a.text,
                "confidence": a.confidence,
            },
            "claim_b": {
                "paper_id": b.paper_id,
                "paper_title": claim_paper_title.get(b.id, "Unknown paper"),
                "text": b.text,
                "confidence": b.confidence,
            },
            "created_at": r.created_at,
        })

    # Sort: contradictions first, then nuance, then support; newest within each.
    order = {"contradiction": 0, "nuance": 1, "support": 2}
    out.sort(key=lambda x: (order.get(x["relationship"], 9), x["created_at"] or ""), reverse=False)
    return out


@app.post("/api/contradictions")
@limiter.limit(settings.rl_contradictions)
def run_contradictions(request: Request, req: ContradictionRequest,
                       user: User = Depends(authlib.get_current_user)):
    scope = _scope_ids(user, req.paper_ids)
    if not scope:
        return []
    results = contradiction_agent.run_contradiction_scan(
        paper_ids=scope,
        similarity_threshold=req.similarity_threshold,
        max_pairs=req.max_pairs,
        api_key=authlib.resolve_user_api_key(user),
        model=_resolve_model_and_meter(user),
    )
    # Invalidate insight cache so research wire reflects new relationships immediately
    _invalidate_insight_cache()

    return [
        {
            "id": r.id,
            "relationship": r.relationship,
            "category": r.category,
            "explanation": r.explanation,
            "resolution": r.resolution,
            "stronger_evidence": r.stronger_evidence,
            "similarity": round(r.similarity, 3),
            "claim_a": {
                "paper_id": r.claim_a.paper_id,
                "paper_title": r.claim_a.paper_title,
                "text": r.claim_a.text,
                "confidence": r.claim_a.confidence,
            },
            "claim_b": {
                "paper_id": r.claim_b.paper_id,
                "paper_title": r.claim_b.paper_title,
                "text": r.claim_b.text,
                "confidence": r.claim_b.confidence,
            },
            "created_at": r.created_at,
        }
        for r in results
    ]


# â”€â”€ Hypotheses â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

@app.get("/api/hypotheses")
def get_cached_hypotheses(user: User = Depends(authlib.get_current_user)):
    """
    Return the most recent cached hypotheses for this user.
    Zero LLM calls — pure DB read from hypothesis_cache table.
    Returns [] if no cache exists yet.
    """
    paper_ids = db.list_paper_ids_for_user(user.id)
    entries = db.list_hypothesis_cache(paper_ids)
    if not entries:
        return []
    # Return the most recent entry's hypotheses
    latest = entries[0]
    return latest["hypotheses"]


@app.post("/api/hypotheses")
@limiter.limit(settings.rl_hypotheses)
def generate_hypotheses(request: Request, req: HypothesisRequest,
                        user: User = Depends(authlib.get_current_user)):
    """
    Generate testable hypotheses from the library.

    Response changes from previous version:
      - source_conflicts: list of validated relationship IDs the hypothesis draws from
      - grounding: "detected_conflicts" | "single_paper_gaps"
      - novelty_score: cosine distance from nearest library chunk (0â€“1, higher = more novel)
      - novelty_tier: "high" | "medium" | "low" | "unknown"
      - impact: REMOVED (no reliable signal â€” no citation data in DB)
      - novelty_explanation: REMOVED (replaced by novelty_score + novelty_tier)

    Pass refresh=true to bypass the output cache.
    Cache auto-invalidates when a new contradiction scan runs.
    """
    scope = _scope_ids(user, req.paper_ids)
    if not scope:
        return []
    hypotheses = hypothesis_agent.generate(
        research_question=req.research_question,
        paper_ids=scope,
        num_hypotheses=req.num_hypotheses,
        force_refresh=req.refresh,
        api_key=authlib.resolve_user_api_key(user),
        model=_resolve_model_and_meter(user),
    )

    return [
        {
            "id": h.id,
            "statement": h.statement,
            "rationale": h.rationale,
            "source_conflicts": h.source_conflicts,
            "supporting_papers": h.supporting_papers,
            "methodology": h.methodology,
            "challenges": h.challenges,
            "novelty_score": h.novelty_score,
            "novelty_tier": h.novelty_tier,
            "grounding": h.grounding,
            "research_question": h.research_question,
            "created_at": h.created_at,
        }
        for h in hypotheses
    ]


# â”€â”€ Import â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

@app.post("/api/import/search")
@limiter.limit(settings.rl_import_search)
def import_search(request: Request, req: ImportSearchRequest,
                  user: User = Depends(authlib.get_current_user)):
    results = importer.search(
        query=req.query,
        sources=req.sources,
        max_per_source=req.max_per_source,
    )

    return [
        {
            "title": r.title,
            "authors": r.authors,
            "abstract": r.abstract or "",
            "year": r.year,
            "source": r.source,
            "source_id": r.source_id,
            "doi": r.doi,
            "pdf_url": r.pdf_url,
            "citation_count": r.citation_count,
            "url": r.url,
        }
        for r in results
    ]


@app.post("/api/import/lookup")
def import_lookup(req: ImportLookupRequest, user: User = Depends(authlib.get_current_user)):
    """Look up a paper by arXiv ID, DOI, or URL."""
    result = importer.lookup(req.identifier)
    if not result:
        raise HTTPException(status_code=404, detail="Paper not found")
    return {
        "title": result.title,
        "authors": result.authors,
        "abstract": result.abstract or "",
        "year": result.year,
        "source": result.source,
        "source_id": result.source_id,
        "doi": result.doi,
        "pdf_url": result.pdf_url,
        "citation_count": result.citation_count,
        "url": result.url,
    }


def _normalize_abstract(text: str | None) -> str:
    """
    Clean abstracts from arXiv / Semantic Scholar before storing.

    External APIs return abstracts with:
    - Embedded newlines mid-sentence (arXiv wraps at ~80 chars)
    - Multiple consecutive spaces
    - Leading/trailing whitespace

    We replace newlines with spaces and collapse runs so the abstract reads
    as a single clean paragraph. This fixes mid-word truncation in the UI
    that occurred when the truncation point landed on a newline.
    """
    if not text:
        return ""
    import re as _re
    text = text.replace("\r\n", " ").replace("\n", " ").replace("\r", " ")
    text = _re.sub(r"[ \t]+", " ", text)
    return text.strip()


@app.post("/api/import/add")
@limiter.limit(settings.rl_import_add)
def import_add(
    request: Request,
    req: ImportAddRequest,
    background_tasks: BackgroundTasks = BackgroundTasks(),
    user: User = Depends(authlib.get_current_user),
):
    from agents.paper_import import ImportResult

    result = ImportResult(
        title=req.title,
        authors=req.authors,
        abstract=req.abstract,
        year=req.year,
        source=req.source,
        source_id=req.source_id,
        doi=req.doi,
        pdf_url=req.pdf_url,
        citation_count=None,
        url=req.url,
    )

    # Dedup BEFORE downloading â€” per user (same paper in another user's library
    # is not a duplicate for this user).
    arxiv_id = req.source_id if req.source == "arxiv" else None
    existing = db.find_duplicate(req.title, doi=req.doi, arxiv_id=arxiv_id)
    if existing and existing.user_id == user.id:
        return {
            "id": existing.id,
            "title": existing.title,
            "status": "duplicate",
            "message": f"This paper is already in your library: \"{existing.title}\".",
        }

    # Download PDF
    pdf_path = importer.download_pdf(result)
    if not pdf_path:
        raise HTTPException(
            status_code=400,
            detail="PDF download failed. The paper may not have an open-access PDF.",
        )

    # Ingest into library
    user_key = authlib.resolve_user_api_key(user)
    model = _resolve_model_and_meter(user)
    paper = agent.ingest_pdf(pdf_path, filename=pdf_path.name, api_key=user_key, model=model)

    # Update metadata from the source (better than what PDF extraction finds),
    # and stamp ownership in the same write.
    import psycopg2
    conn = psycopg2.connect(db._dsn)
    cur = conn.cursor()
    cur.execute(
        "UPDATE papers SET title=%s, authors=%s, abstract=%s, year=%s, source=%s, doi=%s, arxiv_id=%s, user_id=%s WHERE id=%s",
        (req.title, json.dumps(req.authors), _normalize_abstract(req.abstract), req.year,
         req.source, req.doi, arxiv_id, user.id, paper.id),
    )
    conn.commit()
    cur.close()
    conn.close()

    # Analyze in background
    background_tasks.add_task(_analyze_paper_bg, paper.id, user_key, model)
    _invalidate_insight_cache()

    return {
        "id": paper.id,
        "title": req.title,
        "status": "analyzing",
        "message": "Paper imported and queued for analysis.",
    }


# â”€â”€ Monitor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

@app.post("/api/monitor/scan")
@limiter.limit(settings.rl_monitor)
def monitor_scan(request: Request, req: MonitorRequest,
                 user: User = Depends(authlib.get_current_user)):
    topics = [
        MonitorTopic(
            name=t["name"],
            keywords=t["keywords"],
            sources=t.get("sources", ["arxiv", "semantic_scholar"]),
        )
        for t in req.topics
    ]

    results, email_sent, email_error, sources_failed = monitor.run_full_scan(
        topics=topics,
        recipient=req.email,
        max_per_source=req.max_per_source,
        relevance_threshold=req.relevance_threshold,
        user_id=user.id,
        api_key=authlib.resolve_user_api_key(user),
        model=_resolve_model_and_meter(user),
    )

    digests = [
        {
            "topic": r.topic,
            "papers_found": r.papers_found,
            "papers_relevant": r.papers_relevant,
            "scan_time": r.scan_time,
            "papers": [
                {
                    "title": sp.paper.title,
                    "authors": sp.paper.authors,
                    "year": sp.paper.year,
                    "source": sp.paper.source,
                    "abstract": sp.paper.abstract or "",
                    "url": sp.paper.url,
                    "pdf_url": sp.paper.pdf_url,
                    "relevance_score": sp.relevance_score,
                    "relevance_tier": settings.relevance_tier(sp.relevance_score)
                                       if hasattr(settings, "relevance_tier") else None,
                    "relevance_reason": sp.relevance_reason,
                }
                for sp in r.scored_papers
            ],
        }
        for r in results
    ]

    # Wrap digests with truthful email status so the UI never claims a send
    # that didn't actually happen. email_requested lets the UI distinguish
    # "no email entered" from "email entered but failed".
    return {
        "digests": digests,
        "email_requested": bool(req.email),
        "email_sent": email_sent,
        "email_error": email_error,
        "sources_failed": sources_failed,
    }


# â”€â”€ Knowledge Graph â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

class GraphRequest(BaseModel):
    paper_ids: Optional[list[str]] = None
    similarity_threshold: float = 0.40
    max_pairs: int = 120
    # Default False = read-only. Edges are read straight from the persisted
    # `relationships` table (zero LLM calls, no new writes, watermark stays
    # put so viewing the graph never invalidates the hypothesis cache).
    # Pass True to run the live two-stage pipeline, which judges new pairs
    # and writes them through â€” use only to deliberately expand coverage.
    compute: bool = False


def _build_graph_readonly(papers):
    """
    Assemble the graph from the persisted relationships table â€” no agent
    calls, no LLM, no writes. This is the same data the conflict map and
    hypothesis grounding read, so all three stay consistent.

    Claims come from db.get_claims_for_paper (pure DB read). Edges come from
    db.list_relationships scoped to the selected papers. Every paper that has
    a relationship is represented; papers with no detected relationships
    simply have no nodes (same as before â€” isolated claims are hidden).
    """
    scope_ids = [p.id for p in papers]

    # Claim lookup: id -> (claim object, paper title). Pure DB read.
    claim_by_id = {}
    for p in papers:
        for c in db.get_claims_for_paper(p.id):
            claim_by_id[c.id] = (c, p.title)

    rels = db.list_relationships(paper_ids=scope_ids)

    edges = []
    connected_claim_ids = set()
    for r in rels:
        if r.relationship in ("error", "unrelated"):
            continue
        # Both endpoints must resolve to claims inside our scope.
        if r.claim_lo not in claim_by_id or r.claim_hi not in claim_by_id:
            continue
        edges.append({
            "source": r.claim_lo,
            "target": r.claim_hi,
            "relationship": r.relationship,
            "category": r.category,
            "similarity": round(r.similarity, 3),
            "explanation": r.explanation,
        })
        connected_claim_ids.add(r.claim_lo)
        connected_claim_ids.add(r.claim_hi)

    degree: dict[str, int] = {}
    for e in edges:
        degree[e["source"]] = degree.get(e["source"], 0) + 1
        degree[e["target"]] = degree.get(e["target"], 0) + 1

    nodes = []
    for cid in connected_claim_ids:
        c, title = claim_by_id[cid]
        nodes.append({
            "id": c.id,
            "claim": c.text,
            "paper_id": c.paper_id,
            "paper_title": title,
            "section": c.section,
            "confidence": c.confidence,
            "degree": degree.get(c.id, 0),
        })

    return {
        "nodes": nodes,
        "edges": edges,
        "papers": [{"id": p.id, "title": p.title} for p in papers],
    }


def _build_graph_compute(req, papers, api_key: str | None = None, model: str | None = None):
    """
    Live pipeline: judge pairs and write them through to the relationships
    table. This is the original behaviour, preserved behind compute=true.

    Coverage guarantee: after selecting the top-N pairs by similarity, we
    check which papers have zero representation and inject their single best
    pair regardless of score, so every paper with claims appears.

    Cost note: judge_pair() reads from the DB cache first. Pairs already
    judged by a previous scan are cache hits; only genuinely new pairs fire
    the LLM judge (and get persisted, moving the relationships watermark).
    """
    # Extract claims (DB-first, zero LLM if already cached)
    all_claims = []
    for paper in papers:
        all_claims.extend(contradiction_agent.extract_claims(paper.id, api_key=api_key, model=model))

    if len(all_claims) < 2:
        return {"nodes": [], "edges": [], "papers": [{"id": p.id, "title": p.title} for p in papers]}

    # Find cross-paper pairs sorted by similarity descending
    all_pairs = contradiction_agent.find_claim_pairs(all_claims, req.similarity_threshold)

    # Select top-N pairs, then apply per-paper fairness guarantee:
    # any paper not yet represented gets its single best pair added back in.
    selected = list(all_pairs[: req.max_pairs])
    represented_papers = set()
    for pair in selected:
        represented_papers.add(pair.claim_a.paper_id)
        represented_papers.add(pair.claim_b.paper_id)

    # All pairs sorted by similarity (best first) for fairness injection
    all_pairs_by_paper: dict[str, list] = {}
    for pair in all_pairs:
        for pid in [pair.claim_a.paper_id, pair.claim_b.paper_id]:
            all_pairs_by_paper.setdefault(pid, []).append(pair)

    # Inject the best pair for any unrepresented paper â€” only if a cross-paper
    # pair exists for it at all (some papers may have no similar claims to others)
    for paper in papers:
        if paper.id not in represented_papers:
            candidates = all_pairs_by_paper.get(paper.id, [])
            if candidates:
                best = candidates[0]
                if best not in selected:
                    selected.append(best)
                    represented_papers.add(best.claim_a.paper_id)
                    represented_papers.add(best.claim_b.paper_id)

    # Judge each selected pair (DB cache hit for most; LLM only for new pairs)
    edges = []
    connected_claim_ids = set()
    for pair in selected:
        result = contradiction_agent.judge_pair(pair, api_key=api_key, model=model)
        if result.relationship == "error":
            continue
        edges.append({
            "source": pair.claim_a.id,
            "target": pair.claim_b.id,
            "relationship": result.relationship,
            "category": result.category,
            "similarity": round(pair.similarity, 3),
            "explanation": result.explanation,
        })
        connected_claim_ids.add(pair.claim_a.id)
        connected_claim_ids.add(pair.claim_b.id)

    # The compute path may have written new relationships via judge_pair.
    # Invalidate the insight cache so the dashboard and research wire reflect
    # them immediately â€” same contract as the contradiction scan endpoint.
    # Without this, expanding the graph can surface contradictions that the
    # dashboard's "top contradiction" card never sees (stale cache).
    _invalidate_insight_cache()

    # Degree count for node sizing
    degree: dict[str, int] = {}
    for e in edges:
        degree[e["source"]] = degree.get(e["source"], 0) + 1
        degree[e["target"]] = degree.get(e["target"], 0) + 1

    nodes = [
        {
            "id": c.id,
            "claim": c.text,
            "paper_id": c.paper_id,
            "paper_title": c.paper_title,
            "section": c.section,
            "confidence": c.confidence,
            "degree": degree.get(c.id, 0),
        }
        for c in all_claims
        if c.id in connected_claim_ids
    ]

    return {
        "nodes": nodes,
        "edges": edges,
        "papers": [{"id": p.id, "title": p.title} for p in papers],
    }


@app.post("/api/graph")
def build_graph(req: GraphRequest, user: User = Depends(authlib.get_current_user)):
    """
    Assemble a claim-level knowledge graph.

    Nodes  = claims extracted from papers (the atomic unit).
    Edges  = relationships between claims (contradiction/support/nuance).

    Read-only by default (compute=false): edges come straight from the
    persisted relationships table â€” zero LLM calls, no writes, and the
    relationships watermark never moves, so viewing the graph will not
    invalidate the hypothesis cache. This keeps the graph, the conflict
    map, and the hypothesis grounding consistent with one another.

    Pass compute=true to run the live two-stage pipeline (judges new pairs,
    writes them through, applies the per-paper fairness guarantee). Use that
    only when deliberately expanding coverage.
    """
    scope = _scope_ids(user, req.paper_ids)
    if len(scope) < 2:
        return {"nodes": [], "edges": [], "papers": []}
    papers = [db.get_paper(pid) for pid in scope]
    papers = [p for p in papers if p is not None]

    if len(papers) < 2:
        return {"nodes": [], "edges": [], "papers": []}

    if req.compute:
        return _build_graph_compute(req, papers, authlib.resolve_user_api_key(user), _resolve_model_and_meter(user))
    return _build_graph_readonly(papers)


# â”€â”€ Insight Feed â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

class InsightRequest(BaseModel):
    paper_ids: Optional[list[str]] = None
    limit: int = 30


@app.post("/api/insights")
def insight_feed(req: InsightRequest, user: User = Depends(authlib.get_current_user)):
    """
    Synthesize a stream of typed insights from existing agent outputs.

    Sources:
      - newest papers         â†’ new_paper insights
      - research_gaps analyses â†’ gap insights
      - relationships table   â†’ contradiction / consensus insights (zero LLM calls)

    Cache: assembled list is cached in-process for _INSIGHT_CACHE_TTL seconds
    (default 2 hours). Invalidated immediately on any paper add or delete so
    the feed always reflects the current library state after writes.
    """
    import uuid

    # â”€â”€ Cache read â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    now = _time.time()
    _entry = _insight_cache.get(user.id)
    if _entry is not None and (now - _entry["ts"]) < _INSIGHT_CACHE_TTL:
        return _entry["payload"][: req.limit]

    owned = _owned_ids(user)

    # â”€â”€ Assemble insights (all DB reads, zero LLM calls) â”€â”€â”€â”€â”€
    insights = []

    # Newest papers
    papers = db.list_papers(limit=10, user_id=user.id)
    for p in papers[:5]:
        insights.append({
            "id": str(uuid.uuid4()),
            "type": "new_paper",
            "headline": p.title,
            "claim": "",
            "detail": (p.abstract or "")[:400],
            "papers": [p.title],
            "created_at": p.created_at,
        })

    def _truncate(s: str, n: int) -> str:
        """Word-boundary truncation â€” avoids cutting headlines mid-word."""
        if len(s) <= n:
            return s
        cut = s[:n].rsplit(" ", 1)[0]
        return cut + "â€¦"

    # Track papers already surfaced by a cross-paper relationship insight, so a
    # single dominant paper does not headline both a contradiction AND a gap.
    # Cross-paper relationships are higher-value signal than single-paper gaps,
    # so they claim their papers first and gaps fill in only what is left.
    papers_in_relationships: set[str] = set()

    # Contradiction / consensus / nuance insights â€” from the relationships table.
    try:
        cached_rels = db.list_relationships(paper_ids=owned) if owned else []
        claim_paper: dict[str, str] = {}
        for p in db.list_papers(limit=200, user_id=user.id):
            for c in db.get_claims_for_paper(p.id):
                claim_paper[c.id] = p.title

        def _strip_paper_prefix(sentence: str, title_a: str, title_b: str) -> str:
            """
            The explanation's first sentence usually leads with a paper title
            ("<Paper> reports that ..."). The paper names are already shown in
            the papers chip, so repeating them in the headline is redundant.
            Strip a leading paper-title prefix (plus a reporting verb) so the
            headline leads with the actual finding.
            """
            s = sentence
            for title in (title_a, title_b):
                if title and title != "Unknown paper" and s.startswith(title):
                    s = s[len(title):].lstrip(" :â€”-")
                    # Drop a leading reporting verb so it reads cleanly.
                    for verb in ("reports that ", "documents that ", "establishes that ",
                                 "finds that ", "shows that ", "demonstrates that ",
                                 "identifies that ", "reports ", "documents ", "finds ",
                                 "shows ", "establishes "):
                        if s.lower().startswith(verb):
                            s = s[len(verb):]
                            break
                    break
            # Capitalise first letter if we stripped into a lowercase start.
            return s[:1].upper() + s[1:] if s else sentence

        for rel in cached_rels:
            if rel.relationship in ("error", "unrelated"):
                continue

            ta = claim_paper.get(rel.claim_lo, "Unknown paper")
            tb = claim_paper.get(rel.claim_hi, "Unknown paper")
            explanation = rel.explanation or ""
            first_sentence = explanation.split(".")[0].strip() if explanation else ""
            first_sentence = _strip_paper_prefix(first_sentence, ta, tb)

            if rel.relationship == "contradiction":
                headline = _truncate(first_sentence, 120) if first_sentence else f"Conflicting findings between {ta[:40]} and {tb[:40]}"
                insights.append({
                    "id": rel.id, "type": "contradiction", "headline": headline,
                    "claim": "", "detail": explanation,
                    "papers": [ta, tb], "created_at": rel.created_at,
                })
                papers_in_relationships.add(ta); papers_in_relationships.add(tb)
            elif rel.relationship == "support":
                headline = _truncate(first_sentence, 120) if first_sentence else f"Converging evidence across {ta[:40]} and {tb[:40]}"
                insights.append({
                    "id": rel.id, "type": "consensus", "headline": headline,
                    "claim": "", "detail": explanation,
                    "papers": [ta, tb], "created_at": rel.created_at,
                })
                papers_in_relationships.add(ta); papers_in_relationships.add(tb)
            elif rel.relationship == "nuance":
                if len(explanation) > 80:
                    headline = _truncate(first_sentence, 120) if first_sentence else f"Boundary condition between {ta[:40]} and {tb[:40]}"
                    insights.append({
                        "id": rel.id, "type": "gap", "headline": headline,
                        "claim": "", "detail": explanation,
                        "papers": [ta, tb], "created_at": rel.created_at,
                    })
                    papers_in_relationships.add(ta); papers_in_relationships.add(tb)
    except Exception as e:
        print(f"Insight relationship read skipped: {e}")

    # Gap insights from research_gaps analyses â€” but ONLY for papers that aren't
    # already represented by a relationship insight above. This is the dedup
    # that stops one paper from headlining multiple cells on the dashboard.
    for p in papers[:8]:
        if p.title in papers_in_relationships:
            continue
        analyses = db.get_analyses_for_paper(p.id)
        for a in analyses:
            if a.analysis_type == "research_gaps" and a.content:
                lines = [l.strip() for l in a.content.strip().split("\n") if l.strip()]
                first = lines[0][:180] if lines else ""
                insights.append({
                    "id": str(uuid.uuid4()),
                    "type": "gap",
                    "headline": first,
                    "claim": "",
                    "detail": a.content[:600],
                    "papers": [p.title],
                    "created_at": p.created_at,
                })
                break

    # Order the feed by signal priority, newest-first within each type.
    # Contradictions are the highest-value signal and must never be buried by a
    # large volume of lower-signal nuance/gap insights â€” otherwise a limit-
    # capped consumer (e.g. the dashboard's top-contradiction card) misses them.
    #
    # Two stable sorts: first by recency (newest first), then by type priority.
    # Python's sort is stable, so the recency order is preserved within each
    # priority group.
    _TYPE_PRIORITY = {
        "contradiction": 0,
        "consensus": 1,
        "hypothesis": 2,
        "gap": 3,
        "new_paper": 4,
    }
    insights.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    insights.sort(key=lambda x: _TYPE_PRIORITY.get(x.get("type", ""), 9))

    # â”€â”€ Cache write â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    _insight_cache[user.id] = {"payload": insights, "ts": _time.time()}

    return insights[: req.limit]
