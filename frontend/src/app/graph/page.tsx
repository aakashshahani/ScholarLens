"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { api, Paper, GraphPayload, GraphNode, GraphEdge } from "@/lib/api";
import { PageHeader, EmptyState, Spinner, PrimaryButton, REL } from "@/components/ui";
import { Network, AlertCircle, Info, Zap, Download, Search } from "lucide-react";
import { cache } from "@/lib/cache";
import Link from "next/link";

const W = 820, H = 560;

const PAPER_PALETTE = [
  "#7C6FFF", "#3DD4A0", "#F5A623", "#FF5C5C",
  "#5B9BE0", "#D86FB0", "#4ECDC4", "#FFE66D", "#A8E6CF", "#FF8B94",
];

function paperColor(paperId: string, data: GraphPayload | null): string {
  if (!data) return PAPER_PALETTE[0];
  const idx = data.papers.findIndex((p) => p.id === paperId);
  return PAPER_PALETTE[Math.max(0, idx) % PAPER_PALETTE.length];
}

function nodeR(degree: number, emphasized: boolean): number {
  const base = 12 + Math.min(degree, 6) * 1.6;
  return emphasized ? base + 3 : base;
}

function centralityLabel(node: GraphNode, data: GraphPayload): string {
  const rank = [...data.nodes].sort((a, b) => b.degree - a.degree)
    .findIndex((n) => n.id === node.id) + 1;
  if (rank === 1) return "Most connected claim";
  if (rank <= 3) return `#${rank} most connected`;
  return `${node.degree} connection${node.degree !== 1 ? "s" : ""}`;
}

interface Sim { id: string; x: number; y: number; vx: number; vy: number; node: GraphNode; }

