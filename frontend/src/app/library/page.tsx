"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, Paper } from "@/lib/api";
import { cache } from "@/lib/cache";
import { PageHeader, EmptyState, SkeletonCard, FilterChip, Card, Spinner, ProgressRing, AnalysisTag, Claim } from "@/components/ui";
import { Search, MessageCircleQuestion, BookOpen, ArrowUpDown, FileText, ArrowRight } from "lucide-react";

const ACCENTS = [
  "var(--gen)", "var(--support)", "var(--nuance)", "var(--contra)",
  "#a78bfa", "#f59e0b", "#06b6d4", "#ec4899",
];

// ── Markdown renderer ─────────────────────────────────────────


export default function LibraryPage() {
  const router = useRouter();
  const [papers, setPapers]                 = useState<Paper[]>([]);
  const [loading, setLoading]               = useState(true);

  const [filter, setFilter]                 = useState("all");
  const [selected, setSelected]             = useState<Paper | null>(null);
  const [sortBy, setSortBy]                 = useState<"recent" | "coverage">("recent");
  const [abstractExpanded, setAbstractExpanded] = useState(false);

  useEffect(() => {
    // Cache-first: show papers instantly, refresh in background
    const cachedPapers = cache.read<Paper[]>("papers");
    if (cachedPapers?.length) {
      setPapers(cachedPapers);
      setLoading(false);
      if (cachedPapers[0]) setSelected(cachedPapers[0]);
    }
    api.listPapers(50)
      .then((p) => {
        setPapers(p);
        cache.write("papers", p);
        setLoading(false);
        if (p[0] && !cachedPapers?.length) setSelected(p[0]);
      })
      .catch(() => setLoading(false));

  }, []);

  useEffect(() => { setAbstractExpanded(false); }, [selected?.id]);



  const totalAnalyses = papers.reduce((n, p) => n + (p.analysis_types?.length || 0), 0);
  const totalClaims   = papers.reduce((n, p) => n + (p.chunk_count || 0), 0);

  const filtered = papers
    .filter((p) =>
      filter === "all"
        || (filter === "analyzed" && (p.analysis_types?.length || 0) >= 6)
        || p.source === filter
    )
    .sort((a, b) =>
      sortBy === "coverage"
        ? (b.analysis_types?.length || 0) - (a.analysis_types?.length || 0)
        : new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

  const abstract = selected?.abstract || "";
  const ABSTRACT_TRUNCATE = 600;
  const abstractTruncated = abstract.length > ABSTRACT_TRUNCATE && !abstractExpanded;
  const abstractDisplay = (() => {
    if (!abstractTruncated) return abstract;
    const slice = abstract.slice(0, ABSTRACT_TRUNCATE);
    // Prefer sentence boundary
    const lastPeriod = slice.lastIndexOf(". ");
    if (lastPeriod > 150) return abstract.slice(0, lastPeriod + 1) + "…";
    // Fall back to word boundary — guaranteed to not cut mid-word
    const lastSpace = slice.lastIndexOf(" ");
    return abstract.slice(0, lastSpace > 0 ? lastSpace : ABSTRACT_TRUNCATE) + "…";
  })();

  return (
    <div>
      <PageHeader
        title="The corpus"
        subtitle={`${papers.length} paper${papers.length !== 1 ? "s" : ""} · ${totalAnalyses} analyses${totalClaims > 0 ? ` · ${totalClaims} chunks indexed` : ""}`}
      />



      {/* ── Filters ─────────────────────────────────────── */}
      <div className="flex items-center gap-2 mb-4">
        {["all", "analyzed", "arxiv", "upload"].map((f) => (
          <FilterChip
            key={f}
            label={f === "all" ? "All" : f === "analyzed" ? "Fully analyzed" : f}
            active={filter === f}
            onClick={() => setFilter(f)}
          />
        ))}
        <button
          onClick={() => setSortBy((s) => s === "recent" ? "coverage" : "recent")}
          className="ml-auto flex items-center gap-1.5 text-[11px] text-[var(--text-3)] hover:text-[var(--text-2)] t-all"
        >
          <ArrowUpDown size={12} />
          {sortBy === "recent" ? "sorted by recent" : "sorted by coverage"}
        </button>
      </div>

      {/* ── Main layout ─────────────────────────────────── */}
      {loading ? (
        <div className="space-y-2.5">{[1, 2, 3, 4].map((i) => <SkeletonCard key={i} />)}</div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<BookOpen size={20} />}
          title="No papers match"
          hint={papers.length === 0 ? "Upload a paper to get started" : "Try a different filter"}
        />
      ) : (
        <div className="grid grid-cols-[1fr_300px] gap-5 items-start">

          {/* ── Left: paper cards (original layout preserved exactly) ── */}
          <div className="space-y-2">
            {filtered.map((p, idx) => {
              const isSel   = selected?.id === p.id;
              const accent  = ACCENTS[idx % ACCENTS.length];
              const done    = p.analysis_types?.length || 0;

              return (
                <button
                  key={p.id}
                  onClick={() => setSelected(p)}
                  className={`w-full text-left rounded-[var(--r-lg)] border overflow-hidden t-all ${
                    isSel
                      ? "border-[var(--line-3)] bg-[var(--surface-3)]"
                      : "border-[var(--line)] bg-[var(--surface-2)] hover:border-[var(--line-2)] hover:bg-[var(--surface-2)]"
                  }`}
                  style={isSel ? { boxShadow: `0 0 0 1px ${accent}22` } : {}}
                >
                  <div className="flex overflow-hidden">
                    <div className="w-[3px] shrink-0" style={{ background: accent }} />
                    <div className="flex-1 min-w-0 p-4 pl-[14px]">
                      <div className="flex items-start gap-3 mb-1.5">
                        <div className="flex-1 min-w-0">
                          <div className="text-[13.5px] font-medium text-[var(--text-1)] leading-snug clamp-2">{p.title}</div>
                        </div>
                        <div className="shrink-0 mt-0.5"><ProgressRing done={done} size={26} /></div>
                      </div>
                      <div className="text-[11.5px] text-[var(--text-3)] mb-2.5">
                        {(p.authors || []).slice(0, 2).join(", ")}
                        {(p.authors || []).length > 2 && ` +${p.authors.length - 2}`}
                        {" · "}{p.year || "?"}
                        {" · "}<span className="capitalize">{p.source?.replace(/_/g, " ") || "upload"}</span>
                      </div>
                      {!isSel && p.abstract && (
                        <p className="text-[12px] text-[var(--text-3)] leading-[1.55] clamp-2 mb-2.5">{p.abstract}</p>
                      )}
                      {done > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {orderAnalyses(p.analysis_types).map((t) => <AnalysisTag key={t} type={t} />)}
                        </div>
                      )}
                      {done === 0 && <span className="text-[11px] text-[var(--text-4)]">Analysis pending…</span>}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* ── Right: inspector rail (original preserved exactly) ── */}
          <div className="sticky top-6">
            {selected ? (
              <div className="bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-lg)] overflow-hidden">
                <div className="h-[3px] w-full"
                  style={{ background: ACCENTS[filtered.findIndex((p) => p.id === selected.id) % ACCENTS.length] }} />
                <div className="p-5">
                  <h2 className="text-[14px] font-semibold text-[var(--text-1)] leading-snug mb-1">{selected.title}</h2>
                  <p className="text-[12px] text-[var(--text-3)] mb-4 leading-snug">
                    {(selected.authors || []).join(", ") || "—"}{" · "}{selected.year || "?"}
                  </p>
                  <div className="flex gap-4 mb-4 pb-4 border-b border-[var(--line)]">
                    {[
                      { v: selected.page_count ?? "?", l: "pages" },
                      { v: `${selected.analysis_types?.length || 0}/6`, l: "analyses" },
                      { v: selected.chunk_count ?? "?", l: "chunks" },
                    ].map(({ v, l }) => (
                      <div key={l} className="text-center">
                        <div className="font-display text-[16px] text-[var(--text-1)] tabular-nums leading-none">{v}</div>
                        <div className="text-[10px] text-[var(--text-4)] uppercase tracking-wider mt-0.5">{l}</div>
                      </div>
                    ))}
                  </div>
                  {abstract && (
                    <div className="mb-4">
                      <div className="text-[10.5px] font-medium text-[var(--text-4)] uppercase tracking-wider mb-2">Abstract</div>
                      <p className="text-[12px] text-[var(--text-2)] leading-[1.65]">{abstractDisplay}</p>
                      {abstract.length > ABSTRACT_TRUNCATE && (
                        <button onClick={() => setAbstractExpanded((e) => !e)}
                          className="text-[11px] text-[var(--gen)] mt-1.5 hover:underline t-all">
                          {abstractExpanded ? "Show less" : "Read full abstract"}
                        </button>
                      )}
                    </div>
                  )}
                  <div className="mb-5">
                    <div className="text-[10.5px] font-medium text-[var(--text-4)] uppercase tracking-wider mb-2">Analyses</div>
                    <div className="flex flex-wrap gap-1">
                      {orderAnalyses(selected.analysis_types).map((t) => <AnalysisTag key={t} type={t} />)}
                      {(selected.analysis_types?.length || 0) === 0 && (
                        <span className="text-[12px] text-[var(--text-3)]">None yet — analysis pending</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-[var(--text-4)] mb-5">
                    <span className="capitalize">{selected.source?.replace(/_/g, " ") || "upload"}</span>
                    <span>Added {new Date(selected.created_at).toLocaleDateString()}</span>
                  </div>
                  <a href={`/paper/${selected.id}`}
                    className="flex items-center justify-center gap-2 w-full py-2.5 rounded-[var(--r-md)] border border-[var(--gen-line)] bg-[var(--gen-dim)] text-[var(--gen)] text-[12.5px] font-medium t-all hover:bg-[var(--gen)] hover:text-white">
                    Open paper <ArrowRight size={13} />
                  </a>
                </div>
              </div>
            ) : (
              <div className="bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-lg)] p-8 text-center">
                <FileText size={20} className="text-[var(--text-4)] mx-auto mb-2" />
                <p className="text-[13px] text-[var(--text-3)]">Select a paper to inspect it.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
