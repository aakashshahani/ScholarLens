"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api, type SearchResult, type Paper } from "@/lib/api";
import { cache } from "@/lib/cache";
import { Card } from "@/components/ui";
import { Trash2, ChevronDown, ChevronUp, ArrowUp } from "lucide-react";
import { LogoMark } from "@/components/logo";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Exchange {
  id: string;
  question: string;
  answer: string | null;
  sources: SearchResult[];
  answerLoading: boolean;
  answerError: string | null;
}

const CACHE_KEY = "search_conversation";
const POLL_INTERVAL = 2500;

// Domain-agnostic starters that work for any library. A library-specific
// prompt is appended at runtime from the user's actual papers.
const BASE_SUGGESTIONS = [
  "What are the main contradictions across these papers?",
  "What research gaps do these papers identify?",
  "Which methodologies are most common in this literature?",
  "Summarize the key findings across my library.",
];

function buildSuggestions(papers: Paper[]): string[] {
  if (!papers.length) return BASE_SUGGESTIONS;
  // Swap in one concrete, library-specific prompt referencing a real paper so
  // the chips feel tailored rather than canned.
  const t = papers[0].title;
  const shortTitle = t.length > 48 ? t.slice(0, 48) + "…" : t;
  return [BASE_SUGGESTIONS[0], BASE_SUGGESTIONS[1], `What does "${shortTitle}" conclude?`, BASE_SUGGESTIONS[2]];
}

// ── Relevance tier badge ──────────────────────────────────────────────────────

const TIER_STYLES: Record<string, { label: string; color: string; bg: string }> = {
  highly_relevant: { label: "Highly relevant", color: "var(--support)", bg: "var(--support-dim)" },
  related:         { label: "Related",          color: "var(--nuance)",  bg: "var(--nuance-dim)"  },
  tangential:      { label: "Broader field",    color: "var(--text-3)",  bg: "var(--surface-3)"   },
};

function TierBadge({ tier }: { tier?: string }) {
  const t = TIER_STYLES[tier || "tangential"] || TIER_STYLES.tangential;
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10.5px] font-medium"
      style={{ color: t.color, background: t.bg }}>
      {t.label}
    </span>
  );
}

// ── Query-term highlight ──────────────────────────────────────────────────────

function HighlightedText({ text, query }: { text: string; query: string }) {
  const words = query.trim().split(/\s+/).filter((w) => w.length > 2);
  if (!words.length) return <>{text}</>;
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const parts = text.split(new RegExp(`(${escaped.join("|")})`, "gi"));
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="bg-[var(--gen-dim)] text-[var(--gen)] rounded-[2px] px-0.5 not-italic font-medium">{part}</mark>
        ) : part
      )}
    </>
  );
}

// ── Paper result card ─────────────────────────────────────────────────────────

function PaperResult({ title, passages, query, topMatch = false }: { title: string; passages: SearchResult[]; query: string; topMatch?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? passages : passages.slice(0, 2);
  const best = passages[0];

  return (
    <div className={`border rounded-[var(--r-lg)] overflow-hidden bg-[var(--surface-1)] t-all ${topMatch ? "border-[var(--gen-line)]" : "border-[var(--line)] hover:border-[var(--line-2)]"}`}>
      {/* Paper header */}
      <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            {topMatch && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10.5px] font-medium text-[var(--gen)] bg-[var(--gen-dim)] border border-[var(--gen-line)]">
                Top match
              </span>
            )}
            <TierBadge tier={best.relevance_tier} />
            <span className="text-[10.5px] text-[var(--text-4)] capitalize">
              {best.section || "general"}
            </span>
          </div>
          <div className="text-[14px] font-semibold text-[var(--text-1)] leading-snug">
            {title}
          </div>
        </div>
        <span className="text-[11px] text-[var(--text-4)] shrink-0 mt-1">
          {passages.length} passage{passages.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Passages */}
      <div className="px-4 pb-3 space-y-3">
        {shown.map((s, i) => (
          <div key={i} className={i > 0 ? "pt-3 border-t border-[var(--line)]" : ""}>
            {i > 0 && (
              <div className="flex items-center gap-1.5 mb-1.5">
                <TierBadge tier={s.relevance_tier} />
                <span className="text-[10.5px] text-[var(--text-4)] capitalize">{s.section || "general"}</span>
              </div>
            )}
            <p className="text-[13.5px] text-[var(--text-2)] leading-[1.7]">
              <HighlightedText text={s.text} query={query} />
            </p>
          </div>
        ))}
      </div>

      {/* Expand / collapse */}
      {passages.length > 2 && (
        <button
          onClick={() => setExpanded((e) => !e)}
          className="w-full flex items-center justify-center gap-1.5 py-2.5 border-t border-[var(--line)] text-[12px] text-[var(--gen)] font-medium t-all hover:bg-[var(--surface-2)]"
        >
          {expanded ? <><ChevronUp size={13} /> Show less</> : <><ChevronDown size={13} /> Show {passages.length - 2} more passage{passages.length - 2 !== 1 ? "s" : ""}</>}
        </button>
      )}
    </div>
  );
}

