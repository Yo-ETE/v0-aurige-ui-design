"use client"

import { useState, useCallback } from "react"
import { AppShell } from "@/components/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Activity, Car, AlertTriangle, Trash2, RotateCcw, Info, Loader2, Search,
  Download, Save, FileJson, FileSpreadsheet, Copy, CheckCircle2
} from "lucide-react"
import {
  requestVIN, readDTCs, clearDTCs, resetECU, fullOBDScan,
  type OBDResponse, type FullScanResponse
} from "@/lib/api"
import { SentFramesHistory, useSentFramesHistory } from "@/components/sent-frames-history"
import { useMissionStore } from "@/lib/mission-store"

// ============================================================================
// VIN Decoder utility
// ============================================================================

interface VINInfo {
  wmi: string
  region: string
  country: string
  manufacturer: string
  vds: string
  modelYear: string
  plant: string
  serial: string
}

function decodeVIN(vin: string): VINInfo | null {
  if (!vin || vin.length !== 17) return null

  const wmi = vin.substring(0, 3)
  const vds = vin.substring(3, 9)
  const yearChar = vin.charAt(9)
  const plant = vin.charAt(10)
  const serial = vin.substring(11)

  // Region from first char
  const regionMap: Record<string, string> = {
    "1": "Amerique du Nord", "2": "Canada", "3": "Mexique",
    "4": "Etats-Unis", "5": "Etats-Unis",
    "J": "Japon", "K": "Coree du Sud", "L": "Chine",
    "S": "Royaume-Uni", "V": "France", "W": "Allemagne",
    "Z": "Italie", "Y": "Suede/Finlande",
  }

  // Manufacturer from WMI
  const mfgMap: Record<string, string> = {
    "VF1": "Renault", "VF3": "Peugeot", "VF7": "Citroen",
    "WBA": "BMW", "WBS": "BMW M", "WDB": "Mercedes-Benz",
    "WDD": "Mercedes-Benz", "WF0": "Ford Europe",
    "WVW": "Volkswagen", "WAU": "Audi", "WP0": "Porsche",
    "ZFA": "Fiat", "ZAR": "Alfa Romeo", "ZLA": "Lancia",
    "JTD": "Toyota", "JHM": "Honda", "JN1": "Nissan",
    "1G1": "Chevrolet", "1FA": "Ford", "1HG": "Honda US",
    "2HM": "Hyundai Canada", "5YJ": "Tesla", "KMH": "Hyundai",
    "VF8": "Dacia", "VNK": "Toyota Europe",
    "TMB": "Skoda", "VSS": "SEAT", "SJN": "Nissan UK",
  }

  // Year from char
  const yearMap: Record<string, string> = {
    "A": "2010", "B": "2011", "C": "2012", "D": "2013", "E": "2014",
    "F": "2015", "G": "2016", "H": "2017", "J": "2018", "K": "2019",
    "L": "2020", "M": "2021", "N": "2022", "P": "2023", "R": "2024",
    "S": "2025", "T": "2026", "V": "2027", "W": "2028", "X": "2029",
    "Y": "2030", "1": "2001", "2": "2002", "3": "2003", "4": "2004",
    "5": "2005", "6": "2006", "7": "2007", "8": "2008", "9": "2009",
  }

  const firstChar = vin.charAt(0)
  const region = regionMap[firstChar] || "Inconnu"

  // Country detection
  let country = "Inconnu"
  if (firstChar === "V" && vin.charAt(1) === "F") country = "France"
  else if (firstChar === "W") country = "Allemagne"
  else if (firstChar === "Z") country = "Italie"
  else if (firstChar === "S") country = "Royaume-Uni"
  else if (firstChar === "J") country = "Japon"
  else if (firstChar === "K") country = "Coree du Sud"
  else if (firstChar === "L") country = "Chine"
  else if (firstChar === "1" || firstChar === "4" || firstChar === "5") country = "Etats-Unis"
  else if (firstChar === "2") country = "Canada"
  else if (firstChar === "3") country = "Mexique"
  else if (firstChar === "Y") country = "Suede/Finlande"

  const manufacturer = mfgMap[wmi] || `Inconnu (${wmi})`
  const modelYear = yearMap[yearChar] || `Inconnu (${yearChar})`

  return { wmi, region, country, manufacturer, vds, modelYear, plant, serial }
}

