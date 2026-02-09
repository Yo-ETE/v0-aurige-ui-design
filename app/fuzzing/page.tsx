"use client"

import { useState, useEffect, useCallback, useMemo } from "react"
import { AppShell } from "@/components/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Flame,
  AlertTriangle,
  Play,
  Square,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Database,
  Shuffle,
  FileText,
  SlidersHorizontal,
  Target,
  BarChart3,
  RefreshCw,
} from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  startFuzzing,
  stopFuzzing,
  getFuzzingStatus,
  getLogsAnalysis,
  type ProcessStatus,
  type CANInterface,
  type FuzzDataMode,
  type FuzzingParams,
  type LogIdAnalysis,
  type LogsAnalysis,
} from "@/lib/api"
import { useMissionStore } from "@/lib/mission-store"
import { SentFramesHistory, useSentFramesHistory } from "@/components/sent-frames-history"
import { cn } from "@/lib/utils"

// ---- Data Mode Card ----
function DataModeOption({
  mode,
  selected,
  onSelect,
  title,
  description,
  icon: Icon,
  disabled,
}: {
  mode: FuzzDataMode
  selected: boolean
  onSelect: (m: FuzzDataMode) => void
  title: string
  description: string
  icon: React.ElementType
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onSelect(mode)}
      disabled={disabled}
      className={cn(
        "flex items-start gap-3 rounded-lg border p-3 text-left transition-all",
        selected
          ? "border-primary bg-primary/5 ring-1 ring-primary/30"
          : "border-border bg-card hover:border-primary/30 hover:bg-accent/30",
        disabled && "opacity-40 cursor-not-allowed"
      )}
    >
      <div
        className={cn(
          "flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md",
          selected ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
        )}
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <p className={cn("text-sm font-medium", selected ? "text-primary" : "text-foreground")}>
          {title}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
    </button>
  )
}

// ---- Byte Range Viz ----
function ByteRangeBar({ index, min, max, unique }: { index: number; min: number; max: number; unique: number }) {
  const range = max - min
  const pct = (range / 255) * 100
  const offset = (min / 255) * 100

  return (
    <div className="flex items-center gap-2 text-xs font-mono">
      <span className="w-6 text-muted-foreground text-right">B{index}</span>
      <div className="flex-1 h-3 bg-muted rounded-full relative overflow-hidden">
        <div
          className={cn(
            "absolute h-full rounded-full",
            pct > 80 ? "bg-warning/60" : pct > 30 ? "bg-primary/50" : "bg-success/50"
          )}
          style={{ left: `${offset}%`, width: `${Math.max(pct, 2)}%` }}
        />
      </div>
      <span className="w-16 text-muted-foreground text-right">
        {min.toString(16).toUpperCase().padStart(2, "0")}-{max.toString(16).toUpperCase().padStart(2, "0")}
      </span>
      <span className="w-8 text-muted-foreground/50 text-right">{unique}v</span>
    </div>
  )
}

// ---- Log ID Selector Row ----
function LogIdRow({
  entry,
  selected,
  onToggle,
}: {
  entry: LogIdAnalysis
  selected: boolean
  onToggle: (id: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(entry.canId)}
      className={cn(
        "flex items-center gap-3 w-full rounded-md border px-3 py-2 text-left transition-all text-xs",
        selected
          ? "border-primary/50 bg-primary/5"
          : "border-transparent hover:bg-accent/30"
      )}
    >
      <div
        className={cn(
          "h-4 w-4 flex-shrink-0 rounded border-2 flex items-center justify-center",
          selected ? "border-primary bg-primary" : "border-muted-foreground/30"
        )}
      >
        {selected && <CheckCircle2 className="h-3 w-3 text-primary-foreground" />}
      </div>
      <span className="font-mono font-bold text-primary w-10">{entry.canId}</span>
      <span className="text-muted-foreground">{entry.count} trames</span>
      <span className="text-muted-foreground/50">{entry.sampleCount} uniques</span>
      <div className="ml-auto flex gap-1">
        {entry.samples.slice(0, 2).map((s, i) => (
          <span key={i} className="font-mono text-[10px] text-muted-foreground/50 bg-muted px-1 rounded">
            {s.length > 12 ? s.slice(0, 12) + "..." : s}
          </span>
        ))}
      </div>
    </button>
  )
}

