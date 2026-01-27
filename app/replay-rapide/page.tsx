"use client"

import { useState } from "react"
import { AppShell } from "@/components/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Zap, Keyboard, Send, AlertTriangle, RotateCcw, Trash2 } from "lucide-react"

interface QuickSlot {
  key: string
  label: string
  frame: string
}

export default function ReplayRapide() {
  const [slots, setSlots] = useState<QuickSlot[]>([
    { key: "A", label: "A", frame: "7DF#02010C" },
    { key: "Z", label: "Z", frame: "7DF#02010D" },
    { key: "E", label: "E", frame: "7E0#0301000000000000" },
  ])
  const [keyboardEnabled, setKeyboardEnabled] = useState(false)
  const [burstId, setBurstId] = useState("7DF")
  const [burstData, setBurstData] = useState("02010C00000000")
  const [burstCount, setBurstCount] = useState("100")
  const [burstInterval, setBurstInterval] = useState("10")
  const [isBurstRunning, setIsBurstRunning] = useState(false)

  const handleSlotChange = (index: number, frame: string) => {
    const newSlots = [...slots]
    newSlots[index].frame = frame
    setSlots(newSlots)
  }

  const handleSendSlot = async (index: number) => {
    // Mock send
    console.log(`Sending slot ${slots[index].key}: ${slots[index].frame}`)
  }

  const handleBurstSend = async () => {
    setIsBurstRunning(true)
    await new Promise((resolve) => setTimeout(resolve, 2000))
    setIsBurstRunning(false)
  }

  const handleClearDTC = async () => {
    // Mock clear
    console.log("Clearing DTC codes")
  }

  const handleResetECU = async () => {
    // Mock reset
    console.log("Resetting ECU")
  }

  return (
    <AppShell
      title="Replay Rapide"
      description="Envoi rapide de trames CAN avec raccourcis clavier"
    >
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Quick Replay Slots Card */}
        <Card className="border-border bg-card">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                  <Zap className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <CardTitle className="text-lg">Quick Replay Slots</CardTitle>
                  <CardDescription>
                    Slots de trames à envoi rapide
                  </CardDescription>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Keyboard className="h-4 w-4 text-muted-foreground" />
                <Switch
                  checked={keyboardEnabled}
                  onCheckedChange={setKeyboardEnabled}
                />
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {slots.map((slot, index) => (
              <div key={slot.key} className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-secondary font-mono font-semibold text-foreground">
                  {slot.label}
                </div>
                <Input
                  value={slot.frame}
                  onChange={(e) => handleSlotChange(index, e.target.value)}
                  className="flex-1 font-mono"
                  placeholder="ID#DATA"
                />
                <Button
                  onClick={() => handleSendSlot(index)}
                  size="icon"
                  className="h-10 w-10"
                >
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            ))}
            {keyboardEnabled && (
              <p className="text-xs text-success">
                Raccourcis clavier activés - Appuyez sur A, Z ou E pour envoyer
              </p>
            )}
          </CardContent>
        </Card>

        {/* Diagnostic Functions Card */}
        <Card className="border-border bg-card">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <RotateCcw className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-lg">Fonctions Diagnostic</CardTitle>
                <CardDescription>
                  Actions OBD-II rapides
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button
              onClick={handleClearDTC}
              variant="outline"
              className="w-full justify-start gap-3 bg-transparent"
            >
              <Trash2 className="h-4 w-4" />
              Effacer les codes erreur (DTC)
            </Button>
            <Button
              onClick={handleResetECU}
              variant="destructive"
              className="w-full justify-start gap-3"
            >
              <RotateCcw className="h-4 w-4" />
              Reset ECU
            </Button>
            <Alert className="border-warning/50 bg-warning/10">
              <AlertTriangle className="h-4 w-4 text-warning" />
              <AlertTitle className="text-warning">Attention</AlertTitle>
              <AlertDescription className="text-warning/80">
                Le reset ECU peut affecter le fonctionnement du véhicule. 
                Utilisez uniquement sur un véhicule de test.
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>

        {/* Burst Send Card */}
        <Card className="border-border bg-card lg:col-span-2">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <Zap className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-lg">Burst Send</CardTitle>
                <CardDescription>
                  Envoi de multiples trames en rafale
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-2">
                <Label htmlFor="burst-id">CAN ID (hex)</Label>
                <Input
                  id="burst-id"
                  value={burstId}
                  onChange={(e) => setBurstId(e.target.value)}
                  className="font-mono"
                  placeholder="7DF"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="burst-data">Data (hex)</Label>
                <Input
                  id="burst-data"
                  value={burstData}
                  onChange={(e) => setBurstData(e.target.value)}
                  className="font-mono"
                  placeholder="02010C00000000"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="burst-count">Count</Label>
                <Input
                  id="burst-count"
                  type="number"
                  value={burstCount}
                  onChange={(e) => setBurstCount(e.target.value)}
                  max={1000}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="burst-interval">Interval (ms)</Label>
                <Input
                  id="burst-interval"
                  type="number"
                  value={burstInterval}
                  onChange={(e) => setBurstInterval(e.target.value)}
                />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Envoi de <span className="font-semibold text-foreground">{burstCount}</span> trames{" "}
                <span className="font-mono text-primary">{burstId}#{burstData}</span> avec un intervalle de{" "}
                <span className="font-semibold text-foreground">{burstInterval}ms</span>
              </p>
              <Button
                onClick={handleBurstSend}
                disabled={isBurstRunning}
                className="gap-2"
              >
                <Send className="h-4 w-4" />
                {isBurstRunning ? "Envoi en cours..." : `Envoyer ${burstCount} trames`}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  )
}
