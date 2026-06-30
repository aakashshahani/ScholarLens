"use client";

import { useEffect, useState, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { api, Paper } from "@/lib/api";
import { cache } from "@/lib/cache";
import { Card, Spinner, EmptyState, AnalysisTag, SectionLabel } from "@/components/ui";
import { ArrowLeft, RefreshCw, Trash2, FileText, CheckCircle2, SendHorizontal, Download, ExternalLink, Copy, Check } from "lucide-react";

const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
   .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const inlineMd = (s: string) => {
  const e = escHtml(s);
  return e
    .replace(/\*\*(.+?)\*\*/g, '<strong class="font-semibold text-[var(--text-1)]">$1</strong>')
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, '<code class="font-mono text-[11.5px] bg-[var(--surface-3)] px-1.5 py-0.5 rounded text-[var(--gen)]">$1</code>');
};

function AnalysisContent({ text }: { text: string }) {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let listItems: string[] = [];

  const flushList = (key: string) => {
    if (!listItems.length) return;
    elements.push(
      <ul key={key} className="mb-5 pl-0 list-none space-y-2.5">
        {listItems.map((item, i) => (
          <li key={i} className="flex items-start gap-3">
            <span className="mt-[8px] w-[6px] h-[6px] rounded-full bg-[var(--gen)] opacity-60 shrink-0" />
            <span className="flex-1 text-[14px] text-[var(--text-1)] leading-[1.85]"
              dangerouslySetInnerHTML={{ __html: inlineMd(item) }} />
          </li>
        ))}
      </ul>
    );
    listItems = [];
  };

  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (!line) { flushList(`l${idx}`); return; }

    if (line.startsWith("## ") || line.startsWith("# ")) {
      flushList(`l${idx}`);
      const title = line.replace(/^#{1,2} /, "");
      elements.push(
        <div key={idx} className="flex items-center gap-3 mt-7 mb-3">
          <div className="w-[3px] h-5 rounded-full bg-[var(--gen)] shrink-0" />
          <h2 className="text-[15px] font-semibold text-[var(--text-1)] tracking-[-0.01em]">{title}</h2>
        </div>
      );
      return;
    }

    if (line.startsWith("### ")) {
      flushList(`l${idx}`);
      elements.push(
        <div key={idx} className="flex items-center gap-2 mt-5 mb-2">
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[var(--gen)]">{line.slice(4)}</span>
          <div className="flex-1 h-px bg-[var(--line)]" />
        </div>
      );
      return;
    }

    if (line.startsWith("- ") || line.startsWith("* ") || line.startsWith("• ")) {
      listItems.push(line.slice(2));
      return;
    }

    const numbered = line.match(/^\d+[.)]\s+(.+)/);
    if (numbered) { listItems.push(numbered[1]); return; }

    // Bold-only short lines act as sub-headings
    if (/^\*\*.+\*\*$/.test(line) && line.length < 80) {
      flushList(`l${idx}`);
      elements.push(
        <p key={idx} className="text-[13px] font-semibold text-[var(--text-2)] mt-4 mb-1.5"
          dangerouslySetInnerHTML={{ __html: inlineMd(line) }} />
      );
      return;
    }

    flushList(`l${idx}`);
    elements.push(
      <p key={idx} className="text-[14px] text-[var(--text-1)] leading-[1.9] mb-3"
        dangerouslySetInnerHTML={{ __html: inlineMd(line) }} />
    );
  });

  flushList("end");
  return <div>{elements}</div>;
}

// Keep MarkdownContent alias for the Q&A answer (same component, different name for clarity)
const MarkdownContent = AnalysisContent;

function parseClaimsFromContent(content: string): string[] {
  const claims: string[] = [];
  let current = "";
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    const numbered = line.match(/^\d+[.)]\s+(.+)/);
    const bulleted = line.match(/^[-*•]\s+(.+)/);
    const stripped = (s: string) => s.replace(/\*\*/g, "").replace(/\*/g, "");
    if (numbered || bulleted) {
      if (current.trim()) claims.push(current.trim());
      current = stripped(numbered?.[1] ?? bulleted?.[1] ?? "");
    } else if (line) {
      current += (current ? " " : "") + stripped(line);
    }
  }
  if (current.trim()) claims.push(current.trim());
  return claims;
}

