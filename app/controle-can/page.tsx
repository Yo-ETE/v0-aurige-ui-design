"use client"

import { useState, useEffect } from "react"
import { AppShell } from "@/components/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Settings, Power, PowerOff, CheckCircle2, AlertCircle, Loader2 } from "lucide-react"
import { initializeCAN, stopCAN, getCANStatus, type CANInterfaceStatus } from "@/lib/api"

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
                <Label htmlFor="bitrate">Débit (Bitrate)</Label>
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
      </div>
    </AppShell>
  )
}
