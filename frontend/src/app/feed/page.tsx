"use client";

import { useEffect, useState } from "react";
import { api, Insight } from "@/lib/api";
import { PageHeader, Card, EmptyState, Spinner, FilterChip, Claim, PrimaryButton } from "@/components/ui";
import { Radio, Zap, TrendingUp, CircleDot, FlaskConical, FileText, RefreshCw } from "lucide-react";

const TYPE_META: Record<string, { icon: React.ElementType; color: string; label: string }> = {
  contradiction: { icon: Zap, color: "var(--contra)", label: "Contradiction detected" },
  consensus: { icon: TrendingUp, color: "var(--support)", label: "Consensus" },
  gap: { icon: CircleDot, color: "var(--nuance)", label: "Gap identified" },
  hypothesis: { icon: FlaskConical, color: "var(--gen)", label: "Hypothesis" },
  new_paper: { icon: FileText, color: "#5B9BE0", label: "New paper" },
};

export default function FeedPage() {
  const [insights, setInsights] = useState<Insight[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [lastLoaded, setLastLoaded] = useState<Date | null>(null);

  const load = () => {
    setLoading(true);
    api.insights({ limit: 30 })
      .then((d) => { setInsights(d); setLoading(false); setLastLoaded(new Date()); })
      .catch(() => setLoading(false));
  };
  useEffect(load, []);

  const filtered = filter === "all" ? insights : insights.filter((i) => i.type === filter);
  const hasScanResults = insights.some((i) => i.type === "contradiction" || i.type === "consensus");

  return (
    <div>
      <PageHeader
        title="Research wire"
        subtitle={lastLoaded ? `Last loaded ${lastLoaded.toLocaleTimeString()}` : "Synthesized from your library — no extra API calls."}
        action={
          <button onClick={load} disabled={loading}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-2)] text-[12.5px] text-[var(--text-2)] t-all hover:border-[var(--line-2)] hover:text-[var(--text-1)] disabled:opacity-50">
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        }
      />

      {!hasScanResults && !loading && (
        <div className="bg-[var(--surface-2)] border border-[var(--nuance-line)] rounded-[var(--r-lg)] p-4 mb-5 flex items-center gap-3">
          <CircleDot size={16} className="text-[var(--nuance)] shrink-0" />
          <div className="text-[13px] text-[var(--text-2)]">
            Contradiction and consensus insights appear here after you{" "}
            <a href="/contradictions" className="text-[var(--gen)] font-medium hover:underline">
              run a contradiction scan
            </a>
            . New paper and gap insights are already loading from your library.
          </div>
        </div>
      )}

      <div className="flex gap-2 mb-5">
        {["all", "contradiction", "consensus", "gap", "new_paper"].map((f) => (
          <FilterChip key={f}
            label={f === "all" ? "All" : TYPE_META[f]?.label || f}
            active={filter === f} onClick={() => setFilter(f)} />
        ))}
      </div>

      {loading ? (
        <Spinner label="Loading from your library…" />
      ) : filtered.length === 0 ? (
        <EmptyState icon={<Radio size={20} />}
          title={filter === "all" ? "Your research wire is quiet" : `No ${filter} insights yet`}
          hint={filter === "all"
            ? "Add papers and run a contradiction scan to start generating insights."
            : `Run a contradiction scan to surface ${filter} signals.`} />
      ) : (
        <div className="relative">
          <div className="absolute left-[15px] top-2 bottom-2 w-px bg-[var(--line)]" />
          <div className="space-y-3">
            {filtered.map((ins, idx) => {
              const meta = TYPE_META[ins.type] || TYPE_META.gap;
              const Icon = meta.icon;
              const open = expanded[ins.id];
              return (
                <div key={ins.id} className="relative pl-11 glow-in" style={{ animationDelay: `${idx * 40}ms` }}>
                  <div className="absolute left-0 top-3 w-8 h-8 rounded-full flex items-center justify-center"
                    style={{ background: "var(--surface-2)", border: `1px solid ${meta.color}` }}>
                    <Icon size={14} style={{ color: meta.color }} />
                  </div>
                  <Card>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-[11px] font-medium uppercase tracking-wider" style={{ color: meta.color }}>
                        {meta.label}
                      </span>
                      <span className="ml-auto mono text-[11px] text-[var(--text-4)]">
                        {new Date(ins.created_at).toLocaleDateString()}
                      </span>
                    </div>
                    <div className="text-[14.5px] font-medium text-[var(--text-1)] leading-snug mb-2">{ins.headline}</div>
                    {ins.claim && <Claim className="block mb-2 text-[var(--text-2)]">{ins.claim}</Claim>}
                    {open && ins.detail && (
                      <div className="text-[13px] text-[var(--text-2)] leading-[1.65] mt-2 pt-3 border-t border-[var(--line)] fade-up">
                        {ins.detail}
                      </div>
                    )}
                    <div className="flex items-center gap-3 mt-3">
                      {ins.detail && (
                        <button onClick={() => setExpanded((s) => ({ ...s, [ins.id]: !s[ins.id] }))}
                          className="text-[12px] text-[var(--gen)] font-medium hover:underline">
                          {open ? "Show less" : "Why this matters"}
                        </button>
                      )}
                      {ins.papers?.length > 0 && (
                        <span className="text-[11px] text-[var(--text-4)]">
                          {ins.papers.length} paper{ins.papers.length > 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                  </Card>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
