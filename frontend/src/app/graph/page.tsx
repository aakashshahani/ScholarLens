"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { api, Paper, GraphPayload, GraphNode, GraphEdge, DebateCluster } from "@/lib/api";
import { Spinner, REL } from "@/components/ui";
import {
  Network, Zap, Download, Search, Layers,
  GitBranch, BookOpen, Plus, Minus, Maximize2,
} from "lucide-react";
import { cache } from "@/lib/cache";
import Link from "next/link";

// ── Palette & helpers ────────────────────────────────────────
const PALETTE = [
  "#7C6FFF", "#3DD4A0", "#F5A623", "#FF5C5C",
  "#5B9BE0", "#D86FB0", "#4ECDC4", "#FFE66D", "#A8E6CF", "#FF8B94",
];

function pColor(paperId: string, data: GraphPayload | null): string {
  if (!data) return PALETTE[0];
  const i = data.papers.findIndex((p) => p.id === paperId);
  return PALETTE[Math.max(0, i) % PALETTE.length];
}
function pIdx(paperId: string, data: GraphPayload | null): number {
  if (!data) return 0;
  return Math.max(0, data.papers.findIndex((p) => p.id === paperId)) % PALETTE.length;
}
function nodeR(degree: number) { return 15 + Math.min(degree, 9) * 1.9; }

interface Sim { id: string; x: number; y: number; vx: number; vy: number; node: GraphNode; }
interface XForm { x: number; y: number; k: number; }

// Glass-morphism HUD panel style
const G: React.CSSProperties = {
  background: "rgba(15,18,26,0.86)",
  backdropFilter: "blur(18px)",
  WebkitBackdropFilter: "blur(18px)",
  border: "1px solid rgba(255,255,255,0.07)",
  borderRadius: 13,
};

