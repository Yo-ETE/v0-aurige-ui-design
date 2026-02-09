"use client"

import { useState, useEffect, useMemo } from "react"
import { AppShell } from "@/components/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  GitCompare,
  ArrowLeftRight,
  Loader2,
  Play,
  Send,
  FileCode,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  AlertCircle,
  MinusCircle,
  PlusCircle,
  Save,
  Trash2,
  FolderOpen,
  Plus,
  ArrowLeft,
  Clock,
  Shield,
  TrendingUp,
  ArrowUpDown,
  Info,
  Zap,
  Filter,
} from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Label } from "@/components/ui/label"
import {
  compareLogs,
  listMissionLogs,
  sendCANFrame,
  addDBCSignal,
  listComparisons,
  getComparison,
  saveComparison,
  deleteComparison,
  type CompareLogsResponse,
  type CompareFrameDiff,
  type LogEntry,
  type SavedComparisonSummary,
} from "@/lib/api"
import { useMissionStore } from "@/lib/mission-store"
import { useExportStore } from "@/lib/export-store"
import { useRouter } from "next/navigation"
import { useToast } from "@/hooks/use-toast"
import { LogImportButton } from "@/components/log-import-button"

// Tree node type for hierarchical logs
interface LogTreeNode extends LogEntry {
  children: LogTreeNode[]
}

function buildLogTree(logs: LogEntry[]): LogTreeNode[] {
  const logMap = new Map<string, LogTreeNode>()
  const roots: LogTreeNode[] = []
  logs.forEach(log => logMap.set(log.id, { ...log, children: [] }))
  logs.forEach(log => {
    const node = logMap.get(log.id)!
    if (log.parentId && logMap.has(log.parentId)) {
      logMap.get(log.parentId)!.children.push(node)
    } else {
      roots.push(node)
    }
  })
  const sortNodes = (nodes: LogTreeNode[]) => {
    nodes.sort((a, b) => a.filename.localeCompare(b.filename))
    nodes.forEach(n => sortNodes(n.children))
  }
  sortNodes(roots)
  return roots
}

function LogSelectItem({ log, depth, disabledId }: { log: LogTreeNode; depth: number; disabledId: string }) {
  return (
    <>
      <SelectItem key={log.id} value={log.id} disabled={log.id === disabledId} className="pl-2">
        <span style={{ paddingLeft: `${depth * 16}px` }} className="flex items-center gap-1">
          {depth > 0 && <span className="text-muted-foreground">{"\u2514"}</span>}
          {log.filename}
        </span>
      </SelectItem>
      {log.children.map(child => (
        <LogSelectItem key={child.id} log={child} depth={depth + 1} disabledId={disabledId} />
      ))}
    </>
  )
}

type ViewMode = "list" | "new" | "view"

