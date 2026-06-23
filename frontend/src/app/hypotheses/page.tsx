"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, Paper, Hypothesis } from "@/lib/api";
import { PageHeader, Card, EmptyState, Spinner, Slider, SelectChip, PrimaryButton, SectionLabel, Claim } from "@/components/ui";
import { FlaskConical, TriangleAlert, GitBranch, AlertCircle, CheckCircle2, Zap, RefreshCw } from "lucide-react";
import { cache } from "@/lib/cache";

// Novelty tier badge — shows only when the hypothesis is genuinely high
// novelty (score > 0.30 for voyage-3.5-lite). Medium and low are silent:
// showing "Medium novelty" on every card adds no signal. The novelty rail
// on the right already communicates relative ordering visually.
function NoveltyBadge({ score }: { score: number }) {
  if (score > 0.30) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium"
        style={{ background: "var(--support-dim)", color: "var(--support)" }}>
        High novelty
      </span>
    );
  }
  if (score > 0.12) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-[var(--surface-3)]"
        style={{ color: "var(--text-3)" }}>
        Explores covered ground
      </span>
    );
  }
  // Low novelty — say nothing, the bar rail communicates it
  return null;
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
  const [libraryChanged, setLibraryChanged] = useState(false);

  // Build a cache key from sorted paper IDs so switching selections
  // never shows results from a different scope.
  const selectionCacheKey = (ids: string[], allPapers: Paper[]) => {
    // Treat "all papers explicitly selected" the same as "none selected (= all)"
    // so the cache hit works regardless of how the user made the selection.
    const allSelected = ids.length === allPapers.length && allPapers.length > 0;
    return (ids.length === 0 || allSelected) ? "hypotheses:all"
      : `hypotheses:${[...ids].sort().join(",")}`;
  };

  useEffect(() => {
    const cachedPapers = cache.read<Paper[]>("papers");
    if (cachedPapers?.length) setPapers(cachedPapers);
    api.listPapers(50).then((p) => { setPapers(p); cache.write("papers", p); });

    // On initial load, no selection is made yet — try the server cache directly.
    // localStorage is only read once the user has an active selection (in generate).
    api.getCachedHypotheses()
      .then((hyps) => {
        if (hyps && hyps.length > 0) {
          setHypotheses(hyps);
          // Write under the "all" key so subsequent loads with no selection hit this
          cache.write(selectionCacheKey([], papers), hyps);
        } else {
          setShowConfig(true);
        }
      })
      .catch(() => setShowConfig(true));

    // Fingerprint check — warn if library changed since last generation
    api.health().then((h) => {
      const fingerprint = h.library_fingerprint || "default";
      const cachedFp = cache.read<string>("hypotheses_fp");
      if (cachedFp && cachedFp !== fingerprint) setLibraryChanged(true);
    }).catch(() => {});
  }, []);

  const maxNoveltyScore = useMemo(
    () => Math.max(...hypotheses.map((x) => x.novelty_score || 0), 0.0001),
    [hypotheses]
  );

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };
  useEffect(() => () => stopPolling(), []);

  const generate = async () => {
    setLoading(true); setHypotheses([]); setError("");
    const cacheKey = selectionCacheKey(selectedIds, papers);

    // Serve from localStorage cache if library hasn't changed
    if (!libraryChanged) {
      const localHit = cache.read<Hypothesis[]>(cacheKey);
      if (localHit && localHit.length > 0) {
        setHypotheses(localHit);
        setShowConfig(false);
        setLoading(false);
        return;
      }
    }

    try {
      const { job_id } = await api.generateHypotheses({
        researchQuestion: question || undefined,
        // If all papers are selected or none are, pass undefined (= all papers).
        paperIds: (selectedIds.length === 0 || selectedIds.length === papers.length)
          ? undefined
          : selectedIds,
        numHypotheses: count,
        refresh: true,
      });

      cache.write("hypotheses_job", job_id);
      stopPolling();
      pollRef.current = setInterval(async () => {
        try {
          const job = await api.getJob<Hypothesis[]>(job_id);
          if (job.status === "done" && job.result) {
            stopPolling();
            cache.clear("hypotheses_job");
            setHypotheses(job.result);
            cache.write(cacheKey, job.result);
            setShowConfig(false);
            setLibraryChanged(false);
            api.health().then((h) => {
              const fp = h.library_fingerprint || "default";
              cache.write("hypotheses_fp", fp);
            }).catch(() => {});
            setLoading(false);
          } else if (job.status === "error") {
            stopPolling();
            cache.clear("hypotheses_job");
            setError(job.error || "Generation failed.");
            setLoading(false);
          }
        } catch (e: any) {
          stopPolling();
          setError(e.message);
          setLoading(false);
        }
      }, 2500);
    } catch (e: any) {
      setError(e.message);
      setLoading(false);
    }
  };

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

      {libraryChanged && !showConfig && (
        <div className="bg-[var(--nuance-dim)] border border-[var(--nuance-line)] rounded-[var(--r-lg)] p-4 mb-4 flex items-center gap-3">
          <AlertCircle size={15} className="text-[var(--nuance)] shrink-0" />
          <div className="flex-1 text-[13px] text-[var(--text-2)]">
            Your library has changed — these hypotheses may not reflect your latest papers.
          </div>
          <button
            onClick={() => { setShowConfig(true); setLibraryChanged(false); }}
            className="text-[12px] text-[var(--gen)] font-medium hover:underline shrink-0 t-all"
          >
            Regenerate
          </button>
        </div>
      )}

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
                <div className="flex items-center justify-between mb-2.5">
                <div className="text-[11px] font-medium text-[var(--text-3)] uppercase tracking-wider">Focus papers · leave empty for all</div>
                <div className="flex gap-2">
                  <button onClick={() => setSelectedIds(papers.map(p => p.id))}
                    className="text-[11px] text-[var(--gen)] hover:underline t-all">
                    Select all
                  </button>
                  <span className="text-[11px] text-[var(--text-4)]">·</span>
                  <button onClick={() => setSelectedIds([])}
                    className="text-[11px] text-[var(--text-3)] hover:underline t-all">
                    Clear
                  </button>
                </div>
              </div>
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

          {hypotheses.length > 0 && (() => {
            // No rank map needed — NoveltyBadge uses absolute score, not rank.
            // The rail sorts and displays relative ordering visually.

            return (
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
                              <CheckCircle2 size={11} /> grounded in detected conflict
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-[11px] text-[var(--text-3)]">
                              <Zap size={11} /> gap-based
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="mb-3">
                        <NoveltyBadge score={h.novelty_score || 0} />
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

              {/* Novelty ranking — relative bars, no raw cosine numbers.
                  The score drives width and order; we show rank position so the
                  rail is self-explanatory without exposing a meaningless float. */}
              <div className="sticky top-6 self-start">
                <Card>
                  <SectionLabel>Novelty ranking</SectionLabel>
                  <div className="text-[11px] text-[var(--text-3)] mb-3 leading-[1.5]">
                    How different each hypothesis is from what your library already covers. Longer bars sit in less-explored territory.
                  </div>
                  <div className="text-[9.5px] text-[var(--text-4)] uppercase tracking-wider mb-2.5">
                    Sorted by distance from library
                  </div>
                  <div className="space-y-2.5">
                    {[...hypotheses]
                      .sort((a, b) => (b.novelty_score || 0) - (a.novelty_score || 0))
                      .map((h, rankIdx) => {
                        const cardNum = hypotheses.indexOf(h) + 1;
                        const score = h.novelty_score || 0;
                        const color = score > 0.30 ? "var(--support)" : score > 0.12 ? "var(--nuance)" : "var(--text-3)";
                        // Width is relative to the top-ranked bar so differences
                        // are visible even when absolute scores cluster tightly.
                        const width = 30 + (score / maxNoveltyScore) * 70; // floor 30% so smallest bar still reads
                        return (
                          <div key={h.id} className="flex items-center gap-2.5">
                            <span className="mono text-[11px] text-[var(--text-3)] w-5 shrink-0">H{cardNum}</span>
                            <div className="flex-1 h-[6px] bg-[var(--surface-3)] rounded-full overflow-hidden">
                              <div className="h-full rounded-full t-all" style={{ width: `${width}%`, background: color }} />
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </Card>
              </div>
            </div>
            );
          })()}
        </>
      )}
    </div>
  );
}
