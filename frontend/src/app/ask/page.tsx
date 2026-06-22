"use client";

import { useEffect, useRef, useState } from "react";
import { api, type SearchResult } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cache } from "@/lib/cache";
import { Sparkles, Send, Trash2, ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
import { Spinner } from "@/components/ui";

// ── Types ────────────────────────────────────────────────────────────────────

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: SearchResult[];   // passages retrieved for this answer
  loading?: boolean;
  error?: string;
}

const CACHE_KEY = "ask_conversation";
const POLL_INTERVAL = 2500; // ms

// ── Markdown-like renderer (same as library page) ─────────────────────────────
function AnswerText({ text }: { text: string }) {
  return (
    <div className="text-[13.5px] text-[var(--text-1)] leading-[1.75] whitespace-pre-wrap">
      {text}
    </div>
  );
}

// ── Source citation pills ─────────────────────────────────────────────────────
function Sources({ sources }: { sources: SearchResult[] }) {
  const [open, setOpen] = useState(false);
  const unique = Array.from(new Map(sources.map((s) => [s.paper_id, s])).values());

  return (
    <div className="mt-3 pt-3 border-t border-[var(--line)]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-[11px] text-[var(--text-3)] hover:text-[var(--text-2)] t-all"
      >
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        {unique.length} source{unique.length !== 1 ? "s" : ""}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {sources.map((s, i) => (
            <div key={i} className="p-2.5 rounded-[var(--r-md)] bg-[var(--surface-2)] border border-[var(--line)]">
              <div className="flex items-start justify-between gap-2 mb-1">
                <span className="text-[12px] font-medium text-[var(--text-1)]">{s.paper_title}</span>
                <span className="text-[10px] text-[var(--text-4)] shrink-0 capitalize">{s.section || "general"}</span>
              </div>
              <div className="text-[12px] text-[var(--text-2)] leading-relaxed line-clamp-3">{s.text}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Message bubble ───────────────────────────────────────────────────────────
function MessageBubble({ msg }: { msg: Message }) {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end mb-4">
        <div className="max-w-[75%] px-4 py-2.5 rounded-[var(--r-lg)] bg-[var(--gen)] text-white text-[13.5px] leading-[1.6]">
          {msg.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3 mb-5">
      <div className="w-7 h-7 rounded-[7px] bg-[var(--gen)] shrink-0 flex items-center justify-center mt-0.5">
        <span className="w-2.5 h-2.5 rounded-full border-[1.5px] border-white" />
      </div>
      <div className="flex-1 min-w-0">
        {msg.loading ? (
          <div className="pt-1"><Spinner label="Searching your library…" /></div>
        ) : msg.error ? (
          <div className="text-[13px] text-[var(--contra)]">{msg.error}</div>
        ) : (
          <>
            <AnswerText text={msg.content} />
            {msg.sources && msg.sources.length > 0 && (
              <Sources sources={msg.sources} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────
export default function AskPage() {
  const { user } = useAuth();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load conversation history from localStorage on mount
  useEffect(() => {
    const saved = cache.read<Message[]>(CACHE_KEY);
    if (saved && saved.length > 0) {
      // Filter out any loading messages from interrupted sessions
      setMessages(saved.filter((m) => !m.loading));
    }
  }, []);

  // Scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Save conversation to localStorage whenever messages change
  useEffect(() => {
    if (messages.length > 0) {
      cache.write(CACHE_KEY, messages.filter((m) => !m.loading));
    }
  }, [messages]);

  // Build conversation history for multi-turn context
  // Pass the last 10 exchanges to stay within token limits
  function buildHistory(): { role: string; content: string }[] {
    return messages
      .filter((m) => !m.loading && !m.error && m.content)
      .slice(-20) // last 20 messages = 10 exchanges
      .map((m) => ({ role: m.role, content: m.content }));
  }

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function pollJob(
    jobId: string,
    assistantMsgId: string,
  ) {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const job = await api.getJob<{ answer: string }>(jobId);

        if (job.status === "done" && job.result) {
          stopPolling();
          const answer = job.result.answer;

          // Fetch source passages for citation display
          let sources: SearchResult[] = [];
          try {
            // Get the user question from the loading message placeholder
            const userMsg = messages.findLast?.((m) => m.role === "user");
            if (userMsg) {
              sources = await api.search(userMsg.content, 5);
            }
          } catch { /* sources are optional */ }

          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId
                ? { ...m, content: answer, loading: false, sources }
                : m
            )
          );
          setSending(false);
        } else if (job.status === "error") {
          stopPolling();
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId
                ? { ...m, content: "", loading: false, error: job.error || "Something went wrong." }
                : m
            )
          );
          setSending(false);
        }
      } catch (e: any) {
        stopPolling();
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId
              ? { ...m, content: "", loading: false, error: e.message }
              : m
          )
        );
        setSending(false);
      }
    }, POLL_INTERVAL);
  }

  async function send() {
    const q = input.trim();
    if (!q || sending) return;

    const userMsgId = crypto.randomUUID();
    const assistantMsgId = crypto.randomUUID();

    const userMsg: Message = { id: userMsgId, role: "user", content: q };
    const loadingMsg: Message = { id: assistantMsgId, role: "assistant", content: "", loading: true };

    setMessages((prev) => [...prev, userMsg, loadingMsg]);
    setInput("");
    setSending(true);

    try {
      const history = buildHistory();
      const { job_id } = await api.ask(q, undefined, history);
      await pollJob(job_id, assistantMsgId);
    } catch (e: any) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId
            ? { ...m, loading: false, error: e.message }
            : m
        )
      );
      setSending(false);
    }
  }

  function clearConversation() {
    stopPolling();
    setMessages([]);
    cache.clear(CACHE_KEY);
    setSending(false);
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  // Cleanup polling on unmount
  useEffect(() => () => stopPolling(), []);

  const isEmpty = messages.length === 0;

  return (
    <div className="flex flex-col h-[calc(100vh-64px)] max-w-[760px]">
      {/* Header */}
      <div className="flex items-center justify-between py-5 shrink-0">
        <div>
          <h1 className="font-display text-[22px] text-[var(--text-1)]">Ask</h1>
          <p className="text-[13px] text-[var(--text-3)] mt-0.5">
            Ask anything about your library. Answers are grounded in your papers.
          </p>
        </div>
        {!isEmpty && (
          <button
            onClick={clearConversation}
            className="flex items-center gap-1.5 px-3 py-2 rounded-[var(--r-md)] border border-[var(--line)] text-[12.5px] text-[var(--text-3)] t-all hover:text-[var(--contra)] hover:border-[var(--contra-line)]"
          >
            <Trash2 size={13} /> Clear
          </button>
        )}
      </div>

      {/* Message list */}
      <div className="flex-1 overflow-y-auto py-2">
        {isEmpty ? (
          <div className="flex flex-col items-center justify-center h-full gap-4 pb-20">
            <div className="w-12 h-12 rounded-[12px] bg-[var(--gen-dim)] border border-[var(--gen-line)] flex items-center justify-center">
              <Sparkles size={22} className="text-[var(--gen)]" />
            </div>
            <div className="text-center">
              <div className="text-[15px] font-medium text-[var(--text-1)] mb-1.5">
                Ask about your research
              </div>
              <div className="text-[13px] text-[var(--text-3)] max-w-[360px] leading-relaxed">
                Questions are answered by searching your library and synthesizing across papers.
                Follow-ups work — the model remembers the conversation.
              </div>
            </div>
            <div className="flex flex-col gap-2 w-full max-w-[400px]">
              {[
                "What are the main contradictions across all papers?",
                "How do these papers measure negotiation outcomes?",
                "What methodology is most common in this literature?",
              ].map((suggestion) => (
                <button
                  key={suggestion}
                  onClick={() => { setInput(suggestion); inputRef.current?.focus(); }}
                  className="text-left px-4 py-2.5 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-1)] text-[13px] text-[var(--text-2)] t-all hover:border-[var(--gen-line)] hover:text-[var(--text-1)] hover:bg-[var(--surface-2)]"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="py-2">
            {messages.map((msg) => (
              <MessageBubble key={msg.id} msg={msg} />
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Input bar */}
      <div className="shrink-0 pb-4 pt-2">
        <div className="flex gap-2 items-end p-2 rounded-[var(--r-lg)] border border-[var(--line)] bg-[var(--surface-1)] focus-within:border-[var(--gen-line)] t-all">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question about your papers… (Enter to send, Shift+Enter for new line)"
            rows={1}
            className="flex-1 bg-transparent text-[13.5px] text-[var(--text-1)] placeholder:text-[var(--text-4)] outline-none resize-none py-1.5 px-1.5 max-h-[120px] leading-[1.5]"
            style={{ fieldSizing: "content" } as React.CSSProperties}
          />
          <button
            onClick={send}
            disabled={sending || !input.trim()}
            className="p-2 rounded-[var(--r-md)] bg-[var(--gen)] text-white t-all hover:opacity-90 disabled:opacity-40 disabled:pointer-events-none shrink-0"
          >
            <Send size={15} />
          </button>
        </div>
        <div className="text-[11px] text-[var(--text-4)] mt-1.5 px-1">
          Answers are synthesized from your library. Sources shown below each response.
          Use <a href="/search" className="text-[var(--gen)] hover:underline">Search</a> to find specific passages.
        </div>
      </div>
    </div>
  );
}