// ── Exchange ──────────────────────────────────────────────────────────────────

function ExchangeCard({ exchange }: { exchange: Exchange }) {
  const [paperFilter, setPaperFilter] = useState<string | null>(null);

  // Group sources by paper
  const byPaper = exchange.sources.reduce<Record<string, SearchResult[]>>((acc, s) => {
    const key = s.paper_id;
    if (!acc[key]) acc[key] = [];
    acc[key].push(s);
    return acc;
  }, {});
  const allGroups = Object.values(byPaper);
  const paperGroups = paperFilter
    ? allGroups.filter((g) => g[0].paper_id === paperFilter)
    : allGroups;
  // Results arrive already ordered by the reranker, so sources[0] is the single
  // best passage. Flag its paper group so we can badge it "Top match".
  const reranked = exchange.sources.some((s) => s.rerank_score != null);
  const topSource = exchange.sources[0];

  return (
    <div className="mb-8">
      {/* Query */}
      <div className="flex justify-end mb-4">
        <div className="max-w-[80%] px-4 py-2.5 rounded-2xl rounded-br-sm bg-[var(--gen)] text-white text-[14px] leading-[1.6]">
          {exchange.question}
        </div>
      </div>

      {/* Results */}
      {exchange.answerLoading ? (
        <div className="flex items-center gap-3 py-2 pl-1">
          <div className="flex gap-1.5">
            {[0, 1, 2].map((i) => (
              <span key={i} className="w-2 h-2 rounded-full bg-[var(--gen)] opacity-60"
                style={{ animation: "pulse 1.4s ease-in-out infinite", animationDelay: `${i * 0.2}s` }} />
            ))}
          </div>
          <span className="text-[13px] text-[var(--text-3)]">Searching your library…</span>
        </div>
      ) : exchange.answerError ? (
        <div className="text-[13px] text-[var(--contra)] py-2">{exchange.answerError}</div>
      ) : allGroups.length === 0 ? (
        <div className="text-[13.5px] text-[var(--text-3)] py-2 pl-1">
          No relevant passages found. Try different keywords or a broader question.
        </div>
      ) : (
        <div>
          {/* Result summary + paper filter chips */}
          <div className="flex flex-wrap items-center gap-2 mb-3 pl-1">
            <span className="text-[12px] text-[var(--text-3)]">
              <span className="font-medium text-[var(--text-1)]">{exchange.sources.length}</span> passage{exchange.sources.length !== 1 ? "s" : ""} across{" "}
              <span className="font-medium text-[var(--text-1)]">{allGroups.length}</span> paper{allGroups.length !== 1 ? "s" : ""}
            </span>
            {allGroups.length > 1 && allGroups.map((g) => {
              const on = paperFilter === g[0].paper_id;
              const title = g[0].paper_title;
              return (
                <button key={g[0].paper_id}
                  onClick={() => setPaperFilter(on ? null : g[0].paper_id)}
                  className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10.5px] border t-all ${on ? "bg-[var(--gen-dim)] text-[var(--gen)] border-[var(--gen-line)]" : "bg-[var(--surface-2)] text-[var(--text-3)] border-[var(--line)] hover:border-[var(--line-2)] hover:text-[var(--text-1)]"}`}>
                  {title.length > 28 ? title.slice(0, 28) + "…" : title}
                </button>
              );
            })}
          </div>
          {/* Paper cards */}
          <div className="space-y-3">
            {paperGroups.map((group) => (
              <PaperResult
                key={group[0].paper_id}
                title={group[0].paper_title}
                passages={group}
                query={exchange.question}
                topMatch={reranked && !paperFilter && group[0] === topSource}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Input bar (shared between hero and bottom) ────────────────────────────────

function InputBar({
  inputRef,
  value,
  onChange,
  onSubmit,
  submitting,
  autoFocus,
  size = "default",
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  submitting: boolean;
  autoFocus?: boolean;
  size?: "hero" | "default";
}) {
  const isHero = size === "hero";

  return (
    <div
      className={`flex items-center gap-2 rounded-2xl border bg-[var(--surface-1)] t-all shadow-sm ${
        isHero
          ? "p-3 border-[var(--line-2)] focus-within:border-[var(--gen-line)] focus-within:shadow-[0_0_0_3px_var(--gen-dim)]"
          : "p-2.5 border-[var(--line)] focus-within:border-[var(--gen-line)]"
      }`}
    >
      <input
        ref={inputRef}
        type="text"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onSubmit()}
        placeholder={isHero ? "Search your research library…" : "Search again…"}
        className={`flex-1 bg-transparent text-[var(--text-1)] placeholder:text-[var(--text-4)] outline-none ${
          isHero ? "text-[15px] px-1 py-0.5" : "text-[13.5px] px-1"
        }`}
      />
      <button
        onClick={onSubmit}
        disabled={submitting || !value.trim()}
        className={`flex items-center justify-center rounded-[10px] bg-[var(--gen)] text-white t-all hover:opacity-90 disabled:opacity-35 disabled:pointer-events-none shrink-0 ${
          isHero ? "w-10 h-10" : "w-8 h-8"
        }`}
      >
        {submitting ? (
          <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
        ) : (
          <ArrowUp size={isHero ? 17 : 14} strokeWidth={2.5} />
        )}
      </button>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SearchPage() {
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [papers, setPapers] = useState<Paper[]>([]);
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const heroInputRef = useRef<HTMLInputElement>(null);
  const autoSubmittedRef = useRef(false);
  const searchParams = useSearchParams();

  useEffect(() => {
    const saved = cache.read<Exchange[]>(CACHE_KEY);
    if (saved?.length) setExchanges(saved.filter((e) => !e.answerLoading));
    // Papers power the library-specific suggestion chip.
    const cachedPapers = cache.read<Paper[]>("papers");
    if (cachedPapers?.length) setPapers(cachedPapers);
    api.listPapers(50).then((p) => { setPapers(p); cache.write("papers", p); }).catch(() => {});
  }, []);

  const suggestions = buildSuggestions(papers);

  useEffect(() => {
    if (exchanges.length > 0) {
      cache.write(CACHE_KEY, exchanges.filter((e) => !e.answerLoading));
    }
  }, [exchanges]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [exchanges]);

  // Auto-submit from URL ?q= param (used by "Find source" links in paper detail)
  useEffect(() => {
    const urlQ = searchParams.get("q");
    if (urlQ && !autoSubmittedRef.current) {
      autoSubmittedRef.current = true;
      submit(urlQ);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  async function submit(override?: string) {
    const q = (override ?? input).trim();
    if (!q || submitting) return;

    const exchangeId = crypto.randomUUID();
    setExchanges((prev) => [...prev, {
      id: exchangeId,
      question: q,
      answer: null,
      sources: [],
      answerLoading: true,
      answerError: null,
    }]);
    setInput("");
    setSubmitting(true);

    try {
      const sources = await api.search(q, 8);
      setExchanges((prev) => prev.map((e) =>
        e.id === exchangeId
          ? { ...e, sources, answerLoading: false, answer: "" }
          : e
      ));
    } catch (e: any) {
      const msg: string = e?.message || "Search failed";
      setExchanges((prev) => prev.map((ex) =>
        ex.id === exchangeId
          ? { ...ex, answerLoading: false, answerError: msg }
          : ex
      ));
    }
    setSubmitting(false);
  }

  function clear() {
    setExchanges([]);
    cache.clear(CACHE_KEY);
    setSubmitting(false);
    setTimeout(() => heroInputRef.current?.focus(), 50);
  }

  const isEmpty = exchanges.length === 0;

  // ── Empty state: hero centered layout ─────────────────────────────────────
  if (isEmpty) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[calc(100vh-120px)] max-w-[680px] mx-auto px-4">
        {/* Logo mark */}
        <div className="mb-8 flex flex-col items-center gap-4">
          <div className="w-14 h-14 rounded-[16px] bg-[var(--gen)] flex items-center justify-center shadow-lg"
            style={{ boxShadow: "0 8px 32px var(--gen-dim), 0 0 0 1px var(--gen-line)" }}>
            <LogoMark size={26} className="text-white" />
          </div>
          <div className="text-center">
            <h1 className="font-display text-[28px] text-[var(--text-1)] tracking-tight leading-tight mb-2">
              Search your library
            </h1>
            <p className="text-[14px] text-[var(--text-3)] max-w-[360px] leading-relaxed">
              Find relevant passages across all your papers.
              Retrieved by meaning, reranked for relevance, and grouped by paper.
            </p>
          </div>
        </div>

        {/* Hero input */}
        <div className="w-full mb-5">
          <InputBar
            inputRef={heroInputRef}
            value={input}
            onChange={setInput}
            onSubmit={submit}
            submitting={submitting}
            autoFocus
            size="hero"
          />
        </div>

        {/* Suggestion chips */}
        <div className="w-full grid grid-cols-2 gap-2">
          {suggestions.map((s) => (
            <button
              key={s}
              onClick={() => {
                setInput(s);
                heroInputRef.current?.focus();
              }}
              className="text-left px-4 py-3 rounded-[14px] border border-[var(--line)] bg-[var(--surface-1)] text-[13px] text-[var(--text-2)] t-all hover:border-[var(--gen-line)] hover:bg-[var(--surface-2)] hover:text-[var(--text-1)] leading-snug group"
            >
              <span className="text-[var(--gen)] text-[11px] font-medium uppercase tracking-wide block mb-0.5 opacity-0 group-hover:opacity-100 t-all">
                Try this
              </span>
              {s}
            </button>
          ))}
        </div>

        <p className="mt-5 text-[11.5px] text-[var(--text-4)] text-center">
          Semantic search + cross-encoder reranking · finds passages by meaning
        </p>
      </div>
    );
  }

  // ── Conversation state ────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-[calc(100vh-64px)] max-w-[760px]">
      {/* Compact header */}
      <div className="flex items-center justify-between pt-4 pb-3 shrink-0 border-b border-[var(--line)] mb-1">
        <div className="flex items-center gap-2.5">
          <div className="w-6 h-6 rounded-[7px] bg-[var(--gen)] flex items-center justify-center">
            <LogoMark size={13} className="text-white" />
          </div>
          <span className="text-[13.5px] font-medium text-[var(--text-1)]">Search</span>
          <span className="text-[11.5px] text-[var(--text-4)]">
            {exchanges.length} exchange{exchanges.length !== 1 ? "s" : ""}
          </span>
        </div>
        <button
          onClick={clear}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--r-md)] text-[12px] text-[var(--text-3)] border border-[var(--line)] t-all hover:text-[var(--contra)] hover:border-[var(--contra-line)]"
        >
          <Trash2 size={12} /> Clear
        </button>
      </div>

      {/* Conversation */}
      <div className="flex-1 overflow-y-auto py-4 px-1">
        {exchanges.map((ex) => <ExchangeCard key={ex.id} exchange={ex} />)}
        <div ref={bottomRef} />
      </div>

      {/* Anchored input */}
      <div className="shrink-0 pb-4 pt-2">
        <InputBar
          inputRef={inputRef}
          value={input}
          onChange={setInput}
          onSubmit={submit}
          submitting={submitting}
          size="default"
        />
        <p className="text-[11px] text-[var(--text-4)] mt-2 px-1">
          Semantic search + reranking · ordered by relevance, not just keywords
        </p>
      </div>
    </div>
  );
}
