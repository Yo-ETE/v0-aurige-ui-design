"use client"

import { useState, useEffect } from "react"
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
  GitCompare,
  ArrowRight,
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
} from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Label } from "@/components/ui/label"
import { compareLogs, listMissionLogs, sendCANFrame, addDBCSignal, type CompareLogsResponse, type CompareFrameDiff, type LogEntry, type CANInterface } from "@/lib/api"
import { useMissionStore } from "@/lib/mission-store"
import { useExportStore } from "@/lib/export-store"
import { useRouter } from "next/navigation"
import { useToast } from "@/hooks/use-toast"

export default function ComparaisonPage() {
  const router = useRouter()
  const { toast } = useToast()
  const currentMission = useMissionStore((state) => state.currentMission)
  const missionId = currentMission?.id
  const { addFrames } = useExportStore()

  // Log selection
  const [missionLogs, setMissionLogs] = useState<LogEntry[]>([])
  const [logAId, setLogAId] = useState<string>("")
  const [logBId, setLogBId] = useState<string>("")
  const [isLoadingLogs, setIsLoadingLogs] = useState(false)

  // Comparison results
  const [comparisonResult, setComparisonResult] = useState<CompareLogsResponse | null>(null)
  const [isComparing, setIsComparing] = useState(false)
  const [expandedFrames, setExpandedFrames] = useState<Set<string>>(new Set())

  // Actions
  const [sendingFrame, setSendingFrame] = useState<string | null>(null)
  const [canInterface, setCanInterface] = useState<CANInterface>("can0")

  // Load mission logs
  useEffect(() => {
    if (missionId) {
      loadLogs()
    }
  }, [missionId])

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
    try {
      const result = await compareLogs(missionId, logAId, logBId)
      setComparisonResult(result)
    } catch (err) {
      toast({ title: "Erreur", description: "Echec de la comparaison", variant: "destructive" })
    } finally {
      setIsComparing(false)
    }
  }

  const handleSendFrame = async (frame: CompareFrameDiff, usePayloadA: boolean) => {
    setSendingFrame(frame.can_id)
    try {
      const payload = usePayloadA ? frame.payload_a : frame.payload_b
      await sendCANFrame(canInterface, frame.can_id, payload)
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
      frames.push({
        canId: frame.can_id,
        data: frame.payload_a,
        timestamp: "0",
        source: `compare-${logAId}`,
      })
    }
    if (frame.payload_b && frame.payload_b !== frame.payload_a) {
      frames.push({
        canId: frame.can_id,
        data: frame.payload_b,
        timestamp: "0",
        source: `compare-${logBId}`,
      })
    }
    addFrames(frames)
    router.push("/replay-rapide")
  }

  const handleSaveToDBC = async (frame: CompareFrameDiff, usePayloadA: boolean) => {
    if (!missionId) {
      toast({ title: "Erreur", description: "Aucune mission selectionnee", variant: "destructive" })
      return
    }
    try {
      const payload = usePayloadA ? frame.payload_a : frame.payload_b
      const signal = {
        can_id: frame.can_id,
        name: `SIG_${frame.can_id}_COMPARE_${Date.now().toString(36).slice(-4).toUpperCase()}`,
        start_bit: 0,
        length: Math.min(payload.length * 4, 64),
        byte_order: "little_endian" as const,
        is_signed: false,
        scale: 1,
        offset: 0,
        min_val: 0,
        max_val: 255,
        unit: "",
        comment: `Trame comparative: ${usePayloadA ? logAId : logBId}`,
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
    if (next.has(canId)) {
      next.delete(canId)
    } else {
      next.add(canId)
    }
    setExpandedFrames(next)
  }

  const getClassificationIcon = (classification: string) => {
    switch (classification) {
      case "differential":
        return <GitCompare className="h-4 w-4 text-amber-500" />
      case "only_a":
        return <MinusCircle className="h-4 w-4 text-red-500" />
      case "only_b":
        return <PlusCircle className="h-4 w-4 text-green-500" />
      case "identical":
        return <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
      default:
        return <AlertCircle className="h-4 w-4" />
    }
  }

  const getClassificationLabel = (classification: string) => {
    switch (classification) {
      case "differential":
        return "Differentiel"
      case "only_a":
        return "Uniquement A"
      case "only_b":
        return "Uniquement B"
      case "identical":
        return "Identique"
      default:
        return classification
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
        <span
          key={i}
          className={isChanged ? "bg-amber-500/30 px-0.5 rounded font-bold" : ""}
        >
          {byte}
        </span>
      )
      if (i + 2 < payload.length) {
        bytes.push(<span key={`sep-${i}`} className="text-muted-foreground/50"> </span>)
      }
    }
    return <span className="font-mono text-xs">{bytes}</span>
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

  return (
    <AppShell
      title="Comparaison de Logs"
      description="Comparez deux logs pour identifier les trames differentielles (ex: ouverture vs fermeture)"
    >
      <div className="space-y-6">
        {/* Log Selection */}
        <Card className="border-border bg-card">
          <CardHeader className="pb-4">
            <CardTitle className="flex items-center gap-2 text-lg">
              <GitCompare className="h-5 w-5 text-primary" />
              Selectionner les logs a comparer
            </CardTitle>
            <CardDescription>
              Choisissez deux logs representant des etats differents (ex: porte ouverte vs porte fermee)
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5 items-end">
              <div className="space-y-2 lg:col-span-2">
                <Label htmlFor="log-a">Log A (etat initial)</Label>
                <Select value={logAId} onValueChange={setLogAId} disabled={isLoadingLogs}>
                  <SelectTrigger id="log-a">
                    <SelectValue placeholder="Selectionner log A..." />
                  </SelectTrigger>
                  <SelectContent>
                    {missionLogs.map((log) => (
                      <SelectItem key={log.id} value={log.id} disabled={log.id === logBId}>
                        {log.filename}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="hidden lg:flex items-center justify-center">
                <ArrowRight className="h-6 w-6 text-muted-foreground" />
              </div>

              <div className="space-y-2 lg:col-span-2">
                <Label htmlFor="log-b">Log B (etat cible)</Label>
                <Select value={logBId} onValueChange={setLogBId} disabled={isLoadingLogs}>
                  <SelectTrigger id="log-b">
                    <SelectValue placeholder="Selectionner log B..." />
                  </SelectTrigger>
                  <SelectContent>
                    {missionLogs.map((log) => (
                      <SelectItem key={log.id} value={log.id} disabled={log.id === logAId}>
                        {log.filename}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-4 pt-2">
              <Button
                onClick={handleCompare}
                disabled={!logAId || !logBId || isComparing}
                className="gap-2"
              >
                {isComparing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <GitCompare className="h-4 w-4" />
                )}
                {isComparing ? "Analyse en cours..." : "Comparer les logs"}
              </Button>

              <div className="flex items-center gap-2">
                <Label htmlFor="can-interface" className="text-sm whitespace-nowrap">Interface:</Label>
                <Select value={canInterface} onValueChange={(v) => setCanInterface(v as CANInterface)}>
                  <SelectTrigger id="can-interface" className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="can0">can0</SelectItem>
                    <SelectItem value="can1">can1</SelectItem>
                    <SelectItem value="vcan0">vcan0</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Results */}
        {comparisonResult && (
          <Card className="border-border bg-card">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-lg">
                Resultats de la comparaison
              </CardTitle>
              <CardDescription>
                {comparisonResult.log_a_name} vs {comparisonResult.log_b_name}
              </CardDescription>
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
                      <div
                        key={frame.can_id}
                        className="rounded-lg border border-border bg-card overflow-hidden"
                      >
                        {/* Header row */}
                        <div
                          className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-secondary/30 transition-colors"
                          onClick={() => toggleExpanded(frame.can_id)}
                        >
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                          )}
                          {getClassificationIcon(frame.classification)}
                          <Badge variant="outline" className="font-mono">
                            {frame.can_id}
                          </Badge>
                          <Badge
                            variant="secondary"
                            className={
                              frame.classification === "differential"
                                ? "bg-amber-500/20 text-amber-500"
                                : frame.classification === "only_a"
                                ? "bg-red-500/20 text-red-500"
                                : frame.classification === "only_b"
                                ? "bg-green-500/20 text-green-500"
                                : "bg-muted text-muted-foreground"
                            }
                          >
                            {getClassificationLabel(frame.classification)}
                          </Badge>
                          <span className="text-xs text-muted-foreground ml-auto">
                            {frame.confidence.toFixed(0)}% confiance
                          </span>
                        </div>

                        {/* Expanded content */}
                        {isExpanded && (
                          <div className="px-3 pb-3 pt-1 border-t border-border bg-secondary/20 space-y-3">
                            {/* Payloads comparison */}
                            <div className="grid gap-2 sm:grid-cols-2">
                              <div className="p-2 rounded bg-card border border-border">
                                <div className="flex items-center justify-between mb-1">
                                  <span className="text-xs text-muted-foreground">Log A ({frame.count_a} trames)</span>
                                  {frame.payload_a && (
                                    <div className="flex gap-1">
                                      <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-6 w-6"
                                        onClick={(e) => { e.stopPropagation(); handleSendFrame(frame, true) }}
                                        disabled={sendingFrame === frame.can_id}
                                        title="Envoyer payload A"
                                      >
                                        {sendingFrame === frame.can_id ? (
                                          <Loader2 className="h-3 w-3 animate-spin" />
                                        ) : (
                                          <Play className="h-3 w-3" />
                                        )}
                                      </Button>
                                      <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-6 w-6 text-primary"
                                        onClick={(e) => { e.stopPropagation(); handleSaveToDBC(frame, true) }}
                                        title="Enregistrer A dans DBC"
                                      >
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
                                      <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-6 w-6"
                                        onClick={(e) => { e.stopPropagation(); handleSendFrame(frame, false) }}
                                        disabled={sendingFrame === frame.can_id}
                                        title="Envoyer payload B"
                                      >
                                        {sendingFrame === frame.can_id ? (
                                          <Loader2 className="h-3 w-3 animate-spin" />
                                        ) : (
                                          <Play className="h-3 w-3" />
                                        )}
                                      </Button>
                                      <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-6 w-6 text-primary"
                                        onClick={(e) => { e.stopPropagation(); handleSaveToDBC(frame, false) }}
                                        title="Enregistrer B dans DBC"
                                      >
                                        <FileCode className="h-3 w-3" />
                                      </Button>
                                    </div>
                                  )}
                                </div>
                                {renderPayloadWithDiff(frame.payload_b, frame.payload_a, frame.bytes_changed)}
                              </div>
                            </div>

                            {/* Bytes changed */}
                            {frame.bytes_changed.length > 0 && (
                              <div className="text-xs text-muted-foreground">
                                Octets modifies: {frame.bytes_changed.map(b => `#${b}`).join(", ")}
                              </div>
                            )}

                            {/* Actions */}
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                className="gap-2 bg-transparent"
                                onClick={(e) => { e.stopPropagation(); handleSendToReplay(frame) }}
                              >
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
        )}
      </div>
    </AppShell>
  )
}
