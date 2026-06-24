"use client";

import { useState, useEffect, useRef } from "react";
import { useAuth } from "@/lib/auth";
import { ApiError } from "@/lib/api";
import { ArrowRight, ArrowLeft } from "lucide-react";
import { LogoBadge } from "@/components/logo";

/* Faint, slow claim-field behind the card — a quiet echo of the landing hero
   so the gate feels like the same product, not a bare login screen. Heavily
   dimmed and static-friendly; respects reduced-motion. */
function GateBackdrop() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion:reduce)").matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const COL = ["#FF5C5C", "#3DD4A0", "#F5A623"];
    let W = 0, H = 0, t = 0, raf = 0;
    type N = { x: number; y: number; vx: number; vy: number; r: number };
    let nodes: N[] = [];
    let edges: { a: number; b: number; c: string }[] = [];
    const hexA = (hex: string, a: number) => {
      const n = parseInt(hex.slice(1), 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    };
    const build = () => {
      const count = 26;
      nodes = Array.from({ length: count }, () => ({
        x: Math.random() * W, y: Math.random() * H,
        vx: (Math.random() - 0.5) * 0.08, vy: (Math.random() - 0.5) * 0.08,
        r: 1.4 + Math.random() * 1.8,
      }));
      edges = [];
      for (let i = 0; i < 18; i++) {
        const a = Math.floor(Math.random() * count);
        let b = Math.floor(Math.random() * count);
        if (a === b) b = (b + 1) % count;
        edges.push({ a, b, c: COL[Math.floor(Math.random() * 3)] });
      }
    };
    const resize = () => {
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); build();
    };
    const frame = () => {
      t += 0.012; ctx.clearRect(0, 0, W, H);
      for (const nd of nodes) {
        nd.x += nd.vx; nd.y += nd.vy;
        if (nd.x < 0 || nd.x > W) nd.vx *= -1;
        if (nd.y < 0 || nd.y > H) nd.vy *= -1;
      }
      for (const e of edges) {
        const a = nodes[e.a], b = nodes[e.b];
        if (!a || !b) continue;
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        if (dist > 320) continue;
        const op = (1 - dist / 320) * (0.14 + Math.sin(t + e.a) * 0.05);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 - dist * 0.1;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(mx, my, b.x, b.y);
        ctx.strokeStyle = hexA(e.c, Math.max(0, op)); ctx.lineWidth = 1; ctx.stroke();
      }
      for (const nd of nodes) {
        ctx.beginPath(); ctx.arc(nd.x, nd.y, nd.r, 0, 6.28);
        ctx.fillStyle = hexA("#9BA1AD", 0.3); ctx.fill();
      }
      raf = requestAnimationFrame(frame);
    };
    resize();
    if (!reduce) frame();
    else { for (const nd of nodes) { ctx.beginPath(); ctx.arc(nd.x, nd.y, nd.r, 0, 6.28); ctx.fillStyle = hexA("#9BA1AD", 0.3); ctx.fill(); } }
    window.addEventListener("resize", resize);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", resize); };
  }, []);
  return <canvas ref={ref} className="absolute inset-0 w-full h-full block opacity-60" />;
}

export function AuthGate({ onBack }: { onBack?: () => void }) {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isRegister = mode === "register";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email.trim()) return setError("Enter your email.");
    if (isRegister && password.length < 8) return setError("Password must be at least 8 characters.");
    if (!password) return setError("Enter your password.");
    setSubmitting(true);
    try {
      if (isRegister) await register(email.trim(), password);
      else await login(email.trim(), password);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.status === 401
            ? "Incorrect email or password."
            : err.message
          : "Something went wrong. Is the backend running on :8000?";
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  function switchMode() {
    setMode(isRegister ? "login" : "register");
    setError(null);
  }

  return (
    <div className="relative min-h-screen flex flex-col items-center justify-center px-4 bg-[var(--canvas)] overflow-hidden">
      <GateBackdrop />
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ background: "radial-gradient(120% 90% at 50% 45%, transparent 25%, rgba(11,13,18,0.7) 70%, var(--canvas) 100%)" }}
      />

      {/* back to landing — only when there's a landing to return to */}
      {onBack && (
        <button
          onClick={onBack}
          className="absolute top-6 left-6 z-10 inline-flex items-center gap-1.5 text-[13px] text-[var(--text-3)] hover:text-[var(--text-1)] t-all"
        >
          <ArrowLeft size={14} /> Back
        </button>
      )}

      {/* logomark + wordmark */}
      <div className="relative z-10 flex items-center gap-3 mb-8 fade-up">
        <LogoBadge size={32} />
        <span className="font-display text-[20px] text-[var(--text-1)]">ScholarLens</span>
      </div>

      <form
        onSubmit={submit}
        className="relative z-10 w-full max-w-[380px] bg-[var(--surface-2)] border border-[var(--line-2)] rounded-[var(--r-lg)] p-7 fade-up"
        style={{ boxShadow: "0 30px 80px -40px rgba(0,0,0,0.8)" }}
      >
        <h1 className="font-display text-[22px] leading-tight text-[var(--text-1)]">
          {isRegister ? "Create your library" : "Welcome back"}
        </h1>
        <p className="text-[13.5px] text-[var(--text-2)] mt-1.5 mb-6">
          {isRegister
            ? "An account keeps your papers, claims, and analyses private to you."
            : "Sign in to reach your research library."}
        </p>

        <label className="block text-[11px] font-medium text-[var(--text-3)] uppercase tracking-wide mb-1.5">Email</label>
        <input
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@university.edu"
          className="w-full bg-[var(--surface-1)] border border-[var(--line-2)] rounded-[var(--r-md)] px-3.5 py-2.5 text-[14px] text-[var(--text-1)] placeholder:text-[var(--text-4)] outline-none t-all focus:border-[var(--gen-line)] mb-4"
        />

        <label className="block text-[11px] font-medium text-[var(--text-3)] uppercase tracking-wide mb-1.5">Password</label>
        <input
          type="password"
          autoComplete={isRegister ? "new-password" : "current-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={isRegister ? "At least 8 characters" : "••••••••"}
          className="w-full bg-[var(--surface-1)] border border-[var(--line-2)] rounded-[var(--r-md)] px-3.5 py-2.5 text-[14px] text-[var(--text-1)] placeholder:text-[var(--text-4)] outline-none t-all focus:border-[var(--gen-line)]"
        />

        {error && (
          <div className="mt-4 px-3 py-2.5 rounded-[var(--r-md)] text-[12.5px]" style={{ background: "var(--contra-dim)", color: "var(--contra)" }}>
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full flex items-center justify-center gap-2 py-2.5 px-5 mt-6 rounded-[var(--r-md)] bg-[var(--gen)] text-white text-[13.5px] font-medium t-all hover:opacity-90 hover:glow-gen active:translate-y-px disabled:opacity-40 disabled:pointer-events-none"
        >
          {submitting ? (
            <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
          ) : (
            <>
              {isRegister ? "Create account" : "Sign in"}
              <ArrowRight size={15} strokeWidth={2.2} />
            </>
          )}
        </button>
      </form>

      <button
        onClick={switchMode}
        className="relative z-10 mt-5 text-[13px] text-[var(--text-3)] hover:text-[var(--text-1)] t-all fade-up"
      >
        {isRegister ? "Already have an account? " : "New here? "}
        <span className="text-[var(--gen)]">{isRegister ? "Sign in" : "Create one"}</span>
      </button>
    </div>
  );
}
