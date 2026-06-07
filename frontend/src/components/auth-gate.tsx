"use client";

import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { ApiError } from "@/lib/api";
import { ArrowRight } from "lucide-react";

export function AuthGate() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isRegister = mode === "register";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!email.trim()) return setError("Enter your email.");
    if (isRegister && password.length < 8) return setError("Password must be at least 8 characters.");
    if (!password) return setError("Enter your password.");

    setSubmitting(true);
    try {
      if (isRegister) await register(email.trim(), password);
      else await login(email.trim(), password);
      // On success the AuthProvider sets `user`, AppShell swaps to the app.
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.status === 401
            ? "Incorrect email or password."
            : err.message
          : "Something went wrong. Is the backend running on :8000?";
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  function switchMode() {
    setMode(isRegister ? "login" : "register");
    setError(null);
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 bg-[var(--canvas)]">
      {/* Logomark + wordmark */}
      <div className="flex items-center gap-3 mb-8 fade-up">
        <span className="relative flex items-center justify-center w-8 h-8 rounded-[8px] bg-[var(--gen)] glow-gen">
          <span className="w-3 h-3 rounded-full border-[1.5px] border-white" />
        </span>
        <span className="font-display text-[20px] text-[var(--text-1)]">ScholarLens</span>
      </div>

      <form
        onSubmit={submit}
        className="w-full max-w-[380px] bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-lg)] p-7 fade-up"
      >
        <h1 className="font-display text-[22px] leading-tight text-[var(--text-1)]">
          {isRegister ? "Create your library" : "Welcome back"}
        </h1>
        <p className="text-[13.5px] text-[var(--text-2)] mt-1.5 mb-6">
          {isRegister
            ? "An account keeps your papers, claims, and analyses private to you."
            : "Sign in to reach your research library."}
        </p>

        <label className="block text-[11px] font-medium text-[var(--text-3)] uppercase tracking-wide mb-1.5">Email</label>
        <input
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@university.edu"
          className="w-full bg-[var(--surface-1)] border border-[var(--line-2)] rounded-[var(--r-md)] px-3.5 py-2.5 text-[14px] text-[var(--text-1)] placeholder:text-[var(--text-4)] outline-none t-all focus:border-[var(--gen-line)] mb-4"
        />

        <label className="block text-[11px] font-medium text-[var(--text-3)] uppercase tracking-wide mb-1.5">Password</label>
        <input
          type="password"
          autoComplete={isRegister ? "new-password" : "current-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={isRegister ? "At least 8 characters" : "••••••••"}
          className="w-full bg-[var(--surface-1)] border border-[var(--line-2)] rounded-[var(--r-md)] px-3.5 py-2.5 text-[14px] text-[var(--text-1)] placeholder:text-[var(--text-4)] outline-none t-all focus:border-[var(--gen-line)]"
        />

        {error && (
          <div className="mt-4 px-3 py-2.5 rounded-[var(--r-md)] text-[12.5px]" style={{ background: "var(--contra-dim)", color: "var(--contra)" }}>
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full flex items-center justify-center gap-2 py-2.5 px-5 mt-6 rounded-[var(--r-md)] bg-[var(--gen)] text-white text-[13.5px] font-medium t-all hover:opacity-90 hover:glow-gen active:translate-y-px disabled:opacity-40 disabled:pointer-events-none"
        >
          {submitting ? (
            <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
          ) : (
            <>
              {isRegister ? "Create account" : "Sign in"}
              <ArrowRight size={15} strokeWidth={2.2} />
            </>
          )}
        </button>
      </form>

      <button
        onClick={switchMode}
        className="mt-5 text-[13px] text-[var(--text-3)] hover:text-[var(--text-1)] t-all fade-up"
      >
        {isRegister ? "Already have an account? " : "New here? "}
        <span className="text-[var(--gen)]">{isRegister ? "Sign in" : "Create one"}</span>
      </button>
    </div>
  );
}
