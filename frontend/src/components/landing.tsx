"use client";

import {
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import Image from "next/image";
import { LogoBadge } from "@/components/logo";
import { ClaimGraph } from "@/components/claim-graph";
import {
  CLAIMS,
  RELS,
  REL_COLOR,
  GEN,
  hexA,
  HYPOTHESIS,
  claimById,
} from "@/lib/graph-data";
import {
  ArrowRight,
  GraduationCap,
  FlaskConical,
  Users,
  BookOpen,
  Microscope,
  Library as LibraryIcon,
  Upload,
  ScanText,
  Lightbulb,
} from "lucide-react";

/**
 * ScholarLens — public landing experience.
 *
 * Concept: "Science is not papers. It's connected claims."
 * The page is a single argument told in motion — documents dissolve into a
 * living graph of claims, the user interrogates a real contradiction, and a
 * hypothesis is born from the disagreement.
 *
 * Design law: meaning lives in the EDGES. Claims render neutral grey; the
 * relationship palette (contra/support/nuance) and the system's purple voice
 * are the only color. Every motion is gated behind reduced-motion + touch.
 */

const REL3 = ["support", "contra", "nuance"] as const;

/* ════════════════════════════ Custom lens cursor ════════════════════════════ */
/* The pointer becomes the instrument the product is named for. Blend-mode keeps
   it legible on any surface; it swells over anything marked [data-hot]. */
function useLensCursor() {
  const ringRef = useRef<HTMLDivElement>(null);
  const dotRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion:reduce)").matches;
    const touch = window.matchMedia("(hover:none)").matches;
    const ring = ringRef.current;
    const dot = dotRef.current;
    if (reduce || touch || !ring || !dot) return;

    document.documentElement.classList.add("lens-cursor");
    let rx = window.innerWidth / 2,
      ry = window.innerHeight / 2;
    let mx = rx,
      my = ry;
    let raf = 0;

    const loop = () => {
      rx += (mx - rx) * 0.18;
      ry += (my - ry) * 0.18;
      ring.style.transform = `translate(${rx}px,${ry}px)`;
      dot.style.transform = `translate(${mx}px,${my}px)`;
      raf = requestAnimationFrame(loop);
    };
    const move = (e: PointerEvent) => {
      mx = e.clientX;
      my = e.clientY;
      ring.classList.remove("is-hide");
      dot.classList.remove("is-hide");
      const hot = (e.target as HTMLElement)?.closest?.("[data-hot]");
      ring.classList.toggle("is-hot", !!hot);
    };
    const down = () => ring.classList.add("is-down");
    const up = () => ring.classList.remove("is-down");
    const leave = () => {
      ring.classList.add("is-hide");
      dot.classList.add("is-hide");
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);
    document.addEventListener("mouseleave", leave);
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      document.documentElement.classList.remove("lens-cursor");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
      document.removeEventListener("mouseleave", leave);
    };
  }, []);

  return (
    <>
      <div ref={ringRef} className="lens-ring is-hide" aria-hidden />
      <div ref={dotRef} className="lens-dot is-hide" aria-hidden />
    </>
  );
}

/* ════════════════════════════ Magnetic wrapper ════════════════════════════ */
function Magnetic({
  children,
  strength = 0.35,
  className = "",
}: {
  children: ReactNode;
  strength?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (
      window.matchMedia("(prefers-reduced-motion:reduce)").matches ||
      window.matchMedia("(hover:none)").matches
    )
      return;
    let raf = 0;
    let tx = 0,
      ty = 0,
      cx = 0,
      cy = 0;
    const loop = () => {
      cx += (tx - cx) * 0.18;
      cy += (ty - cy) * 0.18;
      el.style.transform = `translate(${cx}px,${cy}px)`;
      raf = requestAnimationFrame(loop);
    };
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const dist = Math.hypot(dx, dy);
      const radius = 90;
      if (dist < radius) {
        tx = dx * strength;
        ty = dy * strength;
      } else {
        tx = 0;
        ty = 0;
      }
    };
    const leave = () => {
      tx = 0;
      ty = 0;
    };
    window.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
    };
  }, [strength]);
  return (
    <span ref={ref} className={`inline-block will-change-transform ${className}`}>
      {children}
    </span>
  );
}

/* ════════════════════════════ Narrative hero canvas ════════════════════════════ */
/* Plays the whole thesis on load: ordered "text" → fracture into claim nodes →
   the system tests connections → relationships lock in → the graph breathes. */
