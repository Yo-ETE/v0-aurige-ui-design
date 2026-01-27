"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Play,
  Square,
  Trash2,
  Maximize2,
  Minimize2,
  ChevronDown,
  ChevronUp,
  Terminal,
  AlertCircle,
} from "lucide-react"
import { startSniffer, stopSniffer, createCANWebSocket, type CANMessage } from "@/lib/api"

interface TerminalLine {
  timestamp: string
  canId: string
  data: string
  delta: string
}

export function FloatingTerminal() {
  const [isRunning, setIsRunning] = useState(false)
  const [isMinimized, setIsMinimized] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)
  const [lines, setLines] = useState<TerminalLine[]>([])
  const [selectedInterface, setSelectedInterface] = useState<"can0" | "can1">("can0")
  const [error, setError] = useState<string | null>(null)
  const [isConnecting, setIsConnecting] = useState(false)
  const terminalRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const lastTimestampRef = useRef<number>(0)

  // Handle incoming CAN messages from WebSocket
  const handleMessage = useCallback((msg: CANMessage) => {
    const currentTime = parseFloat(msg.timestamp) || Date.now() / 1000
    const delta = lastTimestampRef.current > 0 
      ? (currentTime - lastTimestampRef.current).toFixed(3)
      : "0.000"
    lastTimestampRef.current = currentTime
    
    // Format timestamp as HH:MM:SS.mmm
    const date = new Date(currentTime * 1000)
    const timeStr = date.toLocaleTimeString("fr-FR", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }) + "." + date.getMilliseconds().toString().padStart(3, "0")
    
    const newLine: TerminalLine = {
      timestamp: timeStr,
      canId: `0x${msg.canId}`,
      data: msg.data,
      delta,
    }
    
    setLines((prev) => [...prev.slice(-500), newLine]) // Keep last 500 lines
  }, [])

  // Start sniffing
  const handleStart = async () => {
    setError(null)
    setIsConnecting(true)
    
    try {
      // Start backend sniffer
      await startSniffer(selectedInterface)
      
      // Connect WebSocket
      const ws = createCANWebSocket(
        selectedInterface,
        handleMessage,
        (err) => {
          console.error("[v0] WebSocket error:", err)
          setError("Connection lost")
          setIsRunning(false)
        },
        () => {
          setIsRunning(false)
        }
      )
      
      ws.onopen = () => {
        setIsRunning(true)
        setIsConnecting(false)
        lastTimestampRef.current = 0
      }
      
      wsRef.current = ws
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start sniffer")
      setIsConnecting(false)
    }
  }

  // Stop sniffing
  const handleStop = async () => {
    try {
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
      await stopSniffer()
    } catch {
      // Ignore stop errors
    }
    setIsRunning(false)
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close()
      }
    }
  }, [])

  // Auto-scroll to bottom
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight
    }
  }, [lines])

  const clearTerminal = () => {
    setLines([])
    lastTimestampRef.current = 0
  }

  if (isMinimized) {
    return (
      <div className="fixed bottom-4 right-4 z-50">
        <Button
          onClick={() => setIsMinimized(false)}
          className="gap-2 bg-terminal text-terminal-foreground border border-border hover:bg-accent"
        >
          <Terminal className="h-4 w-4" />
          <span>Terminal CAN Sniffer</span>
          {isRunning && (
            <span className="h-2 w-2 animate-pulse rounded-full bg-success" />
          )}
          <ChevronUp className="h-4 w-4" />
        </Button>
      </div>
    )
  }

  return (
    <div
      className={cn(
        "fixed z-50 flex flex-col rounded-lg border border-border bg-terminal shadow-2xl transition-all",
        isExpanded
          ? "bottom-4 right-4 left-72 top-20"
          : "bottom-4 right-4 h-80 w-[500px]"
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border bg-card/50 px-4 py-2">
        <div className="flex items-center gap-3">
          <Terminal className="h-4 w-4 text-terminal-foreground" />
          <span className="text-sm font-medium text-foreground">
            Terminal CAN Sniffer
          </span>
          <span className="rounded bg-primary/20 px-2 py-0.5 text-xs font-medium text-primary">
            {selectedInterface}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <select
            value={selectedInterface}
            onChange={(e) => setSelectedInterface(e.target.value as "can0" | "can1")}
            disabled={isRunning}
            className="mr-2 rounded border border-border bg-secondary px-2 py-1 text-xs text-foreground disabled:opacity-50"
          >
            <option value="can0">can0</option>
            <option value="can1">can1</option>
          </select>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={() => setIsExpanded(!isExpanded)}
          >
            {isExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={() => setIsMinimized(true)}
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-2 bg-destructive/20 px-4 py-2 text-xs text-destructive">
          <AlertCircle className="h-3 w-3" />
          <span>{error}</span>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-5 px-2 text-xs"
            onClick={() => setError(null)}
          >
            Dismiss
          </Button>
        </div>
      )}

      {/* Terminal content */}
      <div
        ref={terminalRef}
        className="flex-1 overflow-auto p-3 font-mono text-xs"
      >
        {lines.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <p>
              {isConnecting 
                ? "Connecting to CAN interface..." 
                : "Click \"Start\" to begin capturing CAN frames..."}
            </p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {lines.map((line, index) => (
              <div key={index} className="flex gap-4 hover:bg-accent/30 px-1 rounded">
                <span className="text-muted-foreground w-24 flex-shrink-0">{line.timestamp}</span>
                <span className="text-primary w-20 flex-shrink-0">{line.canId}</span>
                <span className="text-terminal-foreground">{line.data}</span>
                <span className="text-muted-foreground ml-auto">+{line.delta}s</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer controls */}
      <div className="flex items-center gap-2 border-t border-border bg-card/50 px-4 py-2">
        <Button
          size="sm"
          onClick={isRunning ? handleStop : handleStart}
          disabled={isConnecting}
          className={cn(
            "gap-2",
            isRunning
              ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
              : "bg-success text-success-foreground hover:bg-success/90"
          )}
        >
          {isRunning ? (
            <>
              <Square className="h-3 w-3" /> Stop
            </>
          ) : isConnecting ? (
            "Connecting..."
          ) : (
            <>
              <Play className="h-3 w-3" /> Start
            </>
          )}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={clearTerminal}
          className="gap-2 bg-transparent"
        >
          <Trash2 className="h-3 w-3" /> Clear
        </Button>
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <span>{lines.length} frames</span>
          {isRunning && (
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 animate-pulse rounded-full bg-success" />
              Live
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