export default function ComparaisonPage() {
  const router = useRouter()
  const { toast } = useToast()
  const currentMissionId = useMissionStore((state) => state.currentMissionId)
  const missions = useMissionStore((state) => state.missions)
  const { addFrames } = useExportStore()

  const [missionId, setMissionId] = useState<string>("")
  const [missionResolved, setMissionResolved] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>("list")

  // Saved comparisons
  const [savedComparisons, setSavedComparisons] = useState<SavedComparisonSummary[]>([])
  const [isLoadingSaved, setIsLoadingSaved] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // Log selection (new comparison)
  const [missionLogs, setMissionLogs] = useState<LogEntry[]>([])
  const [logAId, setLogAId] = useState<string>("")
  const [logBId, setLogBId] = useState<string>("")
  const [isLoadingLogs, setIsLoadingLogs] = useState(false)

  // Comparison results (new or loaded)
  const [comparisonResult, setComparisonResult] = useState<CompareLogsResponse | null>(null)
  const [isComparing, setIsComparing] = useState(false)
  const [expandedFrames, setExpandedFrames] = useState<Set<string>>(new Set())
  const [currentComparisonName, setCurrentComparisonName] = useState<string>("")
  const [currentComparisonId, setCurrentComparisonId] = useState<string | null>(null)

  // Save dialog
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [saveName, setSaveName] = useState("")
  const [isSaving, setIsSaving] = useState(false)

  // Actions
  const [sendingFrame, setSendingFrame] = useState<string | null>(null)
  const [canInterface, setCanInterface] = useState<"can0" | "can1" | "vcan0">("can0")
  // Replay rare exclusifs
  const [sendingRareKey, setSendingRareKey] = useState<string | null>(null)
  const [sentRareKey, setSentRareKey] = useState<string | null>(null)
  const [replayingAllKey, setReplayingAllKey] = useState<string | null>(null)

  // Sort mode for results
  const [sortMode, setSortMode] = useState<"stability" | "confidence" | "classification" | "command">("stability")
  // Filters for command mode
  const [filterExclusiveOnly, setFilterExclusiveOnly] = useState(false)
  const [rareThreshold, setRareThreshold] = useState(1)

  const logTree = buildLogTree(missionLogs)

  const sortedFrames = useMemo(() => {
    if (!comparisonResult) return []
    let frames = [...comparisonResult.frames]
    
    // Filtre: seulement les IDs avec des rares exclusifs
    if (filterExclusiveOnly) {
      frames = frames.filter(f => 
        (f.exclusive_rare_a?.length ?? 0) > 0 || (f.exclusive_rare_b?.length ?? 0) > 0
      )
    }
    
    return frames.sort((a, b) => {
      if (sortMode === "command") {
        // Tri par commandScore descroissant, puis par classification
        const scoreA = a.command_score ?? 0
        const scoreB = b.command_score ?? 0
        if (scoreA !== scoreB) return scoreB - scoreA
        const prio: Record<string, number> = { differential: 0, only_a: 1, only_b: 2, identical: 3 }
        return (prio[a.classification] ?? 4) - (prio[b.classification] ?? 4)
      }
      if (sortMode === "stability") {
        const priorityA = a.classification === "differential" ? 0 : a.classification === "only_a" ? 1 : a.classification === "only_b" ? 2 : 3
        const priorityB = b.classification === "differential" ? 0 : b.classification === "only_a" ? 1 : b.classification === "only_b" ? 2 : 3
        if (priorityA !== priorityB) return priorityA - priorityB
        return (b.stability_score ?? 0) - (a.stability_score ?? 0)
      }
      if (sortMode === "confidence") return b.confidence - a.confidence
      const prio: Record<string, number> = { differential: 0, only_a: 1, only_b: 2, identical: 3 }
      return (prio[a.classification] ?? 4) - (prio[b.classification] ?? 4)
    })
  }, [comparisonResult, sortMode, filterExclusiveOnly])

  useEffect(() => {
    const localId = sessionStorage.getItem("activeMissionId")
    const effectiveMissionId = localId || currentMissionId
    if (effectiveMissionId) {
      setMissionId(effectiveMissionId)
    }
    // Mark as resolved after checking - whether we found a mission or not
    setMissionResolved(true)
  }, [currentMissionId])

  useEffect(() => {
    if (missionId) {
      loadSavedComparisons()
      loadLogs()
    } else {
      // Reset when no mission
      setSavedComparisons([])
      setMissionLogs([])
      setComparisonResult(null)
      setViewMode("list")
    }
  }, [missionId])

  const loadSavedComparisons = async () => {
    if (!missionId) return
    setIsLoadingSaved(true)
    try {
      const list = await listComparisons(missionId)
      setSavedComparisons(list)
    } catch {
      // Silently fail - may not have any saved comparisons
    } finally {
      setIsLoadingSaved(false)
    }
  }

  const loadLogs = async () => {
    if (!missionId) return
    setIsLoadingLogs(true)
    try {
      const logs = await listMissionLogs(missionId)
      setMissionLogs(logs)
    } catch {
      toast({ title: "Erreur", description: "Impossible de charger les logs", variant: "destructive" })
    } finally {
      setIsLoadingLogs(false)
    }
  }

  const handleCompare = async () => {
    if (!missionId || !logAId || !logBId) return
    setIsComparing(true)
    setComparisonResult(null)
    setCurrentComparisonId(null)
    try {
      const result = await compareLogs(missionId, logAId, logBId)
      setComparisonResult(result)
      setExpandedFrames(new Set())
      const logAName = missionLogs.find(l => l.id === logAId)?.filename || logAId
      const logBName = missionLogs.find(l => l.id === logBId)?.filename || logBId
      setCurrentComparisonName(`${logAName} vs ${logBName}`)
      setViewMode("view")
    } catch {
      toast({ title: "Erreur", description: "Echec de la comparaison", variant: "destructive" })
    } finally {
      setIsComparing(false)
    }
  }

  const handleOpenSaved = async (comp: SavedComparisonSummary) => {
    try {
      const full = await getComparison(missionId, comp.id)
      setComparisonResult(full.result)
      setCurrentComparisonName(full.name)
      setCurrentComparisonId(full.id)
      setLogAId(full.log_a_id)
      setLogBId(full.log_b_id)
      setExpandedFrames(new Set())
      setViewMode("view")
    } catch {
      toast({ title: "Erreur", description: "Impossible de charger la comparaison", variant: "destructive" })
    }
  }

  const handleSave = async () => {
    if (!missionId || !comparisonResult || !saveName.trim()) return
    setIsSaving(true)
    try {
      const logAName = missionLogs.find(l => l.id === logAId)?.filename || logAId
      const logBName = missionLogs.find(l => l.id === logBId)?.filename || logBId
      const saved = await saveComparison(missionId, saveName.trim(), logAId, logAName, logBId, logBName, comparisonResult)
      setCurrentComparisonId(saved.id)
      setCurrentComparisonName(saved.name)
      setShowSaveDialog(false)
      setSaveName("")
      toast({ title: "Sauvegardee", description: `Comparaison "${saved.name}" enregistree` })
      loadSavedComparisons()
    } catch {
      toast({ title: "Erreur", description: "Echec de la sauvegarde", variant: "destructive" })
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async (compId: string) => {
    setDeletingId(compId)
    try {
      await deleteComparison(missionId, compId)
      setSavedComparisons(prev => prev.filter(c => c.id !== compId))
      if (currentComparisonId === compId) {
        setComparisonResult(null)
        setCurrentComparisonId(null)
        setViewMode("list")
      }
      toast({ title: "Supprimee", description: "Comparaison supprimee" })
    } catch {
      toast({ title: "Erreur", description: "Echec de la suppression", variant: "destructive" })
    } finally {
      setDeletingId(null)
    }
  }

  const handleStartNew = () => {
    setLogAId("")
    setLogBId("")
    setComparisonResult(null)
    setCurrentComparisonId(null)
    setCurrentComparisonName("")
    setExpandedFrames(new Set())
    setViewMode("new")
  }

  // Envoyer une trame rare individuelle sur le CAN
  const handleSendRarePayload = async (canId: string, payload: string, key: string) => {
    setSendingRareKey(key)
    setSentRareKey(null)
    try {
      await sendCANFrame({ interface: canInterface, canId, data: payload.replace(/\s/g, "") })
      setSentRareKey(key)
      setTimeout(() => setSentRareKey(prev => prev === key ? null : prev), 2000)
    } catch {
      toast({ title: "Erreur", description: `Echec envoi ${canId}#${payload}`, variant: "destructive" })
    } finally {
      setSendingRareKey(null)
    }
  }

  // Rejouer toutes les trames rares d'un log (A ou B) sequentiellement avec 50ms de delai
  const handleReplayAllRare = async (canId: string, rares: Array<{payload: string, count: number}>, logLabel: string) => {
    const key = `all-${canId}-${logLabel}`
    setReplayingAllKey(key)
    let sent = 0
    try {
      for (const rp of rares) {
        await sendCANFrame({ interface: canInterface, canId, data: rp.payload.replace(/\s/g, "") })
        sent++
        // Petit delai entre chaque trame
        await new Promise(r => setTimeout(r, 50))
      }
      toast({ title: "Replay termine", description: `${sent}/${rares.length} trames ${logLabel} envoyees sur ${canInterface}` })
    } catch {
      toast({ title: "Erreur", description: `Arret apres ${sent}/${rares.length} trames`, variant: "destructive" })
    } finally {
      setReplayingAllKey(null)
    }
  }

  const handleSendFrame = async (frame: CompareFrameDiff, usePayloadA: boolean) => {
    setSendingFrame(frame.can_id)
    try {
      const payload = usePayloadA ? frame.payload_a : frame.payload_b
      await sendCANFrame({ interface: canInterface, canId: frame.can_id, data: payload })
      toast({ title: "Envoyee", description: `Trame ${frame.can_id} envoyee sur ${canInterface}` })
    } catch {
      toast({ title: "Erreur", description: "Echec de l'envoi", variant: "destructive" })
    } finally {
      setSendingFrame(null)
    }
  }

  const handleSendToReplay = (frame: CompareFrameDiff) => {
    const frames = []
    if (frame.payload_a) {
      frames.push({ canId: frame.can_id, data: frame.payload_a, timestamp: "0", source: `compare-A` })
    }
    if (frame.payload_b && frame.payload_b !== frame.payload_a) {
      frames.push({ canId: frame.can_id, data: frame.payload_b, timestamp: "0", source: `compare-B` })
    }
    addFrames(frames)
    router.push("/replay-rapide")
  }

  const handleSaveToDBC = async (frame: CompareFrameDiff, usePayloadA: boolean) => {
    if (!missionId) return
    try {
      const payload = usePayloadA ? frame.payload_a : frame.payload_b
      const label = usePayloadA ? "A" : "B"
      const uniqueId = Date.now().toString(36).slice(-4).toUpperCase()
      const signalName = `SIG_${frame.can_id}_${label}_${uniqueId}`
      const signal = {
        id: signalName,
        can_id: frame.can_id,
        name: signalName,
        start_bit: frame.bytes_changed.length > 0 ? frame.bytes_changed[0] * 8 : 0,
        length: Math.min(payload.length * 4, 64),
        byte_order: "little_endian" as const,
        is_signed: false,
        scale: 1,
        offset: 0,
        min_val: 0,
        max_val: 255,
        unit: "",
        comment: `Comparaison Log ${label}: ${currentComparisonName || ""}`,
        sample_status: payload,
      }
      await addDBCSignal(missionId, signal)
      toast({ title: "Enregistre", description: `Signal ${signalName} ajoute au DBC (Log ${label})` })
    } catch {
      toast({ title: "Erreur", description: "Echec de l'enregistrement DBC", variant: "destructive" })
    }
  }

  const toggleExpanded = (canId: string) => {
    const next = new Set(expandedFrames)
    if (next.has(canId)) next.delete(canId)
    else next.add(canId)
    setExpandedFrames(next)
  }

  const getClassificationIcon = (classification: string) => {
    switch (classification) {
      case "differential": return <GitCompare className="h-4 w-4 text-amber-500" />
      case "only_a": return <MinusCircle className="h-4 w-4 text-red-500" />
      case "only_b": return <PlusCircle className="h-4 w-4 text-green-500" />
      case "identical": return <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
      default: return <AlertCircle className="h-4 w-4" />
    }
  }

  const getClassificationLabel = (classification: string) => {
    switch (classification) {
      case "differential": return "Differentiel"
      case "only_a": return "Uniquement A"
      case "only_b": return "Uniquement B"
      case "identical": return "Identique"
      default: return classification
    }
  }

  const renderPayloadWithDiff = (payload: string, otherPayload: string, bytesChanged: number[]) => {
    if (!payload) return <span className="text-muted-foreground">-</span>
    const bytes = []
    for (let i = 0; i < payload.length; i += 2) {
      const byteIndex = i / 2
      const byte = payload.slice(i, i + 2)
      const isChanged = bytesChanged.includes(byteIndex)
      bytes.push(
        <span key={i} className={isChanged ? "bg-amber-500/30 px-0.5 rounded font-bold" : ""}>
          {byte}
        </span>
      )
      if (i + 2 < payload.length) {
        bytes.push(<span key={`sep-${i}`} className="text-muted-foreground/50">{" "}</span>)
      }
    }
    return <span className="font-mono text-xs">{bytes}</span>
  }

  if (!missionResolved) {
    return (
      <AppShell title="Comparaison de Logs" description="Chargement...">
        <Card className="border-border bg-card">
          <CardContent className="py-12 text-center">
            <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
          </CardContent>
        </Card>
      </AppShell>
    )
  }
  
  if (!missionId) {
    return (
      <AppShell title="Comparaison de Logs" description="Comparez deux logs pour identifier les trames differentielles">
        <Card className="border-border bg-card">
          <CardContent className="flex flex-col items-center justify-center py-16">
            <FolderOpen className="h-16 w-16 text-muted-foreground/30 mb-4" />
            <h2 className="text-xl font-semibold text-foreground mb-2">Aucune mission selectionnee</h2>
            <p className="text-muted-foreground text-center max-w-md mb-6">
              Selectionnez ou creez une mission depuis le Dashboard pour comparer des logs CAN.
            </p>
            <Button onClick={() => router.push("/")} className="gap-2">
              <ArrowLeft className="h-4 w-4" />
              Ouvrir le Dashboard
            </Button>
          </CardContent>
        </Card>
      </AppShell>
    )
  }

  const currentMission = missions.find((m) => m.id === missionId)

  // =========================================================================
  // RENDER: Results view (shared between new and saved)
  // =========================================================================
  const renderResults = () => {
    if (!comparisonResult) return null
    return (
      <Card className="border-border bg-card">
        <CardHeader className="pb-4">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-lg">
                {currentComparisonName || "Resultats de la comparaison"}
              </CardTitle>
              <CardDescription>
                {comparisonResult.log_a_name} vs {comparisonResult.log_b_name}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {!currentComparisonId && (
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-2 bg-transparent"
                  onClick={() => {
                    setSaveName(currentComparisonName)
                    setShowSaveDialog(true)
                  }}
                >
                  <Save className="h-4 w-4" />
                  Sauvegarder
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="gap-2 bg-transparent"
                onClick={() => {
                  setViewMode("list")
                  setComparisonResult(null)
                  setCurrentComparisonId(null)
                }}
              >
                <ArrowLeft className="h-4 w-4" />
                Retour
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Summary */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-center">
              <div className="text-2xl font-bold text-amber-500">{comparisonResult.differential_count}</div>
              <div className="text-xs text-muted-foreground">Differentiels</div>
            </div>
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-center">
              <div className="text-2xl font-bold text-red-500">{comparisonResult.only_a_count}</div>
              <div className="text-xs text-muted-foreground">Uniquement A</div>
            </div>
            <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/30 text-center">
              <div className="text-2xl font-bold text-green-500">{comparisonResult.only_b_count}</div>
              <div className="text-xs text-muted-foreground">Uniquement B</div>
            </div>
            <div className="p-3 rounded-lg bg-muted/50 border border-border text-center">
              <div className="text-2xl font-bold text-muted-foreground">{comparisonResult.identical_count}</div>
              <div className="text-xs text-muted-foreground">Identiques</div>
            </div>
          </div>

          {/* CAN Interface + Sort controls */}
          <div className="flex items-center gap-4 text-sm flex-wrap">
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground">Interface CAN:</Label>
              <select
                value={canInterface}
                onChange={(e) => setCanInterface(e.target.value as "can0" | "can1" | "vcan0")}
                className="rounded border border-border bg-secondary px-2 py-1 text-xs text-foreground"
              >
                <option value="can0">can0</option>
                <option value="can1">can1</option>
                <option value="vcan0">vcan0 (test)</option>
              </select>
            </div>
            <div className="h-4 w-px bg-border" />
            <ArrowUpDown className="h-4 w-4 text-muted-foreground" />
            <span className="text-muted-foreground">Trier par:</span>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant={sortMode === "stability" ? "default" : "outline"}
                className={`h-7 text-xs gap-1 ${sortMode !== "stability" ? "bg-transparent" : ""}`}
                onClick={() => setSortMode("stability")}
              >
                <Shield className="h-3 w-3" />
                Stabilite (reverse)
              </Button>
              <Button
                size="sm"
                variant={sortMode === "confidence" ? "default" : "outline"}
                className={`h-7 text-xs gap-1 ${sortMode !== "confidence" ? "bg-transparent" : ""}`}
                onClick={() => setSortMode("confidence")}
              >
                <TrendingUp className="h-3 w-3" />
                Confiance
              </Button>
              <Button
                size="sm"
                variant={sortMode === "classification" ? "default" : "outline"}
                className={`h-7 text-xs gap-1 ${sortMode !== "classification" ? "bg-transparent" : ""}`}
                onClick={() => setSortMode("classification")}
              >
                <Info className="h-3 w-3" />
                Type
              </Button>
              <Button
                size="sm"
                variant={sortMode === "command" ? "default" : "outline"}
                className={`h-7 text-xs gap-1 ${sortMode !== "command" ? "bg-transparent" : ""}`}
                onClick={() => setSortMode("command")}
              >
                <Zap className="h-3 w-3" />
                Commande probable
              </Button>
            </div>
            <div className="h-4 w-px bg-border" />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant={filterExclusiveOnly ? "default" : "outline"}
                className={`h-7 text-xs gap-1 ${!filterExclusiveOnly ? "bg-transparent" : ""}`}
                onClick={() => setFilterExclusiveOnly(!filterExclusiveOnly)}
              >
                <Filter className="h-3 w-3" />
                Rare exclusif seul
              </Button>
            </div>
          </div>

          {/* Frame list */}
          <ScrollArea className="h-[500px] rounded-lg border border-border">
            <div className="p-2 space-y-1">
              {sortedFrames.map((frame) => {
                const isExpanded = expandedFrames.has(frame.can_id)
                return (
                  <div key={frame.can_id} className="rounded-lg border border-border bg-card overflow-hidden">
                    <div
                      className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-secondary/30 transition-colors"
                      onClick={() => toggleExpanded(frame.can_id)}
                    >
                      {isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                      {getClassificationIcon(frame.classification)}
                      <Badge variant="outline" className="font-mono">{frame.can_id}</Badge>
                      <Badge
                        variant="secondary"
                        className={
                          frame.classification === "differential" ? "bg-amber-500/20 text-amber-500"
                            : frame.classification === "only_a" ? "bg-red-500/20 text-red-500"
                            : frame.classification === "only_b" ? "bg-green-500/20 text-green-500"
                            : "bg-muted text-muted-foreground"
                        }
                      >
                        {getClassificationLabel(frame.classification)}
                      </Badge>
                      {(frame.command_score ?? 0) > 0 && (
                        <Badge variant="secondary" className={`ml-1 text-[10px] h-5 gap-0.5 font-mono ${
                          (frame.command_score ?? 0) >= 60 ? "bg-violet-500/20 text-violet-400 border-violet-500/30"
                          : (frame.command_score ?? 0) >= 30 ? "bg-amber-500/20 text-amber-400 border-amber-500/30"
                          : "bg-muted text-muted-foreground"
                        }`}>
                          <Zap className="h-2.5 w-2.5" />
                          {(frame.command_score ?? 0).toFixed(0)}
                        </Badge>
                      )}
                      {frame.classification !== "identical" && (frame.stability_score ?? 0) > 0 && (
                        <div className="flex items-center gap-1.5 ml-auto" title={`Score de stabilite: ${(frame.stability_score ?? 0).toFixed(0)}% - Plus le score est eleve, plus la trame est un bon candidat pour le reverse`}>
                          <Shield className={`h-3.5 w-3.5 ${
                            (frame.stability_score ?? 0) >= 70 ? "text-emerald-500" 
                            : (frame.stability_score ?? 0) >= 40 ? "text-amber-500" 
                            : "text-muted-foreground"
                          }`} />
                          <div className="w-16 h-1.5 rounded-full bg-secondary overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${
                                (frame.stability_score ?? 0) >= 70 ? "bg-emerald-500"
                                : (frame.stability_score ?? 0) >= 40 ? "bg-amber-500"
                                : "bg-muted-foreground"
                              }`}
                              style={{ width: `${frame.stability_score ?? 0}%` }}
                            />
                          </div>
                          <span className={`text-xs font-medium tabular-nums ${
                            (frame.stability_score ?? 0) >= 70 ? "text-emerald-500"
                            : (frame.stability_score ?? 0) >= 40 ? "text-amber-500"
                            : "text-muted-foreground"
                          }`}>
                            {(frame.stability_score ?? 0).toFixed(0)}
                          </span>
                        </div>
                      )}
                      <span className="text-xs text-muted-foreground shrink-0">
                        {frame.confidence.toFixed(0)}%
                      </span>
                    </div>

                    {isExpanded && (
                      <div className="px-3 pb-3 pt-1 border-t border-border bg-secondary/20 space-y-3">
                        {/* Stability detail for differential */}
                        {frame.classification === "differential" && (frame.stability_score ?? 0) > 0 && (
                          <div className="flex flex-wrap items-center gap-3 p-2 rounded-lg bg-card border border-border text-xs">
                            <div className="flex items-center gap-1">
                              <Shield className={`h-3.5 w-3.5 ${
                                (frame.stability_score ?? 0) >= 70 ? "text-emerald-500" : (frame.stability_score ?? 0) >= 40 ? "text-amber-500" : "text-muted-foreground"
                              }`} />
                              <span className="font-medium">Stabilite: {(frame.stability_score ?? 0).toFixed(0)}/100</span>
                            </div>
                            <span className="text-muted-foreground">|</span>
                            <span className="text-muted-foreground">
                              Payloads uniques: A={frame.unique_payloads_a ?? "?"} B={frame.unique_payloads_b ?? "?"}
                            </span>
                            <span className="text-muted-foreground">|</span>
                            <span className="text-muted-foreground">
                              Dominance: A={frame.dominant_ratio_a?.toFixed(0) ?? "?"}% B={frame.dominant_ratio_b?.toFixed(0) ?? "?"}%
                            </span>
                            <span className="text-muted-foreground">|</span>
                            <span className="text-muted-foreground">
                              {frame.bytes_changed.length} octet{frame.bytes_changed.length > 1 ? "s" : ""} modifie{frame.bytes_changed.length > 1 ? "s" : ""}
                            </span>
                            {(frame.stability_score ?? 0) >= 70 && (
                              <Badge variant="secondary" className="bg-emerald-500/20 text-emerald-500 text-[10px] h-5">
                                Bon candidat reverse
                              </Badge>
                            )}
                          </div>
                        )}
                        {/* Bloc Rares Exclusifs */}
                        {((frame.exclusive_rare_a?.length ?? 0) > 0 || (frame.exclusive_rare_b?.length ?? 0) > 0) && (
                          <div className="p-2 rounded-lg bg-violet-500/5 border border-violet-500/20 space-y-2">
                            <div className="flex items-center gap-1.5 text-xs font-medium text-violet-400">
                              <Zap className="h-3.5 w-3.5" />
                              Rares exclusifs
                              <Badge variant="secondary" className="bg-violet-500/20 text-violet-400 text-[10px] h-4 ml-1">
                                CmdScore: {(frame.command_score ?? 0).toFixed(0)}
                              </Badge>
                            </div>
                            <div className="grid gap-2 sm:grid-cols-2">
                              {/* Exclusifs A */}
                              <div className="space-y-1">
                                <div className="flex items-center justify-between">
                                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Log A ({frame.exclusive_rare_a?.length ?? 0} trames)</span>
                                  {(frame.exclusive_rare_a?.length ?? 0) > 0 && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-5 px-1.5 text-[10px] gap-1"
                                      disabled={replayingAllKey === `all-${frame.can_id}-A`}
                                      onClick={(e) => { e.stopPropagation(); handleReplayAllRare(frame.can_id, frame.exclusive_rare_a, "A") }}
                                      title={`Rejouer les ${frame.exclusive_rare_a.length} trames Log A sur ${canInterface}`}
                                    >
                                      {replayingAllKey === `all-${frame.can_id}-A` ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Play className="h-2.5 w-2.5" />}
                                      Tout rejouer
                                    </Button>
                                  )}
                                </div>
                                {(frame.exclusive_rare_a?.length ?? 0) > 0 ? frame.exclusive_rare_a.map((rp, i) => {
                                  const rareKey = `a-${frame.can_id}-${rp.payload}`
                                  return (
                                    <div key={i} className="flex items-center gap-1 p-1.5 rounded bg-card border border-border group">
                                      <Button
                                        size="icon"
                                        variant="ghost"
                                        className={`h-5 w-5 shrink-0 ${sentRareKey === rareKey ? "text-success" : ""}`}
                                        disabled={sendingRareKey === rareKey}
                                        onClick={(e) => { e.stopPropagation(); handleSendRarePayload(frame.can_id, rp.payload, rareKey) }}
                                        title={`Envoyer ${frame.can_id}#${rp.payload} sur ${canInterface}`}
                                      >
                                        {sendingRareKey === rareKey ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : sentRareKey === rareKey ? <CheckCircle2 className="h-2.5 w-2.5" /> : <Play className="h-2.5 w-2.5" />}
                                      </Button>
                                      <code className="text-xs font-mono text-red-400 break-all min-w-0 truncate">{frame.can_id}#{rp.payload}</code>
                                      <Badge variant="outline" className="text-[10px] h-4 shrink-0">x{rp.count}</Badge>
                                      {rp.ts_preview.length > 0 && (
                                        <span className="text-[10px] text-muted-foreground shrink-0" title={`Timestamps: ${rp.ts_preview.join(", ")}`}>
                                          <Clock className="h-2.5 w-2.5 inline mr-0.5" />
                                          {rp.ts_preview[0].toFixed(2)}s
                                        </span>
                                      )}
                                    </div>
                                  )
                                }) : <span className="text-[10px] text-muted-foreground italic">Aucun</span>}
                              </div>
                              {/* Exclusifs B */}
                              <div className="space-y-1">
                                <div className="flex items-center justify-between">
                                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Log B ({frame.exclusive_rare_b?.length ?? 0} trames)</span>
                                  {(frame.exclusive_rare_b?.length ?? 0) > 0 && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-5 px-1.5 text-[10px] gap-1"
                                      disabled={replayingAllKey === `all-${frame.can_id}-B`}
                                      onClick={(e) => { e.stopPropagation(); handleReplayAllRare(frame.can_id, frame.exclusive_rare_b, "B") }}
                                      title={`Rejouer les ${frame.exclusive_rare_b.length} trames Log B sur ${canInterface}`}
                                    >
                                      {replayingAllKey === `all-${frame.can_id}-B` ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Play className="h-2.5 w-2.5" />}
                                      Tout rejouer
                                    </Button>
                                  )}
                                </div>
                                {(frame.exclusive_rare_b?.length ?? 0) > 0 ? frame.exclusive_rare_b.map((rp, i) => {
                                  const rareKey = `b-${frame.can_id}-${rp.payload}`
                                  return (
                                    <div key={i} className="flex items-center gap-1 p-1.5 rounded bg-card border border-border group">
                                      <Button
                                        size="icon"
                                        variant="ghost"
                                        className={`h-5 w-5 shrink-0 ${sentRareKey === rareKey ? "text-success" : ""}`}
                                        disabled={sendingRareKey === rareKey}
                                        onClick={(e) => { e.stopPropagation(); handleSendRarePayload(frame.can_id, rp.payload, rareKey) }}
                                        title={`Envoyer ${frame.can_id}#${rp.payload} sur ${canInterface}`}
                                      >
                                        {sendingRareKey === rareKey ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : sentRareKey === rareKey ? <CheckCircle2 className="h-2.5 w-2.5" /> : <Play className="h-2.5 w-2.5" />}
                                      </Button>
                                      <code className="text-xs font-mono text-emerald-400 break-all min-w-0 truncate">{frame.can_id}#{rp.payload}</code>
                                      <Badge variant="outline" className="text-[10px] h-4 shrink-0">x{rp.count}</Badge>
                                      {rp.ts_preview.length > 0 && (
                                        <span className="text-[10px] text-muted-foreground shrink-0" title={`Timestamps: ${rp.ts_preview.join(", ")}`}>
                                          <Clock className="h-2.5 w-2.5 inline mr-0.5" />
                                          {rp.ts_preview[0].toFixed(2)}s
                                        </span>
                                      )}
                                    </div>
                                  )
                                }) : <span className="text-[10px] text-muted-foreground italic">Aucun</span>}
                              </div>
                            </div>
                          </div>
                        )}

                        <div className="grid gap-2 sm:grid-cols-2">
                          <div className="p-2 rounded bg-card border border-border">
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-xs text-muted-foreground">Log A ({frame.count_a} trames)</span>
                              {frame.payload_a && (
                                <div className="flex gap-1">
                                  <Button size="icon" variant="ghost" className="h-6 w-6" onClick={(e) => { e.stopPropagation(); handleSendFrame(frame, true) }} disabled={sendingFrame === frame.can_id} title="Envoyer payload A">
                                    {sendingFrame === frame.can_id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                                  </Button>
                                  <Button size="icon" variant="ghost" className="h-6 w-6 text-primary" onClick={(e) => { e.stopPropagation(); handleSaveToDBC(frame, true) }} title="Enregistrer A dans DBC">
                                    <FileCode className="h-3 w-3" />
                                  </Button>
                                </div>
                              )}
                            </div>
                            {renderPayloadWithDiff(frame.payload_a, frame.payload_b, frame.bytes_changed)}
                          </div>
                          <div className="p-2 rounded bg-card border border-border">
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-xs text-muted-foreground">Log B ({frame.count_b} trames)</span>
                              {frame.payload_b && (
                                <div className="flex gap-1">
                                  <Button size="icon" variant="ghost" className="h-6 w-6" onClick={(e) => { e.stopPropagation(); handleSendFrame(frame, false) }} disabled={sendingFrame === frame.can_id} title="Envoyer payload B">
                                    {sendingFrame === frame.can_id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                                  </Button>
                                  <Button size="icon" variant="ghost" className="h-6 w-6 text-primary" onClick={(e) => { e.stopPropagation(); handleSaveToDBC(frame, false) }} title="Enregistrer B dans DBC">
                                    <FileCode className="h-3 w-3" />
                                  </Button>
                                </div>
                              )}
                            </div>
                            {renderPayloadWithDiff(frame.payload_b, frame.payload_a, frame.bytes_changed)}
                          </div>
                        </div>
                        {frame.bytes_changed.length > 0 && (
                          <div className="space-y-1">
                            <div className="text-xs text-muted-foreground">
                              Octets modifies: {frame.bytes_changed.map(b => `#${b}`).join(", ")}
                            </div>
                            {frame.byte_change_detail && frame.byte_change_detail.length > 0 && (
                              <div className="flex flex-wrap gap-1.5">
                                {frame.byte_change_detail.map((bd) => (
                                  <span key={bd.index} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 text-[10px] font-mono">
                                    <span className="text-muted-foreground">#{bd.index}:</span>
                                    <span className="text-red-400">{bd.val_a}</span>
                                    <span className="text-muted-foreground">{">"}</span>
                                    <span className="text-emerald-400">{bd.val_b}</span>
                                    <span className="text-amber-500/70">(+/-{bd.hex_diff})</span>
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                        <div className="flex gap-2">
                          <Button size="sm" variant="outline" className="gap-2 bg-transparent" onClick={(e) => { e.stopPropagation(); handleSendToReplay(frame) }}>
                            <Send className="h-3 w-3" />
                            Envoyer vers Replay
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    )
  }

  return (
    <AppShell
      title="Comparaison de Logs"
      description={currentMission ? `Mission: ${currentMission.name}` : "Comparez deux logs pour identifier les trames differentielles"}
    >
      <div className="space-y-6">
        {/* ============== LIST VIEW ============== */}
        {viewMode === "list" && (
          <>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Comparaisons</h2>
              <Button onClick={handleStartNew} className="gap-2">
                <Plus className="h-4 w-4" />
                Nouvelle comparaison
              </Button>
            </div>

            {isLoadingSaved ? (
              <Card className="border-border bg-card">
                <CardContent className="py-12 text-center">
                  <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
                </CardContent>
              </Card>
            ) : savedComparisons.length === 0 ? (
              <Card className="border-border bg-card">
                <CardContent className="py-12 text-center space-y-3">
                  <GitCompare className="h-10 w-10 mx-auto text-muted-foreground/50" />
                  <p className="text-muted-foreground">Aucune comparaison sauvegardee</p>
                  <p className="text-sm text-muted-foreground/70">
                    Lancez une nouvelle comparaison pour identifier les trames differentielles entre deux logs
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-2">
                {savedComparisons.map((comp) => (
                  <Card key={comp.id} className="border-border bg-card hover:bg-secondary/20 transition-colors">
                    <CardContent className="py-3 px-4">
                      <div className="flex items-center justify-between gap-4">
                        <div
                          className="flex-1 cursor-pointer min-w-0"
                          onClick={() => handleOpenSaved(comp)}
                        >
                          <div className="flex items-center gap-2 mb-1">
                            <GitCompare className="h-4 w-4 text-primary shrink-0" />
                            <span className="font-medium truncate">{comp.name}</span>
                          </div>
                          <div className="flex items-center gap-3 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              {new Date(comp.created_at).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Badge variant="secondary" className="bg-amber-500/20 text-amber-500 text-xs">
                            {comp.differential_count} diff
                          </Badge>
                          {comp.only_a_count > 0 && (
                            <Badge variant="secondary" className="bg-red-500/20 text-red-500 text-xs">
                              {comp.only_a_count} A
                            </Badge>
                          )}
                          {comp.only_b_count > 0 && (
                            <Badge variant="secondary" className="bg-green-500/20 text-green-500 text-xs">
                              {comp.only_b_count} B
                            </Badge>
                          )}
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-destructive hover:text-destructive"
                            onClick={(e) => { e.stopPropagation(); handleDelete(comp.id) }}
                            disabled={deletingId === comp.id}
                          >
                            {deletingId === comp.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </>
        )}

        {/* ============== NEW COMPARISON VIEW ============== */}
        {viewMode === "new" && (
          <>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setViewMode("list")} className="gap-1">
                <ArrowLeft className="h-4 w-4" />
                Retour
              </Button>
              <h2 className="text-lg font-semibold">Nouvelle comparaison</h2>
            </div>

            <Card className="border-border bg-card">
              <CardHeader className="pb-4">
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <ArrowLeftRight className="h-5 w-5 text-primary" />
                    Selectionner les logs a comparer
                  </CardTitle>
                  <LogImportButton missionId={missionId} onImportSuccess={() => loadLogs()} size="sm" />
                </div>
                <CardDescription>
                  Choisissez deux logs representant des etats differents (ex: ouverture vs fermeture)
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5 items-start">
                  <div className="space-y-2 lg:col-span-2">
                    <Label htmlFor="log-a">Log A (ex: ouverture)</Label>
                    <Select value={logAId} onValueChange={setLogAId} disabled={isLoadingLogs}>
                      <SelectTrigger id="log-a">
                        <SelectValue placeholder="Selectionner log A..." />
                      </SelectTrigger>
                      <SelectContent>
                        {logTree.map((log) => (
                          <LogSelectItem key={log.id} log={log} depth={0} disabledId={logBId} />
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="hidden lg:flex items-center justify-center pt-8">
                    <ArrowLeftRight className="h-6 w-6 text-muted-foreground" />
                  </div>

                  <div className="space-y-2 lg:col-span-2">
                    <Label htmlFor="log-b">Log B (ex: fermeture)</Label>
                    <Select value={logBId} onValueChange={setLogBId} disabled={isLoadingLogs}>
                      <SelectTrigger id="log-b">
                        <SelectValue placeholder="Selectionner log B..." />
                      </SelectTrigger>
                      <SelectContent>
                        {logTree.map((log) => (
                          <LogSelectItem key={log.id} log={log} depth={0} disabledId={logAId} />
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="pt-2">
                  <Button onClick={handleCompare} disabled={!logAId || !logBId || isComparing} className="gap-2">
                    {isComparing ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitCompare className="h-4 w-4" />}
                    {isComparing ? "Analyse en cours..." : "Comparer les logs"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </>
        )}

        {/* ============== RESULTS VIEW ============== */}
        {viewMode === "view" && renderResults()}

        {/* ============== SAVE DIALOG ============== */}
        <Dialog open={showSaveDialog} onOpenChange={setShowSaveDialog}>
          <DialogContent className="sm:max-w-md bg-card">
            <DialogHeader>
              <DialogTitle>Sauvegarder la comparaison</DialogTitle>
              <DialogDescription>
                Donnez un nom a cette comparaison pour la retrouver plus tard
              </DialogDescription>
            </DialogHeader>
            <div className="py-4">
              <Label htmlFor="save-name">Nom</Label>
              <Input
                id="save-name"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                placeholder="Ex: Ouverture vs Fermeture porte conducteur"
                className="mt-2"
                onKeyDown={(e) => { if (e.key === "Enter" && saveName.trim()) handleSave() }}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowSaveDialog(false)} className="bg-transparent">
                Annuler
              </Button>
              <Button onClick={handleSave} disabled={!saveName.trim() || isSaving} className="gap-2">
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Sauvegarder
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AppShell>
  )
}
