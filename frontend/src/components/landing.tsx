"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Image from "next/image";
import {
  ArrowRight,
  Zap,
  FlaskConical,
  Network,
  RotateCw,
  GraduationCap,
  FlaskConical as Flask2,
  Users,
  BookOpen,
  Microscope,
  Library as LibraryIcon,
} from "lucide-react";

/**
 * Public marketing landing page, rendered at `/` for unauthenticated visitors.
 * AppShell renders this at `/` for logged-out visitors; CTAs call onSignIn
 * to swap in the auth gate inline (no /login route).
 *
 * Screenshots are expected in `frontend/public/shots/`:
 *   conflict-map.png · knowledge-graph.png · hypotheses.png
 * (See the note in the chat for which uploaded image maps to which filename.)
 */

const REL = ["contra", "support", "nuance"] as const;
const COL: Record<string, string> = {
  contra: "#FF5C5C",
  support: "#3DD4A0",
  nuance: "#F5A623",
  node: "#5E6470",
  core: "#9BA1AD",
};
const hexA = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

/* ─────────────────────────── Hero claim-field ─────────────────────────── */
function ClaimField() {
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
      t = 0,
      raf = 0;
    const mouse = { x: -9999, y: -9999, active: false };
    const isMobile = () => window.innerWidth < 760;

    type Node = { x: number; y: number; vx: number; vy: number; r: number; pulse: number };
    type Edge = { a: number; b: number; type: string; phase: number };
    let nodes: Node[] = [];
    let edges: Edge[] = [];

    const build = () => {
      const count = isMobile() ? 22 : 46;
      nodes = Array.from({ length: count }, () => ({
        x: Math.random() * W,
        y: Math.random() * H,
        vx: (Math.random() - 0.5) * 0.12,
        vy: (Math.random() - 0.5) * 0.12,
        r: 1.6 + Math.random() * 2.2,
        pulse: Math.random() * 6.28,
      }));
      edges = [];
      const ec = isMobile() ? 16 : 34;
      for (let i = 0; i < ec; i++) {
        const a = Math.floor(Math.random() * count);
        let b = Math.floor(Math.random() * count);
        if (a === b) b = (b + 1) % count;
        edges.push({ a, b, type: REL[Math.floor(Math.random() * 3)], phase: Math.random() * 6.28 });
      }
    };
    const resize = () => {
      W = canvas.clientWidth;
      H = canvas.clientHeight;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      build();
    };

    const frame = () => {
      t += 0.016;
      ctx.clearRect(0, 0, W, H);
      for (const nd of nodes) {
        nd.x += nd.vx;
        nd.y += nd.vy;
        if (mouse.active) {
          const dx = mouse.x - nd.x,
            dy = mouse.y - nd.y,
            d2 = dx * dx + dy * dy;
          if (d2 < 46000 && d2 > 1) {
            const f = 120 / d2;
            nd.vx += dx * f * 0.0009;
            nd.vy += dy * f * 0.0009;
          }
        }
        nd.vx *= 0.992;
        nd.vy *= 0.992;
        nd.vx = Math.max(-0.35, Math.min(0.35, nd.vx));
        nd.vy = Math.max(-0.35, Math.min(0.35, nd.vy));
        if (nd.x < 0 || nd.x > W) nd.vx *= -1;
        if (nd.y < 0 || nd.y > H) nd.vy *= -1;
        nd.x = Math.max(0, Math.min(W, nd.x));
        nd.y = Math.max(0, Math.min(H, nd.y));
      }
      for (const e of edges) {
        const a = nodes[e.a],
          b = nodes[e.b];
        if (!a || !b) continue;
        const dist = Math.hypot(b.x - a.x, b.y - a.y),
          maxD = isMobile() ? 240 : 300;
        if (dist > maxD) continue;
        const fade = 1 - dist / maxD,
          breathe = 0.32 + Math.sin(t * 0.8 + e.phase) * 0.14,
          op = fade * breathe,
          c = COL[e.type];
        const mx = (a.x + b.x) / 2,
          my = (a.y + b.y) / 2 - dist * 0.12;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(mx, my, b.x, b.y);
        ctx.strokeStyle = hexA(c, op);
        ctx.lineWidth = e.type === "contra" ? 1.4 : 1.0;
        ctx.stroke();
        const t2 = Math.sin(t * 0.9 + e.phase) * 0.5 + 0.5;
        const px = (1 - t2) * (1 - t2) * a.x + 2 * (1 - t2) * t2 * mx + t2 * t2 * b.x,
          py = (1 - t2) * (1 - t2) * a.y + 2 * (1 - t2) * t2 * my + t2 * t2 * b.y;
        ctx.beginPath();
        ctx.arc(px, py, 1.3, 0, 6.28);
        ctx.fillStyle = hexA(c, op * 1.5);
        ctx.fill();
      }
      for (const nd of nodes) {
        nd.pulse += 0.02;
        const glow = 0.5 + Math.sin(nd.pulse) * 0.25;
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, nd.r + 2.5, 0, 6.28);
        ctx.fillStyle = hexA(COL.node, 0.1 * glow);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, nd.r, 0, 6.28);
        ctx.fillStyle = hexA(COL.core, 0.55);
        ctx.fill();
      }
      raf = requestAnimationFrame(frame);
    };
    const staticDraw = () => {
      ctx.clearRect(0, 0, W, H);
      for (const e of edges) {
        const a = nodes[e.a],
          b = nodes[e.b];
        if (!a || !b) continue;
        const mx = (a.x + b.x) / 2,
          my = (a.y + b.y) / 2 - 30;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(mx, my, b.x, b.y);
        ctx.strokeStyle = hexA(COL[e.type], 0.3);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      for (const nd of nodes) {
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, nd.r, 0, 6.28);
        ctx.fillStyle = hexA(COL.core, 0.55);
        ctx.fill();
      }
    };

    const onMove = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      if (e.clientY < r.bottom) {
        mouse.x = e.clientX - r.left;
        mouse.y = e.clientY - r.top;
        mouse.active = true;
      } else mouse.active = false;
    };
    const onOut = () => (mouse.active = false);

    resize();
    if (reduce) staticDraw();
    else frame();
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

