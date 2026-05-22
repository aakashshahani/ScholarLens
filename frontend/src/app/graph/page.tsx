"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { api, Paper, GraphPayload, GraphNode, GraphEdge } from "@/lib/api";
import { PageHeader, Card, EmptyState, Spinner, SelectChip, PrimaryButton, Claim, REL } from "@/components/ui";
import { Network, Filter } from "lucide-react";

interface Sim { id: string; x: number; y: number; vx: number; vy: number; node: GraphNode; }

export default function GraphPage() {
  const [papers, setPapers] = useState<Paper[]>([]);
  const [data, setData] = useState<GraphPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<GraphNode | null>(null);
  const [active, setActive] = useState<Record<string, boolean>>({ contradiction: true, support: true, nuance: true, unrelated: false });
  const [sims, setSims] = useState<Sim[]>([]);
  const rafRef = useRef<number>(0);
  const simsRef = useRef<Sim[]>([]);
  const W = 760, H = 520;

  useEffect(() => { api.listPapers(50).then(setPapers); }, []);

  const run = async () => {
    setLoading(true); setSel(null);
    try {
      const g = await api.graph({ similarityThreshold: 0.45, maxPairs: 40 });
      setData(g);
      // seed positions
      const seeded: Sim[] = g.nodes.map((n, i) => ({
        id: n.id, node: n,
        x: W / 2 + Math.cos((i / g.nodes.length) * Math.PI * 2) * 160 + (Math.random() - 0.5) * 40,
        y: H / 2 + Math.sin((i / g.nodes.length) * Math.PI * 2) * 160 + (Math.random() - 0.5) * 40,
        vx: 0, vy: 0,
      }));
      simsRef.current = seeded; setSims(seeded);
    } catch (e: any) { alert(e.message); }
    setLoading(false);
  };

  // simple force sim
  const tick = useCallback(() => {
    const nodes = simsRef.current;
    if (!data || nodes.length === 0) return;
    const k = 0.0025;
    for (const n of nodes) {
      n.vx += (W / 2 - n.x) * k; n.vy += (H / 2 - n.y) * k;
    }
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      let dx = a.x - b.x, dy = a.y - b.y; let d = Math.hypot(dx, dy) || 1;
      const rep = 900 / (d * d);
      dx /= d; dy /= d; a.vx += dx * rep; a.vy += dy * rep; b.vx -= dx * rep; b.vy -= dy * rep;
    }
    for (const e of data.edges) {
      const a = nodes.find((n) => n.id === e.source), b = nodes.find((n) => n.id === e.target);
      if (!a || !b) continue;
      let dx = b.x - a.x, dy = b.y - a.y; const d = Math.hypot(dx, dy) || 1;
      const target = 120, f = (d - target) * 0.008;
      dx /= d; dy /= d; a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
    }
    for (const n of nodes) {
      n.vx *= 0.82; n.vy *= 0.82; n.x += n.vx; n.y += n.vy;
      n.x = Math.max(20, Math.min(W - 20, n.x)); n.y = Math.max(20, Math.min(H - 20, n.y));
    }
    setSims([...nodes]);
    rafRef.current = requestAnimationFrame(tick);
  }, [data]);

  useEffect(() => {
    if (data && sims.length) { rafRef.current = requestAnimationFrame(tick); return () => cancelAnimationFrame(rafRef.current); }
  }, [data, tick]);

  const pos = (id: string) => sims.find((s) => s.id === id);
  const neighbors = sel && data ? new Set(data.edges.filter((e) => e.source === sel.id || e.target === sel.id).flatMap((e) => [e.source, e.target])) : null;

  return (
    <div>
      <PageHeader title="Knowledge field" subtitle="Every claim a node. Every line a relationship. Clusters are your research frontiers."
        action={data && <PrimaryButton onClick={run} full={false}><Network size={15} /> Recompute</PrimaryButton>} />

      {papers.length < 2 ? <EmptyState icon={<Network size={20} />} title="Need at least 2 papers" hint="Add papers to map the field" /> :
       !data ? (
        <EmptyState icon={<Network size={20} />} title="Map your knowledge field"
          hint="Build a force-directed graph of claims and how they relate"
          action={<PrimaryButton onClick={run} disabled={loading} full={false}>{loading ? <Spinner /> : <><Network size={15} /> Build graph</>}</PrimaryButton>} />
      ) : (
        <div className="grid grid-cols-[1fr_320px] gap-4 fade-up">
          {/* Canvas */}
          <div className="bg-[var(--surface-1)] border border-[var(--line)] rounded-[var(--r-lg)] overflow-hidden relative">
            {/* filter chips */}
            <div className="absolute top-3 left-3 z-10 flex gap-1.5">
              {(["contradiction", "support", "nuance"] as const).map((t) => (
                <button key={t} onClick={() => setActive((a) => ({ ...a, [t]: !a[t] }))}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] border t-all ${active[t] ? "" : "opacity-40"}`}
                  style={{ background: REL[t].dim, color: REL[t].c, borderColor: REL[t].line }}>
                  <span className="w-[5px] h-[5px] rounded-full" style={{ background: REL[t].c }} />{t}
                </button>
              ))}
            </div>
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 520 }}>
              {/* edges */}
              {data.edges.filter((e) => active[e.relationship]).map((e, i) => {
                const a = pos(e.source), b = pos(e.target); if (!a || !b) return null;
                const dim = sel && !(e.source === sel.id || e.target === sel.id);
                const charged = e.relationship === "contradiction";
                return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={REL[e.relationship].c}
                  strokeWidth={charged ? 1.8 : 1.2} strokeOpacity={dim ? 0.05 : 0.4} className={charged && !dim ? "charged" : ""} />;
              })}
              {/* nodes */}
              {sims.map((s) => {
                const dim = neighbors && !neighbors.has(s.id);
                const isSel = sel?.id === s.id;
                return (
                  <g key={s.id} onClick={() => setSel(s.node)} style={{ cursor: "pointer", opacity: dim ? 0.25 : 1 }} className="t-all">
                    <circle cx={s.x} cy={s.y} r={isSel ? 8 : 5 + Math.min(s.node.degree, 4)} fill="var(--surface-3)" stroke={isSel ? "var(--gen)" : "var(--line-3)"} strokeWidth={isSel ? 2 : 1} />
                    <circle cx={s.x} cy={s.y} r="2.5" fill={isSel ? "var(--gen)" : "var(--text-2)"} />
                  </g>
                );
              })}
            </svg>
            <div className="absolute bottom-3 left-3 text-[10px] text-[var(--text-4)] uppercase tracking-wider">{data.nodes.length} claims · {data.edges.length} relationships</div>
          </div>

          {/* Detail rail */}
          <div className="sticky top-6 self-start">
            {sel ? (
              <Card className="fade-up">
                <div className="text-[11px] font-medium text-[var(--text-3)] uppercase tracking-wider mb-2">Claim</div>
                <Claim className="block mb-4">{sel.claim}</Claim>
                <div className="text-[11px] font-medium text-[var(--text-3)] uppercase tracking-wider mb-1.5">From</div>
                <div className="text-[12.5px] text-[var(--text-1)] mb-1 clamp-2">{sel.paper_title}</div>
                <div className="text-[11px] text-[var(--text-3)] mb-4">{sel.section} · confidence {sel.confidence}</div>
                <div className="text-[11px] font-medium text-[var(--text-3)] uppercase tracking-wider mb-2">Connections ({data.edges.filter((e) => e.source === sel.id || e.target === sel.id).length})</div>
                <div className="space-y-1.5">
                  {data.edges.filter((e) => e.source === sel.id || e.target === sel.id).slice(0, 5).map((e, i) => (
                    <div key={i} className="flex items-center gap-2 text-[12px]"><span className="w-[6px] h-[6px] rounded-full shrink-0" style={{ background: REL[e.relationship].c }} /><span className="text-[var(--text-2)] capitalize">{e.relationship}</span></div>
                  ))}
                </div>
              </Card>
            ) : <Card><div className="text-[13px] text-[var(--text-3)] text-center py-8">Click a node to inspect its claim and connections.</div></Card>}
          </div>
        </div>
      )}
    </div>
  );
}
