"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, Paper } from "@/lib/api";
import { cache } from "@/lib/cache";
import {
  PageHeader, EmptyState, SkeletonCard, FilterChip, AnalysisTag, ProgressRing,
} from "@/components/ui";
import {
  Search, BookOpen, ArrowUpDown, FileText, ArrowRight, Tag,
  Trash2, CheckSquare, Square, Download, X, Plus, Loader2,
} from "lucide-react";

const ACCENTS = [
  "var(--gen)", "var(--support)", "var(--nuance)", "var(--contra)",
  "#a78bfa", "#f59e0b", "#06b6d4", "#ec4899",
];

const ANALYSIS_ORDER = ["summary", "findings", "methods", "key_claims", "limitations", "research_gaps"];
const orderAnalyses = (types: string[]) =>
  [...types].sort((a, b) => {
    const ai = ANALYSIS_ORDER.indexOf(a);
    const bi = ANALYSIS_ORDER.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

type SortKey = "recent" | "coverage" | "title" | "year";

export default function LibraryPage() {
  const router = useRouter();
  const [papers, setPapers]             = useState<Paper[]>([]);
  const [loading, setLoading]           = useState(true);
  const [filter, setFilter]             = useState("all");
  const [activeTag, setActiveTag]       = useState<string | null>(null);
  const [allTags, setAllTags]           = useState<string[]>([]);
  const [selected, setSelected]         = useState<Paper | null>(null);
  const [sortBy, setSortBy]             = useState<SortKey>("recent");
  const [search, setSearch]             = useState("");
  const [abstractExpanded, setAbstractExpanded] = useState(false);
  const [bulkMode, setBulkMode]         = useState(false);
  const [checkedIds, setCheckedIds]     = useState<Set<string>>(new Set());
  const [deleting, setDeleting]         = useState(false);
  // Tag editing
  const [tagInput, setTagInput]         = useState("");
  const [savingTag, setSavingTag]       = useState(false);
  const tagInputRef = useRef<HTMLInputElement>(null);

  const loadPapers = () => {
    const cachedPapers = cache.read<Paper[]>("papers");
    if (cachedPapers?.length) { setPapers(cachedPapers); setLoading(false); if (cachedPapers[0] && !selected) setSelected(cachedPapers[0]); }
    api.listPapers(100).then((p) => {
      setPapers(p); cache.write("papers", p); setLoading(false);
      if (p[0] && !selected) setSelected(p[0]);
    }).catch(() => setLoading(false));
    api.listTags().then((r) => setAllTags(r.tags)).catch(() => {});
  };

  useEffect(() => { loadPapers(); }, []);
  useEffect(() => { setAbstractExpanded(false); }, [selected?.id]);

  const totalAnalyses = papers.reduce((n, p) => n + (p.analysis_types?.length || 0), 0);

  const filtered = useMemo(() => papers
    .filter((p) => {
      if (filter === "analyzed" && (p.analysis_types?.length || 0) < 6) return false;
      if (filter === "arxiv" && p.source !== "arxiv") return false;
      if (filter === "upload" && p.source !== "upload") return false;
      if (activeTag && !(p.tags || []).includes(activeTag)) return false;
      if (search) {
        const q = search.toLowerCase();
        return (
          p.title.toLowerCase().includes(q) ||
          (p.authors || []).some((a) => a.toLowerCase().includes(q)) ||
          (p.abstract || "").toLowerCase().includes(q)
        );
      }
      return true;
    })
    .sort((a, b) => {
      if (sortBy === "coverage") return (b.analysis_types?.length || 0) - (a.analysis_types?.length || 0);
      if (sortBy === "title") return a.title.localeCompare(b.title);
      if (sortBy === "year") return (b.year || 0) - (a.year || 0);
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    }),
    [papers, filter, activeTag, sortBy, search]);

  const abstract = selected?.abstract || "";
  const ABSTRACT_TRUNCATE = 600;
  const abstractTruncated = abstract.length > ABSTRACT_TRUNCATE && !abstractExpanded;
  const abstractDisplay = (() => {
    if (!abstractTruncated) return abstract;
    const slice = abstract.slice(0, ABSTRACT_TRUNCATE);
    const lastPeriod = slice.lastIndexOf(". ");
    if (lastPeriod > 150) return abstract.slice(0, lastPeriod + 1) + "…";
    const lastSpace = slice.lastIndexOf(" ");
    return abstract.slice(0, lastSpace > 0 ? lastSpace : ABSTRACT_TRUNCATE) + "…";
  })();

  const toggleCheck = (id: string) => {
    setCheckedIds((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };
  const checkAll = () => setCheckedIds(new Set(filtered.map((p) => p.id)));
  const uncheckAll = () => setCheckedIds(new Set());

  const deleteSelected = async () => {
    if (!checkedIds.size) return;
    if (!confirm(`Delete ${checkedIds.size} paper${checkedIds.size !== 1 ? "s" : ""}? This cannot be undone.`)) return;
    setDeleting(true);
    for (const id of checkedIds) {
      try { await api.deletePaper(id); } catch {}
    }
    const remaining = papers.filter((p) => !checkedIds.has(p.id));
    setPapers(remaining); cache.write("papers", remaining);
    if (selected && checkedIds.has(selected.id)) setSelected(remaining[0] || null);
    setCheckedIds(new Set()); setBulkMode(false); setDeleting(false);
  };

  const addTag = async (paperId: string, tag: string) => {
    if (!tag.trim()) return;
    setSavingTag(true);
    try {
      await api.addTag(paperId, tag.trim());
      const updated = papers.map((p) =>
        p.id === paperId ? { ...p, tags: [...new Set([...(p.tags || []), tag.trim().toLowerCase()])] } : p
      );
      setPapers(updated); cache.write("papers", updated);
      if (selected?.id === paperId) setSelected(updated.find((p) => p.id === paperId) || selected);
      if (!allTags.includes(tag.trim().toLowerCase())) setAllTags((t) => [...t, tag.trim().toLowerCase()].sort());
      setTagInput("");
    } catch {} finally { setSavingTag(false); }
  };

  const removeTag = async (paperId: string, tag: string) => {
    try {
      await api.removeTag(paperId, tag);
      const updated = papers.map((p) =>
        p.id === paperId ? { ...p, tags: (p.tags || []).filter((t) => t !== tag) } : p
      );
      setPapers(updated); cache.write("papers", updated);
      if (selected?.id === paperId) setSelected(updated.find((p) => p.id === paperId) || selected);
    } catch {}
  };

  const exportCitation = (paperId: string, fmt: "bibtex" | "ris") => {
    const url = api.exportCitation(paperId, fmt);
    const a = document.createElement("a"); a.href = url; a.download = ""; a.click();
  };

  const SORT_LABELS: Record<SortKey, string> = {
    recent: "Recent", coverage: "Coverage", title: "A–Z", year: "Year",
  };
  const SORT_KEYS: SortKey[] = ["recent", "coverage", "title", "year"];

  return (
    <div>
      <PageHeader
        title="The corpus"
        subtitle={`${papers.length} paper${papers.length !== 1 ? "s" : ""} · ${totalAnalyses} analyses`}
      />

      {/* ── Search bar ──────────────────────────────────────── */}
      <div className="relative mb-4">
        <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-4)]" />
        <input
          value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search titles, authors, abstracts…"
          className="w-full pl-9 pr-4 py-2.5 text-[13px] bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-md)] text-[var(--text-1)] placeholder-[var(--text-4)] focus:outline-none focus:border-[var(--gen-line)] t-all"
        />
        {search && (
          <button onClick={() => setSearch("")} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[var(--text-4)] hover:text-[var(--text-2)]">
            <X size={13} />
          </button>
        )}
      </div>

      {/* ── Filters + sort ──────────────────────────────────── */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        {["all", "analyzed", "arxiv", "upload"].map((f) => (
          <FilterChip key={f} label={f === "all" ? "All" : f === "analyzed" ? "Fully analyzed" : f}
            active={filter === f && !activeTag} onClick={() => { setFilter(f); setActiveTag(null); }} />
        ))}

        {allTags.map((t) => (
          <button key={t} onClick={() => setActiveTag(activeTag === t ? null : t)}
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] border t-all ${
              activeTag === t
                ? "bg-[var(--gen)] text-white border-transparent"
                : "bg-[var(--surface-2)] text-[var(--text-2)] border-[var(--line)] hover:border-[var(--line-2)]"
            }`}>
            <Tag size={9} />{t}
          </button>
        ))}

        <div className="ml-auto flex items-center gap-2">
          {/* Sort */}
          <div className="flex items-center gap-1 text-[11px] text-[var(--text-3)]">
            <ArrowUpDown size={11} />
            {SORT_KEYS.map((k) => (
              <button key={k} onClick={() => setSortBy(k)}
                className={`px-2 py-0.5 rounded t-all ${sortBy === k ? "text-[var(--text-1)] font-medium" : "hover:text-[var(--text-2)]"}`}>
                {SORT_LABELS[k]}
              </button>
            ))}
          </div>
          {/* Bulk mode */}
          <button onClick={() => { setBulkMode((b) => !b); setCheckedIds(new Set()); }}
            className={`text-[11px] px-2.5 py-1 rounded border t-all ${
              bulkMode ? "bg-[var(--contra-dim)] text-[var(--contra)] border-[var(--contra-line)]"
                : "text-[var(--text-3)] border-[var(--line)] hover:border-[var(--line-2)]"}`}>
            {bulkMode ? "Exit select" : "Select"}
          </button>
        </div>
      </div>

      {/* ── Bulk action bar ─────────────────────────────────── */}
      {bulkMode && (
        <div className="flex items-center gap-3 mb-3 px-4 py-2.5 bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-md)]">
          <button onClick={checkedIds.size === filtered.length ? uncheckAll : checkAll}
            className="flex items-center gap-1.5 text-[12px] text-[var(--text-2)] hover:text-[var(--text-1)]">
            {checkedIds.size === filtered.length
              ? <CheckSquare size={14} className="text-[var(--gen)]" />
              : <Square size={14} />}
            {checkedIds.size === 0 ? "Select all" : `${checkedIds.size} selected`}
          </button>
          {checkedIds.size > 0 && (
            <button onClick={deleteSelected} disabled={deleting}
              className="flex items-center gap-1.5 ml-2 text-[12px] text-[var(--contra)] hover:opacity-80 t-all disabled:opacity-50">
              {deleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
              Delete {checkedIds.size}
            </button>
          )}
        </div>
      )}

      {/* ── Main layout ─────────────────────────────────────── */}
      {loading ? (
        <div className="space-y-2.5">{[1, 2, 3, 4].map((i) => <SkeletonCard key={i} />)}</div>
      ) : filtered.length === 0 ? (
        <EmptyState icon={<BookOpen size={20} />} title="No papers match"
          hint={papers.length === 0 ? "Upload a paper to get started" : "Try a different filter"} />
      ) : (
        <div className="grid grid-cols-[1fr_320px] gap-5 items-start">

          {/* ── Left: paper cards ──────────────────────────── */}
          <div className="space-y-2">
            {filtered.map((p, idx) => {
              const isSel  = selected?.id === p.id;
              const accent = ACCENTS[idx % ACCENTS.length];
              const done   = p.analysis_types?.length || 0;
              const isChecked = checkedIds.has(p.id);

              return (
                <div key={p.id} className="relative">
                  {bulkMode && (
                    <button onClick={() => toggleCheck(p.id)}
                      className="absolute left-3 top-1/2 -translate-y-1/2 z-10">
                      {isChecked
                        ? <CheckSquare size={15} className="text-[var(--gen)]" />
                        : <Square size={15} className="text-[var(--text-4)]" />}
                    </button>
                  )}
                  <button
                    onClick={() => { if (!bulkMode) setSelected(p); else toggleCheck(p.id); }}
                    className={`w-full text-left rounded-[var(--r-lg)] border overflow-hidden t-all ${
                      isSel && !bulkMode
                        ? "border-[var(--line-3)] bg-[var(--surface-3)]"
                        : isChecked
                        ? "border-[var(--gen-line)] bg-[var(--gen-dim)]"
                        : "border-[var(--line)] bg-[var(--surface-2)] hover:border-[var(--line-2)]"
                    }`}
                    style={isSel && !bulkMode ? { boxShadow: `0 0 0 1px ${accent}22` } : {}}
                  >
                    <div className="flex overflow-hidden">
                      <div className="w-[3px] shrink-0" style={{ background: accent }} />
                      <div className={`flex-1 min-w-0 p-4 ${bulkMode ? "pl-9" : "pl-[14px]"}`}>
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
                        <div className="flex items-center gap-2 flex-wrap">
                          {done > 0
                            ? orderAnalyses(p.analysis_types || []).map((t) => <AnalysisTag key={t} type={t} />)
                            : <span className="text-[11px] text-[var(--text-4)]">Analysis pending…</span>}
                          {(p.tags || []).map((t) => (
                            <span key={t} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] bg-[var(--gen-dim)] text-[var(--gen)] border border-[var(--gen-line)]">
                              <Tag size={8} />{t}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </button>
                </div>
              );
            })}
          </div>

          {/* ── Right: inspector rail ──────────────────────── */}
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

                  {/* Stats */}
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

                  {/* Tags */}
                  <div className="mb-4">
                    <div className="text-[10.5px] font-medium text-[var(--text-4)] uppercase tracking-wider mb-2">Tags</div>
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {(selected.tags || []).map((t) => (
                        <span key={t} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-[var(--gen-dim)] text-[var(--gen)] border border-[var(--gen-line)]">
                          <Tag size={9} />{t}
                          <button onClick={() => removeTag(selected.id, t)} className="hover:text-[var(--contra)] t-all ml-0.5">
                            <X size={9} />
                          </button>
                        </span>
                      ))}
                    </div>
                    <form onSubmit={(e) => { e.preventDefault(); addTag(selected.id, tagInput); }}
                      className="flex gap-1.5">
                      <input ref={tagInputRef} value={tagInput} onChange={(e) => setTagInput(e.target.value)}
                        placeholder="Add tag…"
                        className="flex-1 px-2.5 py-1.5 text-[11.5px] bg-[var(--surface-1)] border border-[var(--line)] rounded-[var(--r-sm)] text-[var(--text-1)] placeholder-[var(--text-4)] focus:outline-none focus:border-[var(--gen-line)] t-all" />
                      <button type="submit" disabled={!tagInput.trim() || savingTag}
                        className="px-2.5 py-1.5 rounded-[var(--r-sm)] bg-[var(--gen)] text-white text-[11.5px] hover:opacity-90 t-all disabled:opacity-40">
                        {savingTag ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
                      </button>
                    </form>
                  </div>

                  {/* Abstract */}
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

                  {/* Analyses */}
                  <div className="mb-4">
                    <div className="text-[10.5px] font-medium text-[var(--text-4)] uppercase tracking-wider mb-2">Analyses</div>
                    <div className="flex flex-wrap gap-1">
                      {orderAnalyses(selected.analysis_types || []).map((t) => <AnalysisTag key={t} type={t} />)}
                      {(selected.analysis_types?.length || 0) === 0 && (
                        <span className="text-[12px] text-[var(--text-3)]">None yet</span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center justify-between text-[11px] text-[var(--text-4)] mb-4 pb-4 border-b border-[var(--line)]">
                    <span className="capitalize">{selected.source?.replace(/_/g, " ") || "upload"}</span>
                    <span>Added {new Date(selected.created_at).toLocaleDateString()}</span>
                  </div>

                  {/* Citation export */}
                  <div className="flex gap-2 mb-3">
                    {(["bibtex", "ris"] as const).map((fmt) => (
                      <button key={fmt} onClick={() => exportCitation(selected.id, fmt)}
                        className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-[var(--r-sm)] border border-[var(--line)] text-[11.5px] text-[var(--text-2)] t-all hover:border-[var(--line-2)] hover:text-[var(--text-1)]">
                        <Download size={11} /> {fmt.toUpperCase()}
                      </button>
                    ))}
                  </div>

                  <Link href={`/paper/${selected.id}`}
                    className="flex items-center justify-center gap-2 w-full py-2.5 rounded-[var(--r-md)] border border-[var(--gen-line)] bg-[var(--gen-dim)] text-[var(--gen)] text-[12.5px] font-medium t-all hover:bg-[var(--gen)] hover:text-white">
                    Open paper <ArrowRight size={13} />
                  </Link>
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
