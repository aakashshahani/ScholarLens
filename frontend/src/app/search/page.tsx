"use client";

import { useEffect, useRef, useState } from "react";
import { api, type SearchResult } from "@/lib/api";
import { cache } from "@/lib/cache";
import { Card } from "@/components/ui";
import { Sparkles, Trash2, ChevronDown, ChevronUp, ArrowUp } from "lucide-react";

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

const SUGGESTIONS = [
  "What are the main contradictions across these papers?",
  "How do these papers measure negotiation outcomes?",
  "What research gaps do these papers identify?",
  "Which methodologies are most common in this literature?",
];

// ── Source passages ───────────────────────────────────────────────────────────

function SourcePassages({ sources }: { sources: SearchResult[] }) {
  const [open, setOpen] = useState(false);

  const byPaper = sources.reduce<Record<string, SearchResult[]>>((acc, s) => {
    if (!acc[s.paper_id]) acc[s.paper_id] = [];
    acc[s.paper_id].push(s);
    return acc;
  }, {});
  const papers = Object.values(byPaper);

  if (sources.length === 0) return null;

  return (
    <div className="mt-4 pt-3 border-t border-[var(--line)]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-[11.5px] text-[var(--text-3)] hover:text-[var(--gen)] t-all font-medium"
      >
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        {papers.length} source{papers.length !== 1 ? "s" : ""} · {sources.length} passage{sources.length !== 1 ? "s" : ""}
      </button>
      {open && (
        <div className="mt-3 space-y-4">
          {papers.map((group) => (
            <div key={group[0].paper_id}>
              <div className="text-[12px] font-semibold text-[var(--text-1)] mb-2 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--gen)] shrink-0" />
                {group[0].paper_title}
              </div>
              {group.map((s, i) => (
                <div key={i} className="ml-3 pl-3 border-l-2 border-[var(--gen-line)] mb-2.5">
                  <div className="text-[10px] text-[var(--text-4)] uppercase tracking-widest mb-1 font-medium">
                    {s.section || "general"}
                  </div>
                  <div className="text-[12.5px] text-[var(--text-2)] leading-[1.65]">
                    {s.text}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Exchange ──────────────────────────────────────────────────────────────────

function ExchangeCard({ exchange }: { exchange: Exchange }) {
  return (
    <div className="mb-8">
      {/* Question bubble */}
      <div className="flex justify-end mb-4">
        <div className="max-w-[75%] px-4 py-3 rounded-2xl rounded-br-sm bg-[var(--gen)] text-white text-[14px] leading-[1.6] shadow-sm">
          {exchange.question}
        </div>
      </div>

      {/* Answer */}
      <div className="flex gap-3">
        {/* Avatar */}
        <div className="w-8 h-8 rounded-[9px] bg-[var(--gen)] shrink-0 flex items-center justify-center mt-0.5 shadow-sm">
          <span className="w-3 h-3 rounded-full border-[1.5px] border-white opacity-90" />
        </div>

        <div className="flex-1 min-w-0">
          {exchange.answerLoading ? (
            <div className="flex items-center gap-3 py-3">
              <div className="flex gap-1.5">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="w-2 h-2 rounded-full bg-[var(--gen)] opacity-60"
                    style={{
                      animation: "pulse 1.4s ease-in-out infinite",
                      animationDelay: `${i * 0.2}s`,
                    }}
                  />
                ))}
              </div>
              <span className="text-[13px] text-[var(--text-3)]">Searching your library…</span>
            </div>
          ) : exchange.answerError ? (
            <div className="text-[13px] text-[var(--contra)] py-2">{exchange.answerError}</div>
          ) : (
            <div className="bg-[var(--surface-2)] border border-[var(--line)] rounded-2xl rounded-tl-sm p-4 shadow-sm">
              <div className="text-[14px] text-[var(--text-1)] leading-[1.8] whitespace-pre-wrap">
                {exchange.answer}
              </div>
              <SourcePassages sources={exchange.sources} />
            </div>
          )}
        </div>
      </div>
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
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const heroInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const saved = cache.read<Exchange[]>(CACHE_KEY);
    if (saved?.length) setExchanges(saved.filter((e) => !e.answerLoading));
  }, []);

  useEffect(() => {
    if (exchanges.length > 0) {
      cache.write(CACHE_KEY, exchanges.filter((e) => !e.answerLoading));
    }
  }, [exchanges]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [exchanges]);

  function stopPolling() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }

  function buildHistory() {
    return exchanges
      .filter((e) => e.answer && !e.answerError)
      .slice(-10)
      .flatMap((e) => [
        { role: "user", content: e.question },
        { role: "assistant", content: e.answer! },
      ]);
  }

  async function submit() {
    const q = input.trim();
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

    // Ask (LLM synthesis) is disabled on free tier due to memory constraints.
    // Semantic search still works — returns relevant passages instantly.
    try {
      const sources = await api.search(q, 8).catch(() => [] as SearchResult[]);
      const answer = sources.length > 0
        ? `Found ${sources.length} relevant passage${sources.length !== 1 ? "s" : ""} across ${new Set(sources.map(s => s.paper_id)).size} paper${new Set(sources.map(s => s.paper_id)).size !== 1 ? "s" : ""}. See sources below.`
        : "No relevant passages found in your library for this query.";
      setExchanges((prev) => prev.map((e) =>
        e.id === exchangeId
          ? { ...e, answer, sources, answerLoading: false }
          : e
      ));
    } catch (e: any) {
      setExchanges((prev) => prev.map((ex) =>
        ex.id === exchangeId
          ? { ...ex, answerLoading: false, answerError: e.message }
          : ex
      ));
    }
    setSubmitting(false);
  }

  function clear() {
    stopPolling();
    setExchanges([]);
    cache.clear(CACHE_KEY);
    setSubmitting(false);
    setTimeout(() => heroInputRef.current?.focus(), 50);
  }

  useEffect(() => () => stopPolling(), []);

  const isEmpty = exchanges.length === 0;

  // ── Empty state: hero centered layout ─────────────────────────────────────
  if (isEmpty) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[calc(100vh-120px)] max-w-[680px] mx-auto px-4">
        {/* Logo mark */}
        <div className="mb-8 flex flex-col items-center gap-4">
          <div className="w-14 h-14 rounded-[16px] bg-[var(--gen)] flex items-center justify-center shadow-lg"
            style={{ boxShadow: "0 8px 32px var(--gen-dim), 0 0 0 1px var(--gen-line)" }}>
            <Sparkles size={24} className="text-white" />
          </div>
          <div className="text-center">
            <h1 className="font-display text-[28px] text-[var(--text-1)] tracking-tight leading-tight mb-2">
              Search your library
            </h1>
            <p className="text-[14px] text-[var(--text-3)] max-w-[360px] leading-relaxed">
              Get synthesized answers from your research papers.
              Every response cites its sources.
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
          {SUGGESTIONS.map((s) => (
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
          Follow-up questions work · answers stay in sync with your library
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
            <Sparkles size={12} className="text-white" />
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
          Semantic search · results ranked by meaning, not just keywords
        </p>
      </div>
    </div>
  );
}
