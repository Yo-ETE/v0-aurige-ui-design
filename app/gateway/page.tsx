"use client"

import { useState, useEffect } from "react"
import { AppShell } from "@/components/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { LogSelector } from "@/components/log-selector"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Network, Loader2, AlertCircle, Database, Download, ArrowRight, Radar, ShieldOff } from "lucide-react"
import {
  interBusCorrelation,
  identifyBus,
  listMissionLogs,
  type InterBusResult,
  type BusIdentifyResult,
  type CANInterface,
  type LogEntry,
} from "@/lib/api"
import { useMissionStore } from "@/lib/mission-store"
import { downloadFile, csvCell } from "@/lib/export-utils"

const IFACES: CANInterface[] = ["can0", "can1", "vcan0"]
const RANGE_COLORS = ["bg-primary", "bg-sky-500", "bg-emerald-500", "bg-amber-500"]

function kindBadge(kind: string) {
  return kind === "relay" ? (
    <Badge className="bg-emerald-600/20 text-emerald-400 border-emerald-600/30">relay</Badge>
  ) : (
    <Badge className="bg-sky-600/20 text-sky-400 border-sky-600/30">translated</Badge>
  )
}

function InterBusCard() {
  const { missions, currentMissionId, fetchMissions } = useMissionStore()
  const activeMission = missions.find((m) => m.id === currentMissionId) ?? null
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [loadingLogs, setLoadingLogs] = useState(false)
  const [logA, setLogA] = useState("")
  const [logB, setLogB] = useState("")
  const [windowMs, setWindowMs] = useState(20)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<InterBusResult | null>(null)

  useEffect(() => {
    fetchMissions()
  }, [fetchMissions])

  useEffect(() => {
    if (!currentMissionId) {
      setLogs([])
      return
    }
    setLoadingLogs(true)
    listMissionLogs(currentMissionId)
      .then(setLogs)
      .catch(() => setLogs([]))
      .finally(() => setLoadingLogs(false))
  }, [currentMissionId])

  const run = async () => {
    if (!currentMissionId || !logA || !logB) return
    setLoading(true)
    setError(null)
    try {
      setResult(await interBusCorrelation(currentMissionId, logA, logB, windowMs))
    } catch (err: unknown) {
      setResult(null)
      setError(err instanceof Error ? err.message : "Erreur inconnue")
    } finally {
      setLoading(false)
    }
  }

  const exportCsv = () => {
    if (!result) return
    const rows = result.pairs.map((p) =>
      [p.id_a, p.id_b, p.co, p.avg_delay_ms, p.p_forward.toFixed(4), p.kind].map(csvCell).join(",")
    )
    downloadFile("inter_bus.csv", ["id_a,id_b,co,avg_delay_ms,p_forward,kind", ...rows].join("\n"), "text/csv")
  }
  const exportJson = () => {
    if (result) downloadFile("inter_bus.json", JSON.stringify(result, null, 2), "application/json")
  }

  return (
    <Card className="border-border/60">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Network className="h-4 w-4 text-primary" /> Corrélation inter-bus (routage gateway)
        </CardTitle>
        <CardDescription className="text-xs">
          Compare un log du bus direct et un log OBD pour trouver les trames relayées par la gateway.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!activeMission ? (
          <Alert>
            <Database className="h-4 w-4" />
            <AlertTitle>Aucune mission active</AlertTitle>
            <AlertDescription>Sélectionnez une mission pour choisir les logs à corréler.</AlertDescription>
          </Alert>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">Mission : {activeMission.name}</p>
            {loadingLogs ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Chargement des logs...
              </div>
            ) : logs.length < 1 ? (
              <p className="text-xs text-muted-foreground">Aucun log disponible dans cette mission.</p>
            ) : (
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1.5 min-w-[220px] flex-1">
                  <Label className="text-xs text-muted-foreground">Log A (bus direct)</Label>
                  <LogSelector logs={logs} value={logA} onValueChange={setLogA} placeholder="Log bus direct" />
                </div>
                <div className="flex flex-col gap-1.5 min-w-[220px] flex-1">
                  <Label className="text-xs text-muted-foreground">Log B (OBD)</Label>
                  <LogSelector logs={logs} value={logB} onValueChange={setLogB} placeholder="Log OBD" />
                </div>
                <div className="flex flex-col gap-1.5 w-28">
                  <Label className="text-xs text-muted-foreground">Fenêtre (ms)</Label>
                  <Input
                    type="number"
                    min={1}
                    className="h-8 text-xs"
                    value={windowMs}
                    onChange={(e) => setWindowMs(Math.max(1, Number(e.target.value) || 20))}
                  />
                </div>
                <Button size="sm" className="h-8 gap-1" onClick={run} disabled={loading || !logA || !logB}>
                  {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Network className="h-3.5 w-3.5" />}
                  Corréler
                </Button>
              </div>
            )}
          </>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Erreur</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {result && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{result.pairs.length} paires</span>
              <span>A : {result.total_a.toLocaleString()} trames</span>
              <span>B : {result.total_b.toLocaleString()} trames</span>
              <Badge variant="outline" className="text-[10px]">{result.elapsed_ms} ms</Badge>
              <Button size="sm" variant="outline" className="h-7 gap-1 bg-transparent" onClick={exportCsv}>
                <Download className="h-3 w-3" /> CSV
              </Button>
              <Button size="sm" variant="outline" className="h-7 gap-1 bg-transparent" onClick={exportJson}>
                <Download className="h-3 w-3" /> JSON
              </Button>
            </div>

            {result.pairs.length === 0 ? (
              <p className="text-xs text-muted-foreground">Aucune paire de trames corrélée entre les deux logs.</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">Routage</TableHead>
                      <TableHead className="text-xs text-right">Co-occurrences</TableHead>
                      <TableHead className="text-xs text-right">Délai moyen (ms)</TableHead>
                      <TableHead className="text-xs text-right">P(forward)</TableHead>
                      <TableHead className="text-xs">Type</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.pairs.map((p) => (
                      <TableRow key={`${p.id_a}-${p.id_b}`}>
                        <TableCell className="font-mono text-xs">
                          <span className="inline-flex items-center gap-1.5">
                            {p.id_a} <ArrowRight className="h-3 w-3 text-muted-foreground" /> {p.id_b}
                          </span>
                        </TableCell>
                        <TableCell className="text-xs text-right tabular-nums">{p.co}</TableCell>
                        <TableCell className="text-xs text-right tabular-nums">{p.avg_delay_ms.toFixed(2)}</TableCell>
                        <TableCell className="text-xs text-right tabular-nums">{(p.p_forward * 100).toFixed(0)}%</TableCell>
                        <TableCell>{kindBadge(p.kind)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <h4 className="text-xs font-semibold flex items-center gap-1.5">
                <ShieldOff className="h-3.5 w-3.5 text-amber-400" /> IDs non relayés (bloqués gateway)
              </h4>
              {result.blocked_ids.length === 0 ? (
                <p className="text-xs text-muted-foreground">Aucun ID bloqué détecté.</p>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {result.blocked_ids.map((id) => (
                    <Badge key={id} variant="outline" className="font-mono text-[10px] border-amber-600/40 text-amber-400">
                      {id}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function estimateClass(estimate: string): string {
  const e = estimate.toLowerCase()
  if (e.includes("obd")) return "bg-sky-600/20 text-sky-400 border-sky-600/30"
  if (e.includes("gateway") || e.includes("diag") || e.includes("indétermin") || e.includes("indetermin")) return "bg-amber-600/20 text-amber-400 border-amber-600/30"
  if (e.includes("aucun") || e.includes("inconnu") || e.includes("silenc") || e.includes("vide")) return "bg-red-600/20 text-red-400 border-red-600/30"
  return "bg-emerald-600/20 text-emerald-400 border-emerald-600/30"
}

function IdentifyCard() {
  const [iface, setIface] = useState<CANInterface>("can0")
  const [duration, setDuration] = useState(2)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<BusIdentifyResult | null>(null)

  const run = async () => {
    setLoading(true)
    setError(null)
    try {
      setResult(await identifyBus(iface, duration))
    } catch (err: unknown) {
      setResult(null)
      setError(err instanceof Error ? err.message : "Erreur inconnue")
    } finally {
      setLoading(false)
    }
  }

  const ranges = result ? Object.entries(result.idRanges) : []
  const rangeTotal = ranges.reduce((s, [, n]) => s + n, 0)

  return (
    <Card className="border-border/60">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Radar className="h-4 w-4 text-primary" /> Identifier un bus
        </CardTitle>
        <CardDescription className="text-xs">
          Écoute passive d&apos;un bus : lecture seule, aucune injection.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5 w-32">
            <Label className="text-xs text-muted-foreground">Interface</Label>
            <Select value={iface} onValueChange={(v) => setIface(v as CANInterface)}>
              <SelectTrigger className="h-8 text-xs w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {IFACES.map((i) => (
                  <SelectItem key={i} value={i}>{i}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5 w-28">
            <Label className="text-xs text-muted-foreground">Durée (s)</Label>
            <Input
              type="number"
              min={0.5}
              max={10}
              step={0.5}
              className="h-8 text-xs"
              value={duration}
              onChange={(e) => setDuration(Math.min(30, Math.max(1, Number(e.target.value) || 2)))}
            />
          </div>
          <Button size="sm" className="h-8 gap-1" onClick={run} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Radar className="h-3.5 w-3.5" />}
            Identifier
          </Button>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Erreur</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {result && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">Estimation :</span>
              <Badge className={`text-sm px-3 py-1 ${estimateClass(result.estimate)}`}>{result.estimate}</Badge>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {[
                ["Trames", result.frameCount.toLocaleString()],
                ["Charge", `${result.loadHz} Hz`],
                ["IDs uniques", result.uniqueIds.toLocaleString()],
                ["Durée", `${result.durationSec} s`],
              ].map(([k, v]) => (
                <div key={k} className="rounded border border-border/40 bg-muted/30 px-3 py-2">
                  <div className="text-[10px] text-muted-foreground">{k}</div>
                  <div className="text-sm font-semibold tabular-nums">{v}</div>
                </div>
              ))}
            </div>

            <div className="flex flex-col gap-1.5">
              <h4 className="text-xs font-semibold">Répartition des IDs</h4>
              {rangeTotal > 0 ? (
                <>
                  <div className="flex h-3 w-full overflow-hidden rounded bg-muted">
                    {ranges.map(([k, n], i) =>
                      n > 0 ? (
                        <div
                          key={k}
                          title={`${k} : ${n}`}
                          className={RANGE_COLORS[i % RANGE_COLORS.length]}
                          style={{ width: `${(n / rangeTotal) * 100}%` }}
                        />
                      ) : null
                    )}
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground font-mono">
                    {ranges.map(([k, n], i) => (
                      <span key={k} className="inline-flex items-center gap-1">
                        <span className={`inline-block h-2 w-2 rounded-sm ${RANGE_COLORS[i % RANGE_COLORS.length]}`} />
                        {k} : {n}
                      </span>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">Aucune trame reçue.</p>
              )}
            </div>

            {result.topIds.length > 0 && (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">ID le plus fréquent</TableHead>
                      <TableHead className="text-xs text-right">Trames</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.topIds.map((t) => (
                      <TableRow key={t.id}>
                        <TableCell className="font-mono text-xs">{t.id}</TableCell>
                        <TableCell className="text-xs text-right tabular-nums">{t.count.toLocaleString()}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default function GatewayPage() {
  return (
    <AppShell title="Gateway" description="Corrélation inter-bus + identification de bus">
      <div className="flex flex-col gap-6">
        <InterBusCard />
        <IdentifyCard />
      </div>
    </AppShell>
  )
}
