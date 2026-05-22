"use client";

import { useState } from "react";
import { api, MonitorDigest } from "@/lib/api";
import { PageHeader, Card, EmptyState, Spinner, Slider, SelectChip, PrimaryButton } from "@/components/ui";
import { Radar, Plus, X, ExternalLink } from "lucide-react";

interface Topic { name: string; keywords: string[]; sources: string[]; }

export default function MonitorPage() {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [topicName, setTopicName] = useState("");
  const [topicKeywords, setTopicKeywords] = useState("");
  const [topicSources, setTopicSources] = useState(["arxiv", "semantic_scholar"]);
  const [threshold, setThreshold] = useState(0.3);
  const [maxPerSource, setMaxPerSource] = useState(5);
  const [email, setEmail] = useState("");
  const [results, setResults] = useState<MonitorDigest[]>([]);
  const [loading, setLoading] = useState(false);

  const addTopic = () => {
    if (!topicName.trim() || !topicKeywords.trim()) return;
    setTopics((t) => [...t, { name: topicName, keywords: topicKeywords.split(",").map((k) => k.trim()).filter(Boolean), sources: [...topicSources] }]);
    setTopicName(""); setTopicKeywords("");
  };

  const runScan = async () => {
    if (topics.length === 0) return;
    setLoading(true); setResults([]);
    try {
      const res = await api.monitorScan({ topics, email: email || undefined, relevanceThreshold: threshold, maxPerSource });
      setResults(res);
    } catch (e: any) { alert(e.message); }
    setLoading(false);
  };

  return (
    <div>
      <PageHeader title="Research monitor" subtitle="Configure topics to watch. ScholarLens finds new papers and scores their relevance to your library." />

      <Card className="mb-4">
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div>
            <div className="text-[11px] font-medium text-[var(--text-muted)] uppercase tracking-wider mb-2">Topic name</div>
            <input type="text" value={topicName} onChange={(e) => setTopicName(e.target.value)} placeholder="e.g., AI Negotiation Training"
              className="w-full bg-[var(--surface-alt)] border border-[var(--border)] rounded-[var(--r-md)] px-3.5 py-2.5 text-[13.5px]" />
          </div>
          <div>
            <div className="text-[11px] font-medium text-[var(--text-muted)] uppercase tracking-wider mb-2">Keywords · comma-separated</div>
            <input type="text" value={topicKeywords} onChange={(e) => setTopicKeywords(e.target.value)} placeholder="LLM negotiation, AI coaching"
              className="w-full bg-[var(--surface-alt)] border border-[var(--border)] rounded-[var(--r-md)] px-3.5 py-2.5 text-[13.5px]" />
          </div>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex gap-1.5">
            {["arxiv", "semantic_scholar"].map((s) => (
              <SelectChip key={s} label={s.replace("_", " ")} active={topicSources.includes(s)}
                onClick={() => setTopicSources((p) => p.includes(s) ? p.filter((x) => x !== s) : [...p, s])} />
            ))}
          </div>
          <PrimaryButton onClick={addTopic} full={false}><Plus size={15} /> Add topic</PrimaryButton>
        </div>
      </Card>

      {topics.length > 0 && (
        <div className="space-y-2 mb-4">
          {topics.map((t, i) => (
            <div key={i} className="flex items-center justify-between bg-[var(--surface)] border border-[var(--border)] rounded-[var(--r-md)] shadow-[var(--shadow-xs)] px-4 py-3">
              <div>
                <div className="text-[13.5px] text-[var(--text-primary)] font-medium">{t.name}</div>
                <div className="text-[12px] text-[var(--text-muted)] mt-0.5">{t.keywords.join(", ")} · {t.sources.map((s) => s.replace("_", " ")).join(" + ")}</div>
              </div>
              <button onClick={() => setTopics((tt) => tt.filter((_, j) => j !== i))} className="text-[var(--text-muted)] hover:text-[var(--red-text)] t-all p-1">
                <X size={16} />
              </button>
            </div>
          ))}
        </div>
      )}

      <Card className="mb-4">
        <div className="grid grid-cols-2 gap-6 mb-5">
          <Slider label="Relevance threshold" value={threshold} min={0.1} max={0.8} step={0.05} onChange={setThreshold} format={(v) => v.toFixed(2)} />
          <Slider label="Results per keyword" value={maxPerSource} min={3} max={10} step={1} onChange={(v) => setMaxPerSource(Math.round(v))} />
        </div>
        <div>
          <div className="text-[11px] font-medium text-[var(--text-muted)] uppercase tracking-wider mb-2">Email for digest · optional</div>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="your@email.com"
            className="w-full bg-[var(--surface-alt)] border border-[var(--border)] rounded-[var(--r-md)] px-3.5 py-2.5 text-[13.5px]" />
        </div>
      </Card>

      {topics.length > 0 && <div className="mb-6"><PrimaryButton onClick={runScan} disabled={loading}><Radar size={15} /> {loading ? "Scanning…" : "Run scan"}</PrimaryButton></div>}

      {loading && <Card className="mb-6"><Spinner label="Scanning arXiv and Semantic Scholar for new papers…" /></Card>}

      {results.length > 0 && (
        <div className="space-y-6 fade-up">
          {results.map((r, ri) => (
            <div key={ri}>
              <div className="flex items-center gap-3 mb-3">
                <h3 className="font-serif text-[17px] font-medium text-[var(--text-primary)]">{r.topic}</h3>
                <span className="text-[12px] text-[var(--text-muted)]">{r.papers_found} found · {r.papers_relevant} relevant</span>
              </div>
              {r.papers.length === 0 ? (
                <div className="text-[12.5px] text-[var(--text-muted)] italic">No relevant papers found.</div>
              ) : (
                <div className="space-y-2.5">
                  {r.papers.map((p, pi) => {
                    const pct = Math.round(p.relevance_score * 100);
                    const c = pct >= 60 ? "var(--teal)" : pct >= 40 ? "var(--amber)" : "var(--text-dim)";
                    return (
                      <div key={pi} className="bg-[var(--surface)] border border-[var(--border)] rounded-[var(--r-lg)] shadow-[var(--shadow-sm)] flex overflow-hidden t-all lift">
                        <div className="w-[3px] shrink-0" style={{ background: c }} />
                        <div className="p-4 pl-[18px] flex-1">
                          <div className="flex justify-between items-center mb-1.5">
                            <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">{p.source.replace("_", " ")}{p.year ? ` · ${p.year}` : ""}</span>
                            <span className="text-[11px] font-medium tabular-nums" style={{ color: c }}>{pct}% relevant</span>
                          </div>
                          <div className="text-[14px] font-medium text-[var(--text-primary)] mb-1 leading-snug">{p.title}</div>
                          <div className="text-[12px] text-[var(--text-muted)] mb-1.5">{p.authors.slice(0, 3).join(", ")}{p.authors.length > 3 ? ` +${p.authors.length - 3}` : ""}</div>
                          <div className="text-[12px] text-[var(--text-muted)] italic mb-2">{p.relevance_reason}</div>
                          <div className="text-[12.5px] text-[var(--text-secondary)] leading-[1.6]">{p.abstract}</div>
                          <a href={p.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[12px] text-[var(--accent)] font-medium mt-2.5 hover:gap-1.5 t-all">
                            View paper <ExternalLink size={12} />
                          </a>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {!loading && results.length === 0 && topics.length === 0 && (
        <EmptyState icon={<Radar size={20} />} title="Add topics to start monitoring" hint="Configure keywords and sources above" />
      )}
    </div>
  );
}
