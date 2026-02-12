"use client"

import { useState, useEffect, useCallback, useMemo } from "react"
import { AppShell } from "@/components/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import {
  BarChart3, Loader2, AlertCircle, Database, Cpu, Search,
  Download, Save, Eye, EyeOff, Filter, ArrowUpDown, CheckCircle2,
  Zap, ChevronDown, ChevronRight, Info, GitBranch, ArrowRight,
  FlaskConical, AlertTriangle, Check, X,
} from "lucide-react"
import {
  getByteHeatmap,
  autoDetectSignals,
  getInterIdDependencies,
  validateCausality,
  listMissionLogs,
  addDBCSignal,
  type HeatmapResult,
  type HeatmapIdEntry,
  type HeatmapByteInfo,
  type AutoDetectResult,
  type DetectedSignal,
  type ExcludedByteInfo,
  type DependencyResult,
  type DependencyEdge,
  type DependencyNode,
  type CausalityResult,
  type LogEntry,
} from "@/lib/api"
import { useMissionStore } from "@/lib/mission-store"
import { cn } from "@/lib/utils"

// =============================================================================
// Heatmap color scale: cold (constant) -> hot (variable)
// =============================================================================

function heatColor(rate: number): string {
  // 0 = dark/grey, 1 = vivid red-orange
  if (rate <= 0) return "rgba(30, 35, 50, 0.8)"
  if (rate < 0.05) return "rgba(40, 55, 90, 0.9)"
  if (rate < 0.15) return "rgba(30, 80, 140, 0.9)"
  if (rate < 0.3) return "rgba(20, 130, 160, 0.9)"
  if (rate < 0.5) return "rgba(30, 170, 100, 0.9)"
  if (rate < 0.7) return "rgba(180, 170, 30, 0.9)"
  if (rate < 0.85) return "rgba(220, 120, 20, 0.95)"
  return "rgba(230, 50, 30, 0.95)"
}

function entropyColor(entropy: number): string {
  const ratio = Math.min(entropy / 8, 1)
  return heatColor(ratio)
}

function confidenceBadge(confidence: number) {
  if (confidence >= 0.85) return <Badge className="bg-emerald-600/20 text-emerald-400 border-emerald-600/30">{(confidence * 100).toFixed(0)}%</Badge>
  if (confidence >= 0.6) return <Badge className="bg-amber-600/20 text-amber-400 border-amber-600/30">{(confidence * 100).toFixed(0)}%</Badge>
  return <Badge className="bg-red-600/20 text-red-400 border-red-600/30">{(confidence * 100).toFixed(0)}%</Badge>
}

// =============================================================================
// Component: Byte Cell (Heatmap)
// =============================================================================

function ByteCell({ byte, mode }: { byte: HeatmapByteInfo; mode: "change_rate" | "entropy" }) {
  const value = mode === "change_rate" ? byte.change_rate : byte.entropy
  const maxVal = mode === "change_rate" ? 1 : 8
  const bg = mode === "change_rate" ? heatColor(value) : entropyColor(value)
  const displayVal = mode === "change_rate"
    ? `${(value * 100).toFixed(0)}%`
    : value.toFixed(1)

  return (
    <div
      className="relative flex items-center justify-center rounded transition-all cursor-default group"
      style={{
        backgroundColor: bg,
        width: "52px",
        height: "36px",
      }}
      title={`Byte ${byte.index} | Change: ${(byte.change_rate * 100).toFixed(1)}% | Entropy: ${byte.entropy.toFixed(2)} bits | Range: [${byte.min}-${byte.max}] | Unique: ${byte.unique_count}`}
    >
      <span className="text-[10px] font-mono font-medium text-white/90">
        {displayVal}
      </span>
      {/* Hover detail popup */}
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 hidden group-hover:block z-50 pointer-events-none">
        <div className="bg-popover border border-border rounded-md px-2.5 py-1.5 shadow-lg text-[10px] font-mono leading-relaxed whitespace-nowrap text-popover-foreground">
          <div>B{byte.index} | {byte.unique_count} val uniques</div>
          <div>Change: {(byte.change_rate * 100).toFixed(1)}%</div>
          <div>Entropy: {byte.entropy.toFixed(3)} bits</div>
          <div>Range: 0x{byte.min.toString(16).toUpperCase().padStart(2, "0")} - 0x{byte.max.toString(16).toUpperCase().padStart(2, "0")}</div>
        </div>
      </div>
    </div>
  )
}

// =============================================================================
// Component: Heatmap Row (one CAN ID)
// =============================================================================

