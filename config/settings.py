"""
ScholarLens configuration — all secrets via env vars.
Copy .env.example to .env and fill in your keys.
"""

import os
from pathlib import Path
from dataclasses import dataclass, field

# Auto-load .env file if it exists
BASE_DIR = Path(__file__).resolve().parent.parent
_env_file = BASE_DIR / ".env"
if _env_file.exists():
    from dotenv import load_dotenv
    load_dotenv(_env_file)

# DATA_DIR is overridable so a deployed host can point it at a PERSISTENT
# volume. On most PaaS the default working dir is ephemeral — if DATA_DIR
# lands there, the SQLite DB and ChromaDB store are wiped on every redeploy.
# Set DATA_DIR=/data (or wherever the mounted volume lives) in production.
DATA_DIR = Path(os.getenv("DATA_DIR", str(BASE_DIR / "data")))
UPLOAD_DIR = DATA_DIR / "uploads"
CHROMA_DIR = DATA_DIR / "chroma"
SQLITE_PATH = DATA_DIR / "scholarlens.db"

# Ensure dirs exist
for d in [DATA_DIR, UPLOAD_DIR, CHROMA_DIR]:
    d.mkdir(parents=True, exist_ok=True)


def _env_int(name: str, default: int) -> int:
    """Parse an int env var, falling back to default on missing/garbage."""
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def _env_bool(name: str, default: bool) -> bool:
    """Parse a boolean env var ('1','true','yes','on' -> True)."""
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class Settings:
    anthropic_api_key: str = field(
        default_factory=lambda: os.getenv("ANTHROPIC_API_KEY", "")
    )
    anthropic_model: str = "claude-haiku-4-5-20251001"

    # BYOK model allowlist. `tier` drives the free-tier ceiling: on the SERVER
    # key, Haiku is unlimited, Sonnet is metered (free_sonnet_limit), and Opus
    # is never run (floored to Haiku). With their OWN key, a user may pick any
    # of these. Validated on settings update so an arbitrary string can't slip
    # through and break every call.
    ALLOWED_MODELS = {
        "claude-haiku-4-5-20251001": {"label": "Haiku — fastest, cheapest", "tier": "haiku"},
        "claude-sonnet-4-6":         {"label": "Sonnet — balanced",         "tier": "sonnet"},
        "claude-opus-4-8":           {"label": "Opus — most capable",       "tier": "opus"},
    }
    # Free Sonnet actions allowed on the SERVER key before BYOK is required.
    free_sonnet_limit: int = field(default_factory=lambda: _env_int("FREE_SONNET_LIMIT", 2))
    # Total free actions (Haiku + Sonnet) on the SERVER key before BYOK required.
    free_action_limit: int = field(default_factory=lambda: _env_int("FREE_ACTION_LIMIT", 15))

    # Embedding model — all-MiniLM-L6-v2 (384-dim, general-purpose).
    # BGE-base was tested and rejected: score compression on narrow-domain
    # negotiation/AI text made distance thresholds unreliable.
    # NOTE: changing this model requires re-embedding the full library.
    embedding_model: str = "all-MiniLM-L6-v2"

    # MiniLM does not require a query instruction prefix (unlike BGE retrieval
    # models). This field is intentionally absent — embed_query() in
    # VectorStore uses the text as-is.

    # Chunking params
    chunk_size: int = 500          # tokens per chunk
    chunk_overlap: int = 50        # overlap tokens

    # ChromaDB
    chroma_collection: str = "papers"

    # Semantic search relevance tiers (cosine distance, lower = more similar).
    # Calibrated for MiniLM on narrow-domain academic text.
    relevance_highly_relevant: float = 0.20   # distance < 0.20
    relevance_related: float = 0.40           # 0.20 <= distance < 0.40
    # distance >= 0.40 → "tangential"

    # External APIs
    semantic_scholar_key: str = field(
        default_factory=lambda: os.getenv("SEMANTIC_SCHOLAR_KEY", "")
    )

    # ── Security / deploy config ─────────────────────────────
    # Admin token guards expensive maintenance endpoints. When unset they are
    # LOCKED (403) — the safe default for prod. Compared in constant time.
    admin_token: str = field(default_factory=lambda: os.getenv("ADMIN_TOKEN", ""))

    # Production frontend origin for CORS. allow_credentials=True forbids "*",
    # so the deployed Vercel URL must be listed explicitly.
    frontend_origin: str = field(default_factory=lambda: os.getenv("FRONTEND_ORIGIN", ""))

    # Upload hard cap, enforced by a bounded read before validation runs.
    max_upload_bytes: int = field(default_factory=lambda: _env_int("MAX_UPLOAD_MB", 25) * 1024 * 1024)

    # Free-text input ceiling (defense against oversized prompt payloads).
    max_query_len: int = 2000

    # ── Rate limiting (slowapi) ──────────────────────────────
    # Per-IP limits. PRE-AUTH defaults — revisit once BYOK shifts model cost
    # onto tenant keys. Empty storage -> in-memory (single instance). Set
    # RATE_LIMIT_STORAGE_URI=redis://host:6379 to share across instances.
    rate_limit_storage_uri: str = field(
        default_factory=lambda: os.getenv("RATE_LIMIT_STORAGE_URI", "") or "memory://"
    )
    rl_default: str = field(default_factory=lambda: os.getenv("RL_DEFAULT", "1000/hour"))
    rl_upload: str = field(default_factory=lambda: os.getenv("RL_UPLOAD", "10/hour"))
    rl_contradictions: str = field(default_factory=lambda: os.getenv("RL_CONTRADICTIONS", "20/hour"))
    rl_hypotheses: str = field(default_factory=lambda: os.getenv("RL_HYPOTHESES", "20/hour"))
    rl_ask: str = field(default_factory=lambda: os.getenv("RL_ASK", "60/hour"))
    rl_search: str = field(default_factory=lambda: os.getenv("RL_SEARCH", "120/hour"))
    rl_monitor: str = field(default_factory=lambda: os.getenv("RL_MONITOR", "10/hour"))
    rl_import_search: str = field(default_factory=lambda: os.getenv("RL_IMPORT_SEARCH", "30/hour"))
    rl_import_add: str = field(default_factory=lambda: os.getenv("RL_IMPORT_ADD", "20/hour"))

    # ── Auth / sessions / BYOK ───────────────────────────────
    # Fernet key for encrypting tenant Anthropic keys at rest. MUST be stable
    # across restarts or stored keys become undecryptable. Generate once:
    #   python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    # then set FERNET_KEY in .env.
    fernet_key: str = field(default_factory=lambda: os.getenv("FERNET_KEY", ""))

    session_cookie_name: str = "session"
    session_ttl_days: int = field(default_factory=lambda: _env_int("SESSION_TTL_DAYS", 7))
    # Secure flag MUST be False on localhost (http) or the browser drops the
    # cookie. Set COOKIE_SECURE=true in production (https).
    cookie_secure: bool = field(default_factory=lambda: _env_bool("COOKIE_SECURE", False))
    cookie_samesite: str = "lax"

    rl_login: str = field(default_factory=lambda: os.getenv("RL_LOGIN", "10/minute"))
    rl_register: str = field(default_factory=lambda: os.getenv("RL_REGISTER", "5/hour"))

    def validate(self) -> list[str]:
        errors = []
        if not self.anthropic_api_key:
            errors.append("ANTHROPIC_API_KEY not set")
        return errors

    def relevance_tier(self, cosine_distance: float) -> str:
        """
        Map a cosine distance to a human-readable relevance tier.

        Args:
            cosine_distance: Value in [0, 1] from ChromaDB (lower = more similar).

        Returns:
            "highly_relevant", "related", or "tangential"
        """
        if cosine_distance < self.relevance_highly_relevant:
            return "highly_relevant"
        if cosine_distance < self.relevance_related:
            return "related"
        return "tangential"


settings = Settings()
