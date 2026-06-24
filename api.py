"""
ScholarLens API â€" FastAPI Backend

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
import threading
import uuid
import secrets

from fastapi import (
    FastAPI, UploadFile, File, HTTPException, BackgroundTasks, Query,
    Request, Header, Depends, Response,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, EmailStr, field_validator
from typing import Annotated, Optional

from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from config import settings, UPLOAD_DIR
from db import Database, Paper
from db.database import User, MonitorTopicRow
import auth as authlib
from agents import (
    PDFAnalysisAgent,
    ContradictionAgent,
    HypothesisAgent,
    PaperImporter,
    MonitoringAgent,
    MonitorTopic,
)
from agents.paper_import import ImportResult

# â"€â"€ App Setup â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

_is_prod = os.getenv("ENV", "production").lower() == "production"
app = FastAPI(
    title="ScholarLens API",
    description="Research intelligence platform — agentic paper analysis, "
                "cross-paper contradiction detection, and hypothesis generation.",
    version="1.0.0",
    # Docs disabled in production by default. Set ENV=development locally.
    docs_url=None if _is_prod else "/api/docs",
    redoc_url=None if _is_prod else "/api/redoc",
)

# â"€â"€ Rate limiting â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
# Per-IP, keyed on the remote address. Storage is in-memory by default
# (correct for a single instance); set RATE_LIMIT_STORAGE_URI=redis://...
# in settings to share counters across instances. The global default is a
# coarse backstop â€" the meaningful limits are per-endpoint decorators below.
def _rate_key(request: Request) -> str:
    """Use authenticated user ID as the rate-limit key when available,
    falling back to IP for unauthenticated endpoints (login, register).
    This prevents users behind shared NAT from consuming each other's quota."""
    user = getattr(request.state, "user", None)
    if user and hasattr(user, "id"):
        return f"user:{user.id}"
    return get_remote_address(request)

limiter = Limiter(
    key_func=_rate_key,
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


@app.middleware("http")
async def _security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    if settings.cookie_secure:
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response


# â"€â"€ Generic error handler â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
# Unhandled exceptions return a clean message instead of leaking internals
# (stack traces, file paths) to the client. HTTPException and RateLimitExceeded
# have their own more-specific handlers and are unaffected.
@app.exception_handler(Exception)
async def _unhandled_exception_handler(request: Request, exc: Exception):
    print(f"[unhandled] {request.method} {request.url.path}: {type(exc).__name__}: {exc}")
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


# â"€â"€ Admin gate â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
# Guards expensive maintenance endpoints. When ADMIN_TOKEN is unset the gate
# fails closed (403) â€" so these are dead in prod unless deliberately enabled.
def require_admin(x_admin_token: Optional[str] = Header(default=None)):
    expected = settings.admin_token
    if not expected or not x_admin_token or not secrets.compare_digest(x_admin_token, expected):
        raise HTTPException(status_code=403, detail="Admin access required")
    return True


# â"€â"€ Upload helpers â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
def _safe_display_name(name: Optional[str]) -> str:
    """Sanitize a client-supplied filename for DISPLAY/storage only â€" never for
    the on-disk path. Strips any directory components and disallowed chars."""
    if not name:
        return "upload.pdf"
    base = os.path.basename(name.replace("\\", "/"))
    base = re.sub(r"[^A-Za-z0-9._ -]", "_", base).strip()
    base = base[:120]
    return base or "upload.pdf"

# â"€â"€ Services (initialized once at startup) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

db = Database()
agent = PDFAnalysisAgent()
contradiction_agent = ContradictionAgent()
hypothesis_agent = HypothesisAgent()
importer = PaperImporter()
monitor = MonitoringAgent()


# ── Scheduled monitoring job ──────────────────────────────────────────────────
# Runs daily at 6am UTC. For each user with active saved topics and a
# digest_email configured, runs a full scan and sends the email digest.
# APScheduler runs in-process — no broker or worker needed.
# State is in-memory only: if Render restarts, the scheduler restarts too.
# This is fine since UptimeRobot keep-alive pings prevent cold starts during
# active hours, and a missed daily scan is not catastrophic.

def _run_scheduled_monitor():
    """Background job: scan saved topics for all active users."""
    print("[scheduler] Starting daily monitor scan...")
    try:
        users = db.list_users_with_active_topics()
        print(f"[scheduler] Found {len(users)} users with active topics")
        for user in users:
            if not user.digest_email:
                continue
            topics_rows = db.list_monitor_topics(user.id)
            active = [t for t in topics_rows if t.is_active]
            if not active:
                continue
            monitor_topics = [
                MonitorTopic(name=t.name, keywords=t.keywords, sources=t.sources)
                for t in active
            ]
            print(f"[scheduler] Scanning {len(active)} topics for {user.email}")
            try:
                monitor.run_full_scan(
                    topics=monitor_topics,
                    recipient=user.digest_email,
                    user_id=user.id,
                )
                for t in active:
                    db.update_topic_scanned_at(t.id)
            except Exception as e:
                print(f"[scheduler] Scan failed for {user.email}: {e}")
    except Exception as e:
        print(f"[scheduler] Job failed: {e}")


try:
    from apscheduler.schedulers.background import BackgroundScheduler
    _scheduler = BackgroundScheduler(timezone="UTC")
    # MONITOR_HOUR and MONITOR_MINUTE are UTC. Default 9:00 UTC (5am ET / 2am PT /
    # 10am London) — a reasonable wake-up time for global researchers.
    # Set MONITOR_HOUR=6 in Render env to revert to original behavior.
    _monitor_hour = int(os.getenv("MONITOR_HOUR", "9"))
    _monitor_minute = int(os.getenv("MONITOR_MINUTE", "0"))
    _scheduler.add_job(_run_scheduled_monitor, "cron",
                       hour=_monitor_hour, minute=_monitor_minute,
                       id="daily_monitor", replace_existing=True)
    def _cleanup_sessions():
        """Delete expired sessions + stale jobs nightly."""
        # Purge jobs older than 2 hours from the in-memory store
        cutoff = _time.time() - 7200
        stale = [jid for jid, j in list(_jobs.items()) if j.get("created_at", 0) < cutoff]
        for jid in stale:
            j = _jobs.pop(jid, {})
            key = f"{j.get('user_id')}:{j.get('endpoint')}"
            _active_jobs.pop(key, None)
        if stale:
            print(f"[scheduler] Purged {len(stale)} stale jobs")
        try:
            _conn = db._get_conn()
            _cur = _conn.cursor()
            try:
                from datetime import datetime, timezone
                _cur.execute(
                    "DELETE FROM sessions WHERE expires_at < %s",
                    (datetime.now(timezone.utc).isoformat(),),
                )
                deleted = _cur.rowcount
                _conn.commit()
                if deleted:
                    print(f"[scheduler] Cleaned up {deleted} expired sessions")
            finally:
                _cur.close()
                db._put_conn(_conn)
        except Exception as e:
            print(f"[scheduler] Session cleanup failed: {e}")

    _scheduler.add_job(_cleanup_sessions, "cron", hour=3, minute=0,
                       id="session_cleanup", replace_existing=True)
    _scheduler.start()
    print(f"[scheduler] Daily monitor job scheduled ({_monitor_hour:02d}:{_monitor_minute:02d} UTC)")
    print("[scheduler] Nightly session cleanup scheduled (03:00 UTC)")
except ImportError:
    print("[scheduler] apscheduler not installed — scheduled monitoring disabled")
    _scheduler = None


# â"€â"€ Insight feed cache â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
# Simple in-process TTL cache â€" no new DB table needed.
# The feed is pure DB reads so it's cheap to recompute, but repeated
# page loads from the frontend shouldn't re-run the same queries on
# every request. Cache holds the last assembled result and its timestamp.
# Invalidated explicitly whenever a paper is added or deleted.

import time as _time

_INSIGHT_CACHE_TTL = 2 * 60 * 60  # 2 hours in seconds

# Per-user insight cache: user_id -> {"payload": list, "ts": float}. Keyed by
# user so one account's feed is never served to another.
_insight_cache: dict[str, dict] = {}

# Embedding count cache: pgvector COUNT(*) is called on every /health probe
# (Render UptimeRobot pings every minute). Cache for 60s to avoid constant load.
_embedding_count_cache: dict[str, object] = {"value": 0, "ts": 0.0}


def _invalidate_insight_cache():
    """Call this any time the library changes so the feed reflects it
    immediately. Clears every user's entry (cheap to rebuild)."""
    _insight_cache.clear()


# â"€â"€ Request/Response Models â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

class SearchRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=settings.max_query_len)
    n_results: int = Field(10, ge=1, le=50)
    paper_id: Optional[str] = None


