"use client";

import { useEffect, useState } from "react";
import { api, Insight } from "@/lib/api";
import { PageHeader, Card, EmptyState, Spinner, FilterChip, Claim, PrimaryButton } from "@/components/ui";
import { Radio, Zap, TrendingUp, CircleDot, FlaskConical, FileText } from "lucide-react";

const TYPE_META: Record<string, { icon: React.ElementType; color: string; label: string }> = {
  contradiction: { icon: Zap, color: "var(--contra)", label: "Contradiction detected" },
  consensus: { icon: TrendingUp, color: "var(--support)", label: "Consensus shift" },
  gap: { icon: CircleDot, color: "var(--nuance)", label: "Gap identified" },
  hypothesis: { icon: FlaskConical, color: "var(--gen)", label: "Hypothesis suggested" },
  new_paper: { icon: FileText, color: "#5B9BE0", label: "New paper" },
};

export default function FeedPage() {
  const [insights, setInsights] = useState<Insight[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const load = () => {
    setLoading(true);
    api.insights({ limit: 30 }).then((d) => { setInsights(d); setLoading(false); }).catch(() => setLoading(false));
  };
  useEffect(load, []);

  const filtered = filter === "all" ? insights : insights.filter((i) => i.type === filter);

  return (
    <div>
      <PageHeader title="Research wire" subtitle="ScholarLens watches your field and surfaces what matters."
        action={<PrimaryButton onClick={load} full={false}><Radio size={15} /> Refresh</PrimaryButton>} />

      <div className="flex gap-2 mb-5">
        {["all", "contradiction", "consensus", "gap", "hypothesis"].map((f) =>
          <FilterChip key={f} label={f === "all" ? "All" : TYPE_META[f]?.label.split(" ")[0] || f} active={filter === f} onClick={() => setFilter(f)} />)}
      </div>

      {loading ? <Spinner label="Synthesizing insights from your library…" />
      : filtered.length === 0 ? (
        <EmptyState icon={<Radio size={20} />} title="Your research wire is quiet"
          hint="Run a contradiction scan or monitor scan to generate insights" />
      ) : (
        <div className="relative">
          {/* timeline spine */}
          <div className="absolute left-[15px] top-2 bottom-2 w-px bg-[var(--line)]" />
          <div className="space-y-3">
            {filtered.map((ins, idx) => {
              const meta = TYPE_META[ins.type] || TYPE_META.gap;
              const Icon = meta.icon;
              const open = expanded[ins.id];
              return (
                <div key={ins.id} className="relative pl-11 glow-in" style={{ animationDelay: `${idx * 50}ms` }}>
                  {/* node */}
                  <div className="absolute left-0 top-3 w-8 h-8 rounded-full flex items-center justify-center" style={{ background: "var(--surface-2)", border: `1px solid ${meta.color}` }}>
                    <Icon size={14} style={{ color: meta.color }} />
                  </div>
                  <Card>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-[11px] font-medium uppercase tracking-wider" style={{ color: meta.color }}>{meta.label}</span>
                      <span className="ml-auto text-[11px] text-[var(--text-4)] mono">{new Date(ins.created_at).toLocaleDateString()}</span>
                    </div>
                    <div className="text-[14.5px] font-medium text-[var(--text-1)] leading-snug mb-2">{ins.headline}</div>
                    {ins.claim && <Claim className="block mb-2 text-[var(--text-2)]">{ins.claim}</Claim>}
                    {open && <div className="text-[13px] text-[var(--text-2)] leading-[1.65] mt-2 pt-3 border-t border-[var(--line)] fade-up">{ins.detail}</div>}
                    <div className="flex items-center gap-3 mt-3">
                      {ins.detail && (
                        <button onClick={() => setExpanded((s) => ({ ...s, [ins.id]: !s[ins.id] }))} className="text-[12px] text-[var(--gen)] font-medium hover:underline">
                          {open ? "Less" : "Why this matters"}
                        </button>
                      )}
                      {ins.papers?.length > 0 && <span className="text-[11px] text-[var(--text-4)]">{ins.papers.length} paper{ins.papers.length > 1 ? "s" : ""}</span>}
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