function HeatmapRow({
  entry,
  mode,
  expanded,
  onToggle,
}: {
  entry: HeatmapIdEntry
  mode: "change_rate" | "entropy"
  expanded: boolean
  onToggle: () => void
}) {
  const maxRate = Math.max(...entry.bytes.map((b) => b.change_rate))

  return (
    <div className="border-b border-border/40 last:border-0">
      <div className="flex items-center gap-2 py-1 px-2 hover:bg-muted/30 transition-colors">
        {/* Expand toggle */}
        <button onClick={onToggle} className="text-muted-foreground hover:text-foreground transition-colors">
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>

        {/* CAN ID */}
        <span className="font-mono text-xs font-semibold text-primary w-12 shrink-0">
          {entry.can_id}
        </span>

        {/* Frequency badge */}
        <span className="text-[10px] text-muted-foreground w-16 shrink-0 text-right tabular-nums">
          {entry.frequency_hz > 0 ? `${entry.frequency_hz} Hz` : "--"}
        </span>

        {/* Byte cells */}
        <div className="flex gap-0.5 ml-2">
          {entry.bytes.map((byte) => (
            <ByteCell key={byte.index} byte={byte} mode={mode} />
          ))}
          {/* Pad to 8 if DLC < 8 */}
          {Array.from({ length: Math.max(0, 8 - entry.bytes.length) }).map((_, i) => (
            <div
              key={`pad-${i}`}
              className="flex items-center justify-center rounded opacity-20"
              style={{ width: "52px", height: "36px", backgroundColor: "rgba(30, 35, 50, 0.5)" }}
            >
              <span className="text-[10px] font-mono text-muted-foreground">--</span>
            </div>
          ))}
        </div>

        {/* Frame count */}
        <span className="text-[10px] text-muted-foreground ml-auto shrink-0 tabular-nums">
          {entry.frame_count.toLocaleString()} trames
        </span>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-10 pb-2 pt-1">
          <div className="grid grid-cols-4 gap-2 text-[10px] font-mono">
            {entry.bytes.map((b) => (
              <div key={b.index} className="bg-muted/30 rounded px-2 py-1.5 border border-border/30">
                <div className="font-semibold text-foreground mb-0.5">Byte {b.index}</div>
                <div className="text-muted-foreground">Change: <span className="text-foreground">{(b.change_rate * 100).toFixed(1)}%</span></div>
                <div className="text-muted-foreground">Entropie: <span className="text-foreground">{b.entropy.toFixed(3)} bits</span></div>
                <div className="text-muted-foreground">Min: <span className="text-foreground">0x{b.min.toString(16).toUpperCase().padStart(2, "0")}</span> Max: <span className="text-foreground">0x{b.max.toString(16).toUpperCase().padStart(2, "0")}</span></div>
                <div className="text-muted-foreground">Unique: <span className="text-foreground">{b.unique_count}</span></div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// =============================================================================
// Component: Signal Byte Map (visual representation of signal in 8-byte message)
// =============================================================================

function SignalByteMap({ signal, excludedBytes }: { signal: DetectedSignal; excludedBytes?: Record<string, ExcludedByteInfo> }) {
  const bytes = Array.from({ length: 8 }, (_, i) => {
    const inSignal = i >= signal.start_byte && i < signal.start_byte + signal.length_bytes
    const excluded = excludedBytes?.[String(i)]
    return { index: i, active: inSignal, excluded }
  })

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex gap-0.5">
        {bytes.map((b) => (
          <div
            key={b.index}
            className={cn(
              "w-8 h-6 rounded text-[9px] font-mono flex items-center justify-center border transition-colors",
              b.active
                ? "bg-primary/30 border-primary/60 text-primary font-semibold"
                : b.excluded
                  ? "bg-amber-900/30 border-amber-600/40 text-amber-400"
                  : "bg-muted/30 border-border/30 text-muted-foreground"
            )}
            title={
              b.excluded
                ? `${b.excluded.type === "counter" ? "Counter" : "Checksum"} (${b.excluded.type === "counter" ? `${((b.excluded.ratio ?? 0) * 100).toFixed(0)}% incr` : `${b.excluded.algo} ${((b.excluded.match_rate ?? 0) * 100).toFixed(0)}%`})`
                : undefined
            }
          >
            B{b.index}
          </div>
        ))}
      </div>
      {/* Show excluded byte labels */}
      {excludedBytes && Object.keys(excludedBytes).length > 0 && (
        <div className="flex gap-0.5">
          {bytes.map((b) => (
            <div key={b.index} className="w-8 text-center">
              {b.excluded && (
                <span className="text-[8px] text-amber-400 font-medium leading-none">
                  {b.excluded.type === "counter" ? "CNT" : "CKS"}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}


// =============================================================================
// Main Page
// =============================================================================

export default function AnalyseCANPage() {
  // Mission & log selection
  const { missions, currentMissionId, fetchMissions } = useMissionStore()
  const [selectedMissionId, setSelectedMissionId] = useState<string>("")
  const [missionLogs, setMissionLogs] = useState<LogEntry[]>([])
  const [selectedLogId, setSelectedLogId] = useState<string>("")
  const [loadingLogs, setLoadingLogs] = useState(false)

  const activeMission = missions.find((m) => m.id === currentMissionId) ?? null

  // Tab state
  const [tab, setTab] = useState<"heatmap" | "autodetect" | "dependencies">("heatmap")

  // Heatmap state
  const [heatmapResult, setHeatmapResult] = useState<HeatmapResult | null>(null)
  const [heatmapLoading, setHeatmapLoading] = useState(false)
  const [heatmapError, setHeatmapError] = useState<string | null>(null)
  const [heatmapMode, setHeatmapMode] = useState<"change_rate" | "entropy">("change_rate")
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [hideConstant, setHideConstant] = useState(false)
  const [minChangeRate, setMinChangeRate] = useState(0)
  const [sortBy, setSortBy] = useState<"frequency" | "activity">("frequency")

  // Auto-detect state
  const [detectResult, setDetectResult] = useState<AutoDetectResult | null>(null)
  const [detectLoading, setDetectLoading] = useState(false)
  const [detectError, setDetectError] = useState<string | null>(null)
  const [minEntropy, setMinEntropy] = useState(0.5)
  const [correlationThreshold, setCorrelationThreshold] = useState(0.85)
  const [excludeCounters, setExcludeCounters] = useState(true)
  const [excludeChecksums, setExcludeChecksums] = useState(true)
  const [selectedSignals, setSelectedSignals] = useState<Set<string>>(new Set())
  const [inspectedSignal, setInspectedSignal] = useState<DetectedSignal | null>(null)
  const [savingDBC, setSavingDBC] = useState(false)
  const [savedSignals, setSavedSignals] = useState<Set<string>>(new Set())

  // Dependency state
  const [depResult, setDepResult] = useState<DependencyResult | null>(null)
  const [depLoading, setDepLoading] = useState(false)
  const [depError, setDepError] = useState<string | null>(null)
  const [depWindowMs, setDepWindowMs] = useState(10)
  const [depMinScore, setDepMinScore] = useState(0.1)
  const [depSelectedEdge, setDepSelectedEdge] = useState<DependencyEdge | null>(null)

  // Causality validation state
  const [causalityResult, setCausalityResult] = useState<CausalityResult | null>(null)
  const [causalityLoading, setCausalityLoading] = useState(false)
  const [causalityError, setCausalityError] = useState<string | null>(null)
  const [causalityEdge, setCausalityEdge] = useState<{ source: string; target: string } | null>(null)
  const [showCausalityWarning, setShowCausalityWarning] = useState(false)
  const [pendingCausalityEdge, setPendingCausalityEdge] = useState<DependencyEdge | null>(null)

  // Fetch missions on mount
  useEffect(() => {
    fetchMissions()
  }, [fetchMissions])

  // Sync with active mission
  useEffect(() => {
    if (currentMissionId && !selectedMissionId) {
      setSelectedMissionId(currentMissionId)
    }
  }, [currentMissionId, selectedMissionId])

  // Load logs when mission changes
  useEffect(() => {
    if (!selectedMissionId) {
      setMissionLogs([])
      setSelectedLogId("")
      return
    }
    setLoadingLogs(true)
    listMissionLogs(selectedMissionId)
      .then((logs) => {
        setMissionLogs(logs)
        if (logs.length > 0 && !selectedLogId) {
          setSelectedLogId(logs[0].filename)
        }
      })
      .catch(() => setMissionLogs([]))
      .finally(() => setLoadingLogs(false))
  }, [selectedMissionId])

  // Toggle expanded row
  const toggleExpanded = useCallback((canId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(canId)) next.delete(canId)
      else next.add(canId)
      return next
    })
  }, [])

  // Heatmap: run analysis
  const runHeatmap = useCallback(async () => {
    setHeatmapLoading(true)
    setHeatmapError(null)
    try {
      const result = await getByteHeatmap({
        missionId: selectedMissionId || undefined,
        logId: selectedLogId || undefined,
      })
      setHeatmapResult(result)
      setExpandedIds(new Set())
    } catch (err: unknown) {
      setHeatmapError(err instanceof Error ? err.message : "Erreur inconnue")
    } finally {
      setHeatmapLoading(false)
    }
  }, [selectedMissionId, selectedLogId])

  // Auto-detect: run analysis
  const runAutoDetect = useCallback(async () => {
    setDetectLoading(true)
    setDetectError(null)
    try {
      const result = await autoDetectSignals({
        missionId: selectedMissionId || undefined,
        logId: selectedLogId || undefined,
        minEntropy,
        correlationThreshold,
        excludeCounters,
        excludeChecksums,
      })
      setDetectResult(result)
      setSelectedSignals(new Set())
      setInspectedSignal(null)
    } catch (err: unknown) {
      setDetectError(err instanceof Error ? err.message : "Erreur inconnue")
    } finally {
      setDetectLoading(false)
    }
  }, [selectedMissionId, selectedLogId, minEntropy, correlationThreshold, excludeCounters, excludeChecksums])

  // Dependencies: run analysis
  const runDependencies = useCallback(async () => {
    setDepLoading(true)
    setDepError(null)
    try {
      const result = await getInterIdDependencies({
        missionId: selectedMissionId || undefined,
        logId: selectedLogId || undefined,
        windowMs: depWindowMs,
        minScore: depMinScore,
      })
      setDepResult(result)
      setDepSelectedEdge(null)
    } catch (err: unknown) {
      setDepError(err instanceof Error ? err.message : "Erreur inconnue")
    } finally {
      setDepLoading(false)
    }
  }, [selectedMissionId, selectedLogId, depWindowMs, depMinScore])

  // Causality: request validation (shows warning first)
  const requestCausalityValidation = useCallback((edge: DependencyEdge) => {
    setPendingCausalityEdge(edge)
    setShowCausalityWarning(true)
  }, [])

  // Causality: confirm and run
  const runCausalityValidation = useCallback(async () => {
    if (!pendingCausalityEdge) return
    setShowCausalityWarning(false)
    const edge = pendingCausalityEdge
    setPendingCausalityEdge(null)
    setCausalityLoading(true)
    setCausalityError(null)
    setCausalityResult(null)
    setCausalityEdge({ source: edge.source, target: edge.target })
    try {
      const result = await validateCausality({
        sourceId: edge.source,
        targetId: edge.target,
        iface: activeMission?.canConfig?.interface || "can0",
        windowMs: depWindowMs,
        repeat: 5,
        missionId: selectedMissionId || undefined,
        logId: selectedLogId || undefined,
      })
      setCausalityResult(result)
    } catch (err: unknown) {
      setCausalityError(err instanceof Error ? err.message : "Erreur inconnue")
    } finally {
      setCausalityLoading(false)
    }
  }, [pendingCausalityEdge, activeMission, depWindowMs, selectedMissionId, selectedLogId])

  // Filter heatmap IDs
  const filteredHeatmapIds = useMemo(() => {
    if (!heatmapResult) return []
    let ids = [...heatmapResult.ids]

    if (hideConstant) {
      ids = ids.filter((entry) => entry.bytes.some((b) => !b.is_constant))
    }
    if (minChangeRate > 0) {
      ids = ids.filter((entry) =>
        entry.bytes.some((b) => b.change_rate >= minChangeRate)
      )
    }
    if (sortBy === "activity") {
      ids.sort((a, b) => {
        const maxA = Math.max(...a.bytes.map((x) => x.change_rate))
        const maxB = Math.max(...b.bytes.map((x) => x.change_rate))
        return maxB - maxA
      })
    }
    return ids
  }, [heatmapResult, hideConstant, minChangeRate, sortBy])

  // Toggle signal selection
  const toggleSignal = useCallback((name: string) => {
    setSelectedSignals((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])

  // Select all signals
  const selectAllSignals = useCallback(() => {
    if (!detectResult) return
    if (selectedSignals.size === detectResult.detected_signals.length) {
      setSelectedSignals(new Set())
    } else {
      setSelectedSignals(new Set(detectResult.detected_signals.map((s) => s.name)))
    }
  }, [detectResult, selectedSignals])

  // Save selected signals to DBC
  const saveSignalsToDBC = useCallback(async () => {
    if (!detectResult || !selectedMissionId || selectedSignals.size === 0) return
    setSavingDBC(true)
    const signalsToSave = detectResult.detected_signals.filter((s) => selectedSignals.has(s.name))
    const newSaved = new Set(savedSignals)

    for (const sig of signalsToSave) {
      try {
        await addDBCSignal(selectedMissionId, {
          message_id: sig.can_id,
          name: sig.name,
          start_bit: sig.start_bit,
          bit_length: sig.bit_length,
          byte_order: sig.byte_order,
          is_signed: sig.is_signed,
          factor: 1,
          offset: 0,
          min_value: sig.value_range[0],
          max_value: sig.value_range[1],
          unit: "",
          comment: `Auto-detected (confidence: ${(sig.confidence * 100).toFixed(0)}%, entropy: ${sig.entropy.toFixed(2)})`,
        })
        newSaved.add(sig.name)
      } catch {
        // continue with others
      }
    }
    setSavedSignals(newSaved)
    setSavingDBC(false)
  }, [detectResult, selectedMissionId, selectedSignals, savedSignals])

  const hasMission = !!selectedMissionId
  const hasLog = !!selectedLogId

  return (
    <AppShell>
      <div className="flex flex-col gap-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <BarChart3 className="h-6 w-6 text-primary" />
            Analyse CAN
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Heatmap de variabilite des bytes et auto-detection de signaux par analyse entropique
          </p>
        </div>

        {/* Mission banner */}
        {activeMission && (
          <Alert className="bg-primary/10 border-primary/30">
            <Database className="h-4 w-4 text-primary" />
            <AlertTitle className="text-primary">Mission active</AlertTitle>
            <AlertDescription className="text-primary/80 text-sm">
              {activeMission.name} -- Les signaux detectes peuvent etre sauvegardes dans le DBC de la mission.
            </AlertDescription>
          </Alert>
        )}

        {/* Main grid */}
        <div className="grid grid-cols-1 xl:grid-cols-[340px_1fr] gap-4">
          {/* Left column: Config */}
          <div className="flex flex-col gap-4">
            {/* Log selection */}
            <Card className="border-border/60">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Database className="h-4 w-4 text-primary" /> Source de donnees
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {/* Mission select */}
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">Mission</Label>
                  <Select value={selectedMissionId} onValueChange={setSelectedMissionId}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="Selectionnez une mission" />
                    </SelectTrigger>
                    <SelectContent>
                      {missions.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.name} {m.id === currentMissionId ? "(active)" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Log select */}
                {hasMission && (
                  <div className="flex flex-col gap-1.5">
                    <Label className="text-xs text-muted-foreground">Log CAN</Label>
                    {loadingLogs ? (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" /> Chargement...
                      </div>
                    ) : missionLogs.length === 0 ? (
                      <p className="text-xs text-muted-foreground">Aucun log disponible</p>
                    ) : (
                      <Select value={selectedLogId} onValueChange={setSelectedLogId}>
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {missionLogs.map((log) => (
                            <SelectItem key={log.filename} value={log.filename}>
                              {log.filename} ({log.framesCount?.toLocaleString() ?? "?"} trames)
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Tab toggle */}
            <div className="flex rounded-lg border border-border bg-muted p-0.5 gap-0.5">
              <button
                onClick={() => setTab("heatmap")}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 text-xs rounded-md px-3 py-1.5 font-medium transition-colors",
                  tab === "heatmap"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <BarChart3 className="h-3.5 w-3.5" /> Heatmap
              </button>
              <button
                onClick={() => setTab("autodetect")}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 text-xs rounded-md px-3 py-1.5 font-medium transition-colors",
                  tab === "autodetect"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Cpu className="h-3.5 w-3.5" /> Auto-detect
              </button>
              <button
                onClick={() => setTab("dependencies")}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 text-xs rounded-md px-3 py-1.5 font-medium transition-colors",
                  tab === "dependencies"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <GitBranch className="h-3.5 w-3.5" /> Dependances
              </button>
            </div>

            {/* Heatmap config */}
            {tab === "heatmap" && (
              <Card className="border-border/60">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Filter className="h-4 w-4 text-primary" /> Filtres Heatmap
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  {/* Color mode */}
                  <div className="flex flex-col gap-1.5">
                    <Label className="text-xs text-muted-foreground">Mode couleur</Label>
                    <Select value={heatmapMode} onValueChange={(v) => setHeatmapMode(v as "change_rate" | "entropy")}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="change_rate">Taux de changement</SelectItem>
                        <SelectItem value="entropy">Entropie de Shannon</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Hide constant IDs */}
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-muted-foreground">Masquer IDs constants</Label>
                    <Switch checked={hideConstant} onCheckedChange={setHideConstant} />
                  </div>

                  {/* Sort */}
                  <div className="flex flex-col gap-1.5">
                    <Label className="text-xs text-muted-foreground">Tri</Label>
                    <Select value={sortBy} onValueChange={(v) => setSortBy(v as "frequency" | "activity")}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="frequency">Par frequence (Hz)</SelectItem>
                        <SelectItem value="activity">Par activite max</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Min change rate filter */}
                  <div className="flex flex-col gap-1.5">
                    <Label className="text-xs text-muted-foreground">
                      Seuil min. change rate
                    </Label>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={5}
                        value={minChangeRate * 100}
                        onChange={(e) => setMinChangeRate(Number(e.target.value) / 100)}
                        className="flex-1 accent-primary h-1.5"
                      />
                      <span className="text-xs font-mono text-muted-foreground w-10 text-right">
                        {(minChangeRate * 100).toFixed(0)}%
                      </span>
                    </div>
                  </div>

                  {/* Run button */}
                  <Button
                    onClick={runHeatmap}
                    disabled={!hasLog || heatmapLoading}
                    className="w-full mt-1"
                  >
                    {heatmapLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    ) : (
                      <Search className="h-4 w-4 mr-2" />
                    )}
                    Analyser
                  </Button>
                </CardContent>
              </Card>
            )}

            {/* Auto-detect config */}
            {tab === "autodetect" && (
              <Card className="border-border/60">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Cpu className="h-4 w-4 text-primary" /> Parametres detection
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Analyse entropique + correlation temporelle pour detecter les frontieres de signaux
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  {/* Min entropy */}
                  <div className="flex flex-col gap-1.5">
                    <Label className="text-xs text-muted-foreground">
                      Seuil entropie min. (bits)
                      <span title="Entropie de Shannon minimum pour considerer un byte comme actif. 0=constant, 8=distribution uniforme. Valeur recommandee: 0.5">
                        <Info className="inline h-3 w-3 ml-1 text-muted-foreground cursor-help" />
                      </span>
                    </Label>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={0}
                        max={4}
                        step={0.1}
                        value={minEntropy}
                        onChange={(e) => setMinEntropy(Number(e.target.value))}
                        className="flex-1 accent-primary h-1.5"
                      />
                      <span className="text-xs font-mono text-muted-foreground w-10 text-right">
                        {minEntropy.toFixed(1)}
                      </span>
                    </div>
                  </div>

                  {/* Correlation threshold */}
                  <div className="flex flex-col gap-1.5">
                    <Label className="text-xs text-muted-foreground">
                      Seuil correlation adjacence
                      <span title="Seuil de correlation (Jaccard) pour grouper des bytes adjacents en un signal multi-byte. Plus eleve = moins de groupements. Valeur recommandee: 0.85">
                        <Info className="inline h-3 w-3 ml-1 text-muted-foreground cursor-help" />
                      </span>
                    </Label>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={50}
                        max={100}
                        step={5}
                        value={correlationThreshold * 100}
                        onChange={(e) => setCorrelationThreshold(Number(e.target.value) / 100)}
                        className="flex-1 accent-primary h-1.5"
                      />
                      <span className="text-xs font-mono text-muted-foreground w-10 text-right">
                        {(correlationThreshold * 100).toFixed(0)}%
                      </span>
                    </div>
                  </div>

                  {/* Pre-scan toggles */}
                  <div className="border-t border-border/40 pt-3 mt-1 flex flex-col gap-2.5">
                    <Label className="text-xs text-muted-foreground font-semibold">Pre-filtrage</Label>
                    <div className="flex items-center justify-between">
                      <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                        Exclure counters
                        <span title="Detecte les bytes qui s'incrementent de 1 a chaque trame (rolling counter) et les exclut de l'analyse.">
                          <Info className="inline h-3 w-3 cursor-help" />
                        </span>
                      </Label>
                      <Switch checked={excludeCounters} onCheckedChange={setExcludeCounters} />
                    </div>
                    <div className="flex items-center justify-between">
                      <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                        Exclure checksums
                        <span title="Detecte les bytes qui correspondent a un XOR8 ou SUM8 des autres bytes du message et les exclut.">
                          <Info className="inline h-3 w-3 cursor-help" />
                        </span>
                      </Label>
                      <Switch checked={excludeChecksums} onCheckedChange={setExcludeChecksums} />
                    </div>
                  </div>

                  {/* Run button */}
                  <Button
                    onClick={runAutoDetect}
                    disabled={!hasLog || detectLoading}
                    className="w-full mt-1"
                  >
                    {detectLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    ) : (
                      <Zap className="h-4 w-4 mr-2" />
                    )}
                    Lancer la detection
                  </Button>
                </CardContent>
              </Card>
            )}

            {/* Dependencies config */}
            {tab === "dependencies" && (
              <Card className="border-border/60">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <GitBranch className="h-4 w-4 text-primary" /> Parametres dependances
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Detecte les IDs qui reagissent apres un changement de payload sur un ID source.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1.5">
                    <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                      Fenetre temporelle (ms)
                      <span title="Duree apres un evenement source pendant laquelle on observe les reactions des autres IDs. 5-20 ms recommande.">
                        <Info className="inline h-3 w-3 cursor-help" />
                      </span>
                    </Label>
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min={1}
                        max={50}
                        step={1}
                        value={depWindowMs}
                        onChange={(e) => setDepWindowMs(Number(e.target.value))}
                        className="flex-1 accent-primary"
                      />
                      <span className="text-xs font-mono w-10 text-right">{depWindowMs} ms</span>
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                      Score minimum
                      <span title="Seuil de score pour afficher une arete. Plus eleve = moins de faux positifs. 0.1 = toutes les correlations detectees.">
                        <Info className="inline h-3 w-3 cursor-help" />
                      </span>
                    </Label>
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min={0.05}
                        max={0.8}
                        step={0.05}
                        value={depMinScore}
                        onChange={(e) => setDepMinScore(Number(e.target.value))}
                        className="flex-1 accent-primary"
                      />
                      <span className="text-xs font-mono w-10 text-right">{(depMinScore * 100).toFixed(0)}%</span>
                    </div>
                  </div>

                  <Button
                    onClick={runDependencies}
                    disabled={!hasLog || depLoading}
                    className="w-full mt-1"
                  >
                    {depLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    ) : (
                      <Search className="h-4 w-4 mr-2" />
                    )}
                    Analyser les dependances
                  </Button>
                </CardContent>
              </Card>
            )}

            {/* Color legend (heatmap tab) */}
            {tab === "heatmap" && (
              <Card className="border-border/60">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs text-muted-foreground">Legende</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center h-5 rounded-md overflow-hidden">
                      {[0, 0.05, 0.15, 0.3, 0.5, 0.7, 0.85, 1].map((v) => (
                        <div
                          key={v}
                          className="flex-1 h-full"
                          style={{ backgroundColor: heatColor(v) }}
                        />
                      ))}
                    </div>
                    <div className="flex justify-between text-[9px] font-mono text-muted-foreground">
                      <span>0% constant</span>
                      <span>50%</span>
                      <span>100% variable</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Right column: Results */}
          <div className="flex flex-col gap-4">
            {/* HEATMAP TAB */}
            {tab === "heatmap" && (
              <Card className="border-border/60">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <BarChart3 className="h-4 w-4 text-primary" /> Matrice de variabilite
                    </CardTitle>
                    {heatmapResult && (
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span>{filteredHeatmapIds.length} / {heatmapResult.total_ids} IDs</span>
                        <span>{heatmapResult.total_frames.toLocaleString()} trames</span>
                        <Badge variant="outline" className="text-[10px]">{heatmapResult.elapsed_ms} ms</Badge>
                      </div>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  {heatmapError && (
                    <Alert variant="destructive" className="mb-3">
                      <AlertCircle className="h-4 w-4" />
                      <AlertDescription>{heatmapError}</AlertDescription>
                    </Alert>
                  )}

                  {!heatmapResult && !heatmapLoading && !heatmapError && (
                    <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                      <BarChart3 className="h-10 w-10 mb-3 opacity-40" />
                      <p className="text-sm font-medium">Aucune analyse lancee</p>
                      <p className="text-xs mt-1">Selectionnez un log et cliquez Analyser</p>
                    </div>
                  )}

                  {heatmapLoading && (
                    <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                      <Loader2 className="h-8 w-8 animate-spin mb-3 text-primary" />
                      <p className="text-sm">Analyse en cours...</p>
                    </div>
                  )}

                  {heatmapResult && !heatmapLoading && (
                    <ScrollArea className="max-h-[600px]">
                      {/* Column headers */}
                      <div className="flex items-center gap-2 py-1.5 px-2 border-b border-border/60 sticky top-0 bg-card z-10">
                        <div className="w-3.5" /> {/* expand icon space */}
                        <span className="text-[10px] font-semibold text-muted-foreground w-12">ID</span>
                        <span className="text-[10px] font-semibold text-muted-foreground w-16 text-right">Freq</span>
                        <div className="flex gap-0.5 ml-2">
                          {Array.from({ length: 8 }, (_, i) => (
                            <div key={i} className="w-[52px] text-center text-[9px] font-mono text-muted-foreground font-semibold">
                              B{i}
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Rows */}
                      {filteredHeatmapIds.map((entry) => (
                        <HeatmapRow
                          key={entry.can_id}
                          entry={entry}
                          mode={heatmapMode}
                          expanded={expandedIds.has(entry.can_id)}
                          onToggle={() => toggleExpanded(entry.can_id)}
                        />
                      ))}

                      {filteredHeatmapIds.length === 0 && (
                        <div className="text-center py-8 text-muted-foreground text-xs">
                          Aucun ID ne correspond aux filtres actuels
                        </div>
                      )}
                    </ScrollArea>
                  )}
                </CardContent>
              </Card>
            )}

            {/* AUTO-DETECT TAB */}
            {tab === "autodetect" && (
              <>
                <Card className="border-border/60">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <Cpu className="h-4 w-4 text-primary" /> Signaux detectes
                      </CardTitle>
                  {detectResult && (
                    <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                      <span>{detectResult.total_signals_found} signaux</span>
                      <span>{detectResult.total_ids_analyzed} IDs analyses</span>
                      {detectResult.excluded_bytes && Object.keys(detectResult.excluded_bytes).length > 0 && (
                        <span className="text-amber-400">
                          {Object.values(detectResult.excluded_bytes).reduce(
                            (sum, byteMap) => sum + Object.keys(byteMap).length, 0
                          )} bytes exclus
                        </span>
                      )}
                      <Badge variant="outline" className="text-[10px]">{detectResult.elapsed_ms} ms</Badge>
                    </div>
                  )}
                    </div>
                  </CardHeader>
                  <CardContent>
                    {detectError && (
                      <Alert variant="destructive" className="mb-3">
                        <AlertCircle className="h-4 w-4" />
                        <AlertDescription>{detectError}</AlertDescription>
                      </Alert>
                    )}

                    {!detectResult && !detectLoading && !detectError && (
                      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                        <Cpu className="h-10 w-10 mb-3 opacity-40" />
                        <p className="text-sm font-medium">Aucune detection lancee</p>
                        <p className="text-xs mt-1">Configurez les parametres et cliquez Lancer la detection</p>
                      </div>
                    )}

                    {detectLoading && (
                      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                        <Loader2 className="h-8 w-8 animate-spin mb-3 text-primary" />
                        <p className="text-sm">Detection en cours... Analyse entropique et correlation temporelle</p>
                      </div>
                    )}

                    {detectResult && !detectLoading && detectResult.detected_signals.length > 0 && (
                      <>
                        {/* Action bar */}
                        <div className="flex items-center gap-2 mb-3">
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-xs h-7"
                            onClick={selectAllSignals}
                          >
                            {selectedSignals.size === detectResult.detected_signals.length ? (
                              <><EyeOff className="h-3 w-3 mr-1" /> Deselectionner tout</>
                            ) : (
                              <><Eye className="h-3 w-3 mr-1" /> Selectionner tout</>
                            )}
                          </Button>
                          {hasMission && (
                            <Button
                              size="sm"
                              className="text-xs h-7"
                              onClick={saveSignalsToDBC}
                              disabled={savingDBC || selectedSignals.size === 0}
                            >
                              {savingDBC ? (
                                <Loader2 className="h-3 w-3 animate-spin mr-1" />
                              ) : (
                                <Save className="h-3 w-3 mr-1" />
                              )}
                              {selectedSignals.size > 0
                                ? `Sauvegarder ${selectedSignals.size} signal(s) dans DBC`
                                : "Cochez des signaux pour sauvegarder"}
                            </Button>
                          )}
                          {!hasMission && (
                            <span className="text-[10px] text-muted-foreground italic">
                              Selectionnez une mission pour sauvegarder dans le DBC
                            </span>
                          )}
                          <span className="text-xs text-muted-foreground ml-auto">
                            {selectedSignals.size} selectionne(s)
                          </span>
                        </div>

                        {/* Excluded bytes summary */}
                        {detectResult.excluded_bytes && Object.keys(detectResult.excluded_bytes).length > 0 && (
                          <div className="mb-3 rounded-lg border border-amber-600/30 bg-amber-900/10 p-3">
                            <p className="text-xs font-semibold text-amber-400 mb-2">
                              Bytes exclus (counters / checksums)
                            </p>
                            <div className="flex flex-wrap gap-x-4 gap-y-1">
                              {Object.entries(detectResult.excluded_bytes).map(([canId, byteMap]) => (
                                <div key={canId} className="flex items-center gap-1.5 text-[11px]">
                                  <span className="font-mono text-primary font-semibold">{canId}</span>
                                  {Object.entries(byteMap).map(([bi, info]) => (
                                    <Badge
                                      key={bi}
                                      variant="outline"
                                      className={cn(
                                        "text-[9px] h-5 px-1.5",
                                        info.type === "counter"
                                          ? "border-amber-600/50 text-amber-400"
                                          : "border-violet-600/50 text-violet-400"
                                      )}
                                      title={
                                        info.type === "counter"
                                          ? `Counter ${info.mode} (${((info.ratio ?? 0) * 100).toFixed(0)}% increments)`
                                          : `Checksum ${info.algo} (${((info.match_rate ?? 0) * 100).toFixed(0)}% match)`
                                      }
                                    >
                                      B{bi} {info.type === "counter" ? "CNT" : "CKS"}
                                      <span className="ml-0.5 opacity-70">
                                        {info.type === "counter"
                                          ? `${((info.ratio ?? 0) * 100).toFixed(0)}%`
                                          : `${info.algo} ${((info.match_rate ?? 0) * 100).toFixed(0)}%`}
                                      </span>
                                    </Badge>
                                  ))}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        <div className="max-h-[500px] overflow-y-auto overflow-x-hidden rounded-md border border-border/30">
                          <Table>
                            <TableHeader className="sticky top-0 z-10 bg-card">
                              <TableRow>
                                <TableHead className="w-8"></TableHead>
                                <TableHead className="text-[10px]">CAN ID</TableHead>
                                <TableHead className="text-[10px]">Nom</TableHead>
                                <TableHead className="text-[10px]">Bytes</TableHead>
                                <TableHead className="text-[10px]">Taille</TableHead>
                                <TableHead className="text-[10px]">Ordre</TableHead>
                                <TableHead className="text-[10px]">Plage</TableHead>
                                <TableHead className="text-[10px]">Entropie</TableHead>
                                <TableHead className="text-[10px]">Confiance</TableHead>
                                <TableHead className="text-[10px] w-8"></TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {detectResult.detected_signals.map((sig) => (
                                <TableRow
                                  key={sig.name}
                                  className={cn(
                                    "cursor-pointer transition-colors",
                                    inspectedSignal?.name === sig.name && "bg-primary/10"
                                  )}
                                  onClick={() => setInspectedSignal(sig)}
                                >
                                  <TableCell>
                                    <input
                                      type="checkbox"
                                      className="accent-primary"
                                      checked={selectedSignals.has(sig.name)}
                                      onChange={(e) => {
                                        e.stopPropagation()
                                        toggleSignal(sig.name)
                                      }}
                                      onClick={(e) => e.stopPropagation()}
                                    />
                                  </TableCell>
                                  <TableCell className="font-mono text-xs text-primary font-semibold">
                                    {sig.can_id}
                                  </TableCell>
                                  <TableCell className="font-mono text-xs">
                                    <div className="flex items-center gap-1.5">
                                      {sig.name}
                                      {savedSignals.has(sig.name) && (
                                        <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                                      )}
                                    </div>
                                  </TableCell>
                                  <TableCell>
                                    <SignalByteMap
                                      signal={sig}
                                      excludedBytes={detectResult.excluded_bytes?.[sig.can_id]}
                                    />
                                  </TableCell>
                                  <TableCell className="text-xs font-mono">
                                    {sig.bit_length}b
                                  </TableCell>
                                  <TableCell className="text-xs">
                                    <Badge variant="outline" className="text-[9px]">
                                      {sig.byte_order === "big_endian" ? "BE" : "LE"}
                                    </Badge>
                                  </TableCell>
                                  <TableCell className="text-xs font-mono">
                                    {sig.value_range[0]} - {sig.value_range[1]}
                                  </TableCell>
                                  <TableCell className="text-xs font-mono">
                                    {sig.entropy.toFixed(2)}
                                  </TableCell>
                                  <TableCell>
                                    {confidenceBadge(sig.confidence)}
                                  </TableCell>
                                  <TableCell>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        setInspectedSignal(sig)
                                      }}
                                      className="text-muted-foreground hover:text-foreground transition-colors"
                                    >
                                      <Eye className="h-3.5 w-3.5" />
                                    </button>
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      </>
                    )}

                    {detectResult && !detectLoading && detectResult.detected_signals.length === 0 && (
                      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                        <Search className="h-8 w-8 mb-3 opacity-40" />
                        <p className="text-sm font-medium">Aucun signal detecte</p>
                        <p className="text-xs mt-1">Essayez de baisser le seuil d{"'"}entropie ou de correlation</p>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </>
            )}

            {/* Dependencies results */}
            {tab === "dependencies" && (
              <>
                <Card className="border-border/60">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <GitBranch className="h-4 w-4 text-primary" /> Graphe de dependances
                      </CardTitle>
                      {depResult && (
                        <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                          <span>{depResult.edges.length} aretes</span>
                          <span>{depResult.nodes.length} noeuds</span>
                          <span>{depResult.active_ids} IDs actifs</span>
                          <Badge variant="outline" className="text-[10px]">{depResult.elapsed_ms} ms</Badge>
                        </div>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent>
                    {depLoading && (
                      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                        <Loader2 className="h-8 w-8 animate-spin mb-3 opacity-40" />
                        <p className="text-sm">Analyse des dependances inter-ID...</p>
                      </div>
                    )}
                    {depError && (
                      <Alert variant="destructive">
                        <AlertCircle className="h-4 w-4" />
                        <AlertTitle>Erreur</AlertTitle>
                        <AlertDescription>{depError}</AlertDescription>
                      </Alert>
                    )}

                    {!depLoading && !depError && !depResult && (
                      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                        <GitBranch className="h-8 w-8 mb-3 opacity-40" />
                        <p className="text-sm font-medium">Selectionnez un log et lancez l{"'"}analyse</p>
                        <p className="text-xs mt-1">Detecte quels IDs changent juste apres un evenement sur un autre ID</p>
                      </div>
                    )}

                    {depResult && !depLoading && depResult.edges.length > 0 && (
                      <>
                        {/* Mini graph - visual node layout */}
                        <div className="mb-4 rounded-lg border border-border/40 bg-muted/20 p-4">
                          <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-3">Vue graphe</p>
                          <div className="flex flex-wrap gap-3 items-center justify-center">
                            {depResult.nodes.map((node) => (
                              <div
                                key={node.id}
                                className={cn(
                                  "flex flex-col items-center gap-0.5 px-3 py-2 rounded-lg border transition-colors cursor-default",
                                  node.role === "source"
                                    ? "bg-primary/15 border-primary/40 text-primary"
                                    : node.role === "target"
                                      ? "bg-emerald-900/20 border-emerald-600/40 text-emerald-400"
                                      : "bg-amber-900/15 border-amber-600/40 text-amber-400"
                                )}
                              >
                                <span className="font-mono text-sm font-bold">{node.id}</span>
                                <span className="text-[9px] opacity-70">
                                  {node.event_count} evt
                                </span>
                                <div className="flex gap-1 text-[8px]">
                                  {node.out_degree > 0 && (
                                    <span className="opacity-60">{node.out_degree} out</span>
                                  )}
                                  {node.in_degree > 0 && (
                                    <span className="opacity-60">{node.in_degree} in</span>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                          {/* Legend */}
                          <div className="flex gap-4 mt-3 justify-center text-[9px] text-muted-foreground">
                            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-primary/60" /> Source</span>
                            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500/60" /> Cible</span>
                            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500/60" /> Les deux</span>
                          </div>
                        </div>

                        {/* Edges table */}
                        <div className="max-h-[400px] overflow-y-auto overflow-x-hidden rounded-md border border-border/30">
                          <Table>
                            <TableHeader className="sticky top-0 z-10 bg-card">
                              <TableRow>
                                <TableHead className="text-[10px]">Source</TableHead>
                                <TableHead className="text-[10px] w-8"></TableHead>
                                <TableHead className="text-[10px]">Cible</TableHead>
                                <TableHead className="text-[10px]">Co-occ.</TableHead>
                                <TableHead className="text-[10px]">P(react)</TableHead>
                                <TableHead className="text-[10px]">Lift</TableHead>
                                <TableHead className="text-[10px]">Score</TableHead>
                                <TableHead className="text-[10px] w-8"></TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {depResult.edges.map((edge, i) => {
                                const scoreColor =
                                  edge.score >= 0.7 ? "text-emerald-400 bg-emerald-900/30 border-emerald-600/40"
                                    : edge.score >= 0.4 ? "text-amber-400 bg-amber-900/30 border-amber-600/40"
                                      : "text-muted-foreground bg-muted/30 border-border/40"
                                return (
                                  <TableRow
                                    key={`${edge.source}-${edge.target}-${i}`}
                                    className={cn(
                                      "cursor-pointer hover:bg-muted/30 transition-colors",
                                      depSelectedEdge?.source === edge.source && depSelectedEdge?.target === edge.target
                                        ? "bg-primary/10"
                                        : ""
                                    )}
                                    onClick={() => setDepSelectedEdge(
                                      depSelectedEdge?.source === edge.source && depSelectedEdge?.target === edge.target
                                        ? null
                                        : edge
                                    )}
                                  >
                                    <TableCell className="font-mono text-xs font-semibold text-primary">
                                      {edge.source}
                                    </TableCell>
                                    <TableCell>
                                      <ArrowRight className="h-3 w-3 text-muted-foreground" />
                                    </TableCell>
                                    <TableCell className="font-mono text-xs font-semibold text-emerald-400">
                                      {edge.target}
                                    </TableCell>
                                    <TableCell className="text-xs font-mono">
                                      {edge.co_occurrences} / {edge.source_events}
                                    </TableCell>
                                    <TableCell className="text-xs font-mono">
                                      {(edge.p_react * 100).toFixed(1)}%
                                    </TableCell>
                                    <TableCell className="text-xs font-mono">
                                      {edge.lift.toFixed(1)}x
                                    </TableCell>
                                    <TableCell>
                                      <Badge
                                        variant="outline"
                                        className={cn("text-[10px] font-mono", scoreColor)}
                                      >
                                        {(edge.score * 100).toFixed(0)}%
                                      </Badge>
                                    </TableCell>
                                    <TableCell>
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          requestCausalityValidation(edge)
                                        }}
                                        disabled={causalityLoading}
                                        className={cn(
                                          "p-1 rounded hover:bg-muted/50 transition-colors",
                                          causalityLoading && causalityEdge?.source === edge.source && causalityEdge?.target === edge.target
                                            ? "text-primary animate-pulse"
                                            : "text-muted-foreground hover:text-foreground"
                                        )}
                                        title="Valider la causalite par injection"
                                      >
                                        <FlaskConical className="h-3.5 w-3.5" />
                                      </button>
                                    </TableCell>
                                  </TableRow>
                                )
                              })}
                            </TableBody>
                          </Table>
                        </div>
                      </>
                    )}

                    {depResult && !depLoading && depResult.edges.length === 0 && (
                      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                        <Search className="h-8 w-8 mb-3 opacity-40" />
                        <p className="text-sm font-medium">Aucune dependance detectee</p>
                        <p className="text-xs mt-1">Essayez d{"'"}augmenter la fenetre temporelle ou de baisser le score minimum</p>
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Selected edge detail */}
                {depSelectedEdge && (
                  <Card className="border-primary/30 bg-primary/5 xl:col-span-2">
                    <CardHeader className="pb-3">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-sm flex items-center gap-2">
                          <Zap className="h-4 w-4 text-primary" />
                          {depSelectedEdge.source}
                          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                          {depSelectedEdge.target}
                        </CardTitle>
                        <button
                          onClick={() => setDepSelectedEdge(null)}
                          className="text-muted-foreground hover:text-foreground text-xs"
                        >
                          Fermer
                        </button>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                        <div className="bg-muted/30 rounded-lg p-3 border border-border/30">
                          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Co-occurrences</p>
                          <p className="font-mono text-sm font-semibold text-foreground">
                            {depSelectedEdge.co_occurrences} / {depSelectedEdge.source_events} evt source
                          </p>
                        </div>
                        <div className="bg-muted/30 rounded-lg p-3 border border-border/30">
                          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">P(reaction)</p>
                          <p className="font-mono text-sm font-semibold text-foreground">
                            {(depSelectedEdge.p_react * 100).toFixed(1)}%
                          </p>
                        </div>
                        <div className="bg-muted/30 rounded-lg p-3 border border-border/30">
                          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Lift</p>
                          <p className="font-mono text-sm font-semibold text-foreground">
                            {depSelectedEdge.lift.toFixed(2)}x
                            <span className="text-[10px] text-muted-foreground ml-1">
                              vs. hasard
                            </span>
                          </p>
                        </div>
                        <div className="bg-muted/30 rounded-lg p-3 border border-border/30">
                          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Evt cible</p>
                          <p className="font-mono text-sm font-semibold text-foreground">
                            {depSelectedEdge.target_events} changements
                          </p>
                        </div>
                      </div>
                      <div className="mt-3 text-xs text-muted-foreground">
                        <p>
                          Quand <span className="font-mono text-primary font-semibold">{depSelectedEdge.source}</span> change de payload,
                          {" "}<span className="font-mono text-emerald-400 font-semibold">{depSelectedEdge.target}</span> reagit dans les {depWindowMs} ms
                          {" "}dans <span className="font-semibold text-foreground">{(depSelectedEdge.p_react * 100).toFixed(1)}%</span> des cas
                          (vs. <span className="font-semibold text-foreground">{depSelectedEdge.lift > 0 ? ((depSelectedEdge.p_react / depSelectedEdge.lift) * 100).toFixed(1) : "0"}%</span> attendu par hasard).
                        </p>
                      </div>
                      {/* Validate causality button in edge detail */}
                      <div className="mt-3 pt-3 border-t border-border/30">
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-xs"
                          onClick={() => requestCausalityValidation(depSelectedEdge)}
                          disabled={causalityLoading}
                        >
                          {causalityLoading && causalityEdge?.source === depSelectedEdge.source && causalityEdge?.target === depSelectedEdge.target ? (
                            <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
                          ) : (
                            <FlaskConical className="h-3 w-3 mr-1.5" />
                          )}
                          Valider causalite par injection
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* Injection warning dialog */}
                {showCausalityWarning && pendingCausalityEdge && (
                  <Card className="border-amber-600/50 bg-amber-900/10 xl:col-span-2">
                    <CardContent className="pt-5">
                      <div className="flex gap-3">
                        <AlertTriangle className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
                        <div className="flex-1">
                          <p className="text-sm font-semibold text-amber-400">Injection active sur le bus CAN</p>
                          <p className="text-xs text-muted-foreground mt-1">
                            Cette operation va injecter la trame <span className="font-mono text-foreground">{pendingCausalityEdge.source}</span> sur
                            le bus CAN et observer si <span className="font-mono text-foreground">{pendingCausalityEdge.target}</span> reagit.
                            Utilisez uniquement en environnement de test, jamais sur un vehicule en circulation.
                          </p>
                          <div className="flex gap-2 mt-3">
                            <Button
                              size="sm"
                              className="text-xs bg-amber-600 hover:bg-amber-700 text-white"
                              onClick={runCausalityValidation}
                            >
                              <FlaskConical className="h-3 w-3 mr-1.5" />
                              Confirmer (5 injections)
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-xs"
                              onClick={() => { setShowCausalityWarning(false); setPendingCausalityEdge(null) }}
                            >
                              Annuler
                            </Button>
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* Causality validation results */}
                {(causalityLoading || causalityResult || causalityError) && causalityEdge && (
                  <Card className="border-border/60 xl:col-span-2">
                    <CardHeader className="pb-3">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-sm flex items-center gap-2">
                          <FlaskConical className="h-4 w-4 text-primary" />
                          Validation causale : {causalityEdge.source} <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" /> {causalityEdge.target}
                        </CardTitle>
                        {!causalityLoading && (
                          <button
                            onClick={() => { setCausalityResult(null); setCausalityError(null); setCausalityEdge(null) }}
                            className="text-muted-foreground hover:text-foreground text-xs"
                          >
                            Fermer
                          </button>
                        )}
                      </div>
                    </CardHeader>
                    <CardContent>
                      {causalityLoading && (
                        <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                          <Loader2 className="h-8 w-8 animate-spin mb-3 opacity-40" />
                          <p className="text-sm">Injection en cours... observation des reactions</p>
                          <p className="text-[10px] mt-1">5 tentatives avec pause entre chaque injection</p>
                        </div>
                      )}
                      {causalityError && (
                        <Alert variant="destructive">
                          <AlertCircle className="h-4 w-4" />
                          <AlertTitle>Erreur</AlertTitle>
                          <AlertDescription>{causalityError}</AlertDescription>
                        </Alert>
                      )}
                      {causalityResult && !causalityLoading && (
                        <>
                          {/* Classification banner */}
                          <div className={cn(
                            "rounded-lg border p-3 mb-4 flex items-center gap-3",
                            causalityResult.classification === "high"
                              ? "bg-emerald-900/15 border-emerald-600/40"
                              : causalityResult.classification === "moderate"
                                ? "bg-amber-900/15 border-amber-600/40"
                                : "bg-red-900/15 border-red-600/40"
                          )}>
                            <div className={cn(
                              "h-10 w-10 rounded-full flex items-center justify-center shrink-0",
                              causalityResult.classification === "high"
                                ? "bg-emerald-600/20"
                                : causalityResult.classification === "moderate"
                                  ? "bg-amber-600/20"
                                  : "bg-red-600/20"
                            )}>
                              {causalityResult.classification === "high" ? (
                                <Check className="h-5 w-5 text-emerald-400" />
                              ) : causalityResult.classification === "moderate" ? (
                                <AlertTriangle className="h-5 w-5 text-amber-400" />
                              ) : (
                                <X className="h-5 w-5 text-red-400" />
                              )}
                            </div>
                            <div>
                              <p className={cn(
                                "text-sm font-semibold",
                                causalityResult.classification === "high"
                                  ? "text-emerald-400"
                                  : causalityResult.classification === "moderate"
                                    ? "text-amber-400"
                                    : "text-red-400"
                              )}>
                                Causalite {causalityResult.classification === "high" ? "ELEVEE" : causalityResult.classification === "moderate" ? "MODEREE" : "FAIBLE"}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {causalityResult.successes} / {causalityResult.attempts} reactions observees ({(causalityResult.success_rate * 100).toFixed(0)}%)
                              </p>
                            </div>
                          </div>

                          {/* Stats grid */}
                          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                            <div className="bg-muted/30 rounded-lg p-3 border border-border/30">
                              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Taux de succes</p>
                              <p className="font-mono text-sm font-semibold text-foreground">{(causalityResult.success_rate * 100).toFixed(0)}%</p>
                            </div>
                            <div className="bg-muted/30 rounded-lg p-3 border border-border/30">
                              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Lag median</p>
                              <p className="font-mono text-sm font-semibold text-foreground">
                                {causalityResult.median_lag_ms != null ? `${causalityResult.median_lag_ms.toFixed(1)} ms` : "--"}
                              </p>
                            </div>
                            <div className="bg-muted/30 rounded-lg p-3 border border-border/30">
                              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Lag min / max</p>
                              <p className="font-mono text-sm font-semibold text-foreground">
                                {causalityResult.min_lag_ms != null ? `${causalityResult.min_lag_ms.toFixed(1)}` : "--"}
                                {" / "}
                                {causalityResult.max_lag_ms != null ? `${causalityResult.max_lag_ms.toFixed(1)} ms` : "--"}
                              </p>
                            </div>
                            <div className="bg-muted/30 rounded-lg p-3 border border-border/30">
                              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Payload injecte</p>
                              <p className="font-mono text-sm font-semibold text-primary">{causalityResult.source_payload}</p>
                            </div>
                          </div>

                          {/* Per-attempt detail */}
                          <div className="mt-4">
                            <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2">Detail par tentative</p>
                            <div className="flex gap-1.5 flex-wrap">
                              {causalityResult.details.map((d) => (
                                <div
                                  key={d.attempt}
                                  className={cn(
                                    "flex items-center gap-1 px-2 py-1 rounded border text-[10px] font-mono",
                                    !d.injected
                                      ? "bg-red-900/20 border-red-600/30 text-red-400"
                                      : d.reaction
                                        ? "bg-emerald-900/20 border-emerald-600/30 text-emerald-400"
                                        : "bg-muted/30 border-border/30 text-muted-foreground"
                                  )}
                                  title={d.error || (d.reaction ? `Reaction en ${d.lag_ms?.toFixed(1)} ms` : "Pas de reaction")}
                                >
                                  #{d.attempt}
                                  {!d.injected ? (
                                    <X className="h-2.5 w-2.5" />
                                  ) : d.reaction ? (
                                    <><Check className="h-2.5 w-2.5" /> {d.lag_ms?.toFixed(1)} ms</>
                                  ) : (
                                    <X className="h-2.5 w-2.5" />
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        </>
                      )}
                    </CardContent>
                  </Card>
                )}
              </>
            )}

            {/* Inspected signal detail -- rendered OUTSIDE the grid, full width below */}
            {tab === "autodetect" && inspectedSignal && (
              <div className="xl:col-span-2">
                <Card className="border-primary/30 bg-primary/5">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <Zap className="h-4 w-4 text-primary" />
                        Detail : {inspectedSignal.name}
                      </CardTitle>
                      <button
                        onClick={() => setInspectedSignal(null)}
                        className="text-muted-foreground hover:text-foreground text-xs"
                      >
                        Fermer
                      </button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                      <div className="bg-muted/30 rounded-lg p-3 border border-border/30">
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wide">CAN ID</p>
                        <p className="font-mono text-sm font-semibold text-primary">{inspectedSignal.can_id}</p>
                      </div>
                      <div className="bg-muted/30 rounded-lg p-3 border border-border/30">
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Position</p>
                        <p className="font-mono text-sm font-semibold text-foreground">
                          Byte {inspectedSignal.start_byte} ({inspectedSignal.bit_length} bits)
                        </p>
                      </div>
                      <div className="bg-muted/30 rounded-lg p-3 border border-border/30">
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Byte Order</p>
                        <p className="text-sm font-semibold text-foreground">
                          {inspectedSignal.byte_order === "big_endian" ? "Big Endian" : "Little Endian"}
                          {inspectedSignal.is_signed && " (signe)"}
                        </p>
                      </div>
                      <div className="bg-muted/30 rounded-lg p-3 border border-border/30">
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Confiance</p>
                        <p className="text-sm font-semibold text-foreground">{(inspectedSignal.confidence * 100).toFixed(1)}%</p>
                      </div>
                    </div>

                    {/* Byte map large */}
                    <div className="mt-4">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2">Carte des bytes</p>
                      <div className="flex gap-1">
                        {Array.from({ length: 8 }, (_, i) => {
                          const inSig = i >= inspectedSignal.start_byte && i < inspectedSignal.start_byte + inspectedSignal.length_bytes
                          return (
                            <div
                              key={i}
                              className={cn(
                                "flex-1 h-10 rounded-md flex flex-col items-center justify-center border text-xs font-mono transition-colors",
                                inSig
                                  ? "bg-primary/25 border-primary/60 text-primary font-bold"
                                  : "bg-muted/20 border-border/30 text-muted-foreground"
                              )}
                            >
                              <span className="text-[9px] opacity-60">Byte</span>
                              <span>{i}</span>
                            </div>
                          )
                        })}
                      </div>
                    </div>

                    {/* Sample values */}
                    <div className="mt-4">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2">Echantillons de valeurs decodees</p>
                      <div className="flex flex-wrap gap-1.5">
                        {inspectedSignal.sample_values.map((v, i) => (
                          <Badge key={i} variant="outline" className="font-mono text-xs">
                            {v}
                          </Badge>
                        ))}
                      </div>
                    </div>

                    {/* Metrics row */}
                    <div className="mt-4 grid grid-cols-3 gap-3">
                      <div className="text-center">
                        <p className="text-[10px] text-muted-foreground">Entropie</p>
                        <p className="font-mono text-sm font-semibold text-foreground">{inspectedSignal.entropy.toFixed(3)} bits</p>
                      </div>
                      <div className="text-center">
                        <p className="text-[10px] text-muted-foreground">Change Rate</p>
                        <p className="font-mono text-sm font-semibold text-foreground">{(inspectedSignal.change_rate * 100).toFixed(1)}%</p>
                      </div>
                      <div className="text-center">
                        <p className="text-[10px] text-muted-foreground">Plage</p>
                        <p className="font-mono text-sm font-semibold text-foreground">{inspectedSignal.value_range[0]} - {inspectedSignal.value_range[1]}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  )
}
