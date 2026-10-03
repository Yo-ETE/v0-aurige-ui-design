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
  Snowflake,
  Waves,
  RotateCcw,
} from "lucide-react"
import { useSnifferStore, type SnifferFrame, type DecodedSignal } from "@/lib/sniffer-store"
import { useMissionStore } from "@/lib/mission-store"

/**
 * Renders a single byte with color based on change state.
 * Red = byte just changed, green = stable, dim = never changed.
 */
function ColoredByte({
  value,
  changed,
  notchActive = false,
  lit = false,
  noise = false,
  count = 0,
}: {
  value: string
  changed: boolean
  notchActive?: boolean
  /** Notch: byte differs from frozen reference (persistent) */
  lit?: boolean
  /** Notch: byte absorbed as background noise */
  noise?: boolean
  /** Notch: number of changes vs reference since freeze */
  count?: number
}) {
  if (!notchActive) {
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
  return (
    <span className="relative inline-flex flex-col items-center">
      <span
        className={cn(
          "inline-block w-[2ch] text-center font-mono transition-colors duration-300",
          lit
            ? "rounded-sm bg-amber-500/25 text-amber-300 font-bold ring-1 ring-amber-400/70"
            : noise
              ? "text-muted-foreground/40 line-through"
              : "text-emerald-400/70"
        )}
        title={noise ? "Bruit absorbe" : lit ? `Change ${count > 0 ? count : 1}x depuis la reference` : undefined}
      >
        {value}
      </span>
      {lit && count > 1 && (
        <span className="absolute -bottom-2 left-1/2 -translate-x-1/2 text-[8px] leading-none text-amber-400/90">
          {count}
        </span>
      )}
    </span>
  )
}

/** Bit-level view of one byte: 8 bits in two nibbles, differing bits highlighted. */
function BitByte({ value, reference, notchActive }: { value: string; reference?: string; notchActive: boolean }) {
  const cur = parseInt(value, 16) || 0
  const prev = reference !== undefined ? parseInt(reference, 16) || 0 : cur
  const bits: React.ReactNode[] = []
  for (let b = 7; b >= 0; b--) {
    const on = (cur >> b) & 1
    const diff = ((cur ^ prev) >> b) & 1
    bits.push(
      <span
        key={b}
        className={cn(
          "inline-block w-[1ch] text-center",
          diff
            ? notchActive
              ? "rounded-sm bg-amber-500/30 text-amber-300 font-bold"
              : "rounded-sm bg-red-500/30 text-red-400 font-bold"
            : on
              ? "text-emerald-400"
              : "text-muted-foreground/40",
          b === 3 && "mr-[0.5ch]"
        )}
      >
        {on}
      </span>
    )
  }
  return <span className="inline-flex font-mono text-[10px]">{bits}</span>
}

function SnifferRow({ 
  frame, 
  dbcEntry, 
  dbcEnabled,
  decodeSignals,
  highlightChangesEnabled,
  ignoreNoisy,
  notchActive,
  notchBase,
  notchChanged,
  notchNoise,
  notchCounts,
}: {
  frame: SnifferFrame
  dbcEntry?: { messageName: string } | null
  dbcEnabled: boolean
  decodeSignals: (canId: string, bytes: string[]) => DecodedSignal[]
  highlightChangesEnabled: boolean
  ignoreNoisy: boolean
  notchActive: boolean
  notchBase?: string[]
  notchChanged?: Set<number>
  notchNoise?: Set<number>
  notchCounts?: number[]
}) {
  const [expanded, setExpanded] = useState(false)
  const [showBits, setShowBits] = useState(false)
  const [flashKey, setFlashKey] = useState(0)
  const isKnown = !!dbcEntry
  const decoded = expanded && dbcEnabled && isKnown ? decodeSignals(frame.canId, frame.bytes) : []
  
  const rowIdle = notchActive && !(notchChanged && notchChanged.size > 0)
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
          rowIdle && "opacity-40",
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
          "w-10 sm:w-12 flex-shrink-0 font-bold text-right text-[10px] sm:text-xs",
          dbcEnabled && isKnown ? "text-success" : dbcEnabled ? "text-warning" : "text-cyan-400"
        )}>
          {frame.canId}
        </span>
        {/* DBC badge + message name */}
        {dbcEnabled && isKnown && (
          <span className="hidden sm:flex items-center gap-1.5 w-28 flex-shrink-0 truncate">
            <span className="inline-flex items-center rounded bg-success/20 px-1 py-px text-[9px] font-bold text-success leading-tight">
              DBC
            </span>
            <span className="text-[10px] text-success/80 truncate font-medium">
              {dbcEntry.messageName}
            </span>
          </span>
        )}
        {dbcEnabled && !isKnown && (
          <span className="hidden sm:block w-28 flex-shrink-0">
            <span className="inline-flex items-center rounded bg-warning/20 px-1 py-px text-[9px] font-bold text-warning leading-tight">
              ???
            </span>
          </span>
        )}
        {/* DLC */}
        <span className="hidden sm:block w-4 flex-shrink-0 text-muted-foreground text-center">
          {frame.dlc}
        </span>
        {/* Data bytes with change coloring */}
        <span className="flex gap-0.5 sm:gap-1 flex-1 min-w-0 overflow-hidden">
          {frame.bytes.map((byte, i) => (
            <ColoredByte
              key={i}
              value={byte.toUpperCase()}
              changed={frame.changedIndices.has(i)}
              notchActive={notchActive}
              lit={!!notchChanged && notchChanged.has(i)}
              noise={!!notchNoise && notchNoise.has(i)}
              count={notchCounts?.[i] || 0}
            />
          ))}
        </span>
        {/* Bit view toggle */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setShowBits((v) => !v) }}
          className={cn(
            "flex-shrink-0 rounded px-1 py-px text-[9px] font-medium leading-tight transition-colors",
            showBits ? "bg-primary/20 text-primary" : "text-muted-foreground/60 hover:text-foreground"
          )}
          title={showBits ? "Masquer la vue bits" : "Afficher la vue bits"}
        >
          bits
        </button>
        {/* Cycle time */}
        <span className="hidden sm:block w-16 flex-shrink-0 text-right text-muted-foreground/70">
          {frame.cycleMs > 0 ? `${frame.cycleMs}ms` : ""}
        </span>
        {/* Count */}
        <span className="w-8 sm:w-12 flex-shrink-0 text-right text-muted-foreground/50 text-[10px] sm:text-xs">
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
      {/* Bit-level view */}
      {showBits && (
        <div className="ml-8 mr-2 mb-1 flex flex-wrap gap-x-3 gap-y-1 rounded bg-card/50 border border-border/50 px-3 py-1.5">
          {frame.bytes.map((byte, i) => (
            <span key={i} className="inline-flex items-center gap-1">
              <span className="text-[9px] text-muted-foreground/50">{i}</span>
              <BitByte
                value={byte}
                reference={notchActive ? notchBase?.[i] : frame.prevBytes[i]}
                notchActive={notchActive}
              />
            </span>
          ))}
        </div>
      )}
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
    notchActive,
    notchBaseline,
    noiseMask,
    changedSinceNotchById,
    changeCountSinceNotchById,
    setNotch,
    clearNotch,
    absorbNoise,
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

  // Adjust size on mount for mobile
  useEffect(() => {
    if (typeof window !== "undefined") {
      if (window.innerWidth < 640) {
        setSize({ w: Math.max(280, window.innerWidth - 16), h: 320 })
      }
    }
  }, [])

  // Keep the dragged position inside the viewport (also on resize/rotate).
  const clampPosition = useCallback(
    (p: { x: number; y: number }, w: number, h: number) => {
      const vw = window.innerWidth
      const vh = window.innerHeight
      const effW = Math.min(w, vw - 16)
      const effH = Math.min(h, vh - 16)
      return {
        x: Math.max(8, Math.min(p.x, vw - effW - 8)),
        y: Math.max(8, Math.min(p.y, vh - Math.min(effH, 48) - 8)),
      }
    },
    []
  )

  useEffect(() => {
    const onResize = () => {
      setPosition((p) => (p ? clampPosition(p, size.w, size.h) : p))
    }
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [size.w, size.h, clampPosition])

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
      setPosition(clampPosition({ x: dragRef.current.origX + dx, y: dragRef.current.origY + dy }, size.w, size.h))
    }
    const handleUp = () => {
      dragRef.current = null
      window.removeEventListener("mousemove", handleMove)
      window.removeEventListener("mouseup", handleUp)
    }
    window.addEventListener("mousemove", handleMove)
    window.addEventListener("mouseup", handleUp)
  }, [position, size.w, size.h, clampPosition])

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    resizeRef.current = { startX: e.clientX, startY: e.clientY, origW: size.w, origH: size.h }

    const handleMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return
      const dw = ev.clientX - resizeRef.current.startX
      const dh = ev.clientY - resizeRef.current.startY
      setSize({
        w: Math.max(280, resizeRef.current.origW + dw),
        h: Math.max(200, resizeRef.current.origH + dh),
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
    
    // Notch: pin IDs that changed since the reference on top (stable order otherwise)
    if (notchActive) {
      const active: string[] = []
      const rest: string[] = []
      for (const id of ids) {
        const c = changedSinceNotchById.get(id)
        if (c && c.size > 0) active.push(id)
        else rest.push(id)
      }
      ids = active.concat(rest)
    }

    return ids
  }, [sortedIds, idFilter, dbcEnabled, dbcFilter, dbcLookup, changedOnlyMode, changedWindowMs, frameMap, notchActive, changedSinceNotchById])

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
      suppressHydrationWarning
      className={cn(
        "fixed z-50 flex flex-col rounded-lg border border-border bg-terminal shadow-2xl",
        isExpanded && "transition-all left-2 lg:left-72"
      )}
      style={
        isExpanded
          ? { bottom: "8px", right: "8px", top: "60px" }
          : position
            ? { left: `${position.x}px`, top: `${position.y}px`, width: `min(${size.w}px, calc(100vw - 16px))`, height: `min(${size.h}px, calc(100vh - 16px))` }
            : { bottom: "8px", right: "8px", width: `min(${size.w}px, calc(100vw - 16px))`, height: `min(${size.h}px, calc(100vh - 16px))` }
      }
    >
      {/* Header - draggable */}
      <div
        className="flex flex-col border-b border-border bg-card/50 cursor-grab active:cursor-grabbing select-none"
        onMouseDown={handleDragStart}
      >
        {/* Top row: title + window controls */}
        <div className="flex items-center justify-between px-3 py-1.5">
          <div className="flex items-center gap-2 min-w-0">
            <GripHorizontal className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
            <Terminal className="h-3.5 w-3.5 text-terminal-foreground shrink-0" />
            <span className="text-xs font-medium text-foreground truncate">CAN Sniffer</span>
            <span className="rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary shrink-0">
              {selectedInterface}
            </span>
            {isRunning && (
              <span className="text-[10px] text-success font-medium shrink-0">LIVE</span>
            )}
            {isPaused && (
              <span className="text-[10px] text-warning font-medium shrink-0">PAUSE</span>
            )}
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
            <select
              value={selectedInterface}
              onChange={(e) => setInterface(e.target.value as "can0" | "can1" | "vcan0")}
              onMouseDown={(e) => e.stopPropagation()}
              disabled={isRunning}
              className="hidden sm:block h-6 rounded border border-border bg-secondary px-1.5 text-[10px] text-foreground disabled:opacity-50"
            >
              <option value="can0">can0</option>
              <option value="can1">can1</option>
              <option value="vcan0">vcan0</option>
            </select>
            <Button size="icon" variant="ghost" className="h-6 w-6 text-muted-foreground hover:text-foreground" onClick={toggleExpand} onMouseDown={(e) => e.stopPropagation()}>
              {isExpanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </Button>
            <Button size="icon" variant="ghost" className="h-6 w-6 text-muted-foreground hover:text-foreground" onClick={toggleMinimize} onMouseDown={(e) => e.stopPropagation()}>
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        {/* Bottom row: tool buttons -- scrollable on mobile */}
        <div className="flex items-center gap-1 px-3 pb-1.5 overflow-x-auto scrollbar-none">
          <Button
            size="icon"
            variant="ghost"
            className={cn(
              "h-6 w-6 shrink-0",
              highlightChangesEnabled 
                ? "text-warning hover:text-warning/80" 
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={toggleHighlightChanges}
            onMouseDown={(e) => e.stopPropagation()}
            title={highlightChangesEnabled ? "Desactiver highlight changes" : "Activer highlight changes"}
          >
            <Zap className="h-3.5 w-3.5" />
          </Button>
          {highlightChangesEnabled && (
            <>
              <select
                value={highlightMode}
                onChange={(e) => setHighlightMode(e.target.value as "payload" | "signal" | "both")}
                onMouseDown={(e) => e.stopPropagation()}
                className="h-6 rounded border border-border bg-secondary px-1.5 text-[10px] text-foreground shrink-0"
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
                  "h-6 w-6 shrink-0",
                  ignoreNoisy 
                    ? "text-muted-foreground hover:text-foreground" 
                    : "text-warning hover:text-warning/80"
                )}
                onClick={toggleIgnoreNoisy}
                onMouseDown={(e) => e.stopPropagation()}
                title={ignoreNoisy ? "Afficher les IDs bruyants" : "Masquer les IDs bruyants"}
              >
                <span className="text-[10px] font-bold">N</span>
              </Button>
            </>
          )}
          <Button
            size="icon"
            variant="ghost"
            className={cn(
              "h-6 w-6 shrink-0",
              changedOnlyMode 
                ? "text-warning hover:text-warning/80" 
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={toggleChangedOnly}
            onMouseDown={(e) => e.stopPropagation()}
            title={changedOnlyMode ? "Montrer tous les IDs" : "Filtrer IDs changes uniquement"}
          >
            <TrendingUp className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className={cn(
              "h-6 w-6 shrink-0",
              dbcEnabled 
                ? "text-success hover:text-success/80" 
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={toggleDbcOverlay}
            onMouseDown={(e) => e.stopPropagation()}
            title={dbcEnabled ? "Desactiver overlay DBC" : "Activer overlay DBC"}
          >
            <FileCode className="h-3.5 w-3.5" />
          </Button>
          <span className="mx-0.5 h-4 w-px shrink-0 bg-border" />
          {!notchActive ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 shrink-0 gap-1 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
              onClick={setNotch}
              onMouseDown={(e) => e.stopPropagation()}
              title="Figer la reference (notch) : memorise l'etat actuel de chaque ID. Declenchez ensuite une action (ex. essuie-glaces) : les octets qui different de la reference restent allumes en orange, meme apres un changement bref. Utilisez Noyer le bruit pour masquer ce qui bouge deja tout seul."
            >
              <Snowflake className="h-3.5 w-3.5" />
              Figer
            </Button>
          ) : (
            <>
              <span className="inline-flex shrink-0 items-center gap-1 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
                Référence figée
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 shrink-0 gap-1 px-1.5 text-[10px] text-amber-300 hover:text-amber-200"
                onClick={absorbNoise}
                onMouseDown={(e) => e.stopPropagation()}
                title="Noyer le bruit : tout ce qui a bougé jusqu'ici devient du fond (barré) ; seuls les NOUVEAUX changements s'allument ensuite."
              >
                <Waves className="h-3.5 w-3.5" />
                Noyer le bruit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 shrink-0 gap-1 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                onClick={clearNotch}
                onMouseDown={(e) => e.stopPropagation()}
                title="Reset : supprimer la référence et revenir à l'affichage normal."
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Reset
              </Button>
            </>
          )}
          {/* Mobile: show interface selector inline */}
          <select
            value={selectedInterface}
            onChange={(e) => setInterface(e.target.value as "can0" | "can1" | "vcan0")}
            onMouseDown={(e) => e.stopPropagation()}
            disabled={isRunning}
            className="sm:hidden h-6 rounded border border-border bg-secondary px-1.5 text-[10px] text-foreground disabled:opacity-50 shrink-0"
          >
            <option value="can0">can0</option>
            <option value="can1">can1</option>
            <option value="vcan0">vcan0</option>
          </select>
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
        <div className="flex items-center gap-2 sm:gap-3 border-b border-border/50 bg-card/30 px-2 py-1 font-mono text-[9px] sm:text-[10px] text-muted-foreground/60 uppercase">
          {dbcEnabled && <span className="w-3 flex-shrink-0" />}
          <span className="w-10 sm:w-12 flex-shrink-0 text-right">ID</span>
          {dbcEnabled && <span className="hidden sm:block w-28 flex-shrink-0">Message</span>}
          <span className="hidden sm:block w-4 flex-shrink-0 text-center">L</span>
          <span className="flex-1">Data</span>
          <span className="hidden sm:block w-16 flex-shrink-0 text-right">Cycle</span>
          <span className="w-8 sm:w-12 flex-shrink-0 text-right">Cnt</span>
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
                  notchActive={notchActive}
                  notchBase={notchActive ? notchBaseline.get(id) : undefined}
                  notchChanged={notchActive ? changedSinceNotchById.get(id) : undefined}
                  notchNoise={notchActive ? noiseMask.get(id) : undefined}
                  notchCounts={notchActive ? changeCountSinceNotchById.get(id) : undefined}
                />
              )
            })}
          </div>
        )}
      </div>

      {/* Footer controls */}
      <div className="flex items-center gap-1.5 sm:gap-2 border-t border-border bg-card/50 px-2 sm:px-4 py-1.5">
        {!isRunning ? (
          <Button
            size="sm"
            onClick={start}
            disabled={isConnecting}
            className="gap-1.5 bg-success text-success-foreground hover:bg-success/90 h-7 text-xs px-2 sm:px-3"
          >
            <Play className="h-3 w-3" />
            <span className="hidden sm:inline">{isConnecting ? "Connexion..." : "Start"}</span>
            <span className="sm:hidden">{isConnecting ? "..." : "Go"}</span>
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              onClick={togglePause}
              className={cn(
                "gap-1.5 h-7 text-xs px-2 sm:px-3",
                isPaused
                  ? "bg-success text-success-foreground hover:bg-success/90"
                  : "bg-warning text-warning-foreground hover:bg-warning/90"
              )}
            >
              {isPaused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
              <span className="hidden sm:inline">{isPaused ? "Resume" : "Pause"}</span>
            </Button>
            <Button
              size="sm"
              onClick={stop}
              className="gap-1.5 bg-destructive text-destructive-foreground hover:bg-destructive/90 h-7 text-xs px-2 sm:px-3"
            >
              <Square className="h-3 w-3" />
              <span className="hidden sm:inline">Stop</span>
            </Button>
          </>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={clearFrames}
          className="gap-1.5 bg-transparent h-7 text-xs px-2 sm:px-3"
        >
          <Trash2 className="h-3 w-3" />
          <span className="hidden sm:inline">Clear</span>
        </Button>
        <div className="ml-auto flex items-center gap-1.5 sm:gap-3 text-[10px] sm:text-xs text-muted-foreground">
          {highlightChangesEnabled && changedOnlyMode && (
            <span className="text-warning font-medium">
              {filteredIds.length}
            </span>
          )}
          {dbcEnabled && dbcStats && (
            <span className={cn(
              "font-medium hidden sm:inline",
              dbcStats.percent >= 50 ? "text-success" : "text-warning"
            )}>
              {dbcStats.percent}% DBC
            </span>
          )}
          <span>{filteredIds.length !== sortedIds.length ? `${filteredIds.length}/` : ""}{sortedIds.length} IDs</span>
          <span className="hidden sm:inline">{totalMessages} msg</span>
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
