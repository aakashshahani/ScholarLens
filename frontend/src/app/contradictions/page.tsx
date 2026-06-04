"use client";

import { useEffect, useState } from "react";
import { api, Paper, ContradictionResult } from "@/lib/api";
import { PageHeader, Card, EmptyState, Spinner, PrimaryButton, Claim, REL } from "@/components/ui";
import { Zap, Settings2, AlertCircle } from "lucide-react";
import { cache } from "@/lib/cache";

// ── Lightweight markdown renderer ────────────────────────────
function MarkdownAnswer({ text }: { text: string }) {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let listBuffer: string[] = [];

  const inlineMd = (s: string) =>
    s
      .replace(/\*\*(.+?)\*\*/g, '<strong class="text-[var(--text-1)] font-semibold">$1</strong>')
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/`(.+?)`/g, '<code class="mono text-[11px] bg-[var(--surface-3)] px-1 py-0.5 rounded text-[var(--gen)]">$1</code>');

  const flushList = (key: string) => {
    if (!listBuffer.length) return;
    elements.push(
      <ul key={key} className="space-y-1 mb-2 pl-0 list-none">
        {listBuffer.map((item, i) => (
          <li key={i} className="flex items-start gap-2 text-[13px] text-[var(--text-1)] leading-[1.6]">
            <span className="mt-[7px] w-[3px] h-[3px] rounded-full bg-[var(--gen)] shrink-0" />
            <span dangerouslySetInnerHTML={{ __html: inlineMd(item) }} />
          </li>
        ))}
      </ul>
    );
    listBuffer = [];
  };

  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (!line) { flushList(`l${idx}`); return; }
    if (line.startsWith("## ")) {
      flushList(`l${idx}`);
      elements.push(<h2 key={idx} className="text-[13px] font-semibold text-[var(--text-1)] mt-3 mb-1">{line.slice(3)}</h2>);
      return;
    }
    if (line.startsWith("### ")) {
      flushList(`l${idx}`);
      elements.push(<h3 key={idx} className="text-[11.5px] font-semibold text-[var(--text-2)] uppercase tracking-wide mt-2 mb-0.5">{line.slice(4)}</h3>);
      return;
    }
    if (line.startsWith("- ") || line.startsWith("* ")) { listBuffer.push(line.slice(2)); return; }
    const numbered = line.match(/^\d+\.\s+(.+)/);
    if (numbered) { listBuffer.push(numbered[1]); return; }
    flushList(`l${idx}`);
    elements.push(
      <p key={idx} className="text-[13px] text-[var(--text-1)] leading-[1.65] mb-1.5"
        dangerouslySetInnerHTML={{ __html: inlineMd(line) }} />
    );
  });
  flushList("end");
  return <div className="space-y-0">{elements}</div>;
}

const PRESETS = {
  quick:    { label: "Quick",    threshold: 0.55, maxPairs: 10, time: "~15s" },
  balanced: { label: "Balanced", threshold: 0.50, maxPairs: 15, time: "~30s" },
  deep:     { label: "Deep",     threshold: 0.40, maxPairs: 25, time: "~60s" },
} as const;
type Preset = keyof typeof PRESETS;