function NarrativeHero() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduce = window.matchMedia("(prefers-reduced-motion:reduce)").matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0,
      H = 0,
      raf = 0,
      t0 = performance.now();
    const mouse = { x: -9999, y: -9999, on: false };

    type N = {
      hx: number;
      hy: number; // home (text layout)
      bw: number; // bar width in text phase
      fx: number;
      fy: number; // free (graph layout)
      x: number;
      y: number;
      vx: number;
      vy: number;
      r: number;
    };
    type E = { a: number; b: number; type: (typeof REL3)[number]; ph: number };
    let nodes: N[] = [];
    let edges: E[] = [];

    const build = () => {
      const mobile = W < 760;
      nodes = [];
      // ── home layout: columns of "text lines" (bars) ──
      const cols = mobile ? 2 : 3;
      const colW = W / cols;
      const rows = mobile ? 6 : 7;
      const blockTop = H * 0.2;
      const rowGap = (H * 0.6) / rows;
      for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) {
          const barsInRow = 1 + (Math.random() < 0.5 ? 1 : 0);
          let xCursor = c * colW + colW * 0.18;
          for (let k = 0; k < barsInRow; k++) {
            const bw = colW * (0.18 + Math.random() * 0.34);
            nodes.push({
              hx: xCursor,
              hy: blockTop + r * rowGap,
              bw,
              fx: W * 0.5 + (Math.random() - 0.5) * W * 0.66,
              fy: H * 0.5 + (Math.random() - 0.5) * H * 0.62,
              x: xCursor,
              y: blockTop + r * rowGap,
              vx: 0,
              vy: 0,
              r: 1.6 + Math.random() * 2.4,
            });
            xCursor += bw + colW * 0.07;
          }
        }
      }
      // ── relationships among the resulting nodes ──
      edges = [];
      const ec = Math.min(nodes.length, mobile ? 16 : 30);
      for (let i = 0; i < ec; i++) {
        const a = Math.floor(Math.random() * nodes.length);
        let b = Math.floor(Math.random() * nodes.length);
        if (a === b) b = (b + 1) % nodes.length;
        edges.push({
          a,
          b,
          type: REL3[Math.floor(Math.random() * 3)],
          ph: Math.random() * 6.28,
        });
      }
    };

    const resize = () => {
      W = canvas.clientWidth;
      H = canvas.clientHeight;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      build();
      t0 = performance.now();
    };

    const ease = (x: number) => 1 - Math.pow(1 - x, 3);
    const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

    const draw = (now: number) => {
      const t = (now - t0) / 1000;
      // phase progress
      const pFrac = clamp01((t - 0.8) / 1.4); // 0.8→2.2 fracture
      const pSearch = clamp01((t - 2.2) / 1.4); // 2.2→3.6 search
      const pLock = clamp01((t - 3.6) / 1.4); // 3.6→5.0 lock-in
      const breathing = t > 5.0;
      const fe = ease(pFrac);

      ctx.clearRect(0, 0, W, H);

      // position: home → free
      for (const n of nodes) {
        const baseX = n.hx + n.bw / 2;
        if (!breathing) {
          n.x = baseX + (n.fx - baseX) * fe;
          n.y = n.hy + (n.fy - n.hy) * fe;
        } else {
          // ambient drift + cursor influence
          n.x += n.vx;
          n.y += n.vy;
          if (mouse.on) {
            const dx = mouse.x - n.x,
              dy = mouse.y - n.y,
              d2 = dx * dx + dy * dy;
            if (d2 < 42000 && d2 > 1) {
              const f = 110 / d2;
              n.vx += dx * f * 0.0009;
              n.vy += dy * f * 0.0009;
            }
          }
          n.vx *= 0.99;
          n.vy *= 0.99;
          n.vx = Math.max(-0.32, Math.min(0.32, n.vx));
          n.vy = Math.max(-0.32, Math.min(0.32, n.vy));
          if (n.x < 0 || n.x > W) n.vx *= -1;
          if (n.y < 0 || n.y > H) n.vy *= -1;
        }
      }

      // ── TEXT bars (fade out as fracture completes) ──
      if (pFrac < 1) {
        const barOp = (1 - fe) * 0.5;
        ctx.fillStyle = hexA("#5E6470", barOp);
        for (const n of nodes) {
          const w = n.bw * (1 - fe);
          if (w < 1) continue;
          ctx.fillRect(n.hx, n.hy - 1.4, w, 2.8);
        }
      }

      // ── candidate edges flicker (search phase) ──
      if (pSearch > 0 && pLock < 1) {
        const seed = Math.floor(t * 14);
        for (let i = 0; i < edges.length; i++) {
          const e = edges[i];
          if (((seed + i) % 3) !== 0) continue; // flicker subset
          const a = nodes[e.a],
            b = nodes[e.b];
          if (!a || !b) continue;
          ctx.strokeStyle = hexA("#5E6470", 0.18 * pSearch * (1 - pLock));
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }

      // ── committed colored edges (lock-in → breathe) ──
      if (pLock > 0) {
        for (const e of edges) {
          const a = nodes[e.a],
            b = nodes[e.b];
          if (!a || !b) continue;
          const dist = Math.hypot(b.x - a.x, b.y - a.y);
          const maxD = W < 760 ? 230 : 300;
          if (dist > maxD) continue;
          const fade = 1 - dist / maxD;
          const breathe = 0.34 + Math.sin(t * 0.8 + e.ph) * 0.14;
          const op = fade * breathe * pLock;
          const col = REL_COLOR[e.type];
          const mx = (a.x + b.x) / 2,
            my = (a.y + b.y) / 2 - dist * 0.1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.quadraticCurveTo(mx, my, b.x, b.y);
          ctx.strokeStyle = hexA(col, op);
          ctx.lineWidth = e.type === "contra" ? 1.4 : 1.0;
          ctx.stroke();
        }
      }

      // ── nodes ──
      for (const n of nodes) {
        const appear = ease(clamp01((t - 1.0) / 1.2));
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 2.4, 0, 6.28);
        ctx.fillStyle = hexA("#5E6470", 0.09 * appear);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, 6.28);
        ctx.fillStyle = hexA("#9BA1AD", 0.55 * appear);
        ctx.fill();
      }

      raf = requestAnimationFrame(draw);
    };

    const staticDraw = () => {
      ctx.clearRect(0, 0, W, H);
      for (const e of edges) {
        const a = nodes[e.a],
          b = nodes[e.b];
        if (!a || !b) continue;
        a.x = a.fx;
        a.y = a.fy;
        b.x = b.fx;
        b.y = b.fy;
        ctx.strokeStyle = hexA(REL_COLOR[e.type], 0.3);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(a.fx, a.fy);
        ctx.lineTo(b.fx, b.fy);
        ctx.stroke();
      }
      for (const n of nodes) {
        ctx.beginPath();
        ctx.arc(n.fx, n.fy, n.r, 0, 6.28);
        ctx.fillStyle = hexA("#9BA1AD", 0.55);
        ctx.fill();
      }
    };

    const onMove = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      if (e.clientY < r.bottom) {
        mouse.x = e.clientX - r.left;
        mouse.y = e.clientY - r.top;
        mouse.on = true;
      } else mouse.on = false;
    };
    const onOut = () => (mouse.on = false);

    resize();
    if (reduce) staticDraw();
    else raf = requestAnimationFrame(draw);
    window.addEventListener("resize", resize);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseout", onOut);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseout", onOut);
    };
  }, []);

  return <canvas ref={ref} className="absolute inset-0 w-full h-full block" />;
}

