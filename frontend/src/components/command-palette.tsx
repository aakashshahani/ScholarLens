"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  LayoutDashboard, Library, Network, Zap, FlaskConical, Radar, Plus, Search, CornerDownLeft, FileText,
} from "lucide-react";
import { api, type Paper } from "@/lib/api";
import { cache } from "@/lib/cache";

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
  { id: "monitor", label: "Open Research Monitor", hint: "Watch the literature", icon: Radar, action: (r) => r.push("/monitor"), keywords: "arxiv alerts new papers" },
  { id: "add", label: "Add Papers", hint: "Upload or import", icon: Plus, action: (r) => r.push("/add-papers"), keywords: "upload import arxiv pdf" },
];

type Item =
  | { kind: "cmd"; cmd: Cmd }
  | { kind: "paper"; paper: Paper };

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [papers, setPapers] = useState<Paper[]>([]);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  // Papers power the "Search … papers …" promise in the input placeholder.
  useEffect(() => {
    const cached = cache.read<Paper[]>("papers");
    if (cached?.length) setPapers(cached);
    api.listPapers(100).then((p) => { setPapers(p); cache.write("papers", p); }).catch(() => {});
  }, []);

  const q = query.toLowerCase();
  const filtered = COMMANDS.filter((c) =>
    !q || c.label.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q) || (c.keywords || "").includes(q)
  );
  const paperMatches = q
    ? papers.filter((p) =>
        p.title.toLowerCase().includes(q) || (p.authors || []).some((a) => a.toLowerCase().includes(q))
      ).slice(0, 5)
    : [];
  const items: Item[] = [
    ...filtered.map((c) => ({ kind: "cmd", cmd: c } as Item)),
    ...paperMatches.map((p) => ({ kind: "paper", paper: p } as Item)),
  ];

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

  const run = (item: Item) => {
    if (item.kind === "cmd") item.cmd.action(router);
    else router.push(`/paper/${item.paper.id}`);
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, items.length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    if (e.key === "Enter" && items[sel]) { e.preventDefault(); run(items[sel]); }
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
          {items.length === 0 ? (
            <div className="px-3 py-8 text-center text-[13px] text-[var(--text-3)]">No matches</div>
          ) : (
            items.map((item, i) => {
              const active = i === sel;
              // Section divider before the first paper result.
              const showPapersLabel = item.kind === "paper" && (i === 0 || items[i - 1].kind === "cmd");
              const Icon = item.kind === "cmd" ? item.cmd.icon : FileText;
              const label = item.kind === "cmd" ? item.cmd.label : item.paper.title;
              const hint = item.kind === "cmd"
                ? item.cmd.hint
                : [(item.paper.authors || [])[0], item.paper.year].filter(Boolean).join(" · ");
              return (
                <div key={item.kind === "cmd" ? item.cmd.id : item.paper.id}>
                  {showPapersLabel && (
                    <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-[var(--text-4)]">Papers</div>
                  )}
                  <button
                    onMouseEnter={() => setSel(i)}
                    onClick={() => run(item)}
                    className={`w-full flex items-center gap-3 px-3 h-11 rounded-[var(--r-md)] text-left t-all ${
                      active ? "bg-[var(--surface-3)]" : ""
                    }`}
                  >
                    <Icon size={16} className={active ? "text-[var(--gen)]" : "text-[var(--text-3)]"} />
                    <span className="text-[13.5px] text-[var(--text-1)] truncate">{label}</span>
                    {hint && <span className="text-[12px] text-[var(--text-4)] ml-auto shrink-0 truncate max-w-[40%]">{hint}</span>}
                    {active && <CornerDownLeft size={13} className="text-[var(--text-3)] shrink-0" />}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
