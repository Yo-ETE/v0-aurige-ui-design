"use client"

import { useState, useEffect, useCallback } from "react"
import { AppShell } from "@/components/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Cpu, Play, Square, Shuffle, AlertCircle, CheckCircle2, Loader2 } from "lucide-react"
import { startGenerator, stopGenerator, getGeneratorStatus, type ProcessStatus } from "@/lib/api"

export default function Generateur() {
  const [canId, setCanId] = useState("")
  const [useRandomId, setUseRandomId] = useState(true)
  const [frameLength, setFrameLength] = useState("8")
  const [delay, setDelay] = useState("100")
  const [status, setStatus] = useState<ProcessStatus>({ running: false })
  const [isStarting, setIsStarting] = useState(false)
  const [isStopping, setIsStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  
  // Simulated frame count (actual count would require backend tracking)
  const [frameCount, setFrameCount] = useState(0)
  const [lastFrame, setLastFrame] = useState<{ id: string; data: string } | null>(null)

  const fetchStatus = useCallback(async () => {
    try {
      const s = await getGeneratorStatus()
      setStatus(s)
      if (!s.running) {
        setFrameCount(0)
        setLastFrame(null)
      }
    } catch {
      // API might not be available
    }
  }, [])

  useEffect(() => {
    fetchStatus()
    const interval = setInterval(fetchStatus, 3000)
    return () => clearInterval(interval)
  }, [fetchStatus])

  // Simulate frame generation display when running
  useEffect(() => {
    if (!status.running) return

    const interval = setInterval(() => {
      const id = useRandomId
        ? Math.floor(Math.random() * 0x7ff).toString(16).toUpperCase().padStart(3, "0")
        : canId || "7DF"
      const length = parseInt(frameLength) || 8
      const data = Array.from({ length }, () =>
        Math.floor(Math.random() * 256).toString(16).toUpperCase().padStart(2, "0")
      ).join(" ")

      setLastFrame({ id, data })
      setFrameCount((prev) => prev + 1)
    }, parseInt(delay) || 100)

    return () => clearInterval(interval)
  }, [status.running, useRandomId, canId, frameLength, delay])

  const handleStart = async () => {
    setError(null)
    setSuccess(null)
    setIsStarting(true)
    setFrameCount(0)
    
    try {
      await startGenerator(
        "can0",
        parseInt(delay) || 100,
        parseInt(frameLength) || 8,
        useRandomId ? undefined : canId || undefined
      )
      setSuccess("Générateur démarré")
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
      await stopGenerator()
      setSuccess("Générateur arrêté")
      await fetchStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur lors de l'arrêt")
    } finally {
      setIsStopping(false)
    }
  }

  return (
    <AppShell
      title="Générateur"
      description="Génération de trames CAN (cangen)"
    >
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Alerts */}
        {(error || success) && (
          <div className="lg:col-span-2">
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
          </div>
        )}

        {/* Configuration Card */}
        <Card className="border-border bg-card">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <Cpu className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-lg">Configuration</CardTitle>
                <CardDescription>
                  Paramètres de génération de trames
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>ID aléatoire</Label>
                  <p className="text-xs text-muted-foreground">
                    Générer un ID CAN aléatoire pour chaque trame
                  </p>
                </div>
                <Switch
                  checked={useRandomId}
                  onCheckedChange={setUseRandomId}
                  disabled={status.running}
                />
              </div>

              {!useRandomId && (
                <div className="space-y-2">
                  <Label htmlFor="can-id">CAN ID (hex)</Label>
                  <Input
                    id="can-id"
                    value={canId}
                    onChange={(e) => setCanId(e.target.value.toUpperCase())}
                    className="font-mono"
                    placeholder="7DF"
                    disabled={status.running}
                  />
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="frame-length">Longueur de trame (1-8 octets)</Label>
                <Input
                  id="frame-length"
                  type="number"
                  value={frameLength}
                  onChange={(e) => setFrameLength(e.target.value)}
                  min={1}
                  max={8}
                  disabled={status.running}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="gen-delay">Intervalle (ms)</Label>
                <Input
                  id="gen-delay"
                  type="number"
                  value={delay}
                  onChange={(e) => setDelay(e.target.value)}
                  disabled={status.running}
                />
              </div>
            </div>

            <div className="flex gap-3">
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
                Démarrer
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
            
            <p className="text-xs text-muted-foreground">
              Utilise <code className="rounded bg-muted px-1 py-0.5 font-mono">cangen</code> pour générer du trafic CAN
            </p>
          </CardContent>
        </Card>

        {/* Status Card */}
        <Card className="border-border bg-card">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <Shuffle className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-lg">Statut</CardTitle>
                <CardDescription>
                  Trames générées en temps réel
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Status indicator */}
            <div className="flex items-center justify-between rounded-lg bg-secondary p-4">
              <div className="flex items-center gap-3">
                <div
                  className={`h-3 w-3 rounded-full ${
                    status.running ? "animate-pulse bg-success" : "bg-muted-foreground"
                  }`}
                />
                <span className="font-medium text-foreground">
                  {status.running ? "Génération active" : "En attente"}
                </span>
              </div>
              <span className="text-2xl font-bold text-primary">
                {frameCount.toLocaleString()}
              </span>
            </div>

            {/* Last frame */}
            <div className="space-y-2">
              <Label className="text-muted-foreground">Dernière trame générée</Label>
              {lastFrame ? (
                <div className="rounded-lg bg-terminal p-4 font-mono">
                  <div className="flex items-center gap-4">
                    <span className="text-primary">0x{lastFrame.id}</span>
                    <span className="text-muted-foreground">#</span>
                    <span className="text-terminal-foreground">{lastFrame.data}</span>
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-border p-4 text-center">
                  <p className="text-sm text-muted-foreground">
                    Démarrez le générateur pour voir les trames
                  </p>
                </div>
              )}
            </div>

            {/* Stats */}
            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-lg bg-secondary p-3 text-center">
                <p className="text-2xl font-bold text-foreground">
                  {Math.round(1000 / (parseInt(delay) || 100))}
                </p>
                <p className="text-xs text-muted-foreground">trames/sec</p>
              </div>
              <div className="rounded-lg bg-secondary p-3 text-center">
                <p className="text-2xl font-bold text-foreground">{delay}</p>
                <p className="text-xs text-muted-foreground">ms intervalle</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  )
}
