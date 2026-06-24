"use client";

import { useEffect, useRef, useState } from "react";
import { api, Paper } from "@/lib/api";
import { cache } from "@/lib/cache";
import { Spinner } from "@/components/ui";
import {
  Send, Sparkles, Trash2, MessageCircle, BookOpen, ChevronDown, User,
} from "lucide-react";

const POLL_MS = 2500;

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: { paper_title: string; section: string | null; text: string }[];
  loading?: boolean;
  error?: string;
}

function SourceCard({ s }: { s: NonNullable<Message["sources"]>[number] }) {
  const [open, setOpen] = useState(false);
  return (
    <button onClick={() => setOpen((o) => !o)} className="text-left w-full">
      <div className="flex items-start gap-2 px-3 py-2.5 rounded-[var(--r-md)] bg-[var(--surface-1)] border border-[var(--line)] hover:border-[var(--line-2)] t-all">
        <BookOpen size={12} className="text-[var(--gen)] mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-[11.5px] text-[var(--text-2)] font-medium leading-snug clamp-1">
            {s.paper_title}
            {s.section && <span className="text-[var(--text-4)] font-normal"> · {s.section}</span>}
          </div>
          {open && (
            <p className="text-[11px] text-[var(--text-3)] leading-[1.6] mt-1.5">{s.text}</p>
          )}
        </div>
        <ChevronDown size={11} className={`text-[var(--text-4)] shrink-0 t-all ${open ? "rotate-180" : ""}`} />
      </div>
    </button>
  );
}