/* ════════════════════════════ Kinetic headline ════════════════════════════ */
/* "Science is not papers." → "It's connected claims." The keyword's letters
   repel from the cursor — the typography enacts the idea. */
function KineticHeadline() {
  const wrapRef = useRef<HTMLHeadingElement>(null);

  // Word entrance is pure CSS (so the SSR'd headline animates without JS). This
  // effect only adds the cursor-repel enhancement on the keyword's letters.
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion:reduce)").matches;
    const root = wrapRef.current;
    if (reduce || !root) return;

    // Cache glyph centers — measuring getBoundingClientRect every frame forces a
    // layout/paint. Re-measure on resize and once the reveal + webfont settle.
    const chars = Array.from(root.querySelectorAll<HTMLElement>(".kin-char.react"));
    let centers: { el: HTMLElement; cx: number; cy: number }[] = [];
    const measure = () => {
      centers = chars.map((el) => {
        const r = el.getBoundingClientRect();
        return { el, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
      });
    };
    const measureTimer = window.setTimeout(measure, 900);

    let raf = 0;
    let px = -9999,
      py = -9999;
    let dirty = false;
    const onMove = (e: PointerEvent) => {
      px = e.clientX;
      py = e.clientY;
      dirty = true;
    };
    const loop = () => {
      if (dirty) {
        for (const c of centers) {
          const dx = c.cx - px,
            dy = c.cy - py,
            d = Math.hypot(dx, dy) || 1;
          const radius = 80;
          if (d < radius) {
            const f = (1 - d / radius) * 16;
            c.el.style.setProperty("--tx", `${(dx / d) * f}px`);
            c.el.style.setProperty("--ty", `${(dy / d) * f}px`);
          } else {
            c.el.style.setProperty("--tx", `0px`);
            c.el.style.setProperty("--ty", `0px`);
          }
        }
      }
      raf = requestAnimationFrame(loop);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("resize", measure);
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(measureTimer);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("resize", measure);
    };
  }, []);

  const keyword = "claims";
  // running index → staggered CSS animation-delay across both lines
  let wi = 0;
  const delay = () => ({ animationDelay: `${0.1 + wi++ * 0.05}s` });

  return (
    <h1
      ref={wrapRef}
      className="font-display text-[clamp(40px,6.6vw,82px)] leading-[1.0] tracking-[-0.025em]"
    >
      <span className="kin-line block">
        {"Science is not".split(" ").map((w, i) => (
          <span key={i} className="kin-word mr-[0.22em]" style={delay()}>
            {w}
          </span>
        ))}
        <span className="kin-word relative" style={delay()}>
          <span className="text-[var(--text-2)]">papers</span>
          <span className="strike-papers" aria-hidden />
        </span>
        <span className="kin-word" style={delay()}>
          .
        </span>
      </span>
      <span className="kin-line block mt-[0.06em]">
        {"It's connected".split(" ").map((w, i) => (
          <span key={i} className="kin-word mr-[0.22em]" style={delay()}>
            {w}
          </span>
        ))}
        <span className="kin-word italic text-[var(--gen)]" style={delay()}>
          {keyword.split("").map((c, i) => (
            <span key={i} className="kin-char react">
              {c}
            </span>
          ))}
          <span className="not-italic">.</span>
        </span>
      </span>
    </h1>
  );
}

/* ════════════════════════════ Claim marquee ════════════════════════════ */
const MARQUEE_ITEMS = CLAIMS.map((c) => c.text);

function MarqueeRow({ rev }: { rev?: boolean }) {
  return (
    <div className="marquee-host overflow-hidden marquee-mask py-1">
      <div className={`marquee-track ${rev ? "rev" : ""}`}>
        {[...MARQUEE_ITEMS, ...MARQUEE_ITEMS].map((tx, i) => (
          <span
            key={i}
            className="mono text-[13px] text-[var(--text-muted)] whitespace-nowrap mx-5 inline-flex items-center gap-2.5"
          >
            <span className="text-[var(--text-4)]">▸</span>
            {tx}
          </span>
        ))}
      </div>
    </div>
  );
}

