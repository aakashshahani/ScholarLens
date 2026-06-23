"use client";

import { useEffect, useState, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { api, Paper } from "@/lib/api";
import { cache } from "@/lib/cache";
import { Card, Spinner, EmptyState, AnalysisTag, SectionLabel } from "@/components/ui";
import { ArrowLeft, RefreshCw, Trash2, FileText, CheckCircle2, SendHorizontal } from "lucide-react";

export default function PaperDetailPage() {
  const params = useParams();
  const router = useRouter();
  const paperId = params.id as string;
  const [paper, setPaper] = useState<Paper | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState(0);


  // Ask state
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
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
    setAsking(true); setAnswer("");
    try {
      const { job_id } = await api.ask(
        `Regarding "${paper?.title}": ${question}`, paperId
      );
      askPollRef.current = setInterval(async () => {
        try {
          const job = await api.getJob<{ answer: string }>(job_id);
          if (job.status === "done" && job.result) {
            clearInterval(askPollRef.current!);
            setAnswer(job.result.answer);
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
              <div className="text-[14px] text-[var(--text-1)] leading-[1.8] whitespace-pre-wrap mb-7">
                {active?.content}
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
                <div className="text-[13.5px] text-[var(--text-1)] leading-[1.7] whitespace-pre-wrap">
                  {answer}
                </div>
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
