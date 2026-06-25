import type { Metadata } from "next";
import { Geist, Geist_Mono, Fraunces } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";

// All three fonts via next/font/google — self-hosted at build time, so no
// external request and no Content-Security-Policy concerns. next/font also
// injects the @font-face rules correctly relative to Tailwind, avoiding the
// "@import must precede all rules" error that a raw @import url() triggers
// against Tailwind v4's inlined import.
const geist = Geist({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-geist",
  display: "swap",
});
const fraunces = Fraunces({
  subsets: ["latin"],
  // Only weight 600 is ever rendered (via the .font-display class) — loading
  // 400/500 was dead weight that delayed the headline's webfont swap (LCP).
  weight: ["600"],
  variable: "--font-fraunces",
  display: "swap",
});
const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ScholarLens — Research Intelligence",
  description: "An AI reasoning system for scientific literature — contradictions, consensus shifts, and hypothesis generation.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`h-full ${geist.variable} ${fraunces.variable} ${geistMono.variable}`}>
      <body className="min-h-full antialiased">
        {/* AuthProvider holds the session; AppShell decides between the loader,
            the login screen, and the full app (chrome + routed page). */}
        <AuthProvider>
          <AppShell>{children}</AppShell>
        </AuthProvider>
      </body>
    </html>
  );
}
