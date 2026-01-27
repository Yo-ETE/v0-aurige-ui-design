"use client"

import { useState, useEffect, useCallback } from "react"
import { AppShell } from "@/components/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Progress } from "@/components/ui/progress"
import { Flame, AlertTriangle, Play, Square, AlertCircle, CheckCircle2, Loader2 } from "lucide-react"
import { startFuzzing, stopFuzzing, getFuzzingStatus, type ProcessStatus } from "@/lib/api"

export default function Fuzzing() {
  const [idStart, setIdStart] = useState("000")
  const [idEnd, setIdEnd] = useState("7FF")
  const [dataTemplate, setDataTemplate] = useState("0000000000000000")
  const [iterations, setIterations] = useState("100")
  const [delay, setDelay] = useState("10")
  const [status, setStatus] = useState<ProcessStatus>({ running: false })
  const [isStarting, setIsStarting] = useState(false)
  const [isStopping, setIsStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  
  // Simulated progress tracking
  const [progress, setProgress] = useState(0)
  const [currentId, setCurrentId] = useState("")
  const [startTime, setStartTime] = useState<number | null>(null)

  const fetchStatus = useCallback(async () => {
    try {
      const s = await getFuzzingStatus()
      setStatus(s)
      if (!s.running) {
        setProgress(0)
        setCurrentId("")
        setStartTime(null)
      }
    } catch {
      // API might not be available
    }
  }, [])

  useEffect(() => {
    fetchStatus()
    const interval = setInterval(fetchStatus, 2000)
    return () => clearInterval(interval)
  }, [fetchStatus])

  // Simulate progress when running
  useEffect(() => {
    if (!status.running || !startTime) return

    const totalIterations = parseInt(iterations)
    const delayMs = parseInt(delay)
    const estimatedDurationMs = totalIterations * delayMs
    
    const interval = setInterval(() => {
      const elapsed = Date.now() - startTime
      const progressPercent = Math.min((elapsed / estimatedDurationMs) * 100, 99)
      setProgress(progressPercent)
      
      // Simulate current ID
      const startId = parseInt(idStart, 16)
      const endId = parseInt(idEnd, 16)
      const currentIdNum = startId + Math.floor(((endId - startId) * progressPercent) / 100)
      setCurrentId(currentIdNum.toString(16).toUpperCase().padStart(3, "0"))
    }, 100)

    return () => clearInterval(interval)
  }, [status.running, startTime, iterations, delay, idStart, idEnd])

  const handleStart = async () => {
    setError(null)
    setSuccess(null)
    setIsStarting(true)
    setProgress(0)
    
    try {
      await startFuzzing(
        "can0",
        idStart,
        idEnd,
        dataTemplate,
        parseInt(iterations),
        parseInt(delay)
      )
      setSuccess("Fuzzing démarré")
      setStartTime(Date.now())
      await fetchStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur lors du démarrage")
    } finally {
      setIsStarting(false)
    }
  }

  const handleStop = async () => {
    setError(null)
    setIsStopping(true)
    
    try {
      await stopFuzzing()
      setSuccess("Fuzzing arrêté")
      setProgress(0)
      setCurrentId("")
      setStartTime(null)
      await fetchStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur lors de l'arrêt")
    } finally {
      setIsStopping(false)
    }
  }

  return (
    <AppShell
      title="Fuzzing"
      description="Test de fuzzing CAN pour découverte de vulnérabilités"
    >
      <div className="grid gap-6">
        {/* Alerts */}
        {(error || success) && (
          <>
            {error && (
              <Alert className="border-destructive/50 bg-destructive/10">
                <AlertCircle className="h-4 w-4 text-destructive" />
                <AlertDescription className="text-destructive">{error}</AlertDescription>
              </Alert>
            )}
            {success && (
              <Alert className="border-success/50 bg-success/10">
                <CheckCircle2 className="h-4 w-4 text-success" />
                <AlertDescription className="text-success">{success}</AlertDescription>
              </Alert>
            )}
          </>
        )}

        {/* Warning Alert */}
        <Alert className="border-warning/50 bg-warning/10">
          <AlertTriangle className="h-4 w-4 text-warning" />
          <AlertTitle className="text-warning">Attention - Utilisation dangereuse</AlertTitle>
          <AlertDescription className="text-warning/80">
            Le fuzzing envoie des trames CAN aléatoires sur le bus. Cela peut provoquer des 
            comportements inattendus ou dangereux du véhicule. Utilisez uniquement sur des 
            véhicules de test dans un environnement contrôlé.
          </AlertDescription>
        </Alert>

        <Card className="border-border bg-card">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-warning/10">
                <Flame className="h-5 w-5 text-warning" />
              </div>
              <div>
                <CardTitle className="text-lg">Configuration Fuzzing</CardTitle>
                <CardDescription>
                  Paramètres de génération de trames aléatoires
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-2">
                <Label htmlFor="id-start">ID Start (hex)</Label>
                <Input
                  id="id-start"
                  value={idStart}
                  onChange={(e) => setIdStart(e.target.value.toUpperCase())}
                  className="font-mono"
                  placeholder="000"
                  disabled={status.running}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="id-end">ID End (hex)</Label>
                <Input
                  id="id-end"
                  value={idEnd}
                  onChange={(e) => setIdEnd(e.target.value.toUpperCase())}
                  className="font-mono"
                  placeholder="7FF"
                  disabled={status.running}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="data-template">Data Template (16 hex)</Label>
                <Input
                  id="data-template"
                  value={dataTemplate}
                  onChange={(e) => setDataTemplate(e.target.value.toUpperCase())}
                  className="font-mono"
                  placeholder="0000000000000000"
                  maxLength={16}
                  disabled={status.running}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="iterations">Iterations (max 1000)</Label>
                <Input
                  id="iterations"
                  type="number"
                  value={iterations}
                  onChange={(e) => setIterations(e.target.value)}
                  max={1000}
                  disabled={status.running}
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="delay">Delay (ms)</Label>
                <Input
                  id="delay"
                  type="number"
                  value={delay}
                  onChange={(e) => setDelay(e.target.value)}
                  disabled={status.running}
                />
              </div>
              <div className="flex items-end gap-3">
                <Button
                  onClick={handleStart}
                  disabled={status.running || isStarting}
                  className="flex-1 gap-2"
                >
                  {isStarting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                  Démarrer fuzzing
                </Button>
                <Button
                  onClick={handleStop}
                  disabled={!status.running || isStopping}
                  variant="destructive"
                  className="flex-1 gap-2"
                >
                  {isStopping ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Square className="h-4 w-4" />
                  )}
                  Arrêter
                </Button>
              </div>
            </div>

            {status.running && (
              <div className="space-y-3 rounded-lg bg-secondary p-4">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Progression</span>
                  <span className="font-mono text-foreground">
                    ID: <span className="text-primary">0x{currentId}</span>
                  </span>
                </div>
                <Progress value={progress} className="h-2" />
                <p className="text-xs text-muted-foreground text-right">
                  {Math.round(progress)}% complété
                </p>
              </div>
            )}
            
            <p className="text-xs text-muted-foreground">
              Utilise <code className="rounded bg-muted px-1 py-0.5 font-mono">cansend</code> en boucle pour envoyer des trames avec IDs incrémentaux
            </p>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  )
}
