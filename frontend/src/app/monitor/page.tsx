"use client";

import { useEffect, useState } from "react";
import { api, MonitorDigest } from "@/lib/api";
import { PageHeader, Card, EmptyState, Spinner, PrimaryButton, SectionLabel } from "@/components/ui";
import { Radar, Plus, X, Mail, ExternalLink, AlertCircle, CheckCircle2 } from "lucide-react";
import { cache } from "@/lib/cache";

interface Topic { name: string; keywords: string[]; sources: string[]; }

const TIER_META: Record<string, { label: string; color: string }> = {
  highly_relevant: { label: "Highly relevant", color: "var(--support)" },
  related: { label: "Related", color: "var(--nuance)" },
  tangential: { label: "Tangential", color: "var(--text-3)" },
};

export default function MonitorPage() {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [topicName, setTopicName] = useState("");
  const [topicKeywords, setTopicKeywords] = useState("");
  const [email, setEmail] = useState("");
  const [results, setResults] = useState<MonitorDigest[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showConfig, setShowConfig] = useState(true);

  useEffect(() => {
    const cachedTopics = cache.read<Topic[]>("monitor_topics");
    if (cachedTopics) setTopics(cachedTopics);
    const cachedEmail = cache.read<string>("monitor_email");
    if (cachedEmail) setEmail(cachedEmail);
    const cachedResults = cache.read<MonitorDigest[]>("monitor_results");
    if (cachedResults && cachedResults.length > 0) {
      setResults(cachedResults);
      setShowConfig(false);
    }
  }, []);

  const addTopic = () => {
    if (!topicName.trim() || !topicKeywords.trim()) return;
    const next = [...topics, {
      name: topicName.trim(),
      keywords: topicKeywords.split(",").map((k) => k.trim()).filter(Boolean),
      sources: ["arxiv", "semantic_scholar"],
    }];
    setTopics(next);
    cache.write("monitor_topics", next);
    setTopicName(""); setTopicKeywords("");
  };

  const removeTopic = (i: number) => {
    const next = topics.filter((_, idx) => idx !== i);
    setTopics(next);
    cache.write("monitor_topics", next);
  };

  const runScan = async () => {
    if (topics.length === 0) { setError("Add at least one topic to monitor."); return; }
    setLoading(true); setError(""); setResults([]);
    if (email) cache.write("monitor_email", email);
    try {
      const res = await api.monitorScan({
        topics: topics.map((t) => ({ name: t.name, keywords: t.keywords, sources: t.sources })),
        email: email || undefined,
        relevanceThreshold: 0.3,
        maxPerSource: 5,
      });
      setResults(res);
      cache.write("monitor_results", res);
      setShowConfig(false);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const totalFound = results.reduce((n, r) => n + r.papers_relevant, 0);

  return (
    <div>
      <PageHeader
        title="Research monitor"
        subtitle="Watch the literature for new papers relevant to your library."
        action={results.length > 0 && (
          <button onClick={() => setShowConfig((s) => !s)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-2)] text-[12.5px] text-[var(--text-2)] t-all hover:border-[var(--line-2)] hover:text-[var(--text-1)]">
            <Radar size={14} /> {showConfig ? "Hide" : "Configure"}
          </button>
        )}
      />

      {showConfig && (
        <div className="fade-up">
          <Card className="mb-4">
            <SectionLabel>Add a topic to watch</SectionLabel>
            <div className="grid grid-cols-[1fr_2fr_auto] gap-2 mb-1">
              <input value={topicName} onChange={(e) => setTopicName(e.target.value)}
                placeholder="Topic name (e.g. AI Negotiation)"
                className="bg-[var(--surface-1)] border border-[var(--line)] rounded-[var(--r-md)] px-3.5 py-2.5 text-[13.5px] text-[var(--text-1)]" />
              <input value={topicKeywords} onChange={(e) => setTopicKeywords(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addTopic()}
                placeholder="Search terms (comma-separated): LLM negotiation, AI coaching"
                className="bg-[var(--surface-1)] border border-[var(--line)] rounded-[var(--r-md)] px-3.5 py-2.5 text-[13.5px] text-[var(--text-1)]" />
              <button onClick={addTopic}
                className="flex items-center gap-1.5 px-3 py-2.5 rounded-[var(--r-md)] bg-[var(--gen-dim)] border border-[var(--gen-line)] text-[var(--gen)] text-[12.5px] font-medium t-all hover:opacity-90">
                <Plus size={14} /> Add
              </button>
            </div>
            <div className="text-[11px] text-[var(--text-3)] mt-1.5">
              Topics search arXiv and Semantic Scholar. Each is scored for relevance against your library.
            </div>
          </Card>

          {topics.length > 0 && (
            <Card className="mb-4">
              <SectionLabel>Topics ({topics.length})</SectionLabel>
              <div className="space-y-2">
                {topics.map((t, i) => (
                  <div key={i} className="flex items-center gap-3 p-3 rounded-[var(--r-md)] bg-[var(--surface-1)] border border-[var(--line)]">
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium text-[var(--text-1)]">{t.name}</div>
                      <div className="text-[11.5px] text-[var(--text-3)] mt-0.5">{t.keywords.join(" · ")}</div>
                    </div>
                    <button onClick={() => removeTopic(i)}
                      className="p-1.5 rounded text-[var(--text-3)] hover:text-[var(--contra)] hover:bg-[var(--surface-3)] t-all">
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </Card>
          )}

          <Card className="mb-4">
            <SectionLabel>Email digest (optional)</SectionLabel>
            <div className="flex items-center gap-2">
              <Mail size={15} className="text-[var(--text-3)] shrink-0" />
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com — leave blank to skip email"
                className="flex-1 bg-[var(--surface-1)] border border-[var(--line)] rounded-[var(--r-md)] px-3.5 py-2 text-[13.5px] text-[var(--text-1)]" />
            </div>
            <div className="text-[11px] text-[var(--text-3)] mt-2">
              If provided, you'll get an HTML digest of relevant papers after each scan.
            </div>
          </Card>

          <PrimaryButton onClick={runScan} disabled={loading || topics.length === 0}>
            <Radar size={15} /> {loading ? "Scanning…" : `Run scan${topics.length > 0 ? ` (${topics.length} topic${topics.length !== 1 ? "s" : ""})` : ""}`}
          </PrimaryButton>
        </div>
      )}

      {loading && !showConfig && (
        <Card className="mb-6">
          <Spinner label="Searching arXiv and Semantic Scholar — this takes 30–60 seconds…" />
        </Card>
      )}

      {error && (
        <div className="bg-[var(--contra-dim)] border border-[var(--contra-line)] rounded-[var(--r-lg)] p-4 mb-6 flex items-start gap-3">
          <AlertCircle size={16} className="text-[var(--contra)] mt-0.5 shrink-0" />
          <div>
            <div className="text-[13px] text-[var(--contra)] font-medium">Scan failed</div>
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
                Found <span className="font-medium">{totalFound}</span> relevant paper{totalFound !== 1 ? "s" : ""} across {results.length} topic{results.length !== 1 ? "s" : ""}
              </span>
              {email && <span className="text-[12px] text-[var(--text-3)] ml-auto">Digest sent to {email}</span>}
            </div>
          </Card>

          {results.map((digest, di) => (
            <div key={di}>
              <div className="flex items-baseline gap-3 mb-3">
                <h2 className="font-display text-[17px] text-[var(--text-1)]">{digest.topic}</h2>
                <span className="text-[11.5px] text-[var(--text-3)]">
                  {digest.papers_relevant} relevant of {digest.papers_found} found
                </span>
              </div>

              {digest.papers.length === 0 ? (
                <Card><div className="text-[13px] text-[var(--text-3)] py-2">No relevant papers found for this topic.</div></Card>
              ) : (
                <div className="space-y-2.5">
                  {digest.papers.map((p, pi) => {
                    const tier = p.relevance_tier ? TIER_META[p.relevance_tier] : null;
                    return (
                      <Card key={pi}>
                        <div className="flex items-start justify-between gap-3 mb-2">
                          <div className="text-[14px] font-medium text-[var(--text-1)] leading-snug flex-1">{p.title}</div>
                          {tier && (
                            <span className="text-[11px] font-medium shrink-0" style={{ color: tier.color }}>
                              {tier.label}
                            </span>
                          )}
                        </div>
                        <div className="text-[12px] text-[var(--text-3)] mb-2">
                          {(p.authors || []).slice(0, 3).join(", ")}{p.authors.length > 3 ? " et al." : ""} · {p.year || "?"} · {p.source}
                        </div>
                        {p.abstract && (
                          <div className="text-[12.5px] text-[var(--text-2)] leading-[1.55] mb-3 clamp-2">{p.abstract}</div>
                        )}
                        <div className="flex items-center gap-3 text-[11.5px]">
                          <span className="text-[var(--text-3)] italic">{p.relevance_reason}</span>
                          <a href={p.url} target="_blank" rel="noopener noreferrer"
                            className="ml-auto flex items-center gap-1 text-[var(--gen)] hover:underline">
                            View <ExternalLink size={11} />
                          </a>
                        </div>
                      </Card>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {!showConfig && results.length === 0 && !loading && (
        <EmptyState icon={<Radar size={20} />} title="No results yet" hint="Configure topics and run a scan." />
      )}
    </div>
  );
}
