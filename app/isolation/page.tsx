"use client"

import { useState, useEffect } from "react"
import { useRouter, useSearchParams } from "next/navigation"
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
import { listMissionLogs, startReplay, stopReplay, getReplayStatus, splitLog, renameLog, deleteLog, getLogContent, getLogDownloadUrl, getLogFamilyDownloadUrl, analyzeCoOccurrence, analyzeFamilyDiff, addDBCSignal, getMissionDBC, getDBCExportUrl, sendCANFrame, type LogEntry, type CANInterface, type LogFrame, type CoOccurrenceResponse, type CoOccurrenceFrame, type EcuFamily, type FamilyAnalysisResponse, type FrameDiff, type DBCSignal } from "@/lib/api"
import { useRouter as useNavRouter } from "next/navigation"
import { useMissionStore } from "@/lib/mission-store"
import { LogImportButton } from "@/components/log-import-button"

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
  const searchParams = useSearchParams()
  const { logs, importLog, addChildLog, removeLog, updateLogTags, updateLogName, clearLogs, setMission, findLog } = useIsolationStore()
  const { addFrames } = useExportStore()
  
  // Analyze param from Replay Rapide (frame to analyze with source context)
  const analyzeParam = searchParams.get("analyze")
  
  // Pending frame to analyze after log import
  const [pendingAnalyzeFrame, setPendingAnalyzeFrame] = useState<{canId: string, data: string, source: string} | null>(null)
  
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
  const [replayingFrameIdx, setReplayingFrameIdx] = useState<number | null>(null)
  const [replayedFrameIdx, setReplayedFrameIdx] = useState<number | null>(null)
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
  const [replayCanInterface, setReplayCanInterface] = useState<"can0" | "can1" | "vcan0">("can0")
  const [availableLogsForAnalysis, setAvailableLogsForAnalysis] = useState<Array<{id: string, name: string, depth?: number}>>([])
  const [selectedCoOccurrenceIds, setSelectedCoOccurrenceIds] = useState<Set<string>>(new Set())
  
  // Family diff analysis state (for DBC workflow)
  const [showFamilyDiff, setShowFamilyDiff] = useState(false)
  const [familyDiffResult, setFamilyDiffResult] = useState<FamilyAnalysisResponse | null>(null)
  const [isAnalyzingFamily, setIsAnalyzingFamily] = useState(false)
  const [selectedFamilyIds, setSelectedFamilyIds] = useState<string[]>([])
  const [diffViewMode, setDiffViewMode] = useState<"bytes" | "bits">("bytes")
  const [selectedDiffFrame, setSelectedDiffFrame] = useState<FrameDiff | null>(null)
  
  // DBC Signal editor state
  const [showSignalEditor, setShowSignalEditor] = useState(false)
  const [editingSignal, setEditingSignal] = useState<Partial<DBCSignal> | null>(null)
  
  // Time windows for diff analysis (offsets in ms from t0)
  const [beforeOffsetMs, setBeforeOffsetMs] = useState<[number, number]>([-500, -50])
  const [ackOffsetMs, setAckOffsetMs] = useState<[number, number]>([0, 100])
  const [statusOffsetMs, setStatusOffsetMs] = useState<[number, number]>([200, 1500])
  
  // State for co-occurrence dialog navigation
  const [coOccStep, setCoOccStep] = useState<"select" | "results">("select")
  
  // Get mission ID from sessionStorage and sync with store
  useEffect(() => {
    const localId = sessionStorage.getItem("activeMissionId")
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
    // Utiliser les tags du backend si disponibles, sinon default
    const backendTags = log.tags && log.tags.length > 0 ? log.tags : (log.parentId ? [] : ["original"])
    const newLog: IsolationLog = {
      id: log.id,
      name: log.filename,
      filename: log.filename,
      missionId: importMissionId,
      tags: backendTags,
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
    
    // If there's a pending analyze frame, open co-occurrence dialog
    if (pendingAnalyzeFrame && closeDialog) {
      setTimeout(() => {
        setSelectedFrame({
          timestamp: 0,
          canId: pendingAnalyzeFrame.canId,
          data: pendingAnalyzeFrame.data,
          interface: "can0",
          raw: pendingAnalyzeFrame.data,
        } as LogFrame)
        setOriginLogId(newLog.id.replace(".log", ""))
        setAnalyzingLog(newLog)
        setCoOccStep("select")
        setPendingAnalyzeFrame(null)
      }, 100)
    }
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
  
  // Load all mission logs for co-occurrence analysis
  const loadAvailableLogsForAnalysis = async (): Promise<Array<{id: string, name: string, depth: number}>> => {
    if (!missionId) return []
    
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
      
      return logsForSelection
    } catch {
      return []
    }
  }
  
  // Handle analyze param from Replay Rapide
  // Store pending canId to find in selected log
  const [pendingCanIdToFind, setPendingCanIdToFind] = useState<{canId: string, data: string} | null>(null)
  
  useEffect(() => {
    if (analyzeParam && missionId) {
      const handleAnalyzeParam = async () => {
        try {
          const params = new URLSearchParams(analyzeParam)
          const canId = params.get("canId")
          const data = params.get("data")
          const source = params.get("source")
          
          if (canId) {
            // Load all mission logs for selection
            const logsForSelection = await loadAvailableLogsForAnalysis()
            setAvailableLogsForAnalysis(logsForSelection)
            
            // Store the canId to find when user selects a log
            setPendingCanIdToFind({ canId, data: data || "" })
            
            // Try to find the source log in the list
            const logName = source ? source.replace("qualified-", "").replace("co-occurrence-", "").replace(".log", "") : ""
            const matchingLog = logsForSelection.find(l => 
              l.name.replace(".log", "") === logName || 
              l.id === logName ||
              l.name.includes(logName)
            )
            
            if (matchingLog) {
              setOriginLogId(matchingLog.id)
            }
            
            // Create a minimal log object to open the dialog
            setAnalyzingLog({
              id: matchingLog?.id || "pending",
              name: matchingLog?.name || source || "Log",
              filename: matchingLog?.name || source || "Log",
              missionId: missionId,
              tags: [],
              frameCount: 0,
            })
            
            setCoOccStep("select")
            
            // Clear the URL param
            router.replace("/isolation", { scroll: false })
          }
        } catch {
          // Invalid param, ignore
        }
      }
      
      handleAnalyzeParam()
    }
  }, [analyzeParam, router, missionId])
  
  // Co-occurrence analysis handlers
  // Step 1: Open the log viewer to select a frame
  const handleAnalyzeCoOccurrence = async (log: IsolationLog) => {
    if (!missionId) return
    
    try {
      // Load ALL logs from the mission
      const logsForSelection = await loadAvailableLogsForAnalysis()
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
  
  // Open family diff analysis for qualifying frames
  const handleQualifyFamily = (familyIds: string[]) => {
    setSelectedFamilyIds(familyIds)
    setShowFamilyDiff(true)
    setFamilyDiffResult(null)
    setSelectedDiffFrame(null)
  }
  
  // Run the family diff analysis with 3 windows (AVANT / ACK / STATUS)
  const runFamilyDiffAnalysis = async () => {
    if (!missionId || !originLogId || selectedFamilyIds.length === 0 || !coOccurrenceResult) {
      console.error("[v0] Missing required data for family diff analysis")
      return
    }
    
    const t0 = coOccurrenceResult.targetFrame.timestamp
    
    setIsAnalyzingFamily(true)
    try {
      const result = await analyzeFamilyDiff({
        mission_id: missionId,
        log_id: originLogId,
        family_ids: selectedFamilyIds,
        t0_timestamp: t0,
        before_offset_ms: beforeOffsetMs,
        ack_offset_ms: ackOffsetMs,
        status_offset_ms: statusOffsetMs,
      })
      setFamilyDiffResult(result)
      if (result.frames_analysis.length > 0) {
        setSelectedDiffFrame(result.frames_analysis[0])
      }
    } catch (error) {
      console.error("[v0] Family diff analysis error:", error)
    } finally {
      setIsAnalyzingFamily(false)
    }
  }
  
  // Reset to default presets
  const resetToDefaultPresets = () => {
    setBeforeOffsetMs([-500, -50])
    setAckOffsetMs([0, 100])
    setStatusOffsetMs([200, 1500])
  }
  
  // Open signal editor for a specific byte/bit
  const handleCreateSignal = (
    canId: string, 
    byteIndex: number, 
    bitIndex?: number,
    analysisInfo?: {
      valueBefore: string
      valueAfter: string
      classification: string
      persistence: string
      sampleBefore?: string   // Full payload AVANT
      sampleAck?: string      // Full payload ACK
      sampleStatus?: string   // Full payload STATUS
    }
  ) => {
    // Generate default comment based on analysis
    let defaultComment = ""
    if (analysisInfo) {
      const classLabel = analysisInfo.classification === "status" ? "STATUS" : 
                         analysisInfo.classification === "ack" ? "ACK" : 
                         analysisInfo.classification === "info" ? "INFO" : analysisInfo.classification.toUpperCase()
      const persLabel = analysisInfo.persistence === "persistent" ? "persistant" : "transitoire"
      defaultComment = `${classLabel} ${persLabel} - Octet ${byteIndex}: ${analysisInfo.valueBefore} -> ${analysisInfo.valueAfter}`
    }
    
    setEditingSignal({
      can_id: canId,
      name: `SIG_${canId}_B${byteIndex}${bitIndex !== undefined ? `_b${bitIndex}` : ""}`,
      start_bit: byteIndex * 8 + (bitIndex ?? 0),
      length: bitIndex !== undefined ? 1 : 8,
      byte_order: "little_endian",
      is_signed: false,
      scale: 1,
      offset: 0,
      min_val: 0,
      max_val: bitIndex !== undefined ? 1 : 255,
      unit: "",
      comment: defaultComment,
      // Store sample payloads for replay
      sample_before: analysisInfo?.sampleBefore,
      sample_ack: analysisInfo?.sampleAck,
      sample_status: analysisInfo?.sampleStatus,
    })
    setShowSignalEditor(true)
  }
  
  // Save signal to mission DBC - always generate unique ID to avoid overwriting
  const handleSaveSignal = async () => {
    if (!missionId || !editingSignal) return
    try {
      const uniqueId = `${editingSignal.can_id}_${editingSignal.name}_${Date.now().toString(36)}`
      await addDBCSignal(missionId, { ...editingSignal, id: uniqueId })
      setShowSignalEditor(false)
      setEditingSignal(null)
    } catch (error) {
      console.error("[v0] Failed to save signal:", error)
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
  
  const handleTagChange = async (logId: string, tag: "success" | "failed") => {
    const log = findLog(logId)
    const logMission = log?.missionId || missionId
    let newTags: string[]
    if (log?.tags.includes(tag)) {
      newTags = log.tags.filter(t => t !== tag)
    } else {
      newTags = [tag]
    }
    // Mettre a jour le store local
    updateLogTags(logId, newTags)
    // Persister sur le backend (meta.json)
    if (logMission) {
      try {
        const { updateLogTags: apiUpdateTags } = await import("@/lib/api")
        await apiUpdateTags(logMission, logId, newTags)
      } catch (err) {
        console.error("[v0] Erreur persistance tags:", err)
      }
    }
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
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <FolderOpen className="h-16 w-16 text-muted-foreground/30 mb-4" />
                <h2 className="text-xl font-semibold text-foreground mb-2">Aucune mission selectionnee</h2>
                <p className="text-muted-foreground text-center max-w-md mb-6">
                  Selectionnez ou creez une mission depuis le Dashboard pour analyser des trames CAN.
                </p>
                <Button onClick={() => router.push("/")} className="gap-2">
                  <ArrowLeft className="h-4 w-4" />
                  Ouvrir le Dashboard
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
  <div className="flex items-center justify-between">
    <DialogTitle>Importer un log</DialogTitle>
    <LogImportButton 
      missionId={missionId} 
      onImportSuccess={() => {
        if (missionId) loadMissionLogs(missionId)
      }} 
      size="sm"
    />
  </div>
  <DialogDescription>
  {pendingAnalyzeFrame ? (
  <>Importez le log contenant la trame <span className="font-mono text-primary">{pendingAnalyzeFrame.canId}</span> pour lancer l&apos;analyse co-occurrence</>
  ) : (
  <>Selectionnez un log de la mission ou importez un fichier externe</>
  )}
  </DialogDescription>
  </DialogHeader>
  {pendingAnalyzeFrame && (
    <div className="p-2 rounded bg-primary/10 border border-primary/30 text-xs">
      <span className="text-muted-foreground">Trame a analyser:</span>{" "}
      <span className="font-mono font-semibold">{pendingAnalyzeFrame.canId}#{pendingAnalyzeFrame.data}</span>
      {pendingAnalyzeFrame.source && (
        <span className="text-muted-foreground ml-2">depuis {pendingAnalyzeFrame.source}</span>
      )}
    </div>
  )}
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
        <DialogContent className="w-[98vw] sm:w-[95vw] max-w-4xl max-h-[90vh] overflow-hidden flex flex-col p-3 sm:p-6">
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
            <div className="flex items-center gap-1 ml-auto">
              <Label className="text-xs whitespace-nowrap text-muted-foreground">Replay CAN:</Label>
              <select
                value={replayCanInterface}
                onChange={(e) => setReplayCanInterface(e.target.value as "can0" | "can1" | "vcan0")}
                className="rounded border border-border bg-secondary px-2 py-1 text-xs text-foreground h-7"
              >
                <option value="can0">can0</option>
                <option value="can1">can1</option>
                <option value="vcan0">vcan0</option>
              </select>
            </div>
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
                  <div className="p-2 overflow-x-auto">
                    <table className="w-full text-xs font-mono min-w-[700px]">
                    <thead className="sticky top-0 bg-secondary">
                      <tr className="text-left text-muted-foreground">
                        <th className="p-2 w-32">Timestamp</th>
                        <th className="p-2 w-16">Interface</th>
                        <th className="p-2 w-20">CAN ID</th>
                        <th className="p-2">Data</th>
                        <th className="p-2 w-20">Actions</th>
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
                            <td className="p-2">
                              <div className="flex gap-1">
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className={`h-6 w-6 ${replayedFrameIdx === index ? "text-success bg-success/20" : "text-success hover:text-success"}`}
                                  disabled={replayingFrameIdx === index}
                                  onClick={async (e) => {
                                    e.stopPropagation()
                                    setReplayingFrameIdx(index)
                                    setReplayedFrameIdx(null)
                                    try {
                                      await sendCANFrame({ interface: replayCanInterface, canId: frame.canId, data: frame.data || frame.raw || "" })
                                      setReplayedFrameIdx(index)
                                      setTimeout(() => setReplayedFrameIdx((prev) => prev === index ? null : prev), 2000)
                                    } catch (err) {
                                      console.error("[v0] sendCANFrame error:", err, "interface:", replayCanInterface, "canId:", frame.canId, "data:", frame.data || frame.raw)
                                      setReplayedFrameIdx(null)
                                    } finally {
                                      setReplayingFrameIdx(null)
                                    }
                                  }}
                                  title={`Rejouer sur ${replayCanInterface}: ${frame.canId}#${frame.data || frame.raw}`}
                                >
                                  {replayingFrameIdx === index ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : replayedFrameIdx === index ? (
                                    <CheckCircle2 className="h-3 w-3" />
                                  ) : (
                                    <Play className="h-3 w-3" />
                                  )}
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-6 w-6"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    addFrames([{
                                      canId: frame.canId,
                                      data: frame.data || frame.raw || "",
                                      timestamp: String(frame.timestamp || 0),
                                      source: originLogId || viewingLog?.name || "unknown",
                                    }])
                                  }}
                                  title="Ajouter au Replay Rapide"
                                >
                                  <Send className="h-3 w-3" />
                                </Button>
                              </div>
                            </td>
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
      <Dialog open={analyzingLog !== null} onOpenChange={(open) => { if (!open) { closeCoOccurrenceDialog(); setCoOccStep("select"); } }}>
        <DialogContent 
          className="overflow-hidden flex flex-col"
          style={{ width: "98vw", maxWidth: "1400px", height: "90vh", maxHeight: "900px" }}
        >
          <DialogHeader className="shrink-0">
            <div className="flex items-center gap-2">
              {coOccStep === "results" && coOccurrenceResult && (
                <Button variant="ghost" size="icon" className="h-8 w-8 bg-transparent" onClick={() => { setCoOccurrenceResult(null); setCoOccStep("select"); }}>
                  <ArrowLeft className="h-4 w-4" />
                </Button>
              )}
              <DialogTitle className="flex items-center gap-2">
                <Network className="h-5 w-5 text-primary" />
                Analyse Co-occurrence ECU
              </DialogTitle>
            </div>
            <DialogDescription>
              {coOccStep === "select" ? "Selectionnez un log a analyser" : `Trames liees a la trame causale dans une fenetre de ${analysisWindowMs}ms`}
            </DialogDescription>
          </DialogHeader>
          
          {/* Target frame info */}
          {coOccurrenceResult && (
            <div className="flex flex-wrap items-center gap-2 sm:gap-4 py-3 px-4 rounded-lg border border-primary/30 bg-primary/5">
              <div className="flex items-center gap-2">
                <span className="text-xs sm:text-sm text-muted-foreground">Trame cible:</span>
                <Badge className="font-mono">{coOccurrenceResult.targetFrame.canId}</Badge>
              </div>
              <div className="hidden sm:flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Log analyse:</span>
                <Badge variant="secondary" className="font-mono text-xs">{originLogId}.log</Badge>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs sm:text-sm text-muted-foreground">IDs trouves:</span>
                <span className="font-semibold text-sm">{coOccurrenceResult.uniqueIdsFound}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs sm:text-sm text-muted-foreground">Trames:</span>
                <span className="font-semibold text-sm">{coOccurrenceResult.totalFramesAnalyzed}</span>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="bg-transparent ml-auto text-xs"
                onClick={() => {
                  // Qualifier la trame cible (t0)
                  setSelectedFamilyIds([coOccurrenceResult.targetFrame.canId])
                  setShowFamilyDiff(true)
                }}
              >
                Qualifier t0
              </Button>
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
                        <div key={idx} className="flex items-center gap-1 bg-secondary rounded-lg px-2 py-1">
                          <span className="font-mono text-xs">{family.name}</span>
                          <span className="text-xs text-muted-foreground">({family.totalFrames})</span>
                          <Button 
                            size="sm" 
                            variant="ghost" 
                            className="h-6 px-2 text-xs text-primary hover:text-primary"
                            onClick={() => handleQualifyFamily(family.frameIds)}
                          >
                            Qualifier
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                
                {/* Related Frames Table */}
                <div className="flex-1 min-h-0 border rounded-lg overflow-auto">
                  <div className="min-w-[800px]">
                    <table className="w-full text-sm">
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
                          <th className="p-2 w-20">Action</th>
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
                              <td className="p-2 font-mono text-muted-foreground text-xs truncate max-w-[200px]">
                                {frame.sampleData[0] || "-"}
                              </td>
                              <td className="p-2">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 px-2 text-xs bg-transparent hover:bg-primary/10"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    // Open Family Diff dialog with this single ID
                                    setSelectedFamilyIds([frame.canId])
                                    setShowFamilyDiff(true)
                                  }}
                                >
                                  Qualifier
                                </Button>
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
                    {selectedCoOccurrenceIds.size} selectionnee(s) - Utilisez Qualifier pour analyser et rejouer
                  </span>
                  <Button variant="outline" size="sm" className="bg-transparent" onClick={() => {
                    // Go back to log selection
                    setCoOccurrenceResult(null)
                    setCoOccStep("select")
                  }}>
                    Nouvelle analyse
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-4 p-4">
                <h4 className="font-medium">Selectionnez un log a analyser</h4>
                <div className="flex flex-col gap-1 max-h-[500px] overflow-auto border rounded-lg p-2">
                  {availableLogsForAnalysis.length > 0 ? availableLogsForAnalysis.map((log) => (
                    <Button
                      key={log.id}
                      variant={originLogId === log.id ? "default" : "ghost"}
                      className={`justify-start gap-2 h-auto py-2 ${originLogId === log.id ? "" : "hover:bg-secondary"}`}
                      style={{ paddingLeft: `${(log.depth || 0) * 16 + 8}px` }}
onClick={async () => {
                            setOriginLogId(log.id)
                            const foundLog = findLog(log.id)
                            if (foundLog) setAnalyzingLog(foundLog)
                            
// If we have a pending canId to find, search for it in the selected log
                            if (pendingCanIdToFind && missionId) {
                              try {
                                const response = await getLogContent(missionId, log.id, 1000)
                                const frames = response.frames
                                // Normalize canId for comparison (remove 0x prefix, uppercase)
                                const normalizeCanId = (id: string | undefined) => {
                                  if (!id) return ""
                                  return id.replace(/^0x/i, "").toUpperCase()
                                }
                                const targetCanId = normalizeCanId(pendingCanIdToFind.canId)
                                
                                const matchingFrame = frames.find(f => {
                                  const frameCanId = normalizeCanId(f.canId)
                                  return frameCanId === targetCanId
                                })
                                
                                if (matchingFrame) {
                                  setSelectedFrame(matchingFrame)
                                  setPendingCanIdToFind(null)
                                }
                              } catch {
                                // Ignore errors
                              }
                            }
                          }}
                    >
                      {(log.depth || 0) > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
                      <FileText className="h-4 w-4 shrink-0" />
                      <span className="truncate text-sm font-mono">{log.name}</span>
                    </Button>
                  )) : (
                    <p className="text-sm text-muted-foreground p-4 text-center">Aucun log disponible. Importez d&apos;abord un log.</p>
                  )}
                </div>
                {pendingCanIdToFind && !selectedFrame && (
                  <div className="p-2 rounded bg-amber-500/10 border border-amber-500/30 text-xs mb-2">
                    <span className="text-amber-500">Recherche automatique de la trame </span>
                    <span className="font-mono font-semibold text-amber-400">{pendingCanIdToFind.canId}</span>
                    <span className="text-amber-500"> dans le log selectionne</span>
                  </div>
                )}
                {originLogId && (
                  <div className="flex flex-col gap-3 pt-4 border-t">
                    <div className="flex items-center gap-4">
                      <span className="text-sm text-muted-foreground">Log selectionne: <span className="font-mono font-medium">{originLogId}</span></span>
                    </div>
                    {selectedFrame ? (
                      <div className="flex items-center gap-4">
                        <span className="text-sm text-muted-foreground">Trame cible: <Badge className="font-mono">{selectedFrame.canId}</Badge> @ {selectedFrame.timestamp}</span>
                        <Button 
                          onClick={async () => {
                            setIsAnalyzing(true)
                            try {
                              const result = await analyzeCoOccurrence(missionId!, originLogId, {
                                logId: originLogId,
                                targetCanId: selectedFrame.canId,
                                targetTimestamp: parseFloat(selectedFrame.timestamp),
                                windowMs: analysisWindowMs,
                                direction: analysisDirection,
                              })
                              setCoOccurrenceResult(result)
                              setCoOccStep("results")
                            } catch (error) {
                              console.error("[v0] Co-occurrence analysis error:", error)
                            } finally {
                              setIsAnalyzing(false)
                            }
                          }}
                          disabled={isAnalyzing}
                          className="gap-2"
                        >
                          {isAnalyzing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                          Analyser les co-occurrences
                        </Button>
                      </div>
                    ) : (
                      <p className="text-sm text-amber-500">Aucune trame cible selectionnee. Retournez a l&apos;arbre et selectionnez une trame dans un log d&apos;abord.</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
      
      {/* Family Diff Analysis Dialog */}
      <Dialog open={showFamilyDiff} onOpenChange={setShowFamilyDiff}>
        <DialogContent 
          className="overflow-hidden flex flex-col"
          style={{ width: "98vw", maxWidth: "1400px", height: "92vh", maxHeight: "950px" }}
        >
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <FlaskConical className="h-5 w-5 text-primary" />
              Qualifier la famille - Diff AVANT/APRES
            </DialogTitle>
            <DialogDescription>
              Comparez les payloads avant et apres l&apos;action pour classifier les trames (STATUS, ACK, INFO)
            </DialogDescription>
          </DialogHeader>
          
          {/* Time window selection with t0 reference */}
          {!familyDiffResult && coOccurrenceResult && (
            <div className="space-y-4 py-4">
              {/* t0 reference info */}
              <div className="flex items-center gap-3 p-3 rounded-lg bg-primary/10 border border-primary/30">
                <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary text-primary-foreground font-bold text-sm">t0</div>
                <div>
                  <p className="text-sm font-medium">Trame causale: <span className="font-mono">{coOccurrenceResult.targetFrame.canId}</span></p>
                  <p className="text-xs text-muted-foreground font-mono">Timestamp: {coOccurrenceResult.targetFrame.timestamp.toFixed(6)}s</p>
                </div>
              </div>
              
              {/* Mini timeline visualization */}
              <div className="relative h-12 bg-secondary/30 rounded-lg overflow-hidden">
                {/* Timeline axis */}
                <div className="absolute top-1/2 left-0 right-0 h-0.5 bg-border -translate-y-1/2" />
                
                {/* t0 marker */}
                <div className="absolute top-0 bottom-0 left-1/2 w-0.5 bg-primary -translate-x-1/2 z-10" />
                <div className="absolute top-1 left-1/2 -translate-x-1/2 text-[10px] font-bold text-primary">t0</div>
                
                {/* AVANT window */}
                <div 
                  className="absolute top-1/2 h-4 bg-muted-foreground/30 rounded -translate-y-1/2"
                  style={{ 
                    left: `calc(50% + ${beforeOffsetMs[0] / 20}px)`, 
                    width: `${(beforeOffsetMs[1] - beforeOffsetMs[0]) / 20}px` 
                  }}
                />
                
                {/* ACK window */}
                <div 
                  className="absolute top-1/2 h-4 bg-primary/50 rounded -translate-y-1/2"
                  style={{ 
                    left: `calc(50% + ${ackOffsetMs[0] / 20}px)`, 
                    width: `${(ackOffsetMs[1] - ackOffsetMs[0]) / 20}px` 
                  }}
                />
                
                {/* STATUS window */}
                <div 
                  className="absolute top-1/2 h-4 bg-success/50 rounded -translate-y-1/2"
                  style={{ 
                    left: `calc(50% + ${statusOffsetMs[0] / 20}px)`, 
                    width: `${Math.min((statusOffsetMs[1] - statusOffsetMs[0]) / 20, 100)}px` 
                  }}
                />
                
                {/* Labels */}
                <div className="absolute bottom-0.5 left-[20%] text-[9px] text-muted-foreground">AVANT</div>
                <div className="absolute bottom-0.5 left-[52%] text-[9px] text-primary">ACK</div>
                <div className="absolute bottom-0.5 left-[65%] text-[9px] text-success">STATUS</div>
              </div>
              
              {/* 3 windows configuration */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {/* AVANT */}
                <div className="p-3 rounded-lg border bg-secondary/30">
                  <Label className="text-xs font-medium text-muted-foreground">AVANT (baseline)</Label>
                  <div className="flex items-center gap-1 mt-2">
                    <Input 
                      type="number" 
                      value={beforeOffsetMs[0]}
                      onChange={(e) => setBeforeOffsetMs([parseInt(e.target.value) || -500, beforeOffsetMs[1]])}
                      className="h-8 text-xs font-mono w-20"
                    />
                    <span className="text-xs">a</span>
                    <Input 
                      type="number" 
                      value={beforeOffsetMs[1]}
                      onChange={(e) => setBeforeOffsetMs([beforeOffsetMs[0], parseInt(e.target.value) || -50])}
                      className="h-8 text-xs font-mono w-20"
                    />
                    <span className="text-xs text-muted-foreground">ms</span>
                  </div>
                </div>
                
                {/* ACK */}
                <div className="p-3 rounded-lg border bg-primary/10 border-primary/30">
                  <Label className="text-xs font-medium text-primary">ACK (transitoire)</Label>
                  <div className="flex items-center gap-1 mt-2">
                    <Input 
                      type="number" 
                      value={ackOffsetMs[0]}
                      onChange={(e) => setAckOffsetMs([parseInt(e.target.value) || 0, ackOffsetMs[1]])}
                      className="h-8 text-xs font-mono w-20"
                    />
                    <span className="text-xs">a</span>
                    <Input 
                      type="number" 
                      value={ackOffsetMs[1]}
                      onChange={(e) => setAckOffsetMs([ackOffsetMs[0], parseInt(e.target.value) || 100])}
                      className="h-8 text-xs font-mono w-20"
                    />
                    <span className="text-xs text-muted-foreground">ms</span>
                  </div>
                </div>
                
                {/* STATUS */}
                <div className="p-3 rounded-lg border bg-success/10 border-success/30">
                  <Label className="text-xs font-medium text-success">STATUS (persistant)</Label>
                  <div className="flex items-center gap-1 mt-2">
                    <Input 
                      type="number" 
                      value={statusOffsetMs[0]}
                      onChange={(e) => setStatusOffsetMs([parseInt(e.target.value) || 200, statusOffsetMs[1]])}
                      className="h-8 text-xs font-mono w-20"
                    />
                    <span className="text-xs">a</span>
                    <Input 
                      type="number" 
                      value={statusOffsetMs[1]}
                      onChange={(e) => setStatusOffsetMs([statusOffsetMs[0], parseInt(e.target.value) || 1500])}
                      className="h-8 text-xs font-mono w-20"
                    />
                    <span className="text-xs text-muted-foreground">ms</span>
                  </div>
                </div>
              </div>
              
              {/* Info and actions */}
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary" className="font-mono">{selectedFamilyIds.length} IDs a analyser</Badge>
                <Button variant="outline" size="sm" className="h-7 text-xs bg-transparent" onClick={resetToDefaultPresets}>
                  Valeurs par defaut
                </Button>
              </div>
              
              <Button 
                onClick={runFamilyDiffAnalysis}
                disabled={isAnalyzingFamily}
                className="gap-2"
              >
                {isAnalyzingFamily ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />}
                Analyser (3 fenetres)
              </Button>
            </div>
          )}
          
          {/* Results */}
          {familyDiffResult && (
            <div className="flex-1 overflow-hidden flex flex-col gap-4">
              {/* Summary */}
              <div className="flex flex-wrap items-center gap-3 p-3 rounded-lg bg-secondary/50">
                <span className="text-sm font-medium">{familyDiffResult.family_name}</span>
                <Badge variant="default" className="bg-success text-success-foreground">
                  {familyDiffResult.summary.status} STATUS
                </Badge>
                <Badge variant="default" className="bg-primary">
                  {familyDiffResult.summary.ack} ACK
                </Badge>
                <Badge variant="secondary">
                  {familyDiffResult.summary.info} INFO
                </Badge>
                <Badge variant="outline" className="bg-transparent">
                  {familyDiffResult.summary.unchanged} inchange
                </Badge>
                
                <div className="ml-auto flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Vue:</span>
                  <Button 
                    size="sm" 
                    variant={diffViewMode === "bytes" ? "default" : "outline"} 
                    className={`h-7 px-2 text-xs ${diffViewMode === "outline" ? "bg-transparent" : ""}`}
                    onClick={() => setDiffViewMode("bytes")}
                  >
                    Octets
                  </Button>
                  <Button 
                    size="sm" 
                    variant={diffViewMode === "bits" ? "default" : "outline"} 
                    className={`h-7 px-2 text-xs ${diffViewMode === "outline" ? "bg-transparent" : ""}`}
                    onClick={() => setDiffViewMode("bits")}
                  >
                    Bits
                  </Button>
                </div>
              </div>
              
              <div className="flex-1 overflow-hidden flex gap-4 min-h-0">
                {/* Frame list with confidence scores */}
                <div className="w-80 shrink-0 overflow-auto border rounded-lg">
                  {familyDiffResult.frames_analysis.map((frame, idx) => (
                    <div
                      key={idx}
                      className={`p-2 border-b cursor-pointer transition-colors ${selectedDiffFrame?.can_id === frame.can_id ? "bg-primary/20" : "hover:bg-secondary/50"}`}
                      onClick={() => setSelectedDiffFrame(frame)}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-semibold">{frame.can_id}</span>
                        <Badge 
                          variant={frame.classification === "status" ? "default" : frame.classification === "ack" ? "default" : "secondary"}
                          className={`text-[10px] ${frame.classification === "status" ? "bg-success text-success-foreground" : frame.classification === "ack" ? "bg-primary" : ""}`}
                        >
                          {frame.classification}
                        </Badge>
                        <span className="text-[10px] text-muted-foreground ml-auto">{frame.confidence.toFixed(0)}%</span>
                      </div>
                      <div className="flex items-center justify-between text-xs text-muted-foreground mt-1">
                        <span>{frame.bytes_diff.length} octet(s)</span>
                        {frame.persistence === "persistent" && <span className="text-success">persistant</span>}
                        {frame.persistence === "transient" && <span className="text-primary">transitoire</span>}
                      </div>
                      <div className="flex items-center gap-1 text-[10px] text-muted-foreground mt-1">
                        <span>Av:{frame.count_before}</span>
                        <span>Ack:{frame.count_ack}</span>
                        <span>St:{frame.count_status}</span>
                      </div>
                    </div>
                  ))}
                </div>
                
                {/* Diff view */}
                <div className="flex-1 overflow-auto border rounded-lg p-4">
                  {selectedDiffFrame ? (
                    <div className="space-y-4">
                      <div className="flex flex-wrap items-center gap-3">
                        <h4 className="font-mono text-lg font-semibold">{selectedDiffFrame.can_id}</h4>
                        <Badge className={`${selectedDiffFrame.classification === "status" ? "bg-success text-success-foreground" : selectedDiffFrame.classification === "ack" ? "bg-primary" : ""}`}>
                          {selectedDiffFrame.classification}
                        </Badge>
                        <Badge variant="outline" className="bg-transparent font-normal">
                          {selectedDiffFrame.confidence.toFixed(0)}% confiance
                        </Badge>
                        {selectedDiffFrame.persistence === "persistent" && (
                          <Badge variant="outline" className="bg-transparent text-success border-success/50">Persistant</Badge>
                        )}
                        {selectedDiffFrame.persistence === "transient" && (
                          <Badge variant="outline" className="bg-transparent text-primary border-primary/50">Transitoire</Badge>
                        )}
                      </div>
                      
                      {/* Frame counts per window */}
                      <div className="flex items-center gap-4 text-xs text-muted-foreground">
                        <span>AVANT: {selectedDiffFrame.count_before} trames</span>
                        <span>ACK: {selectedDiffFrame.count_ack} trames</span>
                        <span>STATUS: {selectedDiffFrame.count_status} trames</span>
                      </div>
                      
                      {/* 3-line diff like cansniffer */}
                      <div className="space-y-2 p-3 rounded-lg bg-secondary/30">
                        <div className="flex items-center gap-2">
                          <span className="w-16 text-xs text-muted-foreground shrink-0">AVANT:</span>
                          <div className="flex gap-1 font-mono text-sm">
                            {selectedDiffFrame.sample_before !== "N/A" ? selectedDiffFrame.sample_before.match(/.{1,2}/g)?.map((byte, i) => {
                              const changed = selectedDiffFrame.bytes_diff.some(d => d.byte_index === i)
                              return (
                                <span 
                                  key={i} 
                                  className={`px-1 rounded ${changed ? "bg-muted-foreground/30" : ""}`}
                                >
                                  {byte}
                                </span>
                              )
                            }) : <span className="text-muted-foreground italic">N/A</span>}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="w-16 text-xs text-primary shrink-0">ACK:</span>
                          <div className="flex gap-1 font-mono text-sm">
                            {selectedDiffFrame.sample_ack !== "N/A" ? selectedDiffFrame.sample_ack.match(/.{1,2}/g)?.map((byte, i) => {
                              const beforeByte = selectedDiffFrame.sample_before.match(/.{1,2}/g)?.[i] || "00"
                              const changed = byte !== beforeByte
                              return (
                                <span 
                                  key={i} 
                                  className={`px-1 rounded ${changed ? "bg-primary/30 text-primary font-semibold" : ""}`}
                                >
                                  {byte}
                                </span>
                              )
                            }) : <span className="text-muted-foreground italic">N/A</span>}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="w-16 text-xs text-success shrink-0">STATUS:</span>
                          <div className="flex gap-1 font-mono text-sm">
                            {selectedDiffFrame.sample_status !== "N/A" ? selectedDiffFrame.sample_status.match(/.{1,2}/g)?.map((byte, i) => {
                              const beforeByte = selectedDiffFrame.sample_before.match(/.{1,2}/g)?.[i] || "00"
                              const changed = byte !== beforeByte
                              return (
                                <span 
                                  key={i} 
                                  className={`px-1 rounded ${changed ? "bg-success/30 text-success font-semibold" : ""}`}
                                >
                                  {byte}
                                </span>
                              )
                            }) : <span className="text-muted-foreground italic">N/A</span>}
                          </div>
                        </div>
                      </div>
                      
                      {/* Detailed byte/bit changes */}
                      {selectedDiffFrame.bytes_diff.length > 0 && (
                        <div className="mt-4 space-y-2">
                          <h5 className="text-sm font-medium">Octets modifies - Cliquez pour creer un signal</h5>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            {selectedDiffFrame.bytes_diff.map((diff, idx) => {
                              const analysisInfo = {
                                valueBefore: diff.value_before,
                                valueAfter: diff.value_after,
                                classification: selectedDiffFrame.classification,
                                persistence: selectedDiffFrame.persistence || "unknown",
                                sampleBefore: selectedDiffFrame.sample_before,
                                sampleAck: selectedDiffFrame.sample_ack,
                                sampleStatus: selectedDiffFrame.sample_status,
                              }
                              return (
                              <div 
                                key={idx} 
                                className="p-3 rounded-lg border bg-secondary/30 hover:bg-secondary/50 cursor-pointer transition-colors"
                                onClick={() => handleCreateSignal(selectedDiffFrame.can_id, diff.byte_index, undefined, analysisInfo)}
                              >
                                <div className="flex items-center justify-between mb-2">
                                  <span className="text-xs font-medium">Octet {diff.byte_index}</span>
                                  <Button size="sm" variant="ghost" className="h-6 px-2 text-xs text-primary bg-transparent">
                                    + Signal
                                  </Button>
                                </div>
                                <div className="text-xs text-muted-foreground mb-1">
                                  Octet {diff.byte_index} detecte comme changeant:
                                </div>
                                <div className="flex items-center gap-2 text-sm font-mono">
                                  <span className="text-destructive">{diff.value_before}</span>
                                  <ChevronRight className="h-3 w-3" />
                                  <span className="text-success">{diff.value_after}</span>
                                </div>
                                {diffViewMode === "bits" && diff.changed_bits.length > 0 && (
                                  <div className="mt-2 flex gap-1">
                                    {[7, 6, 5, 4, 3, 2, 1, 0].map(bit => {
                                      const changed = diff.changed_bits.includes(bit)
                                      return (
                                        <span 
                                          key={bit} 
                                          className={`w-5 h-5 flex items-center justify-center text-[10px] rounded cursor-pointer ${changed ? "bg-primary text-primary-foreground hover:bg-primary/80" : "bg-muted text-muted-foreground"}`}
                                          onClick={(e) => {
                                            e.stopPropagation()
                                            if (changed) handleCreateSignal(selectedDiffFrame.can_id, diff.byte_index, bit, analysisInfo)
                                          }}
                                        >
                                          {bit}
                                        </span>
                                      )
                                    })}
                                  </div>
                                )}
                              </div>
                            )})}
                          </div>
                        </div>
                      )}
                      
                      {selectedDiffFrame.bytes_diff.length === 0 && (
                        <p className="text-sm text-muted-foreground">Aucun changement detecte sur cette trame.</p>
                      )}
                    </div>
                  ) : (
                    <p className="text-muted-foreground">Selectionnez une trame pour voir le diff</p>
                  )}
                </div>
              </div>
              
              {/* Actions */}
              <div className="flex flex-wrap items-center gap-2 pt-2 border-t">
                <Button variant="outline" className="bg-transparent" onClick={() => {
                  // Close family diff and go back to co-occurrence analysis
                  setShowFamilyDiff(false)
                  setFamilyDiffResult(null)
                  setCoOccStep("select")
                  // Re-open co-occurrence dialog with current log
                  if (originLogId) {
                    const log = logs.find(l => l.name.replace(".log", "") === originLogId)
                    if (log) setAnalyzingLog(log)
                  }
                }}>
                  Nouvelle analyse
                </Button>
                <Button 
                  variant="default" 
                  className="gap-1"
                  onClick={() => {
                    // Send all 3 frame states (AVANT, ACK, STATUS) to Replay Rapide
                    const qualifiedFrames = familyDiffResult.frames_analysis
                      .filter(f => f.classification === "status" || f.classification === "ack")
                    if (qualifiedFrames.length > 0) {
                      const framesToSend: Array<{canId: string, data: string, timestamp: string, source: string}> = []
                      qualifiedFrames.forEach(f => {
                        // Helper to clean payload (remove spaces, handle N/A)
                        const cleanPayload = (p: string) => p && p !== "N/A" ? p.replace(/\s/g, "") : null
                        
                        const avant = cleanPayload(f.sample_before)
                        const ack = cleanPayload(f.sample_ack)
                        const status = cleanPayload(f.sample_status)
                        
                        // Add AVANT frame
                        if (avant) {
                          framesToSend.push({
                            canId: f.can_id,
                            data: avant,
                            timestamp: "0",
                            source: `${f.can_id}-AVANT`,
                          })
                        }
                        // Add ACK frame if different from AVANT
                        if (ack && ack !== avant) {
                          framesToSend.push({
                            canId: f.can_id,
                            data: ack,
                            timestamp: "0",
                            source: `${f.can_id}-ACK`,
                          })
                        }
                        // Add STATUS frame if different from AVANT and ACK
                        if (status && status !== avant && status !== ack) {
                          framesToSend.push({
                            canId: f.can_id,
                            data: status,
                            timestamp: "0",
                            source: `${f.can_id}-STATUS`,
                          })
                        }
                      })
                      if (framesToSend.length > 0) {
                        addFrames(framesToSend)
                        setShowFamilyDiff(false)
                        navRouter.push("/replay-rapide")
                      }
                    }
                  }}
                  disabled={!familyDiffResult.frames_analysis.some(f => f.classification === "status" || f.classification === "ack")}
                >
                  <Send className="h-4 w-4" />
                  Envoyer vers Replay Rapide
                </Button>
                {missionId && (
                  <Button variant="outline" className="bg-transparent gap-1" asChild>
                    <a href={getDBCExportUrl(missionId)} download>
                      <Download className="h-4 w-4" />
                      Exporter DBC
                    </a>
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
      
      {/* Signal Editor Dialog */}
      <Dialog open={showSignalEditor} onOpenChange={setShowSignalEditor}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Creer un signal DBC</DialogTitle>
            <DialogDescription>
              Definissez les proprietes du signal pour l&apos;export DBC
            </DialogDescription>
          </DialogHeader>
          
          {editingSignal && (
            <div className="space-y-4 py-4">
              {/* Analysis info banner */}
              {editingSignal.comment && editingSignal.comment.includes("->") && (
                <div className="p-3 rounded-lg bg-primary/10 border border-primary/20">
                  <p className="text-sm font-medium text-primary">{editingSignal.comment}</p>
                </div>
              )}
              
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>CAN ID</Label>
                  <Input value={editingSignal.can_id} disabled className="font-mono" />
                </div>
                <div className="space-y-2">
                  <Label>Nom du signal</Label>
                  <Input 
                    value={editingSignal.name || ""} 
                    onChange={(e) => setEditingSignal(prev => prev ? {...prev, name: e.target.value} : null)}
                    placeholder="SIG_NAME"
                  />
                </div>
              </div>
              
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label>Start bit</Label>
                  <Input 
                    type="number" 
                    value={editingSignal.start_bit ?? 0} 
                    onChange={(e) => setEditingSignal(prev => prev ? {...prev, start_bit: parseInt(e.target.value)} : null)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Longueur (bits)</Label>
                  <Input 
                    type="number" 
                    value={editingSignal.length ?? 8} 
                    onChange={(e) => setEditingSignal(prev => prev ? {...prev, length: parseInt(e.target.value)} : null)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Byte order</Label>
                  <Select 
                    value={editingSignal.byte_order || "little_endian"} 
                    onValueChange={(v) => setEditingSignal(prev => prev ? {...prev, byte_order: v as "little_endian" | "big_endian"} : null)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="little_endian">Little Endian</SelectItem>
                      <SelectItem value="big_endian">Big Endian</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div className="space-y-2">
                  <Label>Scale</Label>
                  <Input 
                    type="number" 
                    step="0.001"
                    value={editingSignal.scale ?? 1} 
                    onChange={(e) => setEditingSignal(prev => prev ? {...prev, scale: parseFloat(e.target.value)} : null)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Offset</Label>
                  <Input 
                    type="number" 
                    value={editingSignal.offset ?? 0} 
                    onChange={(e) => setEditingSignal(prev => prev ? {...prev, offset: parseFloat(e.target.value)} : null)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Min</Label>
                  <Input 
                    type="number" 
                    value={editingSignal.min_val ?? 0} 
                    onChange={(e) => setEditingSignal(prev => prev ? {...prev, min_val: parseFloat(e.target.value)} : null)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Max</Label>
                  <Input 
                    type="number" 
                    value={editingSignal.max_val ?? 255} 
                    onChange={(e) => setEditingSignal(prev => prev ? {...prev, max_val: parseFloat(e.target.value)} : null)}
                  />
                </div>
              </div>
              
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Unite</Label>
                  <Input 
                    value={editingSignal.unit || ""} 
                    onChange={(e) => setEditingSignal(prev => prev ? {...prev, unit: e.target.value} : null)}
                    placeholder="km/h, %, etc."
                  />
                </div>
                <div className="space-y-2 flex items-end gap-2">
                  <div className="flex items-center gap-2">
                    <input 
                      type="checkbox" 
                      id="is-signed"
                      checked={editingSignal.is_signed || false}
                      onChange={(e) => setEditingSignal(prev => prev ? {...prev, is_signed: e.target.checked} : null)}
                      className="rounded"
                    />
                    <Label htmlFor="is-signed">Signe</Label>
                  </div>
                </div>
              </div>
              
              <div className="space-y-2">
                <Label>Commentaire</Label>
                <Input 
                  value={editingSignal.comment || ""} 
                  onChange={(e) => setEditingSignal(prev => prev ? {...prev, comment: e.target.value} : null)}
                  placeholder="Description du signal..."
                />
              </div>
              
              <div className="flex justify-end gap-2 pt-4">
                <Button variant="outline" className="bg-transparent" onClick={() => setShowSignalEditor(false)}>
                  Annuler
                </Button>
                <Button onClick={handleSaveSignal}>
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                  Enregistrer
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </AppShell>
  )
}
