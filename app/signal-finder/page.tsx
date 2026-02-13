"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { AppShell } from "@/components/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Search, Play, Square, Loader2, AlertCircle, CheckCircle2, Activity,
  Trash2, Plus, Upload, Copy, Save, Radio, FileSearch, Database, Info, Crosshair, Zap,
} from "lucide-react"
import {
  correlateOBDWithCAN,
  extractOBDFromLog,
  listMissionLogs,
  addDBCSignal,
  getSignalFinderWsUrl,
  type CANInterface,
  type OBDSample,
  type CorrelationCandidate,
  type CorrelationResult,
  type LogEntry,
} from "@/lib/api"
import { useMissionStore } from "@/lib/mission-store"
import { LogSelector } from "@/components/log-selector"
import { cn } from "@/lib/utils"
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
  Legend, ResponsiveContainer, ReferenceLine,
} from "recharts"

// =============================================================================
// PID Descriptions
// =============================================================================

const PID_OPTIONS: { value: string; label: string; unit: string }[] = [
  { value: "0C", label: "Regime moteur (RPM)", unit: "tr/min" },
  { value: "0D", label: "Vitesse vehicule", unit: "km/h" },
  { value: "05", label: "Temperature liquide refroidissement", unit: "C" },
  { value: "0F", label: "Temperature air admission", unit: "C" },
  { value: "11", label: "Position papillon (%)", unit: "%" },
  { value: "10", label: "Debit air (MAF)", unit: "g/s" },
  { value: "2F", label: "Niveau carburant", unit: "%" },
  { value: "04", label: "Charge moteur (%)", unit: "%" },
  { value: "0B", label: "Pression collecteur (MAP)", unit: "kPa" },
  { value: "42", label: "Tension module commande", unit: "V" },
  { value: "46", label: "Temperature ambiante", unit: "C" },
  { value: "0A", label: "Pression carburant", unit: "kPa" },
  { value: "0E", label: "Avance allumage", unit: "deg" },
  { value: "1F", label: "Duree fonctionnement", unit: "s" },
]

// =============================================================================
// Confidence Badge
// =============================================================================

function ConfidenceBadge({ confidence }: { confidence: number }) {
  if (confidence >= 0.8) {
    return <Badge className="bg-success text-success-foreground font-mono text-xs">{(confidence * 100).toFixed(0)}%</Badge>
  }
  if (confidence >= 0.5) {
    return <Badge className="bg-warning text-warning-foreground font-mono text-xs">{(confidence * 100).toFixed(0)}%</Badge>
  }
  return <Badge variant="destructive" className="font-mono text-xs">{(confidence * 100).toFixed(0)}%</Badge>
}

// =============================================================================
// Correlation Chart
// =============================================================================

function CorrelationChart({ candidate }: { candidate: CorrelationCandidate }) {
  const data = candidate.timestamps.map((t, i) => {
    const t0 = candidate.timestamps[0] || 0
    return {
      time: Number((t - t0).toFixed(2)),
      obd: candidate.obd_values[i],
      can_transformed: candidate.can_transformed[i],
    }
  })

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.28 0.02 260)" />
        <XAxis
          dataKey="time"
          stroke="oklch(0.65 0.02 260)"
          tick={{ fill: "oklch(0.65 0.02 260)", fontSize: 11 }}
          label={{ value: "Temps (s)", position: "insideBottomRight", offset: -4, fill: "oklch(0.65 0.02 260)", fontSize: 11 }}
        />
        <YAxis
          yAxisId="obd"
          stroke="oklch(0.65 0.18 250)"
          tick={{ fill: "oklch(0.65 0.18 250)", fontSize: 11 }}
          label={{ value: "OBD", angle: -90, position: "insideLeft", fill: "oklch(0.65 0.18 250)", fontSize: 11 }}
        />
        <YAxis
          yAxisId="can"
          orientation="right"
          stroke="oklch(0.65 0.2 145)"
          tick={{ fill: "oklch(0.65 0.2 145)", fontSize: 11 }}
          label={{ value: "CAN (transform.)", angle: 90, position: "insideRight", fill: "oklch(0.65 0.2 145)", fontSize: 11 }}
        />
        <RechartsTooltip
          contentStyle={{
            backgroundColor: "oklch(0.18 0.01 260)",
            border: "1px solid oklch(0.28 0.02 260)",
            borderRadius: 6,
            color: "oklch(0.95 0.01 260)",
            fontSize: 12,
          }}
          formatter={(value: number, name: string) => [
            value.toFixed(2),
            name === "obd" ? "Valeur OBD" : "CAN transforme",
          ]}
          labelFormatter={(label) => `t = ${label}s`}
        />
        <Legend
          formatter={(value: string) => (value === "obd" ? "Valeur OBD" : "CAN transforme")}
          wrapperStyle={{ fontSize: 12 }}
        />
        <Line
          yAxisId="obd"
          type="monotone"
          dataKey="obd"
          stroke="oklch(0.65 0.18 250)"
          strokeWidth={2}
          dot={{ r: 2 }}
          activeDot={{ r: 4 }}
        />
        <Line
          yAxisId="can"
          type="monotone"
          dataKey="can_transformed"
          stroke="oklch(0.65 0.2 145)"
          strokeWidth={2}
          dot={{ r: 2 }}
          activeDot={{ r: 4 }}
          strokeDasharray="5 3"
        />
      </LineChart>
    </ResponsiveContainer>
  )
}

