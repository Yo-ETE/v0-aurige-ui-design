"use client"

import { useState, useEffect } from "react"
import { AppShell } from "@/components/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Cpu, Play, Square, Shuffle } from "lucide-react"

export default function Generateur() {
  const [canId, setCanId] = useState("")
  const [useRandomId, setUseRandomId] = useState(true)
  const [frameLength, setFrameLength] = useState("8")
  const [delay, setDelay] = useState("100")
  const [isRunning, setIsRunning] = useState(false)
  const [frameCount, setFrameCount] = useState(0)
  const [lastFrame, setLastFrame] = useState<{ id: string; data: string } | null>(null)

  useEffect(() => {
    if (!isRunning) return

    const interval = setInterval(() => {
      const id = useRandomId
        ? Math.floor(Math.random() * 0x7ff).toString(16).toUpperCase().padStart(3, "0")
        : canId || "7DF"
      const length = Number.parseInt(frameLength) || 8
      const data = Array.from({ length }, () =>
        Math.floor(Math.random() * 256).toString(16).toUpperCase().padStart(2, "0")
      ).join("")

      setLastFrame({ id, data })
      setFrameCount((prev) => prev + 1)
    }, Number.parseInt(delay) || 100)

    return () => clearInterval(interval)
  }, [isRunning, useRandomId, canId, frameLength, delay])

  const handleStart = () => {
    setIsRunning(true)
    setFrameCount(0)
  }

  const handleStop = () => {
    setIsRunning(false)
  }

  return (
    <AppShell
      title="Générateur"
      description="Génération de trames CAN aléatoires"
    >
      <div className="grid gap-6 lg:grid-cols-2">
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
                  disabled={isRunning}
                />
              </div>

              {!useRandomId && (
                <div className="space-y-2">
                  <Label htmlFor="can-id">CAN ID (hex)</Label>
                  <Input
                    id="can-id"
                    value={canId}
                    onChange={(e) => setCanId(e.target.value)}
                    className="font-mono"
                    placeholder="7DF"
                    disabled={isRunning}
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
                  disabled={isRunning}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="gen-delay">Intervalle (ms)</Label>
                <Input
                  id="gen-delay"
                  type="number"
                  value={delay}
                  onChange={(e) => setDelay(e.target.value)}
                  disabled={isRunning}
                />
              </div>
            </div>

            <div className="flex gap-3">
              <Button
                onClick={handleStart}
                disabled={isRunning}
                className="flex-1 gap-2"
              >
                <Play className="h-4 w-4" />
                Démarrer
              </Button>
              <Button
                onClick={handleStop}
                disabled={!isRunning}
                variant="destructive"
                className="flex-1 gap-2"
              >
                <Square className="h-4 w-4" />
                Arrêter
              </Button>
            </div>
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
                    isRunning ? "animate-pulse bg-success" : "bg-muted-foreground"
                  }`}
                />
                <span className="font-medium text-foreground">
                  {isRunning ? "Génération active" : "En attente"}
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
                    <span className="text-primary">{lastFrame.id}</span>
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
                  {Math.round(1000 / (Number.parseInt(delay) || 100))}
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
