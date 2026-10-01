"use client"
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { AUTH_REQUIRED_EVENT } from "@/lib/api-config"
import { APIError, getMe, login as apiLogin, logout as apiLogout,
         type AuthUser, type PermissionFlag } from "@/lib/api"

// zones en lecture seule par défaut pour un viewer sans permissions explicites
const VIEWER_DEFAULT: Partial<Record<PermissionFlag, boolean>> = {
  area_dashboard: true, area_missions: true, area_analysis: true, area_capture: true,
}

interface AuthCtx {
  user: AuthUser | null
  isAdmin: boolean
  isLoading: boolean
  hubUnreachable: boolean
  hasPermission: (flag: PermissionFlag) => boolean
  hasArea: (flag: PermissionFlag) => boolean
  login: (u: string, p: string) => Promise<void>
  logout: () => Promise<void>
  refresh: () => Promise<void>
}
const Ctx = createContext<AuthCtx | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [isLoading, setLoading] = useState(true)
  const [hubUnreachable, setUnreachable] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setUser(await getMe()); setUnreachable(false)
    } catch (err) {
      if (err instanceof APIError && err.status === 401) { setUser(null); setUnreachable(false) }
      else setUnreachable(true)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => {
    refresh()
    const onAuthRequired = () => setUser(null)
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired)
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired)
  }, [refresh])

  const login = useCallback(async (u: string, p: string) => {
    const { user } = await apiLogin(u, p); setUser(user); setUnreachable(false)
  }, [])
  const logout = useCallback(async () => { await apiLogout(); setUser(null) }, [])

  const hasPermission = useCallback((flag: PermissionFlag) => {
    if (!user) return false
    if (user.role === "admin") return true
    // overlay identique au backend : défauts viewer + permissions stockées
    const eff = { ...VIEWER_DEFAULT, ...(user.permissions ?? {}) }
    return !!eff[flag]
  }, [user])

  const value = useMemo<AuthCtx>(() => ({
    user, isAdmin: user?.role === "admin", isLoading, hubUnreachable,
    hasPermission, hasArea: hasPermission, login, logout, refresh,
  }), [user, isLoading, hubUnreachable, hasPermission, login, logout, refresh])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error("useAuth must be used within AuthProvider")
  return ctx
}
