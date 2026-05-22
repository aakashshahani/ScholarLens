"use client";

import { useEffect, useState } from "react";
import { api, Paper, Hypothesis } from "@/lib/api";
import { PageHeader, Card, EmptyState, Spinner, Slider, SelectChip, PrimaryButton, LevelBadge, SectionLabel, Claim } from "@/components/ui";
import { FlaskConical, FileText, TriangleAlert, GitBranch } from "lucide-react";

export default function HypothesesPage() {
  const [papers, setPapers] = useState<Paper[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [question, setQuestion] = useState("");
  const [count, setCount] = useState(5);
  const [hypotheses, setHypotheses] = useState<Hypothesis[]>([]);
  const [loading, setLoading] = useState(false);
  const [showLineage, setShowLineage] = useState<Record<string, boolean>>({});

  useEffect(() => { api.listPapers(50).then(setPapers); }, []);

  const generate = async () => {
    setLoading(true); setHypotheses([]);
    try { setHypotheses(await api.generateHypotheses({ researchQuestion: question || undefined, paperIds: selectedIds.length ? selectedIds : undefined, numHypotheses: count })); }
    catch (e: any) { alert(e.message); }
    setLoading(false);
  };

  const lvl = (s: string) => (s === "high" ? 0.85 : s === "medium" ? 0.5 : 0.2);

  return (
    <div>
      <PageHeader title="Generative bench" subtitle="Hypotheses synthesized from the gaps between your papers." />

      {papers.length < 1 ? <EmptyState icon={<FlaskConical size={20} />} title="Add papers first" /> : (
        <>
          <Card className="mb-6">
            <div className="mb-5">
              <div className="text-[11px] font-medium text-[var(--text-3)] uppercase tracking-wider mb-2">Research question · optional</div>
              <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="e.g., How can AI improve negotiation training outcomes?"
                className="w-full bg-[var(--surface-1)] border border-[var(--line)] rounded-[var(--r-md)] px-3.5 py-2.5 text-[13.5px] text-[var(--text-1)]" />
            </div>
            <div className="mb-5">
              <div className="text-[11px] font-medium text-[var(--text-3)] uppercase tracking-wider mb-2.5">Focus papers · empty = all</div>
              <div className="flex flex-wrap gap-1.5">
                {papers.map((p) => <SelectChip key={p.id} label={p.title.length > 44 ? p.title.slice(0,44)+"…" : p.title} active={selectedIds.includes(p.id)} onClick={() => setSelectedIds((ids) => ids.includes(p.id) ? ids.filter((x) => x !== p.id) : [...ids, p.id])} />)}
              </div>
            </div>
            <div className="mb-5 max-w-[280px]"><Slider label="Number of hypotheses" value={count} min={3} max={8} step={1} onChange={(v) => setCount(Math.round(v))} /></div>
            <PrimaryButton onClick={generate} disabled={loading}><FlaskConical size={15} /> {loading ? "Generating…" : "Generate hypotheses"}</PrimaryButton>
          </Card>

          {loading && <Card className="mb-6"><Spinner label="Analyzing gaps across papers…" /></Card>}

          {hypotheses.length > 0 && (
            <div className="grid grid-cols-[1fr_260px] gap-4 fade-up">
              <div className="space-y-4">
                {hypotheses.map((h, i) => {
                  const open = showLineage[h.id];
                  return (
                    <Card key={h.id}>
                      <div className="flex items-center justify-between mb-3">
                        <span className="inline-flex items-center justify-center w-7 h-7 rounded-[var(--r-md)] bg-[var(--gen-dim)] text-[var(--gen)] text-[12px] font-medium mono">H{i+1}</span>
                        <div className="flex gap-1.5"><LevelBadge label="novelty" level={h.novelty} /><LevelBadge label="impact" level={h.impact} /></div>
                      </div>
                      <div className="font-display text-[17px] text-[var(--text-1)] leading-[1.35] mb-2.5">{h.statement}</div>
                      <div className="text-[13.5px] text-[var(--text-2)] leading-[1.7] mb-4">{h.rationale}</div>

                      <button onClick={() => setShowLineage((s) => ({ ...s, [h.id]: !s[h.id] }))}
                        className="flex items-center gap-1.5 text-[12px] text-[var(--gen)] font-medium mb-3 hover:gap-2 t-all">
                        <GitBranch size={13} /> {open ? "Hide" : "Show"} lineage · {h.supporting_papers.length} sources
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

                      <SectionLabel>How to test</SectionLabel>
                      <div className="text-[13px] text-[var(--text-2)] leading-[1.65] mb-4">{h.methodology}</div>
                      <SectionLabel>Anticipated challenges</SectionLabel>
                      <div className="flex flex-wrap gap-1.5">
                        {h.challenges.map((ch, j) => <span key={j} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-medium" style={{ background: "var(--contra-dim)", color: "var(--contra)" }}><TriangleAlert size={11} />{ch}</span>)}
                      </div>
                    </Card>
                  );
                })}
              </div>

              {/* Novelty x Impact plot */}
              <div className="sticky top-6 self-start">
                <Card>
                  <SectionLabel>Novelty × Impact</SectionLabel>
                  <div className="relative aspect-square bg-[var(--surface-1)] rounded-[var(--r-md)] border border-[var(--line)] mt-1">
                    <div className="absolute inset-0 grid grid-cols-2 grid-rows-2">
                      {["", "", "", ""].map((_, i) => <div key={i} className="border border-[var(--line)]" />)}
                    </div>
                    <span className="absolute top-1.5 right-2 text-[9px] text-[var(--support)] uppercase tracking-wide">prime</span>
                    {hypotheses.map((h, i) => (
                      <div key={h.id} className="absolute w-5 h-5 rounded-full bg-[var(--gen)] flex items-center justify-center text-[9px] text-white font-medium mono -translate-x-1/2 translate-y-1/2 t-all hover:scale-125 cursor-pointer glow-gen"
                        style={{ left: `${lvl(h.novelty) * 100}%`, bottom: `${lvl(h.impact) * 100}%` }} title={h.statement}>H{i+1}</div>
                    ))}
                    <span className="absolute -bottom-5 left-0 text-[9px] text-[var(--text-4)] uppercase tracking-wide">novelty →</span>
                    <span className="absolute -left-1 -top-5 text-[9px] text-[var(--text-4)] uppercase tracking-wide">impact ↑</span>
                  </div>
                  <div className="text-[11px] text-[var(--text-3)] mt-7 leading-[1.5]">Top-right = high novelty, high impact. The bets worth making.</div>
                </Card>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
