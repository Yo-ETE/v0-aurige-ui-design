"use client"

import { useState, useEffect, useCallback } from "react"
import { AppShell } from "@/components/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Zap, Keyboard, Send, AlertTriangle, Loader2, Import, Trash2, Play } from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ScrollArea } from "@/components/ui/scroll-area"
import { sendCANFrame, type CANInterface } from "@/lib/api"
import { SentFramesHistory, useSentFramesHistory } from "@/components/sent-frames-history"
import { useExportStore } from "@/lib/export-store"

interface QuickSlot {
  key: string
  label: string
  id: string
  data: string
}

export default function ReplayRapide() {
  const [canInterface, setCanInterface] = useState<CANInterface>("can0")
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
  const [manualFrame, setManualFrame] = useState("")
  const [isSendingManual, setIsSendingManual] = useState(false)
  
  // Sent frames history
  const { frames, trackFrame, clearHistory } = useSentFramesHistory()
  
  // Exported frames from isolation
  const { frames: exportedFrames, clearFrames: clearExported, removeFrame: removeExportedFrame } = useExportStore()
  const [isReplayingExported, setIsReplayingExported] = useState(false)

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
      { canId: slot.id, data: slot.data, interface: canInterface, description: `Slot ${slot.label}` },
      () => sendCANFrame({ interface: canInterface, canId: slot.id, data: slot.data })
    )
    
    setIsLoading(null)
  }, [slots, trackFrame, canInterface])

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
          { canId: burstId, data: burstData, interface: canInterface, description: `Burst ${i + 1}/${count}` },
          () => sendCANFrame({ interface: canInterface, canId: burstId, data: burstData })
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

  const handleManualSend = async () => {
    if (!manualFrame) return
    setError(null)
    setIsSendingManual(true)
    
    try {
      const [canId, data] = manualFrame.split("#")
      if (!canId || !data) {
        throw new Error("Format invalide. Utilisez: ID#DATA (ex: 7DF#02010C)")
      }
      
      await trackFrame(
        { canId: canId.trim(), data: data.trim(), interface: canInterface, description: "Envoi manuel" },
        () => sendCANFrame({ interface: canInterface, canId: canId.trim(), data: data.trim() })
      )
      setManualFrame("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur lors de l'envoi")
    } finally {
      setIsSendingManual(false)
    }
  }

  const handleReplayExported = async () => {
    setIsReplayingExported(true)
    setError(null)
    try {
      for (let i = 0; i < exportedFrames.length; i++) {
        const frame = exportedFrames[i]
        await trackFrame(
          { canId: frame.canId, data: frame.data, interface: canInterface, description: `Export ${i + 1}/${exportedFrames.length}` },
          () => sendCANFrame({ interface: canInterface, canId: frame.canId, data: frame.data })
        )
        // Small delay between frames
        if (i < exportedFrames.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 10))
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur lors du replay")
    } finally {
      setIsReplayingExported(false)
    }
  }

  const handleSendExportedFrame = async (index: number) => {
    const frame = exportedFrames[index]
    setError(null)
    try {
      await trackFrame(
        { canId: frame.canId, data: frame.data, interface: canInterface, description: `Trame isolee` },
        () => sendCANFrame({ interface: canInterface, canId: frame.canId, data: frame.data })
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur lors de l'envoi")
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

        {/* Interface Selector */}
        <Card className="lg:col-span-2 border-border bg-card">
          <CardContent className="py-4">
            <div className="flex items-center gap-4">
              <Label htmlFor="can-interface" className="whitespace-nowrap">Interface CAN:</Label>
              <Select
                value={canInterface}
                onValueChange={(v) => setCanInterface(v as CANInterface)}
              >
                <SelectTrigger id="can-interface" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="can0">can0</SelectItem>
                  <SelectItem value="can1">can1</SelectItem>
                  <SelectItem value="vcan0">vcan0 (test)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

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

        {/* Manual Send Card */}
        <Card className="border-border bg-card">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <Send className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-lg">Envoi manuel</CardTitle>
                <CardDescription>
                  Envoyer une trame CAN manuellement
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="manual-frame">Trame CAN (ID#DATA)</Label>
              <Input
                id="manual-frame"
                placeholder="7DF#02010C"
                value={manualFrame}
                onChange={(e) => setManualFrame(e.target.value.toUpperCase())}
                className="font-mono"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && manualFrame) {
                    handleManualSend()
                  }
                }}
              />
              <p className="text-xs text-muted-foreground">
                Format: ID hexadecimal # donnees hexadecimales
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" className="font-mono text-xs" onClick={() => setManualFrame("7DF#0100")}>
                PIDs supportes
              </Button>
              <Button size="sm" variant="outline" className="font-mono text-xs" onClick={() => setManualFrame("7DF#02010C")}>
                RPM
              </Button>
              <Button size="sm" variant="outline" className="font-mono text-xs" onClick={() => setManualFrame("7DF#02010D")}>
                Vitesse
              </Button>
              <Button size="sm" variant="outline" className="font-mono text-xs" onClick={() => setManualFrame("7DF#020105")}>
                Temp. moteur
              </Button>
            </div>

            <Button
              onClick={handleManualSend}
              disabled={!manualFrame || isSendingManual}
              className="w-full gap-2"
            >
              {isSendingManual ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              {isSendingManual ? "Envoi..." : "Envoyer"}
            </Button>
          </CardContent>
        </Card>

        {/* Exported Frames from Isolation */}
        {exportedFrames.length > 0 && (
          <Card className="border-border bg-card lg:col-span-2">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-success/10">
                    <Import className="h-5 w-5 text-success" />
                  </div>
                  <div>
                    <CardTitle className="text-lg">Trames importees depuis Isolation</CardTitle>
                    <CardDescription>
                      {exportedFrames.length} trames pretes a etre rejouees
                    </CardDescription>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    onClick={handleReplayExported}
                    disabled={isReplayingExported}
                    className="gap-2"
                  >
                    {isReplayingExported ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Play className="h-4 w-4" />
                    )}
                    {isReplayingExported ? "Replay..." : "Rejouer tout"}
                  </Button>
                  <Button variant="outline" size="icon" onClick={clearExported} className="bg-transparent">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-48 rounded-md border border-border">
                <div className="p-2">
                  <table className="w-full text-xs font-mono">
                    <thead className="sticky top-0 bg-secondary">
                      <tr className="text-left text-muted-foreground">
                        <th className="p-2 w-20">CAN ID</th>
                        <th className="p-2">Data</th>
                        <th className="p-2 w-32">Source</th>
                        <th className="p-2 w-20">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {exportedFrames.map((frame, index) => (
                        <tr key={index} className="border-t border-border/50 hover:bg-secondary/50">
                          <td className="p-2 text-primary font-semibold">{frame.canId}</td>
                          <td className="p-2">{frame.data}</td>
                          <td className="p-2 text-muted-foreground truncate max-w-[120px]">{frame.source}</td>
                          <td className="p-2">
                            <div className="flex gap-1">
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-6 w-6"
                                onClick={() => handleSendExportedFrame(index)}
                              >
                                <Send className="h-3 w-3" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-6 w-6 text-destructive"
                                onClick={() => removeExportedFrame(index)}
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        )}

        {/* Sent Frames History */}
        <SentFramesHistory frames={frames} onClear={clearHistory} />
      </div>
    </AppShell>
  )
}
