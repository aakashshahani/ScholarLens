"use client";

import { useEffect, useState } from "react";
import { api, Paper, SearchResult as SR } from "@/lib/api";
import { PageHeader, EmptyState, SkeletonCard, FilterChip, Card, Spinner, ProgressRing, AnalysisTag, RelDot, Claim } from "@/components/ui";
import { Search, MessageCircleQuestion, BookOpen, ArrowUpDown } from "lucide-react";

export default function LibraryPage() {
  const [papers, setPapers] = useState<Paper[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SR[]>([]);
  const [answer, setAnswer] = useState("");
  const [searching, setSearching] = useState(false);
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<Paper | null>(null);

  useEffect(() => {
    api.listPapers(50).then((p) => { setPapers(p); setLoading(false); if (p[0]) setSelected(p[0]); }).catch(() => setLoading(false));
  }, []);

  const doSearch = async () => { if (!query.trim()) return; setSearching(true); setSearchResults([]); setAnswer(""); setSearchResults(await api.search(query, 10)); setSearching(false); };
  const doAsk = async () => { if (!query.trim()) return; setSearching(true); setSearchResults([]); setAnswer(""); const r = await api.ask(query); setAnswer(r.answer); setSearching(false); };

  const filtered = papers.filter((p) => filter === "all" || (filter === "analyzed" && (p.analysis_types?.length || 0) >= 6) || p.source === filter);

  return (
    <div>
      <PageHeader title="The corpus" subtitle={`${papers.length} papers · ${papers.reduce((n, p) => n + (p.analysis_types?.length || 0), 0)} claims extracted`} />

      <div className="flex gap-2 mb-3">
        <div className="relative flex-1">
          <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-3)]" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && doSearch()} placeholder="Search across all papers…"
            className="w-full bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-md)] pl-10 pr-4 py-2.5 text-[13.5px] text-[var(--text-1)]" />
        </div>
        <button onClick={doSearch} className="flex items-center gap-1.5 px-4 py-2.5 rounded-[var(--r-md)] bg-[var(--gen)] text-white text-[13px] font-medium t-all hover:opacity-90"><Search size={14} /> Search</button>
        <button onClick={doAsk} className="flex items-center gap-1.5 px-4 py-2.5 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-2)] text-[13px] text-[var(--text-2)] t-all hover:border-[var(--gen-line)] hover:text-[var(--gen)]"><MessageCircleQuestion size={14} /> Ask</button>
      </div>

      {searching && <div className="mb-5"><Spinner label="Searching the corpus…" /></div>}
      {answer && <Card className="mb-6 fade-up"><div className="text-[11px] font-medium text-[var(--gen)] uppercase tracking-wider mb-2">Answer</div><div className="text-[13.5px] text-[var(--text-1)] leading-[1.7] whitespace-pre-wrap">{answer}</div></Card>}
      {searchResults.length > 0 && (
        <div className="mb-6 space-y-2 fade-up">
          <p className="text-[12px] text-[var(--text-3)]">{searchResults.length} results</p>
          {searchResults.map((r, i) => (
            <div key={i} className="bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-md)] flex overflow-hidden">
              <div className="w-[3px] shrink-0 bg-[var(--gen)]" />
              <div className="p-3.5 pl-4 flex-1">
                <div className="flex justify-between items-center mb-1.5"><span className="text-[10px] text-[var(--text-4)] uppercase tracking-wider">{r.section || "general"}</span><span className="mono text-[11px] text-[var(--gen)]">{r.relevance}%</span></div>
                <div className="text-[13px] font-medium text-[var(--text-1)] mb-1">{r.paper_title}</div>
                <Claim className="block clamp-2">{r.text}</Claim>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 mb-4">
        {["all", "analyzed", "arxiv", "upload"].map((f) => <FilterChip key={f} label={f === "all" ? "All" : f === "analyzed" ? "Fully analyzed" : f} active={filter === f} onClick={() => setFilter(f)} />)}
        <span className="ml-auto flex items-center gap-1.5 text-[11px] text-[var(--text-4)]"><ArrowUpDown size={12} /> sorted by most contested</span>
      </div>

      {loading ? <div className="space-y-2.5">{[1,2,3,4].map((i) => <SkeletonCard key={i} />)}</div>
      : filtered.length === 0 ? <EmptyState icon={<BookOpen size={20} />} title="No papers match" hint={papers.length === 0 ? "Upload a paper to get started" : "Try a different filter"} />
      : (
        <div className="grid grid-cols-[1fr_320px] gap-4">
          {/* Table */}
          <div className="bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-lg)] overflow-hidden">
            <div className="grid grid-cols-[1fr_auto_auto] gap-4 px-4 py-2.5 border-b border-[var(--line)] text-[10px] uppercase tracking-wider text-[var(--text-4)] font-medium">
              <span>Paper</span><span>Claims</span><span>Coverage</span>
            </div>
            {filtered.map((p) => {
              const isSel = selected?.id === p.id;
              return (
                <button key={p.id} onClick={() => setSelected(p)}
                  className={`w-full grid grid-cols-[1fr_auto_auto] gap-4 px-4 py-3 items-center border-b border-[var(--line)] last:border-0 text-left t-all ${isSel ? "bg-[var(--surface-3)]" : "hover:bg-[var(--surface-2)]"}`}>
                  <div className="min-w-0">
                    <div className="text-[13.5px] font-medium text-[var(--text-1)] clamp-1">{p.title}</div>
                    <div className="text-[11.5px] text-[var(--text-3)] mt-0.5">{(p.authors || []).slice(0,2).join(", ")} · {p.year || "?"}</div>
                  </div>
                  <span className="mono text-[12px] text-[var(--text-2)] tabular-nums">{p.analysis_types?.length || 0}</span>
                  <ProgressRing done={p.analysis_types?.length || 0} size={26} />
                </button>
              );
            })}
          </div>

          {/* Right rail: selected paper claims */}
          <div className="sticky top-6 self-start">
            {selected ? (
              <Card>
                <div className="text-[14px] font-medium text-[var(--text-1)] leading-snug mb-1 clamp-2">{selected.title}</div>
                <div className="text-[12px] text-[var(--text-3)] mb-4">{(selected.authors || []).slice(0,3).join(", ")} · {selected.year || "?"}</div>
                <div className="text-[11px] font-medium text-[var(--text-3)] uppercase tracking-wider mb-2">Analyses</div>
                <div className="flex flex-wrap gap-1 mb-4">{(selected.analysis_types || []).map((t) => <AnalysisTag key={t} type={t} />)}</div>
                <a href={`/paper/${selected.id}`} className="block text-center py-2 rounded-[var(--r-md)] border border-[var(--line)] text-[12.5px] text-[var(--gen)] font-medium t-all hover:border-[var(--gen-line)]">Open paper →</a>
              </Card>
            ) : <Card><div className="text-[13px] text-[var(--text-3)] text-center py-8">Select a paper</div></Card>}
          </div>
        </div>
      )}
    </div>
  );
}
