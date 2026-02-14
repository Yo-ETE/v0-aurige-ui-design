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
  
  // Bitrate scan - track per interface
  const [scanningInterfaces, setScanningInterfaces] = useState<Set<string>>(new Set())
  const [scanResults, setScanResults] = useState<Map<string, BitrateScanResponse>>(new Map())
  const [scanProgress, setScanProgress] = useState<Map<string, number>>(new Map())

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

  const handleScanBitrate = async (iface: "can0" | "can1") => {
    if (iface === "vcan0") {
      setError("Auto-detection impossible sur interface virtuelle")
      return
    }
    setError(null)
    setSuccess(null)
    
    // Add to scanning set
    setScanningInterfaces(prev => new Set([...prev, iface]))
    setScanProgress(prev => new Map(prev).set(iface, 0))
    
    // Simulate progress
    const progressInterval = setInterval(() => {
      setScanProgress(prev => {
        const updated = new Map(prev)
        const current = updated.get(iface) || 0
        updated.set(iface, Math.min(current + 1.5, 95))
        return updated
      })
    }, 200)
    
    try {
      const result = await scanBitrate(iface, 1.5)
      setScanResults(prev => new Map(prev).set(iface, result))
      setScanProgress(prev => {
        const updated = new Map(prev)
        updated.set(iface, 100)
        return updated
      })
      
      if (result.best_bitrate) {
        if (iface === canInterface) {
          setBitrate(result.best_bitrate.toString())
        }
        const bestLabel = result.results.find(r => r.bitrate === result.best_bitrate)?.bitrate_label
        setSuccess(`${iface}: Bitrate detecte - ${bestLabel} (${result.best_score}%)`)
      } else {
        setError(`${iface}: Aucun bitrate detecte`)
      }
    } catch (err) {
      setError(`${iface}: ${err instanceof Error ? err.message : "Erreur lors du scan"}`)
    } finally {
      clearInterval(progressInterval)
      setScanningInterfaces(prev => {
        const updated = new Set(prev)
        updated.delete(iface)
        return updated
      })
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
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Error/Success alerts */}
        {(error || success) && (
          <div className="lg:col-span-3">
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

        {/* CAN Interface Cards - one per interface */}
        {(["can0", "can1", "vcan0"] as const).map((iface) => (
          <Card key={iface} className="border-border bg-card">
            <CardHeader>
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
                  <Radio className="h-4 w-4 text-primary" />
                </div>
                <div>
                  <CardTitle className="text-base">{iface}</CardTitle>
                  <CardDescription className="text-[10px]">{iface === "vcan0" ? "Virtuelle (test)" : "Physique"}</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Interface select - for can0/can1 allow selection */}
              {iface !== "vcan0" && (
                <div className="space-y-2">
                  <Label className="text-xs">Débit (Bitrate)</Label>
                  <div className="flex gap-2">
                    <Select
                      value={iface === canInterface ? bitrate : "500000"}
                      onValueChange={(v) => {
                        if (iface === canInterface) setBitrate(v)
                      }}
                      disabled={scanningInterfaces.has(iface)}
                    >
                      <SelectTrigger className="h-8 text-xs flex-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {bitrates.map((rate) => (
                          <SelectItem key={rate.value} value={rate.value} className="text-xs">
                            {rate.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => handleScanBitrate(iface)}
                      disabled={scanningInterfaces.has(iface)}
                      className="h-8 w-8 bg-transparent shrink-0"
                      title="Auto-detect bitrate"
                    >
                      {scanningInterfaces.has(iface) ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Search className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                </div>
              )}

              {/* Scan progress */}
              {scanningInterfaces.has(iface) && (
                <div className="space-y-1">
                  <Progress value={scanProgress.get(iface) || 0} className="h-1.5" />
                  <p className="text-[10px] text-muted-foreground text-center">Scan en cours...</p>
                </div>
              )}

              {/* Scan result - best */}
              {scanResults.get(iface) && (
                <div className="space-y-2">
                  {scanResults.get(iface)!.best_bitrate && (
                    <div className="flex items-center gap-2 rounded bg-success/10 border border-success/30 p-2">
                      <Zap className="h-3.5 w-3.5 text-success shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-[10px] font-semibold text-success truncate">
                          {scanResults.get(iface)!.results.find(r => r.bitrate === scanResults.get(iface)!.best_bitrate)?.bitrate_label}
                        </p>
                        <p className="text-[9px] text-success/70">
                          Score {scanResults.get(iface)!.best_score}%
                        </p>
                      </div>
                      <Button
                        size="sm"
                        onClick={() => {
                          setCanInterface(iface)
                          if (scanResults.get(iface)!.best_bitrate) {
                            setBitrate(scanResults.get(iface)!.best_bitrate.toString())
                          }
                        }}
                        className="gap-1 h-7 px-2 text-[10px]"
                      >
                        Appliquer
                      </Button>
                    </div>
                  )}
                  
                  {!scanResults.get(iface)!.best_bitrate && (
                    <p className="text-[10px] text-muted-foreground text-center py-2">
                      Aucun trafic détecté
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Detailed Results Section */}
      {Array.from(scanResults.entries()).some(([_, result]) => result.best_bitrate) && (
        <Card className="border-border bg-card lg:col-span-3 mt-6">
          <CardHeader>
            <CardTitle className="text-lg">Résultats détaillés du scan</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-6">
              {Array.from(scanResults.entries()).map(([iface, result]) => (
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
        </Card>
      )}
    </AppShell>
  )
}
