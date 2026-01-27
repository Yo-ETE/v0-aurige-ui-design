"use client"

import { useState } from "react"
import { AppShell } from "@/components/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Progress } from "@/components/ui/progress"
import { Flame, AlertTriangle, Play, Square } from "lucide-react"

export default function Fuzzing() {
  const [idStart, setIdStart] = useState("000")
  const [idEnd, setIdEnd] = useState("7FF")
  const [dataTemplate, setDataTemplate] = useState("0000000000000000")
  const [iterations, setIterations] = useState("100")
  const [delay, setDelay] = useState("10")
  const [isRunning, setIsRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [currentId, setCurrentId] = useState("")

  const handleStart = async () => {
    setIsRunning(true)
    setProgress(0)
    const totalIterations = Number.parseInt(iterations)
    const startId = Number.parseInt(idStart, 16)
    const endId = Number.parseInt(idEnd, 16)

    for (let i = 0; i < totalIterations; i++) {
      if (!isRunning) break
      const currentIdNum = startId + Math.floor(((endId - startId) * i) / totalIterations)
      setCurrentId(currentIdNum.toString(16).toUpperCase().padStart(3, "0"))
      setProgress(((i + 1) / totalIterations) * 100)
      await new Promise((resolve) => setTimeout(resolve, Number.parseInt(delay)))
    }
    setIsRunning(false)
  }

  const handleStop = () => {
    setIsRunning(false)
  }

  return (
    <AppShell
      title="Fuzzing"
      description="Test de fuzzing CAN pour découverte de vulnérabilités"
    >
      <div className="grid gap-6">
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
                  onChange={(e) => setIdStart(e.target.value)}
                  className="font-mono"
                  placeholder="000"
                  disabled={isRunning}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="id-end">ID End (hex)</Label>
                <Input
                  id="id-end"
                  value={idEnd}
                  onChange={(e) => setIdEnd(e.target.value)}
                  className="font-mono"
                  placeholder="7FF"
                  disabled={isRunning}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="data-template">Data Template (16 hex)</Label>
                <Input
                  id="data-template"
                  value={dataTemplate}
                  onChange={(e) => setDataTemplate(e.target.value)}
                  className="font-mono"
                  placeholder="0000000000000000"
                  maxLength={16}
                  disabled={isRunning}
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
                  disabled={isRunning}
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
                  disabled={isRunning}
                />
              </div>
              <div className="flex items-end gap-3">
                <Button
                  onClick={handleStart}
                  disabled={isRunning}
                  className="flex-1 gap-2"
                >
                  <Play className="h-4 w-4" />
                  Démarrer fuzzing
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
            </div>

            {isRunning && (
              <div className="space-y-3 rounded-lg bg-secondary p-4">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Progression</span>
                  <span className="font-mono text-foreground">
                    ID: <span className="text-primary">{currentId}</span>
                  </span>
                </div>
                <Progress value={progress} className="h-2" />
                <p className="text-xs text-muted-foreground text-right">
                  {Math.round(progress)}% complété
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  )
}
