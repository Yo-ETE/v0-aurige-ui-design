"use client"

import { useState, useEffect, useCallback } from "react"
import { AppShell } from "@/components/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Zap, Keyboard, Send, AlertTriangle, Loader2 } from "lucide-react"
import { sendCANFrame } from "@/lib/api"
import { SentFramesHistory, useSentFramesHistory } from "@/components/sent-frames-history"

interface QuickSlot {
  key: string
  label: string
  id: string
  data: string
}

export default function ReplayRapide() {
  const [slots, setSlots] = useState<QuickSlot[]>([
    { key: "a", label: "A", id: "7DF", data: "02010C00000000" },
    { key: "z", label: "Z", id: "7DF", data: "02010D00000000" },
    { key: "e", label: "E", id: "7E0", data: "0301000000000000" },
  ])
  const [keyboardEnabled, setKeyboardEnabled] = useState(false)
  const [burstId, setBurstId] = useState("7DF")
  const [burstData, setBurstData] = useState("02010C00000000")
  const [burstCount, setBurstCount] = useState("100")
  const [burstInterval, setBurstInterval] = useState("10")
  const [isBurstRunning, setIsBurstRunning] = useState(false)
  const [isLoading, setIsLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  
  // Sent frames history
  const { frames, trackFrame, clearHistory } = useSentFramesHistory()

  const handleSlotChange = (index: number, field: "id" | "data", value: string) => {
    const newSlots = [...slots]
    newSlots[index][field] = value
    setSlots(newSlots)
  }

  const handleSendSlot = useCallback(async (index: number) => {
    const slot = slots[index]
    setError(null)
    setIsLoading(`slot-${index}`)
    
    await trackFrame(
      { canId: slot.id, data: slot.data, interface: "can0", description: `Slot ${slot.label}` },
      () => sendCANFrame({ interface: "can0", canId: slot.id, data: slot.data })
    )
    
    setIsLoading(null)
  }, [slots, trackFrame])

  // Keyboard shortcuts
  useEffect(() => {
    if (!keyboardEnabled) return

    const handleKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      const index = slots.findIndex((s) => s.key === key)
      if (index !== -1) {
        e.preventDefault()
        handleSendSlot(index)
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [keyboardEnabled, slots, handleSendSlot])

  const handleBurstSend = async () => {
    setIsBurstRunning(true)
    setError(null)
    try {
      const count = parseInt(burstCount, 10)
      const interval = parseInt(burstInterval, 10)
      
      for (let i = 0; i < count; i++) {
        await trackFrame(
          { canId: burstId, data: burstData, interface: "can0", description: `Burst ${i + 1}/${count}` },
          () => sendCANFrame({ interface: "can0", canId: burstId, data: burstData })
        )
        if (interval > 0 && i < count - 1) {
          await new Promise((resolve) => setTimeout(resolve, interval))
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur lors du burst")
    } finally {
      setIsBurstRunning(false)
    }
  }

  return (
    <AppShell
      title="Replay Rapide"
      description="Envoi rapide de trames CAN avec raccourcis clavier"
    >
      <div className="grid gap-6 lg:grid-cols-2">
        {error && (
          <Alert className="lg:col-span-2 border-destructive/50 bg-destructive/10">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            <AlertDescription className="text-destructive">{error}</AlertDescription>
          </Alert>
        )}

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
                    Slots de trames a envoi rapide
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
              <div key={slot.key} className="flex items-center gap-2">
                <div className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-secondary font-mono font-semibold text-foreground">
                  {slot.label}
                </div>
                <Input
                  value={slot.id}
                  onChange={(e) => handleSlotChange(index, "id", e.target.value)}
                  className="w-20 font-mono"
                  placeholder="ID"
                />
                <Input
                  value={slot.data}
                  onChange={(e) => handleSlotChange(index, "data", e.target.value)}
                  className="flex-1 font-mono"
                  placeholder="DATA"
                />
                <Button
                  onClick={() => handleSendSlot(index)}
                  disabled={isLoading !== null}
                  size="icon"
                  className="h-10 w-10"
                >
                  {isLoading === `slot-${index}` ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </Button>
              </div>
            ))}
            {keyboardEnabled && (
              <p className="text-xs text-success">
                Raccourcis clavier actives - Appuyez sur A, Z ou E pour envoyer
              </p>
            )}
          </CardContent>
        </Card>

        {/* Burst Send Card */}
        <Card className="border-border bg-card">
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
            <div className="grid gap-4 sm:grid-cols-2">
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
            <Button
              onClick={handleBurstSend}
              disabled={isBurstRunning || isLoading !== null}
              className="w-full gap-2"
            >
              {isBurstRunning ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              {isBurstRunning ? "Envoi en cours..." : `Envoyer ${burstCount} trames`}
            </Button>
          </CardContent>
        </Card>

        {/* Sent Frames History */}
        <SentFramesHistory frames={frames} onClear={clearHistory} />
      </div>
    </AppShell>
  )
}
