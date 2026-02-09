"use client"

import { cn } from "@/lib/utils"
import { useState, useRef, useCallback, useMemo } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
  Filter,
  GripHorizontal,
} from "lucide-react"
import { useSnifferStore, type SnifferFrame } from "@/lib/sniffer-store"

/**
 * Renders a single byte with color based on change state.
 * Red = byte just changed, green = stable, dim = never changed.
 */
function ColoredByte({ value, changed }: { value: string; changed: boolean }) {
  return (
    <span
      className={cn(
        "inline-block w-[2ch] text-center font-mono transition-colors duration-300",
        changed
          ? "text-red-400 font-bold"
          : "text-emerald-400"
      )}
    >
      {value}
    </span>
  )
}

function SnifferRow({ frame }: { frame: SnifferFrame }) {
  return (
    <div className="flex items-center gap-3 px-2 py-px hover:bg-accent/20 rounded">
      {/* CAN ID */}
      <span className="w-12 flex-shrink-0 text-cyan-400 font-bold text-right">
        {frame.canId}
      </span>
      {/* DLC */}
      <span className="w-4 flex-shrink-0 text-muted-foreground text-center">
        {frame.dlc}
      </span>
      {/* Data bytes with change coloring */}
      <span className="flex gap-1 flex-1">
        {frame.bytes.map((byte, i) => (
          <ColoredByte
            key={i}
            value={byte.toUpperCase()}
            changed={frame.changedIndices.has(i)}
          />
        ))}
      </span>
      {/* Cycle time */}
      <span className="w-16 flex-shrink-0 text-right text-muted-foreground/70">
        {frame.cycleMs > 0 ? `${frame.cycleMs}ms` : ""}
      </span>
      {/* Count */}
      <span className="w-12 flex-shrink-0 text-right text-muted-foreground/50">
        {frame.count}
      </span>
    </div>
  )
}

