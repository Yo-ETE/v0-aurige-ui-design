"use client"

import { useState } from "react"
import { AppShell } from "@/components/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Settings, Send, Power, PowerOff, CheckCircle2 } from "lucide-react"

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
  const [canInterface, setCanInterface] = useState("can0")
  const [bitrate, setBitrate] = useState("500000")
  const [isInitialized, setIsInitialized] = useState(false)
  const [canFrame, setCanFrame] = useState("")
  const [isSending, setIsSending] = useState(false)

  const handleInitialize = async () => {
    // Mock API call
    await new Promise((resolve) => setTimeout(resolve, 500))
    setIsInitialized(true)
  }

  const handleStop = async () => {
    await new Promise((resolve) => setTimeout(resolve, 300))
    setIsInitialized(false)
  }

  const handleSendFrame = async () => {
    if (!canFrame) return
    setIsSending(true)
    await new Promise((resolve) => setTimeout(resolve, 200))
    setIsSending(false)
    setCanFrame("")
  }

  return (
    <AppShell
      title="Contrôle CAN"
      description="Configuration et contrôle des interfaces CAN"
    >
      <div className="grid gap-6 lg:grid-cols-2">
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
                  onValueChange={setCanInterface}
                  disabled={isInitialized}
                >
                  <SelectTrigger id="interface">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="can0">can0</SelectItem>
                    <SelectItem value="can1">can1</SelectItem>
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

            {isInitialized && (
              <div className="flex items-center gap-2 rounded-md bg-success/10 px-4 py-3 text-sm text-success">
                <CheckCircle2 className="h-4 w-4" />
                <span>
                  Interface {canInterface} initialisée à{" "}
                  {bitrates.find((b) => b.value === bitrate)?.label}
                </span>
              </div>
            )}

            <div className="flex gap-3">
              <Button
                onClick={handleInitialize}
                disabled={isInitialized}
                className="flex-1 gap-2"
              >
                <Power className="h-4 w-4" />
                Initialiser
              </Button>
              <Button
                variant="destructive"
                onClick={handleStop}
                disabled={!isInitialized}
                className="flex-1 gap-2"
              >
                <PowerOff className="h-4 w-4" />
                Arrêter
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Card 2 - Envoi de trame */}
        <Card className="border-border bg-card">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <Send className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-lg">Envoi de trame</CardTitle>
                <CardDescription>
                  Envoyer une trame CAN manuellement
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="frame">Trame CAN (ID#DATA)</Label>
              <Input
                id="frame"
                placeholder="7DF#02010C"
                value={canFrame}
                onChange={(e) => setCanFrame(e.target.value)}
                className="font-mono"
                disabled={!isInitialized}
              />
              <p className="text-xs text-muted-foreground">
                Format: ID hexadécimal # données hexadécimales (ex: 7DF#02010C)
              </p>
            </div>

            <Button
              onClick={handleSendFrame}
              disabled={!isInitialized || !canFrame || isSending}
              className="w-full gap-2"
            >
              <Send className="h-4 w-4" />
              {isSending ? "Envoi en cours..." : "Envoyer"}
            </Button>

            {!isInitialized && (
              <p className="text-center text-sm text-muted-foreground">
                Initialisez l&apos;interface CAN pour envoyer des trames
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  )
}
