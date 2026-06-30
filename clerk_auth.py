"""
Clerk authentication for ScholarLens.

Active only when AUTH_PROVIDER=clerk. Verifies a Clerk session JWT (RS256, keys
fetched from Clerk's JWKS endpoint) and resolves it to an internal User,
creating or linking the internal row as needed.

The internal user `id` stays the durable key for all data (papers, claims,
relationships), so switching auth providers never re-keys anything — Clerk is
only an identity link on top of the existing row.

Resolution order (clerk_user_id FIRST, so a wrong or fake email can never fork
a user's data):
  1. row already linked to this clerk_user_id  -> return it
  2. row with this email                        -> link clerk id, return it
  3. neither                                    -> create a new Clerk-backed row
"""

import threading

import jwt
from jwt import PyJWKClient
from fastapi import Request, HTTPException

from config import settings
from db.database import Database, User

_db = Database()

# PyJWKClient caches Clerk's signing keys internally; build it once, lazily.
_jwks_lock = threading.Lock()
_jwks_client: PyJWKClient | None = None


def _client() -> PyJWKClient:
    global _jwks_client
    if _jwks_client is None:
        with _jwks_lock:
            if _jwks_client is None:
                if not settings.clerk_jwks_url:
                    raise HTTPException(500, "Clerk auth is not configured (CLERK_JWKS_URL missing).")
                _jwks_client = PyJWKClient(settings.clerk_jwks_url)
    return _jwks_client


def _bearer(request: Request) -> str:
    """The Clerk session token, from the Authorization header (cross-origin) or
    Clerk's __session cookie (same-origin)."""
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip()
    cookie = request.cookies.get("__session")
    if cookie:
        return cookie
    raise HTTPException(401, "Not authenticated")


def verify_token(token: str) -> dict:
    try:
        signing_key = _client().get_signing_key_from_jwt(token)
        return jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            issuer=settings.clerk_issuer or None,
            options={"verify_aud": False, "require": ["exp", "iat"]},
            leeway=30,
        )
    except jwt.PyJWTError as e:
        raise HTTPException(401, f"Invalid session: {e}")


def _email_from_claims(claims: dict) -> str | None:
    """Return a VERIFIED email for this Clerk user, or None.

    Verification matters: linking to an existing internal row is keyed on email
    (step 2 of resolution), so an unverified address must never be accepted —
    otherwise someone could register an unverified `victim@x.com` and inherit
    that user's library. Clerk's `primary_email_address` is verified by Clerk's
    own invariant, but we still defend explicitly:
      - reject a claim that carries `email_verified: false`
      - via the Backend API, only return an address whose status is "verified"
    """
    if claims.get("email_verified") is False:
        return None
    for k in ("email", "email_address", "primary_email"):
        v = claims.get(k)
        if isinstance(v, str) and "@" in v:
            return v
    sub = claims.get("sub")
    if sub and settings.clerk_secret_key:
        try:
            import requests
            r = requests.get(
                f"https://api.clerk.com/v1/users/{sub}",
                headers={"Authorization": f"Bearer {settings.clerk_secret_key}"},
                timeout=8,
            )
            if r.ok:
                data = r.json()
                addrs = data.get("email_addresses") or []
                primary_id = data.get("primary_email_address_id")

                def _verified(a: dict) -> bool:
                    return (a.get("verification") or {}).get("status") == "verified"

                # Prefer the verified primary address.
                for a in addrs:
                    if a.get("id") == primary_id and a.get("email_address") and _verified(a):
                        return a["email_address"]
                # Otherwise any verified address.
                for a in addrs:
                    if a.get("email_address") and _verified(a):
                        return a["email_address"]
        except Exception:
            pass
    return None


def get_current_user_clerk(request: Request) -> User:
    """FastAPI dependency for Clerk-backed auth. Same return contract as the
    password path's get_current_user, so every endpoint works unchanged."""
    claims = verify_token(_bearer(request))
    clerk_id = claims.get("sub")
    if not clerk_id:
        raise HTTPException(401, "Invalid session (no subject).")

    # 1. Already linked.
    user = _db.get_user_by_clerk_id(clerk_id)
    if user:
        return user

    email = _email_from_claims(claims)
    if not email:
        raise HTTPException(
            401,
            "Could not determine this account's email. Add an 'email' claim to "
            "the Clerk JWT template, or set CLERK_SECRET_KEY on the server.",
        )

    # 2. Link to an existing internal row by email — this is what preserves a
    #    pre-Clerk user's library.
    existing = _db.get_user_by_email(email)
    if existing:
        _db.link_clerk_id(existing.id, clerk_id)
        return _db.get_user_by_clerk_id(clerk_id) or existing

    # 3. Brand-new account.
    return _db.create_user_for_clerk(email, clerk_id)
