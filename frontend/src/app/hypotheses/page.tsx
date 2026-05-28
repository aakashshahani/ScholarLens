"use client";

import { useEffect, useState } from "react";
import { api, Paper, Hypothesis } from "@/lib/api";
import { PageHeader, Card, EmptyState, Spinner, Slider, SelectChip, PrimaryButton, SectionLabel, Claim } from "@/components/ui";
import { FlaskConical, TriangleAlert, GitBranch, AlertCircle, CheckCircle2, Zap, RefreshCw } from "lucide-react";
import { cache } from "@/lib/cache";

const NOVELTY_COLOR = {
  high: "var(--support)", medium: "var(--nuance)", low: "var(--text-3)", unknown: "var(--text-4)"
} as const;

function NoveltyPill({ tier, score }: { tier: string; score?: number }) {
  const color = NOVELTY_COLOR[tier as keyof typeof NOVELTY_COLOR] || "var(--text-3)";
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-[var(--surface-3)]" style={{ color }}>
      novelty · {tier}{score !== undefined && score > 0 ? ` (${score.toFixed(2)})` : ""}
    </span>
  );
}

export default function HypothesesPage() {
  const [papers, setPapers] = useState<Paper[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [question, setQuestion] = useState("");
  const [count, setCount] = useState(5);
  const [hypotheses, setHypotheses] = useState<Hypothesis[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showLineage, setShowLineage] = useState<Record<string, boolean>>({});
  const [showConfig, setShowConfig] = useState(false);

  useEffect(() => {
    api.listPapers(50).then(setPapers);
    const cached = cache.read<Hypothesis[]>("hypotheses");
    if (cached && cached.length > 0) {
      setHypotheses(cached);
    } else {
      setShowConfig(true);
    }
  }, []);

  const generate = async () => {
    setLoading(true); setHypotheses([]); setError("");
    try {
      const res = await api.generateHypotheses({
        researchQuestion: question || undefined,
        paperIds: selectedIds.length ? selectedIds : undefined,
        numHypotheses: count,
      });
      setHypotheses(res);
      cache.write("hypotheses", res);
      setShowConfig(false);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const lvl = (s: string) => (s === "high" ? 0.85 : s === "medium" ? 0.5 : 0.2);

  return (
    <div>
      <PageHeader
        title="Generative bench"
        subtitle="Hypotheses synthesized from the gaps and conflicts between your papers."
        action={
          <button onClick={() => setShowConfig((s) => !s)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-2)] text-[12.5px] text-[var(--text-2)] t-all hover:border-[var(--line-2)] hover:text-[var(--text-1)]">
            <RefreshCw size={14} /> {showConfig ? "Hide" : "New generation"}
          </button>
        }
      />

      {papers.length < 1 ? (
        <EmptyState icon={<FlaskConical size={20} />} title="Add papers first"
          hint="The generative bench needs at least one analyzed paper." />
      ) : (
        <>
          {showConfig && (
            <Card className="mb-6 fade-up">
              <div className="mb-5">
                <div className="text-[11px] font-medium text-[var(--text-3)] uppercase tracking-wider mb-2">Research question · optional</div>
                <input value={question} onChange={(e) => setQuestion(e.target.value)}
                  placeholder="e.g., How can AI improve negotiation training outcomes?"
                  className="w-full bg-[var(--surface-1)] border border-[var(--line)] rounded-[var(--r-md)] px-3.5 py-2.5 text-[13.5px] text-[var(--text-1)]" />
              </div>
              <div className="mb-5">
                <div className="text-[11px] font-medium text-[var(--text-3)] uppercase tracking-wider mb-2.5">Focus papers · leave empty for all</div>
                <div className="flex flex-wrap gap-1.5">
                  {papers.map((p) => (
                    <SelectChip key={p.id}
                      label={p.title.length > 44 ? p.title.slice(0, 44) + "…" : p.title}
                      active={selectedIds.includes(p.id)}
                      onClick={() => setSelectedIds((ids) => ids.includes(p.id) ? ids.filter((x) => x !== p.id) : [...ids, p.id])} />
                  ))}
                </div>
              </div>
              <div className="mb-5 max-w-[280px]">
                <Slider label="Number of hypotheses" value={count} min={3} max={8} step={1} onChange={(v) => setCount(Math.round(v))} />
              </div>
              <PrimaryButton onClick={generate} disabled={loading}>
                <FlaskConical size={15} /> {loading ? "Generating…" : "Generate hypotheses"}
              </PrimaryButton>
            </Card>
          )}

          {loading && <Card className="mb-6"><Spinner label="Analyzing conflicts and gaps across papers…" /></Card>}

          {error && (
            <div className="bg-[var(--contra-dim)] border border-[var(--contra-line)] rounded-[var(--r-lg)] p-4 mb-6 flex items-start gap-3">
              <AlertCircle size={16} className="text-[var(--contra)] mt-0.5 shrink-0" />
              <div>
                <div className="text-[13px] text-[var(--contra)] font-medium">Generation failed</div>
                <div className="text-[12px] text-[var(--text-2)] mt-0.5">{error}</div>
              </div>
            </div>
          )}

          {hypotheses.length > 0 && (
            <div className="grid grid-cols-[1fr_240px] gap-4 fade-up">
              <div className="space-y-4">
                {hypotheses.map((h, i) => {
                  const open = showLineage[h.id];
                  const isGrounded = h.grounding === "detected_conflicts" && h.source_conflicts?.length > 0;
                  return (
                    <Card key={h.id}>
                      <div className="flex items-center justify-between mb-3">
                        <span className="inline-flex items-center justify-center w-7 h-7 rounded-[var(--r-md)] bg-[var(--gen-dim)] text-[var(--gen)] text-[12px] font-medium mono">
                          H{i + 1}
                        </span>
                        <div className="flex items-center gap-2">
                          {isGrounded ? (
                            <span className="flex items-center gap-1 text-[11px] text-[var(--support)]">
                              <CheckCircle2 size={11} /> grounded in {h.source_conflicts.length} conflict{h.source_conflicts.length !== 1 ? "s" : ""}
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-[11px] text-[var(--text-3)]">
                              <Zap size={11} /> gap-based
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="mb-3">
                        <NoveltyPill tier={h.novelty_tier || h.novelty} score={h.novelty_score} />
                      </div>

                      <div className="font-display text-[17px] text-[var(--text-1)] leading-[1.35] mb-2.5">{h.statement}</div>
                      <div className="text-[13.5px] text-[var(--text-2)] leading-[1.7] mb-4">{h.rationale}</div>

                      <button onClick={() => setShowLineage((s) => ({ ...s, [h.id]: !s[h.id] }))}
                        className="flex items-center gap-1.5 text-[12px] text-[var(--gen)] font-medium mb-3 hover:gap-2 t-all">
                        <GitBranch size={13} /> {open ? "Hide" : "Show"} source papers · {h.supporting_papers.length} source{h.supporting_papers.length !== 1 ? "s" : ""}
                      </button>

                      {open && (
                        <div className="relative pl-5 mb-4 fade-up">
                          <div className="absolute left-[7px] top-2 bottom-2 w-px bg-[var(--gen-line)]" />
                          {h.supporting_papers.map((sp, j) => (
                            <div key={j} className="relative mb-2.5 last:mb-0">
                              <div className="absolute left-[-18px] top-2.5 w-2 h-2 rounded-full bg-[var(--gen)]" />
                              <div className="bg-[var(--surface-1)] rounded-[var(--r-md)] p-3">
                                <div className="text-[12px] text-[var(--text-1)] font-medium clamp-1">{sp.title}</div>
                                <Claim className="block mt-1 text-[var(--text-2)]">{sp.relevant_finding}</Claim>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      <SectionLabel>Methodology</SectionLabel>
                      <div className="text-[13px] text-[var(--text-2)] leading-[1.65] mb-4">{h.methodology}</div>

                      <SectionLabel>Anticipated challenges</SectionLabel>
                      <div className="flex flex-wrap gap-1.5">
                        {h.challenges.map((ch, j) => (
                          <span key={j} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-medium"
                            style={{ background: "var(--contra-dim)", color: "var(--contra)" }}>
                            <TriangleAlert size={11} />{ch}
                          </span>
                        ))}
                      </div>
                    </Card>
                  );
                })}
              </div>

              {/* Novelty plot — only novelty axis since impact is removed */}
              <div className="sticky top-6 self-start">
                <Card>
                  <SectionLabel>Novelty ranking</SectionLabel>
                  <div className="text-[11px] text-[var(--text-3)] mb-4 leading-[1.5]">
                    Measured as cosine distance from your corpus. Higher = more novel relative to what you've already read.
                  </div>
                  <div className="space-y-2.5">
                    {[...hypotheses]
                      .sort((a, b) => (b.novelty_score || 0) - (a.novelty_score || 0))
                      .map((h, rank) => {
                        const idx = hypotheses.indexOf(h);
                        const score = h.novelty_score || 0;
                        const color = score > 0.5 ? "var(--support)" : score > 0.3 ? "var(--nuance)" : "var(--text-3)";
                        return (
                          <div key={h.id} className="flex items-center gap-2.5">
                            <span className="mono text-[11px] text-[var(--text-3)] w-5 shrink-0">H{idx + 1}</span>
                            <div className="flex-1 h-[5px] bg-[var(--surface-3)] rounded-full overflow-hidden">
                              <div className="h-full rounded-full t-all" style={{ width: `${Math.min(score * 150, 100)}%`, background: color }} />
                            </div>
                            <span className="mono text-[11px] tabular-nums w-8 text-right" style={{ color }}>{score.toFixed(2)}</span>
                          </div>
                        );
                      })}
                  </div>
                </Card>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