export default function GraphPage() {
  const [papers, setPapers]   = useState<Paper[]>([]);
  const [data, setData]       = useState<GraphPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");
  const [sel, setSel]         = useState<GraphNode | null>(null);
  const [hovered, setHovered] = useState<Sim | null>(null);
  const [active, setActive]   = useState<Record<string, boolean>>({
    contradiction: true, support: true, nuance: true,
  });
  const [sims, setSims]       = useState<Sim[]>([]);
  const [search, setSearch]   = useState("");
  const rafRef                = useRef<number>(0);
  const simsRef               = useRef<Sim[]>([]);
  const svgRef                = useRef<SVGSVGElement>(null);

  useEffect(() => {
    // Cache-first for papers list
    const cachedPapers = cache.read<Paper[]>("papers");
    if (cachedPapers?.length) setPapers(cachedPapers);
    api.listPapers(50).then((p) => { setPapers(p); cache.write("papers", p); });
    const cached = cache.read<GraphPayload>("graph");
    if (cached?.nodes?.length) {
      setData(cached); seedPositions(cached);
    } else {
      // No cache — fetch persisted relationships from DB (zero LLM calls).
      // Users should never see an empty graph when data exists in SQLite.
      setLoading(true);
      api.graph({ compute: false })
        .then((g) => { setData(g); cache.write("graph", g); seedPositions(g); })
        .catch(() => {})
        .finally(() => setLoading(false));
    }
  }, []);

  const seedPositions = (g: GraphPayload) => {
    const connectedIds = new Set(g.edges.flatMap((e) => [e.source, e.target]));
    const connected = g.nodes.filter((n) => connectedIds.has(n.id));
    const cx = W / 2, cy = H / 2;
    const r = Math.min(W, H) * 0.34;
    const seeded: Sim[] = connected.map((n, i) => ({
      id: n.id, node: n,
      x: cx + Math.cos((i / Math.max(connected.length, 1)) * Math.PI * 2) * r + (Math.random() - 0.5) * 24,
      y: cy + Math.sin((i / Math.max(connected.length, 1)) * Math.PI * 2) * r + (Math.random() - 0.5) * 24,
      vx: 0, vy: 0,
    }));
    simsRef.current = seeded; setSims(seeded);
  };

  // Read-only: pulls from persisted relationships table, zero LLM calls,
  // never moves the watermark so it won't invalidate the hypothesis cache.
  const run = async () => {
    setLoading(true); setSel(null); setHovered(null); setError("");
    try {
      const g = await api.graph({ compute: false });
      setData(g); cache.write("graph", g); seedPositions(g);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  // Deliberate expansion: judges new pairs, writes through, costs credits.
  // Gated behind a confirm so it can't fire by accident.
  const expand = async () => {
    const ok = window.confirm(
      "Expand the relationship set?\n\nThis runs the contradiction pipeline on new claim pairs — it uses API credits and will refresh your hypotheses. Use this only when you've added papers or want deeper coverage."
    );
    if (!ok) return;
    setLoading(true); setSel(null); setHovered(null); setError("");
    try {
      const g = await api.graph({ similarityThreshold: 0.40, maxPairs: 120, compute: true });
      setData(g); cache.write("graph", g); seedPositions(g);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const exportPNG = () => {
    const svg = svgRef.current;
    if (!svg) return;

    // Walk every live SVG element, read its browser-computed fill/stroke
    // (which resolves CSS custom properties), then inline those values into
    // a detached clone so the serialized SVG is self-contained.
    const clone = svg.cloneNode(true) as SVGSVGElement;
    const origEls  = [svg,   ...Array.from(svg.querySelectorAll("*"))];
    const cloneEls = [clone, ...Array.from(clone.querySelectorAll("*"))];
    origEls.forEach((orig, i) => {
      const cs  = getComputedStyle(orig);
      const cel = cloneEls[i] as SVGElement;
      for (const prop of ["fill", "stroke", "opacity", "fill-opacity", "stroke-opacity", "stroke-width"]) {
        const val = cs.getPropertyValue(prop);
        if (val && val !== "none" && val !== "") cel.setAttribute(prop, val);
      }
      cel.removeAttribute("class"); // animations won't work in a standalone blob
    });

    const bg = getComputedStyle(document.documentElement).getPropertyValue("--surface-1").trim() || "#14141f";
    const svgStr = new XMLSerializer().serializeToString(clone);

    const canvas = document.createElement("canvas");
    const scale = 2;
    canvas.width = W * scale; canvas.height = H * scale;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(scale, scale);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    const blob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
    const url  = URL.createObjectURL(blob);
    const img  = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, W, H);
      URL.revokeObjectURL(url);
      const a = document.createElement("a");
      a.download = "knowledge-graph.png";
      a.href = canvas.toDataURL("image/png");
      a.click();
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  };

  const tick = useCallback(() => {
    const nodes = simsRef.current;
    if (!data || !nodes.length) return;
    const cx = W / 2, cy = H / 2;

    // Centering
    for (const n of nodes) {
      n.vx += (cx - n.x) * 0.016;
      n.vy += (cy - n.y) * 0.016;
    }

    // Repulsion
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        const d = Math.hypot(dx, dy) || 1;
        const rep = 1700 / (d * d); dx /= d; dy /= d;
        a.vx += dx * rep; a.vy += dy * rep;
        b.vx -= dx * rep; b.vy -= dy * rep;
      }
    }

    // Springs
    for (const e of data.edges) {
      const a = nodes.find((n) => n.id === e.source);
      const b = nodes.find((n) => n.id === e.target);
      if (!a || !b) continue;
      let dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const f = (d - 110) * 0.010; dx /= d; dy /= d;
      a.vx += dx * f; a.vy += dy * f;
      b.vx -= dx * f; b.vy -= dy * f;
    }

    const pad = 30;
    for (const n of nodes) {
      n.vx *= 0.80; n.vy *= 0.80;
      n.x += n.vx; n.y += n.vy;
      n.x = Math.max(pad, Math.min(W - pad, n.x));
      n.y = Math.max(pad, Math.min(H - pad, n.y));
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
    ? new Set(data.edges
        .filter((e) => e.source === sel.id || e.target === sel.id)
        .flatMap((e) => [e.source, e.target]))
    : null;

  const otherNode = (e: GraphEdge, selfId: string) =>
    data?.nodes.find((n) => n.id === (e.source === selfId ? e.target : e.source));

  const coveredCount = data ? new Set(data.nodes.map((n) => n.paper_id)).size : 0;

  return (
    <div>
      <PageHeader
        title="Knowledge graph"
        subtitle="Every extracted claim is a node. Every detected relationship is an edge. Node size reflects how connected a claim is across your library."
        action={data && (
          <div className="flex items-center gap-2">
            <button onClick={exportPNG}
              className="flex items-center gap-1.5 px-3 py-2 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-2)] text-[12.5px] text-[var(--text-2)] t-all hover:border-[var(--line-2)] hover:text-[var(--text-1)]">
              <Download size={14} /> Export PNG
            </button>
            <button onClick={run} disabled={loading}
              className="flex items-center gap-1.5 px-3 py-2 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-2)] text-[12.5px] text-[var(--text-2)] t-all hover:border-[var(--line-2)] hover:text-[var(--text-1)] disabled:opacity-40">
              <Network size={14} /> Refresh
            </button>
            <PrimaryButton onClick={expand} full={false} disabled={loading}>
              <Zap size={15} /> Expand
            </PrimaryButton>
          </div>
        )}
      />

      {papers.length < 2 ? (
        <EmptyState icon={<Network size={20} />} title="Need at least 2 papers"
          hint="Add papers to build the knowledge graph." />

      ) : !data ? (
        <div className="fade-up">
          <div className="bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-lg)] p-6">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-[var(--r-lg)] bg-[var(--gen-dim)] flex items-center justify-center shrink-0">
                <Network size={18} className="text-[var(--gen)]" />
              </div>
              <div className="flex-1">
                <div className="text-[15px] font-medium text-[var(--text-1)] mb-1">Build the knowledge graph</div>
                <div className="text-[13px] text-[var(--text-2)] mb-3 leading-[1.6]">
                  Visualises every claim from your {papers.length} papers as a node, with edges showing where claims support, nuance, or contradict each other. Reads from your existing contradiction scan — no extra API cost.
                </div>
                <div className="flex items-center gap-2 text-[12px] text-[var(--nuance)] mb-4">
                  <Info size={13} />
                  Run a contradiction scan first if you haven&apos;t — the graph reads from those results.
                </div>
                <PrimaryButton onClick={run} disabled={loading} full={false}>
                  {loading ? <Spinner /> : <><Network size={15} /> Build graph</>}
                </PrimaryButton>
              </div>
            </div>
          </div>
        </div>

      ) : (
        <div className="grid grid-cols-[1fr_300px] gap-4 fade-up">

          {/* ── Graph canvas ── */}
          <div className="bg-[var(--surface-1)] border border-[var(--line)] rounded-[var(--r-lg)] overflow-hidden relative">

            {/* Node search */}
            <div className="absolute top-3 right-3 z-10">
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[var(--r-md)] bg-[var(--surface-2)] border border-[var(--line)] focus-within:border-[var(--gen-line)] t-all">
                <Search size={11} className="text-[var(--text-4)] shrink-0" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search nodes…"
                  className="bg-transparent text-[11.5px] text-[var(--text-1)] placeholder-[var(--text-4)] outline-none w-[130px]"
                />
              </div>
            </div>

            {/* Relationship filter chips */}
            <div className="absolute top-3 left-3 z-10 flex gap-1.5">
              {(["contradiction", "support", "nuance"] as const).map((t) => (
                <button key={t}
                  onClick={() => setActive((a) => ({ ...a, [t]: !a[t] }))}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] border t-all ${active[t] ? "" : "opacity-30"}`}
                  style={{ background: REL[t].dim, color: REL[t].c, borderColor: REL[t].line }}>
                  <span className="w-[4px] h-[4px] rounded-full" style={{ background: REL[t].c }} />
                  {t}
                </button>
              ))}
            </div>

            {error && (
              <div className="absolute top-12 left-3 right-3 z-10 bg-[var(--contra-dim)] border border-[var(--contra-line)] rounded-[var(--r-md)] px-3 py-2 flex items-center gap-2">
                <AlertCircle size={13} className="text-[var(--contra)] shrink-0" />
                <span className="text-[12px] text-[var(--contra)]">{error}</span>
              </div>
            )}

            {/* Hover tooltip */}
            {hovered && (() => {
              const px = hovered.x / W, py = hovered.y / H;
              const flipX = px > 0.60, flipY = py > 0.72;
              return (
                <div className="absolute z-20 pointer-events-none"
                  style={{
                    left: `${px * 100}%`, top: `${py * 100}%`,
                    transform: `translate(${flipX ? "calc(-100% - 14px)" : "14px"}, ${flipY ? "-100%" : "-50%"})`,
                  }}>
                  <div className="bg-[var(--surface-3)] border border-[var(--line-2)] rounded-[var(--r-md)] p-3 shadow-xl w-[220px]">
                    <div className="text-[9.5px] font-medium text-[var(--text-4)] uppercase tracking-wider mb-1.5 truncate">
                      {hovered.node.paper_title}
                    </div>
                    <div className="text-[11.5px] text-[var(--text-1)] leading-snug line-clamp-4">
                      {hovered.node.claim}
                    </div>
                    <div className="text-[9.5px] text-[var(--text-4)] mt-2">
                      {hovered.node.degree} connection{hovered.node.degree !== 1 ? "s" : ""}
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* SVG graph */}
            <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }}>
              {/* Edges */}
              {data.edges.filter((e) => active[e.relationship]).map((e, i) => {
                const a = pos(e.source), b = pos(e.target);
                if (!a || !b) return null;
                const dim = neighbors && !(neighbors.has(e.source) && neighbors.has(e.target));
                const w = e.relationship === "contradiction" ? 2 : e.relationship === "support" ? 1.5 : 1;
                return (
                  <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                    stroke={REL[e.relationship].c}
                    strokeWidth={w}
                    strokeOpacity={dim ? 0.04 : neighbors ? 0.75 : 0.28}
                    className={e.relationship === "contradiction" && !dim ? "charged" : ""}
                  />
                );
              })}

              {/* Nodes */}
              {(() => {
                const q = search.trim().toLowerCase();
                const hasQ = q.length > 0;
                return sims.map((s) => {
                  const dim     = neighbors && !neighbors.has(s.id);
                  const isSel   = sel?.id === s.id;
                  const isHov   = hovered?.id === s.id;
                  const isMatch = hasQ && (
                    s.node.claim.toLowerCase().includes(q) ||
                    s.node.paper_title.toLowerCase().includes(q)
                  );
                  const dimBySearch = hasQ && !isMatch;
                  const r       = nodeR(s.node.degree, isSel || isHov || isMatch);
                  const pColor  = paperColor(s.node.paper_id, data);
                  return (
                    <g key={s.id}
                      onClick={() => setSel(isSel ? null : s.node)}
                      onMouseEnter={() => setHovered(s)}
                      onMouseLeave={() => setHovered(null)}
                      style={{ cursor: "pointer", opacity: (dim || dimBySearch) ? 0.10 : 1 }}
                      className="t-all">
                      {/* Search highlight ring */}
                      {isMatch && (
                        <circle cx={s.x} cy={s.y} r={r + 7} fill="none"
                          stroke="var(--gen)" strokeWidth={1.5} strokeOpacity={0.55}
                          strokeDasharray="3 2" />
                      )}
                      {/* Paper colour ring */}
                      <circle cx={s.x} cy={s.y} r={r + 3} fill="none"
                        stroke={pColor} strokeWidth={1.8}
                        strokeOpacity={isSel ? 1 : isHov ? 0.8 : 0.45} />
                      {/* Node body */}
                      <circle cx={s.x} cy={s.y} r={r}
                        fill="var(--surface-3)"
                        stroke={isSel ? "var(--gen)" : "var(--line-3)"}
                        strokeWidth={isSel ? 2 : 1} />
                      {/* Centre dot */}
                      <circle cx={s.x} cy={s.y} r={isSel ? 5 : 3.5}
                        fill={isSel ? "var(--gen)" : pColor}
                        fillOpacity={0.9} />
                    </g>
                  );
                });
              })()}
            </svg>

            {/* Footer legend */}
            <div className="border-t border-[var(--line)] px-3.5 py-2.5 flex flex-wrap gap-x-4 gap-y-1.5 items-center">
              {data.papers.slice(0, 8).map((p, i) => (
                <div key={p.id} className="flex items-center gap-1.5 min-w-0">
                  <span className="w-[8px] h-[8px] rounded-full shrink-0"
                    style={{ background: PAPER_PALETTE[i % PAPER_PALETTE.length] }} />
                  <span className="text-[11px] text-[var(--text-2)] truncate max-w-[140px]">
                    {p.title.length > 32 ? p.title.slice(0, 32) + "…" : p.title}
                  </span>
                </div>
              ))}
              {data.papers.length > 8 && (
                <span className="text-[11px] text-[var(--text-4)]">+{data.papers.length - 8} more</span>
              )}
              <span className="ml-auto text-[10.5px] text-[var(--text-4)] mono shrink-0">
                {coveredCount}/{papers.length} papers · {data.nodes.length} claims · {data.edges.length} links
              </span>
            </div>
          </div>

          {/* ── Inspector rail ── */}
          <div className="sticky top-6 self-start space-y-3">
            {sel ? (
              <div className="bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-lg)] p-4 fade-up">
                {/* Centrality badge */}
                <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[var(--gen-dim)] text-[var(--gen)] text-[10.5px] font-medium mb-3">
                  <span className="w-[3px] h-[3px] rounded-full bg-[var(--gen)]" />
                  {centralityLabel(sel, data)}
                </div>

                <div className="text-[10px] font-medium text-[var(--text-4)] uppercase tracking-wider mb-1.5">Claim</div>
                <p className="text-[12.5px] text-[var(--text-1)] leading-[1.65] mb-3">{sel.claim}</p>

                {/* Paper attribution */}
                <div className="flex items-center gap-2 py-2.5 border-t border-b border-[var(--line)] mb-3">
                  <span className="w-[7px] h-[7px] rounded-full shrink-0"
                    style={{ background: paperColor(sel.paper_id, data) }} />
                  <div className="min-w-0">
                    <div className="text-[11.5px] text-[var(--text-1)] font-medium clamp-1">{sel.paper_title}</div>
                    <div className="text-[10px] text-[var(--text-3)]">{sel.section} · {sel.confidence} confidence</div>
                  </div>
                </div>

                {/* Connections */}
                {(() => {
                  const conns = data.edges
                    .filter((e) => (e.source === sel.id || e.target === sel.id) && e.relationship !== "unrelated")
                    .sort((a, b) => b.similarity - a.similarity)
                    .slice(0, 6);
                  if (!conns.length)
                    return <p className="text-[12px] text-[var(--text-3)]">No detected relationships for this claim.</p>;
                  return (
                    <>
                      <div className="text-[10px] font-medium text-[var(--text-4)] uppercase tracking-wider mb-2">
                        Connections ({conns.length})
                      </div>
                      <div className="space-y-1.5">
                        {conns.map((e, i) => {
                          const other = otherNode(e, sel.id);
                          const rk = e.relationship as keyof typeof REL;
                          return (
                            <div key={i}
                              className="p-2.5 rounded-[var(--r-md)] bg-[var(--surface-1)] border border-[var(--line)] cursor-pointer hover:border-[var(--line-2)] t-all"
                              onClick={() => { if (other) setSel(other); }}>
                              <div className="flex items-center gap-1.5 mb-1">
                                <span className="w-[5px] h-[5px] rounded-full shrink-0"
                                  style={{ background: REL[rk].c }} />
                                <span className="text-[10.5px] font-medium capitalize"
                                  style={{ color: REL[rk].c }}>{e.relationship}</span>
                                <span className="mono text-[9.5px] text-[var(--text-4)] ml-auto">
                                  {e.similarity.toFixed(2)}
                                </span>
                              </div>
                              {other && (
                                <div className="text-[10.5px] text-[var(--text-3)] clamp-1">{other.paper_title}</div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </>
                  );
                })()}
              </div>
            ) : (
              <div className="bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-lg)] p-4">
                <p className="text-[13px] text-[var(--text-3)] text-center py-4">
                  Click any node to inspect its claim and connections.
                </p>
                <p className="text-[11px] text-[var(--text-4)] text-center">
                  Larger node = more connections · Colour ring = paper
                </p>
              </div>
            )}

            {/* About card */}
            <div className="bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-lg)] p-4">
              <div className="text-[10px] font-medium text-[var(--text-4)] uppercase tracking-wider mb-2">How it works</div>
              <div className="text-[11.5px] text-[var(--text-2)] leading-[1.65]">
                Each node is a claim extracted from a paper. Edges are relationships detected by the contradiction pipeline — support, nuance, or contradiction. Node size reflects how many relationships a claim participates in across the whole library.
              </div>
              <Link href="/contradictions"
                className="mt-3 flex items-center gap-1.5 text-[11.5px] text-[var(--gen)] font-medium hover:gap-2 t-all">
                View contradiction scan →
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
