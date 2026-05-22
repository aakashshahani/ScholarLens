"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Upload,
  Library,
  Search,
  FileText,
  Zap,
  Lightbulb,
  Download,
  Radio,
} from "lucide-react";

const NAV = [
  { href: "/upload", label: "Upload", icon: Upload },
  { href: "/import-papers", label: "Import", icon: Download },
  { href: "/library", label: "Library", icon: Library },
  { href: "/search", label: "Search", icon: Search },
  { href: "/contradictions", label: "Contradictions", icon: Zap },
  { href: "/hypotheses", label: "Hypotheses", icon: Lightbulb },
  { href: "/monitor", label: "Monitor", icon: Radio },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="fixed inset-y-0 left-0 w-56 bg-[#0a0f1a] border-r border-[var(--border)] flex flex-col z-30">
      {/* Logo */}
      <Link href="/" className="block px-5 pt-6 pb-5">
        <div className="text-gradient font-mono font-bold text-lg tracking-tight">
          ◆ ScholarLens
        </div>
        <div className="font-mono text-[10px] text-slate-600 tracking-[2.5px] uppercase mt-0.5">
          Research Intelligence
        </div>
      </Link>

      {/* Nav */}
      <nav className="flex-1 px-3 space-y-0.5">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active =
            pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-150
                ${
                  active
                    ? "bg-[var(--card)] text-cyan-400 border border-[var(--border)]"
                    : "text-slate-500 hover:text-slate-300 hover:bg-[var(--card)]"
                }`}
            >
              <Icon size={15} strokeWidth={active ? 2 : 1.5} />
              {label}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="px-5 py-4 border-t border-[var(--border)]">
        <div className="font-mono text-[10px] text-slate-700 tracking-wider uppercase">
          v1.0.0 · FastAPI + Next.js
        </div>
      </div>
    </aside>
  );
}
