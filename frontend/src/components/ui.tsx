"use client";

import { ReactNode } from "react";
import Link from "next/link";
import { Check } from "lucide-react";

/* ── Page header ─────────────────────────────────────────── */
export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between mb-7 fade-up">
      <div>
        <h1 className="font-display text-[28px] leading-[1.05] text-[var(--text-1)]">{title}</h1>
        {subtitle && <p className="text-[14px] text-[var(--text-2)] mt-2">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

/* ── Card ─────────────────────────────────────────────────── */
export function Card({ children, className = "", hover = false }: { children: ReactNode; className?: string; hover?: boolean }) {
  return (
    <div className={`bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-lg)] p-5 ${hover ? "t-all lift cursor-pointer" : ""} ${className}`}>
      {children}
    </div>
  );
}

/* ── Metric tile ─────────────────────────────────────────── */
export function MetricCard({ value, label, color = "var(--gen)", barPercent, icon }: { value: string | number; label: string; color?: string; barPercent?: number; icon?: ReactNode }) {
  return (
    <div className="relative bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-lg)] p-5 overflow-hidden t-all lift">
      <div className="flex items-start justify-between">
        <div>
          <div className="font-display text-[28px] leading-none text-[var(--text-1)] tabular-nums">{value}</div>
          <div className="text-[12px] text-[var(--text-2)] mt-2">{label}</div>
        </div>
        {icon && <div style={{ color }} className="opacity-80">{icon}</div>}
      </div>
      {barPercent !== undefined && (
        <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-[var(--surface-3)]">
          <div className="h-full t-all" style={{ width: `${Math.min(100, barPercent)}%`, background: color }} />
        </div>
      )}
    </div>
  );
}

/* ── Claim text (mono = machine-extracted) ───────────────── */
export function Claim({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`mono text-[12.5px] leading-[1.55] text-[var(--text-1)] ${className}`}>{children}</span>;
}

/* ── Reasoning palette ───────────────────────────────────── */
export const REL: Record<string, { c: string; dim: string; line: string; label: string }> = {
  contradiction: { c: "var(--contra)", dim: "var(--contra-dim)", line: "var(--contra-line)", label: "Contradiction" },
  support:       { c: "var(--support)", dim: "var(--support-dim)", line: "var(--support-line)", label: "Support" },
  nuance:        { c: "var(--nuance)", dim: "var(--nuance-dim)", line: "var(--nuance-line)", label: "Nuance" },
  unrelated:     { c: "var(--text-3)", dim: "var(--surface-3)", line: "var(--line-2)", label: "Unrelated" },
};

export function RelDot({ type }: { type: string }) {
  const s = REL[type] || REL.unrelated;
  return <span className="inline-block w-[6px] h-[6px] rounded-full" style={{ background: s.c }} />;
}

export function RelPill({ type }: { type: string }) {
  const s = REL[type] || REL.unrelated;
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium" style={{ background: s.dim, color: s.c }}>
      <span className="w-[6px] h-[6px] rounded-full" style={{ background: s.c }} />
      {s.label}
    </span>
  );
}

/* ── Analysis tag ────────────────────────────────────────── */
const TAG: Record<string, string> = {
  summary: "var(--support)", methods: "#5B9BE0", findings: "var(--nuance)",
  limitations: "var(--contra)", key_claims: "var(--gen)", research_gaps: "#D86FB0",
};
export function AnalysisTag({ type }: { type: string }) {
  const c = TAG[type] || "var(--text-3)";
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[var(--r-sm)] text-[11px] font-medium bg-[var(--surface-3)]" style={{ color: c }}>
      <span className="w-[5px] h-[5px] rounded-full" style={{ background: c }} />
      {type.replace("_", " ")}
    </span>
  );
}

/* ── Progress ring ───────────────────────────────────────── */
export function ProgressRing({ done, total = 6, size = 30 }: { done: number; total?: number; size?: number }) {
  const r = (size - 4) / 2;
  const circ = 2 * Math.PI * r;
  const pct = total > 0 ? done / total : 0;
  const complete = done >= total;
  const color = complete ? "var(--support)" : "var(--gen)";
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} title={`${done}/${total} analyses`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth="2.5" />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round"
          strokeDasharray={circ} strokeDashoffset={circ * (1 - pct)} style={{ transition: "stroke-dashoffset .5s ease" }} />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        {complete ? <Check size={13} strokeWidth={3} style={{ color }} /> : <span className="text-[9px] font-medium text-[var(--text-2)] tabular-nums">{done}</span>}
      </div>
    </div>
  );
}

/* ── Level badge ─────────────────────────────────────────── */
export function LevelBadge({ label, level }: { label: string; level: "high" | "medium" | "low" }) {
  const c = { high: "var(--support)", medium: "var(--nuance)", low: "var(--text-3)" }[level];
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-[var(--surface-3)]" style={{ color: c }}>
      {label} · {level}
    </span>
  );
}

