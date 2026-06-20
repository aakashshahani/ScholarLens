"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { PageHeader, Card, Spinner } from "@/components/ui";
import { Upload as UploadIcon, FileText, CheckCircle2, AlertCircle } from "lucide-react";

export default function UploadPage() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<string[]>([]);
  const [paperId, setPaperId] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f?.name.endsWith(".pdf")) setFile(f);
  }, []);

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true); setStatus(["Uploading PDF…"]); setError("");
    try {
      const res = await api.uploadPaper(file);
      setPaperId(res.id);
      setStatus((s) => [...s, `✓ "${res.title}" ingested`, "Running AI analysis…"]);
      const poll = setInterval(async () => {
        try {
          const st = await api.paperStatus(res.id);
          setStatus((prev) => {
            const base = prev.filter((l) => !l.startsWith("  ◇ "));
            return [...base, ...st.analysis_types.map((t: string) => `  ◇ ${t.replace("_", " ")}`)];
          });
          if (st.complete) { clearInterval(poll); setComplete(true); setUploading(false); }
        } catch { /* keep polling */ }
      }, 3000);
      setTimeout(() => { clearInterval(poll); setUploading(false); }, 120000);
    } catch (e: any) { setError(e.message); setUploading(false); }
  };

  return (
    <div>
      <PageHeader
        title="Upload paper"
        subtitle="Drop a PDF and ScholarLens will extract claims, analyze methods, and map it into your library."
      />

      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => {
          const input = document.createElement("input");
          input.type = "file"; input.accept = ".pdf";
          input.onchange = (e) => {
            const f = (e.target as HTMLInputElement).files?.[0];
            if (f) setFile(f);
          };
          input.click();
        }}
        className={`border-2 border-dashed rounded-[var(--r-xl)] p-14 text-center cursor-pointer t-all ${
          dragOver
            ? "border-[var(--gen)] bg-[var(--gen-dim)]"
            : file
            ? "border-[var(--gen-line)] bg-[var(--gen-dim)]"
            : "border-[var(--line-2)] hover:border-[var(--gen-line)] hover:bg-[var(--surface-2)]"
        }`}
      >
        {file ? (
          <div className="flex flex-col items-center gap-2.5">
            <FileText size={28} className="text-[var(--gen)]" />
            <div className="text-[14px] font-medium text-[var(--text-1)]">{file.name}</div>
            <div className="mono text-[11.5px] text-[var(--text-3)]">
              {(file.size / 1024).toFixed(0)} KB · PDF
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2.5">
            <UploadIcon size={28} className="text-[var(--text-4)]" />
            <div className="text-[14px] text-[var(--text-2)]">Drop a PDF here or click to browse</div>
            <div className="text-[12px] text-[var(--text-4)]">Any field · any length · up to 25MB</div>
          </div>
        )}
      </div>

      {/* Upload button */}
      {file && !uploading && !complete && (
        <button
          onClick={handleUpload}
          className="mt-4 w-full py-3 rounded-[var(--r-md)] bg-[var(--gen)] text-white text-[13.5px] font-medium t-all hover:opacity-90"
        >
          Analyze paper
        </button>
      )}

      {/* Error */}
      {error && (
        <div className="mt-4 flex items-start gap-3 bg-[var(--contra-dim)] border border-[var(--contra-line)] rounded-[var(--r-lg)] p-4">
          <AlertCircle size={15} className="text-[var(--contra)] mt-0.5 shrink-0" />
          <div className="text-[13px] text-[var(--contra)]">{error}</div>
        </div>
      )}

      {/* Status log */}
      {status.length > 0 && (
        <Card className="mt-4">
          <div className="space-y-1.5 mb-3">
            {status.map((line, i) => (
              <div key={i} className="mono text-[12.5px] text-[var(--text-2)]">{line}</div>
            ))}
          </div>
          {uploading && <Spinner label="Analysis in progress…" />}
        </Card>
      )}

      {/* Complete */}
      {complete && paperId && (
        <Card className="mt-4">
          <div className="flex items-center gap-2 mb-4">
            <CheckCircle2 size={15} className="text-[var(--support)]" />
            <span className="text-[13.5px] text-[var(--support)] font-medium">Analysis complete</span>
          </div>
          <button
            onClick={() => router.push(`/paper/${paperId}`)}
            className="w-full py-2.5 rounded-[var(--r-md)] border border-[var(--line-2)] text-[13px] text-[var(--text-2)] t-all hover:text-[var(--text-1)] hover:border-[var(--gen-line)]"
          >
            View paper →
          </button>
        </Card>
      )}
    </div>
  );
}
