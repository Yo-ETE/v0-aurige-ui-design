"use client"

/**
 * Assistant d'isolation binaire guidé.
 *
 * Encode le workflow : choisir un log de départ → Diviser & tester →
 * Rejouer A → "A reproduit l'action ?" Oui (A devient candidat) / Non →
 * Rejouer B → "B reproduit ?" Oui (B candidat) / Non → impasse.
 * Répète jusqu'à 1 trame → Trame isolée → marquer succès.
 *
 * Réutilise l'API (splitLog, startReplay, getReplayStatus) et le store
 * d'isolation (addChildLog). Aucune modif backend.
 */

import { useMemo, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Wand2, Play, Scissors, CheckCircle2, XCircle, Loader2, RotateCcw, Eye, Trophy, AlertTriangle } from "lucide-react"
import { splitLog, startReplay, getReplayStatus, type CANInterface } from "@/lib/api"
import { useIsolationStore, type IsolationLog } from "@/lib/isolation-store"

type Phase = "pick" | "ready" | "test_a" | "test_b" | "isolated" | "deadend"

interface Candidate {
  id: string
  name: string
  missionId: string
  frameCount: number
}

interface IsolationAssistantProps {
  logs: IsolationLog[]
  canInterface: CANInterface
  onMarkSuccess: (log: { id: string; missionId: string }) => void
  onView: (log: IsolationLog) => void
}

// Aplatit l'arbre en liste (avec indentation visuelle) pour le sélecteur de départ.
function flatten(logs: IsolationLog[], depth = 0): { log: IsolationLog; depth: number }[] {
  const out: { log: IsolationLog; depth: number }[] = []
  for (const l of logs) {
    out.push({ log: l, depth })
    if (l.children && l.children.length) out.push(...flatten(l.children, depth + 1))
  }
  return out
}

