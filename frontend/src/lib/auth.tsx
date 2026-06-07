"use client";

import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from "react";
import { api, type AuthUser } from "@/lib/api";
import { cache } from "@/lib/cache";

interface AuthState {
  user: AuthUser | null;
  loading: boolean;                                   // true until the initial me() resolves
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  // Single source of truth for "who is logged in" — also points the
  // localStorage cache at this user's namespace so one account never reads
  // another's cached results on a shared browser.
  const applyUser = useCallback((u: AuthUser | null) => {
    setUser(u);
    cache.setUser(u?.id ?? null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      applyUser(await api.me());
    } catch {
      applyUser(null); // 401 (no/expired session) — not an error, just logged out
    } finally {
      setLoading(false);
    }
  }, [applyUser]);

  useEffect(() => { refresh(); }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    applyUser(await api.login(email, password));
  }, [applyUser]);

  const register = useCallback(async (email: string, password: string) => {
    applyUser(await api.register(email, password));
  }, [applyUser]);

  const logout = useCallback(async () => {
    try { await api.logout(); } catch { /* clear locally regardless */ }
    cache.clearAll();   // wipe every cached result on this browser
    applyUser(null);
  }, [applyUser]);

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
