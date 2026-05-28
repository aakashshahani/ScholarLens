"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { api, Paper, GraphPayload, GraphNode } from "@/lib/api";
import { PageHeader, Card, EmptyState, Spinner, PrimaryButton, Claim, REL } from "@/components/ui";
import { Network, AlertCircle, Info } from "lucide-react";
import { cache } from "@/lib/cache";

interface Sim { id: string; x: number; y: number; vx: number; vy: number; node: GraphNode; }
const W = 760, H = 520;

export default function GraphPage() {
  const [papers, setPapers] = useState<Paper[]>([]);
  const [data, setData] = useState<GraphPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sel, setSel] = useState<GraphNode | null>(null);
  const [active, setActive] = useState<Record<string, boolean>>({ contradiction: true, support: true, nuance: true, unrelated: false });
  const [sims, setSims] = useState<Sim[]>([]);
  const rafRef = useRef<number>(0);
  const simsRef = useRef<Sim[]>([]);

  useEffect(() => {
    api.listPapers(50).then(setPapers);
    const cached = cache.read<GraphPayload>("graph");
    if (cached && cached.nodes.length > 0) {
      setData(cached);
      seedPositions(cached);
    }
  }, []);

  const seedPositions = (g: GraphPayload) => {
    const connectedIds = new Set(g.edges.flatMap((e) => [e.source, e.target]));
    const connected = g.nodes.filter((n) => connectedIds.has(n.id));
    const seeded: Sim[] = connected.map((n, i) => ({
      id: n.id, node: n,
      x: W / 2 + Math.cos((i / Math.max(connected.length, 1)) * Math.PI * 2) * 160 + (Math.random() - 0.5) * 40,
      y: H / 2 + Math.sin((i / Math.max(connected.length, 1)) * Math.PI * 2) * 160 + (Math.random() - 0.5) * 40,
      vx: 0, vy: 0,
    }));
    simsRef.current = seeded; setSims(seeded);
  };

  const run = async () => {
    setLoading(true); setSel(null); setError("");
    try {
      const g = await api.graph({ similarityThreshold: 0.45, maxPairs: 40 });
      setData(g);
      cache.write("graph", g);
      seedPositions(g);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const tick = useCallback(() => {
    const nodes = simsRef.current;
    if (!data || nodes.length === 0) return;
    for (const n of nodes) { n.vx += (W / 2 - n.x) * 0.0025; n.vy += (H / 2 - n.y) * 0.0025; }
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      let dx = a.x - b.x, dy = a.y - b.y;
      const d = Math.hypot(dx, dy) || 1;
      const rep = 900 / (d * d); dx /= d; dy /= d;
      a.vx += dx * rep; a.vy += dy * rep; b.vx -= dx * rep; b.vy -= dy * rep;
    }
    for (const e of data.edges) {
      const a = nodes.find((n) => n.id === e.source), b = nodes.find((n) => n.id === e.target);
      if (!a || !b) continue;
      let dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const f = (d - 120) * 0.008; dx /= d; dy /= d;
      a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
    }
    for (const n of nodes) {
      n.vx *= 0.82; n.vy *= 0.82; n.x += n.vx; n.y += n.vy;
      n.x = Math.max(20, Math.min(W - 20, n.x)); n.y = Math.max(20, Math.min(H - 20, n.y));
    }
    setSims([...nodes]);
    rafRef.current = requestAnimationFrame(tick);
  }, [data]);

  useEffect(() => {
    if (data && sims.length) {
      rafRef.current = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(rafRef.current);
    }
  }, [data, tick]);

  const pos = (id: string) => sims.find((s) => s.id === id);
  const neighbors = sel && data
    ? new Set(data.edges.filter((e) => e.source === sel.id || e.target === sel.id).flatMap((e) => [e.source, e.target]))
    : null;

  // Only count nodes that have edges — isolated ones are filtered out of the sim
  const connectedCount = data ? new Set(data.edges.flatMap((e) => [e.source, e.target])).size : 0;
  const isolatedCount = data ? data.nodes.length - connectedCount : 0;
  const estimatedPairs = Math.min(40, Math.floor(papers.length * (papers.length - 1) / 2));

  return (
    <div>
      <PageHeader
        title="Knowledge field"
        subtitle="Every claim a node. Every line a relationship."
        action={data && (
          <PrimaryButton onClick={run} full={false} disabled={loading}>
            <Network size={15} /> Recompute
          </PrimaryButton>
        )}
      />

      {papers.length < 2 ? (
        <EmptyState icon={<Network size={20} />} title="Need at least 2 papers" hint="Add papers to map the knowledge field." />
      ) : !data ? (
        <div className="fade-up">
          <div className="bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-lg)] p-6">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-[var(--r-lg)] bg-[var(--gen-dim)] flex items-center justify-center shrink-0">
                <Network size={18} className="text-[var(--gen)]" />
              </div>
              <div className="flex-1">
                <div className="text-[15px] font-medium text-[var(--text-1)] mb-1">Build your knowledge graph</div>
                <div className="text-[13px] text-[var(--text-2)] mb-3 leading-[1.6]">
                  Maps claims from {papers.length} papers into a force-directed graph. Nodes are claims; edges are detected relationships. Only claims that share a relationship appear connected — the graph shows confirmed connections, not exhaustive coverage.
                </div>
                <div className="flex items-center gap-2 text-[12px] text-[var(--nuance)] mb-4">
                  <Info size={13} />
                  Analyzes up to {estimatedPairs} claim pairs · takes 30–90 seconds · uses API credits
                </div>
                <PrimaryButton onClick={run} disabled={loading} full={false}>
                  {loading ? <Spinner /> : <><Network size={15} /> Build graph</>}
                </PrimaryButton>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-[1fr_320px] gap-4 fade-up">
          <div className="bg-[var(--surface-1)] border border-[var(--line)] rounded-[var(--r-lg)] overflow-hidden relative">
            <div className="absolute top-3 left-3 z-10 flex gap-1.5">
              {(["contradiction", "support", "nuance"] as const).map((t) => (
                <button key={t} onClick={() => setActive((a) => ({ ...a, [t]: !a[t] }))}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] border t-all ${active[t] ? "" : "opacity-30"}`}
                  style={{ background: REL[t].dim, color: REL[t].c, borderColor: REL[t].line }}>
                  <span className="w-[5px] h-[5px] rounded-full" style={{ background: REL[t].c }} />{t}
                </button>
              ))}
            </div>

            {error && (
              <div className="absolute top-12 left-3 right-3 z-10 bg-[var(--contra-dim)] border border-[var(--contra-line)] rounded-[var(--r-md)] px-3 py-2 flex items-center gap-2">
                <AlertCircle size={13} className="text-[var(--contra)] shrink-0" />
                <span className="text-[12px] text-[var(--contra)]">{error}</span>
              </div>
            )}

            <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 520 }}>
              {data.edges.filter((e) => active[e.relationship]).map((e, i) => {
                const a = pos(e.source), b = pos(e.target);
                if (!a || !b) return null;
                const dim = sel && !(e.source === sel.id || e.target === sel.id);
                return (
                  <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                    stroke={REL[e.relationship].c}
                    strokeWidth={e.relationship === "contradiction" ? 1.8 : 1.2}
                    strokeOpacity={dim ? 0.04 : 0.4}
                    className={e.relationship === "contradiction" && !dim ? "charged" : ""} />
                );
              })}
              {/* Only render nodes that have edges — isolated nodes hidden */}
              {sims.map((s) => {
                const dim = neighbors && !neighbors.has(s.id);
                const isSel = sel?.id === s.id;
                return (
                  <g key={s.id} onClick={() => setSel(s.node)} style={{ cursor: "pointer", opacity: dim ? 0.15 : 1 }} className="t-all">
                    <circle cx={s.x} cy={s.y}
                      r={isSel ? 8 : 5 + Math.min(s.node.degree, 4)}
                      fill="var(--surface-3)"
                      stroke={isSel ? "var(--gen)" : "var(--line-3)"}
                      strokeWidth={isSel ? 2 : 1} />
                    <circle cx={s.x} cy={s.y} r="2.5" fill={isSel ? "var(--gen)" : "var(--text-2)"} />
                  </g>
                );
              })}
            </svg>

            <div className="absolute bottom-3 left-3 flex items-center gap-3 text-[10px] text-[var(--text-4)] uppercase tracking-wider">
              <span>{connectedCount} connected claims · {data.edges.length} relationships</span>
              {isolatedCount > 0 && <span className="text-[var(--text-4)]">· {isolatedCount} claims with no detected relationships hidden</span>}
            </div>
          </div>

          <div className="sticky top-6 self-start space-y-3">
            {sel ? (
              <Card className="fade-up">
                <div className="text-[11px] font-medium text-[var(--text-3)] uppercase tracking-wider mb-2">Claim</div>
                <Claim className="block mb-4">{sel.claim}</Claim>
                <div className="text-[11px] font-medium text-[var(--text-3)] uppercase tracking-wider mb-1.5">From</div>
                <div className="text-[12.5px] text-[var(--text-1)] mb-0.5 clamp-2">{sel.paper_title}</div>
                <div className="text-[11px] text-[var(--text-3)] mb-4">{sel.section} · confidence {sel.confidence}</div>
                <div className="text-[11px] font-medium text-[var(--text-3)] uppercase tracking-wider mb-2">
                  Connections ({data.edges.filter((e) => e.source === sel.id || e.target === sel.id).length})
                </div>
                <div className="space-y-1.5">
                  {data.edges.filter((e) => e.source === sel.id || e.target === sel.id).slice(0, 6).map((e, i) => (
                    <div key={i} className="flex items-center gap-2 text-[12px]">
                      <span className="w-[6px] h-[6px] rounded-full shrink-0" style={{ background: REL[e.relationship].c }} />
                      <span className="text-[var(--text-2)] capitalize">{e.relationship}</span>
                      <span className="mono text-[10px] text-[var(--text-4)] ml-auto">{e.similarity.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              </Card>
            ) : (
              <Card><div className="text-[13px] text-[var(--text-3)] text-center py-8">Click a node to inspect its claim and connections.</div></Card>
            )}
            <Card>
              <div className="text-[11px] font-medium text-[var(--text-3)] uppercase tracking-wider mb-2">About this graph</div>
              <div className="text-[12px] text-[var(--text-2)] leading-[1.6]">
                Only claims sharing a detected relationship appear as connected nodes. Claims using different vocabulary for the same concept may not be linked — the graph shows confirmed connections, not exhaustive coverage.
              </div>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
