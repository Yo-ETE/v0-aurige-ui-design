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
  Search,
  Network,
} from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useIsolationStore, type IsolationLog } from "@/lib/isolation-store"
import { useExportStore } from "@/lib/export-store"
import { listMissionLogs, startReplay, stopReplay, getReplayStatus, splitLog, renameLog, deleteLog, getLogContent, getLogDownloadUrl, getLogFamilyDownloadUrl, analyzeCoOccurrence, type LogEntry, type CANInterface, type LogFrame, type CoOccurrenceResponse, type CoOccurrenceFrame, type EcuFamily } from "@/lib/api"
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
  missionId,
  onReplay,
  onSplit,
  onRemove,
  onTagChange,
  onRename,
  onView,
  onAnalyze,
  isReplaying,
  isSplitting,
  renamingLog,
  newLogName,
  setNewLogName,
  setRenamingLog,
}: {
  item: IsolationLog
  depth?: number
  missionId: string
  onReplay: (log: IsolationLog) => void
  onSplit: (log: IsolationLog) => void
  onRemove: (logId: string) => void
  onTagChange: (logId: string, tag: "success" | "failed") => void
  onRename: (log: IsolationLog) => void
  onView: (log: IsolationLog) => void
  onAnalyze: (log: IsolationLog) => void
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
              className="h-7 w-7"
              onClick={() => onTagChange(item.id, "success")}
              title="Marquer comme succes"
            >
              <CheckCircle2 className="h-3 w-3" />
            </Button>
            {item.tags.includes("success") && (
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={() => onAnalyze(item)}
                title="Analyser co-occurrence ECU"
              >
                <Network className="h-3 w-3" />
              </Button>
            )}
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
              title="Telecharger"
              asChild
            >
              <a href={getLogDownloadUrl(missionId, item.id)} download={item.filename}>
                <Download className="h-3 w-3" />
              </a>
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
              missionId={missionId}
              onAnalyze={onAnalyze}
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
  
  // Co-occurrence analysis state
  const [analyzingLog, setAnalyzingLog] = useState<IsolationLog | null>(null)
  const [coOccurrenceResult, setCoOccurrenceResult] = useState<CoOccurrenceResponse | null>(null)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [analysisWindowMs, setAnalysisWindowMs] = useState(200)
  const [analysisDirection, setAnalysisDirection] = useState<"before" | "after" | "both">("both")
  const [selectedFrame, setSelectedFrame] = useState<LogFrame | null>(null)
  const [originLogId, setOriginLogId] = useState<string | null>(null)
  const [availableLogsForAnalysis, setAvailableLogsForAnalysis] = useState<Array<{id: string, name: string, depth?: number}>>([])
  const [selectedCoOccurrenceIds, setSelectedCoOccurrenceIds] = useState<Set<string>>(new Set())
  
  // Get mission ID from localStorage and sync with store
  useEffect(() => {
    const localId = localStorage.getItem("activeMissionId")
    const effectiveMissionId = localId || currentMissionId
    
    if (effectiveMissionId) {
      setMissionId(effectiveMissionId)
      // Sync isolation store with current mission - clears logs if mission changed
      setMission(effectiveMissionId)
    } else {
      // No mission - clear isolation store
      setMissionId("")
      setMission(null)
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
  
  // Co-occurrence analysis handlers
  // Step 1: Open the log viewer to select a frame
  const handleAnalyzeCoOccurrence = async (log: IsolationLog) => {
    if (!missionId) return
    
    // Load ALL logs from the mission (not just the isolation tree)
    try {
      const allMissionLogs = await listMissionLogs(missionId)
      
      // Group logs by parent/child hierarchy
      const logIds = new Set(allMissionLogs.map(l => l.id))
      const rootLogs = allMissionLogs.filter(l => !l.parentId || !logIds.has(l.parentId))
      const childrenMap = new Map<string, LogEntry[]>()
      
      allMissionLogs.forEach(l => {
        if (l.parentId) {
          const children = childrenMap.get(l.parentId) || []
          children.push(l)
          childrenMap.set(l.parentId, children)
        }
      })
      
      // Build flat list with hierarchy indication
      const logsForSelection: Array<{id: string, name: string, depth: number}> = []
      const addLogWithChildren = (log: typeof allMissionLogs[0], depth: number) => {
        logsForSelection.push({ id: log.id, name: log.filename, depth })
        const children = childrenMap.get(log.id) || []
        children.sort((a, b) => a.filename.localeCompare(b.filename))
        children.forEach(child => addLogWithChildren(child, depth + 1))
      }
      
      rootLogs.sort((a, b) => a.filename.localeCompare(b.filename))
      rootLogs.forEach(log => addLogWithChildren(log, 0))
      
      setAvailableLogsForAnalysis(logsForSelection)
      
      // Find the root log in the isolation tree for default selection
      let rootLogId = log.id
      let currentLog: IsolationLog | undefined = log
      while (currentLog?.parentId) {
        const parent = findLog(currentLog.parentId)
        if (parent) {
          rootLogId = parent.id
          currentLog = parent
        } else {
          break
        }
      }
      
      // Default to root log, user can change to any mission log
      setOriginLogId(rootLogId)
    } catch (error) {
      // Fallback: use isolation tree only
      const collectAllLogs = (items: IsolationLog[], depth = 0): Array<{id: string, name: string, depth: number}> => {
        const result: Array<{id: string, name: string, depth: number}> = []
        for (const item of items) {
          result.push({ id: item.id, name: item.name, depth })
          if (item.children?.length) {
            result.push(...collectAllLogs(item.children, depth + 1))
          }
        }
        return result
      }
      setAvailableLogsForAnalysis(collectAllLogs(logs))
      setOriginLogId(log.id)
    }
    
    setSelectedFrame(null)
    setCoOccurrenceResult(null)
    
    // Open the success log to select the causal frame
    handleViewLog(log)
  }
  
  // Step 2: User selects a frame in the viewer
  const handleSelectFrameForAnalysis = (frame: LogFrame) => {
    setSelectedFrame(frame)
  }
  
  // Step 3: Run analysis with selected frame on origin log
  const runCoOccurrenceAnalysis = async () => {
    if (!selectedFrame || !originLogId || !missionId) return
    if (!selectedFrame.canId || !selectedFrame.timestamp) return
    
    setAnalyzingLog(viewingLog)
    closeLogViewer()
    setIsAnalyzing(true)
    
    try {
      const result = await analyzeCoOccurrence(missionId, originLogId, {
        logId: originLogId,
        targetCanId: selectedFrame.canId,
        targetTimestamp: parseFloat(selectedFrame.timestamp),
        windowMs: analysisWindowMs,
        direction: analysisDirection,
      })
      
      setCoOccurrenceResult(result)
    } catch (error) {
      console.error("[v0] Co-occurrence analysis error:", error)
    } finally {
      setIsAnalyzing(false)
    }
  }
  
  const closeCoOccurrenceDialog = () => {
    setAnalyzingLog(null)
    setCoOccurrenceResult(null)
    setSelectedFrame(null)
    setOriginLogId(null)
    setAvailableLogsForAnalysis([])
    setSelectedCoOccurrenceIds(new Set())
  }
  
  // Send selected co-occurrence frames to Replay Rapide
  const handleSendToReplayRapide = () => {
    if (!coOccurrenceResult || selectedCoOccurrenceIds.size === 0) return
    
    const framesToSend = coOccurrenceResult.relatedFrames
      .filter(f => selectedCoOccurrenceIds.has(f.canId))
      .map(f => ({
        canId: f.canId,
        data: f.sampleData[0] || "00",
        timestamp: "0",
        source: `co-occurrence-${originLogId}`,
      }))
    
    addFrames(framesToSend)
    closeCoOccurrenceDialog()
    navRouter.push("/replay-rapide")
  }
  
  // Toggle selection of a co-occurrence frame
  const toggleCoOccurrenceSelection = (canId: string) => {
    setSelectedCoOccurrenceIds(prev => {
      const next = new Set(prev)
      if (next.has(canId)) {
        next.delete(canId)
      } else {
        next.add(canId)
      }
      return next
    })
  }
  
  // Select/deselect all co-occurrence frames
  const toggleAllCoOccurrenceSelection = () => {
    if (!coOccurrenceResult) return
    if (selectedCoOccurrenceIds.size === coOccurrenceResult.relatedFrames.length) {
      setSelectedCoOccurrenceIds(new Set())
    } else {
      setSelectedCoOccurrenceIds(new Set(coOccurrenceResult.relatedFrames.map(f => f.canId)))
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

  const handleDeleteLog = async (logId: string) => {
    if (!missionId) return
    
    try {
      // Delete from server first using the current mission ID
      await deleteLog(missionId, logId)
    } catch {
      // If server delete fails (file may not exist), continue with store removal
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
                    missionId={missionId}
                    onReplay={handleReplay}
                    onSplit={handleSplit}
                    onRemove={handleDeleteLog}
                    onTagChange={handleTagChange}
                    onRename={handleRename}
                    onView={handleViewLog}
                    onAnalyze={handleAnalyzeCoOccurrence}
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
                    // A log is a "root" if it has no parent OR its parent doesn't exist in the list
                    const logIds = new Set(missionLogs.map(l => l.id))
                    const originLogs = missionLogs.filter(l => !l.parentId || !logIds.has(l.parentId))
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
                                  className="h-8 bg-transparent"
                                  onClick={() => handleImportLog(originLog)}
                                >
                                  <Import className="h-3 w-3 mr-1" />
                                  <span className="hidden sm:inline">Importer</span>
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-8 px-2 text-destructive hover:text-destructive"
                                title="Supprimer"
                                onClick={async () => {
                                  if (!confirm(`Supprimer ${originLog.filename} et ses divisions ?`)) return
                                  try {
                                    await deleteLog(importMissionId, originLog.id)
                                    // Refresh the logs list
                                    const updatedLogs = await listMissionLogs(importMissionId)
                                    setMissionLogs(updatedLogs)
                                  } catch {}
                                }}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
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
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                                        title="Supprimer"
                                        onClick={async () => {
                                          if (!confirm(`Supprimer ${child.filename} ?`)) return
                                          try {
                                            await deleteLog(importMissionId, child.id)
                                            const updatedLogs = await listMissionLogs(importMissionId)
                                            setMissionLogs(updatedLogs)
                                          } catch {}
                                        }}
                                      >
                                        <Trash2 className="h-3 w-3" />
                                      </Button>
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
      <Dialog open={viewingLog !== null} onOpenChange={(open) => {
        if (!open) {
          closeLogViewer()
          setSelectedFrame(null)
          if (!analyzingLog) setOriginLogId(null)
        }
      }}>
        <DialogContent className="w-[95vw] max-w-4xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2 text-sm sm:text-base">
              <FileText className="h-4 w-4 sm:h-5 sm:w-5 shrink-0" />
              <span className="truncate">{viewingLog?.name}</span>
            </DialogTitle>
            <DialogDescription className="text-xs sm:text-sm">
              {totalFrames} trames
              {logFrames.length < totalFrames && ` (${logFrames.length} affichees)`}
              {originLogId && (
                <span className="block sm:inline sm:ml-2 text-primary">
                  Selectionnez la trame causale
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          
          {/* Action buttons - responsive */}
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {originLogId && selectedFrame && (
              <Button
                onClick={runCoOccurrenceAnalysis}
                size="sm"
                className="gap-1"
              >
                <Network className="h-3 w-3" />
                <span className="hidden sm:inline">Analyser</span> co-occurrence
              </Button>
            )}
            <Button
              onClick={handleExportToReplay}
              disabled={logFrames.length === 0}
              variant="outline"
              size="sm"
              className="gap-1 bg-transparent"
            >
              <Send className="h-3 w-3" />
              <span className="hidden sm:inline">Exporter vers</span> Replay
            </Button>
          </div>
          
          {/* Analysis parameters - responsive grid */}
          {originLogId && (
            <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-2 sm:gap-3 p-2 sm:p-3 rounded-lg border border-primary/30 bg-primary/5 shrink-0">
              <div className="flex items-center gap-1">
                <Label className="text-xs whitespace-nowrap">Fenetre:</Label>
                <Select value={analysisWindowMs.toString()} onValueChange={(v) => setAnalysisWindowMs(parseInt(v))}>
                  <SelectTrigger className="w-20 h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="100">100 ms</SelectItem>
                    <SelectItem value="200">200 ms</SelectItem>
                    <SelectItem value="500">500 ms</SelectItem>
                    <SelectItem value="1000">1 sec</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-1">
                <Label className="text-xs whitespace-nowrap">Direction:</Label>
                <Select value={analysisDirection} onValueChange={(v) => setAnalysisDirection(v as "before" | "after" | "both")}>
                  <SelectTrigger className="w-24 h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="before">Avant</SelectItem>
                    <SelectItem value="after">Apres</SelectItem>
                    <SelectItem value="both">Les deux</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-1 col-span-2 sm:col-span-1">
                <Label className="text-xs whitespace-nowrap">Analyser sur:</Label>
                <Select value={originLogId || ""} onValueChange={(v) => setOriginLogId(v)}>
                  <SelectTrigger className="flex-1 sm:w-40 h-7 font-mono text-xs">
                    <SelectValue placeholder="Log" />
                  </SelectTrigger>
                  <SelectContent className="max-h-60">
                    {availableLogsForAnalysis.map((log) => (
                      <SelectItem key={log.id} value={log.id} className="font-mono text-xs">
                        <span style={{ paddingLeft: `${(log.depth || 0) * 8}px` }} className="flex items-center gap-1">
                          {(log.depth || 0) > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
                          {log.name.length > 25 ? log.name.slice(0, 25) + "..." : log.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {selectedFrame && (
                <div className="flex items-center gap-1 col-span-2 sm:col-span-1">
                  <span className="text-xs text-muted-foreground">Trame:</span>
                  <Badge className="font-mono text-xs h-6">{selectedFrame.canId}</Badge>
                  <span className="font-mono text-xs text-muted-foreground truncate max-w-16">{selectedFrame.data}</span>
                </div>
              )}
            </div>
          )}
          
          <div className="mt-2">
            {isLoadingFrames ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <ScrollArea className="h-[350px] rounded-md border border-border">
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
                      {logFrames.map((frame, index) => {
                        const isSelected = selectedFrame && 
                          selectedFrame.timestamp === frame.timestamp && 
                          selectedFrame.canId === frame.canId
                        return (
                          <tr 
                            key={index} 
                            className={`border-t border-border/50 cursor-pointer transition-colors ${
                              isSelected 
                                ? "bg-primary/20 hover:bg-primary/25" 
                                : "hover:bg-secondary/50"
                            }`}
                            onClick={() => originLogId && handleSelectFrameForAnalysis(frame)}
                          >
                            <td className="p-2 text-muted-foreground">{frame.timestamp || "-"}</td>
                            <td className="p-2">{frame.interface || "-"}</td>
                            <td className="p-2 text-primary font-semibold">{frame.canId || "-"}</td>
                            <td className="p-2">{frame.data || frame.raw}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </ScrollArea>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Co-occurrence Analysis Dialog */}
      <Dialog open={analyzingLog !== null} onOpenChange={(open) => !open && closeCoOccurrenceDialog()}>
        <DialogContent className="w-[95vw] max-w-4xl h-[85vh] max-h-[700px] overflow-hidden flex flex-col p-4 sm:p-6">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Network className="h-5 w-5" />
              Analyse Co-occurrence ECU
            </DialogTitle>
            <DialogDescription>
              Trames liees a la trame causale dans une fenetre de {analysisWindowMs}ms
            </DialogDescription>
          </DialogHeader>
          
          {/* Target frame info */}
          {coOccurrenceResult && (
            <div className="flex flex-wrap items-center gap-4 py-3 px-4 rounded-lg border border-primary/30 bg-primary/5">
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Trame cible:</span>
                <Badge className="font-mono">{coOccurrenceResult.targetFrame.canId}</Badge>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Log analyse:</span>
                <Badge variant="secondary" className="font-mono">{originLogId}.log</Badge>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">IDs trouves:</span>
                <span className="font-semibold">{coOccurrenceResult.uniqueIdsFound}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Trames:</span>
                <span className="font-semibold">{coOccurrenceResult.totalFramesAnalyzed}</span>
              </div>
            </div>
          )}
          
          {/* Results */}
          <div className="flex-1 overflow-hidden">
            {isAnalyzing ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <span className="ml-3 text-muted-foreground">Analyse en cours...</span>
              </div>
            ) : coOccurrenceResult ? (
              <div className="h-full flex flex-col gap-4">
                {/* ECU Families */}
                {coOccurrenceResult.ecuFamilies.length > 0 && (
                  <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
                    <h4 className="font-medium text-sm mb-2 flex items-center gap-2">
                      <Network className="h-4 w-4 text-primary" />
                      Familles ECU detectees
                    </h4>
                    <div className="flex flex-wrap gap-2">
                      {coOccurrenceResult.ecuFamilies.map((family, idx) => (
                        <Badge key={idx} variant="secondary" className="font-mono">
                          {family.name} ({family.totalFrames} trames)
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
                
                {/* Related Frames Table */}
                <div className="flex-1 min-h-0 border rounded-lg overflow-auto">
                  <div className="min-w-[700px]">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-secondary z-10">
                        <tr className="text-left text-muted-foreground">
                          <th className="p-2 w-8">
                            <input 
                              type="checkbox" 
                              checked={selectedCoOccurrenceIds.size === coOccurrenceResult.relatedFrames.length && coOccurrenceResult.relatedFrames.length > 0}
                              onChange={toggleAllCoOccurrenceSelection}
                              className="rounded"
                            />
                          </th>
                          <th className="p-2 w-20">CAN ID</th>
                          <th className="p-2 w-16">Score</th>
                          <th className="p-2 w-16">Type</th>
                          <th className="p-2 w-12">Nb</th>
                          <th className="p-2 w-16">Avant</th>
                          <th className="p-2 w-16">Apres</th>
                          <th className="p-2 w-20">Delai</th>
                          <th className="p-2">Data</th>
                        </tr>
                      </thead>
                      <tbody>
                        {coOccurrenceResult.relatedFrames.map((frame, idx) => {
                          const isSelected = selectedCoOccurrenceIds.has(frame.canId)
                          return (
                            <tr 
                              key={idx} 
                              className={`border-t border-border/50 cursor-pointer transition-colors ${isSelected ? "bg-primary/10" : "hover:bg-secondary/50"}`}
                              onClick={() => toggleCoOccurrenceSelection(frame.canId)}
                            >
                              <td className="p-2">
                                <input 
                                  type="checkbox" 
                                  checked={isSelected}
                                  onChange={() => toggleCoOccurrenceSelection(frame.canId)}
                                  onClick={(e) => e.stopPropagation()}
                                  className="rounded"
                                />
                              </td>
                              <td className="p-2 font-mono font-semibold text-primary">{frame.canId}</td>
                              <td className="p-2">
                                <div className="flex items-center gap-1">
                                  <div 
                                    className="h-2 rounded-full bg-primary" 
                                    style={{ width: `${frame.score * 30}px` }}
                                  />
                                  <span className="text-muted-foreground">{(frame.score * 100).toFixed(0)}%</span>
                                </div>
                              </td>
                              <td className="p-2">
                                <Badge 
                                  variant={frame.frameType === "ack" ? "default" : frame.frameType === "command" ? "secondary" : "outline"}
                                  className={`text-[10px] ${frame.frameType === "ack" ? "bg-success text-success-foreground" : ""}`}
                                >
                                  {frame.frameType}
                                </Badge>
                              </td>
                              <td className="p-2 text-center">{frame.count}</td>
                              <td className="p-2 text-center">{frame.countBefore}</td>
                              <td className="p-2 text-center">{frame.countAfter}</td>
                              <td className="p-2 text-center text-[10px]">{frame.avgDelayMs > 0 ? "+" : ""}{frame.avgDelayMs.toFixed(1)}ms</td>
                              <td className="p-2 font-mono text-muted-foreground text-[10px] truncate max-w-[150px]">
                                {frame.sampleData[0] || "-"}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
                
                {/* Actions */}
                <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border">
                  <span className="text-xs text-muted-foreground">
                    {selectedCoOccurrenceIds.size} selectionnee(s)
                  </span>
                  <Button 
                    size="sm" 
                    onClick={handleSendToReplayRapide}
                    disabled={selectedCoOccurrenceIds.size === 0}
                    className="gap-1"
                  >
                    <Send className="h-3 w-3" />
                    Replay Rapide
                  </Button>
                  <Button variant="outline" size="sm" className="bg-transparent" onClick={() => {
                    // Export selected IDs or all if none selected
                    const ids = selectedCoOccurrenceIds.size > 0 
                      ? Array.from(selectedCoOccurrenceIds)
                      : coOccurrenceResult.relatedFrames.map(f => f.canId)
                    navigator.clipboard.writeText(ids.join(","))
                  }}>
                    Copier IDs
                  </Button>
                  {coOccurrenceResult.ecuFamilies.length > 0 && (
                    <Button variant="outline" size="sm" className="bg-transparent" onClick={() => {
                      const allIds = coOccurrenceResult.ecuFamilies.flatMap(f => f.frameIds)
                      navigator.clipboard.writeText(allIds.join(","))
                    }}>
                      Copier IDs ECU
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Network className="h-12 w-12 text-muted-foreground/50 mb-4" />
                <p className="text-sm text-muted-foreground">
                  Configurez les parametres et cliquez sur Analyser<br/>
                  pour identifier les trames liees a la trame causale.
                </p>
                <p className="text-xs text-muted-foreground mt-2">
                  L&apos;analyse se fait sur le log d&apos;origine: {analyzingLog?.name}
                </p>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </AppShell>
  )
}