function InlineMd({ text }: { text: string }) {
  const html = text
    .replace(/\*\*(.+?)\*\*/g, '<strong class="text-[var(--text-1)] font-semibold">$1</strong>')
    .replace(/`(.+?)`/g, '<code class="mono text-[11px] bg-[var(--surface-3)] px-1 py-0.5 rounded text-[var(--gen)]">$1</code>');
  return (
    <div className="text-[13px] text-[var(--text-1)] leading-[1.7] space-y-1.5">
      {text.split("\n").map((line, i) => {
        if (!line.trim()) return <div key={i} className="h-2" />;
        if (line.startsWith("- ") || line.startsWith("* ")) {
          return (
            <div key={i} className="flex items-start gap-2">
              <span className="mt-[8px] w-[3px] h-[3px] rounded-full bg-[var(--gen)] shrink-0" />
              <span dangerouslySetInnerHTML={{ __html: line.slice(2).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>') }} />
            </div>
          );
        }
        return <p key={i} dangerouslySetInnerHTML={{ __html: line.replace(/\*\*(.+?)\*\*/g, '<strong class="font-semibold">$1</strong>') }} />;
      })}
    </div>
  );
}

const SUGGESTIONS = [
  "What are the main contradictions across these papers?",
  "How do the papers measure outcomes?",
  "What research gaps are identified?",
  "Which methodology is most common?",
];

export default function AskPage() {
  const [papers, setPapers]   = useState<Paper[]>([]);
  const [scopeId, setScopeId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput]     = useState("");
  const [submitting, setSubmitting] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef  = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const cached = cache.read<Paper[]>("papers");
    if (cached?.length) setPapers(cached);
    api.listPapers(100).then((p) => { setPapers(p); cache.write("papers", p); }).catch(() => {});
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const history = messages
    .filter((m) => !m.loading && !m.error && m.content)
    .map((m) => ({ role: m.role, content: m.content }));

  const pollAnswer = async (jobId: string, msgId: string) => {
    const interval = setInterval(async () => {
      try {
        const job = await api.getJob<{ answer: string }>(jobId);
        if (job.status === "done" && job.result) {
          clearInterval(interval);
          const answer = job.result.answer || "";
          // Parse source blocks from the answer text if the backend embeds them
          setMessages((ms) => ms.map((m) =>
            m.id === msgId ? { ...m, loading: false, content: answer } : m
          ));
          setSubmitting(false);
        } else if (job.status === "error") {
          clearInterval(interval);
          setMessages((ms) => ms.map((m) =>
            m.id === msgId ? { ...m, loading: false, error: job.error || "Unknown error" } : m
          ));
          setSubmitting(false);
        }
      } catch {
        clearInterval(interval);
        setMessages((ms) => ms.map((m) =>
          m.id === msgId ? { ...m, loading: false, error: "Request failed." } : m
        ));
        setSubmitting(false);
      }
    }, POLL_MS);
    setTimeout(() => { clearInterval(interval); setSubmitting(false); }, 90000);
  };

  const submit = async (q?: string) => {
    const question = (q || input).trim();
    if (!question || submitting) return;
    setInput("");
    setSubmitting(true);

    const userMsgId = crypto.randomUUID();
    const asstMsgId = crypto.randomUUID();

    setMessages((ms) => [
      ...ms,
      { id: userMsgId, role: "user", content: question },
      { id: asstMsgId, role: "assistant", content: "", loading: true },
    ]);

    try {
      const res = await api.ask(question, scopeId || undefined, history.slice(-8));
      if (res.status === "done" && (res as any).result?.answer) {
        setMessages((ms) => ms.map((m) =>
          m.id === asstMsgId ? { ...m, loading: false, content: (res as any).result.answer } : m
        ));
        setSubmitting(false);
      } else {
        pollAnswer(res.job_id, asstMsgId);
      }
    } catch (e: any) {
      setMessages((ms) => ms.map((m) =>
        m.id === asstMsgId ? { ...m, loading: false, error: e.message } : m
      ));
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-80px)] max-h-[860px]">
      {/* ── Header ────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="font-display text-[24px] text-[var(--text-1)] flex items-center gap-2">
            Ask <Sparkles size={16} className="text-[var(--gen)]" />
          </h1>
          <p className="text-[12.5px] text-[var(--text-3)] mt-0.5">
            Multi-turn Q&A grounded in your library. Shift+Enter for newline.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Scope selector */}
          <select
            value={scopeId || ""}
            onChange={(e) => setScopeId(e.target.value || null)}
            className="text-[12px] bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-md)] px-3 py-2 text-[var(--text-1)] focus:outline-none focus:border-[var(--gen-line)] t-all"
          >
            <option value="">Whole library</option>
            {papers.map((p) => (
              <option key={p.id} value={p.id}>{p.title.slice(0, 50)}{p.title.length > 50 ? "…" : ""}</option>
            ))}
          </select>
          {messages.length > 0 && (
            <button onClick={() => setMessages([])}
              className="flex items-center gap-1.5 text-[12px] text-[var(--text-3)] border border-[var(--line)] rounded-[var(--r-md)] px-3 py-2 t-all hover:text-[var(--contra)] hover:border-[var(--contra-line)]">
              <Trash2 size={12} /> Clear
            </button>
          )}
        </div>
      </div>

      {/* ── Messages ──────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto space-y-5 pr-1 pb-2">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-5 text-center">
            <div className="w-12 h-12 rounded-2xl bg-[var(--gen-dim)] flex items-center justify-center">
              <MessageCircle size={22} className="text-[var(--gen)]" />
            </div>
            <div>
              <p className="text-[14px] text-[var(--text-1)] font-medium mb-1">Ask anything about your library</p>
              <p className="text-[12.5px] text-[var(--text-3)]">Answers are grounded in your uploaded papers.</p>
            </div>
            <div className="grid grid-cols-2 gap-2 max-w-lg">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => submit(s)}
                  className="text-left px-3.5 py-3 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-2)] text-[12px] text-[var(--text-2)] t-all hover:border-[var(--gen-line)] hover:text-[var(--text-1)]">
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`flex gap-3 ${m.role === "user" ? "flex-row-reverse" : ""}`}>
              {/* Avatar */}
              <div className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${
                m.role === "user"
                  ? "bg-[var(--gen-dim)] text-[var(--gen)]"
                  : "bg-[var(--surface-3)] text-[var(--text-3)]"
              }`}>
                {m.role === "user" ? <User size={13} /> : <Sparkles size={13} />}
              </div>

              <div className={`flex-1 max-w-[85%] ${m.role === "user" ? "items-end" : "items-start"} flex flex-col gap-1.5`}>
                {m.role === "user" ? (
                  <div className="bg-[var(--gen)] text-white px-4 py-2.5 rounded-[var(--r-lg)] rounded-tr-sm text-[13px] leading-[1.6]">
                    {m.content}
                  </div>
                ) : m.loading ? (
                  <div className="bg-[var(--surface-2)] border border-[var(--line)] px-4 py-3 rounded-[var(--r-lg)] rounded-tl-sm">
                    <Spinner label="Searching your library…" />
                  </div>
                ) : m.error ? (
                  <div className="bg-[var(--contra-dim)] border border-[var(--contra-line)] px-4 py-3 rounded-[var(--r-lg)] rounded-tl-sm text-[13px] text-[var(--contra)]">
                    {m.error}
                  </div>
                ) : (
                  <div className="bg-[var(--surface-2)] border border-[var(--line)] px-4 py-3.5 rounded-[var(--r-lg)] rounded-tl-sm">
                    <InlineMd text={m.content} />
                  </div>
                )}
              </div>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* ── Input ─────────────────────────────────────────── */}
      <div className="mt-3 relative">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask a question about your papers…"
          rows={1}
          className="w-full pl-4 pr-14 py-3.5 text-[13px] bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-lg)] text-[var(--text-1)] placeholder-[var(--text-4)] focus:outline-none focus:border-[var(--gen-line)] resize-none t-all"
          style={{ minHeight: "52px", maxHeight: "140px" }}
          onInput={(e) => {
            const el = e.currentTarget;
            el.style.height = "auto";
            el.style.height = Math.min(el.scrollHeight, 140) + "px";
          }}
        />
        <button
          onClick={() => submit()}
          disabled={!input.trim() || submitting}
          className="absolute right-3 top-1/2 -translate-y-1/2 w-8 h-8 rounded-[var(--r-md)] bg-[var(--gen)] text-white flex items-center justify-center t-all hover:opacity-90 disabled:opacity-30"
        >
          <Send size={14} />
        </button>
      </div>
    </div>
  );
}