export default function ContradictionsPage() {
  const [papers, setPapers] = useState<Paper[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [preset, setPreset] = useState<Preset>("balanced");
  const [results, setResults] = useState<ContradictionResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<ContradictionResult | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [libraryChanged, setLibraryChanged] = useState(false);

  useEffect(() => {
    api.listPapers(50).then(setPapers);

    // Fast first paint from localStorage if present, then replace with the
    // full persisted set from the backend so the conflict map always shows
    // ALL accumulated relationships — consistent with the dashboard count,
    // not just the last scan's slice.
    const cached = cache.read<ContradictionResult[]>("contradictions");
    if (cached && Array.isArray(cached) && cached.length > 0) {
      setResults(cached);
      const firstReal = cached.find((r) => r.relationship !== "unrelated" && r.relationship !== "error");
      if (firstReal) setSelected(firstReal);
    }

    // Source of truth: the full relationship table (pure DB read, zero LLM).
    api.listContradictions()
      .then((full) => {
        if (Array.isArray(full) && full.length > 0) {
          setResults(full);
          cache.write("contradictions", full);
          setSelected((prev) => prev || full.find(
            (r) => r.relationship !== "unrelated" && r.relationship !== "error"
          ) || null);
          setShowConfig(false);
        } else if (!cached || cached.length === 0) {
          // Nothing persisted and nothing cached → first-run config prompt.
          setShowConfig(true);
        }
        // Keep the library-changed fingerprint check for the warning banner.
        api.health().then((h) => {
          const fingerprint = (h as any).library_fingerprint || "default";
          const cachedFingerprint = localStorage.getItem("sl_contradictions_fp");
          if (cachedFingerprint && cachedFingerprint !== fingerprint) setLibraryChanged(true);
        }).catch(() => {});
      })
      .catch(() => {
        // Backend unreachable: fall back to whatever was cached; prompt if empty.
        if (!cached || cached.length === 0) setShowConfig(true);
      });
  }, []);

  const p = PRESETS[preset];

  const runScan = async () => {
    setLoading(true); setResults([]); setFilter(null); setSelected(null); setError("");
    setLibraryChanged(false);
    const stages = ["Extracting claims from papers", "Embedding & comparing claims", "Judging relationships"];
    let si = 0; setStage(stages[0]);
    const ticker = setInterval(() => { si = Math.min(si + 1, stages.length - 1); setStage(stages[si]); }, 3000);
    try {
      await api.runContradictions({
        paperIds: selectedIds.length ? selectedIds : undefined,
        similarityThreshold: p.threshold,
        maxPairs: p.maxPairs,
      });
      // The scan appended/updated rows. Reload the FULL persisted set so the
      // view shows everything accumulated, not just this run's slice.
      const full = await api.listContradictions();
      setResults(full);
      cache.write("contradictions", full);
      api.health().then((h) => {
        const fp = (h as any).library_fingerprint || "default";
        localStorage.setItem("sl_contradictions_fp", fp);
      }).catch(() => {});
      setShowConfig(false);
      const firstReal = full.find((r) => r.relationship !== "unrelated" && r.relationship !== "error");
      if (firstReal) setSelected(firstReal);
    } catch (e: any) { setError(e.message); }
    clearInterval(ticker); setLoading(false);
  };

  const counts: Record<string, number> = {};
  results.forEach((r) => { counts[r.relationship] = (counts[r.relationship] || 0) + 1; });
  const displayResults = results.filter((r) => r.relationship !== "error");
  const filtered = filter ? displayResults.filter((r) => r.relationship === filter) : displayResults;

  return (
    <div>
      <PageHeader
        title="Conflict map"
        subtitle="Where your papers disagree — claim against claim."
        action={
          <button onClick={() => setShowConfig((s) => !s)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-2)] text-[12.5px] text-[var(--text-2)] t-all hover:border-[var(--line-2)] hover:text-[var(--text-1)]">
            <Settings2 size={14} /> {showConfig ? "Hide" : "New scan"}
          </button>
        }
      />

      {papers.length < 2 ? (
        <EmptyState icon={<Zap size={20} />} title="Need at least 2 papers" hint="Add more papers to surface conflicts." />
      ) : (
        <>
          {/* Library changed banner — shows without forcing config */}
          {libraryChanged && !showConfig && (
            <div className="bg-[var(--nuance-dim)] border border-[var(--nuance-line)] rounded-[var(--r-lg)] p-4 mb-4 flex items-center gap-3">
              <AlertCircle size={15} className="text-[var(--nuance)] shrink-0" />
              <div className="flex-1 text-[13px] text-[var(--text-2)]">
                Your library has changed — these results may be outdated.
              </div>
              <button
                onClick={() => { setShowConfig(true); setLibraryChanged(false); }}
                className="text-[12px] text-[var(--gen)] font-medium hover:underline shrink-0 t-all"
              >
                Run new scan
              </button>
            </div>
          )}

          {showConfig && (
            <Card className="mb-6 fade-up">
              <div className="mb-5">
                <div className="text-[11px] font-medium text-[var(--text-3)] uppercase tracking-wider mb-2.5">Scan depth</div>
                <div className="grid grid-cols-3 gap-2">
                  {(Object.entries(PRESETS) as [Preset, typeof PRESETS[Preset]][]).map(([key, val]) => (
                    <button key={key} onClick={() => setPreset(key)}
                      className={`p-3 rounded-[var(--r-md)] border text-left t-all ${preset === key ? "bg-[var(--gen-dim)] border-[var(--gen-line)] text-[var(--text-1)]" : "bg-[var(--surface-1)] border-[var(--line)] text-[var(--text-2)] hover:border-[var(--line-2)]"}`}>
                      <div className="text-[13px] font-medium mb-0.5">{val.label}</div>
                      <div className="text-[11px] text-[var(--text-3)]">{val.time}</div>
                    </button>
                  ))}
                </div>
                <div className="text-[11px] text-[var(--text-3)] mt-2">
                  {p.label}: compares up to {p.maxPairs} claim pairs across papers
                  {preset === "deep" && " — thorough but slow"}
                  {preset === "quick" && " — fast, may miss some relationships"}
                </div>
              </div>

              <div className="mb-5">
                <div className="text-[11px] font-medium text-[var(--text-3)] uppercase tracking-wider mb-2.5">Papers · leave empty to scan all</div>
                <div className="flex flex-wrap gap-1.5">
                  {papers.map((p) => {
                    const active = selectedIds.includes(p.id);
                    return (
                      <button key={p.id} onClick={() => setSelectedIds((ids) => active ? ids.filter((x) => x !== p.id) : [...ids, p.id])}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--r-md)] text-[12px] border t-all ${active ? "bg-[var(--gen-dim)] text-[var(--gen)] border-[var(--gen-line)]" : "bg-[var(--surface-2)] text-[var(--text-2)] border-[var(--line)] hover:border-[var(--line-2)] hover:text-[var(--text-1)]"}`}>
                        {p.title.length > 40 ? p.title.slice(0, 40) + "…" : p.title}
                      </button>
                    );
                  })}
                </div>
              </div>

              <PrimaryButton onClick={runScan} disabled={loading}>
                <Zap size={15} /> {loading ? "Scanning…" : `Run ${p.label.toLowerCase()} scan`}
              </PrimaryButton>
            </Card>
          )}

          {loading && (
            <Card className="mb-6">
              <div className="flex items-center gap-3">
                <Spinner />
                <div>
                  <div className="text-[13px] text-[var(--text-1)] font-medium">{stage}</div>
                  <div className="text-[11px] text-[var(--text-3)] mt-0.5">Expected time: {p.time}</div>
                </div>
              </div>
            </Card>
          )}

          {error && (
            <div className="bg-[var(--contra-dim)] border border-[var(--contra-line)] rounded-[var(--r-lg)] p-4 mb-6 flex items-start gap-3">
              <AlertCircle size={16} className="text-[var(--contra)] mt-0.5 shrink-0" />
              <div>
                <div className="text-[13px] text-[var(--contra)] font-medium">Scan failed</div>
                <div className="text-[12px] text-[var(--text-2)] mt-0.5">{error}</div>
              </div>
            </div>
          )}

          {results.length > 0 && (
            <div className="fade-up">
              <div className="grid grid-cols-4 gap-3 mb-5">
                {(["contradiction", "nuance", "support", "unrelated"] as const).map((type) => {
                  const on = filter === type;
                  return (
                    <button key={type} onClick={() => setFilter(on ? null : type)}
                      className={`relative bg-[var(--surface-2)] border rounded-[var(--r-lg)] p-4 text-left overflow-hidden t-all lift ${on ? "border-[var(--line-3)]" : "border-[var(--line)]"}`}>
                      <div className="font-display text-[24px] leading-none tabular-nums" style={{ color: REL[type].c }}>{counts[type] || 0}</div>
                      <div className="text-[11px] text-[var(--text-3)] mt-1.5 capitalize">{type}s</div>
                      <div className="absolute bottom-0 left-0 right-0 h-[2px]" style={{ background: REL[type].c }} />
                    </button>
                  );
                })}
              </div>

              <div className="grid grid-cols-[1fr_340px] gap-4">
                <div className="space-y-3">
                  {filtered.map((r) => {
                    const isSel = selected?.id === r.id;
                    return (
                      <button key={r.id} onClick={() => setSelected(r)}
                        className={`w-full text-left bg-[var(--surface-2)] border rounded-[var(--r-lg)] p-4 t-all ${isSel ? "border-[var(--line-3)]" : "border-[var(--line)] hover:border-[var(--line-2)]"}`}
                        style={isSel ? { boxShadow: `0 0 24px -10px ${(REL[r.relationship] ?? REL["unrelated"]).c}` } : {}}>
                        <TensionPair r={r} />
                      </button>
                    );
                  })}
                </div>
                <div className="sticky top-6 self-start">
                  {selected ? <Adjudication r={selected} /> : (
                    <Card><div className="text-[13px] text-[var(--text-3)] text-center py-8">Select a pair to see the model's reasoning.</div></Card>
                  )}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TensionPair({ r }: { r: ContradictionResult }) {
  const s = REL[r.relationship] ?? REL["unrelated"];
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-wide" style={{ background: s.dim, color: s.c }}>
          <span className="w-[5px] h-[5px] rounded-full" style={{ background: s.c }} />{r.relationship}
        </span>
        <span className="text-[10px] text-[var(--text-4)] uppercase tracking-wider">{r.category}</span>
        <span className="ml-auto mono text-[10px] text-[var(--text-4)]">{r.similarity ? `sim ${r.similarity.toFixed(2)}` : ""}</span>
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-center">
        <div>
          <div className="text-[10px] text-[var(--text-4)] mb-1 clamp-1">{r.claim_a.paper_title}</div>
          <Claim className="clamp-2 block">{r.claim_a.text}</Claim>
        </div>
        <div className="flex flex-col items-center w-12">
          <div className={`h-[2px] w-full ${r.relationship === "contradiction" ? "charged" : ""}`} style={{ background: s.line }} />
        </div>
        <div className="text-right">
          <div className="text-[10px] text-[var(--text-4)] mb-1 clamp-1">{r.claim_b.paper_title}</div>
          <Claim className="clamp-2 block">{r.claim_b.text}</Claim>
        </div>
      </div>
    </div>
  );
}

function Adjudication({ r }: { r: ContradictionResult }) {
  const s = REL[r.relationship] ?? REL["unrelated"];
  const stronger = r.stronger_evidence === "paper_a" ? r.claim_a.paper_title
    : r.stronger_evidence === "paper_b" ? r.claim_b.paper_title : null;

  return (
    <Card className="fade-up">
      <div className="flex items-center gap-2 mb-4">
        <span className="w-2 h-2 rounded-full" style={{ background: s.c }} />
        <span className="text-[12px] font-medium uppercase tracking-wider" style={{ color: s.c }}>{r.relationship}</span>
        <span className="ml-auto text-[10px] text-[var(--text-4)] uppercase tracking-wider">{r.category}</span>
      </div>
      <div className="text-[11px] font-medium text-[var(--text-3)] uppercase tracking-wider mb-2">Adjudication</div>
      <MarkdownAnswer text={r.explanation || ""} />
      {stronger && (
        <div className="mt-4 pt-4 border-t border-[var(--line)]">
          <div className="text-[11px] font-medium text-[var(--text-3)] uppercase tracking-wider mb-1.5">Stronger evidence</div>
          <div className="text-[12.5px] text-[var(--support)] font-medium">{stronger}</div>
        </div>
      )}
      {r.resolution && (
        <div className="mt-4 pt-4 border-t border-[var(--line)]">
          <div className="text-[11px] font-medium text-[var(--text-3)] uppercase tracking-wider mb-1.5">Path to resolution</div>
          <div className="text-[12.5px] text-[var(--text-2)] leading-[1.6]">{r.resolution}</div>
        </div>
      )}
    </Card>
  );
}
