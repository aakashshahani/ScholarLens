"use client";

import { useEffect, useRef, useState } from "react";
import { api, MonitorDigest, MonitorTopic } from "@/lib/api";
import { PageHeader, Card, EmptyState, Spinner, PrimaryButton, SectionLabel } from "@/components/ui";
import { Radar, Plus, X, ExternalLink, AlertCircle, CheckCircle2, Clock, BookPlus, Loader2 } from "lucide-react";
import { cache } from "@/lib/cache";

// Local draft type — what the user is building before saving
interface DraftTopic { name: string; keywords: string[]; sources: string[]; }

const TIER_META: Record<string, { label: string; color: string }> = {
  highly_relevant: { label: "Highly relevant", color: "var(--support)" },
  related:         { label: "Related",          color: "var(--nuance)" },
  tangential:      { label: "Broader field",    color: "var(--text-3)" },
};

function formatLastScanned(iso: string | null): string {
  if (!iso) return "Never scanned";
  const d = new Date(iso);
  const now = new Date();
  const diffH = Math.round((now.getTime() - d.getTime()) / 3600000);
  if (diffH < 1) return "Just now";
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  return `${diffD}d ago`;
}

export default function MonitorPage() {
  // Saved topics (from DB)
  const [savedTopics, setSavedTopics] = useState<MonitorTopic[]>([]);
  const [loadingTopics, setLoadingTopics] = useState(true);

  // Draft topic input
  const [topicName, setTopicName] = useState("");
  const [topicKeywords, setTopicKeywords] = useState("");

  // Scan config — digest email comes from account settings, not entered here
  const [results, setResults] = useState<MonitorDigest[]>([]);

  const [sourcesFailed, setSourcesFailed] = useState<string[]>([]);
  const [showTangential, setShowTangential] = useState<Record<number, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showConfig, setShowConfig] = useState(true);
  const [savingTopic, setSavingTopic] = useState(false);

  // Load saved topics + persisted results on mount.
  // Stale-while-revalidate: paint localStorage instantly, then replace with the
  // DB-persisted results (which survive restarts and are shared across devices).
  useEffect(() => {
    const cachedResults = cache.read<MonitorDigest[]>("monitor_results");
    if (cachedResults && cachedResults.length > 0) {
      setResults(cachedResults);
      setShowConfig(false);
    }

    api.getMonitorResults()
      .then(({ digests }) => {
        if (digests && digests.length > 0) {
          setResults(digests);
          cache.write("monitor_results", digests);
          setShowConfig(false);
        }
      })
      .catch(() => {});

    api.listMonitorTopics()
      .then((topics) => {
        setSavedTopics(topics);
        setLoadingTopics(false);
      })
      .catch(() => setLoadingTopics(false));
  }, []);

  const addTopic = async () => {
    if (!topicName.trim() || !topicKeywords.trim()) return;
    setSavingTopic(true);
    try {
      const topic = await api.createMonitorTopic({
        name: topicName.trim(),
        keywords: topicKeywords.split(",").map((k) => k.trim()).filter(Boolean),
        sources: ["semantic_scholar", "openalex", "arxiv"],
      });
      setSavedTopics((prev) => [...prev, topic]);
      setTopicName("");
      setTopicKeywords("");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSavingTopic(false);
    }
  };

  const removeTopic = async (topicId: string) => {
    try {
      await api.deleteMonitorTopic(topicId);
      setSavedTopics((prev) => prev.filter((t) => t.id !== topicId));
    } catch (e: any) {
      setError(e.message);
    }
  };

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };
  useEffect(() => () => stopPolling(), []);

  const runScan = async () => {
    if (savedTopics.length === 0) { setError("Add at least one topic to monitor."); return; }
    setLoading(true); setError(""); setResults([]);
    try {
      const { job_id } = await api.monitorScan({
        topics: savedTopics.map((t) => ({ name: t.name, keywords: t.keywords, sources: t.sources })),
        email: undefined,
        relevanceThreshold: 0.5,
        maxPerSource: 5,
      });

      cache.write("monitor_job", job_id);
      stopPolling();
      pollRef.current = setInterval(async () => {
        try {
          const job = await api.getJob<{ digests: MonitorDigest[]; sources_failed: string[] }>(job_id);
          if (job.status === "done" && job.result) {
            stopPolling();
            cache.clear("monitor_job");
            setResults(job.result.digests);
            setSourcesFailed(job.result.sources_failed || []);
            cache.write("monitor_results", job.result.digests);
            setShowConfig(false);
            setLoading(false);
          } else if (job.status === "error") {
            stopPolling();
            cache.clear("monitor_job");
            setError(job.error || "Scan failed.");
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

  const totalStrong = results.reduce(
    (n, r) => n + r.papers.filter((p) =>
      p.relevance_tier === "highly_relevant" || p.relevance_tier === "related"
    ).length,
    0
  );

  const [addingIds, setAddingIds] = useState<Record<string, "loading" | "done" | "error" | "dup">>({});

  const addToLibrary = async (p: MonitorDigest["papers"][0]) => {
    const key = p.title;
    setAddingIds((s) => ({ ...s, [key]: "loading" }));
    try {
      const res = await api.importAdd({
        title: p.title,
        authors: p.authors || [],
        abstract: p.abstract || "",
        year: p.year,
        source: p.source || "semantic_scholar",
        source_id: p.url || p.title,
        doi: null,
        pdf_url: p.pdf_url || null,
        url: p.url || "",
        citation_count: null,
      } as any);
      setAddingIds((s) => ({ ...s, [key]: res.status === "duplicate" ? "dup" : "done" }));
    } catch {
      setAddingIds((s) => ({ ...s, [key]: "error" }));
    }
  };

  const renderPaper = (p: MonitorDigest["papers"][0], idx: number) => {
    const tier = TIER_META[p.relevance_tier || "tangential"] || TIER_META.tangential;
    const addStatus = addingIds[p.title];
    return (
      <Card key={idx} className="!p-4">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="text-[13.5px] font-medium text-[var(--text-1)] leading-snug flex-1">{p.title}</div>
          <div className="flex items-center gap-1.5 shrink-0">
            {/* Add to library */}
            {addStatus === "done" ? (
              <span className="text-[11px] text-[var(--support)] flex items-center gap-1">
                <CheckCircle2 size={12} /> Added
              </span>
            ) : addStatus === "dup" ? (
              <span className="text-[11px] text-[var(--text-3)]">Already in library</span>
            ) : addStatus === "error" ? (
              <span className="text-[11px] text-[var(--contra)]">Failed</span>
            ) : (
              <button onClick={() => addToLibrary(p)} disabled={addStatus === "loading"}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-[var(--r-sm)] border border-[var(--line)] text-[11.5px] text-[var(--text-2)] t-all hover:border-[var(--gen-line)] hover:text-[var(--gen)] disabled:opacity-40">
                {addStatus === "loading"
                  ? <Loader2 size={12} className="animate-spin" />
                  : <BookPlus size={12} />}
                Add
              </button>
            )}
            <a href={p.url} target="_blank" rel="noopener noreferrer"
              className="p-1.5 text-[var(--text-3)] hover:text-[var(--gen)] t-all">
              <ExternalLink size={14} />
            </a>
          </div>
        </div>
        <div className="text-[11.5px] text-[var(--text-3)] mb-2.5">
          {p.authors?.slice(0, 3).join(", ") || "Unknown authors"}
          {(p.authors?.length || 0) > 3 && ` +${p.authors.length - 3}`}
          {p.year ? ` · ${p.year}` : ""}
          {" · "}
          <span className="capitalize">{p.source?.replace("_", " ")}</span>
        </div>
        <div className="text-[12.5px] text-[var(--text-2)] leading-[1.6] mb-3 line-clamp-3">
          {p.abstract}
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium" style={{ color: tier.color }}>{tier.label}</span>
          {p.relevance_reason && (
            <span className="text-[11px] text-[var(--text-3)] italic line-clamp-1 max-w-[60%] text-right">
              {p.relevance_reason}
            </span>
          )}
        </div>
      </Card>
    );
  };

  return (
    <div>
      <PageHeader
        title="Research monitor"
        subtitle="Watch arXiv, OpenAlex, and Semantic Scholar for new papers scored against your library. Topics are saved — the scheduler runs daily."
        action={results.length > 0 && (
          <button onClick={() => setShowConfig((s) => !s)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-2)] text-[12.5px] text-[var(--text-2)] t-all hover:border-[var(--line-2)] hover:text-[var(--text-1)]">
            <Radar size={14} /> {showConfig ? "Hide" : "Configure"}
          </button>
        )}
      />

      {showConfig && (
        <div className="fade-up">
          {/* Add topic */}
          <Card className="mb-4">
            <SectionLabel>Add a topic to watch</SectionLabel>
            <div className="grid grid-cols-[1fr_2fr_auto] gap-2 mb-1">
              <input value={topicName} onChange={(e) => setTopicName(e.target.value)}
                placeholder="Topic name (e.g. LLM Negotiation)"
                className="bg-[var(--surface-1)] border border-[var(--line)] rounded-[var(--r-md)] px-3.5 py-2.5 text-[13.5px] text-[var(--text-1)]" />
              <input value={topicKeywords} onChange={(e) => setTopicKeywords(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addTopic()}
                placeholder="Keywords, comma-separated: LLM negotiation, AI coaching, strategic adaptation"
                className="bg-[var(--surface-1)] border border-[var(--line)] rounded-[var(--r-md)] px-3.5 py-2.5 text-[13.5px] text-[var(--text-1)]" />
              <button onClick={addTopic} disabled={savingTopic || !topicName.trim() || !topicKeywords.trim()}
                className="flex items-center gap-1.5 px-3 py-2.5 rounded-[var(--r-md)] bg-[var(--gen-dim)] border border-[var(--gen-line)] text-[var(--gen)] text-[12.5px] font-medium t-all hover:opacity-90 disabled:opacity-40 disabled:pointer-events-none">
                <Plus size={14} /> {savingTopic ? "Saving…" : "Save"}
              </button>
            </div>
            <div className="text-[11px] text-[var(--text-3)] mt-1.5">
              Topics are saved permanently and scanned daily by the scheduler.
              Sources: Semantic Scholar, OpenAlex (250M+ works), and arXiv.
            </div>
          </Card>

          {/* Saved topics list */}
          {loadingTopics ? (
            <Card className="mb-4"><Spinner label="Loading saved topics…" /></Card>
          ) : savedTopics.length > 0 && (
            <Card className="mb-4">
              <SectionLabel>Saved topics ({savedTopics.length})</SectionLabel>
              <div className="space-y-2">
                {savedTopics.map((t) => (
                  <div key={t.id} className="flex items-center gap-3 p-3 rounded-[var(--r-md)] bg-[var(--surface-1)] border border-[var(--line)]">
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium text-[var(--text-1)]">{t.name}</div>
                      <div className="text-[11.5px] text-[var(--text-3)] mt-0.5">{t.keywords.join(" · ")}</div>
                      {t.last_scanned_at && (
                        <div className="flex items-center gap-1 text-[10.5px] text-[var(--text-4)] mt-1">
                          <Clock size={10} />
                          {formatLastScanned(t.last_scanned_at)}
                        </div>
                      )}
                    </div>
                    <button onClick={() => removeTopic(t.id)}
                      className="p-1.5 rounded text-[var(--text-3)] hover:text-[var(--contra)] hover:bg-[var(--surface-3)] t-all">
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </Card>
          )}

          <div className="mb-4 px-1 text-[12px] text-[var(--text-3)]">
            Daily digests are sent to the email set in{" "}
            <a href="/settings" className="text-[var(--gen)] hover:underline">Settings</a>.
            The scheduler runs automatically every day at 09:00 UTC.
          </div>

          <PrimaryButton onClick={runScan} disabled={loading || savedTopics.length === 0}>
            <Radar size={15} />
            {loading ? "Scanning…" : `Run scan now${savedTopics.length > 0 ? ` (${savedTopics.length} topic${savedTopics.length !== 1 ? "s" : ""})` : ""}`}
          </PrimaryButton>
        </div>
      )}

      {loading && !showConfig && (
        <Card className="mb-6">
          <Spinner label="Searching Semantic Scholar, OpenAlex, and arXiv — this takes 30–60 seconds…" />
        </Card>
      )}

      {error && (
        <div className="bg-[var(--contra-dim)] border border-[var(--contra-line)] rounded-[var(--r-lg)] p-4 mb-6 flex items-start gap-3">
          <AlertCircle size={16} className="text-[var(--contra)] mt-0.5 shrink-0" />
          <div>
            <div className="text-[13px] text-[var(--contra)] font-medium">Error</div>
            <div className="text-[12px] text-[var(--text-2)] mt-0.5">{error}</div>
          </div>
        </div>
      )}

      {results.length > 0 && (
        <div className="fade-up space-y-6">
          <Card>
            <div className="flex items-center gap-2">
              <CheckCircle2 size={16} className="text-[var(--support)]" />
              <span className="text-[13px] text-[var(--text-1)]">
                Found <span className="font-medium">{totalStrong}</span> strong match{totalStrong !== 1 ? "es" : ""} across {results.length} topic{results.length !== 1 ? "s" : ""}
              </span>

            </div>
          </Card>

          {sourcesFailed.length > 0 && (
            <div className="bg-[var(--nuance-dim)] border border-[var(--nuance-line)] rounded-[var(--r-lg)] p-3.5 flex items-start gap-2.5">
              <AlertCircle size={15} className="text-[var(--nuance)] mt-0.5 shrink-0" />
              <div className="text-[12.5px] text-[var(--text-2)] leading-relaxed">
                {sourcesFailed.join(" and ")} {sourcesFailed.length === 1 ? "was" : "were"} unavailable this scan — results shown are from the sources that responded.
              </div>
            </div>
          )}

          {results.map((digest, di) => {
            const strong = digest.papers.filter((p) =>
              p.relevance_tier === "highly_relevant" || p.relevance_tier === "related"
            );
            const tangential = digest.papers.filter((p) =>
              p.relevance_tier === "tangential" || !p.relevance_tier
            );

            return (
              <div key={di}>
                <div className="flex items-center gap-2 mb-3">
                  <h2 className="text-[14px] font-semibold text-[var(--text-1)]">{digest.topic}</h2>
                  <span className="text-[11.5px] text-[var(--text-3)]">
                    {digest.papers_relevant} relevant · {digest.papers_found} found
                  </span>
                </div>

                {digest.papers.length === 0 ? (
                  <Card><div className="text-[13px] text-[var(--text-3)] py-2">No papers found for this topic.</div></Card>
                ) : strong.length === 0 ? (
                  <>
                    <div className="text-[12px] text-[var(--text-3)] mb-2.5">
                      No close matches — showing broader field papers below.
                    </div>
                    <div className="space-y-2.5">{tangential.map(renderPaper)}</div>
                  </>
                ) : (
                  <div className="space-y-2.5">
                    {strong.map(renderPaper)}
                    {tangential.length > 0 && (
                      <div>
                        <button onClick={() => setShowTangential((s) => ({ ...s, [di]: !s[di] }))}
                          className="text-[12px] text-[var(--gen)] font-medium hover:underline my-1">
                          {showTangential[di] ? "Hide" : "Show"} {tangential.length} broader field match{tangential.length !== 1 ? "es" : ""}
                        </button>
                        {showTangential[di] && (
                          <div className="space-y-2.5 mt-2.5">{tangential.map(renderPaper)}</div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!showConfig && results.length === 0 && !loading && (
        <EmptyState icon={<Radar size={20} />} title="No results yet"
          hint={savedTopics.length === 0 ? "Add topics above to start monitoring." : "Run a scan to see new papers."} />
      )}
    </div>
  );
}
