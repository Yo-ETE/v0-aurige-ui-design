"use client"

import { useState } from "react"
import { AppShell } from "@/components/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Activity, Car, AlertTriangle, Trash2, RotateCcw, Info } from "lucide-react"

export default function OBDII() {
  const [canInterface, setCanInterface] = useState("can0")
  const [isLoading, setIsLoading] = useState<string | null>(null)
  const [vin, setVin] = useState<string | null>(null)
  const [dtcCodes, setDtcCodes] = useState<string[] | null>(null)

  const handleRetrieveVIN = async () => {
    setIsLoading("vin")
    await new Promise((resolve) => setTimeout(resolve, 1000))
    setVin("WBAPH5C55BA123456")
    setIsLoading(null)
  }

  const handleReadDTC = async () => {
    setIsLoading("dtc")
    await new Promise((resolve) => setTimeout(resolve, 1500))
    setDtcCodes(["P0300", "P0171", "P0420"])
    setIsLoading(null)
  }

  const handleClearDTC = async () => {
    setIsLoading("clear")
    await new Promise((resolve) => setTimeout(resolve, 800))
    setDtcCodes([])
    setIsLoading(null)
  }

  const handleResetECU = async () => {
    setIsLoading("reset")
    await new Promise((resolve) => setTimeout(resolve, 2000))
    setVin(null)
    setDtcCodes(null)
    setIsLoading(null)
  }

  return (
    <AppShell
      title="OBD-II"
      description="Diagnostic OBD-II du véhicule"
    >
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Main Diagnostic Card */}
        <Card className="border-border bg-card">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <Activity className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-lg">Diagnostic OBD-II</CardTitle>
                <CardDescription>
                  Interroger le système de diagnostic embarqué
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="obd-interface">Interface CAN</Label>
              <Select value={canInterface} onValueChange={setCanInterface}>
                <SelectTrigger id="obd-interface">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="can0">can0</SelectItem>
                  <SelectItem value="can1">can1</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Button
                onClick={handleRetrieveVIN}
                disabled={isLoading !== null}
                variant="outline"
                className="justify-start gap-3 bg-transparent"
              >
                <Car className="h-4 w-4" />
                {isLoading === "vin" ? "Lecture..." : "Récupérer VIN"}
              </Button>
              <Button
                onClick={handleReadDTC}
                disabled={isLoading !== null}
                variant="outline"
                className="justify-start gap-3 bg-transparent"
              >
                <AlertTriangle className="h-4 w-4" />
                {isLoading === "dtc" ? "Lecture..." : "Lire DTC"}
              </Button>
              <Button
                onClick={handleClearDTC}
                disabled={isLoading !== null}
                variant="outline"
                className="justify-start gap-3 bg-transparent"
              >
                <Trash2 className="h-4 w-4" />
                {isLoading === "clear" ? "Effacement..." : "Effacer DTC"}
              </Button>
              <Button
                onClick={handleResetECU}
                disabled={isLoading !== null}
                variant="destructive"
                className="justify-start gap-3"
              >
                <RotateCcw className="h-4 w-4" />
                {isLoading === "reset" ? "Reset..." : "Reset ECU"}
              </Button>
            </div>

            <Alert className="border-muted bg-muted/50">
              <Info className="h-4 w-4" />
              <AlertTitle>Notes</AlertTitle>
              <AlertDescription className="text-muted-foreground">
                <ul className="mt-2 list-disc space-y-1 pl-4 text-xs">
                  <li>L&apos;interface CAN doit être initialisée avant utilisation</li>
                  <li>Compatible avec les véhicules OBD-II (post-2000 en Europe)</li>
                  <li>Le reset ECU peut affecter le fonctionnement du véhicule</li>
                </ul>
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>

        {/* Results Card */}
        <Card className="border-border bg-card">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <Car className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-lg">Résultats</CardTitle>
                <CardDescription>
                  Informations du véhicule
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* VIN Section */}
            <div className="space-y-2">
              <Label className="text-muted-foreground">VIN (Vehicle Identification Number)</Label>
              {vin ? (
                <div className="rounded-md bg-secondary p-3">
                  <p className="font-mono text-lg text-foreground">{vin}</p>
                </div>
              ) : (
                <div className="rounded-md border border-dashed border-border p-3 text-center">
                  <p className="text-sm text-muted-foreground">
                    Cliquez sur &quot;Récupérer VIN&quot; pour lire le numéro
                  </p>
                </div>
              )}
            </div>

            {/* DTC Section */}
            <div className="space-y-2">
              <Label className="text-muted-foreground">Codes défaut (DTC)</Label>
              {dtcCodes ? (
                dtcCodes.length > 0 ? (
                  <div className="space-y-2">
                    {dtcCodes.map((code) => (
                      <div
                        key={code}
                        className="flex items-center justify-between rounded-md bg-destructive/10 p-3"
                      >
                        <div className="flex items-center gap-3">
                          <AlertTriangle className="h-4 w-4 text-destructive" />
                          <span className="font-mono font-semibold text-destructive">
                            {code}
                          </span>
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {code === "P0300" && "Random/Multiple Cylinder Misfire"}
                          {code === "P0171" && "System Too Lean (Bank 1)"}
                          {code === "P0420" && "Catalyst System Efficiency Below Threshold"}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex items-center gap-3 rounded-md bg-success/10 p-3">
                    <div className="h-2 w-2 rounded-full bg-success" />
                    <span className="text-sm text-success">Aucun code défaut</span>
                  </div>
                )
              ) : (
                <div className="rounded-md border border-dashed border-border p-3 text-center">
                  <p className="text-sm text-muted-foreground">
                    Cliquez sur &quot;Lire DTC&quot; pour scanner les codes défaut
                  </p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  )
}