// ==============================
// Main Page
// ==============================
export default function Fuzzing() {
  const currentMission = useMissionStore((s) => s.getCurrentMission())

  // Basic params
  const [canInterface, setCanInterface] = useState<CANInterface>("can0")
  const [idStart, setIdStart] = useState("000")
  const [idEnd, setIdEnd] = useState("7FF")
  const [dataTemplate, setDataTemplate] = useState("")
  const [iterations, setIterations] = useState("100")
  const [delay, setDelay] = useState("10")
  const [dlc, setDlc] = useState("8")

  // Data mode
  const [dataMode, setDataMode] = useState<FuzzDataMode>("random")

  // Status
  const [status, setStatus] = useState<ProcessStatus>({ running: false })
  const [isStarting, setIsStarting] = useState(false)
  const [isStopping, setIsStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // Progress simulation
  const [progress, setProgress] = useState(0)
  const [startTime, setStartTime] = useState<number | null>(null)

  // Log analysis for smart modes
  const [logsAnalysis, setLogsAnalysis] = useState<LogsAnalysis | null>(null)
  const [isLoadingLogs, setIsLoadingLogs] = useState(false)
  const [selectedLogIds, setSelectedLogIds] = useState<Set<string>>(new Set())

  // Sent frames history
  const { frames, addFrame, updateStatus: updateFrameStatus, clearHistory } = useSentFramesHistory()

  // ---- Fetch fuzzing status ----
  const fetchStatus = useCallback(async () => {
    try {
      const s = await getFuzzingStatus()
      setStatus(s)
      if (!s.running) {
        setProgress(0)
        setStartTime(null)
      }
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    fetchStatus()
    const interval = setInterval(fetchStatus, 2000)
    return () => clearInterval(interval)
  }, [fetchStatus])

  // ---- Load mission logs for smart modes ----
  const loadLogsAnalysis = useCallback(async () => {
    if (!currentMission?.id) return
    setIsLoadingLogs(true)
    try {
      const data = await getLogsAnalysis(currentMission.id)
      setLogsAnalysis(data)
      // Auto-select top 5 most frequent IDs
      const topIds = data.ids.slice(0, 5).map((e) => e.canId)
      setSelectedLogIds(new Set(topIds))
    } catch (err) {
      setError("Impossible de charger l'analyse des logs")
    } finally {
      setIsLoadingLogs(false)
    }
  }, [currentMission?.id])

  // Auto-load when mode requires logs
  useEffect(() => {
    if ((dataMode === "logs" || dataMode === "range") && !logsAnalysis && currentMission?.id) {
      loadLogsAnalysis()
    }
  }, [dataMode, logsAnalysis, currentMission?.id, loadLogsAnalysis])

  // ---- Toggle log ID selection ----
  const toggleLogId = useCallback((id: string) => {
    setSelectedLogIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // ---- Compute byte ranges from selected IDs ----
  const computedByteRanges = useMemo(() => {
    if (!logsAnalysis || selectedLogIds.size === 0) return []
    // Merge byte ranges across all selected IDs
    const merged: Map<number, { min: number; max: number; unique: number }> = new Map()
    for (const entry of logsAnalysis.ids) {
      if (!selectedLogIds.has(entry.canId)) continue
      for (const br of entry.byteRanges) {
        const existing = merged.get(br.index)
        if (existing) {
          existing.min = Math.min(existing.min, br.min)
          existing.max = Math.max(existing.max, br.max)
          existing.unique = Math.max(existing.unique, br.unique)
        } else {
          merged.set(br.index, { min: br.min, max: br.max, unique: br.unique })
        }
      }
    }
    return Array.from(merged.entries())
      .sort(([a], [b]) => a - b)
      .map(([index, v]) => ({ index, ...v }))
  }, [logsAnalysis, selectedLogIds])

  // ---- Simulate progress ----
  useEffect(() => {
    if (!status.running || !startTime) return
    const totalIterations = parseInt(iterations)
    const delayMs = parseInt(delay)
    const estimatedDurationMs = totalIterations * delayMs

    const interval = setInterval(() => {
      const elapsed = Date.now() - startTime
      const progressPercent = Math.min((elapsed / estimatedDurationMs) * 100, 99)
      setProgress(progressPercent)
    }, 200)

    return () => clearInterval(interval)
  }, [status.running, startTime, iterations, delay])

  // ---- Start fuzzing ----
  const handleStart = async () => {
    setError(null)
    setSuccess(null)
    setIsStarting(true)
    setProgress(0)

    const targetIds = selectedLogIds.size > 0 && (dataMode === "logs" || dataMode === "range")
      ? Array.from(selectedLogIds)
      : undefined

    const modeLabels: Record<FuzzDataMode, string> = {
      static: "Statique",
      random: "Aleatoire",
      range: "Plage (logs)",
      logs: "Replay mute (logs)",
    }

    const frameId = addFrame({
      canId: targetIds ? targetIds.join(",") : `${idStart}-${idEnd}`,
      data: `Mode: ${modeLabels[dataMode]}`,
      interface: canInterface,
      description: `${iterations} iterations`,
    })

    const params: FuzzingParams = {
      interface: canInterface,
      idStart,
      idEnd,
      iterations: parseInt(iterations),
      delayMs: parseFloat(delay),
      dataMode,
      dlc: parseInt(dlc),
      ...(dataMode === "static" && { dataTemplate }),
      ...(dataMode === "range" && { byteRanges: computedByteRanges }),
      ...(dataMode === "logs" && { missionId: currentMission?.id }),
      ...(targetIds && { targetIds }),
    }

    try {
      await startFuzzing(params)
      updateFrameStatus(frameId, "success")
      setSuccess(`Fuzzing ${modeLabels[dataMode]} demarre`)
      setStartTime(Date.now())
      await fetchStatus()
    } catch (err) {
      updateFrameStatus(frameId, "error")
      setError(err instanceof Error ? err.message : "Erreur lors du demarrage")
    } finally {
      setIsStarting(false)
    }
  }

  // ---- Stop ----
  const handleStop = async () => {
    setError(null)
    setIsStopping(true)
    try {
      await stopFuzzing()
      setSuccess("Fuzzing arrete")
      setProgress(0)
      setStartTime(null)
      await fetchStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur lors de l'arret")
    } finally {
      setIsStopping(false)
    }
  }

  const hasLogs = logsAnalysis && logsAnalysis.ids.length > 0
  const hasMission = !!currentMission?.id

  return (
    <AppShell
      title="Fuzzing"
      description={currentMission ? `Mission: ${currentMission.name}` : "Test de fuzzing CAN"}
    >
      <div className="grid gap-6">
        {/* Alerts */}
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

        {/* Warning */}
        <Alert className="border-warning/50 bg-warning/10">
          <AlertTriangle className="h-4 w-4 text-warning" />
          <AlertTitle className="text-warning">Attention - Utilisation dangereuse</AlertTitle>
          <AlertDescription className="text-warning/80">
            Le fuzzing envoie des trames CAN sur le bus. Cela peut provoquer des comportements
            inattendus. Utilisez uniquement sur des vehicules de test dans un environnement controle.
          </AlertDescription>
        </Alert>

        <div className="grid gap-6 lg:grid-cols-5">
          {/* Left column: Mode + Config */}
          <div className="lg:col-span-3 space-y-6">
            {/* Data Mode Selection */}
            <Card className="border-border bg-card">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                    <SlidersHorizontal className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <CardTitle className="text-lg">Mode de generation</CardTitle>
                    <CardDescription>Comment les donnees des trames sont generees</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid gap-3 sm:grid-cols-2">
                  <DataModeOption
                    mode="random"
                    selected={dataMode === "random"}
                    onSelect={setDataMode}
                    title="Aleatoire"
                    description="Octets generes aleatoirement (0x00-0xFF). Fuzzing classique."
                    icon={Shuffle}
                  />
                  <DataModeOption
                    mode="logs"
                    selected={dataMode === "logs"}
                    onSelect={setDataMode}
                    title="Base sur les logs"
                    description="Reprend les donnees observees dans les logs et mute 1-2 octets."
                    icon={Database}
                    disabled={!hasMission}
                  />
                  <DataModeOption
                    mode="range"
                    selected={dataMode === "range"}
                    onSelect={setDataMode}
                    title="Plage contrainte"
                    description="Octets aleatoires dans les min/max observes par octet dans les logs."
                    icon={BarChart3}
                    disabled={!hasMission}
                  />
                  <DataModeOption
                    mode="static"
                    selected={dataMode === "static"}
                    onSelect={setDataMode}
                    title="Statique"
                    description="Meme data fixe pour toutes les trames. Pour tester un payload precis."
                    icon={FileText}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Configuration */}
            <Card className="border-border bg-card">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-warning/10">
                    <Flame className="h-5 w-5 text-warning" />
                  </div>
                  <div>
                    <CardTitle className="text-lg">Parametres</CardTitle>
                    <CardDescription>Configuration du fuzzing</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Interface CAN</Label>
                    <Select
                      value={canInterface}
                      onValueChange={(v) => setCanInterface(v as CANInterface)}
                      disabled={status.running}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="can0">can0</SelectItem>
                        <SelectItem value="can1">can1</SelectItem>
                        <SelectItem value="vcan0">vcan0 (test)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>DLC (longueur)</Label>
                    <Select
                      value={dlc}
                      onValueChange={setDlc}
                      disabled={status.running}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                          <SelectItem key={n} value={String(n)}>
                            {n} octets
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* ID range - only for sweep modes (not targeted) */}
                {(dataMode === "random" || dataMode === "static") && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label>ID Start (hex)</Label>
                      <Input
                        value={idStart}
                        onChange={(e) => setIdStart(e.target.value.toUpperCase())}
                        className="font-mono"
                        placeholder="000"
                        disabled={status.running}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>ID End (hex)</Label>
                      <Input
                        value={idEnd}
                        onChange={(e) => setIdEnd(e.target.value.toUpperCase())}
                        className="font-mono"
                        placeholder="7FF"
                        disabled={status.running}
                      />
                    </div>
                  </div>
                )}

                {/* Static template */}
                {dataMode === "static" && (
                  <div className="space-y-2">
                    <Label>Data Template (hex, {parseInt(dlc) * 2} caracteres)</Label>
                    <Input
                      value={dataTemplate}
                      onChange={(e) => setDataTemplate(e.target.value.toUpperCase())}
                      className="font-mono"
                      placeholder={"00".repeat(parseInt(dlc))}
                      maxLength={parseInt(dlc) * 2}
                      disabled={status.running}
                    />
                  </div>
                )}

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Iterations</Label>
                    <Input
                      type="number"
                      value={iterations}
                      onChange={(e) => setIterations(e.target.value)}
                      max={100000}
                      disabled={status.running}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Delai (ms)</Label>
                    <Input
                      type="number"
                      value={delay}
                      onChange={(e) => setDelay(e.target.value)}
                      disabled={status.running}
                    />
                  </div>
                </div>

                {/* Action buttons */}
                <div className="flex gap-3 pt-2">
                  <Button
                    onClick={handleStart}
                    disabled={status.running || isStarting}
                    className="flex-1 gap-2"
                  >
                    {isStarting ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Play className="h-4 w-4" />
                    )}
                    Demarrer
                  </Button>
                  <Button
                    onClick={handleStop}
                    disabled={!status.running || isStopping}
                    variant="destructive"
                    className="flex-1 gap-2"
                  >
                    {isStopping ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Square className="h-4 w-4" />
                    )}
                    Arreter
                  </Button>
                </div>

                {/* Progress */}
                {status.running && (
                  <div className="space-y-2 rounded-lg bg-secondary/50 p-3">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Progression estimee</span>
                      <span className="font-mono text-foreground">{Math.round(progress)}%</span>
                    </div>
                    <Progress value={progress} className="h-2" />
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Right column: Log analysis */}
          <div className="lg:col-span-2 space-y-6">
            {/* Log Analysis Panel */}
            <Card className="border-border bg-card">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary">
                      <Target className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <CardTitle className="text-lg">Analyse des logs</CardTitle>
                      <CardDescription>
                        {hasMission
                          ? `Mission: ${currentMission.name}`
                          : "Selectionnez une mission"}
                      </CardDescription>
                    </div>
                  </div>
                  {hasMission && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={loadLogsAnalysis}
                      disabled={isLoadingLogs}
                      className="h-8"
                    >
                      <RefreshCw className={cn("h-3.5 w-3.5", isLoadingLogs && "animate-spin")} />
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {!hasMission && (
                  <div className="flex flex-col items-center justify-center py-8 text-center">
                    <Database className="h-10 w-10 text-muted-foreground/20 mb-3" />
                    <p className="text-sm text-muted-foreground">
                      Aucune mission selectionnee.
                    </p>
                    <p className="text-xs text-muted-foreground/60 mt-1">
                      Selectionnez une mission dans le menu pour utiliser les modes intelligents.
                    </p>
                  </div>
                )}

                {hasMission && isLoadingLogs && (
                  <div className="flex items-center justify-center gap-2 py-8">
                    <Loader2 className="h-5 w-5 animate-spin text-primary" />
                    <span className="text-sm text-muted-foreground">Analyse des logs en cours...</span>
                  </div>
                )}

                {hasMission && !isLoadingLogs && logsAnalysis && (
                  <div className="space-y-4">
                    {/* Summary */}
                    <div className="grid grid-cols-3 gap-2">
                      <div className="rounded-md bg-secondary/50 p-2 text-center">
                        <p className="text-lg font-bold text-foreground">{logsAnalysis.totalUniqueIds}</p>
                        <p className="text-[10px] text-muted-foreground">IDs uniques</p>
                      </div>
                      <div className="rounded-md bg-secondary/50 p-2 text-center">
                        <p className="text-lg font-bold text-foreground">{logsAnalysis.totalFrames.toLocaleString()}</p>
                        <p className="text-[10px] text-muted-foreground">Trames total</p>
                      </div>
                      <div className="rounded-md bg-secondary/50 p-2 text-center">
                        <p className="text-lg font-bold text-primary">{selectedLogIds.size}</p>
                        <p className="text-[10px] text-muted-foreground">IDs cibles</p>
                      </div>
                    </div>

                    {/* Select/Deselect all */}
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => setSelectedLogIds(new Set(logsAnalysis.ids.map((e) => e.canId)))}
                      >
                        Tout
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => {
                          const top10 = logsAnalysis.ids.slice(0, 10).map((e) => e.canId)
                          setSelectedLogIds(new Set(top10))
                        }}
                      >
                        Top 10
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => setSelectedLogIds(new Set())}
                      >
                        Aucun
                      </Button>
                      <span className="ml-auto text-[10px] text-muted-foreground">
                        {selectedLogIds.size}/{logsAnalysis.ids.length} selectionnes
                      </span>
                    </div>

                    {/* ID list */}
                    <ScrollArea className="h-64">
                      <div className="space-y-0.5">
                        {logsAnalysis.ids.map((entry) => (
                          <LogIdRow
                            key={entry.canId}
                            entry={entry}
                            selected={selectedLogIds.has(entry.canId)}
                            onToggle={toggleLogId}
                          />
                        ))}
                      </div>
                    </ScrollArea>
                  </div>
                )}

                {hasMission && !isLoadingLogs && !logsAnalysis && (
                  <div className="flex flex-col items-center justify-center py-8 text-center">
                    <BarChart3 className="h-10 w-10 text-muted-foreground/20 mb-3" />
                    <p className="text-sm text-muted-foreground">Pas encore d'analyse.</p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={loadLogsAnalysis}
                      className="mt-3 gap-2"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Analyser les logs
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Byte Ranges Visualization */}
            {(dataMode === "range" || dataMode === "logs") && computedByteRanges.length > 0 && (
              <Card className="border-border bg-card">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <BarChart3 className="h-4 w-4 text-muted-foreground" />
                    Plages observees par octet
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Min/max observes dans les logs pour les IDs selectionnes
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {computedByteRanges.map((br) => (
                      <ByteRangeBar key={br.index} {...br} />
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>

        {/* Sent Frames History */}
        <SentFramesHistory frames={frames} onClear={clearHistory} />
      </div>
    </AppShell>
  )
}
