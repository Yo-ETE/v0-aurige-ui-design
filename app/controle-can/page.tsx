"use client"

import { useState, useEffect } from "react"
import { AppShell } from "@/components/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Settings, Power, PowerOff, CheckCircle2, AlertCircle, Loader2, Search, Zap, Signal, TriangleAlert, Radio } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { initializeCAN, stopCAN, getCANStatus, scanBitrate, type CANInterfaceStatus, type BitrateScanResponse } from "@/lib/api"

const bitrates = [
  { value: "20000", label: "20 kbit/s" },
  { value: "50000", label: "50 kbit/s" },
  { value: "100000", label: "100 kbit/s" },
  { value: "125000", label: "125 kbit/s" },
  { value: "250000", label: "250 kbit/s" },
  { value: "500000", label: "500 kbit/s" },
  { value: "800000", label: "800 kbit/s" },
  { value: "1000000", label: "1 Mbit/s" },
]

export default function ControleCAN() {
  const [canInterface, setCanInterface] = useState<"can0" | "can1" | "vcan0">("can0")
  const [bitrate, setBitrate] = useState("500000")
  const [canStatus, setCanStatus] = useState<CANInterfaceStatus | null>(null)
  const [isInitializing, setIsInitializing] = useState(false)
  const [isStopping, setIsStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  
  // Bitrate scan
  const [isScanning, setIsScanning] = useState(false)
  const [scanResult, setScanResult] = useState<BitrateScanResponse | null>(null)
  const [scanProgress, setScanProgress] = useState(0)

  // Fetch CAN interface status
  const fetchStatus = async () => {
    try {
      const status = await getCANStatus(canInterface)
      setCanStatus(status)
      if (status.bitrate) {
        setBitrate(status.bitrate.toString())
      }
    } catch (err) {
      // Interface may not exist - this is OK
      setCanStatus(null)
    }
  }

  useEffect(() => {
    fetchStatus()
    const interval = setInterval(fetchStatus, 5000)
    return () => clearInterval(interval)
  }, [canInterface])

  const handleInitialize = async () => {
    setError(null)
    setSuccess(null)
    setIsInitializing(true)
    
    try {
      await initializeCAN(canInterface, parseInt(bitrate))
      setSuccess(`Interface ${canInterface} initialisée à ${bitrates.find(b => b.value === bitrate)?.label}`)
      await fetchStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur lors de l'initialisation")
    } finally {
      setIsInitializing(false)
    }
  }

  const handleStop = async () => {
    setError(null)
    setSuccess(null)
    setIsStopping(true)
    
    try {
      await stopCAN(canInterface)
      setSuccess(`Interface ${canInterface} arrêtée`)
      await fetchStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur lors de l'arrêt")
    } finally {
      setIsStopping(false)
    }
  }

  const handleScanBitrate = async () => {
    if (canInterface === "vcan0") {
      setError("Auto-detection impossible sur interface virtuelle")
      return
    }
    setError(null)
    setSuccess(null)
    setIsScanning(true)
    setScanResult(null)
    setScanProgress(0)
    
    // Simulate progress (scan takes ~15s for 8 bitrates)
    const progressInterval = setInterval(() => {
      setScanProgress(prev => Math.min(prev + 1.5, 95))
    }, 200)
    
    try {
      const result = await scanBitrate(canInterface as "can0" | "can1", 1.5)
      setScanResult(result)
      setScanProgress(100)
      
      if (result.best_bitrate) {
        setBitrate(result.best_bitrate.toString())
        setSuccess(`Bitrate detecte: ${result.results.find(r => r.bitrate === result.best_bitrate)?.bitrate_label} (score: ${result.best_score}%)`)
      } else {
        setError("Aucun bitrate detecte. Verifiez que le bus CAN est connecte et actif.")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur lors du scan")
    } finally {
      clearInterval(progressInterval)
      setIsScanning(false)
    }
  }
  
  const getScoreColor = (score: number) => {
    if (score >= 80) return "text-success"
    if (score >= 50) return "text-amber-500"
    if (score > 0) return "text-orange-500"
    return "text-muted-foreground"
  }
  
  const getScoreBadge = (score: number) => {
    if (score >= 80) return "bg-success/20 text-success border-success/30"
    if (score >= 50) return "bg-amber-500/20 text-amber-500 border-amber-500/30"
    if (score > 0) return "bg-orange-500/20 text-orange-500 border-orange-500/30"
    return "bg-muted text-muted-foreground"
  }

  const isInitialized = canStatus?.up ?? false

  return (
    <AppShell
      title="Contrôle CAN"
      description="Configuration et contrôle des interfaces CAN"
    >
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Error/Success alerts */}
        {(error || success) && (
          <div className="lg:col-span-2">
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
          </div>
        )}

        {/* Card 1 - Initialisation CAN */}
        <Card className="border-border bg-card">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <Settings className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-lg">Initialisation CAN</CardTitle>
                <CardDescription>
                  Configurer et démarrer l&apos;interface CAN
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="interface">Interface CAN</Label>
                <Select
                  value={canInterface}
                  onValueChange={(v) => setCanInterface(v as "can0" | "can1" | "vcan0")}
                  disabled={isInitialized}
                >
                  <SelectTrigger id="interface">
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
                <Label htmlFor="bitrate">Debit (Bitrate)</Label>
                <div className="flex gap-2">
                  <Select
                    value={bitrate}
                    onValueChange={setBitrate}
                    disabled={isInitialized || isScanning}
                  >
                    <SelectTrigger id="bitrate" className="flex-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {bitrates.map((rate) => (
                        <SelectItem key={rate.value} value={rate.value}>
                          {rate.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={handleScanBitrate}
                    disabled={isInitialized || isScanning || canInterface === "vcan0"}
                    title="Auto-detection du bitrate"
                    className="bg-transparent shrink-0"
                  >
                    {isScanning ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Search className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>
            </div>

            {/* Status display */}
            {canStatus && (
              <div className={`flex items-center gap-2 rounded-md px-4 py-3 text-sm ${
                isInitialized 
                  ? "bg-success/10 text-success" 
                  : "bg-muted text-muted-foreground"
              }`}>
                {isInitialized ? (
                  <>
                    <CheckCircle2 className="h-4 w-4" />
                    <span>
                      Interface {canInterface} active à{" "}
                      {canStatus.bitrate 
                        ? bitrates.find((b) => parseInt(b.value) === canStatus.bitrate)?.label || `${canStatus.bitrate} bit/s`
                        : "bitrate inconnu"}
                    </span>
                  </>
                ) : (
                  <>
                    <PowerOff className="h-4 w-4" />
                    <span>Interface {canInterface} inactive</span>
                  </>
                )}
              </div>
            )}

            {/* Stats if up */}
            {isInitialized && canStatus && (
              <div className="grid grid-cols-3 gap-4 text-center">
                <div className="rounded-lg bg-secondary p-3">
                  <p className="text-lg font-bold text-foreground">{canStatus.txPackets}</p>
                  <p className="text-xs text-muted-foreground">TX Packets</p>
                </div>
                <div className="rounded-lg bg-secondary p-3">
                  <p className="text-lg font-bold text-foreground">{canStatus.rxPackets}</p>
                  <p className="text-xs text-muted-foreground">RX Packets</p>
                </div>
                <div className="rounded-lg bg-secondary p-3">
                  <p className="text-lg font-bold text-foreground">{canStatus.errors}</p>
                  <p className="text-xs text-muted-foreground">Errors</p>
                </div>
              </div>
            )}

            <div className="flex gap-3">
              <Button
                onClick={handleInitialize}
                disabled={isInitialized || isInitializing}
                className="flex-1 gap-2"
              >
                {isInitializing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Power className="h-4 w-4" />
                )}
                Initialiser
              </Button>
              <Button
                variant="destructive"
                onClick={handleStop}
                disabled={!isInitialized || isStopping}
                className="flex-1 gap-2"
              >
                {isStopping ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <PowerOff className="h-4 w-4" />
                )}
                Arrêter
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Card 2 - Auto-detection results */}
        {(isScanning || scanResult) && (
          <Card className="border-border bg-card">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/10">
                  <Radio className="h-5 w-5 text-amber-500" />
                </div>
                <div>
                  <CardTitle className="text-lg">Auto-detection Bitrate</CardTitle>
                  <CardDescription>
                    {isScanning 
                      ? "Scan en cours... Ne debranchez pas le CAN."
                      : scanResult 
                        ? `Scan termine en ${(scanResult.scan_duration_ms / 1000).toFixed(1)}s`
                        : "Resultats du scan"}
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {isScanning && (
                <div className="space-y-2">
                  <Progress value={scanProgress} className="h-2" />
                  <p className="text-xs text-muted-foreground text-center">
                    Test des 8 bitrates standards...
                  </p>
                </div>
              )}
              
              {scanResult && (
                <div className="space-y-3">
                  {/* Best result highlight */}
                  {scanResult.best_bitrate && (
                    <div className="flex items-center gap-3 rounded-lg bg-success/10 border border-success/30 p-3">
                      <Zap className="h-5 w-5 text-success shrink-0" />
                      <div className="flex-1">
                        <p className="text-sm font-semibold text-success">
                          {scanResult.results.find(r => r.bitrate === scanResult.best_bitrate)?.bitrate_label}
                        </p>
                        <p className="text-xs text-success/80">
                          Score {scanResult.best_score}% - Detecte automatiquement
                        </p>
                      </div>
                      <Button
                        size="sm"
                        onClick={() => {
                          if (scanResult.best_bitrate) {
                            setBitrate(scanResult.best_bitrate.toString())
                          }
                        }}
                        className="gap-1"
                      >
                        <CheckCircle2 className="h-3 w-3" />
                        Appliquer
                      </Button>
                    </div>
                  )}
                  
                  {/* All results table */}
                  <div className="rounded-md border border-border overflow-hidden">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-secondary text-muted-foreground text-left">
                          <th className="p-2">Bitrate</th>
                          <th className="p-2 text-center">Trames</th>
                          <th className="p-2 text-center">IDs</th>
                          <th className="p-2 text-center">Erreurs</th>
                          <th className="p-2 text-right">Score</th>
                        </tr>
                      </thead>
                      <tbody>
                        {scanResult.results.map((r) => (
                          <tr 
                            key={r.bitrate} 
                            className={`border-t border-border/50 transition-colors cursor-pointer hover:bg-secondary/50 ${
                              r.bitrate === scanResult.best_bitrate ? "bg-success/5" : ""
                            }`}
                            onClick={() => setBitrate(r.bitrate.toString())}
                          >
                            <td className="p-2 font-mono font-medium">
                              <div className="flex items-center gap-2">
                                {r.bitrate === scanResult.best_bitrate && (
                                  <Zap className="h-3 w-3 text-success" />
                                )}
                                {r.bitrate_label}
                              </div>
                            </td>
                            <td className="p-2 text-center">
                              {r.frames_received > 0 ? (
                                <span className="text-success font-medium">{r.frames_received}</span>
                              ) : (
                                <span className="text-muted-foreground">0</span>
                              )}
                            </td>
                            <td className="p-2 text-center">
                              {r.unique_ids > 0 ? (
                                <span className="text-primary font-medium">{r.unique_ids}</span>
                              ) : (
                                <span className="text-muted-foreground">0</span>
                              )}
                            </td>
                            <td className="p-2 text-center">
                              {r.errors > 0 ? (
                                <span className="text-destructive">{r.errors}</span>
                              ) : (
                                <span className="text-muted-foreground">0</span>
                              )}
                            </td>
                            <td className="p-2 text-right">
                              <Badge variant="outline" className={getScoreBadge(r.score)}>
                                {r.score}%
                              </Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  
                  {!scanResult.best_bitrate && (
                    <div className="flex items-center gap-2 text-sm text-amber-500 bg-amber-500/10 rounded-md p-3">
                      <TriangleAlert className="h-4 w-4 shrink-0" />
                      <span>Aucun trafic CAN detecte. Verifiez le cablage et que le vehicule est sous contact.</span>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  )
}