class _ChatMessage(BaseModel):
    role: str = Field(..., pattern="^(user|assistant)$")
    content: str = Field(..., min_length=1, max_length=settings.max_query_len)


class AskRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=settings.max_query_len)
    paper_id: Optional[str] = None
    history: Optional[list[_ChatMessage]] = Field(None, max_length=20)


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


_Keyword = Annotated[str, Field(min_length=1, max_length=200)]
_AuthorName = Annotated[str, Field(min_length=1, max_length=300)]

_ALLOWED_SOURCES = {"semantic_scholar", "openalex", "arxiv"}


class ImportAddRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=1000)
    authors: list[_AuthorName] = Field(..., max_length=50)
    abstract: str = Field(..., max_length=10_000)
    year: Optional[int] = Field(None, ge=1000, le=2100)
    source: str = Field(..., max_length=50)
    source_id: str = Field(..., max_length=200)
    doi: Optional[str] = Field(None, max_length=200)
    pdf_url: Optional[str] = Field(None, max_length=2000)
    url: str = Field(..., max_length=2000)

    @field_validator("pdf_url", "url", mode="before")
    @classmethod
    def _safe_url(cls, v):
        if v is None:
            return v
        from urllib.parse import urlparse
        parsed = urlparse(str(v))
        if parsed.scheme not in ("http", "https"):
            raise ValueError("URL must use http or https")
        return v


class ImportLookupRequest(BaseModel):
    identifier: str = Field(..., min_length=1, max_length=500)


class _MonitorTopicInput(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    keywords: list[_Keyword] = Field(..., min_length=1, max_length=10)
    sources: list[str] = Field(default=["semantic_scholar", "openalex", "arxiv"], max_length=3)

    @field_validator("sources", mode="before")
    @classmethod
    def _valid_sources(cls, v):
        bad = [s for s in (v or []) if s not in _ALLOWED_SOURCES]
        if bad:
            raise ValueError(f"Unknown sources: {bad}")
        return v


class MonitorRequest(BaseModel):
    topics: list[_MonitorTopicInput] = Field(..., min_length=1, max_length=10)
    email: Optional[str] = Field(None, max_length=320)
    relevance_threshold: float = Field(0.5, ge=0.0, le=1.0)
    max_per_source: int = Field(5, ge=1, le=20)


class MonitorTopicRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    keywords: list[_Keyword] = Field(..., min_length=1, max_length=10)
    sources: list[str] = Field(
        default=["semantic_scholar", "openalex", "arxiv"],
        max_length=3,
    )

    @field_validator("sources", mode="before")
    @classmethod
    def _valid_sources(cls, v):
        bad = [s for s in (v or []) if s not in _ALLOWED_SOURCES]
        if bad:
            raise ValueError(f"Unknown sources: {bad}")
        return v


# â"€â"€ Background task helper â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

def _analyze_paper_bg(paper_id: str, api_key: str | None = None, model: str | None = None):
    """Background task for paper analysis. Runs on the caller's BYOK key when
    provided, else the server key; `model` is the resolved, tier-capped model."""
    try:
        agent.analyze_paper(paper_id, api_key=api_key, model=model)
    except Exception as e:
        print(f"Background analysis failed for {paper_id}: {e}")


# â"€â"€ Auth & Settings (BYOK) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=8, max_length=200)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=1, max_length=200)


class SettingsUpdateRequest(BaseModel):
    # All optional â€" only provided fields change. For api_key and digest_email,
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
        samesite=settings.cookie_samesite,  # "lax" â€" blocks cross-site CSRF
        max_age=settings.session_ttl_days * 24 * 3600,
        path="/",
    )


