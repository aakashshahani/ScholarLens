"use client";

import Link from "next/link";
import { FileQuestion } from "lucide-react";

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center max-w-sm">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-[var(--r-xl)] bg-[var(--surface-2)] border border-[var(--line)] mb-6">
          <FileQuestion size={24} className="text-[var(--text-3)]" />
        </div>
        <div className="font-display text-[28px] text-[var(--text-1)] mb-2 leading-tight">
          Page not found
        </div>
        <div className="text-[13.5px] text-[var(--text-3)] mb-8 leading-[1.6]">
          This page doesn't exist or was moved.
        </div>
        <Link
          href="/"
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-[var(--r-md)] bg-[var(--surface-2)] border border-[var(--line)] text-[13px] text-[var(--text-2)] t-all hover:border-[var(--line-2)] hover:text-[var(--text-1)]"
        >
          Back to ScholarLens
        </Link>
      </div>
    </div>
  );
}
