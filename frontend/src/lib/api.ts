/**
 * ScholarLens API Client — typed fetch wrapper for the FastAPI backend.
 *
 * Auth: the backend sets an httpOnly session cookie on login/register. Every
 * request below sends `credentials: "include"` so the browser attaches that
 * cookie cross-origin (frontend on :3000 / Vercel, backend on :8000 / Railway).
 * Without it, every authenticated call returns 401.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

// ── Session token storage ────────────────────────────────────
// Stored in localStorage as a fallback for cross-origin deployments
// where third-party cookies are blocked (Chrome 2024+).
// The httpOnly cookie is still set by the backend and used in same-origin
// or cookie-friendly environments.
const TOKEN_KEY = "sl_session_token";

function saveToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* SSR or storage disabled */ }
}

function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

// ── Types ───────────────────────────────────────────────────

export interface Paper {
  id: string;
  title: string;
  authors: string[];
  abstract: string;
  year: number | null;
  source: string;
  page_count: number | null;
  created_at: string;
  analysis_types?: string[];
  chunk_count?: number;
  analyses?: Analysis[];
}

export interface Analysis {
  id: string;
  type: string;
  content: string;
  created_at: string;
}

export interface SearchResult {
  paper_id: string;
  paper_title: string;
  section: string | null;
  text: string;
  // Backend returns a raw cosine distance (lower = more similar) plus a tier.
  relevance_score: number;
  relevance_tier?: "highly_relevant" | "related" | "tangential";
}

export interface ContradictionResult {
  id: string;
  relationship: "contradiction" | "nuance" | "support" | "unrelated" | "error";
  category: string;
  explanation: string;
  resolution: string;
  stronger_evidence: string;
  similarity?: number;
  claim_a: { paper_id: string; paper_title: string; text: string; confidence: string };
  claim_b: { paper_id: string; paper_title: string; text: string; confidence: string };
  created_at: string;
}

export interface Hypothesis {
  id: string;
  statement: string;
  rationale: string;
  supporting_papers: { paper_id: string; title: string; relevant_finding: string }[];
  source_conflicts: string[];               // validated relationship IDs
  grounding: "detected_conflicts" | "single_paper_gaps" | string;
  methodology: string;
  challenges: string[];
  // Deterministic novelty signal (cosine distance from corpus). The old
  // self-assessed `novelty`/`impact` string tiers were removed server-side.
  novelty_score: number;
  novelty_tier: "high" | "medium" | "low" | "unknown";
  research_question: string;
  created_at: string;
}

export interface ImportResult {
  title: string;
  authors: string[];
  abstract: string;
  year: number | null;
  source: string;
  source_id: string;
  doi: string | null;
  pdf_url: string | null;
  citation_count: number | null;
  url: string;
}

export interface MonitorTopic {
  id: string;
  name: string;
  keywords: string[];
  sources: string[];
  is_active: boolean;
  last_scanned_at: string | null;
  created_at: string;
}

export interface MonitorDigest {
  topic: string;
  papers_found: number;
  papers_relevant: number;
  scan_time: string;
  papers: {
    title: string;
    authors: string[];
    year: number | null;
    source: string;
    abstract: string;
    url: string;
    pdf_url: string | null;
    relevance_score: number;
    relevance_tier?: string;
    relevance_reason: string;
  }[];
}

export interface MonitorScanResponse {
  digests: MonitorDigest[];
  email_requested: boolean;
  email_sent: boolean;
  email_error: string | null;
  sources_failed: string[];
}

export interface HealthStatus {
  status: "ok" | "degraded";
  papers: number;
  library_fingerprint: string;
}

export interface PaperStatus {
  id: string;
  title: string;
  analysis_count: number;
  analysis_types: string[];
  complete: boolean;
  missing: string[];
}

export interface GraphNode {
  id: string;
  claim: string;
  paper_id: string;
  paper_title: string;
  section: string;
  confidence: string;
  degree: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  relationship: "contradiction" | "support" | "nuance" | "unrelated";
  category: string;
  similarity: number;
  explanation: string;
}

export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  papers: { id: string; title: string }[];
}

export interface Insight {
  id: string;
  type: "contradiction" | "consensus" | "gap" | "hypothesis" | "new_paper";
  headline: string;
  claim: string;
  detail: string;
  papers: string[];
  created_at: string;
}

export interface ContradictionCount {
  counts: { contradiction: number; support: number; nuance: number; unrelated: number };
  total: number;
  last_scanned: string | null;
}

// ── Auth / settings types ───────────────────────────────────