/* ─────────────────────────── Lens band ─────────────────────────── */
const LENS_LINES = [
  "counterparty modeling does not reliably improve outcomes",
  "static coaching outperformed both AI conditions on empowerment",
  "64% of participants adapted between integrative and distributive",
  "AI prediction leads people to forgo guaranteed rewards",
  "adaptation magnitude depends on prior strategy use",
  "confidentiality concerns emerged as an adoption barrier",
  "informed side often makes the weaker concessions",
  "phase-aligned adaptation predicts outcomes differently",
  "post-perturbation distributive shifts show weak prediction",
  "agents model preferences but fail to leverage them",
  "strategic adaptability is constrained by initial posture",
  "feedback-driven coaching raises rapport, not utility",
];

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
            const W = stage.clientWidth;
            const iv = setInterval(() => {
              p += 0.025;
              if (p >= 1) {
                clearInterval(iv);
                setTimeout(() => (lens.style.opacity = "0"), 400);
                return;
              }
              move(W * (0.2 + p * 0.6), 90 + Math.sin(p * Math.PI * 2) * 70);
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
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        move(e.clientX - r.left, e.clientY - r.top);
      }}
      onMouseLeave={() => {
        if (lensRef.current) lensRef.current.style.opacity = "0";
      }}
      className="relative mt-12 h-[300px] rounded-[var(--r-lg)] border border-[var(--line)] bg-[var(--surface-1)] overflow-hidden cursor-crosshair"
    >
      <div className="absolute top-3 left-4 text-[11px] text-[var(--text-3)] pointer-events-none z-10">
        12 claims extracted from 5 papers
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
              <span style={{ color: COL[REL[i % 3]] }}>▸</span> {l}
              {"     "}
            </span>
          ))}
        </div>
      </div>
      <div className="absolute bottom-3 right-4 text-[11px] text-[var(--text-4)] pointer-events-none">
        hover to read extracted claims
      </div>
    </div>
  );
}

