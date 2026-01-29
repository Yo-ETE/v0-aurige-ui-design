"use client"

import { useRef, useEffect } from "react"
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
  Pause,
} from "lucide-react"
import { useSnifferStore } from "@/lib/sniffer-store"

export function FloatingTerminal() {
  const terminalRef = useRef<HTMLDivElement>(null)
  
  // Use global store for persistence across page navigation
  const {
    isRunning,
    isConnecting,
    selectedInterface,
    error,
    lines,
    isPaused,
    isMinimized,
    isExpanded,
    setInterface,
    start,
    stop,
    togglePause,
    toggleMinimize,
    toggleExpand,
    clearLines,
  } = useSnifferStore()

  // Auto-scroll to bottom when new lines arrive
  useEffect(() => {
    if (terminalRef.current && !isPaused) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight
    }
  }, [lines, isPaused])

  if (isMinimized) {
    return (
      <div className="fixed bottom-4 right-4 z-50">
        <Button
          onClick={toggleMinimize}
          className="gap-2 bg-terminal text-terminal-foreground border border-border hover:bg-accent"
        >
          <Terminal className="h-4 w-4" />
          <span>CAN Sniffer</span>
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
            CAN Sniffer
          </span>
          <span className="rounded bg-primary/20 px-2 py-0.5 text-xs font-medium text-primary">
            {selectedInterface}
          </span>
          {isRunning && (
            <span className="text-xs text-success font-medium">LIVE</span>
          )}
          {isPaused && (
            <span className="text-xs text-warning font-medium">PAUSE</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <select
            value={selectedInterface}
            onChange={(e) => setInterface(e.target.value as "can0" | "can1")}
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
            onClick={toggleExpand}
          >
            {isExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={toggleMinimize}
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
                ? "Connexion a l'interface CAN..." 
                : "Cliquez sur \"Start\" pour demarrer le sniffer CAN..."}
            </p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {lines.map((line) => (
              <div key={line.id} className="flex gap-4 hover:bg-accent/30 px-1 rounded">
                <span className="text-muted-foreground w-24 flex-shrink-0">{line.timestamp}</span>
                <span className="text-primary w-16 flex-shrink-0">0x{line.canId}</span>
                <span className="text-terminal-foreground flex-1">{line.data}</span>
                <span className="text-muted-foreground/60 w-8 text-right">[{line.dlc}]</span>
                {line.delta !== undefined && (
                  <span className="text-muted-foreground/50 w-16 text-right">+{line.delta}ms</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer controls */}
      <div className="flex items-center gap-2 border-t border-border bg-card/50 px-4 py-2">
        {!isRunning ? (
          <Button
            size="sm"
            onClick={start}
            disabled={isConnecting}
            className="gap-2 bg-success text-success-foreground hover:bg-success/90"
          >
            <Play className="h-3 w-3" />
            {isConnecting ? "Connexion..." : "Start"}
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              onClick={togglePause}
              className={cn(
                "gap-2",
                isPaused
                  ? "bg-success text-success-foreground hover:bg-success/90"
                  : "bg-warning text-warning-foreground hover:bg-warning/90"
              )}
            >
              {isPaused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
              {isPaused ? "Resume" : "Pause"}
            </Button>
            <Button
              size="sm"
              onClick={stop}
              className="gap-2 bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              <Square className="h-3 w-3" />
              Stop
            </Button>
          </>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={clearLines}
          className="gap-2 bg-transparent"
        >
          <Trash2 className="h-3 w-3" />
          Clear
        </Button>
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <span>{lines.length} trames</span>
          {isRunning && !isPaused && (
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 animate-pulse rounded-full bg-success" />
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
