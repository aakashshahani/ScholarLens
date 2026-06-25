"use client";

import { ReactNode, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { LeftRail } from "@/components/left-rail";
import { CommandPalette } from "@/components/command-palette";
import { AuthGate } from "@/components/auth-gate";
import Landing from "@/components/landing";

function FullScreenLoader() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--canvas)]">
      <div className="flex flex-col items-center gap-4">
        <span className="relative flex items-center justify-center w-9 h-9 rounded-[9px] bg-[var(--gen)] glow-gen">
          <span className="w-3.5 h-3.5 rounded-full border-2 border-white" />
        </span>
        <div className="w-5 h-5 border-2 border-[var(--surface-3)] border-t-[var(--gen)] rounded-full animate-spin" />
      </div>
    </div>
  );
}

/**
 * Renders one of these states:
 *   loading                 → full-screen loader while the initial me() check runs
 *   logged out, "/", browse → the public marketing landing page (no app chrome)
 *   logged out, gate shown  → the login / register gate (triggered by a landing CTA,
 *                             or shown immediately on any non-root path)
 *   signed in               → the real app: left rail, command palette, routed page
 *
 * The landing lives at "/" so a shared link lands on marketing, not a login wall.
 * Its CTAs flip `showGate` to swap in the gate inline — no separate /login route,
 * so there's nothing to 404 on. The gate's own "Back" resets it via onBack.
 * Authenticated users get the dashboard at "/" exactly as before.
 *
 * Pages mount only in the signed-in branch, so none of them fire API calls
 * until there's a valid session — which is what stops the 401 waterfall.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const pathname = usePathname();
  const [showGate, setShowGate] = useState(false);
  const [maybeReturning, setMaybeReturning] = useState(false);

  // Read the session hint AFTER hydration so the first client render matches the
  // server (both render the landing with no overlay). Setting state in an effect
  // then re-rendering avoids a hydration mismatch.
  useEffect(() => {
    let alive = true;
    try {
      // Defer out of the synchronous effect body (avoids cascading-render lint
      // and keeps the first client render identical to the server's).
      if (localStorage.getItem("sl_session") === "1")
        queueMicrotask(() => alive && setMaybeReturning(true));
    } catch { /* storage blocked */ }
    return () => {
      alive = false;
    };
  }, []);

  // The public marketing landing renders immediately at "/" — this is what the
  // server sends to logged-out visitors and crawlers, so the hero paints without
  // waiting on the client-side api.me() round-trip. A returning user (session
  // hint present) gets a loader over it until me() resolves into the dashboard,
  // so they don't see the marketing page flash.
  if (pathname === "/" && !user && !showGate) {
    return (
      <>
        <Landing onSignIn={() => setShowGate(true)} />
        {loading && maybeReturning && <FullScreenLoader />}
      </>
    );
  }

  if (loading) return <FullScreenLoader />;

  if (!user) {
    return <AuthGate onBack={pathname === "/" ? () => setShowGate(false) : undefined} />;
  }

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
