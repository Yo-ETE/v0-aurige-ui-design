"use client"

import { useState, useEffect } from "react"
import { AppShell } from "@/components/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { 
  AlertTriangle, 
  RefreshCw, 
  Shield, 
  CheckCircle2, 
  XCircle,
  AlertCircle,
  FileSearch,
  Zap,
} from "lucide-react"
import { 
  attemptCrashRecovery, 
  getFuzzingHistory, 
  compareLogsWithFuzzing,
  listMissionLogs,
  type FuzzingHistory,
  type CrashRecoveryResponse,
  type LogComparisonResult,
  type CANInterface,
  type LogEntry,
} from "@/lib/api"
import { useMissionStore } from "@/lib/mission-store"
import { cn } from "@/lib/utils"

export default function CrashRecoveryPage() {
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

  useEffect(() => {
    loadHistory()
    if (currentMission?.id) {
      loadLogs()
    }
  }, [currentMission?.id])
  
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
    setIsLoadingHistory(true)
    try {
      const data = await getFuzzingHistory()
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

  return (
    <AppShell>
    <div className="container mx-auto space-y-6 py-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Crash Recovery</h1>
        <p className="text-muted-foreground mt-1">
          Detection et recuperation apres crash CAN / fuzzing
        </p>
      </div>

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

          {history?.exists && (
            <>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <div className="rounded border border-border bg-secondary/20 p-3">
                  <p className="text-muted-foreground text-xs">Trames envoyees</p>
                  <p className="text-2xl font-bold text-foreground">{history.total_sent || 0}</p>
                </div>
                <div className="rounded border border-border bg-secondary/20 p-3">
                  <p className="text-muted-foreground text-xs">IDs uniques</p>
                  <p className="text-2xl font-bold text-primary">
                    {new Set((history.frames || []).map(f => f.id)).size}
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

              {history.frames && history.frames.length > 0 && (
                <div className="max-h-96 overflow-y-auto rounded border border-border bg-secondary/10 p-3 font-mono text-xs">
                  <div className="mb-2 text-muted-foreground">
                    Affichage de toutes les {history.frames.length} trames envoyées
                  </div>
                  {history.frames.map((frame, i) => (
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
          )}
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
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium w-32">Log pre-fuzz:</label>
            {availableLogs.length > 0 ? (
              <select
                value={selectedPreFuzzLog}
                onChange={(e) => setSelectedPreFuzzLog(e.target.value)}
                className="flex-1 rounded border border-border bg-background px-3 py-2 text-sm"
                disabled={isLoadingLogs}
              >
                <option value="">Selectionnez un log...</option>
                {availableLogs.map((log) => (
                  <option key={log.id} value={log.id}>
                    {log.name || log.id}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={selectedPreFuzzLog}
                onChange={(e) => setSelectedPreFuzzLog(e.target.value)}
                placeholder="Ex: 20250211_143022"
                className="flex-1 rounded border border-border bg-background px-3 py-2 text-sm"
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
              <div className="flex gap-2">
                <input
                  type="text"
                  value={customSuspectIds}
                  onChange={(e) => setCustomSuspectIds(e.target.value)}
                  placeholder="Ex: 4C8, 303, 360"
                  className="flex-1 rounded border border-border bg-background px-3 py-2 text-sm font-mono"
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
