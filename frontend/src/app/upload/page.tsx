"use client";

import { useState, useCallback, useRef } from "react";
import Link from "next/link";
import { api, BatchUploadResult } from "@/lib/api";
import { PageHeader, Card, Spinner } from "@/components/ui";
import {
  Upload as UploadIcon, FileText, CheckCircle2, AlertCircle,
  X, FolderOpen, ArrowRight, Loader2,
} from "lucide-react";

interface QueueItem {
  file: File;
  status: "pending" | "uploading" | "analyzing" | "complete" | "duplicate" | "error";
  paperId?: string;
  title?: string;
  message?: string;
  analysisTypes?: string[];
}

const STATUS_COLOR: Record<QueueItem["status"], string> = {
  pending:   "text-[var(--text-3)]",
  uploading: "text-[var(--nuance)]",
  analyzing: "text-[var(--gen)]",
  complete:  "text-[var(--support)]",
  duplicate: "text-[var(--text-3)]",
  error:     "text-[var(--contra)]",
};

const STATUS_LABEL: Record<QueueItem["status"], string> = {
  pending:   "Queued",
  uploading: "Uploading…",
  analyzing: "Analyzing…",
  complete:  "Complete",
  duplicate: "Already in library",
  error:     "Error",
};

export default function UploadPage() {
  const [queue, setQueue]     = useState<QueueItem[]>([]);
  const [running, setRunning] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const pollsRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  const addFiles = useCallback((files: FileList | File[]) => {
    const pdfs = Array.from(files).filter((f) => f.name.toLowerCase().endsWith(".pdf"));
    if (!pdfs.length) return;
    setQueue((q) => {
      const existing = new Set(q.map((i) => i.file.name + i.file.size));
      const fresh = pdfs.filter((f) => !existing.has(f.name + f.size));
      return [...q, ...fresh.map((f) => ({ file: f, status: "pending" as const }))];
    });
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    addFiles(e.dataTransfer.files);
  }, [addFiles]);

  const handleBrowse = () => {
    const input = document.createElement("input");
    input.type = "file"; input.accept = ".pdf"; input.multiple = true;
    input.onchange = (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (files) addFiles(files);
    };
    input.click();
  };

  const remove = (idx: number) => {
    setQueue((q) => q.filter((_, i) => i !== idx));
  };

  const pollStatus = (paperId: string, idx: number) => {
    const interval = setInterval(async () => {
      try {
        const st = await api.paperStatus(paperId);
        setQueue((q) => q.map((item, i) => {
          if (i !== idx) return item;
          if (st.complete) {
            clearInterval(pollsRef.current[paperId]);
            delete pollsRef.current[paperId];
            return { ...item, status: "complete", analysisTypes: st.analysis_types };
          }
          return { ...item, analysisTypes: st.analysis_types };
        }));
      } catch { /* keep polling */ }
    }, 3000);
    pollsRef.current[paperId] = interval;
    setTimeout(() => {
      clearInterval(pollsRef.current[paperId]);
      delete pollsRef.current[paperId];
    }, 120000);
  };

  const runUpload = async () => {
    const pending = queue.filter((i) => i.status === "pending");
    if (!pending.length) return;
    setRunning(true);

    // Process sequentially to show per-file progress; batch API used for the actual upload
    for (let i = 0; i < queue.length; i++) {
      if (queue[i].status !== "pending") continue;
      setQueue((q) => q.map((item, j) => j === i ? { ...item, status: "uploading" } : item));
      try {
        const res = await api.uploadPapersBatch([queue[i].file]);
        const r = res.results[0];
        if (!r) continue;
        if (r.status === "error") {
          setQueue((q) => q.map((item, j) =>
            j === i ? { ...item, status: "error", message: r.message } : item));
        } else if (r.status === "duplicate") {
          setQueue((q) => q.map((item, j) =>
            j === i ? { ...item, status: "duplicate", paperId: r.id, title: r.title, message: r.message } : item));
        } else {
          setQueue((q) => q.map((item, j) =>
            j === i ? { ...item, status: "analyzing", paperId: r.id, title: r.title } : item));
          if (r.id) pollStatus(r.id, i);
        }
      } catch (e: any) {
        setQueue((q) => q.map((item, j) =>
          j === i ? { ...item, status: "error", message: e.message } : item));
      }
    }

    setRunning(false);
  };

  const pending = queue.filter((i) => i.status === "pending").length;
  const done    = queue.filter((i) => i.status === "complete").length;
  const errors  = queue.filter((i) => i.status === "error").length;

  return (
    <div>
      <PageHeader
        title="Upload papers"
        subtitle="Drop one or more PDFs — ScholarLens will extract claims, run analysis, and map them into your library."
      />

      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={handleBrowse}
        className={`border-2 border-dashed rounded-[var(--r-xl)] p-12 text-center cursor-pointer t-all ${
          dragOver
            ? "border-[var(--gen)] bg-[var(--gen-dim)]"
            : queue.length
            ? "border-[var(--gen-line)] bg-[var(--gen-dim)]"
            : "border-[var(--line-2)] hover:border-[var(--gen-line)] hover:bg-[var(--surface-2)]"
        }`}
      >
        <div className="flex flex-col items-center gap-2.5 pointer-events-none">
          <FolderOpen size={30} className={dragOver ? "text-[var(--gen)]" : "text-[var(--text-4)]"} />
          <div className="text-[14px] text-[var(--text-2)] font-medium">
            {queue.length ? "Drop more PDFs or click to add" : "Drop PDFs here or click to browse"}
          </div>
          <div className="text-[12px] text-[var(--text-4)]">
            Multiple files · any field · up to 20 PDFs per batch · 25 MB each
          </div>
        </div>
      </div>

      {/* Queue */}
      {queue.length > 0 && (
        <div className="mt-5 space-y-2">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-[14px] text-[var(--text-1)]">
              Upload queue
              <span className="ml-2 text-[11px] text-[var(--text-3)] font-normal mono">
                {queue.length} file{queue.length !== 1 ? "s" : ""}
                {done > 0 ? ` · ${done} complete` : ""}
                {errors > 0 ? ` · ${errors} failed` : ""}
              </span>
            </h2>
            {pending > 0 && !running && (
              <button
                onClick={runUpload}
                className="flex items-center gap-1.5 px-4 py-2 rounded-[var(--r-md)] bg-[var(--gen)] text-white text-[12.5px] font-medium hover:opacity-90 t-all"
              >
                <UploadIcon size={13} /> Analyze {pending} paper{pending !== 1 ? "s" : ""}
              </button>
            )}
            {running && (
              <div className="flex items-center gap-2 text-[12px] text-[var(--gen)]">
                <Loader2 size={13} className="animate-spin" /> Uploading…
              </div>
            )}
          </div>

          {queue.map((item, i) => (
            <div key={i}
              className="flex items-center gap-3 bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-md)] px-4 py-3">
              <FileText size={15} className="text-[var(--text-4)] shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] text-[var(--text-1)] truncate">
                  {item.title || item.file.name}
                </div>
                <div className="text-[11px] text-[var(--text-4)] mt-0.5">
                  {(item.file.size / 1024).toFixed(0)} KB
                  {item.message && ` · ${item.message}`}
                  {item.analysisTypes?.length
                    ? ` · ${item.analysisTypes.length}/6 analyses`
                    : ""}
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <span className={`text-[11.5px] font-medium ${STATUS_COLOR[item.status]}`}>
                  {item.status === "analyzing" && <Loader2 size={11} className="inline animate-spin mr-1" />}
                  {item.status === "complete" && <CheckCircle2 size={11} className="inline mr-1" />}
                  {STATUS_LABEL[item.status]}
                </span>

                {item.status === "complete" && item.paperId && (
                  <Link href={`/paper/${item.paperId}`}
                    className="text-[11.5px] text-[var(--gen)] hover:underline flex items-center gap-0.5">
                    View <ArrowRight size={10} />
                  </Link>
                )}
                {item.status === "duplicate" && item.paperId && (
                  <Link href={`/paper/${item.paperId}`}
                    className="text-[11.5px] text-[var(--text-3)] hover:underline flex items-center gap-0.5">
                    Open <ArrowRight size={10} />
                  </Link>
                )}

                {(item.status === "pending" || item.status === "error") && (
                  <button onClick={() => remove(i)}
                    className="text-[var(--text-4)] hover:text-[var(--contra)] t-all">
                    <X size={14} />
                  </button>
                )}
              </div>
            </div>
          ))}

          {/* Error summary */}
          {errors > 0 && (
            <div className="flex items-start gap-2 bg-[var(--contra-dim)] border border-[var(--contra-line)] rounded-[var(--r-md)] px-4 py-3 mt-2">
              <AlertCircle size={14} className="text-[var(--contra)] mt-0.5 shrink-0" />
              <span className="text-[12.5px] text-[var(--contra)]">
                {errors} file{errors !== 1 ? "s" : ""} failed.
                Check that they are valid PDFs under 25 MB.
              </span>
            </div>
          )}

          {/* All done */}
          {done > 0 && done === queue.filter(i => i.status !== "pending").length && (
            <div className="flex items-center gap-2 text-[12.5px] text-[var(--support)] mt-1">
              <CheckCircle2 size={13} />
              All uploads processed. Head to{" "}
              <Link href="/library" className="underline">your library</Link> to see them.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
