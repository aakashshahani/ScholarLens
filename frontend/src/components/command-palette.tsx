"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  LayoutDashboard, Library, Network, Zap, FlaskConical, Radio, Plus, Search, CornerDownLeft,
} from "lucide-react";

interface Cmd {
  id: string;
  label: string;
  hint: string;
  icon: React.ElementType;
  action: (r: ReturnType<typeof useRouter>) => void;
  keywords?: string;
}

const COMMANDS: Cmd[] = [
  { id: "dash", label: "Go to Dashboard", hint: "Situation room", icon: LayoutDashboard, action: (r) => r.push("/") },
  { id: "lib", label: "Go to Library", hint: "The corpus", icon: Library, action: (r) => r.push("/library") },
  { id: "graph", label: "Open Knowledge Graph", hint: "Claim field", icon: Network, action: (r) => r.push("/graph"), keywords: "map network nodes" },
  { id: "contra", label: "Run Contradiction Scan", hint: "Conflict map", icon: Zap, action: (r) => r.push("/contradictions"), keywords: "conflict tension" },
  { id: "hypo", label: "Generate Hypotheses", hint: "Generative bench", icon: FlaskConical, action: (r) => r.push("/hypotheses"), keywords: "ideas research questions" },
  { id: "feed", label: "Open Insight Feed", hint: "Research wire", icon: Radio, action: (r) => r.push("/feed"), keywords: "news activity" },
  { id: "add", label: "Add Papers", hint: "Upload or import", icon: Plus, action: (r) => r.push("/add-papers"), keywords: "upload import arxiv pdf" },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = COMMANDS.filter((c) => {
    const q = query.toLowerCase();
    return !q || c.label.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q) || (c.keywords || "").includes(q);
  });

  const close = useCallback(() => { setOpen(false); setQuery(""); setSel(0); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); setOpen((o) => !o); }
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 30); }, [open]);
  useEffect(() => { setSel(0); }, [query]);

  const run = (c: Cmd) => { c.action(router); close(); };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, filtered.length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    if (e.key === "Enter" && filtered[sel]) { e.preventDefault(); run(filtered[sel]); }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[18vh]" onClick={close}>
      <div className="absolute inset-0 bg-black/55 backdrop-blur-[2px]" />
      <div
        className="relative w-full max-w-[560px] mx-4 bg-[var(--surface-2)] border border-[var(--line-3)] rounded-[var(--r-lg)] overflow-hidden glow-gen fade-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 h-13 border-b border-[var(--line)]">
          <Search size={17} className="text-[var(--text-3)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search commands, papers, actions…"
            className="flex-1 bg-transparent border-0 outline-none py-3.5 text-[14px] text-[var(--text-1)] placeholder:text-[var(--text-4)]"
            style={{ boxShadow: "none" }}
          />
          <kbd className="mono text-[10px] px-1.5 py-0.5 rounded bg-[var(--surface-3)] border border-[var(--line-2)] text-[var(--text-3)]">ESC</kbd>
        </div>
        <div className="max-h-[340px] overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <div className="px-3 py-8 text-center text-[13px] text-[var(--text-3)]">No matches</div>
          ) : (
            filtered.map((c, i) => {
              const Icon = c.icon;
              const active = i === sel;
              return (
                <button
                  key={c.id}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => run(c)}
                  className={`w-full flex items-center gap-3 px-3 h-11 rounded-[var(--r-md)] text-left t-all ${
                    active ? "bg-[var(--surface-3)]" : ""
                  }`}
                >
                  <Icon size={16} className={active ? "text-[var(--gen)]" : "text-[var(--text-3)]"} />
                  <span className="text-[13.5px] text-[var(--text-1)]">{c.label}</span>
                  <span className="text-[12px] text-[var(--text-4)] ml-auto">{c.hint}</span>
                  {active && <CornerDownLeft size={13} className="text-[var(--text-3)]" />}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
