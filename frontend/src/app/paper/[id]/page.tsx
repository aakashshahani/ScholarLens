"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api, Paper } from "@/lib/api";
import { Card, Spinner, EmptyState, AnalysisTag, SectionLabel } from "@/components/ui";
import { ArrowLeft, RefreshCw, Trash2, FileText, SendHorizontal } from "lucide-react";

export default function PaperDetailPage() {
  const params = useParams();
  const router = useRouter();
  const paperId = params.id as string;
  const [paper, setPaper] = useState<Paper | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState(0);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [asking, setAsking] = useState(false);

  useEffect(() => { api.getPaper(paperId).then((p) => { setPaper(p); setLoading(false); }).catch(() => setLoading(false)); }, [paperId]);

  const handleAsk = async () => {
    if (!question.trim()) return;
    setAsking(true); setAnswer("");
    try { const r = await api.ask(`Regarding "${paper?.title}": ${question}`, paperId); setAnswer(r.answer); }
    catch (e: any) { setAnswer(`Error: ${e.message}`); }
    setAsking(false);
  };
  const handleDelete = async () => { if (!confirm("Delete this paper and all its analyses?")) return; await api.deletePaper(paperId); router.push("/library"); };

  if (loading) return <Spinner label="Loading paper…" />;
  if (!paper) return <EmptyState icon={<FileText size={20} />} title="Paper not found" />;
  const analyses = paper.analyses || [];
  const active = analyses[activeTab];

  return (
    <div className="fade-up">
      <button onClick={() => router.push("/library")} className="flex items-center gap-1.5 text-[12.5px] text-[var(--gen)] font-medium mb-5 hover:gap-2 t-all"><ArrowLeft size={13} /> Library</button>
      <div className="flex gap-7">
        <div className="flex-1 min-w-0">
          <h1 className="font-display text-[24px] text-[var(--text-1)] leading-[1.2] mb-2">{paper.title}</h1>
          <p className="text-[13.5px] text-[var(--text-2)] mb-5">{paper.authors?.join(", ") || "—"} · {paper.year || "?"}</p>
          <div className="flex gap-6 pb-5 mb-5 border-b border-[var(--line)]">
            {[{ v: paper.page_count ?? "?", l: "pages" }, { v: `${analyses.length}/6`, l: "analyses" }, { v: paper.chunk_count ?? "?", l: "chunks" }].map(({ v, l }) => (
              <div key={l} className="flex items-baseline gap-1.5"><span className="font-display text-[19px] text-[var(--text-1)] tabular-nums">{v}</span><span className="text-[11px] text-[var(--text-3)] uppercase tracking-wide">{l}</span></div>
            ))}
          </div>
          <div className="flex gap-2 mb-6">
            <button onClick={() => api.reanalyze(paperId)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--r-md)] text-[12.5px] text-[var(--text-2)] border border-[var(--line)] bg-[var(--surface-2)] t-all hover:border-[var(--gen-line)] hover:text-[var(--gen)]"><RefreshCw size={13} /> Reanalyze</button>
            <button onClick={handleDelete} className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--r-md)] text-[12.5px] text-[var(--text-2)] border border-[var(--line)] bg-[var(--surface-2)] t-all hover:border-[var(--contra-line)] hover:text-[var(--contra)]"><Trash2 size={13} /> Delete</button>
          </div>
          {analyses.length > 0 ? (
            <>
              <div className="flex gap-0.5 border-b border-[var(--line)] mb-5 overflow-x-auto">
                {analyses.map((a, i) => (
                  <button key={a.id} onClick={() => setActiveTab(i)} className={`relative px-3.5 py-2.5 text-[12.5px] whitespace-nowrap t-all ${i === activeTab ? "text-[var(--text-1)] font-medium" : "text-[var(--text-3)] hover:text-[var(--text-2)]"}`}>
                    {a.type.replace("_", " ")}{i === activeTab && <span className="absolute bottom-[-1px] left-2 right-2 h-[2px] rounded-full bg-[var(--gen)]" />}
                  </button>
                ))}
              </div>
              <div className="text-[14px] text-[var(--text-1)] leading-[1.8] whitespace-pre-wrap mb-7">{active?.content}</div>
            </>
          ) : <Card className="mb-7"><p className="text-[var(--text-2)] text-[13px]">No analyses yet. Click Reanalyze to run the AI agent.</p></Card>}
          <SectionLabel>Ask about this paper</SectionLabel>
          <div className="flex gap-2 mb-3">
            <input value={question} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleAsk()} placeholder="e.g. What was the effect size for self-efficacy?"
              className="flex-1 bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-md)] px-3.5 py-2.5 text-[13.5px] text-[var(--text-1)]" />
            <button onClick={handleAsk} disabled={asking} className="flex items-center gap-1.5 px-4 py-2.5 rounded-[var(--r-md)] bg-[var(--gen)] text-white text-[13px] font-medium t-all hover:opacity-90 disabled:opacity-50">{asking ? "…" : <><SendHorizontal size={14} /> Ask</>}</button>
          </div>
          {answer && <Card className="fade-up"><div className="text-[13.5px] text-[var(--text-1)] leading-[1.7] whitespace-pre-wrap">{answer}</div></Card>}
        </div>
        <div className="w-[230px] shrink-0">
          <div className="bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-lg)] p-4 sticky top-6">
            <SectionLabel>Metadata</SectionLabel>
            {[{ k: "Source", v: paper.source?.replace("_", " ") || "?" }, { k: "Pages", v: String(paper.page_count ?? "?") }, { k: "Year", v: String(paper.year ?? "?") }].map(({ k, v }) => (
              <div key={k} className="flex justify-between py-1.5 border-b border-[var(--line)] text-[12px] last:border-0"><span className="text-[var(--text-3)]">{k}</span><span className="text-[var(--text-1)] font-medium capitalize">{v}</span></div>
            ))}
            <div className="mt-4"><SectionLabel>Analyses</SectionLabel><div className="flex flex-wrap gap-1">{analyses.map((a) => <AnalysisTag key={a.id} type={a.type} />)}</div></div>
            {paper.abstract && <div className="mt-4"><SectionLabel>Abstract</SectionLabel><p className="text-[12px] text-[var(--text-2)] leading-[1.6]">{paper.abstract.slice(0, 320)}{paper.abstract.length > 320 ? "…" : ""}</p></div>}
          </div>
        </div>
      </div>
    </div>
  );
}