export function FloatingTerminal() {
  const {
    isRunning,
    isConnecting,
    selectedInterface,
    error,
    frameMap,
    sortedIds,
    totalMessages,
    isPaused,
    isMinimized,
    isExpanded,
    idFilter,
    setInterface,
    setIdFilter,
    start,
    stop,
    togglePause,
    toggleMinimize,
    toggleExpand,
    clearFrames,
  } = useSnifferStore()

  // Drag state
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 600, h: 384 })
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)
  const resizeRef = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null)

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const rect = (e.currentTarget.closest("[data-sniffer-window]") as HTMLElement)?.getBoundingClientRect()
    if (!rect) return
    const pos = position || { x: rect.left, y: rect.top }
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y }

    const handleMove = (ev: MouseEvent) => {
      if (!dragRef.current) return
      const dx = ev.clientX - dragRef.current.startX
      const dy = ev.clientY - dragRef.current.startY
      setPosition({ x: dragRef.current.origX + dx, y: dragRef.current.origY + dy })
    }
    const handleUp = () => {
      dragRef.current = null
      window.removeEventListener("mousemove", handleMove)
      window.removeEventListener("mouseup", handleUp)
    }
    window.addEventListener("mousemove", handleMove)
    window.addEventListener("mouseup", handleUp)
  }, [position])

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    resizeRef.current = { startX: e.clientX, startY: e.clientY, origW: size.w, origH: size.h }

    const handleMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return
      const dw = ev.clientX - resizeRef.current.startX
      const dh = ev.clientY - resizeRef.current.startY
      setSize({
        w: Math.max(400, resizeRef.current.origW + dw),
        h: Math.max(250, resizeRef.current.origH + dh),
      })
    }
    const handleUp = () => {
      resizeRef.current = null
      window.removeEventListener("mousemove", handleMove)
      window.removeEventListener("mouseup", handleUp)
    }
    window.addEventListener("mousemove", handleMove)
    window.addEventListener("mouseup", handleUp)
  }, [size])

  // Filtered IDs
  const filteredIds = useMemo(() => {
    if (!idFilter.trim()) return sortedIds
    const filters = idFilter.toUpperCase().split(",").map(f => f.trim()).filter(Boolean)
    return sortedIds.filter(id => filters.some(f => id.includes(f)))
  }, [sortedIds, idFilter])

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
      data-sniffer-window
      className={cn(
        "fixed z-50 flex flex-col rounded-lg border border-border bg-terminal shadow-2xl",
        isExpanded && "transition-all"
      )}
      style={
        isExpanded
          ? { bottom: 16, right: 16, left: 288, top: 80 }
          : position
            ? { left: position.x, top: position.y, width: size.w, height: size.h }
            : { bottom: 16, right: 16, width: size.w, height: size.h }
      }
    >
      {/* Header - draggable */}
      <div
        className="flex items-center justify-between border-b border-border bg-card/50 px-4 py-2 cursor-grab active:cursor-grabbing select-none"
        onMouseDown={handleDragStart}
      >
        <div className="flex items-center gap-3">
          <GripHorizontal className="h-4 w-4 text-muted-foreground/50" />
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
            onChange={(e) => setInterface(e.target.value as "can0" | "can1" | "vcan0")}
            onMouseDown={(e) => e.stopPropagation()}
            disabled={isRunning}
            className="mr-2 rounded border border-border bg-secondary px-2 py-1 text-xs text-foreground disabled:opacity-50"
          >
            <option value="can0">can0</option>
            <option value="can1">can1</option>
            <option value="vcan0">vcan0 (test)</option>
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

      {/* ID Filter bar */}
      {sortedIds.length > 0 && (
        <div className="flex items-center gap-2 border-b border-border/50 bg-card/30 px-3 py-1.5">
          <Filter className="h-3 w-3 text-muted-foreground flex-shrink-0" />
          <input
            type="text"
            value={idFilter}
            onChange={(e) => setIdFilter(e.target.value)}
            onMouseDown={(e) => e.stopPropagation()}
            placeholder="Filtrer par ID (ex: 303, 7DF, 12E,090)"
            className="flex-1 bg-transparent text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none"
          />
          {idFilter && (
            <span className="text-[10px] text-muted-foreground">
              {filteredIds.length}/{sortedIds.length}
            </span>
          )}
        </div>
      )}

      {/* Column headers */}
      {sortedIds.length > 0 && (
        <div className="flex items-center gap-3 border-b border-border/50 bg-card/30 px-2 py-1 font-mono text-[10px] text-muted-foreground/60 uppercase">
          <span className="w-12 flex-shrink-0 text-right">ID</span>
          <span className="w-4 flex-shrink-0 text-center">L</span>
          <span className="flex-1">Data</span>
          <span className="w-16 flex-shrink-0 text-right">Cycle</span>
          <span className="w-12 flex-shrink-0 text-right">Count</span>
        </div>
      )}

      {/* Terminal content - cansniffer mode: fixed rows per ID */}
      <div className="flex-1 overflow-auto p-1 font-mono text-xs">
        {sortedIds.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <p>
              {isConnecting 
                ? "Connexion a l'interface CAN..." 
                : "Cliquez sur \"Start\" pour demarrer le sniffer CAN..."}
            </p>
          </div>
        ) : (
          <div>
            {filteredIds.map((id) => {
              const frame = frameMap.get(id)
              if (!frame) return null
              return <SnifferRow key={id} frame={frame} />
            })}
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
          onClick={clearFrames}
          className="gap-2 bg-transparent"
        >
          <Trash2 className="h-3 w-3" />
          Clear
        </Button>
        <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          <span>{filteredIds.length !== sortedIds.length ? `${filteredIds.length}/` : ""}{sortedIds.length} IDs</span>
          <span>{totalMessages} msg</span>
          {isRunning && !isPaused && (
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 animate-pulse rounded-full bg-success" />
            </span>
          )}
        </div>
      </div>

      {/* Resize handle (bottom-right corner) */}
      {!isExpanded && (
        <div
          className="absolute bottom-0 right-0 h-4 w-4 cursor-se-resize"
          onMouseDown={handleResizeStart}
        >
          <svg className="h-4 w-4 text-muted-foreground/30" viewBox="0 0 16 16" fill="currentColor">
            <circle cx="12" cy="12" r="1.5" />
            <circle cx="8" cy="12" r="1.5" />
            <circle cx="12" cy="8" r="1.5" />
          </svg>
        </div>
      )}
    </div>
  )
}
