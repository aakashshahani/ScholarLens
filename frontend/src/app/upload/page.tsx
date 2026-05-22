"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { PageHeader, Card, Spinner, Badge, EmptyState } from "@/components/ui";
import { Upload as UploadIcon, FileText, CheckCircle2 } from "lucide-react";

export default function UploadPage() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<string[]>([]);
  const [paperId, setPaperId] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState("");

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f?.name.endsWith(".pdf")) setFile(f);
  }, []);

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    setStatus(["Uploading PDF..."]);
    setError("");

    try {
      const res = await api.uploadPaper(file);
      setPaperId(res.id);
      setStatus((s) => [...s, `✓ "${res.title}" ingested`, "Running AI analysis (this takes ~30s)..."]);

      // Poll for completion
      const poll = setInterval(async () => {
        try {
          const st = await api.paperStatus(res.id);
          setStatus((prev) => {
            const base = prev.filter((l) => !l.startsWith("  ◇ "));
            return [...base, ...st.analysis_types.map((t: string) => `  ◇ ${t.replace("_", " ")}`)];
          });
          if (st.complete) {
            clearInterval(poll);
            setComplete(true);
            setUploading(false);
          }
        } catch {
          /* keep polling */
        }
      }, 3000);

      // Safety timeout
      setTimeout(() => {
        clearInterval(poll);
        setUploading(false);
      }, 120000);
    } catch (e: any) {
      setError(e.message);
      setUploading(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Upload & Analyze"
        subtitle="Drop a research paper and ScholarLens will automatically analyze it."
      />

      {/* Drop zone */}
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
        className={`border-2 border-dashed rounded-xl p-12 text-center transition-all cursor-pointer
          ${file ? "border-cyan-500/40 bg-cyan-500/5" : "border-[var(--border)] hover:border-blue-500/30"}`}
        onClick={() => {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = ".pdf";
          input.onchange = (e) => {
            const f = (e.target as HTMLInputElement).files?.[0];
            if (f) setFile(f);
          };
          input.click();
        }}
      >
        {file ? (
          <div className="flex flex-col items-center gap-2">
            <FileText size={32} className="text-cyan-400" />
            <div className="font-semibold text-slate-200">{file.name}</div>
            <div className="font-mono text-xs text-slate-500">
              {(file.size / 1024).toFixed(0)} KB · PDF
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <UploadIcon size={32} className="text-slate-600" />
            <div className="text-slate-500">Drop a PDF here or click to browse</div>
            <div className="font-mono text-xs text-slate-600">
              any field · any length
            </div>
          </div>
        )}
      </div>

      {/* Upload button */}
      {file && !uploading && !complete && (
        <button
          onClick={handleUpload}
          className="mt-4 w-full py-3 rounded-lg bg-gradient-to-r from-blue-500 to-cyan-500 text-white font-semibold text-sm hover:shadow-lg hover:shadow-blue-500/20 transition-all"
        >
          ▶ ANALYZE PAPER
        </button>
      )}

      {/* Error */}
      {error && (
        <Card hover={false} className="mt-4 border-rose-500/30">
          <p className="text-rose-400 text-sm">{error}</p>
        </Card>
      )}

      {/* Status log */}
      {status.length > 0 && (
        <Card hover={false} className="mt-4">
          <div className="space-y-1.5">
            {status.map((line, i) => (
              <div key={i} className="font-mono text-xs text-slate-400">
                {line}
              </div>
            ))}
            {uploading && <Spinner label="Analysis in progress..." />}
          </div>
        </Card>
      )}

      {/* Complete */}
      {complete && paperId && (
        <Card hover={false} className="mt-4 border-emerald-500/30">
          <div className="flex items-center gap-2 mb-3">
            <CheckCircle2 size={16} className="text-emerald-400" />
            <span className="text-emerald-400 font-semibold text-sm">
              Analysis complete
            </span>
          </div>
          <button
            onClick={() => router.push(`/paper/${paperId}`)}
            className="w-full py-2.5 rounded-lg bg-[var(--card-hover)] border border-[var(--border)] text-sm font-medium text-slate-300 hover:text-white hover:border-cyan-500/30 transition-all"
          >
            View Paper →
          </button>
        </Card>
      )}
    </div>
  );
}
