"use client";

import { ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import { LeftRail } from "@/components/left-rail";
import { CommandPalette } from "@/components/command-palette";
import { AuthGate } from "@/components/auth-gate";

/**
 * Renders one of three states:
 *   loading  → full-screen loader while the initial me() check runs
 *   no user  → the login / register screen (no app chrome)
 *   signed in → the real app: left rail, command palette, and the routed page
 *
 * Pages mount only in the signed-in branch, so none of them fire API calls
 * until there's a valid session — which is what stops the 401 waterfall.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-[var(--canvas)]">
        <div className="flex flex-col items-center gap-4">
          <span className="relative flex items-center justify-center w-9 h-9 rounded-[9px] bg-[var(--gen)] glow-gen">
            <span className="w-3.5 h-3.5 rounded-full border-2 border-white" />
          </span>
          <div className="w-5 h-5 border-2 border-[var(--surface-3)] border-t-[var(--gen)] rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  if (!user) return <AuthGate />;

  return (
    <>
      <LeftRail />
      <CommandPalette />
      <main className="pl-[60px] min-h-screen">
        <div className="max-w-[1180px] mx-auto px-8 py-8">{children}</div>
      </main>
    </>
  );
}
