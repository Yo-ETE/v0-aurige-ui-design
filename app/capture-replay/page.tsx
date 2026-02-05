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
  AlertCircle, Loader2, CheckCircle2, ArrowLeft, FlaskConical, Pencil,
  ChevronRight, FolderTree
} from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { 
  startCapture, stopCapture, getCaptureStatus, type CANInterface, 
  listMissionLogs, deleteLog, renameLog, getLogDownloadUrl, getLogFamilyDownloadUrl,
  startReplay, stopReplay, getReplayStatus,
  type LogEntry, type CaptureStatus, type ProcessStatus
} from "@/lib/api"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useMissionStore } from "@/lib/mission-store"
import { useIsolationStore } from "@/lib/isolation-store"
import { LogImportButton } from "@/components/log-import-button"

export default function CaptureReplay() {
  const router = useRouter()
  const storeMissionId = useMissionStore((state) => state.currentMissionId)
  const missions = useMissionStore((state) => state.missions)
  const importLogToIsolation = useIsolationStore((state) => state.importLog)
  
  // Use localStorage as primary source (persists across page reloads)
  const [missionId, setMissionId] = useState<string>("")
  
  useEffect(() => {
    // Read from localStorage first (most reliable)
    const localId = localStorage.getItem("activeMissionId")
    if (localId) {
      setMissionId(localId)
    } else if (storeMissionId) {
      setMissionId(storeMissionId)
    }
  }, [storeMissionId])
  
  const currentMission = missions.find((m) => m.id === missionId)
  
  const [canInterface, setCanInterface] = useState<CANInterface>("can0")
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus>({ running: false, durationSeconds: 0 })
  const [replayStatus, setReplayStatus] = useState<ProcessStatus>({ running: false })
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [captureDescription, setCaptureDescription] = useState("")
  const [replayingLogId, setReplayingLogId] = useState<string | null>(null)
  const [renamingLogId, setRenamingLogId] = useState<string | null>(null)
  const [newLogName, setNewLogName] = useState("")
  
  // Timer for capture duration display
  const [displayDuration, setDisplayDuration] = useState(0)
  
  // Countdown before capture
  const [countdownSeconds, setCountdownSeconds] = useState(3) // Default 3 seconds
  const [isCountingDown, setIsCountingDown] = useState(false)
  const [currentCountdown, setCurrentCountdown] = useState(0)

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

  const startCaptureWithCountdown = async () => {
    if (!missionId) {
      setError("Aucune mission selectionnee. Selectionnez une mission depuis le tableau de bord.")
      return
    }
    
    setError(null)
    setSuccess(null)
    
    // Start countdown
    if (countdownSeconds > 0) {
      setIsCountingDown(true)
      setCurrentCountdown(countdownSeconds)
      
      for (let i = countdownSeconds; i > 0; i--) {
        setCurrentCountdown(i)
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
      
      setIsCountingDown(false)
      setCurrentCountdown(0)
    }
    
    // Actually start capture
    try {
      const result = await startCapture(missionId, canInterface, undefined, captureDescription || undefined)
      setSuccess(`Capture demarree: ${result.filename}`)
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
      await startReplay(missionId, logId, canInterface)
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
    if (!confirm("Supprimer ce log ?")) return
    try {
      await deleteLog(missionId, logId)
      await fetchLogs()
    } catch {
      setError("Erreur lors de la suppression")
    }
  }

  const handleRenameLog = async (logId: string) => {
    if (!newLogName.trim()) return
    try {
      await renameLog(missionId, logId, newLogName.trim())
      setRenamingLogId(null)
      setNewLogName("")
      await fetchLogs()
      setSuccess("Log renomme avec succes")
    } catch {
      setError("Erreur lors du renommage")
    }
  }

  const startRenaming = (log: LogEntry) => {
    setRenamingLogId(log.id)
    setNewLogName(log.filename.replace(".log", ""))
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

        {/* Interface Selector */}
        <Card className="lg:col-span-2 border-border bg-card">
          <CardContent className="py-4">
            <div className="flex items-center gap-4">
              <Label htmlFor="can-interface" className="whitespace-nowrap">Interface CAN:</Label>
              <Select
                value={canInterface}
                onValueChange={(v) => setCanInterface(v as CANInterface)}
                disabled={captureStatus.running || replayStatus.running}
              >
                <SelectTrigger id="can-interface" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="can0">can0</SelectItem>
                  <SelectItem value="can1">can1</SelectItem>
                  <SelectItem value="vcan0">vcan0 (test)</SelectItem>
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground">
                Capture et replay sur cette interface
              </span>
            </div>
          </CardContent>
        </Card>

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
            ) : isCountingDown ? (
              <div className="flex flex-col items-center justify-center py-6">
                <p className="text-sm text-muted-foreground mb-2">Demarrage dans...</p>
                <span className="text-6xl font-mono font-bold text-primary animate-pulse">
                  {currentCountdown}
                </span>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="description">Description (optionnel)</Label>
                  <Input
                    id="description"
                    placeholder="Ex: Ouverture porte conducteur"
                    value={captureDescription}
                    onChange={(e) => setCaptureDescription(e.target.value)}
                  />
                </div>
                <div className="flex items-center gap-3">
                  <Label htmlFor="countdown" className="whitespace-nowrap text-sm">Decompte:</Label>
                  <Select value={String(countdownSeconds)} onValueChange={(v) => setCountdownSeconds(Number(v))}>
                    <SelectTrigger id="countdown" className="w-24">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">Aucun</SelectItem>
                      <SelectItem value="3">3 sec</SelectItem>
                      <SelectItem value="5">5 sec</SelectItem>
                      <SelectItem value="10">10 sec</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            <div className="flex gap-3">
              <Button
                onClick={startCaptureWithCountdown}
                disabled={captureStatus.running || !missionId || isCountingDown}
                className="flex-1 gap-2"
              >
                <Circle className="h-4 w-4" />
                {isCountingDown ? "Preparation..." : "Demarrer capture"}
              </Button>
              <Button
                variant="destructive"
                onClick={handleStopCapture}
                disabled={!captureStatus.running}
                className="flex-1 gap-2"
              >
                <Square className="h-4 w-4" />
                Arreter
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
<div className="flex items-center justify-between w-full">
    <div className="flex items-center gap-3">
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
        <FolderOpen className="h-5 w-5 text-primary" />
      </div>
      <div>
        <CardTitle className="text-lg">Logs de la mission</CardTitle>
        <CardDescription>
          Fichiers de capture enregistres
        </CardDescription>
      </div>
    </div>
    <LogImportButton 
      missionId={missionId} 
      onImportSuccess={() => loadLogs()} 
      size="sm"
    />
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
              <ScrollArea className="h-80">
                <div className="space-y-2 pr-4">
                  {(() => {
                    // Group logs by family (origin logs with their children)
                    // A log is a "root" if it has no parent OR its parent doesn't exist in the list
                    const logIds = new Set(logs.map(l => l.id))
                    const originLogs = logs.filter(l => !l.parentId || !logIds.has(l.parentId))
                    const childrenMap = new Map<string, LogEntry[]>()
                    
                    logs.forEach(l => {
                      if (l.parentId) {
                        const children = childrenMap.get(l.parentId) || []
                        children.push(l)
                        childrenMap.set(l.parentId, children)
                      }
                    })
                    
                    // Recursively get all descendants
                    const getAllDescendants = (logId: string): LogEntry[] => {
                      const directChildren = childrenMap.get(logId) || []
                      const allDescendants: LogEntry[] = [...directChildren]
                      directChildren.forEach(child => {
                        allDescendants.push(...getAllDescendants(child.id))
                      })
                      return allDescendants
                    }

                    // Render a single log item
                    const renderLogItem = (log: LogEntry, isChild = false, depth = 0) => (
                      <div
                        key={log.id}
                        className={`flex items-center justify-between rounded-lg border border-border p-2 ${
                          isChild ? "bg-background/50 ml-4" : "bg-secondary/50"
                        }`}
                        style={isChild ? { marginLeft: `${depth * 16}px` } : undefined}
                      >
                        <div className="min-w-0 flex-1">
                          {renamingLogId === log.id ? (
                            <div className="flex items-center gap-2">
                              <Input
                                value={newLogName}
                                onChange={(e) => setNewLogName(e.target.value)}
                                className="h-7 text-sm font-mono"
                                autoFocus
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") handleRenameLog(log.id)
                                  if (e.key === "Escape") setRenamingLogId(null)
                                }}
                              />
                              <Button size="sm" variant="ghost" onClick={() => handleRenameLog(log.id)}>OK</Button>
                              <Button size="sm" variant="ghost" onClick={() => setRenamingLogId(null)}>X</Button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2">
                              {isChild && <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />}
                              <p className="truncate font-mono text-sm text-foreground">
                                {log.filename}
                              </p>
                            </div>
                          )}
                          <p className="text-xs text-muted-foreground">
                            {log.framesCount.toLocaleString()} trames • {formatFileSize(log.size)}
                            {log.durationSeconds && ` • ${formatTime(log.durationSeconds)}`}
                          </p>
                        </div>
                        <div className="ml-2 flex items-center gap-1 shrink-0">
                          {replayStatus.running && replayingLogId === log.id ? (
                            <Button 
                              size="icon" 
                              variant="ghost" 
                              className="h-7 w-7 text-destructive"
                              onClick={handleStopReplay}
                            >
                              <Square className="h-3 w-3" />
                            </Button>
                          ) : (
                            <Button 
                              size="icon" 
                              variant="ghost" 
                              className="h-7 w-7"
                              onClick={() => handleReplay(log.id)}
                              disabled={replayStatus.running || captureStatus.running}
                              title="Rejouer"
                            >
                              <Play className="h-3 w-3" />
                            </Button>
                          )}
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            title="Renommer"
                            onClick={() => startRenaming(log)}
                          >
                            <Pencil className="h-3 w-3" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            title="Isolation"
                            onClick={() => {
                              importLogToIsolation({
                                id: log.id,
                                name: log.filename,
                                filename: log.filename,
                                missionId: missionId,
                                tags: ["original"],
                                frameCount: log.framesCount,
                              })
                              router.push("/isolation")
                            }}
                          >
                            <FlaskConical className="h-3 w-3" />
                          </Button>
                          <Button 
                            size="icon" 
                            variant="ghost" 
                            className="h-7 w-7"
                            title="Telecharger"
                            asChild
                          >
                            <a href={getLogDownloadUrl(missionId, log.id)} download={log.filename}>
                              <Download className="h-3 w-3" />
                            </a>
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-destructive hover:text-destructive"
                            title="Supprimer"
                            onClick={() => handleDeleteLog(log.id)}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                    )
                    
                    return originLogs.map((originLog) => {
                      const family = getAllDescendants(originLog.id)
                      const hasFamily = family.length > 0
                      
                      return (
                        <div key={originLog.id} className="rounded-lg border border-border">
                          {/* Origin log header */}
                          <div className="p-2 sm:p-3 bg-secondary/50">
                            {/* Info section */}
                            <div className="flex items-start gap-2 mb-2">
                              {hasFamily && <FolderTree className="h-4 w-4 text-primary shrink-0 mt-0.5" />}
                              <div className="min-w-0 flex-1">
                                {renamingLogId === originLog.id ? (
                                  <div className="flex items-center gap-2">
                                    <Input
                                      value={newLogName}
                                      onChange={(e) => setNewLogName(e.target.value)}
                                      className="h-7 text-sm font-mono"
                                      autoFocus
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") handleRenameLog(originLog.id)
                                        if (e.key === "Escape") setRenamingLogId(null)
                                      }}
                                    />
                                    <Button size="sm" variant="ghost" onClick={() => handleRenameLog(originLog.id)}>OK</Button>
                                    <Button size="sm" variant="ghost" onClick={() => setRenamingLogId(null)}>X</Button>
                                  </div>
                                ) : (
                                  <p className="font-mono text-xs sm:text-sm text-foreground break-all">
                                    {originLog.filename}
                                  </p>
                                )}
                                <p className="text-xs text-muted-foreground">
                                  {new Date(originLog.createdAt).toLocaleString("fr-FR")} - {originLog.framesCount.toLocaleString()} trames
                                  {hasFamily && ` - ${family.length} div.`}
                                </p>
                              </div>
                            </div>
                            {/* Buttons row - always visible */}
                            <div className="flex items-center gap-1 flex-wrap">
                              {replayStatus.running && replayingLogId === originLog.id ? (
                                <Button size="sm" variant="ghost" className="h-7 px-2 text-destructive gap-1" onClick={handleStopReplay}>
                                  <Square className="h-3 w-3" />
                                  <span className="text-xs">Stop</span>
                                </Button>
                              ) : (
                                <Button size="sm" variant="ghost" className="h-7 px-2 gap-1" onClick={() => handleReplay(originLog.id)} disabled={replayStatus.running || captureStatus.running} title="Rejouer">
                                  <Play className="h-3 w-3" />
                                  <span className="text-xs hidden sm:inline">Rejouer</span>
                                </Button>
                              )}
                              <Button size="sm" variant="ghost" className="h-7 px-2 gap-1" title="Renommer" onClick={() => startRenaming(originLog)}>
                                <Pencil className="h-3 w-3" />
                                <span className="text-xs hidden sm:inline">Renommer</span>
                              </Button>
                              <Button size="sm" variant="ghost" className="h-7 px-2 gap-1" title="Isolation" onClick={() => {
                                importLogToIsolation({ id: originLog.id, name: originLog.filename, filename: originLog.filename, missionId, tags: ["original"], frameCount: originLog.framesCount })
                                router.push("/isolation")
                              }}>
                                <FlaskConical className="h-3 w-3" />
                                <span className="text-xs hidden sm:inline">Isolation</span>
                              </Button>
                              {hasFamily ? (
                                <Button size="sm" variant="ghost" className="h-7 px-2 gap-1" title="Telecharger ZIP" asChild>
                                  <a href={getLogFamilyDownloadUrl(missionId, originLog.id)} download>
                                    <Download className="h-3 w-3" />
                                    <span className="text-xs hidden sm:inline">ZIP</span>
                                  </a>
                                </Button>
                              ) : (
                                <Button size="sm" variant="ghost" className="h-7 px-2 gap-1" title="Telecharger" asChild>
                                  <a href={getLogDownloadUrl(missionId, originLog.id)} download={originLog.filename}>
                                    <Download className="h-3 w-3" />
                                  </a>
                                </Button>
                              )}
                              <Button size="sm" variant="ghost" className="h-7 px-2 gap-1 text-destructive hover:text-destructive" title="Supprimer" onClick={() => handleDeleteLog(originLog.id)}>
                                <Trash2 className="h-3 w-3" />
                                <span className="text-xs hidden sm:inline">Suppr.</span>
                              </Button>
                            </div>
                          </div>
                          
                          {/* Children (splits) */}
                          {hasFamily && (
                            <div className="border-t border-border bg-background/50 p-2 space-y-1">
                              {family.map((child) => {
                                const depth = (child.id.match(/_[aAbB]/g) || []).length
                                return renderLogItem(child, true, depth)
                              })}
                            </div>
                          )}
                        </div>
                      )
                    })
                  })()}
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  )
}
