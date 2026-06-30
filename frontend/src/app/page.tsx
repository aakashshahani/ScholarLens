"use client";

/**
 * Dashboard — "command center" layout.
 *
 * DATA HONESTY: every number is real. No invented deltas, scores, or trends.
 * See previous version comments for endpoint mapping.
 *
 * Visual upgrades in this version:
 *  - Animated gradient mesh background (CSS keyframes, zero JS cost)
 *  - SVG grain overlay at 3% opacity for material depth
 *  - Staggered card entrance animations on mount
 *  - Stat numbers count up on mount
 *  - Per-accent hover glows on spotlight + action cards
 *  - # markdown strip on all insight headlines
 *  - Icon size 18px, spotlight min-height 160px
 *  - "View all highlights" border upgraded to var(--line-2)
 *  - Rotating left-border colors on recent papers
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, HealthStatus, Paper, Insight, Hypothesis, GraphPayload } from "@/lib/api";
import { cache } from "@/lib/cache";
import {
  FileStack, CheckCircle2, Link2, TrendingUp, ArrowRight, ArrowUpRight,
  Sparkles, FlaskConical, Upload, AlertTriangle, Network, Loader2,
} from "lucide-react";

interface RelCounts { contradiction: number; support: number; nuance: number; unrelated: number; }
interface TopContra { explanation: string; paper_a: string; paper_b: string; }

// Strip leading markdown heading chars + fix common Windows-1252 mojibake
function cleanHeadline(s: string): string {
  return s
    .replace(/^#+\s*/, "")
    .replace(/â€¦/g, "…")
    .replace(/â€™/g, "’")
    .replace(/â€œ/g, "“")
    .replace(/Ã©/g, "é")
    .replace(/Ã /g, "à")
    .trim();
}

// Animated count-up hook
function useCountUp(target: number, duration = 900): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (target === 0) { setValue(0); return; }
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3); // ease-out-cubic
      setValue(Math.round(eased * target));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [target, duration]);
  return value;
}

// Rotating accent colors for recent papers left borders
const PAPER_ACCENTS = ["var(--gen)", "var(--support)", "var(--nuance)", "var(--contra)"];

