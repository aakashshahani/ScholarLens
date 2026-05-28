"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, HealthStatus, Paper, Insight } from "@/lib/api";
import { PageHeader, MetricCard, Spinner, EmptyState, SkeletonCard, RelDot } from "@/components/ui";
import { FileStack, CheckCircle2, Zap, Radio, ArrowRight, BookOpen, Plus } from "lucide-react";

export default function Dashboard() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [papers, setPapers] = useState<Paper[]>([]);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [relCounts, setRelCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.health().then(setHealth).catch((e) => setError(e.message));
    api.listPapers(8).then((p) => { setPapers(p); setLoading(false); }).catch(() => setLoading(false));
    api.insights({ limit: 6 }).then(setInsights).catch(() => {});
    // Lightweight count — no LLM calls
    fetch("http://localhost:8000/api/contradictions/count")
      .then((r) => r.json())
      .then((d) => setRelCounts(d.counts || {}))
      .catch(() => {});
  }, []);

  const analyzed = papers.filter((p) => (p.analysis_types?.length || 0) >= 6).length;
  const contradictionCount = relCounts.contradiction || 0;
  const totalRelationships = Object.values(relCounts).reduce((a, b) => a + b, 0);
  const hasInsights = insights.length > 0;

  return (
    <div>
      <PageHeader title="Situation room" subtitle="Your knowledge base — and where the tension is." />

      {error ? (
        <div className="bg-[var(--contra-dim)] border border-[var(--contra-line)] rounded-[var(--r-lg)] p-5 mb-6">
          <p className="text-[var(--contra)] text-[13px] font-medium">Backend not reachable — {error}</p>
          <p className="text-[var(--text-2)] text-[12px] mt-1.5">
            Start it with <code className="mono text-[11px] bg-[var(--surface-3)] px-1.5 py-0.5 rounded">uvicorn api:app --reload --port 8000</code>
          </p>
        </div>
      ) : !health ? (
        <Spinner label="Connecting to backend…" />
      ) : (
        <>
          <div className="grid grid-cols-4 gap-3 mb-6 fade-up">
            <MetricCard value={health.papers} label="Papers" color="var(--gen)" icon={<FileStack size={18} />} />
            <MetricCard value={analyzed} label="Fully analyzed" color="var(--support)"
              barPercent={health.papers > 0 ? (analyzed / health.papers) * 100 : 0} icon={<CheckCircle2 size={18} />} />
            <MetricCard
              value={contradictionCount > 0 ? contradictionCount : "—"}
              label="Contradictions detected"
              color="var(--contra)"
              icon={<Zap size={18} />} />
            <MetricCard
              value={totalRelationships > 0 ? totalRelationships : "—"}
              label="Cross-paper links"
              color="var(--nuance)"
              icon={<Radio size={18} />} />
          </div>

          <div className="grid grid-cols-3 gap-3 mb-8">
            <Link href="/contradictions" className="group">
              <div className="h-full bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-lg)] p-5 t-all lift">
                <div className="flex items-center gap-2 mb-3">
                  <Zap size={15} className="text-[var(--contra)]" />
                  <span className="text-[13px] font-medium text-[var(--text-1)]">Conflict map</span>
                  <ArrowRight size={13} className="ml-auto text-[var(--text-4)] group-hover:text-[var(--text-2)] group-hover:translate-x-0.5 t-all" />
                </div>
                {contradictionCount > 0 ? (
                  <>
                    <div className="font-display text-[32px] text-[var(--contra)] leading-none mb-1 tabular-nums">{contradictionCount}</div>
                    <div className="text-[12px] text-[var(--text-3)]">
                      {relCounts.nuance ? `+ ${relCounts.nuance} nuanced disagreement${relCounts.nuance > 1 ? "s" : ""}` : "contradictions detected across papers"}
                    </div>
                  </>
                ) : totalRelationships > 0 ? (
                  <>
                    <div className="font-display text-[32px] text-[var(--support)] leading-none mb-1 tabular-nums">{totalRelationships}</div>
                    <div className="text-[12px] text-[var(--text-3)]">relationships mapped — no direct contradictions</div>
                  </>
                ) : (
                  <>
                    <div className="font-display text-[32px] text-[var(--text-4)] leading-none mb-1">—</div>
                    <div className="text-[12px] text-[var(--text-3)]">Run a scan to surface conflicts.</div>
                  </>
                )}
              </div>
            </Link>

            <Link href="/feed" className="group">
              <div className="h-full bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-lg)] p-5 t-all lift">
                <div className="flex items-center gap-2 mb-3">
                  <Radio size={15} className="text-[var(--gen)]" />
                  <span className="text-[13px] font-medium text-[var(--text-1)]">Research wire</span>
                  <ArrowRight size={13} className="ml-auto text-[var(--text-4)] group-hover:text-[var(--text-2)] group-hover:translate-x-0.5 t-all" />
                </div>
                {hasInsights ? (
                  <div className="space-y-2">
                    {insights.slice(0, 3).map((ins) => (
                      <div key={ins.id} className="flex items-start gap-2">
                        <RelDot type={ins.type === "consensus" ? "support" : ins.type === "gap" ? "nuance" : ins.type} />
                        <span className="text-[12px] text-[var(--text-2)] leading-[1.4] clamp-1">{ins.headline}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-[12px] text-[var(--text-3)] leading-[1.6]">Run a contradiction scan to populate the wire.</div>
                )}
              </div>
            </Link>

            <Link href="/library" className="group">
              <div className="h-full bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-lg)] p-5 t-all lift">
                <div className="flex items-center gap-2 mb-3">
                  <BookOpen size={15} className="text-[var(--support)]" />
                  <span className="text-[13px] font-medium text-[var(--text-1)]">Analysis status</span>
                  <ArrowRight size={13} className="ml-auto text-[var(--text-4)] group-hover:text-[var(--text-2)] group-hover:translate-x-0.5 t-all" />
                </div>
                <div className="space-y-2 text-[12px]">
                  <div className="flex justify-between">
                    <span className="text-[var(--text-3)]">Papers analyzed</span>
                    <span className="text-[var(--text-1)] tabular-nums">{analyzed} / {health.papers}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--text-3)]">Coverage</span>
                    <span className="text-[var(--support)] tabular-nums font-medium">
                      {health.papers > 0 ? Math.round((analyzed / health.papers) * 100) : 0}%
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--text-3)]">Conflicts found</span>
                    <span className="text-[var(--text-1)] tabular-nums">{contradictionCount > 0 ? contradictionCount : "—"}</span>
                  </div>
                </div>
              </div>
            </Link>
          </div>

          {/* Adaptive next-step banner — what should the user do right now? */}
          {(() => {
            const fewPapers = health.papers < 2;
            const noScan = health.papers >= 2 && totalRelationships === 0;
            const ready = health.papers >= 2 && totalRelationships > 0;
            if (fewPapers) {
              return (
                <div className="bg-[var(--surface-2)] border border-[var(--gen-line)] rounded-[var(--r-lg)] p-4 mb-7 fade-up flex items-center gap-4">
                  <span className="text-[11px] font-medium text-[var(--gen)] uppercase tracking-wider shrink-0">Step 1</span>
                  <div className="text-[13px] text-[var(--text-2)] flex-1">
                    Add at least 2 papers to start mapping conflicts and consensus.
                  </div>
                  <Link href="/add-papers" className="flex items-center gap-1.5 px-3.5 py-2 rounded-[var(--r-md)] bg-[var(--gen)] text-white text-[12.5px] font-medium t-all hover:opacity-90 shrink-0">
                    <Plus size={14} /> Add papers
                  </Link>
                </div>
              );
            }
            if (noScan) {
              return (
                <div className="bg-[var(--surface-2)] border border-[var(--gen-line)] rounded-[var(--r-lg)] p-4 mb-7 fade-up flex items-center gap-4">
                  <span className="text-[11px] font-medium text-[var(--gen)] uppercase tracking-wider shrink-0">Next</span>
                  <div className="text-[13px] text-[var(--text-2)] flex-1">
                    Run your first contradiction scan to surface conflicts and consensus across {health.papers} papers.
                  </div>
                  <Link href="/contradictions" className="flex items-center gap-1.5 px-3.5 py-2 rounded-[var(--r-md)] bg-[var(--gen)] text-white text-[12.5px] font-medium t-all hover:opacity-90 shrink-0">
                    <Zap size={14} /> Run scan
                  </Link>
                </div>
              );
            }
            if (ready) {
              return (
                <div className="bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-lg)] p-4 mb-7 fade-up flex items-center gap-4">
                  <span className="text-[11px] font-medium text-[var(--support)] uppercase tracking-wider shrink-0">Try next</span>
                  <div className="text-[13px] text-[var(--text-2)] flex-1">
                    Generate hypotheses grounded in the {contradictionCount > 0 ? `${contradictionCount} conflicts` : "relationships"} you've found.
                  </div>
                  <Link href="/hypotheses" className="flex items-center gap-1.5 px-3.5 py-2 rounded-[var(--r-md)] border border-[var(--line-2)] bg-[var(--surface-1)] text-[var(--text-1)] text-[12.5px] font-medium t-all hover:border-[var(--gen-line)] hover:text-[var(--gen)] shrink-0">
                    Generate hypotheses <ArrowRight size={13} />
                  </Link>
                </div>
              );
            }
            return null;
          })()}

          <div className="flex items-center justify-between mb-3.5">
            <h2 className="font-display text-[19px] text-[var(--text-1)]">Recent papers</h2>
            <Link href="/library" className="flex items-center gap-1 text-[13px] text-[var(--gen)] font-medium hover:gap-1.5 t-all">
              View all <ArrowRight size={13} />
            </Link>
          </div>

          {loading ? (
            <div className="space-y-2.5">{[1, 2, 3].map((i) => <SkeletonCard key={i} />)}</div>
          ) : papers.length === 0 ? (
            <EmptyState icon={<BookOpen size={20} />} title="No papers yet" hint="Upload a paper or import from arXiv to get started" />
          ) : (
            <div className="space-y-2.5">
              {papers.slice(0, 4).map((p, i) => (
                <Link key={p.id} href={`/paper/${p.id}`} className="block group">
                  <div className="bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-lg)] flex overflow-hidden t-all group-hover:border-[var(--line-2)] group-hover:bg-[var(--surface-3)]">
                    <div className="w-[3px] shrink-0" style={{ background: ["var(--support)", "var(--gen)", "var(--nuance)", "#5B9BE0"][i % 4] }} />
                    <div className="p-4 pl-[18px] flex-1 min-w-0">
                      <div className="text-[15px] font-medium text-[var(--text-1)] leading-[1.35] mb-1.5 clamp-1 group-hover:text-white t-all">{p.title}</div>
                      <div className="text-[12.5px] text-[var(--text-3)]">
                        {(p.authors || []).slice(0, 3).join(", ")} · {p.year || "?"} · {(p.analysis_types?.length || 0)}/6 analyses
                      </div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
