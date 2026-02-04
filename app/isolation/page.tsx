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
  ChevronDown,
  Info,
  FolderOpen,
  Import,
  ArrowLeft,
  Loader2,
  CheckCircle2,
  Pencil,
  Eye,
  X,
  Send,
  Download,
  FolderTree,
} from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useIsolationStore, type IsolationLog } from "@/lib/isolation-store"
import { useExportStore } from "@/lib/export-store"
import { listMissionLogs, startReplay, stopReplay, getReplayStatus, splitLog, renameLog, deleteLog, getLogContent, getLogDownloadUrl, getLogFamilyDownloadUrl, type LogEntry, type CANInterface, type LogFrame } from "@/lib/api"
import { useRouter as useNavRouter } from "next/navigation"
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
  onRename,
  onView,
  isReplaying,
  isSplitting,
  renamingLog,
  newLogName,
  setNewLogName,
  setRenamingLog,
}: {
  item: IsolationLog
  depth?: number
  onReplay: (log: IsolationLog) => void
  onSplit: (log: IsolationLog) => void
  onRemove: (logId: string) => void
  onTagChange: (logId: string, tag: "success" | "failed") => void
  onRename: (log: IsolationLog) => void
  onView: (log: IsolationLog) => void
  isReplaying: string | null
  isSplitting: string | null
  renamingLog: string | null
  newLogName: string
  setNewLogName: (name: string) => void
  setRenamingLog: (id: string | null) => void
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
        {renamingLog === item.id ? (
          <div className="flex-1 flex items-center gap-2">
            <Input
              value={newLogName}
              onChange={(e) => setNewLogName(e.target.value)}
              className="h-7 text-sm"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") onRename(item)
                if (e.key === "Escape") setRenamingLog(null)
              }}
            />
            <Button size="sm" variant="ghost" onClick={() => onRename(item)}>OK</Button>
            <Button size="sm" variant="ghost" onClick={() => setRenamingLog(null)}>Annuler</Button>
          </div>
        ) : (
          <span className="flex-1 truncate font-mono text-sm">{item.name}</span>
        )}
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
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={() => onView(item)}
              title="Voir les trames"
            >
              <Eye className="h-3 w-3" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={() => {
                setRenamingLog(item.id)
                setNewLogName(item.name.replace(".log", ""))
              }}
              title="Renommer"
            >
              <Pencil className="h-3 w-3" />
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
              onRename={onRename}
              onView={onView}
              isReplaying={isReplaying}
              isSplitting={isSplitting}
              renamingLog={renamingLog}
              newLogName={newLogName}
              setNewLogName={setNewLogName}
              setRenamingLog={setRenamingLog}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default function Isolation() {
  const router = useRouter()
  const navRouter = useNavRouter()
  const { logs, importLog, addChildLog, removeLog, updateLogTags, updateLogName, clearLogs, setMission, findLog } = useIsolationStore()
  const { addFrames } = useExportStore()
  
  // Mission context
  const currentMissionId = useMissionStore((state) => state.currentMissionId)
  const missions = useMissionStore((state) => state.missions)
  
  const [canInterface, setCanInterface] = useState<CANInterface>("can0")
  const [missionId, setMissionId] = useState<string>("")
  const [missionLogs, setMissionLogs] = useState<LogEntry[]>([])
  const [isLoadingLogs, setIsLoadingLogs] = useState(false)
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [isReplaying, setIsReplaying] = useState<string | null>(null)
  const [renamingLog, setRenamingLog] = useState<string | null>(null)
  const [newLogName, setNewLogName] = useState("")
  const [importMissionId, setImportMissionId] = useState<string>("")
  
  // Log viewer state
  const [viewingLog, setViewingLog] = useState<IsolationLog | null>(null)
  const [logFrames, setLogFrames] = useState<LogFrame[]>([])
  const [isLoadingFrames, setIsLoadingFrames] = useState(false)
  const [totalFrames, setTotalFrames] = useState(0)
  
  // Get mission ID from localStorage and sync with store
  useEffect(() => {
    const localId = localStorage.getItem("activeMissionId")
    const effectiveMissionId = localId || currentMissionId
    
    if (effectiveMissionId) {
      setMissionId(effectiveMissionId)
      // Sync isolation store with current mission - clears logs if mission changed
      setMission(effectiveMissionId)
    }
  }, [currentMissionId, setMission])
  
  // Load mission logs when dialog opens
  const handleOpenImport = async () => {
    setShowImportDialog(true)
    setImportMissionId(missionId) // Default to current mission
    if (!missionId) return
    await loadMissionLogs(missionId)
  }

  // Load logs for a specific mission
  const loadMissionLogs = async (targetMissionId: string) => {
    if (!targetMissionId) return
    setIsLoadingLogs(true)
    try {
      const fetchedLogs = await listMissionLogs(targetMissionId)
      setMissionLogs(fetchedLogs)
    } catch {
      setMissionLogs([])
    } finally {
      setIsLoadingLogs(false)
    }
  }

  // Handle mission change in import dialog
  const handleImportMissionChange = async (newMissionId: string) => {
    setImportMissionId(newMissionId)
    await loadMissionLogs(newMissionId)
  }
  
  const handleImportLog = (log: LogEntry, closeDialog = true) => {
    const newLog: IsolationLog = {
      id: log.id,
      name: log.filename,
      filename: log.filename,
      missionId: importMissionId,
      tags: log.parentId ? [] : ["original"],  // Only mark as original if no parent
      frameCount: log.framesCount,
    }
    
    // Check if parent is already imported
    if (log.parentId) {
      const parentLog = findLog(log.parentId)
      if (parentLog) {
        // Add as child of existing parent
        addChildLog(log.parentId, newLog)
        if (closeDialog) setShowImportDialog(false)
        return
      }
    }
    
    // Import as root log
    importLog(newLog)
    if (closeDialog) setShowImportDialog(false)
  }
  
  // Import a family of logs (parent + all children)
  const handleImportFamily = (originLog: LogEntry, family: LogEntry[]) => {
    // First import the origin if not already imported
    if (!logs.some(l => l.id === originLog.id)) {
      handleImportLog(originLog, false)
    }
    
    // Sort family by depth (shallow first) so parents are imported before children
    const sortedFamily = [...family].sort((a, b) => {
      const depthA = (a.id.match(/_[aAbB]/g) || []).length
      const depthB = (b.id.match(/_[aAbB]/g) || []).length
      return depthA - depthB
    })
    
    // Import each child
    sortedFamily.forEach(child => {
      if (!logs.some(l => l.id === child.id) && !findLog(child.id)) {
        handleImportLog(child, false)
      }
    })
    
    setShowImportDialog(false)
  }
  
  const handleReplay = async (log: IsolationLog) => {
    setIsReplaying(log.id)
    try {
      await startReplay(log.missionId, log.id, canInterface)
      
      // Poll for completion instead of fixed timeout
      const pollInterval = setInterval(async () => {
        try {
          const status = await getReplayStatus()
          if (!status.running) {
            clearInterval(pollInterval)
            setIsReplaying(null)
          }
        } catch {
          clearInterval(pollInterval)
          setIsReplaying(null)
        }
      }, 500)
      
    } catch {
      setIsReplaying(null)
    }
  }

  const handleRename = async (log: IsolationLog) => {
    if (!newLogName.trim()) return
    try {
      const result = await renameLog(log.missionId, log.id, newLogName.trim())
      updateLogName(log.id, result.newId, result.newName)
      setRenamingLog(null)
      setNewLogName("")
    } catch (err) {
      alert(err instanceof Error ? err.message : "Erreur lors du renommage")
    }
  }

  const startRenaming = (log: IsolationLog) => {
    setRenamingLog(log.id)
    setNewLogName(log.name.replace(".log", ""))
  }

  const handleViewLog = async (log: IsolationLog) => {
    setViewingLog(log)
    setIsLoadingFrames(true)
    setLogFrames([])
    try {
      const response = await getLogContent(log.missionId, log.id, 500)
      setLogFrames(response.frames)
      setTotalFrames(response.totalCount)
    } catch (err) {
      console.error("Failed to load log content:", err)
    } finally {
      setIsLoadingFrames(false)
    }
  }

  const closeLogViewer = () => {
    setViewingLog(null)
    setLogFrames([])
  }

  const handleExportToReplay = () => {
    if (!viewingLog || logFrames.length === 0) return
    
    const exportedFrames = logFrames
      .filter(f => f.canId && f.data)
      .map(f => ({
        canId: f.canId!,
        data: f.data!,
        timestamp: f.timestamp,
        source: viewingLog.name,
      }))
    
    addFrames(exportedFrames)
    closeLogViewer()
    navRouter.push("/replay-rapide")
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

  const handleDeleteLog = async (logId: string) => {
    // Find the log to get its mission ID
    const log = logs.find(l => l.id === logId) || 
      logs.flatMap(l => l.children || []).find(c => c.id === logId)
    
    if (log) {
      try {
        // Delete from server first
        await deleteLog(log.missionId, logId)
      } catch {
        // If server delete fails (file may not exist), continue with store removal
      }
    }
    
    // Remove from local store
    removeLog(logId)
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
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <Label htmlFor="can-interface" className="text-xs text-muted-foreground whitespace-nowrap">Replay sur:</Label>
                  <Select
                    value={canInterface}
                    onValueChange={(v) => setCanInterface(v as CANInterface)}
                    disabled={isReplaying !== null}
                  >
                    <SelectTrigger id="can-interface" className="h-8 w-28 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="can0">can0</SelectItem>
                      <SelectItem value="can1">can1</SelectItem>
                      <SelectItem value="vcan0">vcan0</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
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
                    onRemove={handleDeleteLog}
                    onTagChange={handleTagChange}
                    onRename={handleRename}
                    onView={handleViewLog}
                    isReplaying={isReplaying}
                    isSplitting={isSplitting}
                    renamingLog={renamingLog}
                    newLogName={newLogName}
                    setNewLogName={setNewLogName}
                    setRenamingLog={setRenamingLog}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Import Dialog */}
      <Dialog open={showImportDialog} onOpenChange={setShowImportDialog}>
        <DialogContent className="max-w-[95vw] sm:max-w-lg overflow-hidden">
          <DialogHeader>
            <DialogTitle>Importer un log</DialogTitle>
            <DialogDescription>
              Selectionnez un log a importer pour l&apos;isolation
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-4">
            {/* Mission Selector */}
            <div className="space-y-2">
              <Label htmlFor="import-mission">Mission source</Label>
              <Select
                value={importMissionId}
                onValueChange={handleImportMissionChange}
              >
                <SelectTrigger id="import-mission">
                  <SelectValue placeholder="Selectionnez une mission" />
                </SelectTrigger>
                <SelectContent>
                  {missions.map((mission) => (
                    <SelectItem key={mission.id} value={mission.id}>
                      {mission.name}
                      {mission.id === missionId && " (courante)"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            
            {/* Logs List - Grouped by family */}
            <div>
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
              <ScrollArea className="h-80">
                <div className="space-y-2 pr-4">
                  {(() => {
                    // Group logs by family (origin logs with their children)
                    const originLogs = missionLogs.filter(l => !l.parentId)
                    const childrenMap = new Map<string, LogEntry[]>()
                    
                    missionLogs.forEach(l => {
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
                    
                    return originLogs.map((originLog) => {
                      const family = getAllDescendants(originLog.id)
                      const hasFamily = family.length > 0
                      const isOriginImported = logs.some((l) => l.id === originLog.id)
                      const allFamilyImported = family.every(f => logs.some(l => l.id === f.id))
                      const anyFamilyImported = family.some(f => logs.some(l => l.id === f.id))
                      
                      return (
                        <div key={originLog.id} className="rounded-lg border border-border overflow-hidden">
                          {/* Origin log header */}
                          <div
                            className={`flex items-center gap-2 p-3 ${
                              isOriginImported ? "bg-muted/50" : "bg-secondary/50"
                            }`}
                          >
                            {hasFamily && (
                              <FolderTree className="h-4 w-4 text-primary shrink-0" />
                            )}
                            <div className="min-w-0 flex-1">
                              <p className="font-mono text-sm text-foreground break-all">
                                {originLog.filename}
                              </p>
                              <p className="text-xs text-muted-foreground truncate">
                                {originLog.framesCount ? `${originLog.framesCount} trames` : ""}
                                {hasFamily && ` - ${family.length} division(s)`}
                              </p>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              {hasFamily && (
                                <>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-8 px-2"
                                    onClick={() => handleImportFamily(originLog, family)}
                                    disabled={isOriginImported && allFamilyImported}
                                    title="Importer tout le dossier"
                                  >
                                    <FolderOpen className="h-4 w-4" />
                                  </Button>
                                  <a
                                    href={getLogFamilyDownloadUrl(importMissionId, originLog.id)}
                                    download
                                    className="inline-flex"
                                  >
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-8 px-2"
                                      title="Telecharger le dossier (ZIP)"
                                    >
                                      <Download className="h-4 w-4" />
                                    </Button>
                                  </a>
                                </>
                              )}
                              {!hasFamily && (
                                <a
                                  href={getLogDownloadUrl(importMissionId, originLog.id)}
                                  download
                                  className="inline-flex"
                                >
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-8 px-2"
                                    title="Telecharger"
                                  >
                                    <Download className="h-4 w-4" />
                                  </Button>
                                </a>
                              )}
                              {isOriginImported ? (
                                <Badge variant="secondary" className="text-xs">Importe</Badge>
                              ) : (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-8"
                                  onClick={() => handleImportLog(originLog)}
                                >
                                  <Import className="h-3 w-3 mr-1" />
                                  <span className="hidden sm:inline">Importer</span>
                                </Button>
                              )}
                            </div>
                          </div>
                          
                          {/* Children (splits) - shown indented */}
                          {hasFamily && (
                            <div className="border-t border-border bg-background/50">
                              {family.map((child, idx) => {
                                const isChildImported = logs.some((l) => l.id === child.id)
                                const depth = (child.id.match(/_[aAbB]/g) || []).length
                                return (
                                  <div
                                    key={child.id}
                                    className={`flex items-center gap-2 p-2 border-b border-border/50 last:border-b-0 ${
                                      isChildImported ? "opacity-60" : "hover:bg-secondary/30"
                                    }`}
                                    style={{ paddingLeft: `${depth * 16 + 12}px` }}
                                  >
                                    <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                                    <div className="min-w-0 flex-1">
                                      <p className="font-mono text-xs text-foreground break-all">
                                        {child.filename}
                                      </p>
                                      <p className="text-xs text-muted-foreground">
                                        {child.framesCount} trames
                                      </p>
                                    </div>
                                    <div className="flex items-center gap-1 shrink-0">
                                      <a
                                        href={getLogDownloadUrl(importMissionId, child.id)}
                                        download
                                        className="inline-flex"
                                      >
                                        <Button
                                          size="sm"
                                          variant="ghost"
                                          className="h-6 w-6 p-0"
                                          title="Telecharger"
                                        >
                                          <Download className="h-3 w-3" />
                                        </Button>
                                      </a>
                                      {isChildImported ? (
                                        <Badge variant="secondary" className="text-xs">Importe</Badge>
                                      ) : (
                                        <Button
                                          size="sm"
                                          variant="ghost"
                                          className="h-6 px-2 text-xs"
                                          onClick={() => handleImportLog(child)}
                                        >
                                          <Import className="h-3 w-3" />
                                        </Button>
                                      )}
                                    </div>
                                  </div>
                                )
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
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Log Viewer Dialog */}
      <Dialog open={viewingLog !== null} onOpenChange={(open) => !open && closeLogViewer()}>
        <DialogContent className="sm:max-w-4xl max-h-[80vh]">
          <DialogHeader>
            <div className="flex items-center justify-between">
              <div>
                <DialogTitle className="flex items-center gap-2">
                  <FileText className="h-5 w-5" />
                  {viewingLog?.name}
                </DialogTitle>
                <DialogDescription>
                  {totalFrames} trames au total
                  {logFrames.length < totalFrames && ` (affichage des ${logFrames.length} premieres)`}
                </DialogDescription>
              </div>
              <Button
                onClick={handleExportToReplay}
                disabled={logFrames.length === 0}
                className="gap-2"
              >
                <Send className="h-4 w-4" />
                Exporter vers Replay
              </Button>
            </div>
          </DialogHeader>
          <div className="mt-4">
            {isLoadingFrames ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <ScrollArea className="h-[400px] rounded-md border border-border">
                <div className="p-2">
                  <table className="w-full text-xs font-mono">
                    <thead className="sticky top-0 bg-secondary">
                      <tr className="text-left text-muted-foreground">
                        <th className="p-2 w-32">Timestamp</th>
                        <th className="p-2 w-16">Interface</th>
                        <th className="p-2 w-20">CAN ID</th>
                        <th className="p-2">Data</th>
                      </tr>
                    </thead>
                    <tbody>
                      {logFrames.map((frame, index) => (
                        <tr key={index} className="border-t border-border/50 hover:bg-secondary/50">
                          <td className="p-2 text-muted-foreground">{frame.timestamp || "-"}</td>
                          <td className="p-2">{frame.interface || "-"}</td>
                          <td className="p-2 text-primary font-semibold">{frame.canId || "-"}</td>
                          <td className="p-2">{frame.data || frame.raw}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </ScrollArea>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </AppShell>
  )
}
