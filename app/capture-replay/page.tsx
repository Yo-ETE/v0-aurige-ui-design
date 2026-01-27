"use client"

import { useState } from "react"
import { AppShell } from "@/components/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Video, FolderOpen, Play, Trash2, Download, Circle, Square, FileText } from "lucide-react"

interface LogFile {
  id: string
  name: string
  date: string
  size: string
  frames: number
}

const mockLogs: LogFile[] = [
  { id: "1", name: "capture_2024-01-15_14-32-01.log", date: "15/01/2024 14:32", size: "2.4 MB", frames: 15420 },
  { id: "2", name: "capture_2024-01-15_10-15-33.log", date: "15/01/2024 10:15", size: "1.1 MB", frames: 7230 },
  { id: "3", name: "capture_2024-01-14_16-45-22.log", date: "14/01/2024 16:45", size: "3.8 MB", frames: 24100 },
]

export default function CaptureReplay() {
  const [isCapturing, setIsCapturing] = useState(false)
  const [captureTime, setCaptureTime] = useState(0)
  const [logs, setLogs] = useState<LogFile[]>(mockLogs)
  const [missionLogs] = useState<LogFile[]>([])

  const handleStartCapture = () => {
    setIsCapturing(true)
    const startTime = Date.now()
    const interval = setInterval(() => {
      setCaptureTime(Math.floor((Date.now() - startTime) / 1000))
    }, 1000)
    // Store interval ID for cleanup
    ;(window as unknown as { captureInterval: NodeJS.Timeout }).captureInterval = interval
  }

  const handleStopCapture = () => {
    setIsCapturing(false)
    clearInterval((window as unknown as { captureInterval: NodeJS.Timeout }).captureInterval)
    setCaptureTime(0)
    // Add new mock log
    const newLog: LogFile = {
      id: Date.now().toString(),
      name: `capture_${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.log`,
      date: new Date().toLocaleString("fr-FR"),
      size: `${(Math.random() * 3 + 0.5).toFixed(1)} MB`,
      frames: Math.floor(Math.random() * 20000 + 5000),
    }
    setLogs([newLog, ...logs])
  }

  const handleDeleteLog = (id: string) => {
    setLogs(logs.filter((log) => log.id !== id))
  }

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
  }

  return (
    <AppShell
      title="Capture & Replay"
      description="Capturer et rejouer des logs CAN"
    >
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Capture CAN Card */}
        <Card className="border-border bg-card">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <Video className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-lg">Capture CAN</CardTitle>
                <CardDescription>
                  Enregistrer toutes les trames CAN
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {isCapturing && (
              <div className="flex items-center justify-center gap-4 rounded-lg bg-destructive/10 py-6">
                <div className="relative">
                  <Circle className="h-4 w-4 animate-pulse fill-destructive text-destructive" />
                </div>
                <span className="text-2xl font-mono font-semibold text-destructive">
                  {formatTime(captureTime)}
                </span>
              </div>
            )}

            <div className="flex gap-3">
              <Button
                onClick={handleStartCapture}
                disabled={isCapturing}
                className="flex-1 gap-2"
              >
                <Circle className="h-4 w-4" />
                Démarrer capture
              </Button>
              <Button
                variant="destructive"
                onClick={handleStopCapture}
                disabled={!isCapturing}
                className="flex-1 gap-2"
              >
                <Square className="h-4 w-4" />
                Arrêter
              </Button>
            </div>

            <p className="text-xs text-muted-foreground">
              Les logs sont sauvegardés dans{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
                /var/aurige/logs/
              </code>
            </p>
          </CardContent>
        </Card>

        {/* Logs disponibles Card */}
        <Card className="border-border bg-card">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <FolderOpen className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-lg">Logs disponibles</CardTitle>
                <CardDescription>
                  Fichiers de capture récents
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {logs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <FileText className="mb-3 h-12 w-12 text-muted-foreground/50" />
                <p className="text-sm text-muted-foreground">
                  Aucun log disponible
                </p>
                <p className="text-xs text-muted-foreground">
                  Démarrez une capture pour créer un log
                </p>
              </div>
            ) : (
              <div className="space-y-3 max-h-64 overflow-y-auto">
                {logs.map((log) => (
                  <div
                    key={log.id}
                    className="flex items-center justify-between rounded-lg border border-border bg-secondary/50 p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-sm text-foreground">
                        {log.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {log.date} • {log.size} • {log.frames.toLocaleString()} trames
                      </p>
                    </div>
                    <div className="ml-4 flex items-center gap-1">
                      <Button size="icon" variant="ghost" className="h-8 w-8">
                        <Play className="h-4 w-4" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-8 w-8">
                        <Download className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        onClick={() => handleDeleteLog(log.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Logs de la mission Card */}
        <Card className="border-border bg-card lg:col-span-2">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <FileText className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-lg">Logs de la mission</CardTitle>
                <CardDescription>
                  Logs associés à la mission BMW Série 1
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {missionLogs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <FolderOpen className="mb-3 h-12 w-12 text-muted-foreground/50" />
                <p className="text-sm text-muted-foreground">
                  Aucun log associé à cette mission
                </p>
                <p className="text-xs text-muted-foreground">
                  Importez ou capturez des logs pour les ajouter à la mission
                </p>
                <Button variant="outline" className="mt-4 bg-transparent">
                  Importer un log
                </Button>
              </div>
            ) : (
              <div className="rounded-lg border border-border">
                {/* Table would go here */}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  )
}
