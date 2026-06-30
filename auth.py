"""
Authentication, sessions, and BYOK key encryption for ScholarLens.

Design (see SECURITY notes):
- Passwords: bcrypt. bcrypt silently caps at 72 bytes, so we truncate to 72
  bytes consistently in BOTH hash and verify (never a surprise mismatch).
- Sessions: opaque 256-bit random token (secrets.token_urlsafe), stored in an
  httpOnly + (prod) Secure + SameSite=Lax cookie. The token is the only thing
  in the cookie; all state lives server-side in the sessions table. A fresh
  token is issued on every login (rotation), and sessions expire after
  settings.session_ttl_days.
- BYOK: tenant Anthropic keys are encrypted at rest with Fernet (symmetric,
  AES-128-CBC + HMAC). The Fernet key comes from FERNET_KEY in the environment
  and is NEVER stored in the DB or returned to the client. Decrypted keys are
  never logged.
"""

import secrets
from datetime import datetime, timezone, timedelta

import bcrypt
from cryptography.fernet import Fernet, InvalidToken
from fastapi import Request, HTTPException

from config import settings
from db.database import Database, User

# Single DB handle for auth lookups (same SQLite file as the rest of the app).
_db = Database()

_BCRYPT_MAX_BYTES = 72

# Pre-computed dummy hash used in constant-time login checks.
# When the email doesn't exist we still run bcrypt so the timing is
# indistinguishable from a wrong-password attempt on a real account.
_DUMMY_HASH = bcrypt.hashpw(b"dummy", bcrypt.gensalt()).decode("utf-8")


# ── Passwords ────────────────────────────────────────────────

def hash_password(password: str) -> str:
    pw = password.encode("utf-8")[:_BCRYPT_MAX_BYTES]
    return bcrypt.hashpw(pw, bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    pw = password.encode("utf-8")[:_BCRYPT_MAX_BYTES]
    try:
        return bcrypt.checkpw(pw, password_hash.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def verify_password_constant_time(password: str, user_hash: str | None) -> bool:
    """Always runs bcrypt regardless of whether a user was found, so unknown
    emails take the same wall-clock time as wrong passwords on real accounts."""
    hash_to_check = user_hash if user_hash is not None else _DUMMY_HASH
    result = verify_password(password, hash_to_check)
    return result and user_hash is not None


# ── BYOK key encryption (Fernet) ─────────────────────────────

def _fernet() -> Fernet:
    key = settings.fernet_key
    if not key:
        # Fail loud server-side; never silently store a plaintext key.
        raise HTTPException(
            status_code=500,
            detail="Server encryption key is not configured.",
        )
    try:
        return Fernet(key.encode("utf-8") if isinstance(key, str) else key)
    except (ValueError, TypeError):
        raise HTTPException(
            status_code=500,
            detail="Server encryption key is invalid.",
        )


def encrypt_api_key(plaintext: str) -> str:
    """Encrypt a tenant Anthropic key for storage. Returns a Fernet token."""
    return _fernet().encrypt(plaintext.encode("utf-8")).decode("utf-8")


def decrypt_api_key(token: str) -> str:
    """Decrypt a stored key. Raises 500 if FERNET_KEY changed since storage."""
    try:
        return _fernet().decrypt(token.encode("utf-8")).decode("utf-8")
    except InvalidToken:
        raise HTTPException(
            status_code=500,
            detail="Stored API key could not be decrypted (server key changed?).",
        )


# ── Sessions ─────────────────────────────────────────────────

def new_session_token() -> str:
    return secrets.token_urlsafe(32)  # 256 bits of entropy


def session_expiry_iso() -> str:
    expires = datetime.now(timezone.utc) + timedelta(days=settings.session_ttl_days)
    return expires.isoformat()


def _is_expired(expires_at: str) -> bool:
    try:
        return datetime.fromisoformat(expires_at) < datetime.now(timezone.utc)
    except ValueError:
        return True  # unparseable -> treat as expired (fail closed)


# ── FastAPI dependency ───────────────────────────────────────

def get_current_user(request: Request) -> User:
    """Resolve the logged-in user from the session cookie or Authorization
    header, or raise 401.

    Checks in order:
      1. httpOnly session cookie (local dev, same-origin)
      2. Authorization: Bearer <token> header (cross-origin production)

    Use as: `user: User = Depends(get_current_user)`."""
    # Delegate to Clerk when configured. Kept as a lazy import so PyJWT/Clerk
    # code never loads in the default password deployment.
    if settings.auth_provider == "clerk":
        from clerk_auth import get_current_user_clerk
        return get_current_user_clerk(request)

    token = request.cookies.get(settings.session_cookie_name)
    if not token:
        # Fall back to Authorization header for cross-origin requests
        # where third-party cookies are blocked (Chrome 2024+)
        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            token = auth_header[7:]
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")

    sess = _db.get_session(token)
    if not sess:
        raise HTTPException(status_code=401, detail="Invalid session")

    if _is_expired(sess.expires_at):
        _db.delete_session(token)  # clean up the dead row
        raise HTTPException(status_code=401, detail="Session expired")

    user = _db.get_user_by_id(sess.user_id)
    if not user:
        # Session points at a deleted user — clean up and reject.
        _db.delete_session(token)
        raise HTTPException(status_code=401, detail="Not authenticated")

    return user


def resolve_user_api_key(user: User) -> str:
    """The Anthropic key to use for this user's LLM calls: their own decrypted
    BYOK key if set, otherwise the server's env key (so the owner can use the
    app without configuring BYOK). Wired into the agents in the scoping phase."""
    if user.api_key_encrypted:
        return decrypt_api_key(user.api_key_encrypted)
    return settings.anthropic_api_key


def user_has_own_key(user: User) -> bool:
    """True if the user has stored their own BYOK key (so they're uncapped and
    may run any allowed model)."""
    return bool(user.api_key_encrypted)


def model_tier(model_string: str) -> str:
    """'haiku' | 'sonnet' | 'opus' | 'unknown' for an allowlisted model."""
    info = settings.ALLOWED_MODELS.get(model_string)
    return info["tier"] if info else "unknown"


def resolve_user_model(user: User) -> str:
    """The model to actually use for this user's calls, enforcing the free-tier
    ceiling server-side (defense in depth — the client can't override it):

      • own key (BYOK): their chosen model, if allowlisted; else the default.
      • server key:     Haiku and Sonnet are allowed (Sonnet is metered by the
                        caller); Opus is never run on the server key, so an Opus
                        selection is floored to the Haiku default.
    """
    chosen = user.model if user.model in settings.ALLOWED_MODELS else settings.anthropic_model
    if user_has_own_key(user):
        return chosen
    if model_tier(chosen) == "opus":
        return settings.anthropic_model
    return chosen
