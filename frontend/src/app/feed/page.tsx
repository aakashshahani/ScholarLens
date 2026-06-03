"use client";

import { useEffect, useState } from "react";
import { api, Insight } from "@/lib/api";
import { PageHeader, EmptyState, Spinner } from "@/components/ui";
import { Radio, Zap, TrendingUp, CircleDot, FlaskConical, FileText, RefreshCw, ChevronDown, ChevronUp } from "lucide-react";

const TYPE_META: Record<string, { icon: React.ElementType; color: string; label: string; bg: string }> = {
  contradiction: { icon: Zap,         color: "var(--contra)",  bg: "var(--contra-dim)",     label: "Contradiction" },
  consensus:     { icon: TrendingUp,  color: "var(--support)", bg: "var(--support-dim)",    label: "Consensus"     },
  gap:           { icon: CircleDot,   color: "var(--nuance)",  bg: "var(--nuance-dim)",     label: "Gap"           },
  hypothesis:    { icon: FlaskConical,color: "var(--gen)",     bg: "var(--gen-dim)",        label: "Hypothesis"    },
  new_paper:     { icon: FileText,    color: "#5B9BE0",        bg: "rgba(91,155,224,0.12)", label: "New paper"     },
};

const FILTER_TABS = [
  { key: "all",           label: "All"            },
  { key: "contradiction", label: "Contradictions"  },
  { key: "consensus",     label: "Consensus"       },
  { key: "gap",           label: "Gaps"            },
  { key: "new_paper",     label: "New papers"      },
];

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
          <li key={i} className="flex items-start gap-2 text-[12.5px] text-[var(--text-2)] leading-[1.6]">
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
      <p key={idx} className="text-[12.5px] text-[var(--text-2)] leading-[1.65] mb-1.5"
        dangerouslySetInnerHTML={{ __html: inlineMd(line) }} />
    );
  });
  flushList("end");
  return <div className="space-y-0">{elements}</div>;
}

export default function FeedPage() {
  const [insights, setInsights]     = useState<Insight[]>([]);
  const [loading, setLoading]       = useState(true);
  const [filter, setFilter]         = useState("all");
  const [expanded, setExpanded]     = useState<Record<string, boolean>>({});
  const [lastLoaded, setLastLoaded] = useState<Date | null>(null);

  const load = () => {
    setLoading(true);
    api.insights({ limit: 40 })
      .then((d) => { setInsights(d); setLoading(false); setLastLoaded(new Date()); })
      .catch(() => setLoading(false));
  };
  useEffect(load, []);

  const filtered = filter === "all" ? insights : insights.filter((i) => i.type === filter);
  const hasScanResults = insights.some((i) => i.type === "contradiction" || i.type === "consensus");

  // Count per type for filter tabs
  const typeCounts: Record<string, number> = {};
  insights.forEach((i) => { typeCounts[i.type] = (typeCounts[i.type] || 0) + 1; });

  return (
    <div>
      <PageHeader
        title="Research wire"
        subtitle={lastLoaded ? `Updated ${lastLoaded.toLocaleTimeString()}` : "Synthesized from your library — no extra API calls."}
        action={
          <button
            onClick={load}
            disabled={loading}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-2)] text-[12.5px] text-[var(--text-2)] t-all hover:border-[var(--line-2)] hover:text-[var(--text-1)] disabled:opacity-50"
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        }
      />

      {/* Prompt to run scan if no relationship data yet */}
      {!hasScanResults && !loading && (
        <div className="bg-[var(--surface-2)] border border-[var(--nuance-line)] rounded-[var(--r-lg)] p-4 mb-5 flex items-center gap-3">
          <CircleDot size={15} className="text-[var(--nuance)] shrink-0" />
          <div className="text-[13px] text-[var(--text-2)]">
            Contradiction and consensus signals appear after you{" "}
            <a href="/contradictions" className="text-[var(--gen)] font-medium hover:underline">
              run a contradiction scan
            </a>.
          </div>
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex gap-1.5 mb-6 flex-wrap">
        {FILTER_TABS.map(({ key, label }) => {
          const count = key === "all" ? insights.length : (typeCounts[key] || 0);
          if (key !== "all" && count === 0) return null;
          return (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--r-md)] text-[12px] border t-all ${
                filter === key
                  ? "border-[var(--gen-line)] bg-[var(--gen-dim)] text-[var(--gen)]"
                  : "border-[var(--line)] bg-[var(--surface-2)] text-[var(--text-3)] hover:border-[var(--line-2)] hover:text-[var(--text-2)]"
              }`}
            >
              {label}
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${filter === key ? "bg-[var(--gen)] text-white" : "bg-[var(--surface-3)] text-[var(--text-4)]"}`}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {loading ? (
        <Spinner label="Loading from your library…" />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Radio size={20} />}
          title={filter === "all" ? "Your research wire is quiet" : `No ${filter} insights yet`}
          hint="Add papers and run a contradiction scan to generate signals."
        />
      ) : (
        <div className="space-y-3">
          {filtered.map((ins) => {
            const meta = TYPE_META[ins.type] || TYPE_META.gap;
            const Icon = meta.icon;
            const open = expanded[ins.id];
            const hasDetail = ins.detail && ins.detail.length > 0;
            const hasTwoPapers = ins.papers?.length >= 2;

            return (
              <div
                key={ins.id}
                className="bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-lg)] overflow-hidden t-all hover:border-[var(--line-2)]"
              >
                {/* Top accent bar matching type */}
                <div className="h-[2px]" style={{ background: meta.color }} />

                <div className="p-4">
                  {/* Type badge + date */}
                  <div className="flex items-center gap-2 mb-3">
                    <span
                      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10.5px] font-medium"
                      style={{ background: meta.bg, color: meta.color }}
                    >
                      <Icon size={11} />
                      {meta.label}
                    </span>
                    <span className="ml-auto text-[10.5px] text-[var(--text-4)]">
                      {new Date(ins.created_at).toLocaleDateString()}
                    </span>
                  </div>

                  {/* Headline — the main signal */}
                  <p className="text-[13.5px] font-medium text-[var(--text-1)] leading-snug mb-3">
                    {ins.headline}
                  </p>

                  {/* Paper names — always visible, named clearly */}
                  {ins.papers?.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-3">
                      {ins.papers.map((p, i) => (
                        <span
                          key={i}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-[var(--r-sm)] bg-[var(--surface-3)] text-[11px] text-[var(--text-3)] border border-[var(--line)]"
                        >
                          <span
                            className="w-[5px] h-[5px] rounded-full shrink-0"
                            style={{ background: i === 0 ? meta.color : "var(--text-4)" }}
                          />
                          <span className="clamp-1 max-w-[200px]">{p}</span>
                        </span>
                      ))}
                      {hasTwoPapers && (
                        <span className="text-[10px] text-[var(--text-4)] self-center px-1">
                          vs.
                        </span>
                      )}
                    </div>
                  )}

                  {/* Expandable detail */}
                  {hasDetail && (
                    <>
                      {open && (
                        <div className="pt-3 mb-3 border-t border-[var(--line)] fade-up">
                          <MarkdownAnswer text={ins.detail} />
                        </div>
                      )}
                      <button
                        onClick={() => setExpanded((s) => ({ ...s, [ins.id]: !s[ins.id] }))}
                        className="flex items-center gap-1 text-[11.5px] text-[var(--gen)] font-medium hover:underline t-all"
                      >
                        {open ? <><ChevronUp size={12} /> Hide reasoning</> : <><ChevronDown size={12} /> See full analysis</>}
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