// ============================================================================
// OBD PID definitions for human-readable display
// ============================================================================

const PID_DESCRIPTIONS: Record<string, string> = {
  "0100": "PIDs supportes [01-20]",
  "0101": "Statut moniteurs depuis effacement DTC",
  "0103": "Etat du systeme de carburant",
  "0104": "Charge calculee du moteur",
  "0105": "Temperature liquide refroidissement",
  "0106": "Correction carburant court terme (banc 1)",
  "0107": "Correction carburant long terme (banc 1)",
  "010B": "Pression absolue collecteur admission",
  "010C": "Regime moteur (RPM)",
  "010D": "Vitesse vehicule",
  "010E": "Avance a l'allumage",
  "010F": "Temperature air admission",
  "0110": "Debit d'air MAF",
  "0111": "Position papillon",
  "011C": "Standard OBD supporte",
  "011F": "Temps depuis demarrage moteur",
  "0120": "PIDs supportes [21-40]",
  "0140": "PIDs supportes [41-60]",
  "0142": "Tension module controle",
  "0145": "Position papillon relative",
  "0146": "Temperature air ambiant",
  "014C": "Avance allumage commandee",
  "0151": "Type de carburant",
  "0160": "PIDs supportes [61-80]",
}

// ============================================================================
// DTC code descriptions
// ============================================================================

const DTC_DESCRIPTIONS: Record<string, string> = {
  // Common Powertrain codes
  "P0100": "Debit d'air massique - Dysfonctionnement",
  "P0101": "Debit d'air massique - Plage/Performance",
  "P0102": "Debit d'air massique - Entree basse",
  "P0103": "Debit d'air massique - Entree haute",
  "P0110": "Temperature air admission - Dysfonctionnement",
  "P0115": "Temperature liquide refroidissement - Dysfonctionnement",
  "P0120": "Capteur position papillon - Dysfonctionnement",
  "P0130": "Sonde O2 (banc 1, capteur 1) - Dysfonctionnement",
  "P0133": "Sonde O2 (banc 1, capteur 1) - Reponse lente",
  "P0171": "Systeme trop pauvre (banc 1)",
  "P0172": "Systeme trop riche (banc 1)",
  "P0300": "Rates d'allumage detectes - Cylindres multiples",
  "P0301": "Rate d'allumage - Cylindre 1",
  "P0302": "Rate d'allumage - Cylindre 2",
  "P0303": "Rate d'allumage - Cylindre 3",
  "P0304": "Rate d'allumage - Cylindre 4",
  "P0325": "Capteur de cliquetis 1 - Dysfonctionnement",
  "P0335": "Capteur position vilebrequin A - Dysfonctionnement",
  "P0340": "Capteur position arbre a cames A - Dysfonctionnement",
  "P0401": "EGR - Debit insuffisant",
  "P0420": "Catalyseur - Efficacite insuffisante (banc 1)",
  "P0440": "Systeme EVAP - Dysfonctionnement",
  "P0442": "Systeme EVAP - Petite fuite detectee",
  "P0446": "Systeme EVAP - Controle purge - Dysfonctionnement",
  "P0455": "Systeme EVAP - Grosse fuite detectee",
  "P0500": "Capteur vitesse vehicule - Dysfonctionnement",
  "P0505": "Controle ralenti - Dysfonctionnement",
  "P0507": "Controle ralenti - Regime superieur",
  "P0562": "Tension systeme - Basse",
  "P0563": "Tension systeme - Haute",
  // Common Chassis codes
  "C0035": "Capteur vitesse roue AV gauche - Dysfonctionnement",
  "C0040": "Capteur vitesse roue AV droite - Dysfonctionnement",
  "C0045": "Capteur vitesse roue AR gauche - Dysfonctionnement",
  "C0050": "Capteur vitesse roue AR droite - Dysfonctionnement",
  // Common Body codes
  "B0001": "Module commande eclairage - Court-circuit",
  "B1000": "Memoire defaut ECU - Dysfonctionnement interne",
}

