"use client";

/**
 * ScholarLens — public landing experience ("Knowledge Field").
 *
 * Concept (told as one continuous argument in motion): a single paper dissolves into
 * its atomic claims, claims connect into evidence, contradictions hold the field under
 * tension, a knowledge graph resolves, and a generated hypothesis is born from a gap.
 *
 * Architecture — STATIC-FIRST, ENHANCEMENT-SECOND:
 *  - The server renders a real, complete, accessible narrative (header + CTA + the seven
 *    chapters as <section>s + the Evidence Chamber content + footer). This is what
 *    crawlers, no-JS visitors, screen readers, and the reduced-motion path get. It is a
 *    good page on its own, and it doubles as the scroll driver.
 *  - On capable clients (JS on, prefers-reduced-motion: no-preference, not low-end, real
 *    pointer / large screen) the WebGL cinematic (landing-cinematic.tsx) mounts on top as
 *    a fixed, opaque layer and BECOMES the experience. three.js loads only then.
 *
 * Design law (shared with the product): meaning lives in the EDGES — amber support,
 * red contradiction, teal hypothesis, purple --gen for the system's own voice.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { LogoBadge } from "@/components/logo";
import { CHAPTERS, CHAMBER, type Chapter } from "@/components/landing-data";
import LandingCinematic from "@/components/landing-cinematic";
import { ArrowRight, X, ChevronDown } from "lucide-react";

const ACCENT: Record<Chapter["accent"], string> = {
  neutral: "var(--text-2)",
  support: "var(--support)",
  contra: "var(--contra)",
  hypothesis: "#35d0c0",
  system: "var(--gen)",
};

/* ════════════════════════ Evidence Chamber (shared content) ════════════════════════ */
/* Rendered inline in the static narrative (always accessible, no-JS) AND inside the modal
   dialog that the cinematic's contradiction markers open. One content source, two homes. */
