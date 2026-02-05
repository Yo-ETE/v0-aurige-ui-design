"use client"

import { useState, useCallback, useRef } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Send, Trash2, CheckCircle2, XCircle, Clock } from "lucide-react"

// Generate unique ID without crypto.randomUUID (not available in HTTP context)
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
}

export interface SentFrame {
  id: string
  timestamp: Date
  canId: string
  data: string
  interface: "can0" | "can1"
  status: "pending" | "success" | "error"
  description?: string
}

interface SentFramesHistoryProps {
  maxItems?: number
}

// Hook to manage sent frames history
export function useSentFramesHistory(maxItems = 50) {
  const [frames, setFrames] = useState<SentFrame[]>([])

  const addFrame = useCallback((frame: Omit<SentFrame, "id" | "timestamp" | "status">) => {
    const newFrame: SentFrame = {
      ...frame,
      id: generateId(),
      timestamp: new Date(),
      status: "pending",
    }
    setFrames((prev) => [newFrame, ...prev].slice(0, maxItems))
    return newFrame.id
  }, [maxItems])

  const updateStatus = useCallback((id: string, status: "success" | "error") => {
    setFrames((prev) =>
      prev.map((f) => (f.id === id ? { ...f, status } : f))
    )
  }, [])

  const toggleSuccess = useCallback((id: string) => {
    setFrames((prev) =>
      prev.map((f) => {
        if (f.id !== id) return f
        // Toggle between success and pending (allows undo)
        return { ...f, status: f.status === "success" ? "pending" : "success" }
      })
    )
  }, [])

  const clearHistory = useCallback(() => {
    setFrames([])
  }, [])

  // Helper to add and auto-update status
  const trackFrame = useCallback(
    async (
      frame: Omit<SentFrame, "id" | "timestamp" | "status">,
      sendFn: () => Promise<void>
    ) => {
      const id = addFrame(frame)
      try {
        await sendFn()
        updateStatus(id, "success")
        return true
      } catch {
        updateStatus(id, "error")
        return false
      }
    },
    [addFrame, updateStatus]
  )

  return { frames, addFrame, updateStatus, toggleSuccess, clearHistory, trackFrame }
}

export function SentFramesHistory({
  frames,
  onClear,
  onToggleSuccess,
}: {
  frames: SentFrame[]
  onClear: () => void
  onToggleSuccess?: (id: string) => void
}) {
  if (frames.length === 0) {
    return (
      <Card className="border-border bg-card">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Send className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-sm font-medium">Historique des envois</CardTitle>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <Clock className="h-8 w-8 text-muted-foreground/30 mb-2" />
            <p className="text-xs text-muted-foreground">
              Aucune trame envoyee
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  const successCount = frames.filter((f) => f.status === "success").length
  const errorCount = frames.filter((f) => f.status === "error").length

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Send className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-sm font-medium">Historique des envois</CardTitle>
            <Badge variant="secondary" className="text-xs">
              {frames.length}
            </Badge>
            {successCount > 0 && (
              <Badge variant="default" className="bg-success text-success-foreground text-xs">
                {successCount} OK
              </Badge>
            )}
            {errorCount > 0 && (
              <Badge variant="destructive" className="text-xs">
                {errorCount} Err
              </Badge>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={onClear} className="h-7 text-xs">
            <Trash2 className="h-3 w-3 mr-1" />
            Vider
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <ScrollArea className="h-48">
          <div className="space-y-1">
            {frames.map((frame) => (
              <div
                key={frame.id}
                className="flex items-center gap-2 rounded border border-border bg-secondary/30 px-2 py-1.5 font-mono text-xs"
              >
                {frame.status === "pending" && (
                  <button
                    type="button"
                    onClick={() => onToggleSuccess?.(frame.id)}
                    className="hover:scale-110 transition-transform"
                    title="Marquer comme succes"
                  >
                    <Clock className="h-3 w-3 text-warning animate-pulse" />
                  </button>
                )}
                {frame.status === "success" && (
                  <button
                    type="button"
                    onClick={() => onToggleSuccess?.(frame.id)}
                    className="hover:scale-110 transition-transform"
                    title="Annuler le succes"
                  >
                    <CheckCircle2 className="h-3 w-3 text-success" />
                  </button>
                )}
                {frame.status === "error" && (
                  <XCircle className="h-3 w-3 text-destructive" />
                )}
                <span className="text-muted-foreground">
                  {frame.timestamp.toLocaleTimeString("fr-FR", {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </span>
                <Badge variant="outline" className="text-[10px] px-1 py-0">
                  {frame.interface}
                </Badge>
                <span className="text-primary font-semibold">{frame.canId}</span>
                <span className="text-foreground flex-1">{frame.data}</span>
                {frame.description && (
                  <span className="text-muted-foreground truncate max-w-24">
                    {frame.description}
                  </span>
                )}
              </div>
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}
