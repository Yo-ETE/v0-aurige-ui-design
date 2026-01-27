"use client"

import { useState, useEffect, useRef } from "react"
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
} from "lucide-react"

const mockSnifferData = [
  { time: "14:32:01.123", id: "0x7E8", data: "03 41 0C 1A F8 00 00 00", delta: "0.000" },
  { time: "14:32:01.156", id: "0x7E8", data: "03 41 0D 32 00 00 00 00", delta: "0.033" },
  { time: "14:32:01.189", id: "0x7DF", data: "02 01 0C 00 00 00 00 00", delta: "0.033" },
  { time: "14:32:01.223", id: "0x7E8", data: "03 41 0C 1B 10 00 00 00", delta: "0.034" },
  { time: "14:32:01.256", id: "0x18DAF110", data: "03 7F 01 12 00 00 00 00", delta: "0.033" },
  { time: "14:32:01.290", id: "0x7E8", data: "03 41 05 7A 00 00 00 00", delta: "0.034" },
  { time: "14:32:01.323", id: "0x7DF", data: "02 01 05 00 00 00 00 00", delta: "0.033" },
  { time: "14:32:01.356", id: "0x7E8", data: "03 41 0F 3C 00 00 00 00", delta: "0.033" },
]

export function FloatingTerminal() {
  const [isRunning, setIsRunning] = useState(false)
  const [isMinimized, setIsMinimized] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)
  const [lines, setLines] = useState<typeof mockSnifferData>([])
  const [selectedInterface, setSelectedInterface] = useState("can0")
  const terminalRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isRunning) return

    const interval = setInterval(() => {
      const randomData = mockSnifferData[Math.floor(Math.random() * mockSnifferData.length)]
      const newLine = {
        ...randomData,
        time: new Date().toLocaleTimeString("fr-FR", {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }) + "." + String(Math.floor(Math.random() * 1000)).padStart(3, "0"),
      }
      setLines((prev) => [...prev.slice(-100), newLine])
    }, 100 + Math.random() * 200)

    return () => clearInterval(interval)
  }, [isRunning])

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight
    }
  }, [lines])

  const clearTerminal = () => {
    setLines([])
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
            onChange={(e) => setSelectedInterface(e.target.value)}
            className="mr-2 rounded border border-border bg-secondary px-2 py-1 text-xs text-foreground"
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

      {/* Terminal content */}
      <div
        ref={terminalRef}
        className="flex-1 overflow-auto p-3 font-mono text-xs"
      >
        {lines.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <p>Click &quot;Start&quot; to begin capturing CAN frames...</p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {lines.map((line, index) => (
              <div key={index} className="flex gap-4 hover:bg-accent/30 px-1 rounded">
                <span className="text-muted-foreground w-24 flex-shrink-0">{line.time}</span>
                <span className="text-primary w-20 flex-shrink-0">{line.id}</span>
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
          onClick={() => setIsRunning(!isRunning)}
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
              Capturing
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
