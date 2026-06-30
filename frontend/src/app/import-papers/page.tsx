"use client";

import { useState } from "react";
import { api, ImportResult } from "@/lib/api";
import { PageHeader, Card, Spinner, EmptyState, SectionLabel } from "@/components/ui";
import { Search, Plus, ExternalLink, CheckCircle2, Download } from "lucide-react";

const inputCls =
  "w-full bg-[var(--surface-1)] border border-[var(--line)] rounded-[var(--r-md)] px-3.5 py-2.5 text-[13.5px] text-[var(--text-1)] placeholder:text-[var(--text-4)] outline-none t-all focus:border-[var(--gen-line)]";

export default function ImportPage() {
  const [lookupId, setLookupId] = useState("");
  const [query, setQuery] = useState("");
  const [sources, setSources] = useState(["semantic_scholar", "openalex", "arxiv"]);
  const [maxResults, setMaxResults] = useState(5);
  const [results, setResults] = useState<ImportResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState("");
  const [importing, setImporting] = useState<Record<number, string>>({});

  const handleLookup = async () => {
    if (!lookupId.trim()) return;
    setLoading(true); setResults([]); setError("");
    try {
      const r = await api.importLookup(lookupId.trim());
      setResults([r]);
    } catch (e: any) { setError(e.message || "Lookup failed."); }
    setSearched(true); setLoading(false);
  };

  const handleSearch = async () => {
    if (!query.trim()) return;
    if (sources.length === 0) { setError("Select at least one source to search."); return; }
    setLoading(true); setResults([]); setError("");
    try {
      const res = await api.importSearch(query, sources, maxResults);
      setResults(res);
    } catch (e: any) { setError(e.message || "Search failed."); }
    setSearched(true); setLoading(false);
  };

  const handleAdd = async (r: ImportResult, idx: number) => {
    setImporting((p) => ({ ...p, [idx]: "importing" }));
    try {
      const res = await api.importAdd(r);
      setImporting((p) => ({ ...p, [idx]: res.status === "duplicate" ? "dup" : "done" }));
    } catch (e: any) {
      setImporting((p) => ({ ...p, [idx]: `error: ${e.message}` }));
    }
  };

  const toggleSource = (s: string) =>
    setSources((prev) => prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]);

  return (
    <div>
      <PageHeader
        title="Import papers"
        subtitle="Search Semantic Scholar, OpenAlex, and arXiv, or paste a DOI or arXiv ID."
      />

      {/* Quick lookup */}
      <Card className="mb-4">
        <SectionLabel>Quick lookup</SectionLabel>
        <div className="flex gap-2">
          <input
            type="text" value={lookupId}
            onChange={(e) => setLookupId(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLookup()}
            placeholder="arXiv ID (2301.12345), DOI (10.1145/…), or URL"
            className={inputCls}
          />
          <button
            onClick={handleLookup}
            className="px-4 py-2.5 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-2)] text-[13px] text-[var(--text-2)] t-all hover:border-[var(--line-2)] hover:text-[var(--text-1)]"
          >
            Lookup
          </button>
        </div>
      </Card>

      {/* Search */}
      <Card className="mb-6">
        <SectionLabel>Search databases</SectionLabel>
        <div className="flex gap-2 mb-3">
          <input
            type="text" value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            placeholder="e.g., LLM negotiation coaching feedback"
            className={inputCls}
          />
          <button
            onClick={handleSearch} disabled={loading}
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-[var(--r-md)] bg-[var(--gen)] text-white text-[13px] font-medium t-all hover:opacity-90 disabled:opacity-40"
          >
            <Search size={14} />
          </button>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex gap-1.5">
            {["semantic_scholar", "openalex", "arxiv"].map((s) => (
              <button
                key={s}
                onClick={() => toggleSource(s)}
                className={`px-3 py-1.5 rounded-[var(--r-md)] text-[12px] font-medium border t-all ${
                  sources.includes(s)
                    ? "bg-[var(--gen-dim)] border-[var(--gen-line)] text-[var(--gen)]"
                    : "border-[var(--line)] text-[var(--text-3)] hover:text-[var(--text-2)]"
                }`}
              >
                {s.replace("_", " ")}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <span className="text-[11.5px] text-[var(--text-3)]">Per source: {maxResults}</span>
            <input
              type="range" min={3} max={10} value={maxResults}
              onChange={(e) => setMaxResults(parseInt(e.target.value))}
              className="w-20"
            />
          </div>
        </div>
      </Card>

      {error && (
        <div className="bg-[var(--contra-dim)] border border-[var(--contra-line)] rounded-[var(--r-lg)] p-3.5 mb-4 text-[12.5px] text-[var(--contra)]">
          {error}
        </div>
      )}

      {loading && <Card><Spinner label="Searching databases…" /></Card>}

      {!loading && !searched && (
        <EmptyState
          icon={<Download size={20} />}
          title="Find papers to add"
          hint="Search Semantic Scholar, OpenAlex, and arXiv above, or paste an arXiv ID, DOI, or URL for a direct lookup."
        />
      )}

      {!loading && searched && results.length === 0 && (
        <EmptyState
          icon={<Search size={20} />}
          title="No papers found"
          hint="Try different keywords, or widen the sources you're searching."
        />
      )}

      {results.length > 0 && (
        <div className="space-y-3">
          <div className="text-[11.5px] text-[var(--text-3)] mb-1">
            {results.length} paper{results.length !== 1 ? "s" : ""} found
          </div>
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
                    <div className="text-[14px] font-medium text-[var(--text-1)] leading-snug mb-1">
                      {r.title}
                    </div>
                    <div className="text-[12px] text-[var(--text-3)] mb-2">{authorsStr}</div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-[var(--text-3)] mb-2">
                      <span>{r.source.toUpperCase().replace("_", " ")}</span>
                      <span>{r.year || "?"}</span>
                      {r.pdf_url && <span className="text-[var(--support)]">PDF available</span>}
                      {r.citation_count != null && <span>{r.citation_count} citations</span>}
                    </div>
                    {abstractStr && (
                      <div className="text-[12.5px] text-[var(--text-2)] leading-[1.55]">
                        {abstractStr}
                      </div>
                    )}
                  </div>

                  <div className="flex flex-col items-end gap-2 shrink-0">
                    {status === "done" ? (
                      <span className="flex items-center gap-1 text-[12px] text-[var(--support)]">
                        <CheckCircle2 size={13} /> Added
                      </span>
                    ) : status === "dup" ? (
                      <span className="text-[12px] text-[var(--text-3)]">Already in library</span>
                    ) : status === "importing" ? (
                      <Spinner />
                    ) : r.pdf_url ? (
                      <button
                        onClick={() => handleAdd(r, i)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--r-md)] bg-[var(--gen-dim)] border border-[var(--gen-line)] text-[var(--gen)] text-[12.5px] font-medium t-all hover:opacity-90"
                      >
                        <Plus size={13} /> Add
                      </button>
                    ) : (
                      <span className="text-[12px] text-[var(--text-4)]">No PDF</span>
                    )}
                    <a
                      href={r.url} target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-1 text-[12px] text-[var(--gen)] hover:underline"
                    >
                      View <ExternalLink size={11} />
                    </a>
                    {status?.startsWith("error") && (
                      <span className="text-[11px] text-[var(--contra)]">{status}</span>
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
