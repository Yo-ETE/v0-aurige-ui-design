"use client"

import { useState } from "react"
import { AppShell } from "@/components/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Activity, Car, AlertTriangle, Trash2, RotateCcw, Info, Loader2 } from "lucide-react"
import { requestVIN, readDTCs, clearDTCs, resetECU, type OBDResponse } from "@/lib/api"

export default function OBDII() {
  const [canInterface, setCanInterface] = useState<"can0" | "can1">("can0")
  const [isLoading, setIsLoading] = useState<string | null>(null)
  const [vin, setVin] = useState<string | null>(null)
  const [dtcCodes, setDtcCodes] = useState<string[] | null>(null)
  const [lastResponse, setLastResponse] = useState<OBDResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleRetrieveVIN = async () => {
    setIsLoading("vin")
    setError(null)
    try {
      const response = await requestVIN(canInterface)
      setLastResponse(response)
      if (response.data) {
        setVin(response.data)
      }
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
      const response = await readDTCs(canInterface)
      setLastResponse(response)
      // In real implementation, parse DTC codes from response
      if (response.status === "sent") {
        // Request sent, check candump for response
        setDtcCodes(null)
      }
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
      const response = await clearDTCs(canInterface)
      setLastResponse(response)
      if (response.status === "sent") {
        setDtcCodes([])
      }
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
      const response = await resetECU(canInterface)
      setLastResponse(response)
      setVin(null)
      setDtcCodes(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur lors du reset ECU")
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
              <Select value={canInterface} onValueChange={(v) => setCanInterface(v as "can0" | "can1")}>
                <SelectTrigger className="bg-input border-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="can0">can0</SelectItem>
                  <SelectItem value="can1">can1</SelectItem>
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
      </div>
    </AppShell>
  )
}