/* ─────────────────────── Sample-analysis panel ─────────────────────── */
function SampleAnalysis() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [count, setCount] = useState(0);
  const [shown, setShown] = useState<boolean[]>([false, false, false]);
  const startedRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  const run = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion:reduce)").matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W = canvas.clientWidth,
      H = canvas.clientHeight,
      raf = 0;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const palette = ["#FF5C5C", "#3DD4A0", "#F5A623", "#5E6470"];
    const nodes = Array.from({ length: 28 }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      tx: W * 0.5 + (Math.random() - 0.5) * W * 0.7,
      ty: H * 0.5 + (Math.random() - 0.5) * H * 0.7,
      r: 1.4 + Math.random() * 2,
      col: palette[Math.floor(Math.random() * 4)],
    }));

    setShown([false, false, false]);
    setCount(0);
    const TARGET = 12;
    let c = 0;
    const ci = setInterval(() => {
      c += 1;
      if (c >= TARGET) {
        c = TARGET;
        clearInterval(ci);
      }
      setCount(c);
    }, 70);

    const draw = () => {
      for (const n of nodes) {
        n.x += (n.tx - n.x) * 0.06;
        n.y += (n.ty - n.y) * 0.06;
      }
      ctx.clearRect(0, 0, W, H);
      for (let i = 0; i < nodes.length; i++)
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i],
            b = nodes[j],
            d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < 70) {
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.strokeStyle = hexA("#5E6470", (1 - d / 70) * 0.3);
            ctx.lineWidth = 0.8;
            ctx.stroke();
          }
        }
      for (const n of nodes) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, 6.28);
        ctx.fillStyle = hexA(n.col, 0.8);
        ctx.fill();
      }
      raf = requestAnimationFrame(draw);
    };

    const timers: ReturnType<typeof setTimeout>[] = [];
    if (reduce) {
      nodes.forEach((n) => {
        n.x = n.tx;
        n.y = n.ty;
      });
      draw();
      cancelAnimationFrame(raf);
      setCount(TARGET);
      setShown([true, true, true]);
    } else {
      draw();
      [0, 1, 2].forEach((i) =>
        timers.push(
          setTimeout(() => setShown((s) => s.map((v, k) => (k === i ? true : v))), 700 + i * 650)
        )
      );
    }

    cleanupRef.current = () => {
      cancelAnimationFrame(raf);
      clearInterval(ci);
      timers.forEach(clearTimeout);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const io = new IntersectionObserver(
      (es) =>
        es.forEach((e) => {
          if (e.isIntersecting && !startedRef.current) {
            startedRef.current = true;
            run();
          }
        }),
      { threshold: 0.4 }
    );
    io.observe(canvas);
    return () => {
      io.disconnect();
      cleanupRef.current?.();
    };
  }, [run]);

  const findings = [
    {
      color: "var(--contra)",
      label: "Most contested claim",
      text: '"Counterparty modeling is not strategy" — agents model a partner\'s preferences but fail to turn that into better outcomes.',
      meta: "7 papers weigh in · no consensus",
    },
    {
      color: "var(--nuance)",
      label: "Research gap",
      text: "AI coaching and strategic adaptation are both active here — but only two papers connect them.",
      meta: "Sparse bridge · high opportunity",
    },
    {
      color: "var(--gen)",
      label: "Generated hypothesis",
      text: "Phase-aligned adaptations predict outcomes differently than misaligned ones — reconciling why distributive shifts seem unpredictive in aggregate.",
      meta: "Grounded in 2 sources · most novel",
    },
  ];

  return (
    <div className="mt-12 bg-[var(--surface-1)] border border-[var(--line)] rounded-[var(--r-lg)] overflow-hidden">
      <div className="flex items-center justify-between px-[22px] py-4 border-b border-[var(--line)]">
        <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.1em] text-[var(--text-3)]">
          <span
            className="w-[7px] h-[7px] rounded-full bg-[var(--gen)]"
            style={{ boxShadow: "0 0 8px var(--gen-glow)" }}
          />
          Sample analysis
        </span>
        <button
          onClick={() => {
            cleanupRef.current?.();
            run();
          }}
          className="inline-flex items-center gap-1.5 text-[12px] text-[var(--text-3)] border border-[var(--line-2)] rounded-[var(--r-sm)] px-3 py-[5px] t-all hover:text-[var(--text-1)] hover:border-[var(--line-3)]"
        >
          <RotateCw size={12} /> Replay
        </button>
      </div>
      <div className="grid md:grid-cols-[300px_1fr] min-h-[340px]">
        <div className="relative border-b md:border-b-0 md:border-r border-[var(--line)] p-6">
          <div className="absolute top-6 left-6 text-[12px] text-[var(--text-3)]">
            <b className="text-[var(--text-1)] font-medium tabular-nums">{count}</b> papers analyzed
          </div>
          <canvas ref={canvasRef} className="w-full h-[260px] block" />
        </div>
        <div className="p-6 md:px-7 flex flex-col gap-3.5">
          {findings.map((f, i) => (
            <div
              key={i}
              className="rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-2)] px-4 py-3.5 transition-all duration-500"
              style={{
                opacity: shown[i] ? 1 : 0,
                transform: shown[i] ? "translateX(0)" : "translateX(12px)",
              }}
            >
              <div
                className="text-[10.5px] uppercase tracking-[0.1em] mb-[7px] flex items-center gap-[7px]"
                style={{ color: f.color }}
              >
                <span className="w-[6px] h-[6px] rounded-full" style={{ background: f.color }} />
                {f.label}
              </div>
              <div className="text-[14px] leading-[1.45] text-[var(--text-1)]">{f.text}</div>
              <div className="text-[11.5px] text-[var(--text-3)] mt-1.5">{f.meta}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── Showcase row ─────────────────────────── */
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
        className="bg-[var(--surface-1)] border border-[var(--line-2)] rounded-[var(--r-lg)] overflow-hidden"
        style={{ boxShadow: "0 30px 60px -30px rgba(0,0,0,0.6)" }}
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

/* ─────────────────────────── Page ─────────────────────────── */
export default function Landing({ onSignIn }: { onSignIn: () => void }) {
  const go = onSignIn;

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion:reduce)").matches;
    const els = Array.from(document.querySelectorAll<HTMLElement>(".reveal"));
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

  const builtFor = [
    { icon: GraduationCap, label: "PhD students mapping a literature" },
    { icon: Flask2, label: "Labs keeping up with a fast-moving field" },
    { icon: BookOpen, label: "Professors building a course reading list" },
    { icon: Microscope, label: "Master's students finding a thesis gap" },
    { icon: Users, label: "Independent researchers without a lab behind them" },
    { icon: LibraryIcon, label: "Anyone reading across more than one sitting" },
  ];

  return (
    <div className="bg-[var(--canvas)] text-[var(--text-1)]">
      {/* nav */}
      <nav className="fixed top-0 left-0 right-0 z-30 h-[60px] flex items-center justify-between px-7 backdrop-blur-[10px] bg-gradient-to-b from-[rgba(11,13,18,0.85)] to-transparent">
        <div className="flex items-center gap-3">
          <span className="relative flex items-center justify-center w-7 h-7 rounded-[8px] bg-[var(--gen)] glow-gen">
            <span className="w-[11px] h-[11px] rounded-full border-[1.6px] border-white" />
          </span>
          <span className="font-display text-[17px]">ScholarLens</span>
        </div>
        <div className="flex items-center gap-2">
          <a href="#finds" className="hidden sm:block text-[13.5px] text-[var(--text-2)] px-3.5 py-2 rounded-[var(--r-md)] t-all hover:text-[var(--text-1)] hover:bg-[var(--surface-2)]">
            What it finds
          </a>
          <a href="#product" className="hidden sm:block text-[13.5px] text-[var(--text-2)] px-3.5 py-2 rounded-[var(--r-md)] t-all hover:text-[var(--text-1)] hover:bg-[var(--surface-2)]">
            Product
          </a>
          <button onClick={go} className="text-[13.5px] text-[var(--text-2)] px-3.5 py-2 rounded-[var(--r-md)] t-all hover:text-[var(--text-1)] hover:bg-[var(--surface-2)]">
            Sign in
          </button>
          <button onClick={go} className="inline-flex items-center gap-1.5 text-[13.5px] font-medium text-white bg-[var(--gen)] px-4 py-2 rounded-[var(--r-md)] t-all hover:opacity-90 hover:glow-gen">
            Get started <ArrowRight size={14} />
          </button>
        </div>
      </nav>

      {/* hero */}
      <header className="relative min-h-screen flex items-center justify-center overflow-hidden">
        <ClaimField />
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              "radial-gradient(120% 90% at 50% 42%, transparent 30%, rgba(11,13,18,0.55) 72%, var(--canvas) 100%)",
          }}
        />
        <div className="relative z-[5] text-center px-6 max-w-[880px]">
          <div className="inline-flex items-center gap-2 text-[12px] text-[var(--text-2)] bg-[var(--surface-2)] border border-[var(--line-2)] pl-[11px] pr-[13px] py-1.5 rounded-full mb-[30px] fade-up">
            <span className="w-[6px] h-[6px] rounded-full bg-[var(--gen)]" style={{ boxShadow: "0 0 8px var(--gen-glow)" }} />
            Research intelligence
          </div>
          <h1 className="font-display text-[clamp(40px,6.4vw,76px)] leading-[1.02] tracking-[-0.02em] fade-up" style={{ animationDelay: ".1s" }}>
            Find where the literature
            <br />
            <span className="italic text-[var(--gen)]">contradicts itself.</span>
          </h1>
          <p className="text-[clamp(15px,1.9vw,18.5px)] leading-[1.55] text-[var(--text-2)] max-w-[600px] mx-auto mt-6 fade-up" style={{ animationDelay: ".2s" }}>
            Upload a corpus. ScholarLens finds where the papers disagree, what they leave open,
            and what a careful reader might try next.
          </p>
          <div className="flex gap-3 justify-center items-center mt-9 flex-wrap fade-up" style={{ animationDelay: ".32s" }}>
            <button onClick={go} className="inline-flex items-center gap-2 text-[14.5px] font-medium text-white bg-[var(--gen)] px-[22px] py-3 rounded-[var(--r-md)] t-all hover:opacity-90 hover:glow-gen hover:-translate-y-px">
              Map your literature <ArrowRight size={15} />
            </button>
            <a href="#finds" className="inline-flex items-center gap-2 text-[14.5px] text-[var(--text-1)] border border-[var(--line-2)] px-5 py-3 rounded-[var(--r-md)] t-all hover:border-[var(--line-3)] hover:bg-[var(--surface-2)]">
              See what it finds
            </a>
          </div>
          <div className="flex gap-5 justify-center mt-12 flex-wrap fade-up" style={{ animationDelay: ".46s" }}>
            {(["contra", "support", "nuance"] as const).map((k) => (
              <span key={k} className="inline-flex items-center gap-2 text-[12.5px] text-[var(--text-3)] capitalize">
                <span className="w-[18px] h-[2px] rounded-[2px]" style={{ background: COL[k] }} />
                {k === "contra" ? "Contradiction" : k === "support" ? "Support" : "Nuance"}
              </span>
            ))}
          </div>
        </div>
      </header>

      {/* what you walk away with */}
      <section id="finds" className="px-6 py-[110px] max-w-[1080px] mx-auto">
        <div className="reveal text-[11px] uppercase tracking-[0.14em] text-[var(--gen)] font-medium mb-3.5">
          What you walk away with
        </div>
        <h2 className="reveal font-display text-[clamp(28px,3.6vw,44px)] leading-[1.08] max-w-[640px]">
          You don&apos;t get a summary. You get the shape of the field.
        </h2>
        <p className="reveal text-[16px] leading-[1.6] text-[var(--text-2)] max-w-[580px] mt-[18px]">
          Point it at a body of work and it shows you the claim papers keep fighting over,
          the question none of them answer, and a testable direction that follows from both.
        </p>
        <div className="reveal">
          <SampleAnalysis />
        </div>
        <div className="reveal mt-9">
          <button onClick={go} className="inline-flex items-center gap-2 text-[14.5px] font-medium text-white bg-[var(--gen)] px-[22px] py-3 rounded-[var(--r-md)] t-all hover:opacity-90 hover:glow-gen hover:-translate-y-px">
            Analyze a field <ArrowRight size={15} />
          </button>
        </div>
      </section>

      {/* lens */}
      <section className="px-6 pb-[110px] max-w-[1080px] mx-auto">
        <div className="reveal text-[11px] uppercase tracking-[0.14em] text-[var(--gen)] font-medium mb-3.5">
          How it reads your corpus
        </div>
        <h2 className="reveal font-display text-[clamp(28px,3.6vw,44px)] leading-[1.08] max-w-[640px]">
          Every claim, traced back to the sentence it came from.
        </h2>
        <p className="reveal text-[16px] leading-[1.6] text-[var(--text-2)] max-w-[580px] mt-[18px]">
          Hover over the corpus and the blur lifts. What you see are claims pulled directly from
          results and methods sections — not paraphrased, not summarized, not telephone-gamed.
        </p>
        <div className="reveal">
          <LensBand />
        </div>
      </section>

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
            copy="Every claim your library contains, laid out as a graph. Claims that support each other pull together; contradictions push apart. Node size tracks how central a claim is to the field. One view of a structure you used to hold in your head."
            outcome="The whole field in one view"
            src="/shots/knowledge-graph.png"
            alt="ScholarLens knowledge graph of claims connected by relationship type"
            barTitle="scholarlens · knowledge graph"
          />
        </div>
        <div className="reveal">
          <ShowcaseRow
            title="The generative bench"
            copy="ScholarLens reads the gaps and conflicts in your library and proposes hypotheses that follow from them. Each one traces back to the specific claims that motivated it, ranked by how far it sits from territory your library already covers."
            outcome="Directions grounded in what the field actually says"
            src="/shots/hypotheses.png"
            alt="ScholarLens generative bench showing a ranked, grounded hypothesis"
            barTitle="scholarlens · hypotheses"
          />
        </div>
      </section>

      {/* built for */}
      <section className="px-6 pb-[110px] max-w-[1080px] mx-auto">
        <div className="reveal text-[11px] uppercase tracking-[0.14em] text-[var(--gen)] font-medium mb-3.5">
          Built for
        </div>
        <h2 className="reveal font-display text-[clamp(28px,3.6vw,44px)] leading-[1.08] max-w-[640px]">
          Anyone who has to hold a whole literature in their head.
        </h2>
        <div className="reveal grid sm:grid-cols-2 md:grid-cols-3 gap-3 mt-10">
          {builtFor.map(({ icon: Icon, label }) => (
            <div key={label} className="bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-md)] px-[18px] py-[18px] flex items-center gap-3.5">
              <span className="inline-flex items-center justify-center w-[34px] h-[34px] rounded-[var(--r-sm)] bg-[var(--gen-dim)] text-[var(--gen)] shrink-0">
                <Icon size={17} />
              </span>
              <span className="text-[14px] text-[var(--text-1)]">{label}</span>
            </div>
          ))}
        </div>
      </section>

      {/* close */}
      <section className="text-center px-6 pt-[130px] pb-[90px]">
        <h2 className="font-display text-[clamp(30px,4.4vw,54px)] leading-[1.05] max-w-[700px] mx-auto">
          Your library has an argument inside it.
          <br />
          ScholarLens finds <span className="italic text-[var(--gen)]">what it is</span>.
        </h2>
        <div className="mt-10">
          <button onClick={go} className="inline-flex items-center gap-2 text-[14.5px] font-medium text-white bg-[var(--gen)] px-[22px] py-3 rounded-[var(--r-md)] t-all hover:opacity-90 hover:glow-gen hover:-translate-y-px">
            Explore your corpus <ArrowRight size={15} />
          </button>
        </div>
      </section>

      <footer className="border-t border-[var(--line)] py-7 text-center text-[12.5px] text-[var(--text-3)]">
        ScholarLens · Built by Aakash Shahani
      </footer>
    </div>
  );
}
