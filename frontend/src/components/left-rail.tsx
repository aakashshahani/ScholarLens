"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  LayoutDashboard, Library, Zap, FlaskConical, Radar, Plus, LogOut, Settings as SettingsIcon, Search,
} from "lucide-react";
import { useAuth } from "@/lib/auth";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/library", label: "Library", icon: Library },
  { href: "/contradictions", label: "Contradictions", icon: Zap },
  { href: "/hypotheses", label: "Hypotheses", icon: FlaskConical },
  { href: "/search", label: "Search", icon: Search },
  { href: "/monitor", label: "Monitor", icon: Radar },
];

export function LeftRail() {
  const pathname = usePathname();
  const [expanded, setExpanded] = useState(false);
  const { user, logout } = useAuth();
  const libraryName = user?.library_name ?? null;

  return (
    <aside
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
      className="fixed inset-y-0 left-0 z-40 flex flex-col bg-[var(--surface-1)] border-r border-[var(--line)] t-all"
      style={{ width: expanded ? 220 : 60 }}
    >
      {/* Logomark */}
      <Link href="/" className="flex items-center h-14 px-[18px] shrink-0 overflow-hidden">
        <span className="relative flex items-center justify-center w-6 h-6 rounded-[7px] bg-[var(--gen)] shrink-0 glow-gen">
          <span className="w-2.5 h-2.5 rounded-full border-[1.5px] border-white" />
        </span>
        <div className="ml-3 flex flex-col overflow-hidden t-all" style={{ opacity: expanded ? 1 : 0 }}>
          <span className="font-display text-[15px] text-[var(--text-1)] whitespace-nowrap leading-tight">
            ScholarLens
          </span>
          {libraryName && libraryName !== "My Library" && (
            <span className="text-[11px] text-[var(--text-4)] whitespace-nowrap truncate leading-tight mt-0.5">
              {libraryName}
            </span>
          )}
        </div>
      </Link>

      {/* Nav */}
      <nav className="flex-1 px-2.5 pt-2 space-y-0.5">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={`relative flex items-center h-9 px-[9px] rounded-[var(--r-md)] overflow-hidden t-all ${
                active ? "bg-[var(--surface-3)] text-[var(--text-1)]" : "text-[var(--text-3)] hover:text-[var(--text-1)] hover:bg-[var(--surface-2)]"
              }`}
            >
              {active && <span className="absolute left-0 top-1.5 bottom-1.5 w-[2.5px] rounded-full bg-[var(--gen)]" />}
              <Icon size={17} strokeWidth={active ? 2.2 : 1.8} className="shrink-0" />
              <span className="text-[13.5px] ml-3 whitespace-nowrap t-all" style={{ opacity: expanded ? 1 : 0 }}>
                {label}
              </span>
            </Link>
          );
        })}
      </nav>

      {/* Add + account + hint */}
      <div className="px-2.5 pb-3 space-y-2">
        <Link
          href="/add-papers"
          className="flex items-center h-9 px-[9px] rounded-[var(--r-md)] bg-[var(--gen)] text-white overflow-hidden t-all hover:opacity-90"
        >
          <Plus size={17} strokeWidth={2.4} className="shrink-0" />
          <span className="text-[13px] font-medium ml-3 whitespace-nowrap t-all" style={{ opacity: expanded ? 1 : 0 }}>
            Add papers
          </span>
        </Link>

        <Link
          href="/settings"
          title="Settings"
          className={`relative flex items-center h-9 px-[9px] rounded-[var(--r-md)] overflow-hidden t-all ${
            pathname.startsWith("/settings") ? "bg-[var(--surface-3)] text-[var(--text-1)]" : "text-[var(--text-3)] hover:text-[var(--text-1)] hover:bg-[var(--surface-2)]"
          }`}
        >
          {pathname.startsWith("/settings") && <span className="absolute left-0 top-1.5 bottom-1.5 w-[2.5px] rounded-full bg-[var(--gen)]" />}
          <SettingsIcon size={17} strokeWidth={pathname.startsWith("/settings") ? 2.2 : 1.8} className="shrink-0" />
          <span className="text-[13.5px] ml-3 whitespace-nowrap t-all" style={{ opacity: expanded ? 1 : 0 }}>
            Settings
          </span>
        </Link>

        {user && (
          <button
            onClick={logout}
            title="Sign out"
            className="flex items-center w-full h-9 px-[9px] rounded-[var(--r-md)] text-[var(--text-3)] hover:text-[var(--text-1)] hover:bg-[var(--surface-2)] overflow-hidden t-all"
          >
            <LogOut size={17} strokeWidth={1.8} className="shrink-0" />
            <span className="text-[12.5px] ml-3 whitespace-nowrap t-all truncate" style={{ opacity: expanded ? 1 : 0 }}>
              {user.email}
            </span>
          </button>
        )}

        <div
          className="flex items-center h-7 px-[9px] text-[var(--text-4)] overflow-hidden t-all"
          style={{ opacity: expanded ? 1 : 0 }}
        >
          <span className="text-[11px] whitespace-nowrap">Press</span>
          <kbd className="mono text-[10px] mx-1 px-1.5 py-0.5 rounded bg-[var(--surface-3)] border border-[var(--line-2)]">⌘K</kbd>
        </div>
      </div>
    </aside>
  );
}