function getDTCDescription(code: string): string {
  return DTC_DESCRIPTIONS[code.toUpperCase()] || ""
}

function getDTCCategory(code: string): string {
  const prefix = code.charAt(0).toUpperCase()
  switch (prefix) {
    case "P": return "Powertrain"
    case "C": return "Chassis"
    case "B": return "Body"
    case "U": return "Network"
    default: return "Inconnu"
  }
}

function getDTCColor(code: string): string {
  const prefix = code.charAt(0).toUpperCase()
  switch (prefix) {
    case "P": return "bg-destructive text-destructive-foreground"
    case "C": return "bg-warning text-warning-foreground"
    case "B": return "bg-primary text-primary-foreground"
    case "U": return "bg-muted text-muted-foreground"
    default: return "bg-muted text-muted-foreground"
  }
}

// ============================================================================
// Export utilities
// ============================================================================

interface OBDExportData {
  timestamp: string
  interface: string
  vin: string | null
  vinDecoded: VINInfo | null
  pids: { raw: string; description: string }[]
  dtcs: string[]
  scanDuration?: string
}

function buildExportData(
  canInterface: string,
  vin: string | null,
  scanResult: FullScanResponse | null,
  dtcCodes: string[] | null
): OBDExportData {
  const vinInfo = vin ? decodeVIN(vin) : null
  const pids = (scanResult?.results?.pids || []).map((raw) => {
    const pidKey = raw.substring(0, 4).toUpperCase()
    return { raw, description: PID_DESCRIPTIONS[pidKey] || "" }
  })
  return {
    timestamp: new Date().toISOString(),
    interface: canInterface,
    vin,
    vinDecoded: vinInfo,
    pids,
    dtcs: dtcCodes || scanResult?.results?.dtcs || [],
    scanDuration: scanResult?.message,
  }
}

function exportJSON(data: OBDExportData) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `obd-scan-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  a.click()
  URL.revokeObjectURL(url)
}

function exportCSV(data: OBDExportData) {
  const rows: string[][] = []
  rows.push(["Type", "Cle", "Valeur"])
  rows.push(["Info", "Date", data.timestamp])
  rows.push(["Info", "Interface", data.interface])
  if (data.vin) {
    rows.push(["VIN", "Raw", data.vin])
    if (data.vinDecoded) {
      rows.push(["VIN", "Constructeur", data.vinDecoded.manufacturer])
      rows.push(["VIN", "Pays", data.vinDecoded.country])
      rows.push(["VIN", "Annee modele", data.vinDecoded.modelYear])
      rows.push(["VIN", "WMI", data.vinDecoded.wmi])
      rows.push(["VIN", "VDS", data.vinDecoded.vds])
      rows.push(["VIN", "Usine", data.vinDecoded.plant])
      rows.push(["VIN", "Numero serie", data.vinDecoded.serial])
    }
  }
  data.pids.forEach((pid) => {
    rows.push(["PID", pid.raw, pid.description])
  })
  data.dtcs.forEach((dtc) => {
    rows.push(["DTC", dtc, ""])
  })

  const csv = rows.map((r) => r.map((c) => `"${c}"`).join(",")).join("\n")
  const blob = new Blob([csv], { type: "text/csv" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `obd-scan-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// ============================================================================
// Page Component
// ============================================================================

