"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CLAIMS,
  RELS,
  REL_COLOR,
  GEN,
  NODE_GREY,
  NODE_CORE,
  hexA,
  claimById,
  type RelType,
  type Relationship,
} from "@/lib/graph-data";

/**
 * The interactive claim graph — the landing's "wow" instrument.
 *
 * Three depths of interaction, each truer to the product than the last:
 *   hover → illuminate a claim's neighborhood (agreement glides in, conflict
 *           recoils, nuance arcs); everything else dims.
 *   click → open the debate: the two conflicting claims verbatim + the
 *           system's verdict on which side the evidence favors.
 *   drag  → throw a node; the cluster answers with spring physics, proving
 *           this is a live reasoning system, not a picture of one.
 *
 * Meaning lives in the edges: nodes are neutral grey, sized by evidential
 * weight; color belongs to relationships only.
 */

type PNode = {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  weight: number;
  degree: number; // # relationships — drives ring brightness (contestedness)
  fixed: boolean; // pinned while dragged
};

const SPRING: Record<RelType, { rest: number; k: number }> = {
  support: { rest: 88, k: 0.012 }, // pulls together
  contra: { rest: 210, k: 0.010 }, // pushes apart, under tension
  nuance: { rest: 150, k: 0.008 },
};

export function ClaimGraph() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [debate, setDebate] = useState<Relationship | null>(null);
  const [touched, setTouched] = useState(false);

  // adjacency + the strongest contradiction per node (for click → debate)
  const { neighbors, contraForNode } = useMemo(() => {
    const neighbors = new Map<string, Set<string>>();
    const contraForNode = new Map<string, Relationship>();
    CLAIMS.forEach((c) => neighbors.set(c.id, new Set()));
    RELS.forEach((e) => {
      neighbors.get(e.a)!.add(e.b);
      neighbors.get(e.b)!.add(e.a);
      if (e.type === "contra") {
        if (!contraForNode.has(e.a)) contraForNode.set(e.a, e);
        if (!contraForNode.has(e.b)) contraForNode.set(e.b, e);
      }
    });
    return { neighbors, contraForNode };
  }, []);

  // live mutable refs the rAF loop reads without re-subscribing
  const nodesRef = useRef<Map<string, PNode>>(new Map());
  const hoverRef = useRef<string | null>(null);
  const dragRef = useRef<{ id: string; moved: boolean } | null>(null);
  const mouseRef = useRef({ x: 0, y: 0 });

  // hover lives in a ref only — the canvas reads it each frame, so there's no
  // need to re-render React on every pointer move.
  const setHover = useCallback((id: string | null) => {
    hoverRef.current = id;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduce = window.matchMedia("(prefers-reduced-motion:reduce)").matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0,
      H = 0,
      raf = 0,
      t = 0;

    const nodes = nodesRef.current;

    const seed = () => {
      W = wrap.clientWidth;
      H = wrap.clientHeight;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (nodes.size === 0) {
        // seed contradiction cluster left-of-center, consensus right, so the
        // settled layout reads as "two regions of the field".
        const contraSet = new Set(["c1", "c2", "c3", "c4", "c9"]);
        CLAIMS.forEach((c, i) => {
          const left = contraSet.has(c.id);
          const cx = left ? W * 0.36 : W * 0.64;
          const cy = H * 0.5;
          nodes.set(c.id, {
            id: c.id,
            x: cx + (Math.random() - 0.5) * W * 0.28,
            y: cy + (Math.random() - 0.5) * H * 0.55,
            vx: 0,
            vy: 0,
            r: 4 + c.weight * 1.7,
            weight: c.weight,
            degree: neighbors.get(c.id)!.size,
            fixed: false,
          });
          void i;
        });
      }
    };

    const step = () => {
      const arr = [...nodes.values()];
      // pairwise repulsion (n=12 → trivial)
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const a = arr[i],
            b = arr[j];
          const dx = a.x - b.x,
            dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) d2 = 1;
          const d = Math.sqrt(d2);
          const f = Math.min(1600 / d2, 2.4);
          const ux = dx / d,
            uy = dy / d;
          a.vx += ux * f;
          a.vy += uy * f;
          b.vx -= ux * f;
          b.vy -= uy * f;
        }
      }
      // edge springs (support pulls in, contra pushes out)
      for (const e of RELS) {
        const a = nodes.get(e.a)!,
          b = nodes.get(e.b)!;
        const { rest, k } = SPRING[e.type];
        const dx = b.x - a.x,
          dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 1;
        const force = (d - rest) * k;
        const ux = dx / d,
          uy = dy / d;
        a.vx += ux * force;
        a.vy += uy * force;
        b.vx -= ux * force;
        b.vy -= uy * force;
      }
      // gentle centering + integrate
      for (const n of arr) {
        n.vx += (W / 2 - n.x) * 0.0009;
        n.vy += (H / 2 - n.y) * 0.0009;
        n.vx *= 0.86;
        n.vy *= 0.86;
        if (n.fixed) {
          n.x = mouseRef.current.x;
          n.y = mouseRef.current.y;
          n.vx = n.vy = 0;
        } else {
          n.x += n.vx;
          n.y += n.vy;
        }
        const m = 16;
        n.x = Math.max(m, Math.min(W - m, n.x));
        n.y = Math.max(m, Math.min(H - m, n.y));
      }
    };

    const drawEdge = (e: Relationship, lit: boolean, dim: boolean) => {
      const a = nodes.get(e.a)!,
        b = nodes.get(e.b)!;
      const col = REL_COLOR[e.type];
      const dx = b.x - a.x,
        dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 1;
      // perpendicular for curvature
      const px = -dy / dist,
        py = dx / dist;
      const mx = (a.x + b.x) / 2,
        my = (a.y + b.y) / 2;

      let base = e.type === "contra" ? 0.5 : 0.34;
      if (e.type === "support") base = 0.30 + Math.sin(t * 1.6 + a.x * 0.01) * 0.12; // breathe
      let op = base;
      if (lit) op = Math.min(1, base + 0.5);
      if (dim) op *= 0.12;

      ctx.save();
      ctx.strokeStyle = hexA(col, op);
      ctx.lineWidth = e.type === "contra" ? (lit ? 2.1 : 1.5) : lit ? 1.6 : 1.0;

      if (e.type === "contra") {
        // taut + animated current + faint vibration = tension
        const jitter = lit ? Math.sin(t * 9) * 1.2 : Math.sin(t * 7) * 0.4;
        ctx.setLineDash([9, 5]);
        ctx.lineDashOffset = -t * 18;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x + px * jitter, b.y + py * jitter);
        ctx.stroke();
        ctx.setLineDash([]);
        // adjudication arrow toward the favored claim
        if (lit && e.favors && e.favors !== "none") {
          const tgt = e.favors === "a" ? a : b;
          const ang = Math.atan2(tgt.y - my, tgt.x - mx);
          const ax = (a.x + b.x) / 2,
            ay = (a.y + b.y) / 2;
          ctx.fillStyle = hexA(col, 0.95);
          ctx.beginPath();
          ctx.moveTo(ax + Math.cos(ang) * 8, ay + Math.sin(ang) * 8);
          ctx.lineTo(ax + Math.cos(ang + 2.5) * 7, ay + Math.sin(ang + 2.5) * 7);
          ctx.lineTo(ax + Math.cos(ang - 2.5) * 7, ay + Math.sin(ang - 2.5) * 7);
          ctx.closePath();
          ctx.fill();
        }
      } else if (e.type === "nuance") {
        // a bending, dotted arc — it qualifies rather than opposes
        const bow = 22;
        ctx.setLineDash([2, 5]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(mx + px * bow, my + py * bow, b.x, b.y);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        // support: relaxed catenary sag
        const sag = 14;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(mx - px * sag, my - py * sag, b.x, b.y);
        ctx.stroke();
      }
      ctx.restore();
    };

    const drawNode = (n: PNode, lit: boolean, dim: boolean, isHover: boolean) => {
      const contest = Math.min(1, n.degree / 4);
      let ringOp = 0.25 + contest * 0.4;
      let coreOp = 0.6;
      if (lit) {
        ringOp = Math.min(1, ringOp + 0.4);
        coreOp = 0.95;
      }
      if (dim) {
        ringOp *= 0.18;
        coreOp *= 0.2;
      }
      // contestedness halo
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r + 5, 0, 6.28);
      ctx.fillStyle = hexA(NODE_GREY, (dim ? 0.03 : 0.08) * (0.5 + contest));
      ctx.fill();
      // ring
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r + 2, 0, 6.28);
      ctx.strokeStyle = hexA(NODE_CORE, ringOp);
      ctx.lineWidth = 1.2;
      ctx.stroke();
      // core
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, 6.28);
      ctx.fillStyle = hexA(NODE_CORE, coreOp);
      ctx.fill();
      if (isHover) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 8 + Math.sin(t * 4) * 1.5, 0, 6.28);
        ctx.strokeStyle = hexA("#FFFFFF", 0.5);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    };

    const drawLabel = (n: PNode) => {
      const c = claimById(n.id)!;
      ctx.font =
        "12px ui-monospace, SFMono-Regular, Menlo, monospace";
      const text = c.text;
      const tw = Math.min(ctx.measureText(text).width, 300);
      const pad = 9;
      let bx = n.x + n.r + 12;
      let by = n.y - 26;
      const bw = Math.min(tw, 300) + pad * 2;
      const bh = 42;
      if (bx + bw > W) bx = n.x - n.r - 12 - bw;
      if (by < 4) by = 4;
      if (by + bh > H) by = H - bh - 4;
      ctx.fillStyle = "rgba(18,21,28,0.96)";
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.lineWidth = 1;
      roundRect(ctx, bx, by, bw, bh, 7);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#E8EAED";
      ctx.textBaseline = "middle";
      wrapFill(ctx, text, bx + pad, by + 14, bw - pad * 2, 15);
      ctx.fillStyle = "#5E6470";
      ctx.font = "10px ui-sans-serif, system-ui";
      ctx.fillText(c.paper, bx + pad, by + bh - 9);
    };

    const frame = () => {
      if (!reduce) {
        step();
        t += 0.016; // advances breathing, dash-flow + hover pulse
      }
      ctx.clearRect(0, 0, W, H);
      const hv = hoverRef.current;
      const lit = new Set<string>();
      if (hv) {
        lit.add(hv);
        neighbors.get(hv)!.forEach((id) => lit.add(id));
      }
      // edges first
      for (const e of RELS) {
        const isLit = hv ? lit.has(e.a) && lit.has(e.b) : false;
        const isDim = hv ? !(lit.has(e.a) && lit.has(e.b)) : false;
        drawEdge(e, isLit, isDim);
      }
      // nodes
      for (const n of nodes.values()) {
        const isLit = hv ? lit.has(n.id) : false;
        const isDim = hv ? !lit.has(n.id) : false;
        drawNode(n, isLit, isDim, n.id === hv);
      }
      if (hv) drawLabel(nodes.get(hv)!);
      raf = requestAnimationFrame(frame);
    };

    seed();
    if (reduce) {
      for (let i = 0; i < 240; i++) step(); // settle synchronously
    }
    frame();

    // ── pointer handling ──────────────────────────────────────
    const pick = (mx: number, my: number) => {
      let best: PNode | null = null;
      let bd = 26 * 26;
      for (const n of nodes.values()) {
        const dx = n.x - mx,
          dy = n.y - my,
          d2 = dx * dx + dy * dy;
        if (d2 < bd) {
          bd = d2;
          best = n;
        }
      }
      return best;
    };
    const toLocal = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onDown = (e: PointerEvent) => {
      const { x, y } = toLocal(e);
      mouseRef.current = { x, y };
      const n = pick(x, y);
      if (n) {
        dragRef.current = { id: n.id, moved: false };
        n.fixed = true;
        canvas.setPointerCapture(e.pointerId);
        setTouched(true); // no-op once already true; React skips the re-render
      }
    };
    const onMove = (e: PointerEvent) => {
      const { x, y } = toLocal(e);
      mouseRef.current = { x, y };
      if (dragRef.current) {
        dragRef.current.moved = true;
        return;
      }
      const n = pick(x, y);
      if ((n?.id ?? null) !== hoverRef.current) setHover(n?.id ?? null);
      canvas.style.cursor = n ? "grab" : "default";
    };
    const onUp = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (drag) {
        const n = nodes.get(drag.id)!;
        n.fixed = false;
        if (!drag.moved) {
          // a click → open the debate if this claim is contested
          const ce = contraForNode.get(drag.id);
          if (ce) setDebate(ce);
        }
        dragRef.current = null;
        try {
          canvas.releasePointerCapture(e.pointerId);
        } catch {}
      }
    };
    const onLeave = () => {
      if (!dragRef.current) setHover(null);
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointerleave", onLeave);
    const ro = new ResizeObserver(() => {
      const hadNodes = nodes.size > 0;
      const oldW = W,
        oldH = H;
      W = wrap.clientWidth;
      H = wrap.clientHeight;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // rescale positions so layout follows the container
      if (hadNodes && oldW && oldH) {
        for (const n of nodes.values()) {
          n.x *= W / oldW;
          n.y *= H / oldH;
        }
      }
    });
    ro.observe(wrap);

    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      ro.disconnect();
    };
  }, [neighbors, contraForNode, setHover]);

  const aClaim = debate ? claimById(debate.a)! : null;
  const bClaim = debate ? claimById(debate.b)! : null;
  const favored = debate?.favors;

  return (
    <div className="relative">
      <div
        ref={wrapRef}
        className="relative w-full h-[clamp(420px,64vh,680px)] rounded-[var(--r-lg)] border border-[var(--line-2)] overflow-hidden"
        style={{
          background:
            "radial-gradient(120% 90% at 50% 30%, #14171F 0%, var(--canvas) 75%)",
        }}
        data-hot
      >
        <canvas ref={canvasRef} className="absolute inset-0 block touch-none" />

        {/* prompt — fades after first touch */}
        <div
          className="pointer-events-none absolute left-1/2 -translate-x-1/2 top-5 text-[12px] text-[var(--text-3)] flex items-center gap-2 transition-opacity duration-500"
          style={{ opacity: touched ? 0 : 1 }}
        >
          <span
            className="w-[6px] h-[6px] rounded-full bg-[var(--gen)]"
            style={{ boxShadow: "0 0 8px var(--gen-glow)" }}
          />
          Hover a claim · drag it · click a contested one
        </div>

        {/* legend */}
        <div className="pointer-events-none absolute bottom-4 left-4 flex flex-col gap-1.5">
          {(
            [
              ["support", "agrees"],
              ["contra", "contradicts"],
              ["nuance", "qualifies"],
            ] as [RelType, string][]
          ).map(([k, label]) => (
            <span
              key={k}
              className="inline-flex items-center gap-2 text-[11px] text-[var(--text-3)]"
            >
              <span
                className="w-[16px] h-[2px] rounded"
                style={{ background: REL_COLOR[k] }}
              />
              {label}
            </span>
          ))}
        </div>
      </div>

      {/* the debate — click payoff */}
      {debate && aClaim && bClaim && (
        <div
          className="absolute inset-0 z-20 flex items-center justify-center p-4"
          onClick={() => setDebate(null)}
        >
          <div
            className="absolute inset-0 bg-[rgba(8,9,13,0.74)] backdrop-blur-[3px]"
            style={{ animation: "fadeUp .25s ease both" }}
          />
          <div
            className="relative w-full max-w-[640px] bg-[var(--surface-1)] border border-[var(--line-2)] rounded-[var(--r-lg)] p-6 md:p-7"
            style={{ animation: "glowIn .4s cubic-bezier(.16,1,.3,1) both" }}
            onClick={(e) => e.stopPropagation()}
            data-hot
          >
            <div className="flex items-center justify-between mb-5">
              <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.12em] text-[var(--contra)]">
                <span className="w-[7px] h-[7px] rounded-full bg-[var(--contra)]" />
                Contradiction
              </span>
              <button
                onClick={() => setDebate(null)}
                className="text-[12px] text-[var(--text-3)] hover:text-[var(--text-1)] t-all"
                data-hot
              >
                Close ✕
              </button>
            </div>

            <div className="grid md:grid-cols-2 gap-3.5">
              {[
                { c: aClaim, side: "a" },
                { c: bClaim, side: "b" },
              ].map(({ c, side }) => (
                <div
                  key={side}
                  className="rounded-[var(--r-md)] border bg-[var(--surface-2)] px-4 py-3.5"
                  style={{
                    borderColor:
                      favored === side
                        ? "var(--support-line)"
                        : "var(--line)",
                  }}
                >
                  <div className="mono text-[13px] leading-[1.5] text-[var(--text-1)]">
                    {c.text}
                  </div>
                  <div className="mt-2.5 flex items-center justify-between">
                    <span className="text-[11px] text-[var(--text-3)]">
                      {c.paper}
                    </span>
                    {favored === side && (
                      <span className="text-[10.5px] uppercase tracking-[0.1em] text-[var(--support)]">
                        stronger evidence
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {debate.verdict && (
              <div
                className="mt-4 rounded-[var(--r-md)] px-4 py-3.5"
                style={{
                  background: "var(--gen-dim)",
                  border: "1px solid var(--gen-line)",
                }}
              >
                <div
                  className="text-[10.5px] uppercase tracking-[0.12em] mb-1.5 flex items-center gap-2"
                  style={{ color: GEN }}
                >
                  <span
                    className="w-[6px] h-[6px] rounded-full"
                    style={{ background: GEN, boxShadow: `0 0 8px ${hexA(GEN, 0.7)}` }}
                  />
                  ScholarLens verdict
                </div>
                <div className="text-[13.5px] leading-[1.55] text-[var(--text-1)]">
                  {debate.verdict}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── tiny canvas helpers ─────────────────────────────────── */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function wrapFill(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxW: number,
  lh: number
) {
  const words = text.split(" ");
  let line = "";
  let yy = y;
  let lines = 0;
  for (let i = 0; i < words.length && lines < 2; i++) {
    const test = line ? line + " " + words[i] : words[i];
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, yy);
      line = words[i];
      yy += lh;
      lines++;
    } else {
      line = test;
    }
  }
  if (lines < 2) ctx.fillText(line, x, yy);
}