def _public_user(user: User) -> dict:
    """User shape safe to return to the client â€" never the password hash or
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
                    "Add your own Anthropic API key for more -- Haiku stays available."),
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
    narrowed to any requested subset. Empty means 'nothing accessible' â€" and
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
        raise HTTPException(status_code=409, detail="Unable to register with this email.")
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
    # Always run bcrypt even when the email is unknown — same wall-clock time
    # as a wrong-password attempt, so timing can't distinguish the two cases.
    if not authlib.verify_password_constant_time(req.password, user.password_hash if user else None):
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
    # Show only a masked placeholder when a key is stored â€" never decrypt for
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
@limiter.limit(settings.rl_test_key)
def test_api_key(request: Request, req: TestKeyRequest, user: User = Depends(authlib.get_current_user)):
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


# â"€â"€ Health Check â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

@app.api_route("/health", methods=["GET", "HEAD"])
@limiter.exempt
def health_root():
    """Bare /health for Render + UptimeRobot health check probes."""
    return {"status": "ok"}


@app.get("/api/health")
@limiter.exempt
def health():
    errors = settings.validate()
    paper_count, latest_paper = db.paper_stats()
    now_ts = _time.time()
    if now_ts - _embedding_count_cache["ts"] > 60:
        _embedding_count_cache["value"] = agent.vector_store.count()
        _embedding_count_cache["ts"] = now_ts
    embedding_count = _embedding_count_cache["value"]
    # Library fingerprint: changes whenever papers are added or removed.
    # Frontend uses this as a cache-bust key for contradiction results.
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
    (under 400 chars) â€" these were truncated at import time by the [:300] slice
    that previously existed in the search/lookup response serializers.

    Safe to run multiple times â€" only updates papers where the new abstract
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
                _conn = db._get_conn()
                _cur = _conn.cursor()
                _cur.execute("UPDATE papers SET abstract=%s WHERE id=%s", (clean, p.id))
                _conn.commit()
                _cur.close()
                db._put_conn(_conn)
                updated += 1
                print(f"Fixed abstract for: {p.title[:60]}")
        except Exception as e:
            print(f"Failed to fix abstract for {p.title[:40]}: {e}")
    return {"updated": updated, "checked": sum(1 for p in papers if p.source == "arxiv")}



# â"€â"€ Papers â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

@app.get("/api/papers")
def list_papers(limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0),
                tag: Optional[str] = Query(None),
                user: User = Depends(authlib.get_current_user)):
    papers = db.list_papers(limit=limit, offset=offset, user_id=user.id)
    if not papers:
        return []
    # Tag filter: narrow to papers that carry the requested tag
    if tag:
        tagged_ids = set(db.list_paper_ids_by_tag(user.id, tag))
        papers = [p for p in papers if p.id in tagged_ids]
    if not papers:
        return []
    paper_ids = [p.id for p in papers]
    # Batch fetch — 3 DB calls instead of 3N (N+1 fix)
    analyses_map = db.get_analyses_for_papers(paper_ids)
    claim_counts = db.get_claim_counts_for_papers(paper_ids)
    tags_map = db.get_tags_for_papers(paper_ids)
    return [
        {
            "id": p.id,
            "title": p.title,
            "authors": p.authors,
            "abstract": p.abstract or "",
            "year": p.year,
            "source": p.source,
            "page_count": p.page_count,
            "created_at": p.created_at,
            "analysis_types": [a.analysis_type for a in analyses_map.get(p.id, [])],
            "chunk_count": claim_counts.get(p.id, 0),
            "tags": tags_map.get(p.id, []),
        }
        for p in papers
    ]

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
    paper_tags = db.get_tags_for_paper(paper_id)
    return {
        "id": paper.id,
        "title": paper.title,
        "authors": paper.authors,
        "abstract": paper.abstract,
        "year": paper.year,
        "source": paper.source,
        "doi": paper.doi,
        "arxiv_id": paper.arxiv_id,
        "page_count": paper.page_count,
        "created_at": paper.created_at,
        "chunk_count": len(chunks),
        "tags": paper_tags,
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
    db.delete_relationships_for_claims(claim_ids)
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


# â"€â"€ Upload & Analyze â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

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

    # Bounded read â€" never pull an unbounded upload into memory. Abort as soon
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

    # Ingest (extract + chunk + embed) â€" this is fast enough to do inline
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

    # Analyze in background (parallel â€" ~5x faster than sequential loop)
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
@limiter.limit(settings.rl_upload)
def reanalyze_paper(request: Request, paper_id: str, background_tasks: BackgroundTasks = BackgroundTasks(),
                    user: User = Depends(authlib.get_current_user)):
    """Re-run analysis on an already-ingested paper."""
    paper = _require_owned_paper(paper_id, user)
    # Invalidate cached claims + their relationships so they're freshly derived
    claim_ids = [c.id for c in db.get_claims_for_paper(paper_id)]
    db.delete_claims_for_paper(paper_id)
    if claim_ids:
        _conn = db._get_conn()
        _cur = _conn.cursor()
        try:
            _cur.execute(
                "DELETE FROM relationships WHERE claim_lo = ANY(%s) OR claim_hi = ANY(%s)",
                (claim_ids, claim_ids),
            )
            _conn.commit()
        finally:
            _cur.close()
            db._put_conn(_conn)
    background_tasks.add_task(_analyze_paper_bg, paper_id, authlib.resolve_user_api_key(user), _resolve_model_and_meter(user))
    return {"id": paper_id, "status": "analyzing"}


# â"€â"€ Search & QA â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

@app.post("/api/search")
@limiter.limit(settings.rl_search)
def search_papers(request: Request, req: SearchRequest,
                  user: User = Depends(authlib.get_current_user)):
    """
    Semantic search across the paper library.

    Relevance fields returned per result:
      relevance_tier  â€" "highly_relevant" | "related" | "tangential"
                        Defined thresholds on cosine distance, calibrated for
                        MiniLM on narrow-domain academic text. Honest and
                        explainable; replaces the previous fake-precise percentage.
      relevance_score â€" raw cosine distance in [0, 1] (lower = more similar).
                        Exposed so the frontend can sort or filter if needed,
                        but not intended for display to end users.

    Thresholds (from settings):
      < 0.20  â†' highly_relevant
      < 0.40  â†' related
      >= 0.40 â†' tangential
    """
    owned_ids = db.list_paper_ids_for_user(user.id)
    if not owned_ids:
        return []

    if not settings.voyage_api_key:
        raise HTTPException(status_code=503, detail="Search is not configured on this server (missing VOYAGE_API_KEY).")

    indexed = agent.vector_store.count_for_papers(owned_ids)
    if indexed == 0:
        raise HTTPException(
            status_code=409,
            detail="None of your papers have been indexed for search yet. Open each paper and click 'Re-analyze' to enable search.",
        )

    try:
        results = agent.vector_store.search(
            query=req.query,
            n_results=req.n_results,
            paper_id=req.paper_id,
            paper_ids=owned_ids,
        )
    except Exception as exc:
        print(f"[search] {exc}")
        raise HTTPException(status_code=503, detail="Search temporarily unavailable.") from exc

    paper_title_map = db.get_paper_titles(list({r.paper_id for r in results}))

    response = []
    for r in results:
        response.append({
            "paper_id": r.paper_id,
            "paper_title": paper_title_map.get(r.paper_id, "Unknown"),
            "section": r.section,
            "text": r.text[:800],
            "relevance_tier": settings.relevance_tier(r.score),
            "relevance_score": round(r.score, 4),
        })
    return response


import hashlib as _hashlib
_ask_cache: dict[str, dict] = {}
_ASK_CACHE_TTL = 3600  # 1 hour

# ── Background job store ──────────────────────────────────────────────────
# In-memory only — resets on Render restart. Acceptable for the free tier
# since a missed job just means the user retries.
#
# Structure: job_id → {status, result, error, user_id, endpoint, created_at}
# status: "running" | "done" | "error"
_jobs: dict[str, dict] = {}
_active_jobs: dict[str, str] = {}
_jobs_lock = threading.Lock()


def _new_job(user_id: str, endpoint: str) -> str:
    """Create a new job entry. Returns job_id."""
    job_id = str(uuid.uuid4())
    with _jobs_lock:
        _jobs[job_id] = {
            "status": "running",
            "result": None,
            "error": None,
            "user_id": user_id,
            "endpoint": endpoint,
            "created_at": _time.time(),
        }
        _active_jobs[f"{user_id}:{endpoint}"] = job_id
    return job_id


def _finish_job(job_id: str, result: dict):
    with _jobs_lock:
        if job_id in _jobs:
            _jobs[job_id]["status"] = "done"
            _jobs[job_id]["result"] = result
        job = _jobs.get(job_id, {})
        _active_jobs.pop(f"{job.get('user_id')}:{job.get('endpoint')}", None)


def _fail_job(job_id: str, error: str):
    with _jobs_lock:
        if job_id in _jobs:
            _jobs[job_id]["status"] = "error"
            _jobs[job_id]["error"] = error
        job = _jobs.get(job_id, {})
        _active_jobs.pop(f"{job.get('user_id')}:{job.get('endpoint')}", None)


def _get_or_reuse_job(user_id: str, endpoint: str) -> str | None:
    with _jobs_lock:
        key = f"{user_id}:{endpoint}"
        existing = _active_jobs.get(key)
        if existing and existing in _jobs and _jobs[existing]["status"] == "running":
            return existing
    return None


def _ask_bg(job_id: str, question: str, paper_id: str | None,
             paper_ids: list[str], api_key: str | None, model: str,
             cache_key: str, history: list[dict] | None = None):
    """Background task for Ask — simple single-pass RAG, low memory footprint."""
    try:
        answer = agent.ask(
            question,
            paper_id=paper_id,
            paper_ids=paper_ids,
            api_key=api_key,
            model=model,
            history=history,
        )
        _ask_cache[cache_key] = {"answer": answer, "ts": _time.time()}
        _finish_job(job_id, {"answer": answer, "cached": False})
    except Exception as e:
        _fail_job(job_id, str(e))


@app.post("/api/ask")
@limiter.limit(settings.rl_ask)
def ask_question(request: Request, req: AskRequest,
                 background_tasks: BackgroundTasks,
                 user: User = Depends(authlib.get_current_user)):
    """Simple RAG Ask — one embed + one pgvector search + one LLM call.
    Runs as a background task to avoid blocking the main thread."""
    _cache_raw = f"{user.id}:{req.question}:{req.paper_id}"
    _cache_key = _hashlib.sha256(_cache_raw.encode()).hexdigest()[:16]
    _now = _time.time()
    if _cache_key in _ask_cache:
        entry = _ask_cache[_cache_key]
        if _now - entry["ts"] < _ASK_CACHE_TTL:
            job_id = _new_job(user.id, "ask")
            _finish_job(job_id, {"answer": entry["answer"], "cached": True})
            return {"job_id": job_id, "status": "done", "cached": True}
    existing = _get_or_reuse_job(user.id, "ask")
    if existing:
        return {"job_id": existing, "status": "running"}
    job_id = _new_job(user.id, "ask")
    raw_history = getattr(req, "history", None)
    history = [{"role": m.role, "content": m.content} for m in raw_history] if raw_history else None
    background_tasks.add_task(
        _ask_bg, job_id, req.question, req.paper_id,
        _owned_ids(user), authlib.resolve_user_api_key(user),
        _resolve_model_and_meter(user), _cache_key, history,
    )
    return {"job_id": job_id, "status": "running"}


# â"€â"€ Contradictions â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

# ── Job polling ──────────────────────────────────────────────────────────

@app.get("/api/jobs/{job_id}")
def get_job(job_id: str, user: User = Depends(authlib.get_current_user)):
    """Poll a background job. Returns status + result when done."""
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    if job["user_id"] != user.id:
        raise HTTPException(status_code=404, detail="Job not found.")
    return {
        "job_id": job_id,
        "status": job["status"],
        "result": job["result"],
        "error": job["error"],
        "endpoint": job["endpoint"],
    }


@app.get("/api/contradictions/count")
def contradiction_count(user: User = Depends(authlib.get_current_user)):
    """Lightweight endpoint â€" returns cached relationship counts with no LLM calls."""
    owned = _owned_ids(user)
    rels = db.list_relationships(paper_ids=owned, strict=True) if owned else []
    counts = {"contradiction": 0, "support": 0, "nuance": 0, "unrelated": 0}
    for r in rels:
        if r.relationship in counts:
            counts[r.relationship] += 1
    last = max((r.created_at for r in rels), default=None) if rels else None
    return {"counts": counts, "total": len(rels), "last_scanned": last}


