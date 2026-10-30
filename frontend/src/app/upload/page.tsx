"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { PageHeader } from "@/components/ui";
import {
  Upload as UploadIcon, FileText, CheckCircle2, AlertCircle,
  X, FolderOpen, ArrowRight, Loader2,
} from "lucide-react";

interface QueueItem {
  key: string;            // stable id: rows are updated by key, never by index
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
  const nextKey = useRef(0);

  // Stop every status poll when the page unmounts.
  useEffect(() => () => { Object.values(pollsRef.current).forEach(clearInterval); }, []);

  const patchItem = (key: string, fields: Partial<QueueItem>) =>
    setQueue((q) => q.map((item) => item.key === key ? { ...item, ...fields } : item));

  const addFiles = useCallback((files: FileList | File[]) => {
    const pdfs = Array.from(files).filter((f) => f.name.toLowerCase().endsWith(".pdf"));
    if (!pdfs.length) return;
    setQueue((q) => {
      const existing = new Set(q.map((i) => i.file.name + i.file.size));
      const fresh = pdfs.filter((f) => !existing.has(f.name + f.size));
      return [...q, ...fresh.map((f) => ({ key: `f${nextKey.current++}`, file: f, status: "pending" as const }))];
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

  const remove = (key: string) => {
    setQueue((q) => q.filter((item) => item.key !== key));
  };

  const stopPoll = (paperId: string) => {
    clearInterval(pollsRef.current[paperId]);
    delete pollsRef.current[paperId];
  };

  const pollStatus = (paperId: string, key: string) => {
    const startedAt = Date.now();
    pollsRef.current[paperId] = setInterval(async () => {
      if (Date.now() - startedAt > 180_000) {
        stopPoll(paperId);
        patchItem(key, { message: "still analyzing in the background — check the library" });
        return;
      }
      try {
        const st = await api.paperStatus(paperId);
        if (st.complete) stopPoll(paperId);
        patchItem(key, st.complete
          ? { status: "complete", analysisTypes: st.analysis_types }
          : { analysisTypes: st.analysis_types });
      } catch { /* network blip — keep polling */ }
    }, 3000);
  };

  // Batches the server accepts per request; the endpoint is rate limited per
  // request (not per file), so files go up together rather than one call each.
  const BATCH_SIZE = 20;

  const runUpload = async () => {
    const pendingItems = queue.filter((i) => i.status === "pending");
    if (!pendingItems.length) return;
    setRunning(true);
    pendingItems.forEach((item) => patchItem(item.key, { status: "uploading" }));

    for (let start = 0; start < pendingItems.length; start += BATCH_SIZE) {
      const batch = pendingItems.slice(start, start + BATCH_SIZE);
      try {
        const res = await api.uploadPapersBatch(batch.map((item) => item.file));
        // Results come back in upload order, one per file.
        batch.forEach((item, n) => {
          const r = res.results[n];
          if (!r || r.status === "error") {
            patchItem(item.key, { status: "error", message: r?.message || "Upload failed." });
          } else if (r.status === "duplicate") {
            patchItem(item.key, { status: "duplicate", paperId: r.id, title: r.title, message: r.message });
          } else {
            patchItem(item.key, { status: "analyzing", paperId: r.id, title: r.title });
            if (r.id) pollStatus(r.id, item.key);
          }
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Upload failed.";
        batch.forEach((item) => patchItem(item.key, { status: "error", message }));
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

          {queue.map((item) => (
            <div key={item.key}
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
                  <button onClick={() => remove(item.key)}
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