/* ── Paper row card ──────────────────────────────────────── */
const PCOLORS = ["var(--support)", "var(--gen)", "var(--nuance)", "#5B9BE0", "#D86FB0", "var(--contra)"];
export function PaperCard({ id, title, authors, year, source, pageCount, analysisTypes, colorIndex = 0, contradictions = 0, supports = 0 }: {
  id: string; title: string; authors: string[]; year: number | null; source: string; pageCount: number | null; analysisTypes?: string[]; colorIndex?: number; contradictions?: number; supports?: number;
}) {
  const authorsStr = authors.length > 3 ? authors.slice(0, 3).join(", ") + ` +${authors.length - 3}` : authors.join(", ") || "—";
  const color = PCOLORS[colorIndex % PCOLORS.length];
  const total = analysisTypes?.length || 0;
  return (
    <Link href={`/paper/${id}`} className="block group">
      <div className="bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-lg)] flex overflow-hidden t-all group-hover:border-[var(--line-2)] group-hover:bg-[var(--surface-3)]">
        <div className="w-[3px] shrink-0" style={{ background: color }} />
        <div className="p-4 pl-[18px] flex-1 min-w-0">
          <div className="text-[15px] font-medium text-[var(--text-1)] leading-[1.35] mb-2 clamp-2 group-hover:text-white t-all">{title}</div>
          <div className="text-[12.5px] text-[var(--text-2)] mb-3 flex items-center gap-1.5 flex-wrap">
            <span>{authorsStr}</span><span className="text-[var(--text-4)]">·</span>
            <span className="text-[var(--text-3)]">{year || "?"}</span><span className="text-[var(--text-4)]">·</span>
            <span className="text-[var(--text-3)]">{pageCount || "?"}p</span><span className="text-[var(--text-4)]">·</span>
            <span className="text-[var(--text-3)] capitalize">{source.replace("_", " ")}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1">{analysisTypes?.map((t) => <AnalysisTag key={t} type={t} />)}</div>
            <div className="flex items-center gap-2.5 shrink-0">
              {contradictions > 0 && <span className="flex items-center gap-1 text-[11px] text-[var(--text-2)]"><RelDot type="contradiction" />{contradictions}</span>}
              {supports > 0 && <span className="flex items-center gap-1 text-[11px] text-[var(--text-2)]"><RelDot type="support" />{supports}</span>}
              <ProgressRing done={total} />
            </div>
          </div>
        </div>
      </div>
    </Link>
  );
}

/* ── Slider w/ filled track + value ──────────────────────── */
export function Slider({ label, value, min, max, step, onChange, format }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format?: (v: number) => string; }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div>
      <div className="flex items-center justify-between mb-2.5">
        <label className="text-[11px] font-medium text-[var(--text-3)] uppercase tracking-wide">{label}</label>
        <span className="mono text-[12px] text-[var(--gen)] tabular-nums">{format ? format(value) : value}</span>
      </div>
      <div className="relative">
        <div className="absolute top-1/2 left-0 -translate-y-1/2 h-[5px] rounded-full bg-[var(--gen)] pointer-events-none" style={{ width: `${pct}%` }} />
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} className="relative w-full" style={{ background: "transparent" }} />
      </div>
    </div>
  );
}

/* ── Selectable chip ─────────────────────────────────────── */
export function SelectChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--r-md)] text-[12px] border t-all ${active ? "bg-[var(--gen-dim)] text-[var(--gen)] border-[var(--gen-line)]" : "bg-[var(--surface-2)] text-[var(--text-2)] border-[var(--line)] hover:border-[var(--line-2)] hover:text-[var(--text-1)]"}`}>
      {active && <Check size={12} strokeWidth={3} />}{label}
    </button>
  );
}

/* ── Filter chip ─────────────────────────────────────────── */
export function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`px-3 py-1.5 rounded-full text-[12.5px] border t-all ${active ? "bg-[var(--text-1)] text-[var(--canvas)] border-[var(--text-1)] font-medium" : "bg-[var(--surface-2)] text-[var(--text-2)] border-[var(--line)] hover:border-[var(--line-2)] hover:text-[var(--text-1)]"}`}>
      {label}
    </button>
  );
}

/* ── Primary button ──────────────────────────────────────── */
export function PrimaryButton({ children, onClick, disabled, full = true }: { children: ReactNode; onClick?: () => void; disabled?: boolean; full?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} className={`${full ? "w-full" : ""} flex items-center justify-center gap-2 py-2.5 px-5 rounded-[var(--r-md)] bg-[var(--gen)] text-white text-[13.5px] font-medium t-all hover:opacity-90 hover:glow-gen active:translate-y-px disabled:opacity-40 disabled:pointer-events-none`}>
      {children}
    </button>
  );
}

/* ── Section label ───────────────────────────────────────── */
export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="text-[11px] font-medium text-[var(--text-3)] uppercase tracking-wider mb-2.5">{children}</div>;
}

/* ── Empty state ─────────────────────────────────────────── */
export function EmptyState({ icon, title, hint, action }: { icon: ReactNode; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="text-center py-16 fade-up">
      <div className="inline-flex items-center justify-center w-12 h-12 rounded-[var(--r-lg)] bg-[var(--surface-2)] border border-[var(--line)] text-[var(--text-3)] mb-4">{icon}</div>
      <div className="text-[var(--text-2)] font-medium">{title}</div>
      {hint && <div className="text-[13px] text-[var(--text-3)] mt-1.5">{hint}</div>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}

/* ── Spinner ─────────────────────────────────────────────── */
export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2.5 text-[13px] text-[var(--text-2)]">
      <div className="w-4 h-4 border-2 border-[var(--surface-3)] border-t-[var(--gen)] rounded-full animate-spin" />
      {label && <span>{label}</span>}
    </div>
  );
}

/* ── Skeleton ────────────────────────────────────────────── */
export function SkeletonCard() {
  return (
    <div className="bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-lg)] p-4 pl-[18px] space-y-3">
      <div className="skeleton h-[18px] w-3/4" /><div className="skeleton h-3 w-1/2" />
      <div className="flex gap-1.5"><div className="skeleton h-4 w-14" /><div className="skeleton h-4 w-14" /><div className="skeleton h-4 w-14" /></div>
    </div>
  );
}
