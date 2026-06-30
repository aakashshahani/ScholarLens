"use client";

import { useEffect, useState } from "react";
import { api, type UserSettings } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { PageHeader, Card, SectionLabel } from "@/components/ui";
import { Check, LogOut, ShieldOff, Mail } from "lucide-react";

const inputCls =
  "w-full bg-[var(--surface-1)] border border-[var(--line-2)] rounded-[var(--r-md)] px-3.5 py-2.5 text-[14px] text-[var(--text-1)] placeholder:text-[var(--text-4)] outline-none t-all focus:border-[var(--gen-line)]";
const primaryBtn =
  "flex items-center justify-center gap-2 py-2.5 px-5 rounded-[var(--r-md)] bg-[var(--gen)] text-white text-[13px] font-medium t-all hover:opacity-90 disabled:opacity-40 disabled:pointer-events-none";
const ghostBtn =
  "flex items-center gap-1.5 py-2.5 px-4 rounded-[var(--r-md)] border border-[var(--line-2)] text-[var(--text-2)] text-[13px] t-all hover:text-[var(--text-1)] hover:border-[var(--text-3)] disabled:opacity-40 disabled:pointer-events-none";

function UsageBar({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const over = used >= limit;
  return (
    <div>
      <div className="flex justify-between text-[12px] mb-1.5">
        <span className="text-[var(--text-3)]">{label}</span>
        <span className="mono text-[var(--text-2)] tabular-nums">{used} / {limit}</span>
      </div>
      <div className="h-[6px] rounded-full bg-[var(--surface-3)] overflow-hidden">
        <div className="h-full t-all" style={{ width: `${pct}%`, background: over ? "var(--contra)" : "var(--gen)" }} />
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const { refresh, logout } = useAuth();
  const [s, setS] = useState<UserSettings | null>(null);
  const [loading, setLoading] = useState(true);

  const [keyInput, setKeyInput] = useState("");
  const [testState, setTestState] = useState<"idle" | "testing" | "valid" | "invalid">("idle");
  const [testMsg, setTestMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const [libName, setLibName] = useState("");
  const [libSaved, setLibSaved] = useState(false);

  const [digestEmail, setDigestEmail] = useState("");
  const [digestSaved, setDigestSaved] = useState(false);
  const [digestError, setDigestError] = useState("");
  const [testDigestState, setTestDigestState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [testDigestMsg, setTestDigestMsg] = useState("");

  async function load() {
    const data = await api.getSettings();
    setS(data);
    setLibName(data.library_name);
    setDigestEmail(data.digest_email || "");
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  if (loading || !s) {
    return <div className="text-[var(--text-3)] text-[14px] py-10">Loading settings…</div>;
  }

  const hasKey = s.has_api_key;
  const sonnetLeft = Math.max(0, s.free_sonnet_limit - s.free_sonnet_used);

  async function testKey() {
    setTestState("testing"); setTestMsg("");
    try {
      const r = await api.testApiKey(keyInput.trim() || undefined);
      if (r.valid) { setTestState("valid"); setTestMsg("Key is valid."); }
      else { setTestState("invalid"); setTestMsg(r.error || "Key was rejected."); }
    } catch (e) {
      setTestState("invalid"); setTestMsg(e instanceof Error ? e.message : "Test failed.");
    }
  }

  async function saveKey() {
    if (!keyInput.trim()) return;
    setBusy(true);
    try {
      await api.updateSettings({ apiKey: keyInput.trim() });
      setKeyInput(""); setTestState("idle"); setTestMsg("");
      await refresh(); await load();
    } finally { setBusy(false); }
  }

  async function removeKey() {
    setBusy(true);
    try {
      await api.updateSettings({ apiKey: "" });
      await refresh(); await load();
    } finally { setBusy(false); }
  }

  async function changeModel(id: string) {
    if (!s) return;
    // Optimistic update — move the checkmark immediately so the UI feels instant.
    // If the API call fails, revert to the previous model.
    const prev = s.model;
    setS({ ...s, model: id });
    setBusy(true);
    try {
      await api.updateSettings({ model: id });
      await refresh();
      await load();
    } catch {
      setS((cur) => cur ? { ...cur, model: prev } : cur);
    } finally {
      setBusy(false);
    }
  }

  async function saveLib() {
    await api.updateSettings({ libraryName: libName.trim() || "My Library" });
    setLibSaved(true); setTimeout(() => setLibSaved(false), 1500);
    await refresh(); await load();
  }

  async function saveDigestEmail() {
    const val = digestEmail.trim() || null;
    // Validate before saving so a malformed address can't silently disable digests.
    if (val && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
      setDigestError("Enter a valid email address.");
      return;
    }
    setDigestError("");
    await api.updateSettings({ digestEmail: val });
    setDigestSaved(true); setTimeout(() => setDigestSaved(false), 1500);
    await refresh(); await load();
  }

  async function testDigest() {
    setTestDigestState("sending"); setTestDigestMsg("");
    try {
      const r = await api.testDigest();
      if (r.email_sent) {
        setTestDigestState("sent");
        setTestDigestMsg(`Digest sent — ${r.papers_relevant} relevant papers across ${r.topics_scanned} topic${r.topics_scanned !== 1 ? "s" : ""}.`);
      } else {
        setTestDigestState("error");
        setTestDigestMsg(r.email_error || "Email not delivered.");
      }
    } catch (e: any) {
      setTestDigestState("error");
      setTestDigestMsg(e.message || "Test failed.");
    }
    setTimeout(() => { setTestDigestState("idle"); setTestDigestMsg(""); }, 8000);
  }

  async function signOutEverywhere() {
    try { await api.logoutAll(); } catch { /* session may already be gone */ }
    await logout();
  }

  return (
    <div className="max-w-[680px]">
      <PageHeader title="Settings" subtitle="Your API key, model, digest email, and account." />

      {/* ── API key (BYOK) ── */}
      <Card className="mb-5">
        <SectionLabel>Anthropic API key</SectionLabel>
        <p className="text-[13px] text-[var(--text-2)] mb-2 leading-[1.5]">
          Bring your own key to run any model, uncapped — billed to your Anthropic account.
          It&apos;s stored encrypted and never shown back. Without a key you&apos;re on the free tier below.
        </p>
        <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer"
          className="inline-block mb-4 text-[12.5px] text-[var(--gen)] hover:underline">
          Get an API key from the Anthropic console →
        </a>

        {hasKey && (
          <div className="flex items-center gap-3 mb-3">
            <span className="mono text-[13px] text-[var(--text-2)]">{s.api_key_masked}</span>
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px]" style={{ background: "var(--support-dim)", color: "var(--support)" }}>
              <Check size={11} /> active
            </span>
          </div>
        )}

        <input
          type="password"
          value={keyInput}
          onChange={(e) => { setKeyInput(e.target.value); setTestState("idle"); setTestMsg(""); }}
          placeholder={hasKey ? "Paste a new key to replace…" : "sk-ant-…"}
          className={inputCls}
        />
        {testMsg && (
          <div className="mt-2 text-[12.5px]" style={{ color: testState === "valid" ? "var(--support)" : "var(--contra)" }}>
            {testMsg}
          </div>
        )}
        <div className="flex items-center gap-2 mt-3">
          <button onClick={testKey} disabled={testState === "testing" || (!keyInput.trim() && !hasKey)} className={ghostBtn}>
            {testState === "testing" ? "Testing…" : "Test"}
          </button>
          <button onClick={saveKey} disabled={!keyInput.trim() || busy} className={primaryBtn}>Save key</button>
          {hasKey && (
            <button onClick={removeKey} disabled={busy} className={`${ghostBtn} ml-auto`} style={{ color: "var(--contra)", borderColor: "var(--contra-line)" }}>
              Remove
            </button>
          )}
        </div>
      </Card>

      {/* ── Model ── */}
      <Card className="mb-5">
        <SectionLabel>Model</SectionLabel>
        <p className="text-[13px] text-[var(--text-2)] mb-3 leading-[1.5]">
          {hasKey
            ? "Pick any model — runs on your key."
            : "The free tier runs Haiku. Sonnet is limited, and Opus needs your own key."}
        </p>
        <div className="space-y-2">
          {s.allowed_models.map((m) => {
            const locked = !hasKey && m.tier === "opus";
            const selected = s.model === m.id;
            const note =
              !hasKey && m.tier === "sonnet" ? ` · ${sonnetLeft} of ${s.free_sonnet_limit} free left`
              : !hasKey && m.tier === "opus" ? " · needs your key"
              : "";
            return (
              <button
                key={m.id}
                disabled={locked || busy}
                onClick={() => changeModel(m.id)}
                className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-[var(--r-md)] border text-left t-all ${
                  selected ? "border-[var(--gen-line)] bg-[var(--gen-dim)]" : "border-[var(--line)] bg-[var(--surface-1)] hover:border-[var(--line-2)]"
                } ${locked ? "opacity-40 pointer-events-none" : ""}`}
              >
                <span className="text-[13.5px] text-[var(--text-1)]">
                  {m.label}<span className="text-[var(--text-3)]">{note}</span>
                </span>
                {selected && <Check size={15} className="text-[var(--gen)]" />}
              </button>
            );
          })}
        </div>
      </Card>

      {/* ── Free tier usage (only without a key) ── */}
      {!hasKey && (
        <Card className="mb-5">
          <SectionLabel>Free tier usage</SectionLabel>
          <div className="mt-1 space-y-3">
            <UsageBar label="Total actions" used={s.free_actions_used} limit={s.free_action_limit} />
            <UsageBar label="Sonnet actions" used={s.free_sonnet_used} limit={s.free_sonnet_limit} />
          </div>
          <p className="text-[12px] text-[var(--text-3)] mt-3">Add your own key above to lift these limits.</p>
        </Card>
      )}

      {/* ── Library ── */}
      <Card className="mb-5">
        <SectionLabel>Library name</SectionLabel>
        <div className="flex gap-2">
          <input value={libName} onChange={(e) => setLibName(e.target.value)} className={inputCls} />
          <button onClick={saveLib} className={primaryBtn}>{libSaved ? "Saved" : "Save"}</button>
        </div>
      </Card>

      {/* ── Digest email ── */}
      <Card className="mb-5">
        <SectionLabel>Daily digest email</SectionLabel>
        <p className="text-[13px] text-[var(--text-2)] mb-3 leading-[1.5]">
          Get a daily email when the research monitor finds new relevant papers.
          Leave blank to disable. The scheduler runs every day at 09:00 UTC.
        </p>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Mail size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-4)]" />
            <input
              type="email"
              value={digestEmail}
              onChange={(e) => setDigestEmail(e.target.value)}
              placeholder="you@example.com"
              className={`${inputCls} pl-9`}
            />
          </div>
          <button onClick={saveDigestEmail} className={primaryBtn}>
            {digestSaved ? "Saved" : "Save"}
          </button>
          {digestEmail && (
            <button
              onClick={() => { setDigestEmail(""); saveDigestEmail(); }}
              className={ghostBtn}
              style={{ color: "var(--contra)", borderColor: "var(--contra-line)" }}
            >
              Clear
            </button>
          )}
        </div>
        {digestError && (
          <div className="mt-2 text-[12.5px] text-[var(--contra)]">{digestError}</div>
        )}
        {testDigestMsg && (
          <div className="mt-2 text-[12.5px]" style={{
            color: testDigestState === "sent" ? "var(--support)" : "var(--contra)"
          }}>
            {testDigestMsg}
          </div>
        )}
        {digestEmail && (
          <div className="mt-3">
            <button
              onClick={testDigest}
              disabled={testDigestState === "sending"}
              className={ghostBtn}
            >
              {testDigestState === "sending" ? "Sending…" : testDigestState === "sent" ? "✓ Sent" : "Send test digest now"}
            </button>
            <div className="text-[11px] text-[var(--text-3)] mt-1.5">
              Triggers an immediate scan and sends the digest to your email. Scheduler runs daily at 09:00 UTC.
            </div>
          </div>
        )}
      </Card>

      {/* ── Account ── */}
      <Card>
        <SectionLabel>Account</SectionLabel>
        <div className="text-[13.5px] text-[var(--text-1)] mb-1">{s.email}</div>
        <div className="flex items-center gap-2 mt-3">
          <button onClick={logout} className={ghostBtn}><LogOut size={14} /> Sign out</button>
          <button onClick={signOutEverywhere} className={ghostBtn} style={{ color: "var(--contra)", borderColor: "var(--contra-line)" }}>
            <ShieldOff size={14} /> Sign out everywhere
          </button>
        </div>
      </Card>
    </div>
  );
}