export default function OBDII() {
  const [canInterface, setCanInterface] = useState<"can0" | "can1" | "vcan0">("can0")
  const [isLoading, setIsLoading] = useState<string | null>(null)
  const [vin, setVin] = useState<string | null>(null)
  const [dtcCodes, setDtcCodes] = useState<string[] | null>(null)
  const [lastResponse, setLastResponse] = useState<OBDResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scanResult, setScanResult] = useState<FullScanResponse | null>(null)
  const [vinSaved, setVinSaved] = useState(false)
  const [copied, setCopied] = useState(false)

  const { frames, trackFrame, clearHistory } = useSentFramesHistory()
  const { getCurrentMission, updateMissionVehicle } = useMissionStore()
  const currentMission = getCurrentMission()

  const vinInfo = vin ? decodeVIN(vin) : null

  const handleCopyVIN = useCallback(() => {
    if (vin) {
      navigator.clipboard.writeText(vin)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }, [vin])

  const handleSaveVINToMission = useCallback(async () => {
    if (!vin || !currentMission) return
    const updatedVehicle = { ...currentMission.vehicle, vin }
    await updateMissionVehicle(currentMission.id, updatedVehicle)
    setVinSaved(true)
  }, [vin, currentMission, updateMissionVehicle])

  const handleRetrieveVIN = async () => {
    setIsLoading("vin")
    setError(null)
    setVinSaved(false)
    try {
      await trackFrame(
        { canId: "7DF", data: "0902", interface: canInterface, description: "Request VIN" },
        async () => {
          const response = await requestVIN(canInterface)
          setLastResponse(response)
          if (response.status === "error") throw new Error(response.message || "Erreur d'envoi")
          if (response.data) setVin(response.data)
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
          if (response.status === "error") throw new Error(response.message || "Erreur d'envoi")
          if (response.data) {
            const codes = response.data.split(",").map((c) => c.trim()).filter(Boolean)
            setDtcCodes(codes)
          } else {
            setDtcCodes([])
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
          if (response.status === "error") throw new Error(response.message || "Erreur d'envoi")
          setDtcCodes([])
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
          if (response.status === "error") throw new Error(response.message || "Erreur d'envoi")
          setVin(null)
          setDtcCodes(null)
          setScanResult(null)
          setVinSaved(false)
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
    setVinSaved(false)
    try {
      await trackFrame(
        { canId: "7DF", data: "SCAN", interface: canInterface, description: "Full OBD Scan (VIN + PIDs + DTCs)" },
        async () => {
          const result = await fullOBDScan(canInterface)
          if (result.status === "error") throw new Error(result.message || "Erreur lors du scan")
          setScanResult(result)
          if (result.results?.vin && result.results.vin.length > 0) {
            setVin(result.results.vin[0])
          }
          if (result.results?.dtcs) {
            setDtcCodes(result.results.dtcs)
          }
        }
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur lors du scan complet")
    } finally {
      setIsLoading(null)
    }
  }

  const handleExport = (format: "json" | "csv") => {
    const data = buildExportData(canInterface, vin, scanResult, dtcCodes)
    if (format === "json") exportJSON(data)
    else exportCSV(data)
  }

  const hasData = vin || scanResult || (dtcCodes && dtcCodes.length > 0)

  return (
    <AppShell title="OBD-II" description="Diagnostic OBD-II du vehicule">
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
                Assurez-vous que l{"'"}interface CAN est initialisee avec le bon bitrate.
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

            {/* Export buttons */}
            {hasData && (
              <div className="flex gap-2 pt-2 border-t border-border">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleExport("json")}
                  className="flex-1 gap-2 bg-transparent"
                >
                  <FileJson className="h-3.5 w-3.5" />
                  Export JSON
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleExport("csv")}
                  className="flex-1 gap-2 bg-transparent"
                >
                  <FileSpreadsheet className="h-3.5 w-3.5" />
                  Export CSV
                </Button>
              </div>
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
            <CardDescription>Recuperation et decodage du VIN via OBD-II</CardDescription>
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
              <div className="space-y-3">
                {/* VIN raw */}
                <div className="rounded-lg border border-success/30 bg-success/10 p-4">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-muted-foreground">VIN detecte</Label>
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="sm" onClick={handleCopyVIN} className="h-6 px-2">
                        {copied ? <CheckCircle2 className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
                      </Button>
                    </div>
                  </div>
                  <p className="font-mono text-lg font-bold text-success tracking-wider">{vin}</p>
                </div>

                {/* VIN decoded */}
                {vinInfo && (
                  <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
                    <Label className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">
                      Decodage VIN
                    </Label>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <span className="text-xs text-muted-foreground">Constructeur</span>
                        <p className="font-medium text-foreground">{vinInfo.manufacturer}</p>
                      </div>
                      <div>
                        <span className="text-xs text-muted-foreground">Pays</span>
                        <p className="font-medium text-foreground">{vinInfo.country}</p>
                      </div>
                      <div>
                        <span className="text-xs text-muted-foreground">Annee modele</span>
                        <p className="font-medium text-foreground">{vinInfo.modelYear}</p>
                      </div>
                      <div>
                        <span className="text-xs text-muted-foreground">Region</span>
                        <p className="font-medium text-foreground">{vinInfo.region}</p>
                      </div>
                      <div>
                        <span className="text-xs text-muted-foreground">WMI</span>
                        <p className="font-mono text-foreground">{vinInfo.wmi}</p>
                      </div>
                      <div>
                        <span className="text-xs text-muted-foreground">VDS</span>
                        <p className="font-mono text-foreground">{vinInfo.vds}</p>
                      </div>
                      <div>
                        <span className="text-xs text-muted-foreground">Code usine</span>
                        <p className="font-mono text-foreground">{vinInfo.plant}</p>
                      </div>
                      <div>
                        <span className="text-xs text-muted-foreground">Numero serie</span>
                        <p className="font-mono text-foreground">{vinInfo.serial}</p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Save to mission */}
                {currentMission && (
                  <Button
                    variant="outline"
                    onClick={handleSaveVINToMission}
                    disabled={vinSaved}
                    className="w-full gap-2"
                  >
                    {vinSaved ? (
                      <>
                        <CheckCircle2 className="h-4 w-4 text-success" />
                        VIN sauvegarde dans {currentMission.name}
                      </>
                    ) : (
                      <>
                        <Save className="h-4 w-4" />
                        Sauvegarder dans la mission: {currentMission.name}
                      </>
                    )}
                  </Button>
                )}
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
                  <div className="space-y-3">
                    <Label className="text-xs text-muted-foreground">
                      {dtcCodes.length} code(s) detecte(s)
                    </Label>
                    <div className="space-y-2">
                      {dtcCodes.map((code) => {
                        const desc = getDTCDescription(code)
                        const cat = getDTCCategory(code)
                        return (
                          <div key={code} className="flex items-center gap-3 rounded-lg border border-border/50 bg-background/30 p-2.5">
                            <Badge className={`font-mono text-sm px-2 py-1 ${getDTCColor(code)}`}>
                              {code}
                            </Badge>
                            <div className="flex-1 min-w-0">
                              {desc ? (
                                <p className="text-sm text-foreground truncate">{desc}</p>
                              ) : (
                                <p className="text-sm text-muted-foreground italic">Description non disponible</p>
                              )}
                              <p className="text-[10px] text-muted-foreground/60">{cat}</p>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            <Alert className="border-warning/50 bg-warning/10">
              <AlertTriangle className="h-4 w-4 text-warning" />
              <AlertDescription className="text-warning text-xs">
                L{"'"}effacement des DTC supprime egalement les donnees de freeze frame.
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
                Ne pas utiliser pendant la conduite. Le vehicule doit etre a l{"'"}arret,
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
              Recupere VIN, scanne les PIDs et lit les DTCs
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
              <div className="space-y-4">
                {/* Summary */}
                <div className="rounded-lg border border-success/30 bg-success/10 p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Activity className="h-5 w-5 text-success" />
                      <span className="font-semibold text-success">Scan termine</span>
                    </div>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="sm" onClick={() => handleExport("json")} className="h-7 gap-1 text-xs">
                        <FileJson className="h-3 w-3" /> JSON
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => handleExport("csv")} className="h-7 gap-1 text-xs">
                        <FileSpreadsheet className="h-3 w-3" /> CSV
                      </Button>
                    </div>
                  </div>

                  <div className="grid gap-4 md:grid-cols-3 mt-3">
                    <div className="rounded bg-background/50 p-3">
                      <Label className="text-xs text-muted-foreground">VIN</Label>
                      <p className="font-mono text-sm">
                        {scanResult.results.vin?.length ? scanResult.results.vin[0] : "Non detecte"}
                      </p>
                    </div>
                    <div className="rounded bg-background/50 p-3">
                      <Label className="text-xs text-muted-foreground">PIDs</Label>
                      <p className="font-mono text-sm">{scanResult.results.pids.length} reponses</p>
                    </div>
                    <div className="rounded bg-background/50 p-3">
                      <Label className="text-xs text-muted-foreground">DTCs</Label>
                      <p className="font-mono text-sm">{scanResult.results.dtcs.length} code(s)</p>
                    </div>
                  </div>
                </div>

                {/* PID Results */}
                {scanResult.results.pids.length > 0 && (
                  <div className="rounded-lg border border-border bg-muted/20 p-4">
                    <Label className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">
                      Reponses PID ({scanResult.results.pids.length})
                    </Label>
                    <ScrollArea className="h-48 mt-2">
                      <div className="space-y-1">
                        {scanResult.results.pids.map((pid, i) => {
                          const pidKey = pid.substring(0, 4).toUpperCase()
                          const desc = PID_DESCRIPTIONS[pidKey]
                          return (
                            <div
                              key={i}
                              className="flex items-center gap-3 rounded border border-border/50 bg-background/30 px-3 py-1.5 font-mono text-xs"
                            >
                              <span className="text-primary font-semibold w-12">{pidKey}</span>
                              <span className="text-foreground flex-1">{pid}</span>
                              {desc && (
                                <span className="text-muted-foreground text-[10px] truncate max-w-48">
                                  {desc}
                                </span>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </ScrollArea>
                  </div>
                )}

                {/* DTC Results from scan */}
                {scanResult.results.dtcs.length > 0 && (
                  <div className="rounded-lg border border-warning/30 bg-warning/10 p-4">
                    <Label className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">
                      Codes defaut ({scanResult.results.dtcs.length})
                    </Label>
                    <div className="space-y-2 mt-2">
                      {scanResult.results.dtcs.map((dtc) => {
                        const desc = getDTCDescription(dtc)
                        const cat = getDTCCategory(dtc)
                        return (
                          <div key={dtc} className="flex items-center gap-3 rounded border border-border/50 bg-background/30 p-2">
                            <Badge className={`font-mono text-sm px-2 py-1 ${getDTCColor(dtc)}`}>
                              {dtc}
                            </Badge>
                            <div className="flex-1 min-w-0">
                              {desc ? (
                                <p className="text-sm text-foreground truncate">{desc}</p>
                              ) : (
                                <p className="text-sm text-muted-foreground italic">Description non disponible</p>
                              )}
                              <p className="text-[10px] text-muted-foreground/60">{cat}</p>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {scanResult.results.logFile && (
                  <p className="text-xs text-muted-foreground">
                    Log: <code className="bg-muted px-1 rounded">{scanResult.results.logFile}</code>
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
