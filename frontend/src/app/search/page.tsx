"use client";

import { useState } from "react";
import { api, SearchResult as SR } from "@/lib/api";
import { PageHeader, Card, EmptyState, Spinner } from "@/components/ui";
import { Search, Sparkles } from "lucide-react";

const inputCls =
  "w-full bg-[var(--surface-1)] border border-[var(--line)] rounded-[var(--r-md)] px-3.5 py-2.5 text-[13.5px] text-[var(--text-1)] placeholder:text-[var(--text-4)] outline-none t-all focus:border-[var(--gen-line)]";

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"search" | "ask">("search");
  const [results, setResults] = useState<SR[]>([]);
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setLoading(true); setResults([]); setAnswer(""); setSearched(true);
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
        subtitle="Query your library by meaning, or ask a question across all papers."
      />

      {/* Mode toggle */}
      <div className="flex gap-1 p-1 bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-lg)] w-fit mb-5">
        {([
          { id: "search", label: "Search library", icon: <Search size={13} /> },
          { id: "ask",    label: "Ask a question", icon: <Sparkles size={13} /> },
        ] as const).map((m) => (
          <button
            key={m.id}
            onClick={() => setMode(m.id)}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-[var(--r-md)] text-[12.5px] font-medium t-all ${
              mode === m.id
                ? "bg-[var(--surface-3)] text-[var(--text-1)]"
                : "text-[var(--text-3)] hover:text-[var(--text-2)]"
            }`}
          >
            {m.icon} {m.label}
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
              ? "e.g., methods for measuring negotiation outcomes"
              : "e.g., What are the main limitations across all papers?"
          }
          className={inputCls}
        />
        <button
          onClick={handleSearch}
          disabled={loading}
          className="flex items-center gap-1.5 px-4 py-2.5 rounded-[var(--r-md)] bg-[var(--gen)] text-white text-[13px] font-medium t-all hover:opacity-90 disabled:opacity-40"
        >
          {loading ? "…" : mode === "search" ? <><Search size={14} /> Search</> : <><Sparkles size={14} /> Ask</>}
        </button>
      </div>

      {loading && <Card><Spinner label={mode === "search" ? "Searching…" : "Thinking…"} /></Card>}

      {/* Search results */}
      {results.length > 0 && (
        <div className="space-y-2.5">
          <div className="text-[11.5px] text-[var(--text-3)] mb-3">
            {results.length} results · sorted by relevance
          </div>
          {results.map((r, i) => (
            <Card key={i}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] text-[var(--text-3)] uppercase tracking-wider">
                  {r.section || "general"}
                </span>
                <span className="mono text-[11px] text-[var(--gen)]">
                  {r.relevance_score !== undefined
                    ? `${Math.round((1 - r.relevance_score) * 100)}% match`
                    : ""}
                </span>
              </div>
              <div className="text-[13.5px] font-medium text-[var(--text-1)] mb-1.5">
                {r.paper_title}
              </div>
              <div className="text-[13px] text-[var(--text-2)] leading-[1.65]">
                {r.text}
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Ask answer */}
      {answer && (
        <Card>
          <div className="text-[13.5px] text-[var(--text-1)] leading-[1.75] whitespace-pre-wrap">
            {answer}
          </div>
        </Card>
      )}

      {!loading && !searched && (
        <EmptyState
          icon={<Search size={20} />}
          title="Search your library"
          hint="Use semantic search to find relevant passages, or ask a question across all papers."
        />
      )}

      {!loading && searched && results.length === 0 && !answer && (
        <EmptyState
          icon={<Search size={20} />}
          title="No results"
          hint="Try different keywords or switch to Ask mode."
        />
      )}
    </div>
  );
}
