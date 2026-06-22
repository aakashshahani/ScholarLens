"use client";

import { useEffect, useRef, useState } from "react";
import { api, type SearchResult } from "@/lib/api";
import { cache } from "@/lib/cache";
import { Card, EmptyState, Spinner } from "@/components/ui";
import { Search, Sparkles, Trash2, ChevronDown, ChevronUp } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Exchange {
  id: string;
  question: string;
  answer: string | null;       // null while loading
  sources: SearchResult[];
  answerLoading: boolean;
  answerError: string | null;
}

const CACHE_KEY = "search_conversation";
const POLL_INTERVAL = 2500;

// ── Source passages (collapsed by default) ────────────────────────────────────

function SourcePassages({ sources }: { sources: SearchResult[] }) {
  const [open, setOpen] = useState(false);

  // Group by paper
  const byPaper = sources.reduce<Record<string, SearchResult[]>>((acc, s) => {
    if (!acc[s.paper_id]) acc[s.paper_id] = [];
    acc[s.paper_id].push(s);
    return acc;
  }, {});
  const papers = Object.values(byPaper);

  if (sources.length === 0) return null;

  return (
    <div className="mt-3 pt-3 border-t border-[var(--line)]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-[11px] text-[var(--text-3)] hover:text-[var(--text-2)] t-all"
      >
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        {papers.length} source paper{papers.length !== 1 ? "s" : ""} · {sources.length} passage{sources.length !== 1 ? "s" : ""}
      </button>
      {open && (
        <div className="mt-2.5 space-y-3">
          {papers.map((group) => (
            <div key={group[0].paper_id}>
              <div className="text-[12px] font-medium text-[var(--text-1)] mb-1.5">
                {group[0].paper_title}
              </div>
              {group.map((s, i) => (
                <div key={i} className="ml-2 pl-2.5 border-l border-[var(--line-2)] mb-2">
                  <div className="text-[10.5px] text-[var(--text-4)] uppercase tracking-wide mb-0.5">
                    {s.section || "general"}
                  </div>
                  <div className="text-[12.5px] text-[var(--text-2)] leading-relaxed">
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

// ── Single exchange (question + answer + sources) ─────────────────────────────

function ExchangeCard({ exchange }: { exchange: Exchange }) {
  return (
    <div className="mb-6">
      {/* Question */}
      <div className="flex justify-end mb-3">
        <div className="max-w-[80%] px-4 py-2.5 rounded-[var(--r-lg)] bg-[var(--gen)] text-white text-[13.5px] leading-[1.6]">
          {exchange.question}
        </div>
      </div>

      {/* Answer + sources */}
      <div className="flex gap-3">
        <div className="w-7 h-7 rounded-[7px] bg-[var(--gen-dim)] border border-[var(--gen-line)] shrink-0 flex items-center justify-center mt-0.5">
          <Sparkles size={13} className="text-[var(--gen)]" />
        </div>
        <div className="flex-1 min-w-0">
          <Card className="!p-4">
            {exchange.answerLoading ? (
              <div className="flex items-center gap-2">
                <div className="flex gap-1">
                  {[0, 1, 2].map((i) => (
                    <span key={i} className="w-1.5 h-1.5 rounded-full bg-[var(--gen)] animate-pulse"
                      style={{ animationDelay: `${i * 150}ms` }} />
                  ))}
                </div>
                <span className="text-[12.5px] text-[var(--text-3)]">Searching your library…</span>
              </div>
            ) : exchange.answerError ? (
              <div className="text-[13px] text-[var(--contra)]">{exchange.answerError}</div>
            ) : (
              <>
                <div className="text-[13.5px] text-[var(--text-1)] leading-[1.75] whitespace-pre-wrap">
                  {exchange.answer}
                </div>
                <SourcePassages sources={exchange.sources} />
              </>
            )}
          </Card>
        </div>
      </div>
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
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load history from cache on mount
  useEffect(() => {
    const saved = cache.read<Exchange[]>(CACHE_KEY);
    if (saved?.length) {
      setExchanges(saved.filter((e) => !e.answerLoading));
    }
  }, []);

  // Persist history on change (skip loading states)
  useEffect(() => {
    if (exchanges.length > 0) {
      cache.write(CACHE_KEY, exchanges.filter((e) => !e.answerLoading));
    }
  }, [exchanges]);

  // Scroll to bottom on new exchanges
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
    const newExchange: Exchange = {
      id: exchangeId,
      question: q,
      answer: null,
      sources: [],
      answerLoading: true,
      answerError: null,
    };

    setExchanges((prev) => [...prev, newExchange]);
    setInput("");
    setSubmitting(true);

    // Run semantic search immediately (fast, no LLM)
    const sourcesPromise = api.search(q, 6).catch(() => [] as SearchResult[]);

    try {
      const history = buildHistory();
      const { job_id } = await api.ask(q, undefined, history);

      // Poll for answer
      stopPolling();
      pollRef.current = setInterval(async () => {
        try {
          const job = await api.getJob<{ answer: string }>(job_id);
          if (job.status === "done" && job.result) {
            stopPolling();
            const sources = await sourcesPromise;
            setExchanges((prev) =>
              prev.map((e) =>
                e.id === exchangeId
                  ? { ...e, answer: job.result!.answer, sources, answerLoading: false }
                  : e
              )
            );
            setSubmitting(false);
          } else if (job.status === "error") {
            stopPolling();
            const sources = await sourcesPromise;
            setExchanges((prev) =>
              prev.map((e) =>
                e.id === exchangeId
                  ? { ...e, sources, answerLoading: false, answerError: job.error || "Something went wrong." }
                  : e
              )
            );
            setSubmitting(false);
          }
        } catch (e: any) {
          stopPolling();
          setExchanges((prev) =>
            prev.map((ex) =>
              ex.id === exchangeId
                ? { ...ex, answerLoading: false, answerError: e.message }
                : ex
            )
          );
          setSubmitting(false);
        }
      }, POLL_INTERVAL);
    } catch (e: any) {
      const sources = await sourcesPromise;
      setExchanges((prev) =>
        prev.map((ex) =>
          ex.id === exchangeId
            ? { ...ex, sources, answerLoading: false, answerError: e.message }
            : ex
        )
      );
      setSubmitting(false);
    }
  }

  function clear() {
    stopPolling();
    setExchanges([]);
    cache.clear(CACHE_KEY);
    setSubmitting(false);
    inputRef.current?.focus();
  }

  useEffect(() => () => stopPolling(), []);

  const isEmpty = exchanges.length === 0;

  const SUGGESTIONS = [
    "What are the main contradictions across these papers?",
    "How do these papers measure negotiation outcomes?",
    "What methodologies are most common in this literature?",
    "What research gaps do these papers identify?",
  ];

  return (
    <div className="flex flex-col h-[calc(100vh-64px)] max-w-[800px]">
      {/* Header */}
      <div className="flex items-center justify-between py-5 shrink-0">
        <div>
          <h1 className="font-display text-[22px] text-[var(--text-1)]">Search</h1>
          <p className="text-[13px] text-[var(--text-3)] mt-0.5">
            Ask questions or search for passages across your library.
            Answers are grounded in your papers — sources shown below each response.
          </p>
        </div>
        {!isEmpty && (
          <button onClick={clear}
            className="flex items-center gap-1.5 px-3 py-2 rounded-[var(--r-md)] border border-[var(--line)] text-[12.5px] text-[var(--text-3)] t-all hover:text-[var(--contra)] hover:border-[var(--contra-line)]">
            <Trash2 size={13} /> Clear
          </button>
        )}
      </div>

      {/* Exchange list */}
      <div className="flex-1 overflow-y-auto py-2">
        {isEmpty ? (
          <div className="flex flex-col items-center justify-center h-full gap-5 pb-20">
            <div className="w-12 h-12 rounded-[12px] bg-[var(--surface-2)] border border-[var(--line)] flex items-center justify-center">
              <Search size={20} className="text-[var(--text-3)]" />
            </div>
            <div className="text-center">
              <div className="text-[15px] font-medium text-[var(--text-1)] mb-1.5">
                Search your research library
              </div>
              <div className="text-[13px] text-[var(--text-3)] max-w-[400px] leading-relaxed">
                Ask questions and get synthesized answers, or search for specific passages.
                Source papers are shown below every answer.
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 w-full max-w-[520px]">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => { setInput(s); inputRef.current?.focus(); }}
                  className="text-left px-3.5 py-2.5 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-1)] text-[12.5px] text-[var(--text-2)] t-all hover:border-[var(--gen-line)] hover:text-[var(--text-1)] leading-snug">
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="py-2">
            {exchanges.map((ex) => <ExchangeCard key={ex.id} exchange={ex} />)}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Input */}
      <div className="shrink-0 pb-4 pt-2">
        <div className="flex gap-2 items-center p-2 rounded-[var(--r-lg)] border border-[var(--line)] bg-[var(--surface-1)] focus-within:border-[var(--gen-line)] t-all">
          <Search size={15} className="text-[var(--text-4)] shrink-0 ml-1.5" />
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Ask a question or search for a topic…"
            className="flex-1 bg-transparent text-[13.5px] text-[var(--text-1)] placeholder:text-[var(--text-4)] outline-none py-1.5"
          />
          <button onClick={submit} disabled={submitting || !input.trim()}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-[var(--r-md)] bg-[var(--gen)] text-white text-[12.5px] font-medium t-all hover:opacity-90 disabled:opacity-40 disabled:pointer-events-none shrink-0">
            <Sparkles size={13} />
            {submitting ? "Thinking…" : "Ask"}
          </button>
        </div>
        <div className="text-[11px] text-[var(--text-4)] mt-1.5 px-1">
          Press Enter to submit · answers are grounded in your library · follow-up questions work
        </div>
      </div>
    </div>
  );
}