@app.get("/api/contradictions")
def list_contradictions(user: User = Depends(authlib.get_current_user)):
    """
    Return the full persisted relationship set â€" every relationship ever
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
    rels = db.list_relationships(paper_ids=owned, strict=True)

    # Build claim-id → claim map in two queries (one for titles, one for all claims)
    title_map = db.paper_title_map(user.id)
    claims_by_paper = db.get_claims_for_papers(list(title_map.keys()))
    claim_by_id = {}
    claim_paper_title = {}
    for pid, ptitle in title_map.items():
        for c in claims_by_paper.get(pid, []):
            claim_by_id[c.id] = c
            claim_paper_title[c.id] = ptitle

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


def _contradiction_bg(job_id: str, scope: list[str], similarity_threshold: float,
                       max_pairs: int, api_key: str | None, model: str):
    try:
        results = contradiction_agent.run_contradiction_scan(
            paper_ids=scope,
            similarity_threshold=similarity_threshold,
            max_pairs=max_pairs,
            api_key=api_key,
            model=model,
        )
        _invalidate_insight_cache()
        _finish_job(job_id, [
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
        ])
    except Exception as e:
        _fail_job(job_id, str(e))


@app.post("/api/contradictions")
@limiter.limit(settings.rl_contradictions)
def run_contradictions(request: Request, req: ContradictionRequest,
                       background_tasks: BackgroundTasks,
                       user: User = Depends(authlib.get_current_user)):
    scope = _scope_ids(user, req.paper_ids)
    if not scope:
        return {"job_id": None, "status": "done", "result": []}
    existing = _get_or_reuse_job(user.id, "contradictions")
    if existing:
        return {"job_id": existing, "status": "running"}
    job_id = _new_job(user.id, "contradictions")
    background_tasks.add_task(
        _contradiction_bg, job_id, scope,
        req.similarity_threshold, req.max_pairs,
        authlib.resolve_user_api_key(user), _resolve_model_and_meter(user),
    )
    return {"job_id": job_id, "status": "running"}


# â"€â"€ Hypotheses â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

@app.get("/api/hypotheses")
def get_cached_hypotheses(user: User = Depends(authlib.get_current_user)):
    """
    Return the most recent cached hypotheses for this user.
    Zero LLM calls — pure DB read from hypothesis_cache table.
    Returns [] if no cache exists yet.
    """
    paper_ids = db.list_paper_ids_for_user(user.id)
    entries = db.list_hypothesis_cache(paper_ids, user_id=user.id)
    if not entries:
        return []
    # Return the most recent entry's hypotheses
    latest = entries[0]
    return latest["hypotheses"]


def _hypothesis_bg(job_id: str, research_question: str | None, scope: list[str],
                    num_hypotheses: int, refresh: bool, api_key: str | None, model: str,
                    user_id: str | None = None):
    try:
        hypotheses = hypothesis_agent.generate(
            research_question=research_question,
            paper_ids=scope,
            num_hypotheses=num_hypotheses,
            force_refresh=refresh,
            api_key=api_key,
            model=model,
            user_id=user_id,
        )
        _finish_job(job_id, [
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
        ])
    except Exception as e:
        _fail_job(job_id, str(e))


@app.post("/api/hypotheses")
@limiter.limit(settings.rl_hypotheses)
def generate_hypotheses(request: Request, req: HypothesisRequest,
                        background_tasks: BackgroundTasks,
                        user: User = Depends(authlib.get_current_user)):
    """Generate testable hypotheses — runs as a background task, returns job_id."""
    scope = _scope_ids(user, req.paper_ids)
    if not scope:
        return {"job_id": None, "status": "done", "result": []}
    existing = _get_or_reuse_job(user.id, "hypotheses")
    if existing:
        return {"job_id": existing, "status": "running"}
    job_id = _new_job(user.id, "hypotheses")
    background_tasks.add_task(
        _hypothesis_bg, job_id, req.research_question, scope,
        req.num_hypotheses, req.refresh,
        authlib.resolve_user_api_key(user), _resolve_model_and_meter(user),
        user.id,
    )
    return {"job_id": job_id, "status": "running"}


# â"€â"€ Import â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

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
@limiter.limit(settings.rl_import_lookup)
def import_lookup(request: Request, req: ImportLookupRequest, user: User = Depends(authlib.get_current_user)):
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
    text = text.replace("\r\n", " ").replace("\n", " ").replace("\r", " ")
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


@app.post("/api/import/add")
@limiter.limit(settings.rl_import_add)
def import_add(
    request: Request,
    req: ImportAddRequest,
    background_tasks: BackgroundTasks = BackgroundTasks(),
    user: User = Depends(authlib.get_current_user),
):
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

    # Dedup BEFORE downloading â€" per user (same paper in another user's library
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
    # Uses db._get_conn()/_put_conn() to go through the shared pool rather
    # than opening a raw connection that could leak on exception.
    _conn = db._get_conn()
    _cur = _conn.cursor()
    try:
        _cur.execute(
            "UPDATE papers SET title=%s, authors=%s, abstract=%s, year=%s, source=%s, doi=%s, arxiv_id=%s, user_id=%s WHERE id=%s",
            (req.title, json.dumps(req.authors), _normalize_abstract(req.abstract), req.year,
             req.source, req.doi, arxiv_id, user.id, paper.id),
        )
        _conn.commit()
    finally:
        _cur.close()
        db._put_conn(_conn)

    # Analyze in background
    background_tasks.add_task(_analyze_paper_bg, paper.id, user_key, model)
    _invalidate_insight_cache()

    return {
        "id": paper.id,
        "title": req.title,
        "status": "analyzing",
        "message": "Paper imported and queued for analysis.",
    }


# â"€â"€ Monitor â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

def _monitor_scan_bg(job_id: str, topics: list, recipient: str | None,
                      max_per_source: int, relevance_threshold: float,
                      user_id: str, api_key: str | None, model: str):
    try:
        results, email_sent, email_error, sources_failed = monitor.run_full_scan(
            topics=topics,
            recipient=recipient,
            max_per_source=max_per_source,
            relevance_threshold=relevance_threshold,
            user_id=user_id,
            api_key=api_key,
            model=model,
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
        _finish_job(job_id, {
            "digests": digests,
            "email_requested": bool(recipient),
            "email_sent": email_sent,
            "email_error": email_error,
            "sources_failed": sources_failed,
        })
    except Exception as e:
        _fail_job(job_id, str(e))


@app.post("/api/monitor/scan")
@limiter.limit(settings.rl_monitor)
def monitor_scan(request: Request, req: MonitorRequest,
                 background_tasks: BackgroundTasks,
                 user: User = Depends(authlib.get_current_user)):
    """Run monitoring scan — returns job_id immediately, scans in background."""
    existing = _get_or_reuse_job(user.id, "monitor_scan")
    if existing:
        return {"job_id": existing, "status": "running"}

    topics = [
        MonitorTopic(
            name=t["name"],
            keywords=t["keywords"],
            sources=t.get("sources", ["semantic_scholar", "openalex", "arxiv"]),
        )
        for t in req.topics
    ]
    job_id = _new_job(user.id, "monitor_scan")
    background_tasks.add_task(
        _monitor_scan_bg, job_id, topics, req.email,
        req.max_per_source, req.relevance_threshold,
        user.id, authlib.resolve_user_api_key(user), _resolve_model_and_meter(user),
    )
    return {"job_id": job_id, "status": "running"}


@app.get("/api/monitor/topics")
def list_monitor_topics(user: User = Depends(authlib.get_current_user)):
    """Return all saved monitor topics for the current user."""
    topics = db.list_monitor_topics(user.id)
    return [
        {
            "id": t.id,
            "name": t.name,
            "keywords": t.keywords,
            "sources": t.sources,
            "is_active": t.is_active,
            "last_scanned_at": t.last_scanned_at,
            "created_at": t.created_at,
        }
        for t in topics
    ]


@app.post("/api/monitor/topics")
def create_monitor_topic(
    req: MonitorTopicRequest,
    user: User = Depends(authlib.get_current_user),
):
    """Save a new monitor topic for the current user."""
    valid_sources = {"semantic_scholar", "openalex", "arxiv"}
    sources = [s for s in req.sources if s in valid_sources]
    if not sources:
        sources = ["semantic_scholar", "openalex", "arxiv"]
    keywords = [k.strip() for k in req.keywords if k.strip()]
    if not keywords:
        raise HTTPException(status_code=400, detail="At least one keyword is required.")
    topic = db.create_monitor_topic(
        user_id=user.id,
        name=req.name.strip(),
        keywords=keywords,
        sources=sources,
    )
    return {
        "id": topic.id,
        "name": topic.name,
        "keywords": topic.keywords,
        "sources": topic.sources,
        "is_active": topic.is_active,
        "last_scanned_at": topic.last_scanned_at,
        "created_at": topic.created_at,
    }


@app.delete("/api/monitor/topics/{topic_id}")
def delete_monitor_topic(
    topic_id: str,
    user: User = Depends(authlib.get_current_user),
):
    """Delete a saved monitor topic. Returns 404 if not found or not owned."""
    deleted = db.delete_monitor_topic(topic_id, user.id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Topic not found.")
    return {"status": "deleted", "id": topic_id}


@app.post("/api/monitor/test-digest")
@limiter.limit(settings.rl_test_digest)
def test_digest(request: Request, user: User = Depends(authlib.get_current_user)):
    """
    Immediately trigger the scheduled digest for the current user.
    Sends to the user's configured digest_email. Returns 400 if no
    digest email is set or no active topics exist.
    Used to verify Gmail SMTP is working without waiting for 9am UTC.
    """
    if not user.digest_email:
        raise HTTPException(
            status_code=400,
            detail="No digest email set. Go to Settings and add your email first."
        )
    topics_rows = db.list_monitor_topics(user.id)
    active = [t for t in topics_rows if t.is_active]
    if not active:
        raise HTTPException(
            status_code=400,
            detail="No active monitor topics. Add a topic on the Monitor page first."
        )
    monitor_topics = [
        MonitorTopic(name=t.name, keywords=t.keywords, sources=t.sources)
        for t in active
    ]
    try:
        results, email_sent, email_error, sources_failed = monitor.run_full_scan(
            topics=monitor_topics,
            recipient=user.digest_email,
            user_id=user.id,
            api_key=authlib.resolve_user_api_key(user),
            model=_resolve_model_and_meter(user),
        )
        for t in active:
            db.update_topic_scanned_at(t.id)
        return {
            "status": "ok",
            "email_sent": email_sent,
            "email_error": email_error,
            "topics_scanned": len(active),
            "papers_found": sum(r.papers_found for r in results),
            "papers_relevant": sum(r.papers_relevant for r in results),
            "sources_failed": sources_failed,
        }
    except Exception as e:
        print(f"[test-digest] {e}")
        raise HTTPException(status_code=500, detail="Digest failed. Check server logs.")


# â"€â"€ Knowledge Graph â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

class GraphRequest(BaseModel):
    paper_ids: Optional[list[str]] = None
    similarity_threshold: float = Field(0.40, ge=0.0, le=1.0)
    max_pairs: int = Field(120, ge=1, le=500)
    compute: bool = False


def _build_graph_readonly(papers):
    """
    Assemble the graph from the persisted relationships table â€" no agent
    calls, no LLM, no writes. This is the same data the conflict map and
    hypothesis grounding read, so all three stay consistent.

    Claims come from db.get_claims_for_paper (pure DB read). Edges come from
    db.list_relationships scoped to the selected papers. Every paper that has
    a relationship is represented; papers with no detected relationships
    simply have no nodes (same as before â€" isolated claims are hidden).
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

    # Inject the best pair for any unrepresented paper â€" only if a cross-paper
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
    # them immediately â€" same contract as the contradiction scan endpoint.
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
@limiter.limit(settings.rl_graph)
def build_graph(request: Request, req: GraphRequest, user: User = Depends(authlib.get_current_user)):
    """
    Assemble a claim-level knowledge graph.

    Nodes  = claims extracted from papers (the atomic unit).
    Edges  = relationships between claims (contradiction/support/nuance).

    Read-only by default (compute=false): edges come straight from the
    persisted relationships table â€" zero LLM calls, no writes, and the
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


# â"€â"€ Insight Feed â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

class InsightRequest(BaseModel):
    paper_ids: Optional[list[str]] = None
    limit: int = Field(30, ge=1, le=200)


@app.post("/api/insights")
@limiter.limit(settings.rl_insights)
def insight_feed(request: Request, req: InsightRequest, user: User = Depends(authlib.get_current_user)):
    """
    Synthesize a stream of typed insights from existing agent outputs.

    Sources:
      - newest papers         â†' new_paper insights
      - research_gaps analyses â†' gap insights
      - relationships table   â†' contradiction / consensus insights (zero LLM calls)

    Cache: assembled list is cached in-process for _INSIGHT_CACHE_TTL seconds
    (default 2 hours). Invalidated immediately on any paper add or delete so
    the feed always reflects the current library state after writes.
    """

    # â"€â"€ Cache read â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    now = _time.time()
    _entry = _insight_cache.get(user.id)
    if _entry is not None and (now - _entry["ts"]) < _INSIGHT_CACHE_TTL:
        return _entry["payload"][: req.limit]

    owned = _owned_ids(user)

    # â"€â"€ Assemble insights (all DB reads, zero LLM calls) â"€â"€â"€â"€â"€
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
        """Word-boundary truncation â€" avoids cutting headlines mid-word."""
        if len(s) <= n:
            return s
        cut = s[:n].rsplit(" ", 1)[0]
        return cut + "â€¦"

    # Track papers already surfaced by a cross-paper relationship insight, so a
    # single dominant paper does not headline both a contradiction AND a gap.
    # Cross-paper relationships are higher-value signal than single-paper gaps,
    # so they claim their papers first and gaps fill in only what is left.
    papers_in_relationships: set[str] = set()

    # Contradiction / consensus / nuance insights â€" from the relationships table.
    try:
        cached_rels = db.list_relationships(paper_ids=owned) if owned else []
        # Build paper ID → title map in one DB call.
        # Relationships store paper_a/paper_b as paper IDs so we use
        # title_map directly instead of the old claim_id → title loop
        # which opened N DB connections (one per paper).
        title_map = db.paper_title_map(user.id)

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
                    s = s[len(title):].lstrip(" :-—")
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

            ta = title_map.get(rel.paper_a, "Unknown paper")
            tb = title_map.get(rel.paper_b, "Unknown paper")
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

    # Gap insights from research_gaps analyses â€" but ONLY for papers that aren't
    # already represented by a relationship insight above. This is the dedup
    # that stops one paper from headlining multiple cells on the dashboard.
    # Gap insights — batch fetch all analyses in one DB call
    gap_paper_ids = [p.id for p in papers[:8]]
    gap_analyses_map = db.get_analyses_for_papers(gap_paper_ids)
    gap_paper_map = {p.id: p for p in papers[:8]}
    for pid, analyses in gap_analyses_map.items():
        p = gap_paper_map.get(pid)
        if not p:
            continue
        for a in analyses:
            if a.analysis_type == "research_gaps" and a.content:
                lines = [l.strip() for l in a.content.strip().split("\n") if l.strip()]
                first = lines[0][:180] if lines else ""
                # Fix Windows-1252 mojibake stored by older pipeline runs
                first = (first
                         .replace('\u00e2\u20ac\u00a6', '\u2026')  # ae... -> ...
                         .replace('\u00e2\u20ac\u2122', '\u2019')  # ae(tm) -> '
                         .replace('\u00e2\u20ac\u0153', '\u201c')  # aeoelig -> ldquo
                         .replace('\u00e2\u20ac\u201d', '\u2014')  # ae'' -> mdash
                         )
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
    # large volume of lower-signal nuance/gap insights â€" otherwise a limit-
    # capped consumer (e.g. the dashboard's top-contradiction card) misses them.
    #
    # Two stable sorts: first by recency (newest first), then by type priority.
    # Python's sort is stable, so the recency order is preserved within each
    # priority group.
    _TYPE_PRIORITY = {
        "contradiction": 0,
        "gap": 1,
        "consensus": 2,
        "hypothesis": 3,
        "new_paper": 4,
    }
    insights.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    insights.sort(key=lambda x: _TYPE_PRIORITY.get(x.get("type", ""), 9))

    # ── Cache write ──────────────────────────────────────────────────────────
    _insight_cache[user.id] = {"payload": insights, "ts": _time.time()}

    return insights[: req.limit]


# ── Batch upload ──────────────────────────────────────────────────────────────

@app.post("/api/papers/upload-batch")
@limiter.limit(settings.rl_upload_batch)
async def upload_papers_batch(
    request: Request,
    files: list[UploadFile] = File(...),
    background_tasks: BackgroundTasks = BackgroundTasks(),
    user: User = Depends(authlib.get_current_user),
):
    """Upload multiple PDFs in one request. Each file is ingested and queued
    for analysis. Returns a per-file result list with status and paper id."""
    if not files:
        raise HTTPException(status_code=400, detail="No files provided.")
    if len(files) > 20:
        raise HTTPException(status_code=400, detail="Maximum 20 files per batch.")

    max_bytes = settings.max_upload_bytes
    results = []
    user_key = authlib.resolve_user_api_key(user)

    for file in files:
        if not file.filename or not file.filename.lower().endswith(".pdf"):
            results.append({"filename": file.filename or "unknown", "status": "error",
                            "message": "Not a PDF file."})
            continue
        try:
            buf = bytearray()
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                buf.extend(chunk)
                if len(buf) > max_bytes:
                    results.append({"filename": file.filename, "status": "error",
                                    "message": f"Exceeds {max_bytes // (1024*1024)} MB limit."})
                    buf = None
                    break
            if buf is None:
                continue
            content = bytes(buf)
            if b"%PDF-" not in content[:1024]:
                results.append({"filename": file.filename, "status": "error",
                                "message": "Not a valid PDF."})
                continue
            display_name = _safe_display_name(file.filename)
            save_path = UPLOAD_DIR / f"{uuid.uuid4().hex}.pdf"
            if UPLOAD_DIR.resolve() not in save_path.resolve().parents:
                results.append({"filename": file.filename, "status": "error",
                                "message": "Invalid path."})
                continue
            save_path.write_bytes(content)
            model = _resolve_model_and_meter(user)
            paper = agent.ingest_pdf(save_path, filename=display_name, api_key=user_key, model=model)
            existing = db.find_duplicate(paper.title, doi=paper.doi, arxiv_id=paper.arxiv_id)
            if existing and existing.id != paper.id and existing.user_id == user.id:
                agent.vector_store.delete_paper_chunks(paper.id)
                db.delete_paper(paper.id)
                try:
                    save_path.unlink(missing_ok=True)
                except OSError:
                    pass
                results.append({"filename": file.filename, "status": "duplicate",
                                "id": existing.id, "title": existing.title,
                                "message": f"Already in library: \"{existing.title}\""})
                continue
            db.set_paper_owner(paper.id, user.id)
            background_tasks.add_task(_analyze_paper_bg, paper.id, user_key, model)
            results.append({"filename": file.filename, "status": "analyzing",
                            "id": paper.id, "title": paper.title})
        except Exception as e:
            results.append({"filename": getattr(file, "filename", "unknown"),
                            "status": "error", "message": str(e)})

    _invalidate_insight_cache()
    return {"results": results, "total": len(results),
            "queued": sum(1 for r in results if r["status"] == "analyzing")}


# ── Tags ──────────────────────────────────────────────────────────────────────

class TagRequest(BaseModel):
    tag: str = Field(..., min_length=1, max_length=50)


@app.get("/api/tags")
def list_tags(user: User = Depends(authlib.get_current_user)):
    """Return all distinct tags used by this user."""
    return {"tags": db.get_all_user_tags(user.id)}


@app.post("/api/papers/{paper_id}/tags")
def add_tag(paper_id: str, req: TagRequest,
            user: User = Depends(authlib.get_current_user)):
    _require_owned_paper(paper_id, user)
    created = db.add_paper_tag(paper_id, user.id, req.tag)
    return {"tag": req.tag.strip().lower(), "created": created}


@app.delete("/api/papers/{paper_id}/tags/{tag}")
def remove_tag(paper_id: str, tag: str,
               user: User = Depends(authlib.get_current_user)):
    _require_owned_paper(paper_id, user)
    deleted = db.remove_paper_tag(paper_id, user.id, tag)
    return {"tag": tag, "deleted": deleted}


# ── Citation export ───────────────────────────────────────────────────────────

from fastapi.responses import PlainTextResponse


def _format_bibtex(paper) -> str:
    key = re.sub(r"[^a-zA-Z0-9]", "", (paper.authors[0].split()[-1] if paper.authors else "Unknown"))
    key += str(paper.year or "")
    key += re.sub(r"[^a-zA-Z0-9]", "", paper.title.split()[0]) if paper.title else ""
    authors_str = " and ".join(paper.authors) if paper.authors else "Unknown"
    lines = [
        f"@article{{{key},",
        f'  title = {{{paper.title or ""}}},' ,
        f'  author = {{{authors_str}}},',
    ]
    if paper.year:
        lines.append(f'  year = {{{paper.year}}},')
    if paper.doi:
        lines.append(f'  doi = {{{paper.doi}}},')
    if paper.arxiv_id:
        lines.append(f'  eprint = {{{paper.arxiv_id}}},')
        lines.append('  archivePrefix = {arXiv},')
    if paper.abstract:
        lines.append(f'  abstract = {{{paper.abstract[:400]}}},')
    lines.append("}")
    return "\n".join(lines)


def _format_ris(paper) -> str:
    lines = ["TY  - JOUR"]
    lines.append(f"TI  - {paper.title or ''}")
    for a in (paper.authors or []):
        lines.append(f"AU  - {a}")
    if paper.year:
        lines.append(f"PY  - {paper.year}")
    if paper.doi:
        lines.append(f"DO  - {paper.doi}")
    if paper.arxiv_id:
        lines.append(f"AN  - {paper.arxiv_id}")
    if paper.abstract:
        lines.append(f"AB  - {paper.abstract[:400]}")
    lines.append("ER  - ")
    return "\n".join(lines)


def _author_last_first(name: str) -> str:
    parts = name.strip().split()
    if len(parts) <= 1:
        return name
    return f"{parts[-1]}, {' '.join(parts[:-1])}"


def _format_apa(paper) -> str:
    authors = paper.authors or []
    if not authors:
        author_str = "Unknown Author"
    elif len(authors) == 1:
        author_str = _author_last_first(authors[0])
    elif len(authors) <= 6:
        parts = [_author_last_first(a) for a in authors]
        author_str = ", ".join(parts[:-1]) + ", & " + parts[-1]
    else:
        parts = [_author_last_first(a) for a in authors[:6]]
        author_str = ", ".join(parts) + ", ... " + _author_last_first(authors[-1])

    year = f"({paper.year})" if paper.year else "(n.d.)"
    title = paper.title or "Untitled"
    doi_part = f" https://doi.org/{paper.doi}" if paper.doi else (
        f" https://arxiv.org/abs/{paper.arxiv_id}" if paper.arxiv_id else ""
    )
    return f"{author_str}. {year}. {title}.{doi_part}"


def _format_chicago(paper) -> str:
    authors = paper.authors or []
    if not authors:
        author_str = "Unknown Author"
    elif len(authors) == 1:
        author_str = _author_last_first(authors[0])
    elif len(authors) <= 3:
        first = _author_last_first(authors[0])
        rest = ", ".join(authors[1:])
        author_str = f"{first}, {rest}"
    else:
        author_str = _author_last_first(authors[0]) + " et al."

    year = paper.year or "n.d."
    title = paper.title or "Untitled"
    doi_part = f" https://doi.org/{paper.doi}." if paper.doi else (
        f" https://arxiv.org/abs/{paper.arxiv_id}." if paper.arxiv_id else "."
    )
    return f'{author_str}. "{title}." {year}.{doi_part}'


def _format_mla(paper) -> str:
    authors = paper.authors or []
    if not authors:
        author_str = "Unknown Author"
    elif len(authors) == 1:
        author_str = _author_last_first(authors[0])
    elif len(authors) == 2:
        author_str = f"{_author_last_first(authors[0])}, and {authors[1]}"
    else:
        author_str = _author_last_first(authors[0]) + ", et al."

    title = paper.title or "Untitled"
    year = paper.year or "n.d."
    doi_part = f" {paper.doi}." if paper.doi else (
        f" arxiv.org/abs/{paper.arxiv_id}." if paper.arxiv_id else "."
    )
    return f'{author_str}. "{title}." {year}.{doi_part}'


@app.get("/api/papers/{paper_id}/export")
def export_paper_citation(
    paper_id: str,
    fmt: str = Query("bibtex", alias="format", pattern="^(bibtex|ris|apa|chicago|mla)$"),
    user: User = Depends(authlib.get_current_user),
):
    paper = _require_owned_paper(paper_id, user)
    safe_title = re.sub(r"[^a-zA-Z0-9_-]", "_", paper.title[:40])
    if fmt == "ris":
        content = _format_ris(paper)
        media_type = "application/x-research-info-systems"
        filename = f"{safe_title}.ris"
    elif fmt == "apa":
        content = _format_apa(paper)
        media_type = "text/plain; charset=utf-8"
        filename = f"{safe_title}_apa.txt"
    elif fmt == "chicago":
        content = _format_chicago(paper)
        media_type = "text/plain; charset=utf-8"
        filename = f"{safe_title}_chicago.txt"
    elif fmt == "mla":
        content = _format_mla(paper)
        media_type = "text/plain; charset=utf-8"
        filename = f"{safe_title}_mla.txt"
    else:
        content = _format_bibtex(paper)
        media_type = "application/x-bibtex"
        filename = f"{safe_title}.bib"
    return PlainTextResponse(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── Contradiction feedback ────────────────────────────────────────────────────

class FeedbackRequest(BaseModel):
    verdict: str = Field(..., pattern="^(agree|disagree|flag)$")


@app.post("/api/contradictions/{rel_id}/feedback")
def contradiction_feedback(
    rel_id: str, req: FeedbackRequest,
    user: User = Depends(authlib.get_current_user),
):
    updated = db.set_relationship_feedback(rel_id, user.id, req.verdict)
    if not updated:
        raise HTTPException(status_code=404, detail="Relationship not found.")
    return {"id": rel_id, "verdict": req.verdict}


# ── Export reports ────────────────────────────────────────────────────────────

@app.get("/api/contradictions/export")
def export_contradictions(
    fmt: str = Query("markdown", alias="format", pattern="^(markdown|json)$"),
    user: User = Depends(authlib.get_current_user),
):
    """Export the full contradiction report as Markdown or JSON."""
    owned = _owned_ids(user)
    if not owned:
        raise HTTPException(status_code=404, detail="No papers in library.")
    rels = db.list_relationships(paper_ids=owned, strict=True)
    title_map = db.paper_title_map(user.id)
    claims_by_paper = db.get_claims_for_papers(list(title_map.keys()))
    claim_by_id = {}
    claim_paper_title = {}
    for pid, ptitle in title_map.items():
        for c in claims_by_paper.get(pid, []):
            claim_by_id[c.id] = c
            claim_paper_title[c.id] = ptitle

    entries = []
    for r in rels:
        if r.relationship in ("error", "unrelated"):
            continue
        a = claim_by_id.get(r.claim_lo)
        b = claim_by_id.get(r.claim_hi)
        if not a or not b:
            continue
        entries.append({
            "id": r.id, "relationship": r.relationship, "category": r.category,
            "explanation": r.explanation, "resolution": r.resolution,
            "stronger_evidence": r.stronger_evidence,
            "paper_a": claim_paper_title.get(a.id, ""), "claim_a": a.text,
            "paper_b": claim_paper_title.get(b.id, ""), "claim_b": b.text,
            "created_at": r.created_at,
        })

    if fmt == "json":
        return JSONResponse(content=entries)

    # Markdown
    lines = ["# ScholarLens — Contradiction Report", ""]
    rel_order = {"contradiction": "Contradictions", "nuance": "Nuances", "support": "Supporting Pairs"}
    for rel_type, heading in rel_order.items():
        group = [e for e in entries if e["relationship"] == rel_type]
        if not group:
            continue
        lines += [f"## {heading}", ""]
        for i, e in enumerate(group, 1):
            lines += [
                f"### {i}. {e['paper_a']} ↔ {e['paper_b']}",
                f"**Category:** {e['category'] or 'N/A'}",
                "",
                f"**Claim A ({e['paper_a']}):** {e['claim_a']}",
                "",
                f"**Claim B ({e['paper_b']}):** {e['claim_b']}",
                "",
                f"**Analysis:** {e['explanation']}",
                "",
                f"**Resolution:** {e['resolution'] or 'N/A'}",
                "",
                f"**Stronger evidence:** {e['stronger_evidence'] or 'N/A'}",
                "",
                "---",
                "",
            ]
    md = "\n".join(lines)
    return PlainTextResponse(
        content=md, media_type="text/markdown",
        headers={"Content-Disposition": 'attachment; filename="contradictions.md"'},
    )


@app.get("/api/hypotheses/export")
def export_hypotheses(
    fmt: str = Query("markdown", alias="format", pattern="^(markdown|json)$"),
    user: User = Depends(authlib.get_current_user),
):
    """Export the hypothesis report as Markdown or JSON."""
    owned = _owned_ids(user)
    cached_entries = db.list_hypothesis_cache(owned, user_id=user.id)
    if not cached_entries:
        raise HTTPException(status_code=404, detail="No hypotheses generated yet.")
    hypotheses = cached_entries[0]["hypotheses"]

    if fmt == "json":
        return JSONResponse(content=hypotheses)

    lines = ["# ScholarLens — Hypothesis Report", ""]
    for i, h in enumerate(hypotheses, 1):
        lines += [
            f"## Hypothesis {i}",
            "",
            f"**Statement:** {h.get('statement', '')}",
            "",
            f"**Rationale:** {h.get('rationale', '')}",
            "",
            f"**Novelty:** {h.get('novelty_tier', 'unknown')} (score: {round(h.get('novelty_score', 0), 3)})",
            "",
            f"**Methodology:** {h.get('methodology', '')}",
            "",
        ]
        challenges = h.get("challenges", [])
        if challenges:
            lines.append("**Challenges:**")
            for c in challenges:
                lines.append(f"- {c}")
            lines.append("")
        papers = h.get("supporting_papers", [])
        if papers:
            lines.append("**Supporting papers:**")
            for p in papers:
                lines.append(f"- {p.get('title', '')} — {p.get('relevant_finding', '')}")
            lines.append("")
        lines += ["---", ""]
    md = "\n".join(lines)
    return PlainTextResponse(
        content=md, media_type="text/markdown",
        headers={"Content-Disposition": 'attachment; filename="hypotheses.md"'},
    )
