"use client";

import { useState } from "react";
import { api, ImportResult } from "@/lib/api";
import { PageHeader, Card, Spinner, EmptyState } from "@/components/ui";
import { Search, Plus, ExternalLink, CheckCircle2, Download } from "lucide-react";

export default function ImportPage() {
  const [lookupId, setLookupId] = useState("");
  const [query, setQuery] = useState("");
  const [sources, setSources] = useState(["arxiv", "semantic_scholar"]);
  const [maxResults, setMaxResults] = useState(5);
  const [results, setResults] = useState<ImportResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false); // distinguishes "no search yet" from "0 results"
  const [importing, setImporting] = useState<Record<number, string>>({}); // idx -> status

  const handleLookup = async () => {
    if (!lookupId.trim()) return;
    setLoading(true);
    setResults([]);
    try {
      const r = await api.importLookup(lookupId.trim());
      setResults([r]);
    } catch (e: any) {
      alert(e.message);
    }
    setSearched(true);
    setLoading(false);
  };

  const handleSearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setResults([]);
    try {
      const res = await api.importSearch(query, sources, maxResults);
      setResults(res);
    } catch (e: any) {
      alert(e.message);
    }
    setSearched(true);
    setLoading(false);
  };

  const handleAdd = async (r: ImportResult, idx: number) => {
    setImporting((p) => ({ ...p, [idx]: "importing" }));
    try {
      await api.importAdd(r);
      setImporting((p) => ({ ...p, [idx]: "done" }));
    } catch (e: any) {
      setImporting((p) => ({ ...p, [idx]: `error: ${e.message}` }));
    }
  };

  const toggleSource = (s: string) => {
    setSources((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]
    );
  };

  return (
    <div>
      <PageHeader
        title="Import Papers"
        subtitle="Search arXiv and Semantic Scholar, or paste a DOI or arXiv ID."
      />

      {/* Quick lookup */}
      <Card hover={false} className="mb-4">
        <label className="font-mono text-[10px] text-slate-600 uppercase tracking-wider block mb-2">
          Quick lookup
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={lookupId}
            onChange={(e) => setLookupId(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLookup()}
            placeholder="arXiv ID (2301.12345), DOI (10.1145/...), or URL"
            className="flex-1 bg-black/20 border border-[var(--border)] rounded-lg px-4 py-2.5 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500/40"
          />
          <button
            onClick={handleLookup}
            className="px-4 py-2.5 rounded-lg bg-[var(--card)] border border-[var(--border)] text-sm text-slate-400 hover:text-cyan-400 hover:border-cyan-500/30 transition-all"
          >
            Lookup
          </button>
        </div>
      </Card>

      {/* Search */}
      <Card hover={false} className="mb-6">
        <label className="font-mono text-[10px] text-slate-600 uppercase tracking-wider block mb-2">
          Search databases
        </label>
        <div className="flex gap-2 mb-3">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            placeholder="e.g., LLM negotiation coaching feedback"
            className="flex-1 bg-black/20 border border-[var(--border)] rounded-lg px-4 py-2.5 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500/40"
          />
          <button
            onClick={handleSearch}
            disabled={loading}
            className="px-5 py-2.5 rounded-lg bg-gradient-to-r from-blue-500 to-cyan-500 text-white text-sm font-semibold hover:shadow-lg hover:shadow-blue-500/20 transition-all disabled:opacity-50"
          >
            <Search size={14} />
          </button>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex gap-2">
            {["arxiv", "semantic_scholar"].map((s) => (
              <button
                key={s}
                onClick={() => toggleSource(s)}
                className={`px-3 py-1 rounded-lg text-xs font-mono border transition-all
                  ${sources.includes(s)
                    ? "bg-cyan-500/10 text-cyan-400 border-cyan-500/30"
                    : "text-slate-600 border-[var(--border)] hover:text-slate-400"
                  }`}
              >
                {s.replace("_", " ")}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <span className="font-mono text-[10px] text-slate-600">Per source: {maxResults}</span>
            <input
              type="range" min={3} max={10} value={maxResults}
              onChange={(e) => setMaxResults(parseInt(e.target.value))}
              className="w-20 accent-cyan-500"
            />
          </div>
        </div>
      </Card>

      {loading && <Spinner label="Searching databases..." />}

      {/* Empty state before any search has run */}
      {!loading && !searched && (
        <EmptyState
          icon={<Download size={20} />}
          title="Find papers to add"
          hint="Search arXiv and Semantic Scholar above, or paste an arXiv ID, DOI, or URL for a direct lookup."
        />
      )}

      {/* No results after a search */}
      {!loading && searched && results.length === 0 && (
        <EmptyState
          icon={<Search size={20} />}
          title="No papers found"
          hint="Try different keywords, or widen the sources you're searching."
        />
      )}

      {/* Results */}
      {results.length > 0 && (
        <div className="space-y-3">
          <p className="font-mono text-xs text-slate-600">
            {results.length} paper{results.length !== 1 ? "s" : ""} found
          </p>
          {results.map((r, i) => {
            const status = importing[i];
            const authorsStr = r.authors.length > 3
              ? r.authors.slice(0, 3).join(", ") + ` +${r.authors.length - 3}`
              : r.authors.join(", ");
            const abstractStr = r.abstract && r.abstract.length > 280
              ? r.abstract.slice(0, 280).trimEnd() + "…"
              : r.abstract;

            return (
              <Card key={i}>
                <div className="flex justify-between items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-slate-200 text-sm leading-snug mb-1">
                      {r.title}
                    </div>
                    <div className="text-xs text-slate-400 mb-2">{authorsStr}</div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-slate-600 mb-2">
                      <span>◇ {r.source.toUpperCase().replace("_", " ")}</span>
                      <span>◆ {r.year || "?"}</span>
                      {r.pdf_url && <span className="text-emerald-500">◇ PDF available</span>}
                      {r.citation_count != null && <span>◆ {r.citation_count} cited</span>}
                    </div>
                    <div className="text-xs text-slate-500 leading-relaxed">
                      {abstractStr}
                    </div>
                  </div>

                  <div className="flex flex-col items-end gap-2 shrink-0">
                    {status === "done" ? (
                      <span className="flex items-center gap-1 text-xs text-emerald-400">
                        <CheckCircle2 size={12} /> Added
                      </span>
                    ) : status === "importing" ? (
                      <Spinner />
                    ) : r.pdf_url ? (
                      <button
                        onClick={() => handleAdd(r, i)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gradient-to-r from-blue-500 to-cyan-500 text-white text-xs font-semibold hover:shadow-lg hover:shadow-blue-500/20 transition-all"
                      >
                        <Plus size={12} /> Add
                      </button>
                    ) : (
                      <span className="font-mono text-[10px] text-slate-600">No PDF</span>
                    )}
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-[10px] text-blue-400 hover:text-blue-300"
                    >
                      <ExternalLink size={10} /> View
                    </a>
                    {status && status.startsWith("error") && (
                      <span className="text-[10px] text-rose-400">{status}</span>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