function ClaimMarquee() {
  return (
    <div className="border-y border-[var(--line)] bg-[var(--surface-1)] py-5 flex flex-col gap-1">
      <MarqueeRow />
      <MarqueeRow rev />
    </div>
  );
}

/* ════════════════════════════ Animated counter ════════════════════════════ */
function Counter({ to, suffix = "" }: { to: number; suffix?: string }) {
  const [n, setN] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion:reduce)").matches;
    let started = false;
    const io = new IntersectionObserver(
      (es) =>
        es.forEach((e) => {
          if (e.isIntersecting && !started) {
            started = true;
            if (reduce) {
              setN(to);
              return;
            }
            const dur = 1100;
            const t0 = performance.now();
            const tick = (now: number) => {
              const p = Math.min(1, (now - t0) / dur);
              setN(Math.round((1 - Math.pow(1 - p, 3)) * to));
              if (p < 1) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }
        }),
      { threshold: 0.6 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [to]);
  return (
    <span ref={ref} className="tabular-nums">
      {n}
      {suffix}
    </span>
  );
}

/* ════════════════════════════ Generation scene ════════════════════════════ */
/* Contradiction → hypothesis. The system's purple voice nucleates from the
   conflict it just resolved. */
function GenerationScene() {
  const ref = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (es) => es.forEach((e) => e.isIntersecting && setShow(true)),
      { threshold: 0.45 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const sources = HYPOTHESIS.from.map((id) => claimById(id)!);

  return (
    <div ref={ref} className="grid md:grid-cols-[1fr_1.1fr] gap-10 items-center">
      {/* source claims feeding in */}
      <div className="flex flex-col gap-3">
        {sources.map((c, i) => (
          <div
            key={c.id}
            className="rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-2)] px-4 py-3 mono text-[12.5px] leading-[1.5] text-[var(--text-2)] transition-all duration-700"
            style={{
              opacity: show ? 1 : 0,
              transform: show ? "translateX(0)" : "translateX(-14px)",
              transitionDelay: `${i * 130}ms`,
            }}
          >
            <span className="text-[var(--text-4)]">▸ </span>
            {c.text}
            <span className="block mt-1 text-[10.5px] not-italic text-[var(--text-3)] font-sans">
              {c.paper}
            </span>
          </div>
        ))}
      </div>

      {/* the generated hypothesis */}
      <div
        className="relative rounded-[var(--r-lg)] p-6 md:p-7 transition-all duration-700"
        style={{
          background: "var(--gen-dim)",
          border: "1px solid var(--gen-line)",
          boxShadow: show ? "0 0 60px -20px var(--gen-glow)" : "none",
          opacity: show ? 1 : 0,
          transform: show ? "translateY(0) scale(1)" : "translateY(16px) scale(0.98)",
          transitionDelay: "420ms",
        }}
      >
        <div
          className="text-[10.5px] uppercase tracking-[0.12em] mb-3 flex items-center gap-2"
          style={{ color: GEN }}
        >
          <span
            className="w-[7px] h-[7px] rounded-full"
            style={{ background: GEN, boxShadow: `0 0 10px ${hexA(GEN, 0.7)}` }}
          />
          Generated hypothesis
        </div>
        <p className="font-display text-[clamp(18px,2.2vw,24px)] leading-[1.3] text-[var(--text-1)]">
          {HYPOTHESIS.text}
        </p>
        <p className="text-[12px] text-[var(--text-3)] mt-4">{HYPOTHESIS.novelty}</p>
      </div>
    </div>
  );
}

/* ════════════════════════════ Lens band (x-ray) ════════════════════════════ */
const LENS_LINES = CLAIMS.map((c) => c.text);

function LensBand() {
  const stageRef = useRef<HTMLDivElement>(null);
  const lensRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const wallText = LENS_LINES.map((l) => "▸ " + l).join("     ");

  const move = useCallback((x: number, y: number) => {
    const stage = stageRef.current,
      lens = lensRef.current,
      content = contentRef.current;
    if (!stage || !lens || !content) return;
    lens.style.left = x + "px";
    lens.style.top = y + "px";
    lens.style.opacity = "1";
    content.style.left = -x + 95 + "px";
    content.style.top = -y + 95 + "px";
    content.style.width = stage.clientWidth + "px";
  }, []);

  useEffect(() => {
    const stage = stageRef.current,
      lens = lensRef.current;
    if (!stage || !lens) return;
    const reduce = window.matchMedia("(prefers-reduced-motion:reduce)").matches;
    move(stage.clientWidth * 0.5, 150);
    lens.style.opacity = "0";

    let demoed = false;
    const io = new IntersectionObserver(
      (es) =>
        es.forEach((e) => {
          if (e.isIntersecting && !demoed && !reduce) {
            demoed = true;
            let p = 0;
            const Wd = stage.clientWidth;
            const iv = setInterval(() => {
              p += 0.025;
              if (p >= 1) {
                clearInterval(iv);
                setTimeout(() => (lens.style.opacity = "0"), 400);
                return;
              }
              move(Wd * (0.2 + p * 0.6), 90 + Math.sin(p * Math.PI * 2) * 70);
            }, 28);
          }
        }),
      { threshold: 0.5 }
    );
    io.observe(stage);
    return () => io.disconnect();
  }, [move]);

  return (
    <div
      ref={stageRef}
      data-hot
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        move(e.clientX - r.left, e.clientY - r.top);
      }}
      onMouseLeave={() => {
        if (lensRef.current) lensRef.current.style.opacity = "0";
      }}
      className="relative h-[300px] rounded-[var(--r-lg)] border border-[var(--line)] bg-[var(--surface-1)] overflow-hidden cursor-crosshair"
    >
      <div className="absolute top-3 left-4 text-[11px] text-[var(--text-3)] pointer-events-none z-10">
        {CLAIMS.length} claims buried in {new Set(CLAIMS.map((c) => c.paper)).size} papers
      </div>
      <div className="absolute inset-0 px-7 py-6 mono text-[12.5px] leading-[2] text-[var(--text-3)] blur-[3.6px] opacity-50 select-none break-words">
        {wallText}
      </div>
      <div
        ref={lensRef}
        className="absolute w-[190px] h-[190px] rounded-full pointer-events-none -translate-x-1/2 -translate-y-1/2 overflow-hidden bg-[var(--surface-2)] opacity-0 transition-opacity duration-200"
        style={{
          border: "1px solid var(--gen-line)",
          boxShadow: "0 0 40px -10px var(--gen-glow), inset 0 0 30px -16px var(--gen-glow)",
        }}
      >
        <div
          ref={contentRef}
          className="absolute px-7 py-6 mono text-[12.5px] leading-[2] text-[var(--text-1)]"
        >
          {LENS_LINES.map((l, i) => (
            <span key={i}>
              <span style={{ color: REL_COLOR[REL3[i % 3]] }}>▸</span> {l}
              {"     "}
            </span>
          ))}
        </div>
      </div>
      <div className="absolute bottom-3 right-4 text-[11px] text-[var(--text-4)] pointer-events-none">
        move the lens to read what&apos;s buried
      </div>
    </div>
  );
}

