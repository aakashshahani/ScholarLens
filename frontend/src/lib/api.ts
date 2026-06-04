/**
 * ScholarLens API Client — typed fetch wrapper for the FastAPI backend.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

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
  relevance: number;                        // raw score (kept for compat)
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
  novelty: "high" | "medium" | "low";
  novelty_score: number;                    // cosine distance from corpus (0-1)
  novelty_tier: "high" | "medium" | "low" | "unknown";
  impact: "high" | "medium" | "low";
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
  errors: string[];
  papers: number;
  embeddings: number;
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

// ── Fetch helper ────────────────────────────────────────────

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    throw new ApiError(res.status, body.detail || res.statusText);
  }
  return res.json();
}

// ── API methods ─────────────────────────────────────────────

export const api = {
  health: () => apiFetch<HealthStatus>("/api/health"),

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
    const res = await fetch(`${API_BASE}/api/papers/upload`, { method: "POST", body: formData });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ detail: res.statusText }));
      throw new ApiError(res.status, body.detail || res.statusText);
    }
    return res.json() as Promise<{ id: string; title: string; status: string; message: string }>;
  },

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

  // Returns cached count without triggering a new scan
  contradictionCount: () =>
    apiFetch<{ count: number; last_scanned: string | null }>("/api/contradictions/count"),

  generateHypotheses: (opts?: { researchQuestion?: string; paperIds?: string[]; numHypotheses?: number }) =>
    apiFetch<Hypothesis[]>("/api/hypotheses", {
      method: "POST",
      body: JSON.stringify({
        research_question: opts?.researchQuestion || null,
        paper_ids: opts?.paperIds || null,
        num_hypotheses: opts?.numHypotheses ?? 5,
      }),
    }),

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
        relevance_threshold: opts.relevanceThreshold ?? 0.3,
        max_per_source: opts.maxPerSource ?? 5,
      }),
    }),

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
