"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, ImportResult } from "@/lib/api";
import { Card, Spinner, SelectChip, PrimaryButton, PageHeader } from "@/components/ui";
import { Upload, Search, Plus, CheckCircle2, ExternalLink, FileText, ArrowRight } from "lucide-react";

export default function AddPapersPage() {
  const router = useRouter();
  const [tab, setTab] = useState<"upload" | "import">("upload");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string[]>([]);
  const [uploadDone, setUploadDone] = useState(false);
  const [uploadPaperId, setUploadPaperId] = useState("");
  const [dragging, setDragging] = useState(false);
  const [lookupId, setLookupId] = useState("");
  const [query, setQuery] = useState("");
  const [sources, setSources] = useState(["arxiv", "semantic_scholar"]);
  const [results, setResults] = useState<ImportResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [importing, setImporting] = useState<Record<number, string>>({});

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true); setUploadStatus(["Uploading PDF…"]);
    try {
      const res = await api.uploadPaper(file); setUploadPaperId(res.id);
      if (res.status === "duplicate") {
        setUploadStatus((s) => [...s, `Already in your library — "${res.title}"`]);
        setUploadDone(true); setUploading(false);
        return;
      }
      setUploadStatus((s) => [...s, `Ingested "${res.title}"`, "Running 6-part analysis…"]);
      const poll = setInterval(async () => { try { const st = await api.paperStatus(res.id); if (st.complete) { clearInterval(poll); setUploadDone(true); setUploading(false); setUploadStatus((s) => [...s, "All analyses complete"]); } } catch {} }, 3000);
      setTimeout(() => { clearInterval(poll); setUploading(false); }, 120000);
    } catch (e: any) { setUploadStatus((s) => [...s, `Error — ${e.message}`]); setUploading(false); }
  };
  const handleLookup = async () => { if (!lookupId.trim()) return; setSearchLoading(true); try { setResults([await api.importLookup(lookupId.trim())]); } catch (e: any) { alert(e.message); } setSearchLoading(false); };
  const handleSearch = async () => { if (!query.trim()) return; setSearchLoading(true); try { setResults(await api.importSearch(query, sources, 5)); } catch (e: any) { alert(e.message); } setSearchLoading(false); };
  const handleAdd = async (r: ImportResult, idx: number) => { setImporting((p) => ({ ...p, [idx]: "importing" })); try { const res = await api.importAdd(r); setImporting((p) => ({ ...p, [idx]: (res as any).status === "duplicate" ? "duplicate" : "done" })); } catch (e: any) { setImporting((p) => ({ ...p, [idx]: `error` })); } };

  return (
    <div>
      <PageHeader title="Add papers" subtitle="Upload a PDF or import from arXiv and Semantic Scholar." />
      <div className="inline-flex gap-1 mb-6 bg-[var(--surface-1)] border border-[var(--line)] p-1 rounded-[var(--r-md)]">
        {(["upload", "import"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`flex items-center gap-1.5 px-4 py-1.5 rounded-[var(--r-sm)] text-[13px] t-all ${tab === t ? "bg-[var(--surface-3)] text-[var(--text-1)] font-medium" : "text-[var(--text-3)] hover:text-[var(--text-1)]"}`}>
            {t === "upload" ? <><Upload size={14} /> Upload PDF</> : <><Search size={14} /> Import</>}
          </button>
        ))}
      </div>

      {tab === "upload" && (
        <div className="fade-up">
          <div onClick={() => { const i = document.createElement("input"); i.type = "file"; i.accept = ".pdf"; i.onchange = (e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) setFile(f); }; i.click(); }}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f?.name.endsWith(".pdf")) setFile(f); }}
            className={`border-2 border-dashed rounded-[var(--r-xl)] p-14 text-center cursor-pointer t-all ${file ? "border-[var(--support-line)] bg-[var(--support-dim)]" : dragging ? "border-[var(--gen-line)] bg-[var(--gen-dim)]" : "border-[var(--line-2)] hover:border-[var(--gen-line)] hover:bg-[var(--surface-2)]"}`}>
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-[var(--r-lg)] bg-[var(--surface-2)] border border-[var(--line)] text-[var(--text-3)] mb-3">{file ? <FileText size={20} className="text-[var(--support)]" /> : <Upload size={20} />}</div>
            {file ? <><div className="text-[14px] font-medium text-[var(--text-1)]">{file.name}</div><div className="text-[12px] text-[var(--text-3)] mt-1">{(file.size / 1024).toFixed(0)} KB · PDF</div></>
              : <><div className="text-[var(--text-2)] font-medium">Drop a PDF here or click to browse</div><div className="text-[12px] text-[var(--text-3)] mt-1">any field · any length</div></>}
          </div>
          {file && !uploading && !uploadDone && <div className="mt-4"><PrimaryButton onClick={handleUpload}><Upload size={15} /> Analyze paper</PrimaryButton></div>}
          {uploadStatus.length > 0 && <Card className="mt-4"><div className="space-y-2">{uploadStatus.map((line, i) => <div key={i} className="flex items-center gap-2 text-[12.5px] text-[var(--text-2)]"><CheckCircle2 size={13} className="text-[var(--support)] shrink-0" /> {line}</div>)}{uploading && <Spinner label="Analysis in progress…" />}</div></Card>}
          {uploadDone && <button onClick={() => router.push(`/paper/${uploadPaperId}`)} className="mt-3 w-full flex items-center justify-center gap-1.5 py-2.5 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-2)] text-[13px] text-[var(--gen)] font-medium t-all hover:border-[var(--gen-line)]">View paper <ArrowRight size={14} /></button>}
        </div>
      )}

      {tab === "import" && (
        <div className="fade-up">
          <Card className="mb-3">
            <div className="text-[11px] font-medium text-[var(--text-3)] uppercase tracking-wider mb-2">Quick lookup</div>
            <div className="flex gap-2">
              <input value={lookupId} onChange={(e) => setLookupId(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleLookup()} placeholder="arXiv ID (2301.12345), DOI, or URL"
                className="flex-1 bg-[var(--surface-1)] border border-[var(--line)] rounded-[var(--r-md)] px-3.5 py-2.5 text-[13.5px] text-[var(--text-1)]" />
              <button onClick={handleLookup} className="px-4 py-2.5 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-2)] text-[13px] text-[var(--text-2)] t-all hover:border-[var(--gen-line)] hover:text-[var(--gen)]">Lookup</button>
            </div>
          </Card>
          <Card className="mb-4">
            <div className="text-[11px] font-medium text-[var(--text-3)] uppercase tracking-wider mb-2">Search databases</div>
            <div className="flex gap-2 mb-3">
              <div className="relative flex-1"><Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-3)]" /><input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleSearch()} placeholder="e.g., LLM negotiation coaching feedback" className="w-full bg-[var(--surface-1)] border border-[var(--line)] rounded-[var(--r-md)] pl-10 pr-4 py-2.5 text-[13.5px] text-[var(--text-1)]" /></div>
              <PrimaryButton onClick={handleSearch} full={false}><Search size={14} /> Search</PrimaryButton>
            </div>
            <div className="flex gap-1.5">{["arxiv", "semantic_scholar"].map((s) => <SelectChip key={s} label={s.replace("_", " ")} active={sources.includes(s)} onClick={() => setSources((p) => p.includes(s) ? p.filter((x) => x !== s) : [...p, s])} />)}</div>
          </Card>
          {searchLoading && <Spinner label="Searching databases…" />}
          {results.length > 0 && (
            <div className="space-y-2.5 fade-up">
              <p className="text-[12px] text-[var(--text-3)]">{results.length} papers found</p>
              {results.map((r, i) => {
                const status = importing[i];
                return (
                  <Card key={i}><div className="flex justify-between items-start gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="text-[14px] font-medium text-[var(--text-1)] leading-snug mb-1">{r.title}</div>
                      <div className="text-[12px] text-[var(--text-3)] mb-2">{r.authors.slice(0, 3).join(", ")}{r.authors.length > 3 ? ` +${r.authors.length - 3}` : ""} · {r.year || "?"} · {r.source.replace("_", " ")}{r.citation_count ? ` · ${r.citation_count} cited` : ""}</div>
                      <div className="text-[12.5px] text-[var(--text-2)] leading-[1.6]">{r.abstract}</div>
                    </div>
                    <div className="shrink-0 flex flex-col items-end gap-2">
                      {status === "done" ? <span className="flex items-center gap-1 text-[12px] text-[var(--support)] font-medium"><CheckCircle2 size={13} /> Added</span> : status === "duplicate" ? <span className="flex items-center gap-1 text-[12px] text-[var(--text-3)] font-medium"><CheckCircle2 size={13} /> Already in library</span> : status === "importing" ? <Spinner /> : r.pdf_url ? <button onClick={() => handleAdd(r, i)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--r-md)] bg-[var(--gen)] text-white text-[12px] font-medium t-all hover:opacity-90"><Plus size={13} /> Add</button> : <span className="text-[11px] text-[var(--text-3)]">No PDF</span>}
                      <a href={r.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-[11px] text-[var(--gen)]">View <ExternalLink size={11} /></a>
                    </div>
                  </div></Card>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