export function IsolationAssistant({ logs, canInterface, onMarkSuccess, onView }: IsolationAssistantProps) {
  const addChildLog = useIsolationStore((s) => s.addChildLog)

  const [phase, setPhase] = useState<Phase>("pick")
  const [candidate, setCandidate] = useState<Candidate | null>(null)
  const [childA, setChildA] = useState<Candidate | null>(null)
  const [childB, setChildB] = useState<Candidate | null>(null)
  const [startId, setStartId] = useState<string>("")
  const [busy, setBusy] = useState(false)
  const [replaying, setReplaying] = useState<"A" | "B" | null>(null)
  const [replayedHalf, setReplayedHalf] = useState<"A" | "B" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<Candidate[]>([])

  const flat = useMemo(() => flatten(logs), [logs])

  const reset = (keepStart = false) => {
    setPhase("pick")
    setCandidate(null)
    setChildA(null)
    setChildB(null)
    setReplaying(null)
    setReplayedHalf(null)
    setError(null)
    setHistory([])
    if (!keepStart) setStartId("")
  }

  const start = () => {
    const found = flat.find((f) => f.log.id === startId)
    if (!found) return
    const fc = found.log.frameCount ?? 0
    const cand: Candidate = { id: found.log.id, name: found.log.name, missionId: found.log.missionId, frameCount: fc }
    setCandidate(cand)
    setHistory([])
    setError(null)
    setPhase(fc <= 1 ? "isolated" : "ready")
  }

  const doSplit = async () => {
    if (!candidate) return
    setBusy(true)
    setError(null)
    try {
      const r = await splitLog(candidate.missionId, candidate.id)
      const a: Candidate = { id: r.logAId, name: r.logAName, missionId: candidate.missionId, frameCount: r.logAFrames }
      const b: Candidate = { id: r.logBId, name: r.logBName, missionId: candidate.missionId, frameCount: r.logBFrames }
      // Ajoute aussi les enfants à l'arbre visible.
      addChildLog(candidate.id, { id: a.id, name: a.name, filename: a.name, missionId: a.missionId, tags: [], frameCount: a.frameCount, children: [] })
      addChildLog(candidate.id, { id: b.id, name: b.name, filename: b.name, missionId: b.missionId, tags: [], frameCount: b.frameCount, children: [] })
      setChildA(a)
      setChildB(b)
      setReplayedHalf(null)
      setPhase("test_a")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur lors de la division")
    } finally {
      setBusy(false)
    }
  }

  // Rejoue une moitié et attend la fin (poll), pour enchaîner sur la question.
  const replayHalf = async (half: "A" | "B") => {
    const c = half === "A" ? childA : childB
    if (!c) return
    setReplaying(half)
    setError(null)
    try {
      await startReplay(c.missionId, c.id, canInterface)
      // Poll jusqu'à la fin du replay (max 120s).
      const deadline = Date.now() + 120000
      // petite attente initiale pour laisser le process démarrer
      await new Promise((r) => setTimeout(r, 300))
      while (Date.now() < deadline) {
        const st = await getReplayStatus()
        if (!st.running) break
        await new Promise((r) => setTimeout(r, 500))
      }
      setReplayedHalf(half)
    } catch (e: unknown) {
      const status = e && typeof e === "object" && "status" in e ? (e as { status?: number }).status : undefined
      setError(status === 409 ? "Un replay est déjà en cours. Arrêtez-le puis réessayez." : (e instanceof Error ? e.message : "Erreur lors du replay"))
    } finally {
      setReplaying(null)
    }
  }

  // Réponse de l'utilisateur : la moitié testée a-t-elle reproduit l'action ?
  const answer = (half: "A" | "B", reproduced: boolean) => {
    const chosen = half === "A" ? childA : childB
    if (reproduced) {
      if (!chosen) return
      // On descend dans cette moitié.
      if (candidate) setHistory((h) => [...h, candidate])
      setCandidate(chosen)
      setChildA(null)
      setChildB(null)
      setReplayedHalf(null)
      setPhase(chosen.frameCount <= 1 ? "isolated" : "ready")
    } else {
      // Cette moitié ne reproduit pas.
      if (half === "A") {
        setReplayedHalf(null)
        setPhase("test_b")
      } else {
        setPhase("deadend")
      }
    }
  }

  const goBack = () => {
    setHistory((h) => {
      if (h.length === 0) {
        reset(true)
        return h
      }
      const prev = h[h.length - 1]
      setCandidate(prev)
      setChildA(null)
      setChildB(null)
      setReplayedHalf(null)
      setError(null)
      setPhase(prev.frameCount <= 1 ? "isolated" : "ready")
      return h.slice(0, -1)
    })
  }

  const markSuccess = () => {
    if (!candidate) return
    onMarkSuccess({ id: candidate.id, missionId: candidate.missionId })
  }

  const header = (
    <CardHeader>
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <Wand2 className="h-5 w-5 text-primary" />
        </div>
        <div className="min-w-0">
          <CardTitle className="text-lg">Assistant d'isolation</CardTitle>
          <CardDescription>Recherche binaire guidée de la trame responsable</CardDescription>
        </div>
      </div>
    </CardHeader>
  )

  return (
    <Card className="border-border bg-card">
      {header}
      <CardContent className="space-y-4">
        {error && (
          <Alert className="border-destructive/50 bg-destructive/10">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            <AlertDescription className="text-destructive text-sm">{error}</AlertDescription>
          </Alert>
        )}

        {phase === "pick" && (
          flat.length === 0 ? (
            <p className="text-sm text-muted-foreground">Importez un log dans l'arbre pour démarrer l'assistant.</p>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Choisissez le log où vous avez joué l'action à isoler.
              </p>
              <Select value={startId} onValueChange={setStartId}>
                <SelectTrigger><SelectValue placeholder="Log de départ" /></SelectTrigger>
                <SelectContent>
                  {flat.map(({ log, depth }) => (
                    <SelectItem key={log.id} value={log.id}>
                      {"— ".repeat(depth)}{log.name}{log.frameCount != null ? ` (${log.frameCount} trames)` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button onClick={start} disabled={!startId} className="w-full gap-2">
                <Wand2 className="h-4 w-4" /> Démarrer l'assistant
              </Button>
            </div>
          )
        )}

        {candidate && phase !== "pick" && (
          <div className="rounded-lg border border-border/50 bg-secondary/20 p-3 space-y-1">
            <p className="text-xs text-muted-foreground">Candidat courant</p>
            <p className="font-mono text-sm break-all">{candidate.name}</p>
            <p className="text-xs text-muted-foreground">{candidate.frameCount} trames</p>
          </div>
        )}

        {phase === "ready" && candidate && (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Divisez le candidat en deux et testez chaque moitié.
            </p>
            <Button onClick={doSplit} disabled={busy} className="w-full gap-2">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scissors className="h-4 w-4" />}
              Diviser &amp; tester
            </Button>
            {history.length > 0 && (
              <Button onClick={goBack} variant="outline" className="w-full gap-2 bg-transparent">
                <RotateCcw className="h-4 w-4" /> Revenir en arrière
              </Button>
            )}
          </div>
        )}

        {(phase === "test_a" || phase === "test_b") && (() => {
          const half = phase === "test_a" ? "A" : "B"
          const c = half === "A" ? childA : childB
          if (!c) return null
          return (
            <div className="space-y-3">
              <div className="rounded-lg border border-border/50 bg-background/50 p-3">
                <p className="text-xs text-muted-foreground">Moitié {half}</p>
                <p className="font-mono text-sm break-all">{c.name}</p>
                <p className="text-xs text-muted-foreground">{c.frameCount} trames</p>
              </div>
              <Button onClick={() => replayHalf(half)} disabled={replaying !== null} className="w-full gap-2">
                {replaying === half ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                {replaying === half ? "Replay en cours..." : `Rejouer ${half} sur ${canInterface}`}
              </Button>
              <p className="text-center text-sm font-medium">
                La moitié {half} a-t-elle reproduit l'action ?
                {replayedHalf !== half && <span className="block text-xs text-muted-foreground">(rejouez d'abord si besoin)</span>}
              </p>
              <div className="flex gap-2">
                <Button onClick={() => answer(half, true)} disabled={replaying !== null} className="flex-1 gap-2 bg-success text-success-foreground hover:bg-success/90">
                  <CheckCircle2 className="h-4 w-4" /> Oui
                </Button>
                <Button onClick={() => answer(half, false)} disabled={replaying !== null} variant="outline" className="flex-1 gap-2 bg-transparent">
                  <XCircle className="h-4 w-4" /> Non
                </Button>
              </div>
              {history.length > 0 && (
                <Button onClick={goBack} variant="ghost" className="w-full gap-2 text-xs">
                  <RotateCcw className="h-3 w-3" /> Revenir en arrière
                </Button>
              )}
            </div>
          )
        })()}

        {phase === "isolated" && candidate && (
          <div className="space-y-3">
            <Alert className="border-success/50 bg-success/10">
              <Trophy className="h-4 w-4 text-success" />
              <AlertDescription className="text-success text-sm">
                Trame isolée : <span className="font-mono">{candidate.name}</span> ({candidate.frameCount} trame{candidate.frameCount > 1 ? "s" : ""}).
              </AlertDescription>
            </Alert>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button onClick={markSuccess} className="w-full gap-2 sm:flex-1">
                <CheckCircle2 className="h-4 w-4" /> Marquer succès
              </Button>
              <Button
                onClick={() => onView({ id: candidate.id, name: candidate.name, filename: candidate.name, missionId: candidate.missionId, tags: [] })}
                variant="outline"
                className="w-full gap-2 bg-transparent sm:flex-1"
              >
                <Eye className="h-4 w-4" /> Voir la trame
              </Button>
            </div>
            {candidate.frameCount > 1 && (
              <Button onClick={() => setPhase("ready")} variant="ghost" className="w-full gap-2 text-xs">
                <Scissors className="h-3 w-3" /> Continuer à diviser
              </Button>
            )}
            <Button onClick={() => reset()} variant="ghost" className="w-full gap-2 text-xs">
              <RotateCcw className="h-3 w-3" /> Recommencer
            </Button>
          </div>
        )}

        {phase === "deadend" && (
          <div className="space-y-3">
            <Alert className="border-warning/50 bg-warning/10">
              <AlertTriangle className="h-4 w-4 text-warning" />
              <AlertDescription className="text-warning text-sm">
                Aucune moitié ne reproduit l'action seule. La trame dépend peut-être d'une combinaison,
                ou le replay n'a pas déclenché. Revenez en arrière pour retester, ou recommencez.
              </AlertDescription>
            </Alert>
            <div className="flex gap-2">
              <Button onClick={goBack} variant="outline" className="flex-1 gap-2 bg-transparent">
                <RotateCcw className="h-4 w-4" /> Revenir en arrière
              </Button>
              <Button onClick={() => reset()} variant="ghost" className="flex-1 gap-2">
                Recommencer
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
