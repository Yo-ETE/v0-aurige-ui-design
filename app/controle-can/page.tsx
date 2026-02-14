"use client"

import { useState, useEffect } from "react"
import { AppShell } from "@/components/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Settings, Power, PowerOff, CheckCircle2, AlertCircle, Loader2, Search, Zap, Signal, TriangleAlert, Radio, ChevronDown } from "lucide-react"
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
  
  // Bitrate scan - per interface tracking
  const [scanningInterfaces, setScanningInterfaces] = useState<string[]>([])
  const [scanResults, setScanResults] = useState<Record<string, BitrateScanResponse>>({})
  const [scanProgress, setScanProgress] = useState<Record<string, number>>({})
  
  // Detailed results toggle
  const [showDetailedResults, setShowDetailedResults] = useState(false)

  // Fetch CAN interface status
  const fetchStatus = async () => {
    try {
      const status = await getCANStatus(canInterface)
      setCanStatus(status)
      if (status.bitrate) {
        setBitrate(status.bitrate.toString())
      }
    } catch {
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
      setSuccess(`Interface ${canInterface} initialisee a ${bitrates.find(b => b.value === bitrate)?.label}`)
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
      setSuccess(`Interface ${canInterface} arretee`)
      await fetchStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur lors de l'arret")
    } finally {
      setIsStopping(false)
    }
  }

  const handleScanBitrate = async (iface: "can0" | "can1") => {
    setError(null)
    setSuccess(null)
    
    setScanningInterfaces(prev => [...prev, iface])
    setScanProgress(prev => ({ ...prev, [iface]: 0 }))
    
    const progressInterval = setInterval(() => {
      setScanProgress(prev => ({
        ...prev,
        [iface]: Math.min((prev[iface] || 0) + 1.5, 95)
      }))
    }, 200)
    
    try {
      const result = await scanBitrate(iface, 1.5)
      setScanResults(prev => ({ ...prev, [iface]: result }))
      setScanProgress(prev => ({ ...prev, [iface]: 100 }))
      
      if (result.best_bitrate) {
        if (iface === canInterface) {
          setBitrate(result.best_bitrate.toString())
        }
        const bestLabel = result.results.find(r => r.bitrate === result.best_bitrate)?.bitrate_label
        setSuccess(`${iface}: Bitrate detecte - ${bestLabel} (${result.best_score}%)`)
      } else {
        setError(`${iface}: Aucun bitrate detecte. Verifiez le cablage.`)
      }
    } catch (err) {
      setError(`${iface}: ${err instanceof Error ? err.message : "Erreur lors du scan"}`)
    } finally {
      clearInterval(progressInterval)
      setScanningInterfaces(prev => prev.filter(i => i !== iface))
    }
  }
  
  const getScoreBadge = (score: number) => {
    if (score >= 80) return "bg-success/20 text-success border-success/30"
    if (score >= 50) return "bg-amber-500/20 text-amber-500 border-amber-500/30"
    if (score > 0) return "bg-orange-500/20 text-orange-500 border-orange-500/30"
    return "bg-muted text-muted-foreground"
  }

  const isInitialized = canStatus?.up ?? false
  const hasAnyResults = Object.values(scanResults).some(r => r.best_bitrate)

  return (
    <AppShell
      title="Controle CAN"
      description="Configuration et controle des interfaces CAN"
    >
      {/* Error/Success alerts */}
      {(error || success) && (
        <div className="mb-6">
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

      {/* Initialisation CAN - main control */}
      <Card className="border-border bg-card mb-6">
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <Settings className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-lg">Initialisation CAN</CardTitle>
              <CardDescription>
                {"Configurer et demarrer l'interface CAN"}
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
              <Select
                value={bitrate}
                onValueChange={setBitrate}
                disabled={isInitialized}
              >
                <SelectTrigger id="bitrate">
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
                    {"Interface"} {canInterface} {"active a"}{" "}
                    {canStatus.bitrate 
                      ? bitrates.find((b) => parseInt(b.value) === canStatus.bitrate)?.label || `${canStatus.bitrate} bit/s`
                      : "bitrate inconnu"}
                  </span>
                </>
              ) : (
                <>
                  <PowerOff className="h-4 w-4" />
                  <span>{"Interface"} {canInterface} {"inactive"}</span>
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
              Arreter
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Scan Bitrate - can0 and can1 side by side */}
      <div className="grid gap-6 lg:grid-cols-2 mb-6">
        {(["can0", "can1"] as const).map((iface) => {
          const isScanning = scanningInterfaces.includes(iface)
          const result = scanResults[iface]
          const progress = scanProgress[iface] || 0
          
          return (
            <Card key={iface} className="border-border bg-card">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/10">
                      <Radio className="h-4 w-4 text-amber-500" />
                    </div>
                    <div>
                      <CardTitle className="text-base">Scan {iface}</CardTitle>
                      <CardDescription className="text-[10px]">Auto-detection bitrate</CardDescription>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleScanBitrate(iface)}
                    disabled={isScanning}
                    className="gap-2 bg-transparent"
                  >
                    {isScanning ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Search className="h-3.5 w-3.5" />
                    )}
                    {isScanning ? "Scan..." : "Scanner"}
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {/* Scan progress */}
                {isScanning && (
                  <div className="space-y-1">
                    <Progress value={progress} className="h-1.5" />
                    <p className="text-[10px] text-muted-foreground text-center">
                      Test des 8 bitrates standards...
                    </p>
                  </div>
                )}

                {/* Scan result */}
                {result && !isScanning && (
                  <div className="space-y-2">
                    {result.best_bitrate ? (
                      <div className="flex items-center gap-2 rounded bg-success/10 border border-success/30 p-3">
                        <Zap className="h-4 w-4 text-success shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-success">
                            {result.results.find(r => r.bitrate === result.best_bitrate)?.bitrate_label}
                          </p>
                          <p className="text-[10px] text-success/70">
                            Score {result.best_score}% - {(result.scan_duration_ms / 1000).toFixed(1)}s
                          </p>
                        </div>
                        <Button
                          size="sm"
                          onClick={() => {
                            setCanInterface(iface)
                            setBitrate(result.best_bitrate!.toString())
                          }}
                          className="gap-1 h-7 px-2 text-[10px]"
                        >
                          Appliquer
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 text-sm text-amber-500 bg-amber-500/10 rounded-md p-3">
                        <TriangleAlert className="h-4 w-4 shrink-0" />
                        <span className="text-xs">Aucun trafic CAN detecte.</span>
                      </div>
                    )}
                  </div>
                )}

                {/* No scan yet */}
                {!result && !isScanning && (
                  <p className="text-xs text-muted-foreground text-center py-4">
                    Cliquez sur Scanner pour detecter le bitrate
                  </p>
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>

      {/* Detailed Results Section - collapsible */}
      {hasAnyResults && (
        <Card className="border-border bg-card">
          <button
            onClick={() => setShowDetailedResults(!showDetailedResults)}
            className="w-full flex items-center justify-between p-4 hover:bg-secondary/30 transition-colors text-left"
          >
            <span className="text-sm font-semibold">Resultats detailles du scan</span>
            <ChevronDown className={`h-4 w-4 transition-transform ${showDetailedResults ? "rotate-180" : ""}`} />
          </button>
          {showDetailedResults && (
            <CardContent>
              <div className="space-y-6">
                {Object.entries(scanResults).map(([iface, result]) => (
                  <div key={iface}>
                    <h3 className="font-semibold text-sm mb-3">{iface}</h3>
                    <div className="rounded-md border border-border overflow-hidden">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-secondary text-muted-foreground">
                            <th className="p-2 text-left">Bitrate</th>
                            <th className="p-2 text-center">Trames</th>
                            <th className="p-2 text-center">IDs</th>
                            <th className="p-2 text-center">Erreurs</th>
                            <th className="p-2 text-right">Score</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.results.map((r) => (
                            <tr 
                              key={r.bitrate} 
                              className={`border-t border-border/50 ${r.bitrate === result.best_bitrate ? "bg-success/5" : ""}`}
                            >
                              <td className="p-2 font-mono font-medium">{r.bitrate_label}</td>
                              <td className="p-2 text-center">{r.frames_received}</td>
                              <td className="p-2 text-center">{r.unique_ids}</td>
                              <td className="p-2 text-center">{r.errors}</td>
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
                  </div>
                ))}
              </div>
            </CardContent>
          )}
        </Card>
      )}
    </AppShell>
  )
}