// =============================================================================
// OBD Samples Editor (for offline mode)
// =============================================================================

function OBDSamplesEditor({
  samples,
  onSamplesChange,
}: {
  samples: OBDSample[]
  onSamplesChange: (s: OBDSample[]) => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  const addSample = () => {
    const ts = samples.length > 0 ? samples[samples.length - 1].timestamp + 0.5 : Date.now() / 1000
    onSamplesChange([...samples, { timestamp: ts, value: 0 }])
  }

  const removeSample = (idx: number) => {
    onSamplesChange(samples.filter((_, i) => i !== idx))
  }

  const updateSample = (idx: number, field: "timestamp" | "value", val: string) => {
    const updated = [...samples]
    updated[idx] = { ...updated[idx], [field]: parseFloat(val) || 0 }
    onSamplesChange(updated)
  }

  const importCSV = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = ev.target?.result as string
      const lines = text.trim().split("\n")
      const parsed: OBDSample[] = []
      for (const line of lines) {
        const parts = line.split(/[,;\t]/).map((s) => s.trim())
        if (parts.length >= 2) {
          const ts = parseFloat(parts[0])
          const val = parseFloat(parts[1])
          if (!isNaN(ts) && !isNaN(val)) {
            parsed.push({ timestamp: ts, value: val })
          }
        }
      }
      if (parsed.length > 0) {
        onSamplesChange(parsed)
      }
    }
    reader.readAsText(file)
    e.target.value = ""
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Label className="text-sm font-medium text-foreground">Echantillons OBD</Label>
        <Badge variant="secondary" className="text-xs">{samples.length}</Badge>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={addSample}>
          <Plus className="mr-1 h-3 w-3" /> Ajouter
        </Button>
        <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()}>
          <Upload className="mr-1 h-3 w-3" /> Importer CSV
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.txt,.tsv"
          className="hidden"
          onChange={importCSV}
        />
        {samples.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => onSamplesChange([])} className="text-destructive">
            <Trash2 className="mr-1 h-3 w-3" /> Vider
          </Button>
        )}
      </div>
      {samples.length > 0 && (
        <ScrollArea className="max-h-48 rounded-md border border-border">
          <div className="p-2">
            <div className="grid grid-cols-[1fr_1fr_40px] gap-1 pb-1 mb-1 border-b border-border text-xs text-muted-foreground font-medium">
              <span>Timestamp</span>
              <span>Valeur</span>
              <span />
            </div>
            {samples.map((s, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_40px] gap-1 items-center mb-1">
                <Input
                  type="number"
                  step="0.001"
                  value={s.timestamp}
                  onChange={(e) => updateSample(i, "timestamp", e.target.value)}
                  className="h-7 text-xs font-mono"
                />
                <Input
                  type="number"
                  step="0.1"
                  value={s.value}
                  onChange={(e) => updateSample(i, "value", e.target.value)}
                  className="h-7 text-xs font-mono"
                />
                <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => removeSample(i)}>
                  <Trash2 className="h-3 w-3 text-muted-foreground" />
                </Button>
              </div>
            ))}
          </div>
        </ScrollArea>
      )}
      <p className="text-xs text-muted-foreground">
        Format CSV : timestamp,valeur (une ligne par echantillon). Le timestamp doit correspondre aux timestamps du log CAN.
      </p>
    </div>
  )
}

