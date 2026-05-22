"use client";

import { useState } from "react";
import { api, SearchResult as SR } from "@/lib/api";
import { PageHeader, Card, EmptyState, Spinner } from "@/components/ui";

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"search" | "ask">("search");
  const [results, setResults] = useState<SR[]>([]);
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setResults([]);
    setAnswer("");
    try {
      if (mode === "search") {
        const res = await api.search(query, 10);
        setResults(res);
      } else {
        const res = await api.ask(query);
        setAnswer(res.answer);
      }
    } catch (e: any) {
      setAnswer(`Error: ${e.message}`);
    }
    setLoading(false);
  };

  return (
    <div>
      <PageHeader
        title="Search"
        subtitle="Query your entire library using natural language."
      />

      {/* Mode toggle */}
      <div className="flex gap-1 bg-[#0a0f1a] border border-[var(--border)] rounded-xl p-1 mb-4 w-fit">
        {(["search", "ask"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`px-4 py-1.5 rounded-lg font-mono text-xs tracking-wide transition-all
              ${mode === m
                ? "bg-[var(--card)] text-cyan-400 border border-[var(--border)]"
                : "text-slate-500 hover:text-slate-300"}`}
          >
            {m === "search" ? "SEARCH LIBRARY" : "ASK A QUESTION"}
          </button>
        ))}
      </div>

      {/* Search bar */}
      <div className="flex gap-2 mb-6">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          placeholder={
            mode === "search"
              ? "e.g., methods for detecting amyloid plaques"
              : "e.g., What are the main limitations across all papers?"
          }
          className="flex-1 bg-[var(--card)] border border-[var(--border)] rounded-lg px-4 py-3 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500/40"
        />
        <button
          onClick={handleSearch}
          disabled={loading}
          className="px-6 py-3 rounded-lg bg-gradient-to-r from-blue-500 to-cyan-500 text-white text-sm font-semibold hover:shadow-lg hover:shadow-blue-500/20 transition-all disabled:opacity-50"
        >
          {loading ? "..." : mode === "search" ? "Search" : "Ask"}
        </button>
      </div>

      {loading && <Spinner label={mode === "search" ? "Searching..." : "Thinking..."} />}

      {/* Search results */}
      {results.length > 0 && (
        <div className="space-y-2">
          <p className="font-mono text-xs text-slate-600 mb-2">
            {results.length} results · sorted by relevance
          </p>
          {results.map((r, i) => (
            <div
              key={i}
              className="bg-[var(--card)] border border-[var(--border)] border-l-2 border-l-blue-500 rounded-r-xl p-4 hover:border-l-cyan-400 transition-all"
            >
              <div className="flex justify-between items-center mb-1">
                <span className="font-mono text-[10px] text-slate-600 uppercase tracking-wider">
                  ◇ {r.section || "general"}
                </span>
                <span className="font-mono text-[11px] text-cyan-500">
                  relevance: {r.relevance}%
                </span>
              </div>
              <div className="font-semibold text-slate-200 text-sm mb-1.5">
                {r.paper_title}
              </div>
              <div className="text-sm text-slate-400 leading-relaxed">
                {r.text}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Ask answer */}
      {answer && (
        <Card hover={false}>
          <div className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">
            {answer}
          </div>
        </Card>
      )}

      {!loading && !results.length && !answer && (
        <EmptyState icon="◆" title="Enter a query to search your library" />
      )}
    </div>
  );
}
