"use client"
/**
 * AuthGate — bloque l'interface tant qu'aucune session valide n'existe.
 * Formulaire identifiant + mot de passe (remplace le champ token AUD-01).
 */
import React, { useState } from "react"
import { KeyRound, Loader2 } from "lucide-react"
import { useAuth } from "@/lib/auth-context"
import { APIError } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, isLoading, hubUnreachable, login, refresh } = useAuth()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!username.trim() || !password) return
    setSubmitting(true); setError(null)
    try {
      await login(username.trim(), password); setPassword("")
    } catch (err) {
      if (err instanceof APIError && err.status === 429) setError("Trop d'essais. Réessayez dans quelques minutes.")
      else if (err instanceof APIError && err.status === 401) setError("Identifiants invalides.")
      else setError("Backend injoignable. Vérifiez que le service aurige-api tourne.")
    } finally { setSubmitting(false) }
  }

  if (user) return <>{children}</>

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Vérification de la session" />
      </div>
    )
  }

  if (hubUnreachable) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <div className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-6 text-center">
          <p className="text-sm text-destructive">Backend injoignable.</p>
          <Button className="w-full" onClick={() => void refresh()}>Réessayer</Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-5 rounded-lg border border-border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10">
            <KeyRound className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-foreground">AURIGE</h1>
            <p className="text-xs text-muted-foreground">Connexion</p>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="aurige-username">Identifiant</Label>
          <Input id="aurige-username" autoFocus autoComplete="username"
                 value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="aurige-password">Mot de passe</Label>
          <Input id="aurige-password" type="password" autoComplete="current-password"
                 value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <Button type="submit" className="w-full" disabled={submitting || !username.trim() || !password}>
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Se connecter
        </Button>
      </form>
    </div>
  )
}
