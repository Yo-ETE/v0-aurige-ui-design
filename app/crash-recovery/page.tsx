"use client"

import { useState, useEffect, Suspense } from "react"
import { useSearchParams } from "next/navigation"
import { AppShell } from "@/components/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { InjectStatusBar } from "@/components/inject-status"
import {
  AlertTriangle,
  RefreshCw,
  Shield,
  CheckCircle2,
  XCircle,
  AlertCircle,
  FileSearch,
  Zap,
  Trash2,
  Play,
  Repeat,
  RotateCcw,
  Plus,
  X,
  Library,
  Ban,
} from "lucide-react"
import {
  attemptCrashRecovery,
  getFuzzingHistory,
  compareLogsWithFuzzing,
  listMissionLogs,
  listKnownFrames,
  createKnownFrame,
  deleteKnownFrame,
  replayKnownFrame,
  getBlocklist,
  setBlocklist,
  type FuzzingHistory,
  type CrashRecoveryResponse,
  type LogComparisonResult,
  type CANInterface,
  type LogEntry,
  type KnownFrame,
} from "@/lib/api"
import { useMissionStore } from "@/lib/mission-store"
import { LogSelector } from "@/components/log-selector"
import { cn } from "@/lib/utils"

const SEVERITY_CLASS: Record<string, string> = {
  info: "text-primary border-primary/50",
  warning: "text-warning border-warning/50",
  danger: "text-destructive border-destructive/50",
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export default function CrashRecoveryPage() {
  // useSearchParams() exige une frontiere Suspense en app-router (prerendu statique)
  return (
    <Suspense fallback={null}>
      <CrashRecoveryContent />
    </Suspense>
  )
}

function CrashRecoveryContent() {
  const searchParams = useSearchParams()
  const currentMission = useMissionStore((state) => state.getCurrentMission())

  const [selectedInterface, setSelectedInterface] = useState<CANInterface>("can0")
  const [history, setHistory] = useState<FuzzingHistory | null>(null)
  const [comparison, setComparison] = useState<LogComparisonResult | null>(null)
  const [recoveryResult, setRecoveryResult] = useState<CrashRecoveryResponse | null>(null)
  const [isLoadingHistory, setIsLoadingHistory] = useState(false)
  const [isComparing, setIsComparing] = useState(false)
  const [isRecovering, setIsRecovering] = useState(false)
  const [selectedPreFuzzLog, setSelectedPreFuzzLog] = useState<string>("")
  const [customSuspectIds, setCustomSuspectIds] = useState<string>("")
  const [availableLogs, setAvailableLogs] = useState<LogEntry[]>([])
  const [isLoadingLogs, setIsLoadingLogs] = useState(false)

  // Bibliotheque de trames remarquables (crash / reinit)
  const [frames, setFrames] = useState<KnownFrame[]>([])
  const [framesError, setFramesError] = useState<string | null>(null)
  const [formLabel, setFormLabel] = useState("")
  const [formCanId, setFormCanId] = useState(searchParams.get("crashFrame") ?? "")
  const [formCrashData, setFormCrashData] = useState(searchParams.get("crashData") ?? "")
  const [formResetData, setFormResetData] = useState("")
  const [formSeverity, setFormSeverity] = useState<"info" | "warning" | "danger">("warning")
  const [formNotes, setFormNotes] = useState("")
  const [isCreating, setIsCreating] = useState(false)
  const [pendingReplay, setPendingReplay] = useState<{ frame: KnownFrame; loop: boolean } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<KnownFrame | null>(null)

  // Liste de blocage AUD-06
  const [blockIds, setBlockIds] = useState<string[]>([])
  const [blockInput, setBlockInput] = useState("")
  const [blockError, setBlockError] = useState<string | null>(null)

  useEffect(() => {
    loadHistory()
    if (currentMission?.id) {
      loadLogs()
    }
  }, [currentMission?.id])

  useEffect(() => {
    loadFrames()
    loadBlocklist()
  }, [])

  const loadLogs = async () => {
    if (!currentMission?.id) return
    setIsLoadingLogs(true)
    try {
      const logs = await listMissionLogs(currentMission.id)
      setAvailableLogs(logs)
    } catch (error) {
      console.error("Failed to load logs:", error)
    } finally {
      setIsLoadingLogs(false)
    }
  }

  const loadHistory = async () => {
    if (!currentMission?.id) {
      setHistory(null)
      return
    }
    setIsLoadingHistory(true)
    try {
      const data = await getFuzzingHistory(currentMission.id)
      setHistory(data)
    } catch (error) {
      console.error("Failed to load fuzzing history:", error)
    } finally {
      setIsLoadingHistory(false)
    }
  }

  const handleCompare = async () => {
    if (!currentMission || !selectedPreFuzzLog) {
      alert("Selectionnez une mission et un log pre-fuzz")
      return
    }
    setIsComparing(true)
    try {
      const result = await compareLogsWithFuzzing(currentMission.id, selectedPreFuzzLog)
      setComparison(result)
    } catch (error) {
      console.error("Failed to compare logs:", error)
      alert("Erreur lors de la comparaison")
    } finally {
      setIsComparing(false)
    }
  }

  const handleRecovery = async (suspectIds?: string[]) => {
    setIsRecovering(true)
    setRecoveryResult(null)
    try {
      const result = await attemptCrashRecovery(selectedInterface, suspectIds)
      setRecoveryResult(result)
    } catch (error) {
      console.error("Recovery failed:", error)
      alert("Erreur lors du recovery")
    } finally {
      setIsRecovering(false)
    }
  }

  const handleQuickRecovery = () => {
    handleRecovery() // Uses common crash IDs
  }

  const handleTargetedRecovery = () => {
    if (!comparison || comparison.suspect_ids.length === 0) {
      alert("Aucun ID suspect identifie. Lancez d'abord la comparaison.")
      return
    }
    handleRecovery(comparison.suspect_ids)
  }

  const handleCustomRecovery = () => {
    const ids = customSuspectIds.split(",").map(id => id.trim().toUpperCase()).filter(Boolean)
    if (ids.length === 0) {
      alert("Entrez au moins un ID")
      return
    }
    handleRecovery(ids)
  }

  // ---- Bibliotheque de trames remarquables ----

  const loadFrames = async () => {
    try {
      const r = await listKnownFrames()
      setFrames(r.frames)
      setFramesError(null)
    } catch (e) {
      setFramesError(errMsg(e))
    }
  }

  const handleCreateFrame = async () => {
    setIsCreating(true)
    setFramesError(null)
    try {
      await createKnownFrame({
        label: formLabel.trim(),
        can_id: formCanId.trim(),
        crash_data: formCrashData.trim(),
        reset_data: formResetData.trim() || undefined,
        severity: formSeverity,
        notes: formNotes.trim() || undefined,
      })
      setFormLabel("")
      setFormCanId("")
      setFormCrashData("")
      setFormResetData("")
      setFormNotes("")
      await loadFrames()
    } catch (e) {
      setFramesError(errMsg(e))
    } finally {
      setIsCreating(false)
    }
  }

  const doReplay = async (frame: KnownFrame, kind: "crash" | "reset", loop: boolean) => {
    setFramesError(null)
    try {
      await replayKnownFrame(frame.id, { interface: selectedInterface, kind, loop })
    } catch (e) {
      setFramesError(errMsg(e))
    }
  }

  const doDelete = async (frame: KnownFrame) => {
    setFramesError(null)
    try {
      await deleteKnownFrame(frame.id)
      await loadFrames()
    } catch (e) {
      setFramesError(errMsg(e))
    }
  }

  // ---- Liste de blocage AUD-06 ----

  const loadBlocklist = async () => {
    try {
      const r = await getBlocklist()
      setBlockIds(r.ids)
      setBlockError(null)
    } catch (e) {
      setBlockError(errMsg(e))
    }
  }

  const updateBlocklist = async (ids: string[]) => {
    setBlockError(null)
    try {
      const r = await setBlocklist(ids)
      setBlockIds(r.ids)
      return true
    } catch (e) {
      setBlockError(errMsg(e))
      return false
    }
  }

  const handleAddBlockId = async () => {
    const id = blockInput.trim().toUpperCase().replace(/^0X/, "")
    if (!id) return
    if (blockIds.includes(id)) {
      setBlockInput("")
      return
    }
    if (await updateBlocklist([...blockIds, id])) setBlockInput("")
  }

  return (
    <AppShell>
    <div className="container mx-auto space-y-6 py-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Crash Recovery</h1>
        <p className="text-muted-foreground mt-1">
          Detection et recuperation apres crash CAN / fuzzing
        </p>
      </div>

      {/* Mission warning */}
      {!currentMission && (
        <Alert className="border-warning bg-warning/10">
          <AlertTriangle className="h-4 w-4 text-warning" />
          <AlertDescription>
            Aucune mission active. Selectionnez une mission pour acceder a l'historique de fuzzing et a l'analyse de crash.
          </AlertDescription>
        </Alert>
      )}

      {/* Interface selector */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-primary" />
            Configuration
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium">Interface CAN:</label>
            <select
              value={selectedInterface}
              onChange={(e) => setSelectedInterface(e.target.value as CANInterface)}
              className="rounded border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="can0">can0</option>
              <option value="can1">can1</option>
              <option value="vcan0">vcan0 (test)</option>
            </select>
          </div>
        </CardContent>
      </Card>

      {/* Trames remarquables (crash / reinit) */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Library className="h-5 w-5 text-primary" />
            Trames remarquables (crash / réinit)
          </CardTitle>
          <CardDescription>
            Bibliothèque de trames connues pour provoquer un crash ou le réinitialiser, rejouables sur l'interface sélectionnée
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <InjectStatusBar className="mb-4" />

          {framesError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{framesError}</AlertDescription>
            </Alert>
          )}

          <div className="overflow-x-auto rounded border border-border">
            <table className="w-full text-sm">
              <thead className="bg-secondary/30 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Label</th>
                  <th className="px-3 py-2">CAN ID</th>
                  <th className="px-3 py-2">Data crash</th>
                  <th className="px-3 py-2">Data réinit</th>
                  <th className="px-3 py-2">Gravité</th>
                  <th className="px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {frames.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-4 text-center text-muted-foreground">
                      Aucune trame enregistrée
                    </td>
                  </tr>
                )}
                {frames.map((f) => (
                  <tr key={f.id} className="border-t border-border align-top">
                    <td className="px-3 py-2">
                      {f.label}
                      {f.notes && <p className="text-xs text-muted-foreground">{f.notes}</p>}
                    </td>
                    <td className="px-3 py-2 font-mono font-bold text-primary">{f.can_id}</td>
                    <td className="px-3 py-2 font-mono">{f.crash_data}</td>
                    <td className="px-3 py-2 font-mono">{f.reset_data || "-"}</td>
                    <td className="px-3 py-2">
                      <Badge variant="outline" className={SEVERITY_CLASS[f.severity] ?? ""}>
                        {f.severity}
                      </Badge>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Button size="sm" variant="outline" onClick={() => setPendingReplay({ frame: f, loop: false })}>
                          <Play className="h-4 w-4 mr-1" />
                          Rejouer crash
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setPendingReplay({ frame: f, loop: true })}>
                          <Repeat className="h-4 w-4 mr-1" />
                          Rejouer crash en boucle
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!f.reset_data}
                          onClick={() => doReplay(f, "reset", false)}
                        >
                          <RotateCcw className="h-4 w-4 mr-1" />
                          Rejouer réinit
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setPendingDelete(f)}>
                          <Trash2 className="h-4 w-4 mr-1" />
                          Supprimer
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="rounded border border-border bg-secondary/10 p-4 space-y-3">
            <h3 className="font-medium text-sm">Ajouter une trame</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input placeholder="Label" value={formLabel} onChange={(e) => setFormLabel(e.target.value)} />
              <Input
                placeholder="CAN ID (ex: 4C8)"
                className="font-mono"
                value={formCanId}
                onChange={(e) => setFormCanId(e.target.value)}
              />
              <Input
                placeholder="Data crash (ex: FF00FF00)"
                className="font-mono"
                value={formCrashData}
                onChange={(e) => setFormCrashData(e.target.value)}
              />
              <Input
                placeholder="Data réinit (optionnel)"
                className="font-mono"
                value={formResetData}
                onChange={(e) => setFormResetData(e.target.value)}
              />
              <select
                value={formSeverity}
                onChange={(e) => setFormSeverity(e.target.value as "info" | "warning" | "danger")}
                className="rounded border border-border bg-background px-3 py-2 text-sm"
                aria-label="Gravité"
              >
                <option value="info">info</option>
                <option value="warning">warning</option>
                <option value="danger">danger</option>
              </select>
              <Input placeholder="Notes (optionnel)" value={formNotes} onChange={(e) => setFormNotes(e.target.value)} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={handleCreateFrame} disabled={isCreating || !formLabel.trim() || !formCanId.trim() || !formCrashData.trim()}>
                <Plus className="h-4 w-4 mr-2" />
                {isCreating ? "Ajout..." : "Ajouter"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* IDs critiques AUD-06 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Ban className="h-5 w-5 text-destructive" />
            IDs critiques (AUD-06)
          </CardTitle>
          <CardDescription>
            Le fuzzing et la génération ne balaient jamais ces IDs. OBD (7DF / 7E0–7EF) n'est jamais bloqué.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {blockError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{blockError}</AlertDescription>
            </Alert>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {blockIds.length === 0 && <span className="text-sm text-muted-foreground">Aucun ID bloqué</span>}
            {blockIds.map((id) => (
              <Badge key={id} variant="outline" className="font-mono gap-1 pr-1">
                {id}
                <button
                  type="button"
                  aria-label={`Retirer ${id}`}
                  className="rounded p-0.5 hover:bg-destructive/20"
                  onClick={() => updateBlocklist(blockIds.filter((x) => x !== id))}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="ID hex (ex: 5E8)"
              className="font-mono w-40"
              value={blockInput}
              onChange={(e) => setBlockInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddBlockId()}
            />
            <Button onClick={handleAddBlockId} disabled={!blockInput.trim()}>
              <Plus className="h-4 w-4 mr-2" />
              Ajouter
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Confirmation injection crash */}
      <AlertDialog open={!!pendingReplay} onOpenChange={(o) => !o && setPendingReplay(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmer l'injection</AlertDialogTitle>
            <AlertDialogDescription>
              Injection volontaire sur un ID potentiellement critique — confirmer
              {pendingReplay && (
                <span className="mt-2 block font-mono">
                  {pendingReplay.frame.can_id}#{pendingReplay.frame.crash_data} sur {selectedInterface}
                  {pendingReplay.loop ? " (en boucle)" : ""}
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingReplay) doReplay(pendingReplay.frame, "crash", pendingReplay.loop)
                setPendingReplay(null)
              }}
            >
              Confirmer
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirmation suppression */}
      <AlertDialog open={!!pendingDelete} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer la trame</AlertDialogTitle>
            <AlertDialogDescription>
              Supprimer « {pendingDelete?.label} » de la bibliothèque ?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDelete) doDelete(pendingDelete)
                setPendingDelete(null)
              }}
            >
              Supprimer
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Fuzzing history */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span className="flex items-center gap-2">
              <FileSearch className="h-5 w-5 text-warning" />
              Historique Fuzzing
            </span>
            <Button size="sm" variant="outline" onClick={loadHistory} disabled={isLoadingHistory}>
              <RefreshCw className={cn("h-4 w-4 mr-2", isLoadingHistory && "animate-spin")} />
              Actualiser
            </Button>
          </CardTitle>
          <CardDescription>
            Trames envoyees lors du dernier fuzzing (avant crash potentiel)
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {!history?.exists && (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                Aucun historique de fuzzing trouve. Lancez un fuzzing pour generer un historique.
              </AlertDescription>
            </Alert>
          )}

          {history?.exists && (() => {
            // Use frames_sent (new format) or frames (legacy)
            const allFrames = history.frames_sent || history.frames || []
            const uniqueIds = new Set(allFrames.map(f => f.id)).size

            return (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                <div className="rounded border border-border bg-secondary/20 p-3">
                  <p className="text-muted-foreground text-xs">Trames envoyees</p>
                  <p className="text-2xl font-bold text-foreground">{history.total_sent || 0}</p>
                </div>
                <div className="rounded border border-border bg-secondary/20 p-3">
                  <p className="text-muted-foreground text-xs">IDs uniques</p>
                  <p className="text-2xl font-bold text-primary">
                    {uniqueIds}
                  </p>
                </div>
                <div className="rounded border border-border bg-secondary/20 p-3">
                  <p className="text-muted-foreground text-xs">Duree (approx)</p>
                  <p className="text-2xl font-bold text-muted-foreground">
                    {history.started_at && history.stopped_at
                      ? `${Math.round((history.stopped_at - history.started_at))}s`
                      : "N/A"}
                  </p>
                </div>
              </div>

              {allFrames.length > 0 && (
                <div className="max-h-96 overflow-y-auto rounded border border-border bg-secondary/10 p-3 font-mono text-xs">
                  <div className="mb-2 text-muted-foreground">
                    Affichage de toutes les {allFrames.length} trames envoyées
                  </div>
                  {allFrames.map((frame, i) => (
                    <div key={i} className="flex items-center gap-3 py-0.5">
                      <span className="text-muted-foreground w-12">#{frame.index || i+1}</span>
                      <span className="text-primary font-bold w-16">{frame.id}</span>
                      <span className="text-muted-foreground">#</span>
                      <span className="text-foreground">{frame.data}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
            )
          })()}
        </CardContent>
      </Card>

      {/* Log comparison */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-warning" />
            Analyse Differentielle
          </CardTitle>
          <CardDescription>
            Comparez un log pre-fuzz avec l'historique pour identifier les IDs suspects
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm font-medium w-32">Log pre-fuzz:</label>
            {availableLogs.length > 0 ? (
              <div className="flex-1 min-w-[200px]">
                <LogSelector
                  logs={availableLogs}
                  value={selectedPreFuzzLog}
                  onValueChange={setSelectedPreFuzzLog}
                  placeholder="Selectionnez un log..."
                  disabled={isLoadingLogs}
                  triggerClassName="h-9 text-sm"
                />
              </div>
            ) : (
              <input
                type="text"
                value={selectedPreFuzzLog}
                onChange={(e) => setSelectedPreFuzzLog(e.target.value)}
                placeholder="Ex: 20250211_143022"
                className="flex-1 min-w-[200px] rounded border border-border bg-background px-3 py-2 text-sm"
              />
            )}
            <Button onClick={handleCompare} disabled={isComparing || !currentMission || !selectedPreFuzzLog}>
              <FileSearch className="h-4 w-4 mr-2" />
              {isComparing ? "Analyse..." : "Comparer"}
            </Button>
          </div>

          {comparison && (
            <div className="space-y-3">
              <Alert className={cn(
                "border-l-4",
                comparison.suspect_ids.length > 0 ? "border-l-warning bg-warning/5" : "border-l-success bg-success/5"
              )}>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  <strong>{comparison.message}</strong>
                  <div className="mt-2 text-xs space-y-1">
                    <p>IDs pre-fuzz: {comparison.pre_fuzz_ids.length}</p>
                    <p>IDs fuzzing: {comparison.fuzzing_ids.length}</p>
                  </div>
                </AlertDescription>
              </Alert>

              {comparison.suspect_ids.length > 0 && (
                <div className="rounded border border-warning/30 bg-warning/5 p-3">
                  <p className="text-sm font-medium mb-2">IDs suspects detectes:</p>
                  <div className="flex flex-wrap gap-2">
                    {comparison.suspect_ids.map(id => (
                      <Badge key={id} variant="outline" className="font-mono text-warning border-warning/50">
                        {id}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recovery actions */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-success" />
            Tentative de Recuperation
          </CardTitle>
          <CardDescription>
            Envoi de trames de reset (0x00...) pour annuler un crash potentiel
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3">
            {/* Quick recovery */}
            <div className="rounded border border-border bg-secondary/10 p-4">
              <h3 className="font-medium text-sm mb-2">Recovery Rapide (IDs Communs)</h3>
              <p className="text-xs text-muted-foreground mb-3">
                Envoie des resets sur les IDs crash classiques: 4C8, 5E8, 3B7, 360, 1A0, 0F6
              </p>
              <Button onClick={handleQuickRecovery} disabled={isRecovering} className="w-full">
                <Shield className="h-4 w-4 mr-2" />
                Lancer Recovery Rapide
              </Button>
            </div>

            {/* Targeted recovery */}
            <div className="rounded border border-warning/30 bg-warning/5 p-4">
              <h3 className="font-medium text-sm mb-2">Recovery Cible (IDs Suspects)</h3>
              <p className="text-xs text-muted-foreground mb-3">
                Envoie des resets uniquement sur les IDs suspects identifies par analyse
              </p>
              <Button
                onClick={handleTargetedRecovery}
                disabled={isRecovering || !comparison || comparison.suspect_ids.length === 0}
                variant="outline"
                className="w-full border-warning/50 text-warning hover:bg-warning/10"
              >
                <AlertTriangle className="h-4 w-4 mr-2" />
                Lancer Recovery Cible ({comparison?.suspect_ids.length || 0} IDs)
              </Button>
            </div>

            {/* Custom recovery */}
            <div className="rounded border border-primary/30 bg-primary/5 p-4">
              <h3 className="font-medium text-sm mb-2">Recovery Manuel (IDs Personnalises)</h3>
              <p className="text-xs text-muted-foreground mb-3">
                Entrez les IDs manuellement (separes par virgules)
              </p>
              <div className="flex flex-wrap gap-2">
                <input
                  type="text"
                  value={customSuspectIds}
                  onChange={(e) => setCustomSuspectIds(e.target.value)}
                  placeholder="Ex: 4C8, 303, 360"
                  className="flex-1 min-w-[200px] rounded border border-border bg-background px-3 py-2 text-sm font-mono"
                />
                <Button onClick={handleCustomRecovery} disabled={isRecovering} variant="outline">
                  <Zap className="h-4 w-4 mr-2" />
                  Executer
                </Button>
              </div>
            </div>
          </div>

          {/* Recovery results */}
          {recoveryResult && (
            <div className="rounded border border-border bg-secondary/20 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-medium text-sm">Resultat du Recovery</h3>
                <Badge variant="outline" className="text-success border-success/50">
                  {recoveryResult.status}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">{recoveryResult.message}</p>

              <div className="space-y-2">
                {recoveryResult.results.map((result, i) => (
                  <div key={i} className="flex items-center gap-3 rounded bg-background p-2 text-xs">
                    {result.status === "sent" ? (
                      <CheckCircle2 className="h-4 w-4 text-success flex-shrink-0" />
                    ) : (
                      <XCircle className="h-4 w-4 text-destructive flex-shrink-0" />
                    )}
                    <span className="font-mono font-bold text-primary w-12">{result.id}</span>
                    <span className="text-muted-foreground flex-1">{result.frame || result.error}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {isRecovering && (
            <Alert>
              <RefreshCw className="h-4 w-4 animate-spin" />
              <AlertDescription>
                Envoi des trames de recovery en cours...
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
    </AppShell>
  )
}
