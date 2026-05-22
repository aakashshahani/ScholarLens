"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Library as LibraryIcon,
  Zap,
  FlaskConical,
  Radar,
  Plus,
} from "lucide-react";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/library", label: "Library", icon: LibraryIcon },
  { href: "/contradictions", label: "Contradictions", icon: Zap },
  { href: "/hypotheses", label: "Hypotheses", icon: FlaskConical },
  { href: "/monitor", label: "Monitor", icon: Radar },
];

export function TopNav() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-30 bg-[var(--surface)]/85 backdrop-blur-md border-b border-[var(--border)]">
      <div className="max-w-[1080px] mx-auto px-6 flex items-center h-14">
        <Link href="/" className="flex items-center gap-2.5 mr-9 shrink-0 group">
          <span className="relative flex items-center justify-center w-6 h-6 rounded-[7px] bg-[var(--accent)] shadow-[var(--shadow-sm)]">
            <span className="w-2.5 h-2.5 rounded-full border-[1.5px] border-white" />
          </span>
          <span className="font-serif text-[17px] font-medium text-[var(--text-primary)] tracking-tight">
            ScholarLens
          </span>
        </Link>

        <nav className="flex items-center gap-0.5 h-full">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={`relative flex items-center gap-1.5 px-3 h-full text-[14px] t-all ${
                  active
                    ? "text-[var(--text-primary)] font-medium"
                    : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                }`}
              >
                <Icon size={15} strokeWidth={active ? 2.2 : 1.8} />
                {label}
                {active && (
                  <span className="absolute bottom-0 left-2 right-2 h-[2px] rounded-full bg-[var(--accent)]" />
                )}
              </Link>
            );
          })}
        </nav>

        <Link
          href="/add-papers"
          className={`ml-auto flex items-center gap-1.5 px-3.5 py-2 rounded-[var(--r-md)] text-[13px] font-medium t-all ${
            pathname.startsWith("/add-papers")
              ? "bg-[var(--accent-hover)] text-white shadow-[var(--shadow-sm)]"
              : "bg-[var(--accent)] text-white shadow-[var(--shadow-sm)] hover:bg-[var(--accent-hover)] hover:shadow-[var(--shadow-md)] hover:-translate-y-px"
          }`}
        >
          <Plus size={15} strokeWidth={2.4} /> Add papers
        </Link>
      </div>
    </header>
  );
}
