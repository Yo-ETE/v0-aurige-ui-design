"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { AppShell } from "@/components/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  GitBranch,
  Play,
  FlaskConical,
  Trash2,
  FileText,
  ChevronRight,
  Info,
  FolderOpen,
  Import,
  ArrowLeft,
  Loader2,
  CheckCircle2,
} from "lucide-react"
import { useIsolationStore, type IsolationLog } from "@/lib/isolation-store"
import { listMissionLogs, startReplay, stopReplay, splitLog, type LogEntry } from "@/lib/api"
import { useMissionStore } from "@/lib/mission-store"

const steps = [
  { number: 1, title: "Capturer une action", description: "Enregistrez le trafic CAN pendant une action vehicule" },
  { number: 2, title: "Importer le log", description: "Importez le fichier de capture dans l'outil" },
  { number: 3, title: "Rejouer", description: "Rejouez le log complet et verifiez si l'action se reproduit" },
  { number: 4, title: "Diviser le log", description: "Coupez le log en deux et testez chaque partie" },
  { number: 5, title: "Iterer", description: "Repetez jusqu'a isoler la trame responsable" },
]

function LogTreeItem({
  item,
  depth = 0,
  onReplay,
  onSplit,
  onRemove,
  onTagChange,
  isReplaying,
}: {
  item: IsolationLog
  depth?: number
  onReplay: (log: IsolationLog) => void
  onSplit: (log: IsolationLog) => void
  onRemove: (logId: string) => void
  onTagChange: (logId: string, tag: "success" | "failed") => void
  isReplaying: string | null
  isSplitting: string | null
}) {
  const [isExpanded, setIsExpanded] = useState(true)
  const hasChildren = item.children && item.children.length > 0

  return (
    <div className="space-y-1">
      <div
        className="flex items-center gap-2 rounded-md border border-border bg-secondary/50 p-3 hover:bg-secondary"
        style={{ marginLeft: depth * 24 }}
      >
        {hasChildren ? (
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            onClick={() => setIsExpanded(!isExpanded)}
          >
            <ChevronRight className={`h-4 w-4 transition-transform ${isExpanded ? "rotate-90" : ""}`} />
          </Button>
        ) : (
          <div className="w-6" />
        )}
        <FileText className="h-4 w-4 text-muted-foreground" />
        <span className="flex-1 truncate font-mono text-sm">{item.name}</span>
        <div className="flex items-center gap-2">
          {item.tags.map((tag) => (
            <Badge
              key={tag}
              variant={tag === "success" ? "default" : tag === "failed" ? "destructive" : "secondary"}
              className={tag === "success" ? "bg-success text-success-foreground" : ""}
            >
              {tag}
            </Badge>
          ))}
          <div className="flex items-center gap-1 ml-2">
            {isReplaying === item.id ? (
              <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive">
                <Loader2 className="h-3 w-3 animate-spin" />
              </Button>
            ) : (
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={() => onReplay(item)}
                title="Rejouer"
              >
                <Play className="h-3 w-3" />
              </Button>
            )}
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-success hover:text-success"
              onClick={() => onTagChange(item.id, "success")}
              title="Marquer comme succes"
            >
              <CheckCircle2 className="h-3 w-3" />
            </Button>
            {isSplitting === item.id ? (
              <Button size="icon" variant="ghost" className="h-7 w-7">
                <Loader2 className="h-3 w-3 animate-spin" />
              </Button>
            ) : (
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={() => onSplit(item)}
                title="Diviser"
              >
                <FlaskConical className="h-3 w-3" />
              </Button>
            )}
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-destructive hover:text-destructive"
              onClick={() => onRemove(item.id)}
              title="Supprimer"
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </div>
      {hasChildren && isExpanded && (
        <div className="space-y-1">
          {item.children?.map((child) => (
            <LogTreeItem
              key={child.id}
              item={child}
              depth={depth + 1}
              onReplay={onReplay}
              onSplit={onSplit}
              onRemove={onRemove}
              onTagChange={onTagChange}
              isReplaying={isReplaying}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default function Isolation() {
  const router = useRouter()
  const { logs, importLog, addChildLog, removeLog, updateLogTags, clearLogs } = useIsolationStore()
  
  // Mission context
  const currentMissionId = useMissionStore((state) => state.currentMissionId)
  const missions = useMissionStore((state) => state.missions)
  
  const [missionId, setMissionId] = useState<string>("")
  const [missionLogs, setMissionLogs] = useState<LogEntry[]>([])
  const [isLoadingLogs, setIsLoadingLogs] = useState(false)
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [isReplaying, setIsReplaying] = useState<string | null>(null)
  
  // Get mission ID from localStorage
  useEffect(() => {
    const localId = localStorage.getItem("activeMissionId")
    if (localId) {
      setMissionId(localId)
    } else if (currentMissionId) {
      setMissionId(currentMissionId)
    }
  }, [currentMissionId])
  
  // Load mission logs when dialog opens
  const handleOpenImport = async () => {
    setShowImportDialog(true)
    if (!missionId) return
    
    setIsLoadingLogs(true)
    try {
      const fetchedLogs = await listMissionLogs(missionId)
      setMissionLogs(fetchedLogs)
    } catch {
      setMissionLogs([])
    } finally {
      setIsLoadingLogs(false)
    }
  }
  
  const handleImportLog = (log: LogEntry) => {
    importLog({
      id: log.id,
      name: log.filename,
      filename: log.filename,
      missionId: missionId,
      tags: ["original"],
      frameCount: log.frameCount,
    })
    setShowImportDialog(false)
  }
  
  const handleReplay = async (log: IsolationLog) => {
    setIsReplaying(log.id)
    try {
      await startReplay(log.missionId, log.id, "can0")
      // Auto-stop after a reasonable time or let user stop manually
      setTimeout(async () => {
        try {
          await stopReplay()
        } catch {
          // Ignore
        }
        setIsReplaying(null)
      }, 10000)
    } catch {
      setIsReplaying(null)
    }
  }
  
  const [isSplitting, setIsSplitting] = useState<string | null>(null)
  
  const handleSplit = async (log: IsolationLog) => {
    setIsSplitting(log.id)
    try {
      const result = await splitLog(log.missionId, log.id)
      
      // Add the two new child logs to the store
      addChildLog(log.id, {
        id: result.logAId,
        name: result.logAName,
        filename: result.logAName,
        missionId: log.missionId,
        tags: [],
        frameCount: result.logAFrames,
        parentId: log.id,
      })
      
      addChildLog(log.id, {
        id: result.logBId,
        name: result.logBName,
        filename: result.logBName,
        missionId: log.missionId,
        tags: [],
        frameCount: result.logBFrames,
        parentId: log.id,
      })
    } catch (err) {
      alert(err instanceof Error ? err.message : "Erreur lors de la division")
    } finally {
      setIsSplitting(null)
    }
  }
  
  const handleTagChange = (logId: string, tag: "success" | "failed") => {
    updateLogTags(logId, [tag])
  }
  
  const currentMission = missions.find((m) => m.id === missionId)

  return (
    <AppShell
      title="Isolation"
      description={currentMission ? `Mission: ${currentMission.name}` : "Isoler une trame CAN responsable d'une action"}
    >
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Instructions Card */}
        <Card className="border-border bg-card lg:col-span-1">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <Info className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-lg">Instructions</CardTitle>
                <CardDescription>
                  Methode d&apos;isolation binaire
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {steps.map((step) => (
                <div key={step.number} className="flex gap-3">
                  <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                    {step.number}
                  </div>
                  <div>
                    <p className="font-medium text-foreground">{step.title}</p>
                    <p className="text-xs text-muted-foreground">{step.description}</p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Log Tree Card */}
        <Card className="border-border bg-card lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                  <GitBranch className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <CardTitle className="text-lg">Arbre de logs</CardTitle>
                  <CardDescription>
                    Logs et sous-divisions pour l&apos;isolation
                  </CardDescription>
                </div>
              </div>
              <div className="flex gap-2">
                {logs.length > 0 && (
                  <Button variant="outline" size="sm" onClick={clearLogs}>
                    Vider
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={handleOpenImport}>
                  <Import className="h-4 w-4 mr-2" />
                  Importer un log
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {!missionId ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <FolderOpen className="mb-3 h-12 w-12 text-muted-foreground/50" />
                <p className="text-sm text-muted-foreground mb-4">
                  Aucune mission selectionnee
                </p>
                <Button onClick={() => router.push("/")} variant="outline" size="sm">
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  Retour a l&apos;accueil
                </Button>
              </div>
            ) : logs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <GitBranch className="mb-3 h-12 w-12 text-muted-foreground/50" />
                <p className="text-sm text-muted-foreground">
                  Aucun log importe
                </p>
                <p className="text-xs text-muted-foreground mb-4">
                  Importez un log pour commencer l&apos;isolation
                </p>
                <Button onClick={handleOpenImport} variant="outline" size="sm">
                  <Import className="h-4 w-4 mr-2" />
                  Importer un log
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                {logs.map((log) => (
                  <LogTreeItem
                    key={log.id}
                    item={log}
                    onReplay={handleReplay}
                    onSplit={handleSplit}
                    onRemove={removeLog}
                    onTagChange={handleTagChange}
                    isReplaying={isReplaying}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Import Dialog */}
      <Dialog open={showImportDialog} onOpenChange={setShowImportDialog}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Importer un log</DialogTitle>
            <DialogDescription>
              Selectionnez un log de la mission a importer pour l&apos;isolation
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4">
            {isLoadingLogs ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
            ) : missionLogs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <FileText className="mb-3 h-10 w-10 text-muted-foreground/50" />
                <p className="text-sm text-muted-foreground">
                  Aucun log dans cette mission
                </p>
                <p className="text-xs text-muted-foreground">
                  Effectuez d&apos;abord une capture dans Capture & Replay
                </p>
              </div>
            ) : (
              <div className="space-y-2 max-h-80 overflow-y-auto">
                {missionLogs.map((log) => {
                  const isImported = logs.some((l) => l.id === log.id)
                  return (
                    <div
                      key={log.id}
                      className={`flex items-center justify-between rounded-lg border border-border p-3 ${
                        isImported ? "bg-muted/50 opacity-60" : "bg-secondary/50 hover:bg-secondary cursor-pointer"
                      }`}
                      onClick={() => !isImported && handleImportLog(log)}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-sm text-foreground">
                          {log.filename}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {log.frameCount ? `${log.frameCount} trames` : ""}
                          {log.description && ` - ${log.description}`}
                        </p>
                      </div>
                      {isImported ? (
                        <Badge variant="secondary">Importe</Badge>
                      ) : (
                        <Button size="sm" variant="outline">
                          <Import className="h-4 w-4 mr-2" />
                          Importer
                        </Button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </AppShell>
  )
}