function KeyClaimsView({ content, paperId }: { content: string; paperId: string }) {
  const claims = parseClaimsFromContent(content);
  if (!claims.length) return <MarkdownContent text={content} />;
  return (
    <div className="space-y-2.5">
      {claims.map((claim, i) => (
        <div key={i} className="flex items-start gap-3 group py-2 border-b border-[var(--line)] last:border-0">
          <span className="shrink-0 w-[18px] text-[11px] font-semibold text-[var(--gen)] pt-[3px]">
            {i + 1}.
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-[13.5px] text-[var(--text-1)] leading-[1.75]">{claim}</p>
            <a href={`/search?q=${encodeURIComponent(claim.slice(0, 120))}`}
              className="inline-flex items-center gap-1 text-[11px] text-[var(--gen)] opacity-0 group-hover:opacity-100 t-all hover:underline mt-1">
              <ExternalLink size={10} /> Find in library
            </a>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function PaperDetailPage() {
  const params = useParams();
  const router = useRouter();
  const paperId = params.id as string;
  const [paper, setPaper] = useState<Paper | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState(0);
  const [copiedFmt, setCopiedFmt] = useState<string | null>(null);

  // Ask state
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [answerSources, setAnswerSources] = useState<{ paper_title: string; section: string | null; text: string }[]>([]);
  const [asking, setAsking] = useState(false);

  // Reanalyze state
  const [reanalyzing, setReanalyzing] = useState(false);
  const [reanalyzeDone, setReanalyzeDone] = useState(false);
  const [reanalyzeError, setReanalyzeError] = useState("");
  const [reanalyzeStage, setReanalyzeStage] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const askPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Cache-first: show cached paper instantly, refresh in background
    const cachedPaper = cache.read<Paper>(`paper_${paperId}`);
    if (cachedPaper) { setPaper(cachedPaper); setLoading(false); }
    api.getPaper(paperId)
      .then((p) => { setPaper(p); setLoading(false); cache.write(`paper_${paperId}`, p); })
      .catch(() => setLoading(false));
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (askPollRef.current) clearInterval(askPollRef.current);
    };
  }, [paperId]);

  const handleReanalyze = async () => {
    setReanalyzing(true);
    setReanalyzeDone(false);
    setReanalyzeError("");
    setReanalyzeStage("Queuing analysis…");

    try {
      await api.reanalyze(paperId);
    } catch (e: any) {
      setReanalyzeError(e.message);
      setReanalyzing(false);
      return;
    }

    // Poll paperStatus until all 6 analyses complete (or 2 min timeout)
    const stages = [
      "Running summary…",
      "Extracting methods…",
      "Analyzing findings…",
      "Reviewing limitations…",
      "Identifying key claims…",
      "Mapping research gaps…",
    ];
    let stageIdx = 0;
    const startTime = Date.now();
    const TIMEOUT_MS = 120_000;

    pollRef.current = setInterval(async () => {
      // Rotate stage label so user sees progress
      stageIdx = (stageIdx + 1) % stages.length;
      setReanalyzeStage(stages[stageIdx]);

      if (Date.now() - startTime > TIMEOUT_MS) {
        clearInterval(pollRef.current!);
        setReanalyzeError("Timed out — analysis may still be running in the background.");
        setReanalyzing(false);
        return;
      }

      try {
        const status = await api.paperStatus(paperId);
        if (status.complete) {
          clearInterval(pollRef.current!);
          // Reload full paper with fresh analyses
          const updated = await api.getPaper(paperId);
          setPaper(updated);
          cache.write(`paper_${paperId}`, updated);
          setActiveTab(0);
          setReanalyzing(false);
          setReanalyzeDone(true);
          // Reset done badge after 3s
          setTimeout(() => setReanalyzeDone(false), 3000);
        }
      } catch {
        // Network blip — keep polling
      }
    }, 3000);
  };


  const handleAsk = async () => {
    if (!question.trim()) return;
    setAsking(true); setAnswer(""); setAnswerSources([]);
    try {
      const { job_id } = await api.ask(
        `Regarding "${paper?.title}": ${question}`, paperId
      );
      askPollRef.current = setInterval(async () => {
        try {
          const job = await api.getJob<{ answer: string; sources?: typeof answerSources }>(job_id);
          if (job.status === "done" && job.result) {
            clearInterval(askPollRef.current!);
            setAnswer(job.result.answer);
            setAnswerSources(job.result.sources || []);
            setAsking(false);
          } else if (job.status === "error") {
            clearInterval(askPollRef.current!);
            setAnswer("Could not answer — try rephrasing.");
            setAsking(false);
          }
        } catch {
          clearInterval(askPollRef.current!);
          setAnswer("Connection error — try again.");
          setAsking(false);
        }
      }, 2000);
    } catch (e: any) {
      setAnswer(`Error: ${e.message}`);
      setAsking(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm("Delete this paper and all its analyses?")) return;
    await api.deletePaper(paperId);
    router.push("/library");
  };

  if (loading) return <Spinner label="Loading paper…" />;
  if (!paper) return <EmptyState icon={<FileText size={20} />} title="Paper not found" />;

  const analyses = paper.analyses || [];
  const active = analyses[activeTab];

  return (
    <div className="fade-up">
      <button
        onClick={() => router.push("/library")}
        className="flex items-center gap-1.5 text-[12.5px] text-[var(--gen)] font-medium mb-5 hover:gap-2 t-all"
      >
        <ArrowLeft size={13} /> Library
      </button>

      <div className="flex gap-7">
        {/* ── Main content ── */}
        <div className="flex-1 min-w-0">
          <h1 className="font-display text-[24px] text-[var(--text-1)] leading-[1.2] mb-2">{paper.title}</h1>
          <p className="text-[13.5px] text-[var(--text-2)] mb-5">
            {paper.authors?.join(", ") || "—"} · {paper.year || "?"}
          </p>

          {/* Stats row */}
          <div className="flex gap-6 pb-5 mb-5 border-b border-[var(--line)]">
            {[
              { v: paper.page_count ?? "?", l: "pages" },
              { v: `${analyses.length}/6`, l: "analyses" },
              { v: paper.chunk_count ?? "?", l: "chunks" },
            ].map(({ v, l }) => (
              <div key={l} className="flex items-baseline gap-1.5">
                <span className="font-display text-[19px] text-[var(--text-1)] tabular-nums">{v}</span>
                <span className="text-[11px] text-[var(--text-3)] uppercase tracking-wide">{l}</span>
              </div>
            ))}
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2 mb-6 flex-wrap">
            <button
              onClick={handleReanalyze}
              disabled={reanalyzing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--r-md)] text-[12.5px] border border-[var(--line)] bg-[var(--surface-2)] t-all hover:border-[var(--gen-line)] hover:text-[var(--gen)] disabled:opacity-50"
              style={{
                color: reanalyzeDone
                  ? "var(--support)"
                  : reanalyzeError
                  ? "var(--contra)"
                  : "var(--text-2)",
              }}
            >
              {reanalyzeDone
                ? <CheckCircle2 size={13} />
                : <RefreshCw size={13} className={reanalyzing ? "animate-spin" : ""} />}
              {reanalyzing
                ? reanalyzeStage
                : reanalyzeDone
                ? "Done"
                : reanalyzeError
                ? "Failed — retry?"
                : "Reanalyze"}
            </button>
            {reanalyzeError && (
              <span className="text-[11px] text-[var(--contra)]">{reanalyzeError}</span>
            )}
            {/* Citation export — BibTeX/RIS download; APA/Chicago/MLA copy */}
            {(["bibtex", "ris"] as const).map((fmt) => {
              const ext: Record<string, string> = { bibtex: "bib", ris: "ris" };
              return (
                <button key={fmt}
                  onClick={async () => {
                    const blob = await api.exportCitation(paperId, fmt);
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url; a.download = `citation.${ext[fmt]}`; a.click();
                    URL.revokeObjectURL(url);
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--r-md)] text-[12.5px] text-[var(--text-2)] border border-[var(--line)] bg-[var(--surface-2)] t-all hover:border-[var(--gen-line)] hover:text-[var(--gen)]">
                  <Download size={13} /> {fmt.toUpperCase()}
                </button>
              );
            })}
            {(["apa", "chicago", "mla"] as const).map((fmt) => {
              const copied = copiedFmt === fmt;
              return (
                <button key={fmt}
                  onClick={async () => {
                    const blob = await api.exportCitation(paperId, fmt);
                    const text = await blob.text();
                    await navigator.clipboard.writeText(text);
                    setCopiedFmt(fmt);
                    setTimeout(() => setCopiedFmt(null), 2000);
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--r-md)] text-[12.5px] border border-[var(--line)] bg-[var(--surface-2)] t-all hover:border-[var(--gen-line)] hover:text-[var(--gen)]"
                  style={{ color: copied ? "var(--support)" : "var(--text-2)" }}>
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                  {fmt.toUpperCase()}
                </button>
              );
            })}
            <button
              onClick={handleDelete}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--r-md)] text-[12.5px] text-[var(--text-2)] border border-[var(--line)] bg-[var(--surface-2)] t-all hover:border-[var(--contra-line)] hover:text-[var(--contra)]"
            >
              <Trash2 size={13} /> Delete
            </button>
          </div>

          {/* Analysis tabs */}
          {analyses.length > 0 ? (
            <>
              <div className="flex gap-0.5 border-b border-[var(--line)] mb-5 overflow-x-auto">
                {analyses.map((a, i) => (
                  <button
                    key={a.id}
                    onClick={() => setActiveTab(i)}
                    className={`relative px-3.5 py-2.5 text-[12.5px] whitespace-nowrap t-all ${
                      i === activeTab
                        ? "text-[var(--text-1)] font-medium"
                        : "text-[var(--text-3)] hover:text-[var(--text-2)]"
                    }`}
                  >
                    {a.type.replace(/_/g, " ")}
                    {i === activeTab && (
                      <span className="absolute bottom-[-1px] left-2 right-2 h-[2px] rounded-full bg-[var(--gen)]" />
                    )}
                  </button>
                ))}
              </div>
              <div className="mb-7">
                {active?.type === "key_claims" ? (
                  <KeyClaimsView content={active.content} paperId={paperId} />
                ) : (
                  <MarkdownContent text={active?.content || ""} />
                )}
              </div>
            </>
          ) : (
            <Card className="mb-7">
              <p className="text-[var(--text-2)] text-[13px]">
                No analyses yet. Click Reanalyze to run the AI agent.
              </p>
            </Card>
          )}


          {/* Ask about this paper */}
          <div className="mt-2">
            <div className="text-[11px] font-medium text-[var(--text-3)] uppercase tracking-wider mb-2">
              Ask about this paper
            </div>
            <div className="flex gap-2 mb-3">
              <input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAsk()}
                placeholder="e.g. What was the sample size? What were the main findings?"
                className="flex-1 bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-md)] px-3.5 py-2.5 text-[13.5px] text-[var(--text-1)] outline-none focus:border-[var(--gen-line)] t-all"
              />
              <button
                onClick={handleAsk}
                disabled={asking || !question.trim()}
                className="flex items-center gap-1.5 px-4 py-2.5 rounded-[var(--r-md)] bg-[var(--gen)] text-white text-[13px] font-medium t-all hover:opacity-90 disabled:opacity-50"
              >
                {asking ? "…" : <><SendHorizontal size={14} /> Ask</>}
              </button>
            </div>
            {answer && (
              <div className="bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-lg)] p-4">
                <MarkdownContent text={answer} />
                {answerSources.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-[var(--line)]">
                    <div className="text-[10px] text-[var(--text-4)] uppercase tracking-wider mb-1.5">
                      Grounded in {answerSources.length} passage{answerSources.length !== 1 ? "s" : ""}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {answerSources.map((s, i) => (
                        <span key={i} className="text-[10.5px] px-2 py-0.5 rounded-full bg-[var(--surface-3)] text-[var(--text-3)] capitalize"
                          title={s.text}>
                          {s.section || "general"}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── Right sidebar ── */}
        <div className="w-[230px] shrink-0">
          <div className="bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-lg)] p-4 sticky top-6">
            <SectionLabel>Metadata</SectionLabel>
            {[
              { k: "Source", v: paper.source?.replace(/_/g, " ") || "?" },
              { k: "Pages", v: String(paper.page_count ?? "?") },
              { k: "Year", v: String(paper.year ?? "?") },
            ].map(({ k, v }) => (
              <div key={k} className="flex justify-between py-1.5 border-b border-[var(--line)] text-[12px] last:border-0">
                <span className="text-[var(--text-3)]">{k}</span>
                <span className="text-[var(--text-1)] font-medium capitalize">{v}</span>
              </div>
            ))}
            {paper.doi && (
              <div className="py-1.5 border-b border-[var(--line)] text-[12px]">
                <span className="text-[var(--text-3)] block mb-0.5">DOI</span>
                <a href={`https://doi.org/${paper.doi}`} target="_blank" rel="noreferrer"
                  className="text-[var(--gen)] hover:underline break-all flex items-center gap-1">
                  {paper.doi} <ExternalLink size={10} className="shrink-0" />
                </a>
              </div>
            )}
            {paper.arxiv_id && (
              <div className="py-1.5 border-b border-[var(--line)] text-[12px]">
                <span className="text-[var(--text-3)] block mb-0.5">arXiv</span>
                <a href={`https://arxiv.org/abs/${paper.arxiv_id}`} target="_blank" rel="noreferrer"
                  className="text-[var(--gen)] hover:underline break-all flex items-center gap-1">
                  {paper.arxiv_id} <ExternalLink size={10} className="shrink-0" />
                </a>
              </div>
            )}
            <div className="mt-4">
              <SectionLabel>Analyses</SectionLabel>
              <div className="flex flex-wrap gap-1">
                {analyses.map((a) => <AnalysisTag key={a.id} type={a.type} />)}
              </div>
            </div>
            {paper.abstract && (
              <div className="mt-4">
                <SectionLabel>Abstract</SectionLabel>
                <p className="text-[12px] text-[var(--text-2)] leading-[1.6]">
                  {paper.abstract}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