function ChamberBody() {
  return (
    <>
      <div className="grid sm:grid-cols-2 gap-4">
        <div className="rounded-[var(--r-lg)] border border-[var(--line-2)] bg-[rgba(220,228,245,0.03)] p-4">
          <div className="mono text-[9px] tracking-[0.18em] text-[var(--text-2)]">CLAIM A</div>
          <div className="mt-2 text-[15px] font-medium leading-snug text-[var(--text-1)]">{CHAMBER.a.text}</div>
          <div className="mt-2.5 text-[11.5px] leading-relaxed text-[var(--text-3)]">{CHAMBER.a.paper}</div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {CHAMBER.a.tags.map((t) => (
              <span key={t} className="mono text-[9px] text-[var(--text-2)] border border-[var(--line-2)] rounded-[5px] px-1.5 py-0.5">{t}</span>
            ))}
          </div>
        </div>
        <div className="rounded-[var(--r-lg)] border border-[var(--contra-line)] bg-[var(--contra-dim)] p-4">
          <div className="mono text-[9px] tracking-[0.18em] text-[var(--contra)]">CLAIM B</div>
          <div className="mt-2 text-[15px] font-medium leading-snug text-[var(--text-1)]">{CHAMBER.b.text}</div>
          <div className="mt-2.5 text-[11.5px] leading-relaxed text-[var(--text-3)]">{CHAMBER.b.paper}</div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {CHAMBER.b.tags.map((t) => (
              <span key={t} className="mono text-[9px] text-[#ffbcbc] border border-[var(--contra-line)] rounded-[5px] px-1.5 py-0.5">{t}</span>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4 grid sm:grid-cols-2 gap-4">
        <div>
          <div className="mono text-[9px] tracking-[0.18em] text-[#35d0c0]">SHARED CONCEPTS</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {CHAMBER.shared.map((s) => (
              <span key={s} className="text-[11.5px] text-[var(--text-2)] border border-[rgba(53,208,192,0.22)] rounded-full px-2.5 py-1">{s}</span>
            ))}
          </div>
        </div>
        <div>
          <div className="mono text-[9px] tracking-[0.18em] text-[var(--support)]">METHODOLOGICAL DIFFERENCE</div>
          <div className="mt-2 text-[12px] leading-relaxed text-[var(--text-2)]">{CHAMBER.methodological}</div>
        </div>
      </div>

      <div className="mt-4 rounded-[var(--r-lg)] border border-[var(--line-2)] bg-[rgba(159,180,216,0.04)] p-4">
        <div className="mono text-[9px] tracking-[0.18em] text-[var(--text-2)]">POSSIBLE EXPLANATIONS</div>
        <div className="mt-2 text-[12.5px] leading-relaxed text-[var(--text-2)]">{CHAMBER.explanations}</div>
      </div>

      <div className="mt-4 flex flex-wrap items-stretch gap-3.5">
        <div className="flex-1 min-w-[240px] rounded-[var(--r-lg)] border border-[var(--gen-line)] bg-[var(--gen-dim)] p-4">
          <div className="mono text-[9px] tracking-[0.18em] text-[var(--gen)]">RESEARCH GAP → HYPOTHESIS</div>
          <div className="mt-2 text-[13px] leading-relaxed text-[var(--text-1)]">{CHAMBER.gap}</div>
        </div>
        <div className="flex items-center">
          <div className="mono text-[10px] leading-relaxed text-[var(--text-muted)] max-w-[210px]">{CHAMBER.footer}</div>
        </div>
      </div>
    </>
  );
}

/* ════════════════════════ Evidence Chamber modal (enhancement) ════════════════════════ */
function ChamberModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key !== "Tab") return;
      const f = cardRef.current?.querySelectorAll<HTMLElement>("button,a[href],[tabindex]:not([tabindex='-1'])");
      if (!f || !f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      prev?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-[4vh_3vw]"
      style={{ background: "rgba(3,4,9,0.6)", backdropFilter: "blur(7px)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="chamber-title"
        className="w-[min(96vw,1040px)] max-h-[90vh] overflow-auto rounded-[var(--r-xl)] border border-[var(--contra-line)]"
        style={{ background: "linear-gradient(180deg,rgba(12,14,22,0.97),rgba(8,9,16,0.99))", boxShadow: "0 50px 130px rgba(0,0,0,0.7)" }}
      >
        <div className="flex items-center gap-3 px-5 py-4 border-b border-[var(--contra-line)]">
          <span className="w-2 h-2 rounded-full bg-[var(--contra)]" style={{ boxShadow: "0 0 10px var(--contra)" }} />
          <div id="chamber-title" className="mono text-[10px] tracking-[0.22em] text-[#ff9696]">EVIDENCE CHAMBER · WHY FINDINGS DISAGREE</div>
          <button ref={closeRef} onClick={onClose} aria-label="Close" className="ml-auto w-[30px] h-[30px] flex items-center justify-center rounded-[var(--r-sm)] border border-[var(--line-3)] text-[var(--text-2)] hover:text-[var(--text-1)] hover:bg-[var(--surface-2)] t-all">
            <X size={15} />
          </button>
        </div>
        <div className="p-5"><ChamberBody /></div>
      </div>
    </div>
  );
}

/* ════════════════════════════════ Static field art ════════════════════════════════ */
function FieldGlyph({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 1200 800" className={className} aria-hidden>
      <g fill="none" stroke="#caa45a" strokeWidth="2" opacity="0.45">
        <line x1="420" y1="300" x2="600" y2="380" /><line x1="600" y1="380" x2="780" y2="320" />
        <line x1="600" y1="380" x2="560" y2="520" /><line x1="780" y1="320" x2="820" y2="470" />
      </g>
      <line x1="780" y1="320" x2="560" y2="520" stroke="#ff4d4d" strokeWidth="2.5" strokeDasharray="6 5" />
      <g>
        <circle cx="420" cy="300" r="9" fill="#e6ecf8" /><circle cx="600" cy="380" r="14" fill="#9fb4d8" />
        <circle cx="780" cy="320" r="10" fill="#ff5b5b" /><circle cx="560" cy="520" r="10" fill="#ff5b5b" />
        <circle cx="820" cy="470" r="9" fill="#35d0c0" /><circle cx="700" cy="560" r="8" fill="#caa45a" />
      </g>
    </svg>
  );
}

/* Small per-chapter motif — enriches the static / reduced-motion narrative. */
function ChapterGlyph({ n, accent, className = "" }: { n: string; accent: string; className?: string }) {
  const c = accent;
  return (
    <svg viewBox="0 0 80 80" className={className} aria-hidden fill="none">
      {n === "01" && <circle cx="40" cy="40" r="6" fill={c} />}
      {n === "02" && (
        <>
          <circle cx="40" cy="20" r="5" fill="#9fb4d8" />
          <line x1="40" y1="25" x2="22" y2="55" stroke={c} strokeWidth="1" opacity="0.5" />
          <line x1="40" y1="25" x2="40" y2="58" stroke={c} strokeWidth="1" opacity="0.5" />
          <line x1="40" y1="25" x2="58" y2="55" stroke={c} strokeWidth="1" opacity="0.5" />
          <circle cx="22" cy="57" r="4" fill={c} /><circle cx="40" cy="60" r="4" fill={c} /><circle cx="58" cy="57" r="4" fill={c} />
        </>
      )}
      {n === "03" && (
        <>
          <line x1="20" y1="30" x2="45" y2="48" stroke={c} strokeWidth="1.4" /><line x1="45" y1="48" x2="62" y2="26" stroke={c} strokeWidth="1.4" /><line x1="45" y1="48" x2="40" y2="64" stroke={c} strokeWidth="1.4" />
          <circle cx="20" cy="30" r="4" fill="#9fb4d8" /><circle cx="45" cy="48" r="5" fill="#9fb4d8" /><circle cx="62" cy="26" r="4" fill="#9fb4d8" /><circle cx="40" cy="64" r="4" fill="#9fb4d8" />
        </>
      )}
      {n === "04" && (
        <>
          <line x1="26" y1="30" x2="54" y2="52" stroke={c} strokeWidth="1.6" strokeDasharray="4 3" />
          <circle cx="26" cy="30" r="5" fill={c} /><circle cx="54" cy="52" r="5" fill={c} />
        </>
      )}
      {n === "05" && [[24, 28], [34, 24], [30, 38], [56, 30], [60, 42], [50, 34], [34, 58], [46, 62], [40, 50]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r="3.2" fill="#9fb4d8" opacity="0.85" />)}
      {n === "06" && (
        <>
          {[[24, 28], [60, 30], [34, 60], [56, 60]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r="3.2" fill="#9fb4d8" opacity="0.55" />)}
          <circle cx="42" cy="44" r="8" fill="none" stroke={c} strokeWidth="1.4" strokeDasharray="3 3" />
        </>
      )}
      {n === "07" && (
        <>
          <rect x="18" y="22" width="44" height="36" rx="4" stroke={c} strokeWidth="1.3" />
          <line x1="18" y1="32" x2="62" y2="32" stroke={c} strokeWidth="1.3" opacity="0.6" />
          <line x1="34" y1="32" x2="34" y2="58" stroke={c} strokeWidth="1.3" opacity="0.6" />
        </>
      )}
    </svg>
  );
}

/* ════════════════════════════════════ Page ════════════════════════════════════ */
export default function Landing({ onSignIn }: { onSignIn: () => void }) {
  const go = onSignIn;
  const [enhance, setEnhance] = useState(false);
  const [chamberOpen, setChamberOpen] = useState(false);
  const announceRef = useRef<HTMLDivElement>(null);
  const closeChamber = useCallback(() => setChamberOpen(false), []);
  const openChamber = useCallback(() => setChamberOpen(true), []);

  // Capability gate — decide static vs. cinematic. setState is deferred out of the
  // effect body (the strict react-compiler lint forbids synchronous setState here).
  useEffect(() => {
    let alive = true;
    let ok = true;
    try {
      if (!window.matchMedia("(prefers-reduced-motion: no-preference)").matches) ok = false;
      if ((navigator.hardwareConcurrency || 8) <= 4) ok = false;
      if (window.matchMedia("(pointer: coarse)").matches && window.innerWidth < 900) ok = false;
      if (ok) {
        const c = document.createElement("canvas");
        if (!(c.getContext("webgl") || c.getContext("experimental-webgl"))) ok = false;
      }
    } catch { ok = false; }
    if (ok) queueMicrotask(() => { if (alive) setEnhance(true); });
    return () => { alive = false; };
  }, []);

  // Scroll-reveal for the static narrative (no-op visual cost when covered by the canvas).
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>(".lz-reveal"));
    if (window.matchMedia("(prefers-reduced-motion:reduce)").matches) {
      els.forEach((e) => e.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver(
      (es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }),
      { threshold: 0.18 }
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);

  return (
    <div className="bg-[var(--canvas)] text-[var(--text-1)]" style={{ minHeight: enhance ? "920vh" : undefined }}>
      {/* skip link */}
      <a href="#get-started" className="sr-only focus:not-sr-only focus:fixed focus:z-[60] focus:top-3 focus:left-3 focus:bg-[var(--surface-2)] focus:border focus:border-[var(--line-3)] focus:rounded-[var(--r-md)] focus:px-4 focus:py-2 focus:text-[13px]">
        Skip the intro
      </a>

      {/* aria-live region announces the active chapter to screen readers driving the canvas */}
      <div ref={announceRef} aria-live="polite" className="sr-only" />

      {/* the cinematic enhancement — covers the static narrative when capable */}
      {enhance && <LandingCinematic onOpenChamber={openChamber} announceRef={announceRef} />}

      {/* ── persistent header (always visible, in both modes, SSR'd) ── */}
      <header className="fixed top-0 left-0 right-0 z-30 h-[60px] flex items-center justify-between px-5 sm:px-7 backdrop-blur-[10px]" style={{ background: "linear-gradient(180deg, rgba(11,13,18,0.85), transparent)" }}>
        <div className="flex items-center gap-3">
          <LogoBadge size={28} />
          <span className="font-display text-[17px]">ScholarLens</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={go} className="hidden sm:block text-[13.5px] text-[var(--text-2)] px-3.5 py-2 rounded-[var(--r-md)] t-all hover:text-[var(--text-1)] hover:bg-[var(--surface-2)]">
            Sign in
          </button>
          <button onClick={go} className="inline-flex items-center gap-1.5 text-[13.5px] font-medium text-white bg-[#6a5cea] px-4 py-2 rounded-[var(--r-md)] t-all hover:opacity-90 hover:glow-gen">
            Enter ScholarLens <ArrowRight size={14} />
          </button>
        </div>
      </header>

      {/* ── static narrative (canonical content; scroll driver when enhanced) ──
          Kept fully accessible in BOTH modes: the cinematic above is aria-hidden
          decoration, so screen-reader / keyboard users navigate this real content
          even when it's visually covered by the canvas. */}
      <main className="relative z-0">
        {/* hero */}
        <section className="relative min-h-screen flex flex-col items-center justify-center text-center px-6 overflow-hidden">
          <FieldGlyph className="absolute inset-0 w-full h-full opacity-[0.5] pointer-events-none" />
          <div className="absolute inset-0 pointer-events-none" style={{ background: "radial-gradient(120% 90% at 50% 45%, transparent 30%, var(--canvas) 100%)" }} />
          <div className="relative z-[1] max-w-[920px]">
            <div className="inline-flex items-center gap-2 text-[12px] text-[var(--text-2)] bg-[var(--surface-2)] border border-[var(--line-2)] pl-[11px] pr-[13px] py-1.5 rounded-full mb-7 fade-up">
              <span className="w-[6px] h-[6px] rounded-full bg-[var(--gen)]" style={{ boxShadow: "0 0 8px var(--gen-glow)" }} />
              A new way of reading the literature
            </div>
            <h1 className="font-display text-[clamp(40px,6.6vw,82px)] leading-[1.02] tracking-[-0.025em]">
              Your field disagrees with itself.
              <br />
              <span className="italic text-[var(--gen)]">See exactly where.</span>
            </h1>
            <p className="text-[clamp(15px,1.9vw,18.5px)] leading-[1.55] text-[var(--text-2)] max-w-[620px] mx-auto mt-7">
              ScholarLens reads your papers down to individual claims and maps how they support,
              contradict, and qualify each other — the structure of the debate, traced to the sentence.
            </p>
            <div className="flex flex-col items-center mt-9">
              <div className="flex gap-3 justify-center items-center flex-wrap">
                <button onClick={go} className="inline-flex items-center gap-2 text-[14.5px] font-medium text-white bg-[#6a5cea] px-[22px] py-3 rounded-[var(--r-md)] t-all hover:opacity-90 hover:glow-gen">
                  Enter ScholarLens <ArrowRight size={15} />
                </button>
                <a href="#chapters" className="inline-flex items-center gap-2 text-[14.5px] text-[var(--text-1)] border border-[var(--line-3)] bg-[var(--surface-2)] px-5 py-3 rounded-[var(--r-md)] t-all hover:border-[rgba(255,255,255,0.22)] hover:bg-[var(--surface-3)]">
                  See how it reads
                </a>
              </div>
              <p className="text-[12.5px] text-[var(--text-muted)] mt-4">Free to start · no credit card needed</p>
            </div>
            {enhance && (
              <div className="mono text-[10px] tracking-[0.3em] text-[var(--text-muted)] mt-12 inline-flex items-center gap-2">
                <ChevronDown size={13} className="animate-bounce" /> SCROLL TO ENTER THE FIELD
              </div>
            )}
          </div>
        </section>

        {/* the seven chapters */}
        <div id="chapters" className="border-t border-[var(--line)]" style={{ background: "var(--surface-1)" }}>
          <div className="max-w-[1000px] mx-auto px-6 py-[90px]">
            <div className="lz-reveal mb-14 max-w-[640px]">
              <div className="mono text-[11px] uppercase tracking-[0.14em] text-[var(--gen)] mb-3.5">How it reads a literature</div>
              <h2 className="font-display text-[clamp(28px,3.6vw,46px)] leading-[1.08]">From one paper to your whole field — in seven steps.</h2>
            </div>
            <ol className="relative border-l border-[var(--line-2)] ml-3">
              {CHAPTERS.map((c) => (
                <li key={c.n} className="lz-reveal relative pl-8 pb-12 last:pb-0 md:pr-24">
                  <span className="absolute -left-[7px] top-1 w-3.5 h-3.5 rounded-full border-2" style={{ borderColor: ACCENT[c.accent], background: "var(--surface-1)" }} />
                  <ChapterGlyph n={c.n} accent={ACCENT[c.accent]} className="hidden md:block absolute right-0 top-0 w-[68px] h-[68px] opacity-90" />
                  <div className="mono text-[10px] tracking-[0.16em] mb-2" style={{ color: ACCENT[c.accent] }}>{c.eyebrow}</div>
                  <h3 className="font-display text-[clamp(19px,2.3vw,26px)] leading-[1.15] text-[var(--text-1)] mb-2.5">{c.title}</h3>
                  <p className="text-[14.5px] leading-[1.65] text-[var(--text-2)] max-w-[620px]">{c.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </div>

        {/* the evidence chamber (content always present, no-JS safe) */}
        <section className="max-w-[1000px] mx-auto px-6 py-[90px]">
          <div className="lz-reveal mb-8 max-w-[680px]">
            <div className="mono text-[11px] uppercase tracking-[0.14em] text-[var(--contra)] mb-3.5">Inside a contradiction</div>
            <h2 className="font-display text-[clamp(28px,3.6vw,46px)] leading-[1.08]">The Evidence Chamber: why two findings disagree.</h2>
            <p className="text-[16px] leading-[1.6] text-[var(--text-2)] mt-[18px]">
              When ScholarLens finds a real contradiction it doesn&apos;t pick a winner — it lays out
              both claims, what they share, how their methods differ, and the research gap the
              disagreement opens up.
            </p>
          </div>
          <div className="lz-reveal rounded-[var(--r-xl)] border border-[var(--line-2)] bg-[var(--surface-2)] p-5 sm:p-7">
            <div className="mono text-[10px] tracking-[0.22em] text-[#ff9696] mb-5 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-[var(--contra)]" style={{ boxShadow: "0 0 10px var(--contra)" }} />
              EVIDENCE CHAMBER · WHY FINDINGS DISAGREE
            </div>
            <ChamberBody />
          </div>
        </section>

        {/* what you get — qualitative, no invented numbers */}
        <div className="border-y border-[var(--line)]" style={{ background: "var(--surface-1)" }}>
          <section className="lz-reveal max-w-[1000px] mx-auto px-6 py-[64px]">
            <div className="mono text-[10px] tracking-[0.16em] text-[var(--text-muted)] mb-9 text-center">WHAT YOU GET FROM EVERY LIBRARY</div>
            <div className="grid sm:grid-cols-3 gap-8">
              {[
                { t: "Every claim, extracted", d: "Each finding pulled out as a discrete claim, traced to the exact paper it came from.", c: "var(--text-2)" },
                { t: "Every conflict, surfaced", d: "Pairs of claims that directly contradict each other, with the reasoning laid out.", c: "var(--contra)" },
                { t: "Every gap, a hypothesis", d: "The questions your evidence points to but no paper has answered yet.", c: "#35d0c0" },
              ].map((m) => (
                <div key={m.t}>
                  <div className="w-8 h-[2px] rounded-full mb-4" style={{ background: m.c }} />
                  <div className="font-display text-[19px] text-[var(--text-1)] leading-snug mb-2">{m.t}</div>
                  <div className="text-[13.5px] text-[var(--text-2)] leading-[1.6]">{m.d}</div>
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* close / CTA */}
        <section id="get-started" className="relative text-center px-6 pt-[120px] pb-[100px] overflow-hidden">
          <div className="absolute inset-0 pointer-events-none" style={{ background: "radial-gradient(ellipse 60% 50% at 50% 100%, rgba(124,111,255,0.12) 0%, transparent 70%)" }} />
          <div className="relative z-[1] inline-block border border-[var(--line-2)] rounded-[var(--r-xl)] px-8 sm:px-10 py-12 max-w-[620px]" style={{ background: "var(--surface-1)", boxShadow: "0 0 80px -20px rgba(124,111,255,0.18)" }}>
            <h2 className="font-display text-[clamp(26px,3.8vw,48px)] leading-[1.05]">
              You can&apos;t read all of it.
              <br />
              <span className="italic text-[var(--gen)]">You don&apos;t have to.</span>
            </h2>
            <p className="text-[15.5px] text-[var(--text-2)] mt-4 leading-[1.6]">
              Point ScholarLens at your library and watch the claims, contradictions, and gaps surface — in minutes.
            </p>
            <div className="mt-7 flex flex-col items-center gap-3">
              <button onClick={go} className="inline-flex items-center gap-2 text-[14.5px] font-medium text-white bg-[#6a5cea] px-[22px] py-3 rounded-[var(--r-md)] t-all hover:opacity-90 hover:glow-gen">
                Enter ScholarLens <ArrowRight size={15} />
              </button>
              <span className="text-[12.5px] text-[var(--text-muted)]">Free to start · no credit card needed</span>
            </div>
          </div>
        </section>

        <footer className="border-t border-[var(--line)] py-7 text-center text-[12.5px] text-[var(--text-muted)]">
          ScholarLens · Built by Aakash Shahani
        </footer>
      </main>

      {/* Evidence Chamber modal — opened by the cinematic's contradiction markers */}
      <ChamberModal open={chamberOpen} onClose={closeChamber} />
    </div>
  );
}
