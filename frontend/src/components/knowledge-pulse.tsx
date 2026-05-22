"use client";

import { useMemo } from "react";

interface PulseNode { id: string; label: string; }
interface PulseEdge { a: number; b: number; type: "contradiction" | "support" | "nuance"; }

const EDGE_COLOR: Record<string, string> = {
  contradiction: "var(--contra)",
  support: "var(--support)",
  nuance: "var(--nuance)",
};

export function KnowledgePulse({ nodes, edges }: { nodes: PulseNode[]; edges: PulseEdge[] }) {
  const W = 1100, H = 120, pad = 40;

  const positions = useMemo(() => {
    const n = nodes.length;
    if (n === 0) return [];
    return nodes.map((_, i) => {
      const x = n === 1 ? W / 2 : pad + (i * (W - pad * 2)) / (n - 1);
      // gentle wave so it doesn't look like a straight line
      const y = H / 2 + Math.sin(i * 1.1) * 22;
      return { x, y };
    });
  }, [nodes]);

  if (nodes.length === 0) {
    return (
      <div className="relative h-[120px] rounded-[var(--r-lg)] bg-[var(--surface-1)] border border-[var(--line)] flex items-center justify-center overflow-hidden">
        <div className="flex items-center gap-6 opacity-40">
          {[0, 1, 2].map((i) => <div key={i} className="w-2.5 h-2.5 rounded-full bg-[var(--text-4)]" />)}
        </div>
        <span className="absolute text-[12px] text-[var(--text-3)]">Add 2+ papers to see connections form</span>
      </div>
    );
  }

  return (
    <div className="relative rounded-[var(--r-lg)] bg-[var(--surface-1)] border border-[var(--line)] overflow-hidden">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 120 }} preserveAspectRatio="none">
        {/* edges */}
        {edges.map((e, i) => {
          const a = positions[e.a], b = positions[e.b];
          if (!a || !b) return null;
          const mx = (a.x + b.x) / 2;
          const my = Math.min(a.y, b.y) - 18;
          const len = Math.hypot(b.x - a.x, b.y - a.y);
          return (
            <path
              key={i}
              d={`M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`}
              fill="none"
              stroke={EDGE_COLOR[e.type]}
              strokeWidth={e.type === "contradiction" ? 1.6 : 1.2}
              strokeOpacity={0.5}
              strokeDasharray={len}
              strokeDashoffset={len}
              style={{ animation: `drawLine 1.2s ${i * 0.08}s cubic-bezier(.16,1,.3,1) forwards` }}
            />
          );
        })}
        {/* nodes */}
        {positions.map((p, i) => (
          <g key={i}>
            <circle cx={p.x} cy={p.y} r="5" fill="var(--surface-3)" stroke="var(--line-3)" strokeWidth="1" />
            <circle cx={p.x} cy={p.y} r="2.5" fill="var(--text-2)" />
          </g>
        ))}
      </svg>
      <style>{`@keyframes drawLine { to { stroke-dashoffset: 0; } }`}</style>
      <div className="absolute top-3 left-4 text-[10px] uppercase tracking-wider text-[var(--text-4)] font-medium">Knowledge pulse · {nodes.length} papers · {edges.length} links</div>
    </div>
  );
}
