"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, HealthStatus, Paper } from "@/lib/api";
import { PageHeader, MetricCard, Spinner, EmptyState, SkeletonCard, Claim, RelDot } from "@/components/ui";
import { KnowledgePulse } from "@/components/knowledge-pulse";
import { FileStack, CheckCircle2, Boxes, Database, Zap, Radio, ArrowRight, BookOpen } from "lucide-react";

export default function Dashboard() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [papers, setPapers] = useState<Paper[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.health().then(setHealth).catch((e) => setError(e.message));
    api.listPapers(8).then((p) => { setPapers(p); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  const analyzed = papers.filter((p) => (p.analysis_types?.length || 0) >= 6).length;
  const sources = new Set(papers.map((p) => p.source));

  // Synthesize pulse edges from adjacency (placeholder until /api/graph) — deterministic, not random
  const pulseNodes = papers.slice(0, 8).map((p) => ({ id: p.id, label: p.title }));
  const pulseEdges = pulseNodes.length >= 2
    ? pulseNodes.slice(0, -1).map((_, i) => ({
        a: i, b: i + 1,
        type: (["support", "contradiction", "nuance"] as const)[i % 3],
      }))
    : [];

  return (
    <div>
      <PageHeader title="Situation room" subtitle="What changed in your knowledge — and where the tension is." />

      {error ? (
        <div className="bg-[var(--contra-dim)] border border-[var(--contra-line)] rounded-[var(--r-lg)] p-5 mb-6">
          <p className="text-[var(--contra)] text-[13px] font-medium">Backend not reachable: {error}</p>
          <p className="text-[var(--text-2)] text-[12px] mt-1.5">Start it with <code className="mono text-[11px] bg-[var(--surface-3)] px-1.5 py-0.5 rounded">uvicorn api:app --reload --port 8000</code></p>
        </div>
      ) : !health ? (
        <Spinner label="Connecting to backend…" />
      ) : (
        <>
          {/* Knowledge pulse band */}
          <div className="mb-6 fade-up">
            <KnowledgePulse nodes={pulseNodes} edges={pulseEdges} />
          </div>

          {/* Metrics */}
          <div className="grid grid-cols-4 gap-3 mb-7 fade-up">
            <MetricCard value={health.papers} label="Papers" color="var(--gen)" icon={<FileStack size={18} />} />
            <MetricCard value={analyzed} label="Fully analyzed" color="var(--support)" barPercent={health.papers > 0 ? (analyzed / health.papers) * 100 : 0} icon={<CheckCircle2 size={18} />} />
            <MetricCard value={health.embeddings} label="Claim chunks" color="#5B9BE0" icon={<Boxes size={18} />} />
            <MetricCard value={sources.size} label="Sources" color="var(--nuance)" icon={<Database size={18} />} />
          </div>

          {/* Three-column situation grid */}
          <div className="grid grid-cols-3 gap-3 mb-8">
            {/* Active contradictions */}
            <Link href="/contradictions" className="group">
              <div className="h-full bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-lg)] p-5 t-all lift">
                <div className="flex items-center gap-2 mb-3">
                  <Zap size={15} className="text-[var(--contra)]" />
                  <span className="text-[13px] font-medium text-[var(--text-1)]">Active contradictions</span>
                  <ArrowRight size={13} className="ml-auto text-[var(--text-4)] group-hover:text-[var(--text-2)] group-hover:translate-x-0.5 t-all" />
                </div>
                <div className="font-display text-[32px] text-[var(--contra)] leading-none mb-1">—</div>
                <div className="text-[12px] text-[var(--text-3)]">Run a scan to surface conflicts across papers.</div>
              </div>
            </Link>

            {/* Newest insights */}
            <Link href="/feed" className="group">
              <div className="h-full bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-lg)] p-5 t-all lift">
                <div className="flex items-center gap-2 mb-3">
                  <Radio size={15} className="text-[var(--gen)]" />
                  <span className="text-[13px] font-medium text-[var(--text-1)]">Research wire</span>
                  <ArrowRight size={13} className="ml-auto text-[var(--text-4)] group-hover:text-[var(--text-2)] group-hover:translate-x-0.5 t-all" />
                </div>
                <div className="text-[12px] text-[var(--text-3)] leading-[1.6]">Machine-generated insights from your library appear here.</div>
              </div>
            </Link>

            {/* Library health */}
            <Link href="/library" className="group">
              <div className="h-full bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-lg)] p-5 t-all lift">
                <div className="flex items-center gap-2 mb-3">
                  <BookOpen size={15} className="text-[var(--support)]" />
                  <span className="text-[13px] font-medium text-[var(--text-1)]">Library health</span>
                  <ArrowRight size={13} className="ml-auto text-[var(--text-4)] group-hover:text-[var(--text-2)] group-hover:translate-x-0.5 t-all" />
                </div>
                <div className="space-y-1.5 text-[12px]">
                  <div className="flex justify-between"><span className="text-[var(--text-3)]">Coverage</span><span className="text-[var(--text-1)] tabular-nums">{health.papers > 0 ? Math.round((analyzed / health.papers) * 100) : 0}%</span></div>
                  <div className="flex justify-between"><span className="text-[var(--text-3)]">Sources</span><span className="text-[var(--text-1)] tabular-nums">{sources.size}</span></div>
                  <div className="flex justify-between"><span className="text-[var(--text-3)]">Chunks</span><span className="text-[var(--text-1)] tabular-nums">{health.embeddings}</span></div>
                </div>
              </div>
            </Link>
          </div>

          {/* Recent papers */}
          <div className="flex items-center justify-between mb-3.5">
            <h2 className="font-display text-[19px] text-[var(--text-1)]">Recent papers</h2>
            <Link href="/library" className="flex items-center gap-1 text-[13px] text-[var(--gen)] font-medium hover:gap-1.5 t-all">View all <ArrowRight size={13} /></Link>
          </div>
          {loading ? (
            <div className="space-y-2.5">{[1,2,3].map((i) => <SkeletonCard key={i} />)}</div>
          ) : papers.length === 0 ? (
            <EmptyState icon={<BookOpen size={20} />} title="No papers yet" hint="Upload a paper or import from arXiv to get started" />
          ) : (
            <div className="space-y-2.5">
              {papers.slice(0, 4).map((p, i) => (
                <Link key={p.id} href={`/paper/${p.id}`} className="block group">
                  <div className="bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-lg)] flex overflow-hidden t-all group-hover:border-[var(--line-2)] group-hover:bg-[var(--surface-3)]">
                    <div className="w-[3px] shrink-0" style={{ background: ["var(--support)","var(--gen)","var(--nuance)","#5B9BE0"][i % 4] }} />
                    <div className="p-4 pl-[18px] flex-1 min-w-0">
                      <div className="text-[15px] font-medium text-[var(--text-1)] leading-[1.35] mb-1.5 clamp-1 group-hover:text-white t-all">{p.title}</div>
                      <div className="text-[12.5px] text-[var(--text-3)]">{(p.authors || []).slice(0,3).join(", ")} · {p.year || "?"} · {(p.analysis_types?.length || 0)}/6 analyses</div>
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