// =============================================================================
// Candidates Table
// =============================================================================

function CandidatesTable({
  candidates,
  selected,
  onSelect,
}: {
  candidates: CorrelationCandidate[]
  selected: CorrelationCandidate | null
  onSelect: (c: CorrelationCandidate) => void
}) {
  if (candidates.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <Search className="h-10 w-10 mb-3 opacity-40" />
        <p className="text-sm">Aucun candidat trouve</p>
        <p className="text-xs mt-1">Lancez une correlation pour voir les resultats</p>
      </div>
    )
  }

  return (
    <ScrollArea className="max-h-[400px]">
      <div className="table-responsive">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-muted-foreground">
              <th className="py-2 px-2 text-left font-medium">#</th>
              <th className="py-2 px-2 text-left font-medium">ID CAN</th>
              <th className="py-2 px-2 text-left font-medium">Modele</th>
              <th className="py-2 px-2 text-right font-medium">Pearson</th>
              <th className="py-2 px-2 text-right font-medium">Spearman</th>
              <th className="py-2 px-2 text-center font-medium">Confiance</th>
              <th className="py-2 px-2 text-right font-medium">N</th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((c, i) => (
              <tr
                key={`${c.can_id}-${c.model}-${i}`}
                onClick={() => onSelect(c)}
                className={cn(
                  "cursor-pointer border-b border-border/50 transition-colors",
                  selected?.can_id === c.can_id && selected?.model === c.model && selected?.byte_index === c.byte_index
                    ? "bg-primary/10"
                    : "hover:bg-accent/50"
                )}
              >
                <td className="py-2 px-2 text-muted-foreground">{i + 1}</td>
                <td className="py-2 px-2 font-mono font-semibold text-foreground">{c.can_id}</td>
                <td className="py-2 px-2 font-mono text-muted-foreground">{c.model}</td>
                <td className="py-2 px-2 text-right font-mono">{c.pearson.toFixed(3)}</td>
                <td className="py-2 px-2 text-right font-mono">{c.spearman.toFixed(3)}</td>
                <td className="py-2 px-2 text-center"><ConfidenceBadge confidence={c.confidence} /></td>
                <td className="py-2 px-2 text-right font-mono text-muted-foreground">{c.n_samples}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ScrollArea>
  )
}

// =============================================================================
// Signal Detail Card
// =============================================================================

function SignalDetail({
  candidate,
  missionId,
  onSaved,
}: {
  candidate: CorrelationCandidate
  missionId: string | null
  onSaved: () => void
}) {
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)

  const formula = candidate.scale !== 0
    ? `Y = ${candidate.scale} * CAN[${candidate.byte_index}${candidate.byte_end !== candidate.byte_index ? `:${candidate.byte_end}` : ""}] + ${candidate.offset}`
    : "N/A"

  const copyFormula = () => {
    navigator.clipboard.writeText(formula)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const saveToDBC = async () => {
    if (!missionId) return
    setSaving(true)
    try {
      const byteOrder = candidate.model_type === "two_byte_le" ? "little_endian" : "big_endian"
      const lengthBits = candidate.model_type === "single_byte" ? 8 : 16
      await addDBCSignal(missionId, {
        can_id: candidate.can_id,
        name: `SF_${candidate.can_id}_B${candidate.byte_index}`,
        start_bit: candidate.byte_index * 8,
        length: lengthBits,
        byte_order: byteOrder,
        is_signed: false,
        scale: candidate.scale,
        offset: candidate.offset,
        min_val: Math.min(...candidate.obd_values),
        max_val: Math.max(...candidate.obd_values),
        unit: "",
        comment: `Signal Finder: ${candidate.model} | Pearson=${candidate.pearson.toFixed(3)} Spearman=${candidate.spearman.toFixed(3)} Confiance=${(candidate.confidence * 100).toFixed(0)}%`,
      })
      setSaved(true)
      onSaved()
      setTimeout(() => setSaved(false), 3000)
    } catch {
      // error handled by UI state
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="border-primary/30">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Crosshair className="h-4 w-4 text-primary" />
          Detail du signal : <span className="font-mono text-primary">{candidate.can_id}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground">Formule</span>
            <code className="font-mono text-foreground bg-secondary/50 px-2 py-1 rounded text-xs break-all">{formula}</code>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground">Modele</span>
            <span className="font-mono text-foreground">{candidate.model}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground">Pearson</span>
            <span className="font-mono text-foreground">{candidate.pearson.toFixed(4)}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground">Spearman</span>
            <span className="font-mono text-foreground">{candidate.spearman.toFixed(4)}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground">Scale / Offset</span>
            <span className="font-mono text-foreground">{candidate.scale} / {candidate.offset}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground">Echantillons</span>
            <span className="font-mono text-foreground">{candidate.n_samples}</span>
          </div>
        </div>
        {/* Chart */}
        <div className="rounded-md border border-border bg-card p-2">
          <CorrelationChart candidate={candidate} />
        </div>
        {/* Actions */}
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={copyFormula}>
            {copied ? <CheckCircle2 className="mr-1 h-3 w-3 text-success" /> : <Copy className="mr-1 h-3 w-3" />}
            {copied ? "Copie" : "Copier formule"}
          </Button>
          {missionId && (
            <Button size="sm" onClick={saveToDBC} disabled={saving || saved}>
              {saving ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : saved ? (
                <CheckCircle2 className="mr-1 h-3 w-3 text-success" />
              ) : (
                <Save className="mr-1 h-3 w-3" />
              )}
              {saved ? "Sauvegarde" : "Sauvegarder dans DBC"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

// =============================================================================
// Live OBD Value Display
// =============================================================================

function LiveOBDValue({ value, unit, name, sampleCount }: { value: number | null; unit: string; name: string; sampleCount: number }) {
  return (
    <div className="flex flex-col items-center justify-center py-4 px-4 rounded-lg border border-border bg-card">
      <span className="text-xs text-muted-foreground mb-1">{name}</span>
      <span className="text-4xl font-mono font-bold text-primary tabular-nums tracking-tight">
        {value !== null ? value.toFixed(1) : "--"}
      </span>
      <span className="text-sm text-muted-foreground">{unit}</span>
      <span className="text-xs text-muted-foreground mt-2">
        {sampleCount} echantillon{sampleCount !== 1 ? "s" : ""}
      </span>
    </div>
  )
}

// =============================================================================
// Main Page
// =============================================================================

export default function SignalFinderPage() {
  // Mode
  const [mode, setMode] = useState<"offline" | "live">("offline")

  // Config
  const [iface, setIface] = useState<CANInterface>("can0")
  const [selectedPid, setSelectedPid] = useState("0C")
  const [windowMs, setWindowMs] = useState(50)

  // Mission integration
  const { missions, currentMissionId, fetchMissions } = useMissionStore()
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(currentMissionId)
  const [missionLogs, setMissionLogs] = useState<LogEntry[]>([])
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null)

  // Offline state
  const [obdSamples, setObdSamples] = useState<OBDSample[]>([])
  const [correlating, setCorrelating] = useState(false)
  const [correlationResult, setCorrelationResult] = useState<CorrelationResult | null>(null)
  const [extracting, setExtracting] = useState(false)
  const [extractInfo, setExtractInfo] = useState<string | null>(null)

  // Live state
  const [liveRunning, setLiveRunning] = useState(false)
  const [liveValue, setLiveValue] = useState<number | null>(null)
  const [liveSampleCount, setLiveSampleCount] = useState(0)
  const [liveCanIds, setLiveCanIds] = useState(0)
  const wsRef = useRef<WebSocket | null>(null)

  // Results (shared)
  const [candidates, setCandidates] = useState<CorrelationCandidate[]>([])
  const [selectedCandidate, setSelectedCandidate] = useState<CorrelationCandidate | null>(null)
  const [error, setError] = useState<string | null>(null)

  const pidInfo = PID_OPTIONS.find((p) => p.value === selectedPid)

  // Fetch missions on mount
  useEffect(() => {
    fetchMissions()
  }, [fetchMissions])

  // Sync current mission
  useEffect(() => {
    if (currentMissionId && !selectedMissionId) {
      setSelectedMissionId(currentMissionId)
    }
  }, [currentMissionId, selectedMissionId])

  // Fetch mission logs when mission changes
  useEffect(() => {
    if (selectedMissionId) {
      listMissionLogs(selectedMissionId)
        .then((logs) => {
          setMissionLogs(logs)
          if (logs.length > 0 && !selectedLogId) {
            setSelectedLogId(logs[0].id)
          }
        })
        .catch(() => setMissionLogs([]))
    } else {
      setMissionLogs([])
      setSelectedLogId(null)
    }
  }, [selectedMissionId, selectedLogId])

  // ==========================================================================
  // Offline Correlation
  // ==========================================================================

  const runOfflineCorrelation = useCallback(async () => {
    if (obdSamples.length < 3) {
      setError("Minimum 3 echantillons OBD requis.")
      return
    }
    setCorrelating(true)
    setError(null)
    setCandidates([])
    setSelectedCandidate(null)
    setCorrelationResult(null)

    try {
      const result = await correlateOBDWithCAN({
        missionId: selectedMissionId || undefined,
        obdSamples,
        windowMs,
        pid: selectedPid,
      })
      setCorrelationResult(result)
      setCandidates(result.candidates)
      if (result.candidates.length > 0) {
        setSelectedCandidate(result.candidates[0])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur lors de la correlation")
    } finally {
      setCorrelating(false)
    }
  }, [obdSamples, selectedMissionId, windowMs, selectedPid])

  // ==========================================================================
  // Auto-extract OBD samples from log
  // ==========================================================================

  const autoExtractFromLog = useCallback(async () => {
    setExtracting(true)
    setError(null)
    setExtractInfo(null)
    try {
      const result = await extractOBDFromLog({
        missionId: selectedMissionId || undefined,
        pid: selectedPid,
      })
      if (result.samples.length > 0) {
        setObdSamples(result.samples)
        setExtractInfo(
          `${result.count} echantillons ${result.name} (${result.unit}) extraits automatiquement du log`
        )
      } else {
        setExtractInfo(
          `Aucune reponse OBD pour le PID ${result.pid} (${result.name}) trouvee dans ce log. ` +
          `Le log ne contient probablement pas de trames OBD (7E8-7EF). ` +
          `Utilisez le mode Live ou ajoutez les echantillons manuellement.`
        )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur lors de l'extraction")
    } finally {
      setExtracting(false)
    }
  }, [selectedMissionId, selectedPid])

  // ==========================================================================
  // Live Mode WebSocket
  // ==========================================================================

  const startLive = useCallback(() => {
    setError(null)
    setCandidates([])
    setSelectedCandidate(null)
    setLiveValue(null)
    setLiveSampleCount(0)
    setLiveCanIds(0)
    setLiveRunning(true)

    const wsUrl = getSignalFinderWsUrl(iface)
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      ws.send(JSON.stringify({
        action: "start",
        pid: selectedPid,
        interface: iface,
        intervalMs: 300,
        service: "01",
        correlationIntervalS: 3,
      }))
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === "obd_sample") {
          setLiveValue(data.value)
          setLiveSampleCount(data.sampleCount || 0)
        } else if (data.type === "correlation_update") {
          setCandidates(data.candidates || [])
          setLiveCanIds(data.canIdsCount || 0)
          if (data.candidates?.length > 0 && !data.final) {
            setSelectedCandidate(data.candidates[0])
          }
          if (data.final && data.candidates?.length > 0) {
            setSelectedCandidate(data.candidates[0])
          }
        } else if (data.type === "error") {
          setError(data.message)
          setLiveRunning(false)
        }
      } catch {
        // ignore parse errors
      }
    }

    ws.onerror = () => {
      setError("Erreur de connexion WebSocket. Verifiez que le backend est accessible.")
      setLiveRunning(false)
    }

    ws.onclose = () => {
      setLiveRunning(false)
    }
  }, [iface, selectedPid])

  const stopLive = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ action: "stop" }))
    }
    setLiveRunning(false)
  }, [])

  // Cleanup WebSocket on unmount
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close()
      }
    }
  }, [])

  return (
    <AppShell
      title="Signal Finder"
      description="Correlation OBD-II / CAN - Identifiez l'ID CAN, les bytes et le facteur d'echelle correspondant a un PID OBD"
    >
        <div className="flex flex-col gap-6">
          {/* Error banner */}
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Erreur</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Mission info banner */}
          {selectedMissionId && (
            <Alert className="border-primary/30 bg-primary/5">
              <Database className="h-4 w-4 text-primary" />
              <AlertTitle className="text-primary text-sm">Mission active</AlertTitle>
              <AlertDescription className="text-xs text-muted-foreground">
                {missions.find((m) => m.id === selectedMissionId)?.name || selectedMissionId}
                {" -- "}Les signaux decouverts peuvent etre sauvegardes dans le DBC de la mission.
              </AlertDescription>
            </Alert>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-[400px_1fr] gap-6">
            {/* ================================================================
                LEFT COLUMN: Configuration + Controls
            ================================================================ */}
            <div className="flex flex-col gap-4">
              {/* Mode Tabs */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Search className="h-4 w-4 text-primary" />
                    Configuration
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  {/* Mode toggle */}
                  <div className="flex rounded-lg border border-border bg-muted p-0.5 gap-0.5">
                    <button
                      onClick={() => setMode("offline")}
                      disabled={liveRunning}
                      className={`flex-1 flex items-center justify-center gap-1.5 text-xs rounded-md px-3 py-1.5 font-medium transition-colors disabled:opacity-50 ${
                        mode === "offline"
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <FileSearch className="h-3.5 w-3.5" /> Offline
                    </button>
                    <button
                      onClick={() => setMode("live")}
                      disabled={correlating}
                      className={`flex-1 flex items-center justify-center gap-1.5 text-xs rounded-md px-3 py-1.5 font-medium transition-colors disabled:opacity-50 ${
                        mode === "live"
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <Radio className="h-3.5 w-3.5" /> Live
                    </button>
                  </div>

                  {/* Interface */}
                  <div className="flex flex-col gap-1.5">
                    <Label className="text-xs text-muted-foreground">Interface CAN</Label>
                    <Select value={iface} onValueChange={(v) => setIface(v as CANInterface)} disabled={liveRunning || correlating}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="can0">can0</SelectItem>
                        <SelectItem value="can1">can1</SelectItem>
                        <SelectItem value="vcan0">vcan0</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* PID */}
                  <div className="flex flex-col gap-1.5">
                    <Label className="text-xs text-muted-foreground">PID OBD-II cible</Label>
                    <Select value={selectedPid} onValueChange={setSelectedPid} disabled={liveRunning || correlating}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PID_OPTIONS.map((p) => (
                          <SelectItem key={p.value} value={p.value}>
                            <span className="font-mono mr-2 text-primary">{p.value}</span> {p.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Window */}
                  <div className="flex flex-col gap-1.5">
                    <Label className="text-xs text-muted-foreground">
                      Fenetre d{"'"}alignement (ms)
                      <Info
                        className="inline h-3 w-3 ml-1 text-muted-foreground cursor-help"
                        title="Tolerance temporelle pour associer un echantillon OBD a une trame CAN. Augmentez si le bus est lent ou les echantillons espaces."
                      />
                    </Label>
                    <Input
                      type="number"
                      min={10}
                      max={500}
                      value={windowMs}
                      onChange={(e) => setWindowMs(parseInt(e.target.value) || 50)}
                      className="h-8 text-xs font-mono"
                      disabled={liveRunning || correlating}
                    />
                  </div>
                </CardContent>
              </Card>

              {/* Mode-specific controls */}
              {mode === "offline" ? (
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <FileSearch className="h-4 w-4 text-primary" />
                      Mode Offline
                    </CardTitle>
                    <CardDescription className="text-xs">
                      Analysez un log CAN existant avec des echantillons OBD
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-4">
                    {/* Mission selector */}
                    <div className="flex flex-col gap-1.5">
                      <Label className="text-xs text-muted-foreground">Mission (optionnel)</Label>
                      <Select
                        value={selectedMissionId || "none"}
                        onValueChange={(v) => setSelectedMissionId(v === "none" ? null : v)}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder="Aucune mission" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Aucune mission</SelectItem>
                          {missions.map((m) => (
                            <SelectItem key={m.id} value={m.id}>
                              {m.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Log selector (if mission) */}
                    {selectedMissionId && missionLogs.length > 0 && (
                      <div className="flex flex-col gap-1.5">
                        <Label className="text-xs text-muted-foreground">Log CAN de la mission</Label>
  <LogSelector
  logs={missionLogs}
  value={selectedLogId || ""}
  onValueChange={setSelectedLogId}
  placeholder="Selectionner un log"
  />
                      </div>
                    )}

                    {/* Auto-extract OBD from log */}
                    {selectedMissionId && (
                      <div className="flex flex-col gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={autoExtractFromLog}
                          disabled={extracting || correlating || !selectedMissionId}
                          className="w-full text-xs border-primary/30 hover:border-primary/60"
                        >
                          {extracting ? (
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Zap className="mr-1.5 h-3.5 w-3.5 text-primary" />
                          )}
                          Auto-extraire les echantillons OBD du log
                        </Button>
                        {extractInfo && (
                          <Alert variant={obdSamples.length > 0 ? "default" : undefined} className="py-2">
                            <AlertDescription className="text-xs">
                              {extractInfo}
                            </AlertDescription>
                          </Alert>
                        )}
                      </div>
                    )}

                    {/* OBD Samples editor */}
                    <OBDSamplesEditor samples={obdSamples} onSamplesChange={setObdSamples} />

                    {/* Launch button */}
                    <Button
                      onClick={runOfflineCorrelation}
                      disabled={correlating || obdSamples.length < 3}
                      className="w-full"
                    >
                      {correlating ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Search className="mr-2 h-4 w-4" />
                      )}
                      {correlating ? "Analyse en cours..." : "Lancer la correlation"}
                    </Button>

                    {correlationResult && (
                      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                        <Badge variant="secondary">{correlationResult.total_ids_analyzed} IDs analyses</Badge>
                        <Badge variant="secondary">{correlationResult.total_frames_processed} trames</Badge>
                        <Badge variant="secondary">{correlationResult.elapsed_ms.toFixed(0)} ms</Badge>
                      </div>
                    )}
                  </CardContent>
                </Card>
              ) : (
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Radio className="h-4 w-4 text-primary" />
                      Mode Live
                    </CardTitle>
                    <CardDescription className="text-xs">
                      Lecture OBD + capture CAN en temps reel avec correlation automatique
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-4">
                    {/* Live value display */}
                    <LiveOBDValue
                      value={liveValue}
                      unit={pidInfo?.unit || ""}
                      name={pidInfo?.label || `PID ${selectedPid}`}
                      sampleCount={liveSampleCount}
                    />

                    {liveRunning && (
                      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                        <Badge variant="secondary" className="gap-1">
                          <Activity className="h-3 w-3 animate-pulse" />
                          Capture en cours
                        </Badge>
                        <Badge variant="secondary">{liveSampleCount} echantillons</Badge>
                        <Badge variant="secondary">{liveCanIds} IDs CAN</Badge>
                      </div>
                    )}

                    {/* Start / Stop */}
                    {!liveRunning ? (
                      <Button onClick={startLive} className="w-full">
                        <Play className="mr-2 h-4 w-4" />
                        Demarrer l{"'"}echantillonnage
                      </Button>
                    ) : (
                      <Button onClick={stopLive} variant="destructive" className="w-full">
                        <Square className="mr-2 h-4 w-4" />
                        Arreter
                      </Button>
                    )}

                    <p className="text-xs text-muted-foreground">
                      Le mode live lit le PID OBD selectionnee toutes les 300ms tout en capturant le trafic CAN. La correlation est calculee automatiquement toutes les 3 secondes.
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>

            {/* ================================================================
                RIGHT COLUMN: Results
            ================================================================ */}
            <div className="flex flex-col gap-4">
              {/* Candidates table */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Activity className="h-4 w-4 text-primary" />
                    Candidats de correlation
                    {candidates.length > 0 && (
                      <Badge variant="secondary" className="ml-auto text-xs">
                        Top {candidates.length}
                      </Badge>
                    )}
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Cliquez sur un candidat pour voir le detail et le graphique de correlation
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <CandidatesTable
                    candidates={candidates}
                    selected={selectedCandidate}
                    onSelect={setSelectedCandidate}
                  />
                </CardContent>
              </Card>

              {/* Selected candidate detail */}
              {selectedCandidate && (
                <SignalDetail
                  candidate={selectedCandidate}
                  missionId={selectedMissionId}
                  onSaved={() => {}}
                />
              )}
            </div>
          </div>
        </div>
    </AppShell>
  )
}