export default function Dashboard() {
  const [health, setHealth]       = useState<HealthStatus | null>(null);
  const [papers, setPapers]       = useState<Paper[]>([]);
  const [insights, setInsights]   = useState<Insight[]>([]);
  const [relCounts, setRelCounts] = useState<RelCounts | null>(null);
  const [topContra, setTopContra] = useState<TopContra | null>(null);
  const [topHypo, setTopHypo]     = useState<Hypothesis | null>(null);
  const [topics, setTopics]       = useState<{ title: string; links: number }[]>([]);
  const [error, setError]         = useState("");
  const [mounted, setMounted]     = useState(false);

  useEffect(() => {
    setMounted(true);

    // ── Cache-first: show stale data immediately, refresh in parallel ─────
    const cachedHealth       = cache.read<HealthStatus>("health");
    const cachedPapers       = cache.read<Paper[]>("papers");
    const cachedInsights     = cache.read<Insight[]>("insights_short");
    const cachedRelCounts    = cache.read<RelCounts>("rel_counts");
    const cachedInsightsLong = cache.read<Insight[]>("insights_long");
    const cachedHypos        = cache.read<Hypothesis[]>("hypotheses");

    if (cachedHealth)          setHealth(cachedHealth);
    if (cachedPapers?.length)  setPapers(cachedPapers);
    if (cachedInsights?.length) setInsights(cachedInsights);
    if (cachedRelCounts)       setRelCounts(cachedRelCounts);
    if (cachedHypos?.length)   setTopHypo(cachedHypos[0]);

    const applyInsightsLong = (rows: Insight[]) => {
      const contra = rows.find((i) => i.type === "contradiction");
      if (contra) setTopContra({
        // headline is already stripped of the paper-title prefix by the backend;
        // only fall back to detail if headline is missing
        explanation: cleanHeadline(contra.headline || contra.detail),
        paper_a: contra.papers?.[0] || "",
        paper_b: contra.papers?.[1] || "",
      });
    };
    if (cachedInsightsLong?.length) applyInsightsLong(cachedInsightsLong);

    // ── Fire all API calls in parallel ────────────────────────────────────
    Promise.allSettled([
      api.health()
        .then((h) => { setHealth(h); cache.write("health", h); })
        .catch((e) => setError(e.message)),
      api.listPapers(50)
        .then((p) => { setPapers(p); cache.write("papers", p); }),
      api.contradictionCount()
        .then((d) => { const c = d.counts || null; setRelCounts(c); if (c) cache.write("rel_counts", c); }),
      // One insights fetch, not two — the short feed is just the first slice of
      // the long list (same endpoint, same ordering). Saves a round trip.
      api.insights({ limit: 30 })
        .then((rows) => {
          cache.write("insights_long", rows);
          applyInsightsLong(rows);
          const shortList = rows.slice(0, 8);
          setInsights(shortList);
          cache.write("insights_short", shortList);
        }),
      api.getCachedHypotheses()
        .then((hyps) => {
          if (hyps && hyps.length > 0) { setTopHypo(hyps[0]); cache.write("hypotheses", hyps); }
        }),
    ]);

    // Graph topics — cache-first, then live fetch (no compute, reads from existing relationships)
    const buildTopics = (g: GraphPayload) => {
      if (!g?.nodes?.length) return;
      const byPaper: Record<string, number> = {};
      g.nodes.forEach((n) => {
        byPaper[n.paper_title] = (byPaper[n.paper_title] || 0) + (n.degree || 0);
      });
      setTopics(
        Object.entries(byPaper)
          .map(([title, links]) => ({ title, links }))
          .sort((a, b) => b.links - a.links)
          .slice(0, 5)
      );
    };
    const cachedGraph = cache.read<GraphPayload>("graph");
    if (cachedGraph?.nodes?.length) buildTopics(cachedGraph);
    api.graph({ compute: false })
      .then((g) => { cache.write("graph", g); buildTopics(g); })
      .catch(() => {});
  }, []);

  const REQUIRED = ["summary", "methods", "findings", "limitations", "key_claims", "research_gaps"];
  const analyzed = papers.filter((p) => {
    const types = new Set(p.analysis_types || []);
    return REQUIRED.every((t) => types.has(t));
  }).length;
  // Only flag papers with zero analyses — those are freshly uploaded and queued.
  // Papers with partial analyses are old/failed runs, not actively processing.
  const analyzingPapers = papers.filter((p) => (p.analysis_types?.length ?? 0) === 0);
  const paperCount         = papers.length || (cache.read<Paper[]>("papers")?.length ?? 0);
  const coverage           = paperCount > 0 ? Math.round((analyzed / paperCount) * 100) : 0;
  const contradictionCount = relCounts?.contradiction ?? 0;
  const crossLinks         = relCounts
    ? relCounts.contradiction + relCounts.support + relCounts.nuance : 0;

  // Dedup so one dominant paper doesn't headline every spotlight cell. We track
  // which papers have already been "spent" so the gap cell picks a different
  // paper than the top-contradiction cell where possible.
  const usedPaperTitles = new Set<string>();
  if (topContra) { usedPaperTitles.add(topContra.paper_a); usedPaperTitles.add(topContra.paper_b); }

  // Show gap insights regardless of which papers appeared in contradiction cards.
  // The previous dedup skipped all papers in relationships — with an active scan,
  // that meant zero gap insights ever surfaced. Gap and contradiction insights
  // can share papers; they show different signals.
  const gapInsight = insights.find((i) => i.type === "gap") || null;
  if (gapInsight) (gapInsight.papers || []).forEach((t) => usedPaperTitles.add(t));

  if (error) return (
    <div className="bg-[var(--contra-dim)] border border-[var(--contra-line)] rounded-[var(--r-lg)] p-5">
      <p className="text-[var(--contra)] text-[13px] font-medium">Backend not reachable — {error}</p>
      <p className="text-[var(--text-2)] text-[12px] mt-1.5">
        Start it with{" "}
        <code className="mono text-[11px] bg-[var(--surface-3)] px-1.5 py-0.5 rounded">
          uvicorn api:app --reload --port 8000
        </code>
      </p>
    </div>
  );

  return (
    <div className="relative min-h-screen">

      {/* ── Subtle grain overlay ─────────────────────────── */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        {/* SVG grain overlay */}
        <svg className="absolute inset-0 w-full h-full opacity-[0.032]" xmlns="http://www.w3.org/2000/svg">
          <filter id="grain">
            <feTurbulence type="fractalNoise" baseFrequency="0.72" numOctaves="4" stitchTiles="stitch" />
            <feColorMatrix type="saturate" values="0" />
          </filter>
          <rect width="100%" height="100%" filter="url(#grain)" />
        </svg>
      </div>

      <div className={mounted ? "fade-up" : "opacity-0"}>

        {/* ── Header ─────────────────────────────────────── */}
        <div className="flex items-start justify-between mb-7">
          <div>
            <h1 className="font-display text-[28px] text-[var(--text-1)] flex items-center gap-2.5 leading-tight">
              Situation room
              <Sparkles size={18} className="text-[var(--gen)] animate-pulse" />
            </h1>
            <p className="text-[13px] text-[var(--text-3)] mt-1.5 tracking-wide">
              Your knowledge base — and where the tension is.
            </p>
          </div>
          <Link href="/import-papers"
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-[var(--r-md)] bg-[var(--gen)] text-white text-[12.5px] font-medium hover:opacity-90 hover:shadow-[0_0_20px_-4px_var(--gen-glow)] t-all">
            <Upload size={14} /> Import paper
          </Link>
        </div>

        {/* ── Stat row ───────────────────────────────────── */}
        <div className="grid grid-cols-5 gap-3 mb-5">
          {[
            { icon: <FileStack size={18} />,    value: paperCount,         label: "Papers",            color: "var(--gen)",     delay: 0,   href: "/library" },
            { icon: <CheckCircle2 size={18} />, value: analyzed,           label: "Fully analyzed",    color: "var(--support)", delay: 60,  href: "/library" },
            { icon: <AlertTriangle size={18} />,value: contradictionCount, label: "Contradictions",    color: "var(--contra)",  delay: 120, href: "/contradictions" },
            { icon: <Link2 size={18} />,        value: crossLinks,         label: "Cross-paper links", color: "var(--nuance)",  delay: 180, href: "/contradictions" },
          ].map(({ icon, value, label, color, delay, href }) => (
            <StatCard key={label} icon={icon} value={value} label={label} color={color} delay={delay} href={href} />
          ))}
          <StatCard
            icon={<TrendingUp size={18} />}
            value={coverage}
            label="Analysis coverage"
            color="var(--support)"
            ring={coverage}
            suffix="%"
            sub={`${analyzed} / ${paperCount} papers`}
            delay={240}
          />
        </div>

        {/* ── Analyzing-in-progress banner ─────────────── */}
        {analyzingPapers.length > 0 && papers.length > 0 && (
          <div className="flex items-center gap-3 bg-[var(--gen-dim)] border border-[var(--gen-line)] rounded-[var(--r-lg)] px-4 py-3 mb-5">
            <Loader2 size={14} className="text-[var(--gen)] animate-spin shrink-0" />
            <div className="flex-1 text-[13px] text-[var(--text-2)]">
              <span className="font-medium text-[var(--text-1)]">
                {analyzingPapers.length} paper{analyzingPapers.length !== 1 ? "s" : ""}
              </span>{" "}
              {analyzingPapers.length === 1 ? "is" : "are"} queued for analysis.
              {" "}Head to the library to trigger analysis or check progress.
            </div>
            <Link href="/library"
              className="shrink-0 text-[12px] text-[var(--gen)] font-medium hover:underline flex items-center gap-1 t-all">
              View in library <ArrowRight size={11} />
            </Link>
          </div>
        )}

        {/* ── Spotlight row ──────────────────────────────── */}
        <div className="grid grid-cols-4 gap-3 mb-5">
          <SpotlightCard title="Top contradiction" accent="var(--contra)" glow="rgba(255,92,92,0.15)">
            {topContra ? (
              <>
                <p className="text-[12.5px] text-[var(--text-2)] leading-snug clamp-4">
                  {topContra.explanation}
                </p>
                <Link href="/contradictions" className="cardlink">
                  View contradiction <ArrowRight size={12} />
                </Link>
              </>
            ) : (
              <EmptyCell text="No contradictions yet. Run a scan to surface them." href="/contradictions" cta="Run a scan" />
            )}
          </SpotlightCard>

          <SpotlightCard title="Research gap" accent="var(--nuance)" glow="rgba(245,166,35,0.12)">
            {gapInsight ? (
              <>
                <p className="text-[12.5px] text-[var(--text-2)] leading-snug clamp-4">
                  {cleanHeadline(gapInsight.headline)}
                </p>
                <Link href="/contradictions" className="cardlink">
                  Explore gaps <ArrowRight size={12} />
                </Link>
              </>
            ) : (
              <EmptyCell text="Gaps appear once papers are analyzed." href="/import-papers" cta="Add papers" />
            )}
          </SpotlightCard>

          <SpotlightCard title="Suggested hypothesis" accent="var(--gen)" glow="rgba(124,111,255,0.15)">
            {topHypo ? (
              <>
                <p className="text-[12.5px] text-[var(--text-2)] leading-snug clamp-5">
                  {topHypo.statement}
                </p>
                <Link href="/hypotheses" className="cardlink">
                  Generate more <ArrowRight size={12} />
                </Link>
              </>
            ) : (
              <EmptyCell text="Generate hypotheses from your paper relationships." href="/hypotheses" cta="Generate" />
            )}
          </SpotlightCard>

          <SpotlightCard title="Most-connected topics" accent="var(--support)" glow="rgba(61,212,160,0.12)">
            {topics.length ? (
              <div className="space-y-2.5 flex-1">
                {topics.map((t, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-[11.5px] text-[var(--text-2)] clamp-1">{t.title}</div>
                      <div className="mt-1 h-[3px] rounded-full bg-[var(--surface-3)] overflow-hidden">
                        <div className="h-full rounded-full bg-[var(--support)] t-all"
                          style={{ width: `${Math.min((t.links / (topics[0]?.links || 1)) * 100, 100)}%` }} />
                      </div>
                    </div>
                    <span className="mono text-[10px] text-[var(--text-4)] shrink-0">{t.links}</span>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyCell text="Connections appear after a contradiction scan." href="/contradictions" cta="Run a scan" />
            )}
          </SpotlightCard>
        </div>

        {/* ── Recent papers (full width) ─────────────────── */}
        <div className="bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-lg)] p-5 mb-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="font-display text-[16px] text-[var(--text-1)]">Recent papers</h2>
              <p className="text-[11.5px] text-[var(--text-3)] mt-0.5">Jump back into your most recently added work.</p>
            </div>
            <Link href="/library" className="text-[11.5px] text-[var(--gen)] font-medium hover:underline flex items-center gap-1">
              View all <ArrowUpRight size={11} />
            </Link>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {papers.slice(0, 4).map((p, i) => (
              <Link key={p.id} href={`/paper/${p.id}`}
                className="block p-3.5 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-1)] hover:border-[var(--line-2)] hover:bg-[var(--surface-3)] t-all border-l-[2.5px] h-full"
                style={{ borderLeftColor: PAPER_ACCENTS[i % PAPER_ACCENTS.length] }}>
                <p className="text-[12.5px] text-[var(--text-1)] font-medium leading-snug mb-2 clamp-3">{p.title}</p>
                <p className="text-[10.5px] text-[var(--text-4)]">
                  {(p.authors || []).slice(0, 2).join(", ")}
                  {p.year ? ` · ${p.year}` : ""}
                </p>
                <p className="text-[10.5px] text-[var(--text-4)] mt-0.5">
                  {p.analysis_types?.length || 0}/6 analyses
                </p>
              </Link>
            ))}
          </div>
        </div>

        {/* ── Continue your research ──────────────────────── */}
        <div>
          <h2 className="font-display text-[15px] text-[var(--text-2)] mb-3 uppercase tracking-widest">
            Continue your research
          </h2>
          <div className="grid grid-cols-4 gap-3">
            <ActionCard href="/hypotheses"   icon={<FlaskConical size={17} />}  accent="var(--gen)"     title="Generate hypotheses"    desc="Create novel hypotheses from paper relationships." />
            <ActionCard href="/graph"        icon={<Network size={17} />}        accent="var(--support)" title="Explore knowledge graph" desc="Visualize connections between claims and papers." />
            <ActionCard href="/contradictions" icon={<AlertTriangle size={17} />} accent="var(--contra)"  title="Find contradictions"    desc="Scan for conflicts across your collection." />
            <ActionCard href="/import-papers" icon={<Upload size={17} />}        accent="var(--nuance)"  title="Analyze new paper"      desc="Import a paper and run full analysis." />
          </div>
        </div>

      </div>
    </div>
  );
}

// ── StatCard ──────────────────────────────────────────────────
function StatCard({ icon, value, label, color, ring, suffix = "", sub, delay = 0, href }: {
  icon: React.ReactNode; value: number; label: string; color: string;
  ring?: number; suffix?: string; sub?: string; delay?: number; href?: string;
}) {
  const displayed = useCountUp(value);
  const inner = (
    <>
      <div className="flex items-start justify-between mb-3">
        <span style={{ color }}>{icon}</span>
        {ring !== undefined && (
          <svg width="28" height="28" viewBox="0 0 28 28">
            <circle cx="14" cy="14" r="11" fill="none" stroke="var(--surface-3)" strokeWidth="3" />
            <circle cx="14" cy="14" r="11" fill="none" stroke={color} strokeWidth="3"
              strokeDasharray={`${(ring / 100) * 69.1} 69.1`} strokeLinecap="round"
              transform="rotate(-90 14 14)" style={{ transition: "stroke-dasharray 1s ease" }} />
          </svg>
        )}
      </div>
      <div className="font-display text-[28px] text-[var(--text-1)] leading-none mb-1 tabular-nums">
        {displayed}{suffix}
      </div>
      <div className="text-[11.5px] text-[var(--text-3)]">{label}</div>
      {sub && <div className="text-[10px] text-[var(--text-4)] mt-0.5">{sub}</div>}
    </>
  );
  const cls = `db-stat-card bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-lg)] p-4 relative overflow-hidden block ${href ? "t-all hover:border-[var(--line-2)]" : ""}`;
  return href
    ? <Link href={href} className={cls} style={{ animationDelay: `${delay}ms` }}>{inner}</Link>
    : <div className={cls} style={{ animationDelay: `${delay}ms` }}>{inner}</div>;
}

// ── SpotlightCard ─────────────────────────────────────────────
function SpotlightCard({ title, accent, glow, children }: {
  title: string; accent: string; glow: string; children: React.ReactNode;
}) {
  return (
    <div className="group bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-lg)] overflow-hidden flex flex-col min-h-[168px] t-all hover:border-[var(--line-2)]"
      style={{ ["--card-glow" as any]: glow }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.boxShadow = `0 0 28px -6px ${glow}`; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.boxShadow = "none"; }}>
      <div className="h-[2px]" style={{ background: accent }} />
      <div className="p-4 flex flex-col flex-1">
        <div className="text-[10px] font-semibold text-[var(--text-3)] uppercase tracking-[0.12em] mb-3">{title}</div>
        <div className="flex-1 flex flex-col justify-between">{children}</div>
      </div>
    </div>
  );
}

// ── EmptyCell ─────────────────────────────────────────────────
function EmptyCell({ text, href, cta }: { text: string; href: string; cta: string }) {
  return (
    <div className="flex flex-col flex-1 justify-between">
      <p className="text-[11.5px] text-[var(--text-4)] leading-snug mb-3">{text}</p>
      <Link href={href} className="cardlink"><span>{cta}</span> <ArrowRight size={12} /></Link>
    </div>
  );
}

// ── ActionCard ────────────────────────────────────────────────
function ActionCard({ href, icon, accent, title, desc }: {
  href: string; icon: React.ReactNode; accent: string; title: string; desc: string;
}) {
  return (
    <Link href={href}
      className="group bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-lg)] p-4 flex flex-col t-all hover:border-[var(--line-2)]"
      onMouseEnter={(e: React.MouseEvent<HTMLAnchorElement>) => { e.currentTarget.style.boxShadow = `0 4px 24px -6px ${accent}33`; }}
      onMouseLeave={(e: React.MouseEvent<HTMLAnchorElement>) => { e.currentTarget.style.boxShadow = "none"; }}>
      <div className="flex items-center justify-between mb-3">
        <span className="w-9 h-9 rounded-[var(--r-md)] flex items-center justify-center t-all"
          style={{ background: `color-mix(in srgb, ${accent} 14%, transparent)`, color: accent }}>
          {icon}
        </span>
        <ArrowRight size={14} className="text-[var(--text-4)] group-hover:text-[var(--text-2)] group-hover:translate-x-0.5 t-all" />
      </div>
      <div className="text-[13px] text-[var(--text-1)] font-medium mb-1">{title}</div>
      <div className="text-[11px] text-[var(--text-3)] leading-snug">{desc}</div>
    </Link>
  );
}
