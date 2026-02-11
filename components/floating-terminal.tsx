"use client"

import { cn } from "@/lib/utils"
import { useState, useRef, useCallback, useMemo, useEffect } from "react"
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
  Filter,
  GripHorizontal,
  FileCode,
  ChevronRight,
  Zap,
  TrendingUp,
} from "lucide-react"
import { useSnifferStore, type SnifferFrame, type DecodedSignal } from "@/lib/sniffer-store"
import { useMissionStore } from "@/lib/mission-store"

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

function SnifferRow({ 
  frame, 
  dbcEntry, 
  dbcEnabled,
  decodeSignals,
  highlightChangesEnabled,
  ignoreNoisy,
}: { 
  frame: SnifferFrame
  dbcEntry?: { messageName: string } | null
  dbcEnabled: boolean
  decodeSignals: (canId: string, bytes: string[]) => DecodedSignal[]
  highlightChangesEnabled: boolean
  ignoreNoisy: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const [flashKey, setFlashKey] = useState(0)
  const isKnown = !!dbcEntry
  const decoded = expanded && dbcEnabled && isKnown ? decodeSignals(frame.canId, frame.bytes) : []
  
  const shouldFlash = highlightChangesEnabled && frame.payloadChanged && !(ignoreNoisy && frame.isNoisy)

  // Trigger flash animation when payload changes
  useEffect(() => {
    if (shouldFlash) {
      setFlashKey(prev => prev + 1)
    }
  }, [frame.payloadChanged, frame.changedAt, shouldFlash])

  return (
    <div>
      <div 
        key={flashKey}
        className={cn(
          "flex items-center gap-3 px-2 py-px rounded transition-colors",
          dbcEnabled && isKnown && "bg-success/5 hover:bg-success/10",
          dbcEnabled && !isKnown && "bg-warning/5 hover:bg-warning/10",
          !dbcEnabled && "hover:bg-accent/20",
          highlightChangesEnabled && frame.payloadChanged && !frame.isNoisy && "sniffer-row-flash",
        )}
        onClick={dbcEnabled && isKnown ? () => setExpanded(!expanded) : undefined}
        style={dbcEnabled && isKnown ? { cursor: "pointer" } : undefined}
      >
        {/* Expand arrow for DBC entries */}
        {dbcEnabled && isKnown ? (
          <ChevronRight className={cn(
            "h-3 w-3 flex-shrink-0 text-muted-foreground/50 transition-transform",
            expanded && "rotate-90"
          )} />
        ) : (
          <span className="w-3 flex-shrink-0" />
        )}
        {/* CAN ID */}
        <span className={cn(
          "w-12 flex-shrink-0 font-bold text-right",
          dbcEnabled && isKnown ? "text-success" : dbcEnabled ? "text-warning" : "text-cyan-400"
        )}>
          {frame.canId}
        </span>
        {/* DBC badge + message name */}
        {dbcEnabled && isKnown && (
          <span className="flex items-center gap-1.5 w-28 flex-shrink-0 truncate">
            <span className="inline-flex items-center rounded bg-success/20 px-1 py-px text-[9px] font-bold text-success leading-tight">
              DBC
            </span>
            <span className="text-[10px] text-success/80 truncate font-medium">
              {dbcEntry.messageName}
            </span>
          </span>
        )}
        {dbcEnabled && !isKnown && (
          <span className="w-28 flex-shrink-0">
            <span className="inline-flex items-center rounded bg-warning/20 px-1 py-px text-[9px] font-bold text-warning leading-tight">
              ???
            </span>
          </span>
        )}
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
        {/* Delta badge for changed frames */}
        {highlightChangesEnabled && frame.payloadChanged && shouldFlash && (
          <span 
            className="flex-shrink-0 inline-flex items-center gap-0.5 rounded bg-warning/20 px-1 py-px text-[9px] font-bold text-warning leading-tight"
            title={frame.changedSignalNames.length > 0 ? `Signaux: ${frame.changedSignalNames.join(", ")}` : undefined}
          >
            {frame.signalChanged && frame.changedSignalNames.length > 0 ? (
              <>SIG</>
            ) : (
              <>Δ{frame.deltaBytes > 0 && frame.deltaBytes}</>
            )}
          </span>
        )}
        {/* Noisy badge */}
        {frame.isNoisy && !ignoreNoisy && (
          <span className="flex-shrink-0 inline-flex items-center rounded bg-muted/40 px-1 py-px text-[9px] font-medium text-muted-foreground leading-tight">
            noisy
          </span>
        )}
      </div>
      {/* Expanded signal decode view */}
      {expanded && decoded.length > 0 && (
        <div className="ml-8 mr-2 mb-1 rounded bg-card/50 border border-border/50 px-3 py-1.5">
          {decoded.map((sig, i) => (
            <div key={i} className="flex items-center gap-3 text-[10px] py-0.5">
              <span className="text-primary font-medium w-28 truncate">{sig.name}</span>
              <span className="text-foreground font-mono font-bold">{sig.value}</span>
              {sig.unit && <span className="text-muted-foreground">{sig.unit}</span>}
              <span className="text-muted-foreground/50 font-mono ml-auto">0x{sig.rawHex}</span>
            </div>
          ))}
        </div>
      )}
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
    dbcEnabled,
    dbcLookup,
    dbcLoading,
    dbcFilter,
    highlightChangesEnabled,
    changedOnlyMode,
    changedWindowMs,
    highlightMode,
    ignoreNoisy,
    setInterface,
    setIdFilter,
    start,
    stop,
    togglePause,
    toggleMinimize,
    toggleExpand,
    clearFrames,
    toggleDbcOverlay,
    loadDbc,
    setDbcFilter,
    decodeSignals,
    toggleHighlightChanges,
    toggleChangedOnly,
    setChangedWindow,
    setHighlightMode,
    toggleIgnoreNoisy,
  } = useSnifferStore()

  const currentMission = useMissionStore((state) => state.getCurrentMission())

  // Auto-load DBC when overlay is enabled and mission is available
  useEffect(() => {
    if (dbcEnabled && currentMission?.id) {
      loadDbc(currentMission.id)
    }
  }, [dbcEnabled, currentMission?.id, loadDbc])

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

  // DBC stats
  const dbcStats = useMemo(() => {
    if (!dbcEnabled || dbcLookup.size === 0) return null
    const known = sortedIds.filter(id => dbcLookup.has(id.toUpperCase())).length
    const total = sortedIds.length
    const percent = total > 0 ? Math.round((known / total) * 100) : 0
    return { known, unknown: total - known, total, percent }
  }, [dbcEnabled, dbcLookup, sortedIds])

  // Filtered IDs
  const filteredIds = useMemo(() => {
    let ids = sortedIds
    
    // Apply "Changed only" filter
    if (changedOnlyMode) {
      const now = Date.now()
      ids = ids.filter(id => {
        const frame = frameMap.get(id)
        if (!frame || frame.changedAt === 0) return false
        return (now - frame.changedAt) <= changedWindowMs
      })
    }
    
    // Apply DBC filter
    if (dbcEnabled && dbcFilter === "dbc") {
      ids = ids.filter(id => dbcLookup.has(id.toUpperCase()))
    } else if (dbcEnabled && dbcFilter === "unknown") {
      ids = ids.filter(id => !dbcLookup.has(id.toUpperCase()))
    }
    
    // Apply text filter
    if (idFilter.trim()) {
      const filters = idFilter.toUpperCase().split(",").map(f => f.trim()).filter(Boolean)
      ids = ids.filter(id => filters.some(f => id.includes(f)))
    }
    
    return ids
  }, [sortedIds, idFilter, dbcEnabled, dbcFilter, dbcLookup, changedOnlyMode, changedWindowMs, frameMap])

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
          <Button
            size="icon"
            variant="ghost"
            className={cn(
              "h-7 w-7",
              highlightChangesEnabled 
                ? "text-warning hover:text-warning/80" 
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={toggleHighlightChanges}
            onMouseDown={(e) => e.stopPropagation()}
            title={highlightChangesEnabled ? "Desactiver highlight changes" : "Activer highlight changes"}
          >
            <Zap className="h-4 w-4" />
          </Button>
          {highlightChangesEnabled && (
            <>
              <select
                value={highlightMode}
                onChange={(e) => setHighlightMode(e.target.value as "payload" | "signal" | "both")}
                onMouseDown={(e) => e.stopPropagation()}
                className="h-7 rounded border border-border bg-secondary px-2 text-[10px] text-foreground"
                title="Mode de detection"
              >
                <option value="payload">Payload</option>
                <option value="signal">Signal</option>
                <option value="both">Both</option>
              </select>
              <Button
                size="icon"
                variant="ghost"
                className={cn(
                  "h-7 w-7",
                  ignoreNoisy 
                    ? "text-muted-foreground hover:text-foreground" 
                    : "text-warning hover:text-warning/80"
                )}
                onClick={toggleIgnoreNoisy}
                onMouseDown={(e) => e.stopPropagation()}
                title={ignoreNoisy ? "Afficher les IDs bruyants" : "Masquer les IDs bruyants"}
              >
                <span className="text-xs font-bold">N</span>
              </Button>
            </>
          )}
          <Button
            size="icon"
            variant="ghost"
            className={cn(
              "h-7 w-7",
              changedOnlyMode 
                ? "text-warning hover:text-warning/80" 
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={toggleChangedOnly}
            onMouseDown={(e) => e.stopPropagation()}
            title={changedOnlyMode ? "Montrer tous les IDs" : "Filtrer IDs changes uniquement"}
          >
            <TrendingUp className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className={cn(
              "h-7 w-7",
              dbcEnabled 
                ? "text-success hover:text-success/80" 
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={toggleDbcOverlay}
            onMouseDown={(e) => e.stopPropagation()}
            title={dbcEnabled ? "Desactiver overlay DBC" : "Activer overlay DBC"}
          >
            <FileCode className="h-4 w-4" />
          </Button>
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

      {/* DBC overlay status bar */}
      {dbcEnabled && sortedIds.length > 0 && dbcStats && (
        <div className="flex items-center gap-2 border-b border-border/50 bg-success/5 px-3 py-1">
          <FileCode className="h-3 w-3 text-success flex-shrink-0" />
          <span className="text-[10px] text-success font-medium">
            DBC: {dbcStats.percent}% connu
          </span>
          <span className="text-[10px] text-muted-foreground">
            ({dbcStats.known} / {dbcStats.total} IDs)
          </span>
          {dbcLoading && <span className="text-[10px] text-muted-foreground animate-pulse">chargement...</span>}
          <div className="ml-auto flex items-center gap-1">
            {(["all", "dbc", "unknown"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setDbcFilter(f)}
                onMouseDown={(e) => e.stopPropagation()}
                className={cn(
                  "rounded px-1.5 py-0.5 text-[9px] font-medium transition-colors",
                  dbcFilter === f
                    ? f === "dbc" ? "bg-success/20 text-success"
                      : f === "unknown" ? "bg-warning/20 text-warning"
                      : "bg-primary/20 text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {f === "all" ? "Tout" : f === "dbc" ? "Connu" : "Inconnu"}
              </button>
            ))}
          </div>
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
          {dbcEnabled && <span className="w-3 flex-shrink-0" />}
          <span className="w-12 flex-shrink-0 text-right">ID</span>
          {dbcEnabled && <span className="w-28 flex-shrink-0">Message</span>}
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
              const dbcEntry = dbcEnabled ? dbcLookup.get(id.toUpperCase()) || null : null
              return (
                <SnifferRow 
                  key={id} 
                  frame={frame} 
                  dbcEntry={dbcEntry}
                  dbcEnabled={dbcEnabled}
                  decodeSignals={decodeSignals}
                  highlightChangesEnabled={highlightChangesEnabled}
                  ignoreNoisy={ignoreNoisy}
                />
              )
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
          {highlightChangesEnabled && changedOnlyMode && (
            <span className="text-warning font-medium">
              Δ {filteredIds.length}
            </span>
          )}
          {dbcEnabled && dbcStats && (
            <span className={cn(
              "font-medium",
              dbcStats.percent >= 50 ? "text-success" : "text-warning"
            )}>
              {dbcStats.percent}% DBC
            </span>
          )}
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
