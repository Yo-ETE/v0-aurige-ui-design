"use client"

/**
 * AuthGate — bloque l'interface tant que le navigateur n'a pas de session valide.
 *
 * Le backend exige un token sur toutes les routes (AUD-01). Ici on vérifie la
 * session au montage, on affiche un formulaire de saisie du token si besoin, et on
 * revient sur ce formulaire dès qu'un appel reçoit un 401 (AUTH_REQUIRED_EVENT).
 * Les enfants (pages, terminal flottant, WebSockets) ne sont montés qu'une fois
 * authentifié, ce qui évite une rafale de 401 et de WebSockets refusés.
 */

import React, { useEffect, useState } from "react"
import { KeyRound, Loader2 } from "lucide-react"
import { AUTH_REQUIRED_EVENT } from "@/lib/api-config"
import { APIError, getAuthStatus, login } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type AuthState = "checking" | "authenticated" | "anonymous" | "unreachable"

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>("checking")
  const [token, setToken] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let cancelled = false
    getAuthStatus()
      .then((res) => {
        if (!cancelled) setState(res.authenticated ? "authenticated" : "anonymous")
      })
      .catch(() => {
        if (!cancelled) setState("unreachable")
      })

    const onAuthRequired = () => setState("anonymous")
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired)
    return () => {
      cancelled = true
      window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired)
    }
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!token.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      await login(token.trim())
      setToken("")
      setState("authenticated")
    } catch (err) {
      setError(
        err instanceof APIError && err.status === 401
          ? "Token invalide."
          : "Backend injoignable. Vérifiez que le service aurige-api tourne."
      )
    } finally {
      setSubmitting(false)
    }
  }

  if (state === "authenticated") return <>{children}</>

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      {state === "checking" ? (
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Vérification de la session" />
      ) : (
        <form
          onSubmit={handleSubmit}
          className="w-full max-w-sm space-y-5 rounded-lg border border-border bg-card p-6 shadow-sm"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10">
              <KeyRound className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-foreground">AURIGE</h1>
              <p className="text-xs text-muted-foreground">Accès protégé par token</p>
            </div>
          </div>

          {state === "unreachable" && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              Backend injoignable. Saisissez le token une fois le service démarré.
            </p>
          )}

          <div className="space-y-2">
            <Label htmlFor="aurige-token">Token d&apos;API</Label>
            <Input
              id="aurige-token"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Collez le token du Raspberry Pi"
            />
            <p className="text-[11px] leading-snug text-muted-foreground">
              Sur le Pi : <code className="font-mono">sudo cat /opt/aurige/api_token</code>
            </p>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <Button type="submit" className="w-full" disabled={submitting || !token.trim()}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Se connecter
          </Button>
        </form>
      )}
    </div>
  )
}
