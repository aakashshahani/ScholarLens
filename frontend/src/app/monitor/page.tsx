"use client";

import { useEffect, useState } from "react";
import { api, MonitorDigest, MonitorScanResponse, MonitorTopic } from "@/lib/api";
import { PageHeader, Card, EmptyState, Spinner, PrimaryButton, SectionLabel } from "@/components/ui";
import { Radar, Plus, X, Mail, ExternalLink, AlertCircle, CheckCircle2, Clock } from "lucide-react";
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

  // Scan config
  const [email, setEmail] = useState("");
  const [results, setResults] = useState<MonitorDigest[]>([]);
  const [emailStatus, setEmailStatus] = useState<{ sent: boolean; error: string | null; requested: boolean }>
    ({ sent: false, error: null, requested: false });
  const [sourcesFailed, setSourcesFailed] = useState<string[]>([]);
  const [showTangential, setShowTangential] = useState<Record<number, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showConfig, setShowConfig] = useState(true);
  const [savingTopic, setSavingTopic] = useState(false);

  // Load saved topics from API on mount
  useEffect(() => {
    const cachedEmail = cache.read<string>("monitor_email");
    if (cachedEmail) setEmail(cachedEmail);

    const cachedResults = cache.read<MonitorDigest[]>("monitor_results");
    if (cachedResults && cachedResults.length > 0) {
      setResults(cachedResults);
      setShowConfig(false);
    }

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

  const runScan = async () => {
    if (savedTopics.length === 0) { setError("Add at least one topic to monitor."); return; }
    setLoading(true); setError(""); setResults([]);
    if (email) cache.write("monitor_email", email);
    try {
      const res: MonitorScanResponse = await api.monitorScan({
        topics: savedTopics.map((t) => ({ name: t.name, keywords: t.keywords, sources: t.sources })),
        email: email || undefined,
        relevanceThreshold: 0.5,
        maxPerSource: 5,
      });
      setResults(res.digests);
      setEmailStatus({ sent: res.email_sent, error: res.email_error, requested: res.email_requested });
      setSourcesFailed(res.sources_failed || []);
      cache.write("monitor_results", res.digests);
      setShowConfig(false);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const totalStrong = results.reduce(
    (n, r) => n + r.papers.filter((p) =>
      p.relevance_tier === "highly_relevant" || p.relevance_tier === "related"
    ).length,
    0
  );

  const renderPaper = (p: MonitorDigest["papers"][0], idx: number) => {
    const tier = TIER_META[p.relevance_tier || "tangential"] || TIER_META.tangential;
    return (
      <Card key={idx} className="!p-4">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="text-[13.5px] font-medium text-[var(--text-1)] leading-snug flex-1">{p.title}</div>
          <a href={p.url} target="_blank" rel="noopener noreferrer"
            className="shrink-0 p-1.5 text-[var(--text-3)] hover:text-[var(--gen)] t-all">
            <ExternalLink size={14} />
          </a>
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

          {/* Email digest */}
          <Card className="mb-4">
            <SectionLabel>Email digest (optional)</SectionLabel>
            <div className="flex items-center gap-2">
              <Mail size={15} className="text-[var(--text-3)] shrink-0" />
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com — daily digest will be sent here"
                className="flex-1 bg-[var(--surface-1)] border border-[var(--line)] rounded-[var(--r-md)] px-3.5 py-2 text-[13.5px] text-[var(--text-1)]" />
            </div>
            <div className="text-[11px] text-[var(--text-3)] mt-2">
              Set your digest email in Settings to receive automatic daily summaries.
              Delivery to arbitrary addresses requires a verified sending domain.
            </div>
          </Card>

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
              {emailStatus.requested && emailStatus.sent && (
                <span className="text-[12px] text-[var(--support)] ml-auto flex items-center gap-1.5">
                  <Mail size={12} /> Digest sent
                </span>
              )}
              {emailStatus.requested && !emailStatus.sent && (
                <span className="text-[12px] text-[var(--nuance)] ml-auto flex items-center gap-1.5"
                  title={emailStatus.error || ""}>
                  <Mail size={12} /> Email not delivered
                </span>
              )}
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
