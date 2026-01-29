"use client"

import { useState, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import { AppShell } from "@/components/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { 
  Video, FolderOpen, Play, Trash2, Download, Circle, Square, FileText, 
  AlertCircle, Loader2, CheckCircle2, ArrowLeft
} from "lucide-react"
import { 
  startCapture, stopCapture, getCaptureStatus, 
  listMissionLogs, deleteLog, getLogDownloadUrl,
  startReplay, stopReplay, getReplayStatus,
  type LogEntry, type CaptureStatus, type ProcessStatus
} from "@/lib/api"
import { useMissionStore } from "@/lib/mission-store"

export default function CaptureReplay() {
  const router = useRouter()
  const currentMissionId = useMissionStore((state) => state.currentMissionId)
  const missions = useMissionStore((state) => state.missions)
  const currentMission = missions.find((m) => m.id === currentMissionId)
  const missionId = currentMissionId || ""
  
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus>({ running: false, durationSeconds: 0 })
  const [replayStatus, setReplayStatus] = useState<ProcessStatus>({ running: false })
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [captureDescription, setCaptureDescription] = useState("")
  const [replayingLogId, setReplayingLogId] = useState<string | null>(null)
  
  // Timer for capture duration display
  const [displayDuration, setDisplayDuration] = useState(0)

  // Fetch statuses
  const fetchStatuses = useCallback(async () => {
    try {
      const [capture, replay] = await Promise.all([
        getCaptureStatus(),
        getReplayStatus(),
      ])
      setCaptureStatus(capture)
      setReplayStatus(replay)
      if (capture.running) {
        setDisplayDuration(capture.durationSeconds)
      }
    } catch (err) {
      // API might not be available - use defaults
    }
  }, [])

  // Fetch logs for mission
  const fetchLogs = useCallback(async () => {
    if (!missionId) return
    try {
      const missionLogs = await listMissionLogs(missionId)
      setLogs(missionLogs)
    } catch (err) {
      // Mission might not exist
      setLogs([])
    }
  }, [missionId])

  useEffect(() => {
    const init = async () => {
      setIsLoading(true)
      await Promise.all([fetchStatuses(), fetchLogs()])
      setIsLoading(false)
    }
    init()
    
    // Poll statuses
    const interval = setInterval(fetchStatuses, 2000)
    return () => clearInterval(interval)
  }, [fetchStatuses, fetchLogs])

  // Update duration timer when capturing
  useEffect(() => {
    if (!captureStatus.running) return
    
    const interval = setInterval(() => {
      setDisplayDuration(prev => prev + 1)
    }, 1000)
    
    return () => clearInterval(interval)
  }, [captureStatus.running])

  const handleStartCapture = async () => {
    if (!missionId) {
      setError("Aucune mission sélectionnée. Sélectionnez une mission depuis le tableau de bord.")
      return
    }
    
    setError(null)
    setSuccess(null)
    
    try {
      const result = await startCapture(missionId, "can0", undefined, captureDescription || undefined)
      setSuccess(`Capture démarrée: ${result.filename}`)
      setDisplayDuration(0)
      setCaptureDescription("")
      await fetchStatuses()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur lors du démarrage de la capture")
    }
  }

  const handleStopCapture = async () => {
    setError(null)
    setSuccess(null)
    
    try {
      const result = await stopCapture()
      setSuccess(`Capture arrêtée: ${result.filename} (${result.durationSeconds}s)`)
      await Promise.all([fetchStatuses(), fetchLogs()])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur lors de l'arrêt de la capture")
    }
  }

  const handleReplay = async (logId: string) => {
    if (!missionId) return
    
    setError(null)
    setSuccess(null)
    
    try {
      await startReplay(missionId, logId, "can0")
      setReplayingLogId(logId)
      setSuccess("Replay démarré")
      await fetchStatuses()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur lors du replay")
    }
  }

  const handleStopReplay = async () => {
    setError(null)
    
    try {
      await stopReplay()
      setReplayingLogId(null)
      setSuccess("Replay arrêté")
      await fetchStatuses()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur lors de l'arrêt du replay")
    }
  }

  const handleDeleteLog = async (logId: string) => {
    if (!missionId) return
    if (!confirm("Supprimer ce log ?")) return
    
    setError(null)
    
    try {
      await deleteLog(missionId, logId)
      await fetchLogs()
      setSuccess("Log supprimé")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur lors de la suppression")
    }
  }

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
  }

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  if (isLoading) {
    return (
      <AppShell title="Capture & Replay" description="Chargement...">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </AppShell>
    )
  }

  // No mission selected - show helpful message
  if (!missionId) {
    return (
      <AppShell title="Capture & Replay" description="Aucune mission selectionnee">
        <Card className="bg-card border-border">
          <CardContent className="flex flex-col items-center justify-center py-16">
            <FolderOpen className="h-16 w-16 text-muted-foreground/30 mb-4" />
            <h2 className="text-xl font-semibold text-foreground mb-2">
              Aucune mission selectionnee
            </h2>
            <p className="text-muted-foreground text-center max-w-md mb-6">
              Vous devez d'abord selectionner ou creer une mission pour pouvoir capturer et rejouer des logs CAN.
            </p>
            <Button onClick={() => router.push("/")} className="gap-2">
              <ArrowLeft className="h-4 w-4" />
              Retour a l'accueil
            </Button>
          </CardContent>
        </Card>
      </AppShell>
    )
  }

  return (
    <AppShell
      title="Capture & Replay"
      description={currentMission ? `Mission: ${currentMission.name}` : "Capturer et rejouer des logs CAN"}
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

        {/* Mission warning */}
        {!missionId && (
          <div className="lg:col-span-2">
            <Alert className="border-warning/50 bg-warning/10">
              <AlertCircle className="h-4 w-4 text-warning" />
              <AlertDescription className="text-warning">
                Aucune mission sélectionnée. Les captures nécessitent une mission active.
              </AlertDescription>
            </Alert>
          </div>
        )}

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
            {captureStatus.running ? (
              <div className="flex items-center justify-center gap-4 rounded-lg bg-destructive/10 py-6">
                <div className="relative">
                  <Circle className="h-4 w-4 animate-pulse fill-destructive text-destructive" />
                </div>
                <span className="text-2xl font-mono font-semibold text-destructive">
                  {formatTime(displayDuration)}
                </span>
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="description">Description (optionnel)</Label>
                <Input
                  id="description"
                  placeholder="Ex: Ouverture porte conducteur"
                  value={captureDescription}
                  onChange={(e) => setCaptureDescription(e.target.value)}
                />
              </div>
            )}

            <div className="flex gap-3">
              <Button
                onClick={handleStartCapture}
                disabled={captureStatus.running || !missionId}
                className="flex-1 gap-2"
              >
                <Circle className="h-4 w-4" />
                Démarrer capture
              </Button>
              <Button
                variant="destructive"
                onClick={handleStopCapture}
                disabled={!captureStatus.running}
                className="flex-1 gap-2"
              >
                <Square className="h-4 w-4" />
                Arrêter
              </Button>
            </div>

            <p className="text-xs text-muted-foreground">
              Les logs sont sauvegardés dans{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
                /opt/aurige/data/missions/{missionId || "<mission>"}/logs/
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
                <CardTitle className="text-lg">Logs de la mission</CardTitle>
                <CardDescription>
                  Fichiers de capture enregistrés
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
              <div className="space-y-3 max-h-80 overflow-y-auto">
                {logs.map((log) => (
                  <div
                    key={log.id}
                    className="flex items-center justify-between rounded-lg border border-border bg-secondary/50 p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-sm text-foreground">
                        {log.filename}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(log.createdAt).toLocaleString("fr-FR")} • {formatFileSize(log.size)} • {log.framesCount.toLocaleString()} trames
                        {log.durationSeconds && ` • ${formatTime(log.durationSeconds)}`}
                      </p>
                      {log.description && (
                        <p className="text-xs text-primary mt-1">{log.description}</p>
                      )}
                    </div>
                    <div className="ml-4 flex items-center gap-1">
                      {replayStatus.running && replayingLogId === log.id ? (
                        <Button 
                          size="icon" 
                          variant="ghost" 
                          className="h-8 w-8 text-destructive"
                          onClick={handleStopReplay}
                        >
                          <Square className="h-4 w-4" />
                        </Button>
                      ) : (
                        <Button 
                          size="icon" 
                          variant="ghost" 
                          className="h-8 w-8"
                          onClick={() => handleReplay(log.id)}
                          disabled={replayStatus.running || captureStatus.running}
                        >
                          <Play className="h-4 w-4" />
                        </Button>
                      )}
                      <Button 
                        size="icon" 
                        variant="ghost" 
                        className="h-8 w-8"
                        asChild
                      >
                        <a 
                          href={getLogDownloadUrl(missionId, log.id)} 
                          download={log.filename}
                        >
                          <Download className="h-4 w-4" />
                        </a>
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
      </div>
    </AppShell>
  )
}