// ── Component ────────────────────────────────────────────────
export default function GraphPage() {
  const [papers, setPapers]   = useState<Paper[]>([]);
  const [data, setData]       = useState<GraphPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");
  const [sel, setSel]         = useState<GraphNode | null>(null);
  const [hovered, setHovered] = useState<Sim | null>(null);
  const [active, setActive]   = useState({ contradiction: true, support: true, nuance: true });
  const [sims, setSims]       = useState<Sim[]>([]);
  const [search, setSearch]   = useState("");
  const [view, setView]       = useState<"graph" | "clusters">("graph");
  const [clusters, setClusters]     = useState<DebateCluster[]>([]);
  const [clusterLoading, setClusterLoading] = useState(false);
  const [selCluster, setSelCluster] = useState<DebateCluster | null>(null);
  const [xform, setXform]     = useState<XForm>({ x: 0, y: 0, k: 1 });
  const [dragging, setDragging] = useState(false);

  const rafRef    = useRef<number>(0);
  const simsRef   = useRef<Sim[]>([]);
  const edgesRef  = useRef<GraphEdge[]>([]);   // avoids the window global + stale closure
  const svgRef    = useRef<SVGSVGElement>(null);
  const xformRef  = useRef<XForm>({ x: 0, y: 0, k: 1 });
  const dimsRef   = useRef({ w: 1400, h: 900 });
  const dragRef   = useRef<{ sx: number; sy: number; px: number; py: number; moved: boolean } | null>(null);

  // ── Dims ────────────────────────────────────────────────────
  useEffect(() => {
    const upd = () => { dimsRef.current = { w: window.innerWidth - 60, h: window.innerHeight }; };
    upd();
    window.addEventListener("resize", upd);
    return () => window.removeEventListener("resize", upd);
  }, []);

  // ── Load data ───────────────────────────────────────────────
  useEffect(() => {
    const cp = cache.read<Paper[]>("papers");
    if (cp?.length) setPapers(cp);
    api.listPapers(50).then((p) => { setPapers(p); cache.write("papers", p); });
    const cg = cache.read<GraphPayload>("graph");
    if (cg?.nodes?.length) { setData(cg); seed(cg); }
    else {
      setLoading(true);
      api.graph({ compute: false })
        .then((g) => { setData(g); cache.write("graph", g); seed(g); })
        .catch(() => {})
        .finally(() => setLoading(false));
    }
    api.listClusters().then(setClusters).catch(() => {});
  }, []);

  // ── Wheel zoom ──────────────────────────────────────────────
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { x, y, k } = xformRef.current;
      const rect = svg.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const f = e.deltaY < 0 ? 1.13 : 0.88;
      const nk = Math.max(0.12, Math.min(5, k * f));
      const t: XForm = { x: mx - (mx - x) * (nk / k), y: my - (my - y) * (nk / k), k: nk };
      xformRef.current = t; setXform(t);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  // ── Seed positions ───────────────────────────────────────────
  const seed = (g: GraphPayload) => {
    const { w, h } = dimsRef.current;
    const cx = w / 2, cy = h / 2;
    const connected = new Set(g.edges.flatMap((e) => [e.source, e.target]));
    const nodes = g.nodes.filter((n) => connected.has(n.id));
    const r = Math.min(w, h) * 0.34;
    const s: Sim[] = nodes.map((n, i) => ({
      id: n.id, node: n,
      x: cx + Math.cos((i / Math.max(nodes.length, 1)) * Math.PI * 2) * r + (Math.random() - 0.5) * 50,
      y: cy + Math.sin((i / Math.max(nodes.length, 1)) * Math.PI * 2) * r + (Math.random() - 0.5) * 50,
      vx: 0, vy: 0,
    }));
    simsRef.current = s; setSims(s);
  };

  // ── Force tick ───────────────────────────────────────────────
  const tick = useCallback(() => {
    const ns = simsRef.current;
    if (!ns.length) return;
    const { w, h } = dimsRef.current;
    const cx = w / 2, cy = h / 2;

    for (const n of ns) { n.vx += (cx - n.x) * 0.009; n.vy += (cy - n.y) * 0.009; }

    for (let i = 0; i < ns.length; i++) {
      for (let j = i + 1; j < ns.length; j++) {
        const a = ns[i], b = ns[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        const d = Math.hypot(dx, dy) || 1;
        const f = 3600 / (d * d); dx /= d; dy /= d;
        a.vx += dx * f; a.vy += dy * f;
        b.vx -= dx * f; b.vy -= dy * f;
      }
    }

    // Edges live in a ref to avoid both a stale closure and leaking onto window.
    const edges = edgesRef.current;
    if (edges.length) {
      for (const e of edges) {
        const a = ns.find((n) => n.id === e.source);
        const b = ns.find((n) => n.id === e.target);
        if (!a || !b) continue;
        let dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 1;
        const f = (d - 190) * 0.008; dx /= d; dy /= d;
        a.vx += dx * f; a.vy += dy * f;
        b.vx -= dx * f; b.vy -= dy * f;
      }
    }

    const pad = 70;
    let maxV2 = 0;
    for (const n of ns) {
      n.vx *= 0.76; n.vy *= 0.76;
      n.x += n.vx; n.y += n.vy;
      n.x = Math.max(pad, Math.min(w - pad, n.x));
      n.y = Math.max(pad, Math.min(h - pad, n.y));
      const v2 = n.vx * n.vx + n.vy * n.vy;
      if (v2 > maxV2) maxV2 = v2;
    }
    setSims([...ns]);
    // Stop once the layout has settled — otherwise the O(n²) repulsion loop
    // burns CPU forever on a static graph. Reheats whenever seed() runs.
    if (maxV2 > 0.04) {
      rafRef.current = requestAnimationFrame(tick);
    }
  }, []);

  useEffect(() => {
    if (!data) return;
    edgesRef.current = data.edges;
    if (sims.length) {
      rafRef.current = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(rafRef.current);
    }
  }, [data, sims.length, tick]);

  // ── Actions ─────────────────────────────────────────────────
  const refresh = async () => {
    setLoading(true); setSel(null); setError("");
    try { const g = await api.graph({ compute: false }); setData(g); cache.write("graph", g); seed(g); }
    catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const expand = async () => {
    if (!window.confirm("Expand relationships?\n\nRuns the contradiction pipeline on new pairs — uses API credits.")) return;
    setLoading(true); setSel(null); setError("");
    try { const g = await api.graph({ similarityThreshold: 0.40, maxPairs: 120, compute: true }); setData(g); cache.write("graph", g); seed(g); }
    catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const detectClusters = async () => {
    setClusterLoading(true);
    try {
      const { job_id } = await api.detectClusters();
      if (!job_id) { setClusters(await api.listClusters()); setView("clusters"); return; }
      const poll = setInterval(async () => {
        try {
          const job = await api.getJob<DebateCluster[]>(job_id);
          if (job.status === "done") { clearInterval(poll); setClusters(await api.listClusters()); setView("clusters"); setClusterLoading(false); }
          else if (job.status === "error") { clearInterval(poll); setClusterLoading(false); }
        } catch { clearInterval(poll); setClusterLoading(false); }
      }, 2000);
    } catch { setClusterLoading(false); }
  };

  const zoomToFit = () => {
    const ns = simsRef.current;
    if (!ns.length) return;
    const { w, h } = dimsRef.current;
    const xs = ns.map(n => n.x), ys = ns.map(n => n.y);
    const pad = 80;
    const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
    const minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
    const k = Math.min(w / (maxX - minX), h / (maxY - minY), 2.5);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const t: XForm = { x: w / 2 - cx * k, y: h / 2 - cy * k, k };
    xformRef.current = t; setXform(t);
  };

  const exportPNG = () => {
    const svg = svgRef.current; if (!svg) return;
    const { w, h } = dimsRef.current;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    const os = [svg, ...Array.from(svg.querySelectorAll("*"))];
    const cs = [clone, ...Array.from(clone.querySelectorAll("*"))];
    os.forEach((o, i) => {
      const s = getComputedStyle(o), c = cs[i] as SVGElement;
      for (const p of ["fill","stroke","opacity","fill-opacity","stroke-opacity","stroke-width"]) {
        const v = s.getPropertyValue(p); if (v && v !== "none" && v !== "") c.setAttribute(p, v);
      }
      c.removeAttribute("class");
    });
    const svgStr = new XMLSerializer().serializeToString(clone);
    const canvas = document.createElement("canvas");
    const sc = 2; canvas.width = w * sc; canvas.height = h * sc;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(sc, sc); ctx.fillStyle = "#0B0D12"; ctx.fillRect(0, 0, w, h);
    const blob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { ctx.drawImage(img, 0, 0, w, h); URL.revokeObjectURL(url); const a = document.createElement("a"); a.download = "knowledge-graph.png"; a.href = canvas.toDataURL("image/png"); a.click(); };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  };

  // ── Pan drag ────────────────────────────────────────────────
  const onSvgDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if ((e.target as Element).closest(".ng")) return;
    dragRef.current = { sx: e.clientX, sy: e.clientY, px: xformRef.current.x, py: xformRef.current.y, moved: false };
  };
  const onSvgMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.sx, dy = e.clientY - dragRef.current.sy;
    if (Math.hypot(dx, dy) > 3) {
      dragRef.current.moved = true; setDragging(true);
      const t: XForm = { ...xformRef.current, x: dragRef.current.px + dx, y: dragRef.current.py + dy };
      xformRef.current = t; setXform(t);
    }
  };
  const onSvgUp = () => { dragRef.current = null; setDragging(false); };

  // ── Derived ──────────────────────────────────────────────────
  const posOf = (id: string) => sims.find((s) => s.id === id);
  const neighbors = sel && data
    ? new Set(data.edges.filter(e => e.source === sel.id || e.target === sel.id).flatMap(e => [e.source, e.target]))
    : null;
  const otherNode = (e: GraphEdge, self: string) =>
    data?.nodes.find(n => n.id === (e.source === self ? e.target : e.source));

  // Tooltip in screen-space (fixed positioning)
  const hovTip = hovered ? {
    x: hovered.x * xform.k + xform.x + 60,
    y: hovered.y * xform.k + xform.y,
  } : null;

  const hasData = !!data?.nodes?.length;

  // ── Render ───────────────────────────────────────────────────
  return (
    <div style={{ position: "fixed", left: 60, top: 0, right: 0, bottom: 0, zIndex: 10, overflow: "hidden", background: "#0B0D12" }}>

      {/* Ambient center glow */}
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none",
        background: "radial-gradient(ellipse 72% 58% at 50% 50%, rgba(124,111,255,0.06) 0%, rgba(124,111,255,0.02) 40%, transparent 70%)" }} />

      {/* ── SVG canvas ─────────────────────────────────────── */}
      <svg ref={svgRef} style={{ width: "100%", height: "100%", cursor: dragging ? "grabbing" : "default", display: "block" }}
        onMouseDown={onSvgDown} onMouseMove={onSvgMove} onMouseUp={onSvgUp} onMouseLeave={onSvgUp}>

        <defs>
          {/* Subtle dot grid */}
          <pattern id="dots" x="0" y="0" width="30" height="30" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="0.8" fill="rgba(255,255,255,0.025)" />
          </pattern>

          {/* Glow filter — used ONLY on selected/hovered node to stay performant */}
          <filter id="glow-sel" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="9" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id="glow-hov" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>

          {/* Per-paper radial gradient for node body */}
          {PALETTE.map((c, i) => (
            <radialGradient key={i} id={`rg${i}`} cx="38%" cy="32%" r="72%">
              <stop offset="0%" stopColor={c} stopOpacity={0.26} />
              <stop offset="100%" stopColor={c} stopOpacity={0.03} />
            </radialGradient>
          ))}
        </defs>

        {/* Background dot grid — outside transform, stays fixed */}
        <rect width="100%" height="100%" fill="url(#dots)" />

        {/* ── Zoomable / pannable group ── */}
        <g transform={`translate(${xform.x},${xform.y}) scale(${xform.k})`}>

          {/* Edges */}
          {data?.edges.filter(e => active[e.relationship as keyof typeof active]).map((e, i) => {
            const a = posOf(e.source), b = posOf(e.target);
            if (!a || !b) return null;
            const dim = !!(neighbors && !(neighbors.has(e.source) && neighbors.has(e.target)));

            if (e.relationship === "contradiction") return (
              <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke="#FF5C5C" strokeWidth={dim ? 1 : 2.2}
                strokeOpacity={dim ? 0.03 : 0.70}
                className={!dim ? "edge-contra" : undefined} />
            );
            if (e.relationship === "support") return (
              <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke="#3DD4A0" strokeWidth={dim ? 1 : 1.8}
                strokeOpacity={dim ? 0.03 : undefined}
                className={!dim ? "edge-support" : undefined} />
            );
            return (
              <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke="#F5A623" strokeWidth={dim ? 1 : 1.5}
                strokeOpacity={dim ? 0.03 : 0.44}
                strokeDasharray="3 8" />
            );
          })}

          {/* Nodes */}
          {(() => {
            const q = search.trim().toLowerCase();
            return sims.map((s) => {
              const isSel  = sel?.id === s.id;
              const isHov  = hovered?.id === s.id;
              const isMatch = q && (s.node.claim.toLowerCase().includes(q) || s.node.paper_title.toLowerCase().includes(q));
              const dim    = (neighbors && !neighbors.has(s.id)) || (q && !isMatch);
              const r      = nodeR(s.node.degree);
              const pc     = pColor(s.node.paper_id, data);
              const pi     = pIdx(s.node.paper_id, data);

              return (
                <g key={s.id} className="ng"
                  onClick={() => { if (dragRef.current?.moved) return; setSel(isSel ? null : s.node); }}
                  onMouseEnter={() => setHovered(s)}
                  onMouseLeave={() => setHovered(null)}
                  style={{ cursor: "pointer", opacity: dim ? 0.06 : 1, transition: "opacity 0.22s" }}>

                  {/* Outer soft aura — no filter, cheap */}
                  <circle cx={s.x} cy={s.y} r={r * 2.6} fill={pc}
                    fillOpacity={isSel ? 0.14 : isHov ? 0.09 : 0.04} />

                  {/* Selection pulse ring via SVG SMIL — zero JS cost */}
                  {isSel && (
                    <circle cx={s.x} cy={s.y} r={r} fill="none" stroke="var(--gen)" strokeWidth={1.8}>
                      <animate attributeName="r" values={`${r};${r + 28}`} dur="1.7s" repeatCount="indefinite" calcMode="ease-out" />
                      <animate attributeName="stroke-opacity" values="0.75;0" dur="1.7s" repeatCount="indefinite" calcMode="ease-out" />
                    </circle>
                  )}

                  {/* Search highlight ring */}
                  {isMatch && (
                    <circle cx={s.x} cy={s.y} r={r + 10} fill="none"
                      stroke="var(--gen)" strokeWidth={1.5} strokeOpacity={0.6} strokeDasharray="4 3" />
                  )}

                  {/* Paper color outer ring */}
                  <circle cx={s.x} cy={s.y} r={r + 5} fill="none"
                    stroke={pc} strokeWidth={2.2}
                    strokeOpacity={isSel ? 1 : isHov ? 0.85 : 0.35} />

                  {/* Node body — dark base */}
                  <circle cx={s.x} cy={s.y} r={r} fill="#1D2230"
                    filter={isSel ? "url(#glow-sel)" : isHov ? "url(#glow-hov)" : undefined} />

                  {/* Radial gradient overlay gives depth */}
                  <circle cx={s.x} cy={s.y} r={r} fill={`url(#rg${pi})`} />

                  {/* Core accent dot */}
                  <circle cx={s.x} cy={s.y} r={isSel ? r * 0.40 : r * 0.27}
                    fill={isSel ? "var(--gen)" : pc} fillOpacity={0.97} />
                </g>
              );
            });
          })()}
        </g>
      </svg>

      {/* ── Hover tooltip — fixed screen-space ── */}
      {hovTip && hovered && (
        <div style={{
          position: "fixed", left: hovTip.x + 20, top: hovTip.y - 66,
          zIndex: 60, pointerEvents: "none", maxWidth: 250, ...G, padding: "11px 15px",
        }}>
          <div style={{ fontSize: 9.5, color: "var(--text-4)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {hovered.node.paper_title}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-1)", lineHeight: 1.55, display: "-webkit-box", WebkitLineClamp: 4, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
            {hovered.node.claim}
          </div>
          <div style={{ fontSize: 9.5, color: "var(--text-4)", marginTop: 6 }}>
            {hovered.node.degree} connection{hovered.node.degree !== 1 ? "s" : ""} · {hovered.node.section}
          </div>
        </div>
      )}

      {/* ── HUD: top-left — view + filters + search ── */}
      <div style={{ position: "absolute", top: 20, left: 20, zIndex: 20, display: "flex", flexDirection: "column", gap: 9 }}>
        {/* View toggle */}
        <div style={{ ...G, display: "flex", padding: 3, gap: 2 }}>
          {(["graph", "clusters"] as const).map((v) => (
            <button key={v} onClick={() => setView(v)} style={{
              padding: "6px 15px", fontSize: 12.5, fontWeight: 500, border: "none", borderRadius: 9,
              cursor: "pointer", display: "flex", alignItems: "center", gap: 6, transition: "all 0.18s",
              background: view === v ? "rgba(124,111,255,0.22)" : "transparent",
              color: view === v ? "#9E94FF" : "var(--text-3)",
            }}>
              {v === "graph" ? <Network size={12} /> : <Layers size={12} />}
              {v === "graph" ? "Graph" : "Clusters"}
            </button>
          ))}
        </div>

        {view === "graph" && (
          <>
            {/* Relationship type toggles */}
            <div style={{ display: "flex", gap: 6 }}>
              {(["contradiction", "support", "nuance"] as const).map((t) => {
                const on = active[t];
                return (
                  <button key={t} onClick={() => setActive(a => ({ ...a, [t]: !a[t] }))} style={{
                    ...G, padding: "5px 12px", fontSize: 11.5, fontWeight: 500, border: `1px solid ${on ? REL[t].line : "rgba(255,255,255,0.05)"}`,
                    background: on ? REL[t].dim : "rgba(14,17,24,0.75)",
                    color: on ? REL[t].c : "var(--text-4)", cursor: "pointer",
                    display: "flex", alignItems: "center", gap: 6, transition: "all 0.18s",
                  }}>
                    <span style={{ width: 5, height: 5, borderRadius: "50%", background: on ? REL[t].c : "var(--text-4)", transition: "background 0.18s" }} />
                    {t}
                  </button>
                );
              })}
            </div>

            {/* Search */}
            <div style={{ ...G, display: "flex", alignItems: "center", gap: 8, padding: "7px 13px" }}>
              <Search size={12} style={{ color: "var(--text-4)", flexShrink: 0 }} />
              <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search nodes…" style={{
                background: "transparent", border: "none", outline: "none", fontSize: 12,
                color: "var(--text-1)", width: 170,
              }} />
            </div>
          </>
        )}
      </div>

      {/* ── HUD: top-right — stats ── */}
      {hasData && view === "graph" && (
        <div style={{ position: "absolute", top: 20, right: 20, zIndex: 20 }}>
          <div style={{ ...G, padding: "10px 20px", display: "flex", alignItems: "center", gap: 22 }}>
            {[
              { label: "Claims",  val: data!.nodes.length, color: "#9E94FF" },
              { label: "Edges",   val: data!.edges.length, color: "var(--text-2)" },
              { label: "Papers",  val: data!.papers.length, color: "#F5A623" },
            ].map(({ label, val, color }) => (
              <div key={label} style={{ textAlign: "center" }}>
                <div style={{ fontSize: 22, fontWeight: 700, color, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{val}</div>
                <div style={{ fontSize: 9, color: "var(--text-4)", textTransform: "uppercase", letterSpacing: "0.09em", marginTop: 3 }}>{label}</div>
              </div>
            ))}
          </div>
          {error && <div style={{ ...G, marginTop: 8, padding: "7px 14px", fontSize: 12, color: "var(--contra)" }}>{error}</div>}
        </div>
      )}

      {/* ── HUD: bottom-left — paper legend ── */}
      {hasData && view === "graph" && (
        <div style={{ position: "absolute", bottom: 20, left: 20, zIndex: 20 }}>
          <div style={{ ...G, padding: "12px 16px", maxWidth: 340 }}>
            <div style={{ fontSize: 9, color: "var(--text-4)", textTransform: "uppercase", letterSpacing: "0.09em", marginBottom: 10 }}>Papers</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {data!.papers.slice(0, 8).map((p, i) => (
                <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: PALETTE[i % PALETTE.length], flexShrink: 0, boxShadow: `0 0 8px ${PALETTE[i % PALETTE.length]}66` }} />
                  <span style={{ fontSize: 11.5, color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {p.title.length > 44 ? p.title.slice(0, 44) + "…" : p.title}
                  </span>
                </div>
              ))}
              {data!.papers.length > 8 && <span style={{ fontSize: 11, color: "var(--text-4)" }}>+{data!.papers.length - 8} more</span>}
            </div>
          </div>
        </div>
      )}

      {/* ── HUD: bottom-right — zoom + actions ── */}
      <div style={{ position: "absolute", bottom: 20, right: 20, zIndex: 20, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
        {view === "graph" && (
          <>
            {/* Zoom controls */}
            <div style={{ ...G, display: "flex", flexDirection: "column", overflow: "hidden", padding: 0 }}>
              {[
                { icon: <Plus size={14} />, fn: () => { const t = { ...xformRef.current, k: Math.min(5, xformRef.current.k * 1.22) }; xformRef.current = t; setXform(t); } },
                { icon: <Maximize2 size={13} />, fn: zoomToFit },
                { icon: <Minus size={14} />, fn: () => { const t = { ...xformRef.current, k: Math.max(0.12, xformRef.current.k * 0.82) }; xformRef.current = t; setXform(t); } },
              ].map(({ icon, fn }, i) => (
                <button key={i} onClick={fn} style={{
                  padding: "10px 13px", background: "transparent", border: "none",
                  borderBottom: i < 2 ? "1px solid rgba(255,255,255,0.05)" : "none",
                  color: "var(--text-3)", cursor: "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  transition: "color 0.15s",
                }}
                  onMouseEnter={e => (e.currentTarget.style.color = "var(--text-1)")}
                  onMouseLeave={e => (e.currentTarget.style.color = "var(--text-3)")}
                >{icon}</button>
              ))}
            </div>

            {/* Action buttons */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <button onClick={exportPNG} style={{ ...G, padding: "8px 15px", fontSize: 12, color: "var(--text-2)", cursor: "pointer", display: "flex", alignItems: "center", gap: 7, border: "1px solid rgba(255,255,255,0.07)", transition: "all 0.18s" }}
                onMouseEnter={e => (e.currentTarget.style.color = "var(--text-1)")}
                onMouseLeave={e => (e.currentTarget.style.color = "var(--text-2)")}>
                <Download size={13} /> Export PNG
              </button>
              <button onClick={refresh} disabled={loading} style={{ ...G, padding: "8px 15px", fontSize: 12, color: "var(--text-2)", cursor: "pointer", display: "flex", alignItems: "center", gap: 7, border: "1px solid rgba(255,255,255,0.07)", opacity: loading ? 0.5 : 1, transition: "all 0.18s" }}
                onMouseEnter={e => (e.currentTarget.style.color = "var(--text-1)")}
                onMouseLeave={e => (e.currentTarget.style.color = "var(--text-2)")}>
                {loading ? <Spinner /> : <><Network size={13} /> Refresh</>}
              </button>
              <button onClick={expand} disabled={loading} style={{
                padding: "9px 15px", fontSize: 12.5, fontWeight: 600,
                background: "rgba(124,111,255,0.18)", border: "1px solid rgba(124,111,255,0.45)",
                borderRadius: 11, color: "#9E94FF", cursor: "pointer",
                display: "flex", alignItems: "center", gap: 7, backdropFilter: "blur(16px)",
                transition: "all 0.18s", opacity: loading ? 0.5 : 1,
              }}
                onMouseEnter={e => (e.currentTarget.style.background = "rgba(124,111,255,0.27)")}
                onMouseLeave={e => (e.currentTarget.style.background = "rgba(124,111,255,0.18)")}>
                <Zap size={13} /> Expand
              </button>
            </div>
          </>
        )}
        {view === "clusters" && (
          <button onClick={detectClusters} disabled={clusterLoading} style={{
            padding: "9px 18px", fontSize: 12.5, fontWeight: 600,
            background: "rgba(124,111,255,0.18)", border: "1px solid rgba(124,111,255,0.45)",
            borderRadius: 11, color: "#9E94FF", cursor: "pointer",
            display: "flex", alignItems: "center", gap: 7, backdropFilter: "blur(16px)",
            opacity: clusterLoading ? 0.6 : 1,
          }}>
            {clusterLoading ? <Spinner /> : <><Layers size={13} /> {clusters.length ? "Re-detect" : "Detect clusters"}</>}
          </button>
        )}
      </div>

      {/* ── Node inspector — floating right panel ── */}
      {sel && data && view === "graph" && (
        <div style={{
          position: "absolute", right: 20, top: "50%", transform: "translateY(-50%)",
          zIndex: 30, width: 310, maxHeight: "80vh", overflowY: "auto",
          ...G, padding: "20px",
        }} className="fade-up">
          <button onClick={() => setSel(null)} style={{
            position: "absolute", top: 14, right: 14, background: "transparent",
            border: "none", color: "var(--text-4)", cursor: "pointer", fontSize: 15, lineHeight: 1,
            transition: "color 0.15s",
          }}
            onMouseEnter={e => (e.currentTarget.style.color = "var(--text-1)")}
            onMouseLeave={e => (e.currentTarget.style.color = "var(--text-4)")}>
            ✕
          </button>

          {/* Badge */}
          <div style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "rgba(124,111,255,0.14)", border: "1px solid rgba(124,111,255,0.32)", borderRadius: 999, padding: "3px 11px", fontSize: 10.5, color: "#9E94FF", fontWeight: 600, marginBottom: 15 }}>
            <span style={{ width: 3, height: 3, borderRadius: "50%", background: "#9E94FF" }} />
            {sel.degree} connection{sel.degree !== 1 ? "s" : ""}
          </div>

          <div style={{ fontSize: 9.5, color: "var(--text-4)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Claim</div>
          <p style={{ fontSize: 12.5, color: "var(--text-1)", lineHeight: 1.68, marginBottom: 15 }}>{sel.claim}</p>

          <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "10px 0", borderTop: "1px solid rgba(255,255,255,0.06)", borderBottom: "1px solid rgba(255,255,255,0.06)", marginBottom: 15 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: pColor(sel.paper_id, data), flexShrink: 0, boxShadow: `0 0 8px ${pColor(sel.paper_id, data)}66` }} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 11.5, color: "var(--text-1)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sel.paper_title}</div>
              <div style={{ fontSize: 10, color: "var(--text-3)", marginTop: 1 }}>{sel.section} · {sel.confidence} confidence</div>
            </div>
          </div>

          {/* Connected edges */}
          {(() => {
            const conns = data.edges
              .filter(e => (e.source === sel.id || e.target === sel.id) && e.relationship !== "unrelated")
              .sort((a, b) => b.similarity - a.similarity).slice(0, 6);
            if (!conns.length) return <p style={{ fontSize: 12, color: "var(--text-4)", textAlign: "center", padding: "10px 0" }}>No relationships detected.</p>;
            return (
              <>
                <div style={{ fontSize: 9.5, color: "var(--text-4)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 9 }}>
                  Connections ({conns.length})
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {conns.map((e, i) => {
                    const other = otherNode(e, sel.id);
                    const rk = e.relationship as keyof typeof REL;
                    return (
                      <button key={i} onClick={() => { if (other) setSel(other); }} style={{
                        padding: "9px 11px", borderRadius: 9, textAlign: "left",
                        background: `${REL[rk].dim}88`, border: `1px solid ${REL[rk].line}`,
                        cursor: "pointer", transition: "all 0.15s", width: "100%",
                      }}
                        onMouseEnter={e => (e.currentTarget.style.borderColor = REL[rk].c)}
                        onMouseLeave={e => (e.currentTarget.style.borderColor = REL[rk].line)}>
                        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4 }}>
                          <span style={{ width: 5, height: 5, borderRadius: "50%", background: REL[rk].c }} />
                          <span style={{ fontSize: 10.5, fontWeight: 700, color: REL[rk].c, textTransform: "capitalize" }}>{e.relationship}</span>
                          <span style={{ fontSize: 9.5, color: "var(--text-4)", marginLeft: "auto", fontFamily: "monospace" }}>{e.similarity.toFixed(2)}</span>
                        </div>
                        {other && <div style={{ fontSize: 10.5, color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{other.paper_title}</div>}
                      </button>
                    );
                  })}
                </div>
              </>
            );
          })()}

          <Link href="/contradictions" style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "#9E94FF", fontWeight: 500, textDecoration: "none" }}>
            View full scan →
          </Link>
        </div>
      )}

      {/* ── Loading indicator ── */}
      {loading && (
        <div style={{ position: "absolute", bottom: 26, left: "50%", transform: "translateX(-50%)", zIndex: 40 }}>
          <div style={{ ...G, padding: "8px 20px", display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: "var(--text-2)" }}>
            <Spinner /> Loading graph…
          </div>
        </div>
      )}

      {/* ── Empty / no-data states ── */}
      {papers.length < 2 && !hasData && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 20 }}>
          <div style={{ ...G, padding: "44px 54px", textAlign: "center", maxWidth: 420 }}>
            <Network size={34} style={{ color: "#9E94FF", margin: "0 auto 18px", display: "block" }} />
            <div style={{ fontSize: 20, fontWeight: 700, color: "var(--text-1)", marginBottom: 8 }}>Need at least 2 papers</div>
            <div style={{ fontSize: 13, color: "var(--text-3)", lineHeight: 1.65 }}>Add papers and run a contradiction scan to grow the knowledge graph.</div>
          </div>
        </div>
      )}

      {papers.length >= 2 && !hasData && !loading && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 20 }}>
          <div style={{ ...G, padding: "44px 54px", textAlign: "center", maxWidth: 460 }} className="fade-up">
            <Network size={34} style={{ color: "#9E94FF", margin: "0 auto 18px", display: "block" }} />
            <div style={{ fontSize: 20, fontWeight: 700, color: "var(--text-1)", marginBottom: 8 }}>Build the knowledge graph</div>
            <div style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.68, marginBottom: 22 }}>
              Every claim becomes a node. Edges show where papers support, contradict, or nuance each other. Reads from your existing scan — no extra API cost.
            </div>
            <button onClick={refresh} style={{
              padding: "11px 26px", fontSize: 14, fontWeight: 600,
              background: "rgba(124,111,255,0.2)", border: "1px solid rgba(124,111,255,0.5)",
              borderRadius: 12, color: "#9E94FF", cursor: "pointer",
              display: "inline-flex", alignItems: "center", gap: 9,
            }}>
              <Network size={15} /> Build graph
            </button>
          </div>
        </div>
      )}

      {/* ── Clusters view ── */}
      {view === "clusters" && (
        <div style={{ position: "absolute", inset: 0, zIndex: 20, overflowY: "auto", padding: 28 }} className="fade-up">
          {clusters.length === 0 ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100%" }}>
              <div style={{ ...G, padding: "44px 54px", textAlign: "center", maxWidth: 420 }}>
                <Layers size={30} style={{ color: "var(--text-4)", margin: "0 auto 16px", display: "block" }} />
                <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text-1)", marginBottom: 8 }}>No clusters yet</div>
                <div style={{ fontSize: 13, color: "var(--text-3)", lineHeight: 1.65 }}>
                  After running a contradiction scan, click "Detect clusters" to group related claims into debate clusters.
                </div>
              </div>
            </div>
          ) : selCluster ? (
            /* ── Cluster detail ── */
            <div style={{ maxWidth: 920, margin: "0 auto" }}>
              <button onClick={() => setSelCluster(null)} style={{ ...G, padding: "7px 15px", fontSize: 12, color: "#9E94FF", border: "1px solid rgba(124,111,255,0.3)", cursor: "pointer", marginBottom: 22, display: "inline-flex", alignItems: "center", gap: 7, background: "rgba(124,111,255,0.1)" }}>
                ← All clusters
              </button>
              <div style={{ ...G, padding: "26px 30px", marginBottom: 18 }}>
                <div style={{ fontSize: 10, color: "var(--text-4)", textTransform: "uppercase", letterSpacing: "0.09em", marginBottom: 7 }}>Debate cluster</div>
                <div style={{ fontSize: 24, fontWeight: 800, color: "var(--text-1)", marginBottom: 8, letterSpacing: "-0.02em" }}>{selCluster.name}</div>
                {selCluster.research_question && <div style={{ fontSize: 14, color: "var(--text-2)", fontStyle: "italic", marginBottom: 10, lineHeight: 1.55 }}>"{selCluster.research_question}"</div>}
                {selCluster.description && <div style={{ fontSize: 13, color: "var(--text-3)", lineHeight: 1.68, marginBottom: 20 }}>{selCluster.description}</div>}
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  {[
                    { label: "Claims", val: selCluster.claim_ids.length, color: "var(--text-2)" },
                    { label: "Contradictions", val: selCluster.contradiction_count, color: "var(--contra)" },
                    { label: "Support", val: selCluster.support_count, color: "var(--support)" },
                    { label: "Nuances", val: selCluster.nuance_count, color: "var(--nuance)" },
                    { label: "Papers", val: selCluster.paper_count, color: "#9E94FF" },
                  ].map(({ label, val, color }) => (
                    <div key={label} style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 11, padding: "12px 20px", textAlign: "center" }}>
                      <div style={{ fontSize: 24, fontWeight: 700, color, lineHeight: 1 }}>{val}</div>
                      <div style={{ fontSize: 9.5, color: "var(--text-4)", marginTop: 5, textTransform: "uppercase", letterSpacing: "0.07em" }}>{label}</div>
                    </div>
                  ))}
                </div>
              </div>
              {data && (() => {
                const cs = new Set(selCluster.claim_ids);
                const cNodes = data.nodes.filter(n => cs.has(n.id));
                const cEdges = data.edges.filter(e => cs.has(e.source) && cs.has(e.target) && e.relationship !== "unrelated");
                return (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 270px", gap: 16 }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      <div style={{ fontSize: 9.5, color: "var(--text-4)", textTransform: "uppercase", letterSpacing: "0.08em" }}>{cNodes.length} claims</div>
                      {cNodes.map(n => {
                        const ne = cEdges.filter(e => e.source === n.id || e.target === n.id);
                        return (
                          <div key={n.id} style={{ ...G, padding: "14px 16px" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                              <span style={{ width: 6, height: 6, borderRadius: "50%", background: pColor(n.paper_id, data), flexShrink: 0, boxShadow: `0 0 6px ${pColor(n.paper_id, data)}66` }} />
                              <span style={{ fontSize: 11, color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.paper_title}</span>
                            </div>
                            <div style={{ fontSize: 12.5, color: "var(--text-1)", lineHeight: 1.65, marginBottom: ne.length ? 8 : 0 }}>{n.claim}</div>
                            {ne.length > 0 && (
                              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                                {ne.slice(0, 3).map((e, i) => {
                                  const rk = e.relationship as keyof typeof REL;
                                  return <span key={i} style={{ padding: "2px 8px", borderRadius: 999, fontSize: 10, fontWeight: 600, background: REL[rk].dim, color: REL[rk].c, border: `1px solid ${REL[rk].line}` }}>{e.relationship}</span>;
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ ...G, padding: "18px", alignSelf: "start", position: "sticky", top: 20 }}>
                      <div style={{ fontSize: 9.5, color: "var(--text-4)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 13 }}>Breakdown</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 9, marginBottom: 18 }}>
                        {[{ type: "contradiction" as const, count: selCluster.contradiction_count }, { type: "nuance" as const, count: selCluster.nuance_count }, { type: "support" as const, count: selCluster.support_count }].filter(x => x.count > 0).map(({ type, count }) => (
                          <div key={type} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ width: 7, height: 7, borderRadius: "50%", background: REL[type].c }} />
                            <span style={{ fontSize: 12, color: "var(--text-2)", textTransform: "capitalize", flex: 1 }}>{type}</span>
                            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-1)" }}>{count}</span>
                          </div>
                        ))}
                      </div>
                      <button onClick={() => { setView("graph"); setSelCluster(null); }} style={{ width: "100%", padding: "9px 0", fontSize: 12, color: "#9E94FF", fontWeight: 600, background: "rgba(124,111,255,0.12)", border: "1px solid rgba(124,111,255,0.3)", borderRadius: 9, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                        <Network size={13} /> View in graph
                      </button>
                    </div>
                  </div>
                );
              })()}
            </div>
          ) : (
            /* ── Cluster list ── */
            <div style={{ maxWidth: 980, margin: "0 auto" }}>
              <div style={{ fontSize: 12, color: "var(--text-4)", marginBottom: 20, letterSpacing: "0.04em", textTransform: "uppercase" }}>
                {clusters.length} debate cluster{clusters.length !== 1 ? "s" : ""} · sorted by conflict density
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(400px, 1fr))", gap: 13 }}>
                {clusters.map(c => {
                  const total = c.contradiction_count + c.support_count + c.nuance_count;
                  const density = total > 0 ? Math.round((c.contradiction_count / total) * 100) : 0;
                  const barColor = density > 60 ? "var(--contra)" : density > 30 ? "var(--nuance)" : "var(--support)";
                  return (
                    <button key={c.id} onClick={() => setSelCluster(c)} style={{ ...G, padding: "20px 22px", textAlign: "left", cursor: "pointer", border: "1px solid rgba(255,255,255,0.06)", transition: "all 0.18s", width: "100%" }}
                      onMouseEnter={e => { e.currentTarget.style.borderColor = "rgba(124,111,255,0.35)"; e.currentTarget.style.background = "rgba(18,21,32,0.92)"; }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.06)"; e.currentTarget.style.background = "rgba(15,18,26,0.86)"; }}>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 11 }}>
                        {c.contradiction_count > 0 && <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 9px", borderRadius: 999, background: "rgba(255,92,92,0.14)", color: "var(--contra)", border: "1px solid rgba(255,92,92,0.3)" }}>{c.contradiction_count} conflicts</span>}
                        {c.support_count > 0 && <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 9px", borderRadius: 999, background: "rgba(61,212,160,0.14)", color: "var(--support)", border: "1px solid rgba(61,212,160,0.3)" }}>{c.support_count} support</span>}
                      </div>
                      <div style={{ fontSize: 17, fontWeight: 800, color: "var(--text-1)", marginBottom: 5, letterSpacing: "-0.015em" }}>{c.name}</div>
                      {c.research_question && <div style={{ fontSize: 12.5, color: "var(--text-3)", fontStyle: "italic", marginBottom: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>"{c.research_question}"</div>}
                      {c.description && <div style={{ fontSize: 12, color: "var(--text-3)", lineHeight: 1.55, marginBottom: 14, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{c.description}</div>}
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <span style={{ fontSize: 11, color: "var(--text-4)", display: "flex", alignItems: "center", gap: 4 }}><BookOpen size={10} /> {c.paper_count}p</span>
                        <span style={{ fontSize: 11, color: "var(--text-4)", display: "flex", alignItems: "center", gap: 4 }}><GitBranch size={10} /> {c.claim_ids.length}c</span>
                        <div style={{ flex: 1, height: 3, background: "rgba(255,255,255,0.06)", borderRadius: 999, overflow: "hidden" }}>
                          <div style={{ height: "100%", width: `${density}%`, background: barColor, borderRadius: 999, boxShadow: `0 0 6px ${barColor}88` }} />
                        </div>
                        <span style={{ fontSize: 10, color: "var(--text-4)", flexShrink: 0 }}>{density}%</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
