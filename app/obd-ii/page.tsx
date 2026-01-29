"use client"

import { useState } from "react"
import { AppShell } from "@/components/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Activity, Car, AlertTriangle, Trash2, RotateCcw, Info, Loader2, Search } from "lucide-react"
import { requestVIN, readDTCs, clearDTCs, resetECU, fullOBDScan, type OBDResponse, type FullScanResponse } from "@/lib/api"
import { SentFramesHistory, useSentFramesHistory } from "@/components/sent-frames-history"

export default function OBDII() {
  const [canInterface, setCanInterface] = useState<"can0" | "can1" | "vcan0">("can0")
  const [isLoading, setIsLoading] = useState<string | null>(null)
  const [vin, setVin] = useState<string | null>(null)
  const [dtcCodes, setDtcCodes] = useState<string[] | null>(null)
  const [lastResponse, setLastResponse] = useState<OBDResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scanResult, setScanResult] = useState<FullScanResponse | null>(null)
  
  // Sent frames history
  const { frames, trackFrame, clearHistory } = useSentFramesHistory()

  const handleRetrieveVIN = async () => {
    setIsLoading("vin")
    setError(null)
    try {
      await trackFrame(
        { canId: "7DF", data: "0902", interface: canInterface, description: "Request VIN" },
        async () => {
          const response = await requestVIN(canInterface)
          setLastResponse(response)
          if (response.status === "error") {
            throw new Error(response.message || "Erreur d'envoi")
          }
          if (response.data) {
            setVin(response.data)
          }
        }
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur lors de la requete VIN")
    } finally {
      setIsLoading(null)
    }
  }

  const handleReadDTC = async () => {
    setIsLoading("dtc")
    setError(null)
    try {
      await trackFrame(
        { canId: "7DF", data: "0300", interface: canInterface, description: "Read DTC" },
        async () => {
          const response = await readDTCs(canInterface)
          setLastResponse(response)
          if (response.status === "error") {
            throw new Error(response.message || "Erreur d'envoi")
          }
          if (response.status === "sent" || response.status === "success") {
            setDtcCodes(null)
          }
        }
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur lors de la lecture DTC")
    } finally {
      setIsLoading(null)
    }
  }

  const handleClearDTC = async () => {
    setIsLoading("clear")
    setError(null)
    try {
      await trackFrame(
        { canId: "7DF", data: "0104", interface: canInterface, description: "Clear DTC" },
        async () => {
          const response = await clearDTCs(canInterface)
          setLastResponse(response)
          if (response.status === "error") {
            throw new Error(response.message || "Erreur d'envoi")
          }
          if (response.status === "sent") {
            setDtcCodes([])
          }
        }
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur lors de l'effacement DTC")
    } finally {
      setIsLoading(null)
    }
  }

  const handleResetECU = async () => {
    setIsLoading("reset")
    setError(null)
    try {
      await trackFrame(
        { canId: "7DF", data: "1101", interface: canInterface, description: "Reset ECU" },
        async () => {
          const response = await resetECU(canInterface)
          setLastResponse(response)
          if (response.status === "error") {
            throw new Error(response.message || "Erreur d'envoi")
          }
          setVin(null)
          setDtcCodes(null)
        }
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur lors du reset ECU")
    } finally {
      setIsLoading(null)
    }
  }

  const handleFullScan = async () => {
    setIsLoading("fullscan")
    setError(null)
    setScanResult(null)
    try {
      await trackFrame(
        { canId: "7DF", data: "SCAN", interface: canInterface, description: "Full OBD Scan (VIN + PIDs + DTCs)" },
        async () => {
          const result = await fullOBDScan(canInterface)
          setScanResult(result)
          // Extract VIN if found
          if (result.results.vin && result.results.vin.length > 0) {
            setVin(result.results.vin[0])
          }
        }
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur lors du scan complet")
    } finally {
      setIsLoading(null)
    }
  }

  return (
    <AppShell
      title="OBD-II"
      description="Diagnostic OBD-II du vehicule"
    >
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Configuration */}
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <Activity className="h-5 w-5 text-primary" />
              Configuration
            </CardTitle>
            <CardDescription>Parametres de diagnostic OBD-II</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Interface CAN</Label>
              <Select value={canInterface} onValueChange={(v) => setCanInterface(v as "can0" | "can1" | "vcan0")}>
                <SelectTrigger className="bg-input border-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
<SelectItem value="can0">can0</SelectItem>
  <SelectItem value="can1">can1</SelectItem>
  <SelectItem value="vcan0">vcan0 (test)</SelectItem>
  </SelectContent>
              </Select>
            </div>

            <Alert className="border-muted bg-muted/30">
              <Info className="h-4 w-4" />
              <AlertTitle>Information</AlertTitle>
              <AlertDescription>
                Les requetes OBD-II utilisent le protocole standard ISO 15765-4 (CAN).
                Assurez-vous que l'interface CAN est initialisee avec le bon bitrate.
              </AlertDescription>
            </Alert>

            {error && (
              <Alert className="border-destructive/50 bg-destructive/10">
                <AlertTriangle className="h-4 w-4 text-destructive" />
                <AlertTitle className="text-destructive">Erreur</AlertTitle>
                <AlertDescription className="text-destructive/80">{error}</AlertDescription>
              </Alert>
            )}

            {lastResponse && (
              <Alert className="border-primary/50 bg-primary/10">
                <Info className="h-4 w-4 text-primary" />
                <AlertTitle className="text-primary">Reponse</AlertTitle>
                <AlertDescription className="text-primary/80 font-mono text-xs">
                  {lastResponse.message}
                  {lastResponse.warning && (
                    <span className="block mt-1 text-warning">{lastResponse.warning}</span>
                  )}
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        {/* VIN */}
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <Car className="h-5 w-5 text-primary" />
              Identification vehicule
            </CardTitle>
            <CardDescription>Recuperation du VIN via OBD-II</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button
              onClick={handleRetrieveVIN}
              disabled={isLoading !== null}
              className="w-full"
            >
              {isLoading === "vin" ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Requete en cours...
                </>
              ) : (
                "Recuperer le VIN"
              )}
            </Button>

            {vin && (
              <div className="rounded-lg border border-success/30 bg-success/10 p-4">
                <Label className="text-xs text-muted-foreground">VIN detecte</Label>
                <p className="font-mono text-lg font-bold text-success">{vin}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* DTC */}
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <AlertTriangle className="h-5 w-5 text-warning" />
              Codes defaut (DTC)
            </CardTitle>
            <CardDescription>Lecture et effacement des codes defaut</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Button
                onClick={handleReadDTC}
                disabled={isLoading !== null}
                variant="secondary"
                className="flex-1"
              >
                {isLoading === "dtc" ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Lecture...
                  </>
                ) : (
                  "Lire les DTC"
                )}
              </Button>
              <Button
                onClick={handleClearDTC}
                disabled={isLoading !== null || !dtcCodes || dtcCodes.length === 0}
                variant="destructive"
              >
                {isLoading === "clear" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
              </Button>
            </div>

            {dtcCodes !== null && (
              <div className="rounded-lg border border-border bg-muted/30 p-4">
                {dtcCodes.length === 0 ? (
                  <p className="text-sm text-success">Aucun code defaut detecte</p>
                ) : (
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">
                      {dtcCodes.length} code(s) detecte(s)
                    </Label>
                    <div className="flex flex-wrap gap-2">
                      {dtcCodes.map((code) => (
                        <span
                          key={code}
                          className="rounded bg-destructive/20 px-2 py-1 font-mono text-sm text-destructive"
                        >
                          {code}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            <Alert className="border-warning/50 bg-warning/10">
              <AlertTriangle className="h-4 w-4 text-warning" />
              <AlertDescription className="text-warning text-xs">
                L'effacement des DTC supprime egalement les donnees de freeze frame.
                A utiliser avec precaution.
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>

        {/* Reset ECU */}
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <RotateCcw className="h-5 w-5 text-destructive" />
              Reset ECU
            </CardTitle>
            <CardDescription>Reinitialisation du calculateur</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert className="border-destructive/50 bg-destructive/10">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              <AlertTitle className="text-destructive">Attention</AlertTitle>
              <AlertDescription className="text-destructive/80 text-sm">
                Le reset ECU peut provoquer un arret temporaire du vehicule.
                Ne pas utiliser pendant la conduite. Le vehicule doit etre a l'arret,
                contact mis.
              </AlertDescription>
            </Alert>

            <Button
              onClick={handleResetECU}
              disabled={isLoading !== null}
              variant="destructive"
              className="w-full"
            >
              {isLoading === "reset" ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Reset en cours...
                </>
              ) : (
                <>
                  <RotateCcw className="h-4 w-4 mr-2" />
                  Reset ECU
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Full Scan */}
        <Card className="lg:col-span-2 bg-card border-border">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <Search className="h-5 w-5 text-primary" />
              Scan complet OBD-II
            </CardTitle>
            <CardDescription>
              Equivalent du script aurige_obd.sh - Recupere VIN, scanne les PIDs et lit les DTCs
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button
              onClick={handleFullScan}
              disabled={isLoading !== null}
              className="w-full"
              size="lg"
            >
              {isLoading === "fullscan" ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Scan en cours... (environ 30 secondes)
                </>
              ) : (
                <>
                  <Search className="h-4 w-4 mr-2" />
                  Lancer le scan complet
                </>
              )}
            </Button>

            {scanResult && (
              <div className="rounded-lg border border-success/30 bg-success/10 p-4 space-y-4">
                <div className="flex items-center gap-2">
                  <Activity className="h-5 w-5 text-success" />
                  <span className="font-semibold text-success">Scan termine</span>
                </div>
                
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="rounded bg-background/50 p-3">
                    <Label className="text-xs text-muted-foreground">VIN</Label>
                    <p className="font-mono text-sm">
                      {scanResult.results.vin?.length ? scanResult.results.vin[0] : "Non detecte"}
                    </p>
                  </div>
                  <div className="rounded bg-background/50 p-3">
                    <Label className="text-xs text-muted-foreground">PIDs scannes</Label>
                    <p className="font-mono text-sm">{scanResult.results.pids.length} reponses</p>
                  </div>
                  <div className="rounded bg-background/50 p-3">
                    <Label className="text-xs text-muted-foreground">DTCs</Label>
                    <p className="font-mono text-sm">{scanResult.results.dtcs.length} trames</p>
                  </div>
                </div>

                {scanResult.results.logFile && (
                  <p className="text-xs text-muted-foreground">
                    Log enregistre: <code className="bg-muted px-1 rounded">{scanResult.results.logFile}</code>
                  </p>
                )}
              </div>
            )}

            <Alert className="border-muted bg-muted/30">
              <Info className="h-4 w-4" />
              <AlertDescription className="text-xs">
                Le scan complet envoie les requetes VIN (Service 09), scanne les PIDs cles du Service 01,
                et lit les DTCs (Service 03). Le protocole ISO-TP avec flow control est utilise pour
                les reponses multi-trames.
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>

        {/* Sent Frames History */}
        <div className="lg:col-span-2">
          <SentFramesHistory frames={frames} onClear={clearHistory} />
        </div>
      </div>
    </AppShell>
  )
}
