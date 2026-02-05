"use client"

import { useState, useEffect } from "react"
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

  const logTree = buildLogTree(missionLogs)

  useEffect(() => {
    const localId = localStorage.getItem("activeMissionId")
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

  const handleSendFrame = async (frame: CompareFrameDiff, usePayloadA: boolean) => {
    setSendingFrame(frame.can_id)
    try {
      const payload = usePayloadA ? frame.payload_a : frame.payload_b
      await sendCANFrame("can0", frame.can_id, payload)
      toast({ title: "Envoyee", description: `Trame ${frame.can_id} envoyee` })
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
      const signal = {
        can_id: frame.can_id,
        name: `SIG_${frame.can_id}_COMP_${Date.now().toString(36).slice(-4).toUpperCase()}`,
        start_bit: 0,
        length: Math.min(payload.length * 4, 64),
        byte_order: "little_endian" as const,
        is_signed: false,
        scale: 1,
        offset: 0,
        min_val: 0,
        max_val: 255,
        unit: "",
        comment: `Comparaison: ${usePayloadA ? "Log A" : "Log B"}`,
        sample_status: payload,
      }
      await addDBCSignal(missionId, signal)
      toast({ title: "Enregistre", description: `Signal ${signal.name} ajoute au DBC` })
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
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">Selectionnez une mission dans le Dashboard pour commencer.</p>
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

          {/* Frame list */}
          <ScrollArea className="h-[500px] rounded-lg border border-border">
            <div className="p-2 space-y-1">
              {comparisonResult.frames.map((frame) => {
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
                      <span className="text-xs text-muted-foreground ml-auto">
                        {frame.confidence.toFixed(0)}% confiance
                      </span>
                    </div>

                    {isExpanded && (
                      <div className="px-3 pb-3 pt-1 border-t border-border bg-secondary/20 space-y-3">
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
                          <div className="text-xs text-muted-foreground">
                            Octets modifies: {frame.bytes_changed.map(b => `#${b}`).join(", ")}
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