/* ════════════════════════════ How it works ════════════════════════════ */
function HowItWorks() {
  const steps = [
    {
      Icon: Upload,
      title: "Drop in your papers",
      body: "Any number, any field. ScholarLens reads the full text — not just abstracts.",
    },
    {
      Icon: ScanText,
      title: "Every claim, extracted",
      body: "Findings pulled as the exact sentence they appear in. Nothing paraphrased, nothing invented.",
    },
    {
      Icon: Lightbulb,
      title: "The debate, mapped",
      body: "See where claims agree, where they contradict, and the hypothesis hiding in the disagreement.",
    },
  ];
  return (
    <section className="px-6 pb-[100px] max-w-[1080px] mx-auto">
      <div className="reveal relative grid md:grid-cols-3 gap-6">
        <div
          className="hidden md:block absolute top-[38px] left-[calc(16.67%+20px)] right-[calc(16.67%+20px)] h-px"
          style={{
            background:
              "linear-gradient(90deg, var(--gen-line), var(--line-2), var(--gen-line))",
          }}
        />
        {steps.map(({ Icon, title, body }, i) => (
          <div
            key={i}
            className="relative bg-[var(--surface-1)] border border-[var(--line)] rounded-[var(--r-lg)] px-6 py-6 flex flex-col"
          >
            <div className="flex items-center gap-3 mb-5">
              <span
                className="inline-flex items-center justify-center w-[38px] h-[38px] rounded-full bg-[var(--gen-dim)] text-[var(--gen)] shrink-0 z-10"
                style={{ border: "1px solid var(--gen-line)" }}
              >
                <Icon size={16} />
              </span>
              {i < 2 && (
                <ArrowRight
                  size={14}
                  className="hidden md:block text-[var(--gen)] opacity-40 absolute right-[-19px] top-[12px] z-10"
                />
              )}
            </div>
            <h3 className="font-display text-[16px] leading-[1.25] text-[var(--text-1)] mb-2">
              {title}
            </h3>
            <p className="text-[13.5px] leading-[1.65] text-[var(--text-2)] flex-1">
              {body}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ════════════════════════════ Product showcase (tilt) ════════════════════════════ */
function ShowcaseRow({
  flip,
  title,
  copy,
  outcome,
  src,
  alt,
  barTitle,
}: {
  flip?: boolean;
  title: string;
  copy: string;
  outcome: string;
  src: string;
  alt: string;
  barTitle: string;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const onMove = (e: React.MouseEvent) => {
    const el = cardRef.current;
    if (!el) return;
    if (window.matchMedia("(hover:none)").matches) return;
    const r = el.getBoundingClientRect();
    const rx = ((e.clientY - r.top) / r.height - 0.5) * -6;
    const ry = ((e.clientX - r.left) / r.width - 0.5) * 6;
    el.style.setProperty("--rx", `${rx}deg`);
    el.style.setProperty("--ry", `${ry}deg`);
  };
  const reset = () => {
    const el = cardRef.current;
    if (!el) return;
    el.style.setProperty("--rx", "0deg");
    el.style.setProperty("--ry", "0deg");
  };
  return (
    <div
      className={`grid md:grid-cols-2 gap-10 items-center mt-24 ${
        flip ? "md:[&>*:first-child]:order-2" : ""
      }`}
    >
      <div>
        <h3 className="font-display text-[clamp(22px,2.6vw,30px)] leading-[1.1] text-[var(--text-1)] mb-3.5">
          {title}
        </h3>
        <p className="text-[14.5px] leading-[1.6] text-[var(--text-2)]">{copy}</p>
        <div className="inline-flex items-center gap-2 mt-4 text-[12.5px] text-[var(--gen)]">
          <ArrowRight size={13} />
          {outcome}
        </div>
      </div>
      <div
        ref={cardRef}
        onMouseMove={onMove}
        onMouseLeave={reset}
        className="tilt bg-[var(--surface-1)] border border-[var(--line-2)] rounded-[var(--r-lg)] overflow-hidden"
        style={{ boxShadow: "0 30px 60px -30px rgba(0,0,0,0.6)" }}
        data-hot
      >
        <div className="flex items-center gap-1.5 px-3.5 py-[11px] border-b border-[var(--line)] bg-[var(--surface-2)]">
          <i className="w-[9px] h-[9px] rounded-full bg-[var(--surface-3)]" />
          <i className="w-[9px] h-[9px] rounded-full bg-[var(--surface-3)]" />
          <i className="w-[9px] h-[9px] rounded-full bg-[var(--surface-3)]" />
          <span className="text-[11px] text-[var(--text-3)] ml-2">{barTitle}</span>
        </div>
        <Image
          src={src}
          alt={alt}
          width={1200}
          height={760}
          className="w-full h-auto block"
          unoptimized
        />
      </div>
    </div>
  );
}

/* ════════════════════════════ Page ════════════════════════════ */
export default function Landing({ onSignIn }: { onSignIn: () => void }) {
  const go = onSignIn;
  const cursor = useLensCursor();

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion:reduce)").matches;
    const els = Array.from(document.querySelectorAll<HTMLElement>(".reveal, .clip-reveal"));
    if (reduce) {
      els.forEach((e) => e.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver(
      (es) =>
        es.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        }),
      { threshold: 0.18 }
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);

  const contraCount = RELS.filter((r) => r.type === "contra").length;
  const paperCount = new Set(CLAIMS.map((c) => c.paper)).size;

  const builtFor = [
    { icon: GraduationCap, label: "PhD students lost in a growing literature review" },
    { icon: FlaskConical, label: "Labs that can't keep pace with their field" },
    { icon: BookOpen, label: "Professors curating a focused reading list" },
    { icon: Microscope, label: "Master's students hunting for a thesis gap" },
    { icon: Users, label: "Independent researchers without a lab behind them" },
    { icon: LibraryIcon, label: "Anyone holding more papers than they can keep straight" },
  ];

  return (
    <div className="bg-[var(--canvas)] text-[var(--text-1)]">
      {cursor}

      {/* nav */}
      <nav className="fixed top-0 left-0 right-0 z-30 h-[60px] flex items-center justify-between px-7 backdrop-blur-[10px] bg-gradient-to-b from-[rgba(11,13,18,0.85)] to-transparent">
        <div className="flex items-center gap-3">
          <LogoBadge size={28} />
          <span className="font-display text-[17px]">ScholarLens</span>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="#graph"
            data-hot
            className="hidden sm:block text-[13.5px] text-[var(--text-2)] px-3.5 py-2 rounded-[var(--r-md)] t-all hover:text-[var(--text-1)] hover:bg-[var(--surface-2)]"
          >
            The graph
          </a>
          <a
            href="#product"
            data-hot
            className="hidden sm:block text-[13.5px] text-[var(--text-2)] px-3.5 py-2 rounded-[var(--r-md)] t-all hover:text-[var(--text-1)] hover:bg-[var(--surface-2)]"
          >
            Product
          </a>
          <button
            onClick={go}
            data-hot
            className="hidden sm:block text-[13.5px] text-[var(--text-2)] px-3.5 py-2 rounded-[var(--r-md)] t-all hover:text-[var(--text-1)] hover:bg-[var(--surface-2)]"
          >
            Sign in
          </button>
          <Magnetic>
            <button
              onClick={go}
              data-hot
              className="inline-flex items-center gap-1.5 text-[13.5px] font-medium text-white bg-[#6a5cea] px-4 py-2 rounded-[var(--r-md)] t-all hover:opacity-90 hover:glow-gen"
            >
              Get started <ArrowRight size={14} />
            </button>
          </Magnetic>
        </div>
      </nav>

      {/* hero */}
      <header className="relative min-h-screen flex items-center justify-center overflow-hidden">
        <NarrativeHero />
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              "radial-gradient(120% 90% at 50% 42%, transparent 28%, rgba(11,13,18,0.6) 70%, var(--canvas) 100%)",
          }}
        />
        <div className="relative z-[5] text-center px-6 max-w-[920px]">
          <div
            className="inline-flex items-center gap-2 text-[12px] text-[var(--text-2)] bg-[var(--surface-2)] border border-[var(--line-2)] pl-[11px] pr-[13px] py-1.5 rounded-full mb-[30px] fade-up"
          >
            <span
              className="w-[6px] h-[6px] rounded-full bg-[var(--gen)]"
              style={{ boxShadow: "0 0 8px var(--gen-glow)" }}
            />
            A new way of reading the literature
          </div>

          <KineticHeadline />

          <p
            className="text-[clamp(15px,1.9vw,18.5px)] leading-[1.55] text-[var(--text-2)] max-w-[600px] mx-auto mt-7 fade-up"
            style={{ animationDelay: "0.55s" }}
          >
            ScholarLens reads the literature down to its atomic claims and maps how they
            support, contradict, and refine one another — so you explore the debate, not
            the documents.
          </p>

          <div
            className="flex flex-col items-center mt-9 fade-up"
            style={{ animationDelay: "0.75s" }}
          >
            <div className="flex gap-3 justify-center items-center flex-wrap">
              <Magnetic>
                <button
                  onClick={go}
                  data-hot
                  className="inline-flex items-center gap-2 text-[14.5px] font-medium text-white bg-[#6a5cea] px-[22px] py-3 rounded-[var(--r-md)] t-all hover:opacity-90 hover:glow-gen"
                >
                  Open the graph <ArrowRight size={15} />
                </button>
              </Magnetic>
              <a
                href="#graph"
                data-hot
                className="inline-flex items-center gap-2 text-[14.5px] text-[var(--text-1)] border border-[var(--line-3)] bg-[var(--surface-2)] px-5 py-3 rounded-[var(--r-md)] t-all hover:border-[rgba(255,255,255,0.22)] hover:bg-[var(--surface-3)]"
              >
                See it think
              </a>
            </div>
            <p className="text-[12.5px] text-[var(--text-muted)] mt-4">
              Free to start · no credit card needed
            </p>
          </div>

          <div
            className="flex gap-5 justify-center mt-12 flex-wrap fade-up"
            style={{ animationDelay: "0.95s" }}
          >
            {REL3.map((k) => (
              <span
                key={k}
                className="inline-flex items-center gap-2 text-[12.5px] text-[var(--text-3)] capitalize"
              >
                <span
                  className="w-[18px] h-[2px] rounded-[2px]"
                  style={{ background: REL_COLOR[k] }}
                />
                {k === "contra" ? "Contradiction" : k === "support" ? "Support" : "Nuance"}
              </span>
            ))}
          </div>
        </div>
      </header>

      {/* marquee of verbatim claims */}
      <ClaimMarquee />

      {/* problem → extraction (the lens reveals what's buried) */}
      <section className="px-6 py-[110px] max-w-[1080px] mx-auto">
        <div className="reveal text-[11px] uppercase tracking-[0.14em] text-[var(--gen)] font-medium mb-3.5">
          The problem
        </div>
        <h2 className="reveal font-display text-[clamp(28px,3.6vw,46px)] leading-[1.08] max-w-[680px]">
          A paper is a sealed box. The knowledge is the claims inside it.
        </h2>
        <p className="reveal text-[16px] leading-[1.6] text-[var(--text-2)] max-w-[600px] mt-[18px]">
          Everything a field knows is locked in documents that don&apos;t talk to each other.
          ScholarLens reads each one down to its atomic claims — verbatim, traced to the exact
          sentence. Move the lens to see them surface.
        </p>
        <div className="reveal mt-12">
          <LensBand />
        </div>
      </section>

      {/* the graph — the wow */}
      <div id="graph" className="border-y border-[var(--line)]" style={{ background: "var(--surface-1)" }}>
        <section className="px-6 py-[110px] max-w-[1080px] mx-auto">
          <div className="reveal text-[11px] uppercase tracking-[0.14em] text-[var(--gen)] font-medium mb-3.5">
            The instrument
          </div>
          <h2 className="reveal font-display text-[clamp(28px,3.6vw,46px)] leading-[1.08] max-w-[700px]">
            Stop reading papers. Start exploring the debate.
          </h2>
          <p className="reveal text-[16px] leading-[1.6] text-[var(--text-2)] max-w-[600px] mt-[18px] mb-10">
            This is a live slice of a real corpus. Agreement pulls claims together;
            contradiction holds them apart under tension. Hover to trace a claim&apos;s
            neighborhood, drag to feel the field respond, and click a contested claim to
            see the verdict.
          </p>
          <div className="reveal">
            <ClaimGraph />
          </div>
        </section>
      </div>

      {/* generation — contradiction becomes hypothesis */}
      <section className="px-6 py-[110px] max-w-[1080px] mx-auto">
        <div className="reveal text-[11px] uppercase tracking-[0.14em] text-[var(--gen)] font-medium mb-3.5">
          What comes out
        </div>
        <h2 className="reveal font-display text-[clamp(28px,3.6vw,46px)] leading-[1.08] max-w-[680px]">
          Every unresolved contradiction is a hypothesis waiting.
        </h2>
        <p className="reveal text-[16px] leading-[1.6] text-[var(--text-2)] max-w-[600px] mt-[18px] mb-12">
          ScholarLens reads the conflicts and gaps in your library and proposes directions that
          follow from them — each grounded in the exact claims that motivated it.
        </p>
        <div className="reveal">
          <GenerationScene />
        </div>
      </section>

      {/* metrics */}
      <div className="border-y border-[var(--line)]" style={{ background: "var(--surface-1)" }}>
        <section className="reveal px-6 py-[70px] max-w-[1080px] mx-auto grid grid-cols-2 md:grid-cols-4 gap-8 text-center">
          {[
            { to: CLAIMS.length, label: "claims extracted" },
            { to: RELS.length, label: "relationships mapped" },
            { to: contraCount, label: "contradictions found" },
            { to: paperCount, label: "papers, one graph" },
          ].map((m, i) => (
            <div key={i}>
              <div className="font-display text-[clamp(34px,5vw,56px)] text-[var(--text-1)] leading-none">
                <Counter to={m.to} />
              </div>
              <div className="text-[12.5px] text-[var(--text-3)] mt-2.5">{m.label}</div>
            </div>
          ))}
        </section>
      </div>

      {/* how it works */}
      <section className="px-6 pt-[110px]">
        <div className="reveal text-center max-w-[640px] mx-auto mb-12">
          <div className="text-[11px] uppercase tracking-[0.14em] text-[var(--gen)] font-medium mb-3.5">
            The method
          </div>
          <h2 className="font-display text-[clamp(26px,3.4vw,40px)] leading-[1.1]">
            Three steps from a folder of PDFs to a field you can see.
          </h2>
        </div>
      </section>
      <HowItWorks />

      {/* product showcase */}
      <section id="product" className="px-6 pb-[110px] max-w-[1080px] mx-auto">
        <div className="reveal text-[11px] uppercase tracking-[0.14em] text-[var(--gen)] font-medium mb-3.5">
          The product
        </div>
        <h2 className="reveal font-display text-[clamp(28px,3.6vw,44px)] leading-[1.08] max-w-[640px]">
          Built to be looked through, not just read.
        </h2>

        <div className="reveal">
          <ShowcaseRow
            title="The conflict map"
            copy="Every paper in your library, compared claim by claim. ScholarLens finds which pairs actually contradict each other, judges which side has stronger evidence, and suggests how the disagreement could be resolved."
            outcome="A verdict on every disagreement, with reasoning"
            src="/shots/conflict-map.png"
            alt="ScholarLens conflict map showing claim-against-claim contradictions with adjudication"
            barTitle="scholarlens · conflict map"
          />
        </div>
        <div className="reveal">
          <ShowcaseRow
            flip
            title="The knowledge graph"
            copy="Every claim in your library, laid out as a graph. Claims that agree cluster together; contradictions push apart. Node size reflects how often a claim appears across papers."
            outcome="The whole field in one view"
            src="/shots/knowledge-graph.png"
            alt="ScholarLens knowledge graph of claims connected by relationship type"
            barTitle="scholarlens · knowledge graph"
          />
        </div>
        <div className="reveal">
          <ShowcaseRow
            title="The generative bench"
            copy="ScholarLens reads the gaps and conflicts in your library and proposes hypotheses that follow from them. Each one links to the specific claims that motivated it, with a novelty score based on how much of the direction your library already covers."
            outcome="Directions grounded in what the field actually says"
            src="/shots/hypotheses.png"
            alt="ScholarLens generative bench showing a ranked, grounded hypothesis"
            barTitle="scholarlens · hypotheses"
          />
        </div>
      </section>

      {/* built for */}
      <div className="border-y border-[var(--line)]" style={{ background: "var(--surface-1)" }}>
        <section className="px-6 py-[110px] max-w-[1080px] mx-auto">
          <div className="reveal text-[11px] uppercase tracking-[0.14em] text-[var(--gen)] font-medium mb-3.5">
            Built for
          </div>
          <h2 className="reveal font-display text-[clamp(28px,3.6vw,44px)] leading-[1.08] max-w-[640px]">
            Anyone who has to hold a whole literature in their head.
          </h2>
          <div className="reveal grid sm:grid-cols-2 md:grid-cols-3 gap-3 mt-10">
            {builtFor.map(({ icon: Icon, label }) => (
              <div
                key={label}
                className="bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-md)] px-[18px] py-[18px] flex items-center gap-3.5"
              >
                <span className="inline-flex items-center justify-center w-[34px] h-[34px] rounded-[var(--r-sm)] bg-[var(--gen-dim)] text-[var(--gen)] shrink-0">
                  <Icon size={17} />
                </span>
                <span className="text-[14px] text-[var(--text-1)]">{label}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* close */}
      <section className="relative text-center px-6 pt-[130px] pb-[100px] overflow-hidden">
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              "radial-gradient(ellipse 60% 50% at 50% 100%, rgba(124,111,255,0.12) 0%, transparent 70%)",
          }}
        />
        <div
          className="relative z-10 inline-block border border-[var(--line-2)] rounded-[var(--r-xl)] px-10 py-12 max-w-[620px]"
          style={{
            background: "var(--surface-1)",
            boxShadow: "0 0 80px -20px rgba(124,111,255,0.18)",
          }}
        >
          <h2 className="font-display text-[clamp(26px,3.8vw,48px)] leading-[1.05]">
            Not a reader. Not a search engine.
            <br />
            <span className="italic text-[var(--gen)]">A new way of seeing science.</span>
          </h2>
          <p className="text-[15.5px] text-[var(--text-2)] mt-4 leading-[1.6]">
            Upload your first paper. See its claims extracted, compared, and argued in under 60 seconds.
          </p>
          <div className="mt-7 flex flex-col items-center gap-3">
            <Magnetic>
              <button
                onClick={go}
                data-hot
                className="inline-flex items-center gap-2 text-[14.5px] font-medium text-white bg-[#6a5cea] px-[22px] py-3 rounded-[var(--r-md)] t-all hover:opacity-90 hover:glow-gen"
              >
                Open the graph <ArrowRight size={15} />
              </button>
            </Magnetic>
            <span className="text-[12.5px] text-[var(--text-muted)]">
              Free to start · no credit card needed
            </span>
          </div>
        </div>
      </section>

      <footer className="border-t border-[var(--line)] py-7 text-center text-[12.5px] text-[var(--text-muted)]">
        ScholarLens · Built by Aakash Shahani
      </footer>
    </div>
  );
}