export interface AuthUser {
  id: string;
  email: string;
  model: string;
  digest_email: string | null;
  library_name: string;
  has_api_key: boolean;
  // Free-tier meters (server key). BYOK users are uncapped.
  free_actions_used: number;
  free_action_limit: number;
  free_sonnet_used: number;
  free_sonnet_limit: number;
}

export interface AllowedModel {
  id: string;
  label: string;
  tier: "haiku" | "sonnet" | "opus";
}

export interface UserSettings extends AuthUser {
  api_key_masked: string | null;
  allowed_models: AllowedModel[];
}

// ── Fetch helper ────────────────────────────────────────────

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const authHeaders: Record<string, string> = token
    ? { "Authorization": `Bearer ${token}` }
    : {};
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include", // send the httpOnly session cookie (same-origin)
    headers: { "Content-Type": "application/json", ...authHeaders, ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    throw new ApiError(res.status, body.detail || res.statusText);
  }
  // 204 / empty-body responses
  if (res.status === 204) return undefined as T;
  return res.json();
}

// ── API methods ─────────────────────────────────────────────

export const api = {
  health: () => apiFetch<HealthStatus>("/api/health"),

  // ── Auth ──────────────────────────────────────────────────
  register: async (email: string, password: string) => {
    const res = await apiFetch<AuthUser & { session_token?: string }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    if (res.session_token) saveToken(res.session_token);
    return res;
  },

  login: async (email: string, password: string) => {
    const res = await apiFetch<AuthUser & { session_token?: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    if (res.session_token) saveToken(res.session_token);
    return res;
  },

  logout: async () => {
    const res = await apiFetch<{ status: string }>("/api/auth/logout", { method: "POST" });
    saveToken(null);
    return res;
  },

  logoutAll: async () => {
    const res = await apiFetch<{ status: string }>("/api/auth/logout-all", { method: "POST" });
    saveToken(null);
    return res;
  },

  me: () => apiFetch<AuthUser>("/api/auth/me"),

  // ── Settings (BYOK) ───────────────────────────────────────
  getSettings: () => apiFetch<UserSettings>("/api/settings"),

  updateSettings: (patch: {
    model?: string;
    digestEmail?: string | null;
    libraryName?: string;
    apiKey?: string | null; // "" clears the stored key; omit to leave unchanged
  }) =>
    apiFetch<AuthUser>("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        model: patch.model,
        digest_email: patch.digestEmail,
        library_name: patch.libraryName,
        api_key: patch.apiKey,
      }),
    }),

  testApiKey: (apiKey?: string) =>
    apiFetch<{ valid: boolean; error?: string }>("/api/settings/test-key", {
      method: "POST",
      body: JSON.stringify({ api_key: apiKey ?? null }),
    }),

  // ── Papers ────────────────────────────────────────────────
  listPapers: (limit = 50, offset = 0) =>
    apiFetch<Paper[]>(`/api/papers?limit=${limit}&offset=${offset}`),

  getPaper: (id: string) => apiFetch<Paper>(`/api/papers/${id}`),

  deletePaper: (id: string) =>
    apiFetch<{ status: string }>(`/api/papers/${id}`, { method: "DELETE" }),

  paperStatus: (id: string) => apiFetch<PaperStatus>(`/api/papers/${id}/status`),

  reanalyze: (id: string) =>
    apiFetch<{ id: string; status: string }>(`/api/papers/${id}/reanalyze`, { method: "POST" }),

  uploadPaper: async (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    // NOTE: no Content-Type header — the browser sets the multipart boundary.
    const uploadToken = getToken();
    const uploadAuthHeaders: Record<string, string> = uploadToken
      ? { "Authorization": `Bearer ${uploadToken}` }
      : {};
    const res = await fetch(`${API_BASE}/api/papers/upload`, {
      method: "POST",
      body: formData,
      credentials: "include",
      headers: uploadAuthHeaders,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ detail: res.statusText }));
      throw new ApiError(res.status, body.detail || res.statusText);
    }
    return res.json() as Promise<{ id: string; title: string; status: string; message: string }>;
  },

  // ── Search / Ask ──────────────────────────────────────────
  search: (query: string, nResults = 10, paperId?: string) =>
    apiFetch<SearchResult[]>("/api/search", {
      method: "POST",
      body: JSON.stringify({ query, n_results: nResults, paper_id: paperId || null }),
    }),

  ask: (question: string, paperId?: string) =>
    apiFetch<{ answer: string }>("/api/ask", {
      method: "POST",
      body: JSON.stringify({ question, paper_id: paperId || null }),
    }),

  // ── Contradictions ────────────────────────────────────────
  listContradictions: () =>
    apiFetch<ContradictionResult[]>("/api/contradictions"),

  runContradictions: (opts?: { paperIds?: string[]; similarityThreshold?: number; maxPairs?: number }) =>
    apiFetch<ContradictionResult[]>("/api/contradictions", {
      method: "POST",
      body: JSON.stringify({
        paper_ids: opts?.paperIds || null,
        similarity_threshold: opts?.similarityThreshold ?? 0.5,
        max_pairs: opts?.maxPairs ?? 15,
      }),
    }),

  // Returns cached counts without triggering a new scan
  contradictionCount: () =>
    apiFetch<ContradictionCount>("/api/contradictions/count"),

  // ── Hypotheses ────────────────────────────────────────────
  getCachedHypotheses: () =>
    apiFetch<Hypothesis[]>("/api/hypotheses"),

  generateHypotheses: (opts?: { researchQuestion?: string; paperIds?: string[]; numHypotheses?: number; refresh?: boolean }) =>
    apiFetch<Hypothesis[]>("/api/hypotheses", {
      method: "POST",
      body: JSON.stringify({
        research_question: opts?.researchQuestion || null,
        paper_ids: opts?.paperIds || null,
        num_hypotheses: opts?.numHypotheses ?? 5,
        refresh: opts?.refresh ?? false,
      }),
    }),

  // ── Import ────────────────────────────────────────────────
  importSearch: (query: string, sources?: string[], maxPerSource?: number) =>
    apiFetch<ImportResult[]>("/api/import/search", {
      method: "POST",
      body: JSON.stringify({
        query,
        sources: sources || ["arxiv", "semantic_scholar"],
        max_per_source: maxPerSource ?? 5,
      }),
    }),

  importLookup: (identifier: string) =>
    apiFetch<ImportResult>("/api/import/lookup", {
      method: "POST",
      body: JSON.stringify({ identifier }),
    }),

  importAdd: (paper: ImportResult) =>
    apiFetch<{ id: string; title: string; status: string }>("/api/import/add", {
      method: "POST",
      body: JSON.stringify(paper),
    }),

  // ── Monitor ───────────────────────────────────────────────
  monitorScan: (opts: {
    topics: { name: string; keywords: string[]; sources?: string[] }[];
    email?: string;
    relevanceThreshold?: number;
    maxPerSource?: number;
  }) =>
    apiFetch<MonitorScanResponse>("/api/monitor/scan", {
      method: "POST",
      body: JSON.stringify({
        topics: opts.topics,
        email: opts.email || null,
        relevance_threshold: opts.relevanceThreshold ?? 0.5,
        max_per_source: opts.maxPerSource ?? 5,
      }),
    }),

  // ── Monitor topics (saved) ───────────────────────────────
  listMonitorTopics: () =>
    apiFetch<MonitorTopic[]>("/api/monitor/topics"),

  createMonitorTopic: (topic: { name: string; keywords: string[]; sources?: string[] }) =>
    apiFetch<MonitorTopic>("/api/monitor/topics", {
      method: "POST",
      body: JSON.stringify({
        name: topic.name,
        keywords: topic.keywords,
        sources: topic.sources ?? ["semantic_scholar", "openalex", "arxiv"],
      }),
    }),

  deleteMonitorTopic: (topicId: string) =>
    apiFetch<{ status: string; id: string }>(`/api/monitor/topics/${topicId}`, {
      method: "DELETE",
    }),

  testDigest: () =>
    apiFetch<{
      email_sent: boolean;
      email_error: string | null;
      papers_relevant: number;
      topics_scanned: number;
      sources_failed: string[];
    }>("/api/monitor/test-digest", { method: "POST" }),

  // ── Graph / Insights ──────────────────────────────────────
  graph: (opts?: { paperIds?: string[]; similarityThreshold?: number; maxPairs?: number; compute?: boolean }) =>
    apiFetch<GraphPayload>("/api/graph", {
      method: "POST",
      body: JSON.stringify({
        paper_ids: opts?.paperIds || null,
        similarity_threshold: opts?.similarityThreshold ?? 0.5,
        max_pairs: opts?.maxPairs ?? 30,
        compute: opts?.compute ?? false,
      }),
    }),

  insights: (opts?: { paperIds?: string[]; limit?: number }) =>
    apiFetch<Insight[]>("/api/insights", {
      method: "POST",
      body: JSON.stringify({ paper_ids: opts?.paperIds || null, limit: opts?.limit ?? 30 }),
    }),
};
