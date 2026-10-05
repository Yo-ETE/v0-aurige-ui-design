"use client"

/**
 * Sniffer Store
 * 
 * Global state for the CAN sniffer terminal.
 * Persists WebSocket connection across page navigation.
 * 
 * Mode cansniffer: one fixed row per CAN ID, colored changing bytes.
 */

import { create } from "zustand"
import { createSnifferWebSocket, getCANStatus, getMissionDBC, type CANMessage, type DBCSignal } from "./api"

/** A signal decoded from raw bytes using DBC definition */
export interface DecodedSignal {
  name: string
  value: number
  unit: string
  rawHex: string
}

/** DBC message info cached for fast lookup */
export interface DbcLookupEntry {
  messageName: string
  dlc: number
  signals: DBCSignal[]
}

export interface SnifferFrame {
  canId: string
  /** Current data bytes as hex string array, e.g. ["0A","FF","00",...] */
  bytes: string[]
  /** Previous data bytes for change detection */
  prevBytes: string[]
  /** Which byte indices changed on last update */
  changedIndices: Set<number>
  /** Timestamp of last reception */
  lastTimestamp: string
  /** Reception count */
  count: number
  /** Delta ms between last two receptions */
  deltaMs: number
  /** DLC */
  dlc: number
  /** Cycle time (ms) - rolling average */
  cycleMs: number
  /** Last raw timestamp for delta calculation */
  _lastRawTs: number
  /** Payload changed flag (for flash animation) */
  payloadChanged: boolean
  /** Number of bytes that changed */
  deltaBytes: number
  /** Timestamp when payload changed */
  changedAt: number
  /** Noisy flag (changes too frequently) */
  isNoisy: boolean
  /** Changed signal names (DBC-level detection) */
  changedSignalNames: string[]
  /** Signal values changed (more precise than payload) */
  signalChanged: boolean
}

interface SnifferState {
  // Connection state
  isRunning: boolean
  isConnecting: boolean
  selectedInterface: "can0" | "can1" | "vcan0"
  error: string | null
  
  // Frame map keyed by CAN ID (cansniffer mode)
  frameMap: Map<string, SnifferFrame>
  /** Sorted IDs cache for rendering */
  sortedIds: string[]
  
  // Filter
  idFilter: string
  
  // DBC overlay
  dbcEnabled: boolean
  dbcLookup: Map<string, DbcLookupEntry>
  dbcMissionId: string | null
  dbcLoading: boolean
  dbcFilter: "all" | "dbc" | "unknown"
  
  // Change tracking (for flash animation)
  highlightChangesEnabled: boolean
  changedOnlyMode: boolean
  changedWindowMs: number
  highlightMode: "payload" | "signal" | "both"
  ignoreNoisy: boolean
  lastPayloadById: Map<string, string>
  lastDecodedSignalsById: Map<string, Record<string, number>>
  changeCountById: Map<string, { count: number; lastResetTs: number }>
  
  // Notch (freeze reference) workflow
  notchActive: boolean
  /** Reference bytes per ID captured when the notch was set */
  notchBaseline: Map<string, string[]>
  /** Byte indices absorbed as background noise, per ID */
  noiseMask: Map<string, Set<number>>
  /** Persistent: byte indices that differed from baseline since notch (excluding noise) */
  changedSinceNotchById: Map<string, Set<number>>
  /** Per-byte number of change events vs baseline since notch */
  changeCountSinceNotchById: Map<string, number[]>
  
  // Terminal state
  isPaused: boolean
  isMinimized: boolean
  isExpanded: boolean
  totalMessages: number
  
  // WebSocket reference (not serialized)
  ws: WebSocket | null
  
  // Actions
  setInterface: (iface: "can0" | "can1" | "vcan0") => void
  setIdFilter: (filter: string) => void
  start: () => Promise<void>
  stop: () => void
  togglePause: () => void
  toggleMinimize: () => void
  toggleExpand: () => void
  clearFrames: () => void
  toggleDbcOverlay: () => void
  loadDbc: (missionId: string) => Promise<void>
  setDbcFilter: (filter: "all" | "dbc" | "unknown") => void
  decodeSignals: (canId: string, bytes: string[]) => DecodedSignal[]
  toggleHighlightChanges: () => void
  toggleChangedOnly: () => void
  setChangedWindow: (ms: number) => void
  setHighlightMode: (mode: "payload" | "signal" | "both") => void
  toggleIgnoreNoisy: () => void
  setNotch: () => void
  clearNotch: () => void
  absorbNoise: () => void
}

export const useSnifferStore = create<SnifferState>((set, get) => ({
  isRunning: false,
  isConnecting: false,
  selectedInterface: "can1",
  error: null,
  frameMap: new Map(),
  sortedIds: [],
  idFilter: "",
  dbcEnabled: false,
  dbcLookup: new Map(),
  dbcMissionId: null,
  dbcLoading: false,
  dbcFilter: "all",
  highlightChangesEnabled: true,
  changedOnlyMode: false,
  changedWindowMs: 5000,
  highlightMode: "both",
  ignoreNoisy: true,
  lastPayloadById: new Map(),
  lastDecodedSignalsById: new Map(),
  changeCountById: new Map(),
  notchActive: false,
  notchBaseline: new Map(),
  noiseMask: new Map(),
  changedSinceNotchById: new Map(),
  changeCountSinceNotchById: new Map(),
  isPaused: false,
  isMinimized: false,
  isExpanded: false,
  totalMessages: 0,
  ws: null,
  
  setInterface: (iface) => {
    const { isRunning, stop } = get()
    if (isRunning) {
      stop()
    }
    set({
      selectedInterface: iface,
      notchActive: false,
      notchBaseline: new Map(),
      noiseMask: new Map(),
      changedSinceNotchById: new Map(),
      changeCountSinceNotchById: new Map(),
    })
  },
  
  setIdFilter: (filter) => set({ idFilter: filter }),
  
  start: async () => {
    const { selectedInterface, ws: existingWs, isRunning, isConnecting } = get()
    
    if (isRunning || isConnecting) return
    
    if (existingWs) {
      try { existingWs.close() } catch { /* ignore */ }
      set({ ws: null })
    }
    
    // Nouvelle connexion : buffers vides
    resetBuffers()
    set({
      isConnecting: true,
      error: null,
      notchActive: false,
      notchBaseline: new Map(),
      noiseMask: new Map(),
      changedSinceNotchById: new Map(),
      changeCountSinceNotchById: new Map(),
    })
    
    try {
      const status = await getCANStatus(selectedInterface)
      if (!status.up) {
        set({
          error: `Interface ${selectedInterface} n'est pas initialisee. Allez dans Controle CAN pour l'activer.`,
          isConnecting: false,
        })
        return
      }
    } catch {
      set({
        error: `Impossible de verifier l'etat de ${selectedInterface}. Verifiez la connexion au Raspberry Pi.`,
        isConnecting: false,
      })
      return
    }
    
    try {
      const ws = createSnifferWebSocket(
        selectedInterface,
        (msg: CANMessage) => {
          // Callback leger : on bufferise, le flush (rAF) fait le travail
          if (get().isPaused) return
          bufferMessage(msg)
        },
        () => {
          set({
            error: "Connexion perdue avec le Raspberry Pi",
            isRunning: false,
            isConnecting: false,
            ws: null,
          })
        },
        () => {
          set({ isRunning: false, isConnecting: false, ws: null })
        }
      )
      
      ws.onopen = () => {
        set({
          isRunning: true,
          isConnecting: false,
          error: null,
          ws,
        })
      }
      
      ws.onerror = () => {
        set({
          error: "Impossible de se connecter au Raspberry Pi",
          isRunning: false,
          isConnecting: false,
          ws: null,
        })
      }
      
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Impossible de demarrer le sniffer",
        isConnecting: false,
        ws: null,
      })
    }
  },
  
  stop: () => {
    resetBuffers()
    const { ws } = get()
    if (ws) {
      try { ws.close() } catch { /* ignore */ }
    }
    set({ ws: null, isRunning: false, isConnecting: false })
  },
  
  togglePause: () => set((state) => ({ isPaused: !state.isPaused })),
  
  toggleMinimize: () => set((state) => ({ isMinimized: !state.isMinimized })),
  
  toggleExpand: () => set((state) => ({ isExpanded: !state.isExpanded })),
  
  clearFrames: () => {
    resetBuffers()
    set({
      frameMap: new Map(),
      sortedIds: [],
      totalMessages: 0,
      // Baseline refers to cleared frames: drop the notch with them
      notchActive: false,
      notchBaseline: new Map(),
      noiseMask: new Map(),
      changedSinceNotchById: new Map(),
      changeCountSinceNotchById: new Map(),
    })
  },
  
  toggleDbcOverlay: () => set((state) => ({ dbcEnabled: !state.dbcEnabled })),
  
  setDbcFilter: (filter) => set({ dbcFilter: filter }),
  
  loadDbc: async (missionId: string) => {
    if (get().dbcMissionId === missionId && get().dbcLookup.size > 0) return
    set({ dbcLoading: true })
    try {
      const data = await getMissionDBC(missionId)
      const lookup = new Map<string, DbcLookupEntry>()
      for (const msg of data.messages) {
        // Strip "0x" or "0X" prefix and normalize to uppercase
        const normalizedId = msg.can_id.replace(/^0[xX]/, "").toUpperCase()
        lookup.set(normalizedId, {
          messageName: msg.name || `MSG_${msg.can_id}`,
          dlc: msg.dlc || 8,
          signals: msg.signals || [],
        })
      }
      set({ dbcLookup: lookup, dbcMissionId: missionId, dbcLoading: false })
    } catch (err) {
      console.error("Failed to load DBC for sniffer:", err)
      set({ dbcLoading: false })
    }
  },
  
  decodeSignals: (canId: string, bytes: string[]): DecodedSignal[] => {
    const { dbcLookup } = get()
    const entry = dbcLookup.get(canId.toUpperCase())
    if (!entry || !entry.signals.length) return []
    
    // Build a numeric value from the bytes for signal extraction
    const decoded: DecodedSignal[] = []
    for (const sig of entry.signals) {
      try {
        // Simple extraction: little-endian, bit-level
        const startByte = Math.floor(sig.start_bit / 8)
        const startBitInByte = sig.start_bit % 8
        
        let rawValue = 0
        if (sig.byte_order === "little_endian") {
          // Extract bits from LSB
          let bitsRead = 0
          let bitPos = sig.start_bit
          while (bitsRead < sig.length && Math.floor(bitPos / 8) < bytes.length) {
            const byteIdx = Math.floor(bitPos / 8)
            const bitIdx = bitPos % 8
            const byteVal = parseInt(bytes[byteIdx] || "0", 16)
            const bit = (byteVal >> bitIdx) & 1
            rawValue |= (bit << bitsRead)
            bitsRead++
            bitPos++
          }
        } else {
          // Big-endian (Motorola) - simplified
          const byteVal = parseInt(bytes[startByte] || "0", 16)
          rawValue = (byteVal >> startBitInByte) & ((1 << sig.length) - 1)
        }
        
        // Handle signed values
        if (sig.is_signed && rawValue >= (1 << (sig.length - 1))) {
          rawValue -= (1 << sig.length)
        }
        
        const physValue = rawValue * sig.scale + sig.offset
        const rawHex = bytes.slice(startByte, startByte + Math.ceil(sig.length / 8)).join("")
        
        decoded.push({
          name: sig.name,
          value: Math.round(physValue * 1000) / 1000,
          unit: sig.unit || "",
          rawHex,
        })
      } catch {
        // Skip signals that fail to decode
      }
    }
    return decoded
  },
  
  toggleHighlightChanges: () => set((state) => ({ highlightChangesEnabled: !state.highlightChangesEnabled })),
  
  toggleChangedOnly: () => set((state) => ({ changedOnlyMode: !state.changedOnlyMode })),
  
  setChangedWindow: (ms: number) => set({ changedWindowMs: ms }),
  
  setHighlightMode: (mode) => set({ highlightMode: mode }),
  
  toggleIgnoreNoisy: () => set((state) => ({ ignoreNoisy: !state.ignoreNoisy })),

  setNotch: () => {
    const { frameMap } = get()
    const baseline = new Map<string, string[]>()
    for (const [id, frame] of frameMap) {
      baseline.set(id, frame.bytes.slice())
    }
    set({
      notchActive: true,
      notchBaseline: baseline,
      noiseMask: new Map(),
      changedSinceNotchById: new Map(),
      changeCountSinceNotchById: new Map(),
    })
  },
  
  clearNotch: () => set({
    notchActive: false,
    notchBaseline: new Map(),
    noiseMask: new Map(),
    changedSinceNotchById: new Map(),
    changeCountSinceNotchById: new Map(),
  }),
  
  absorbNoise: () => {
    const { notchActive, noiseMask, changedSinceNotchById, changeCountSinceNotchById } = get()
    if (!notchActive) return
    const newMask = new Map<string, Set<number>>()
    for (const [id, set_] of noiseMask) newMask.set(id, new Set(set_))
    const newCounts = new Map<string, number[]>()
    for (const [id, arr] of changeCountSinceNotchById) newCounts.set(id, arr.slice())
    for (const [id, changed] of changedSinceNotchById) {
      let mask = newMask.get(id)
      if (!mask) {
        mask = new Set<number>()
        newMask.set(id, mask)
      }
      const counts = newCounts.get(id)
      for (const i of changed) {
        mask.add(i)
        if (counts) counts[i] = 0
      }
    }
    set({
      noiseMask: newMask,
      changedSinceNotchById: new Map(),
      changeCountSinceNotchById: newCounts,
    })
  },
}))

// ---------------------------------------------------------------------------
// Batching : le WS envoie 1 message par trame (~430/s sur bus charge). On
// bufferise hors store et on ne fait qu'un seul set() par frame d'animation.
// ---------------------------------------------------------------------------
const MAX_PENDING = 5000
let _pending: CANMessage[] = []
let _rafId: number | ReturnType<typeof setTimeout> | null = null
let _usingRaf = false

function scheduleFlush() {
  if (_rafId != null) return
  if (typeof requestAnimationFrame !== "undefined") {
    _usingRaf = true
    _rafId = requestAnimationFrame(flushPending)
  } else {
    _usingRaf = false
    _rafId = setTimeout(flushPending, 16)
  }
}

function resetBuffers() {
  if (_rafId != null) {
    if (_usingRaf && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(_rafId as number)
    } else {
      clearTimeout(_rafId as ReturnType<typeof setTimeout>)
    }
  }
  _rafId = null
  _pending = []
}

function bufferMessage(msg: CANMessage) {
  _pending.push(msg)
  // Garde-fou : on conserve les trames les plus recentes
  if (_pending.length > MAX_PENDING) _pending = _pending.slice(-MAX_PENDING)
  scheduleFlush()
}

/** Traite tout le buffer en une passe puis fait un seul set() */
function flushPending() {
  _rafId = null
  const batch = _pending
  _pending = []
  if (batch.length === 0) return

  const store = useSnifferStore.getState()
  // Pause entre-temps : on jette le lot (comportement identique a l'ancien early-return)
  if (store.isPaused) return
  const {
    frameMap,
    sortedIds,
    totalMessages,
    lastPayloadById,
    lastDecodedSignalsById,
    changeCountById,
    highlightChangesEnabled,
    highlightMode,
    dbcEnabled,
    dbcLookup,
    notchActive,
    notchBaseline,
    noiseMask,
    changedSinceNotchById,
    changeCountSinceNotchById,
  } = store

  // Copie de travail unique, mutee en place pour tout le lot
  const newMap = new Map(frameMap)
  let newIdAppeared = false

  for (const msg of batch) {
    const id = msg.canId.toUpperCase()
    const newBytes = (msg.data || "").match(/.{1,2}/g) || []
    const now = typeof msg.timestamp === "number" 
      ? msg.timestamp 
      : Date.now() / 1000
    const nowMs = now * 1000
    const ts = new Date(nowMs).toISOString().substr(11, 12)
    
    const existing = newMap.get(id)
    
    // Byte-level change detection (for coloring)
    const changedIndices = new Set<number>()
    if (existing) {
      for (let i = 0; i < newBytes.length; i++) {
        if (existing.bytes[i] !== newBytes[i]) {
          changedIndices.add(i)
        }
      }
    }
    
    // Payload-level change detection (for flash animation)
    const payloadHex = newBytes.join("")
    const prevPayloadHex = lastPayloadById.get(id)
    let payloadChanged = false
    let deltaBytes = 0
    let isNoisy = false
    
    if (highlightChangesEnabled && prevPayloadHex !== undefined) {
      if (prevPayloadHex !== payloadHex) {
        payloadChanged = true
        // Count how many bytes changed
        const prevBytesArr = prevPayloadHex.match(/.{1,2}/g) || []
        const maxLen = Math.max(newBytes.length, prevBytesArr.length)
        for (let i = 0; i < maxLen; i++) {
          const a = newBytes[i] || ""
          const b = prevBytesArr[i] || ""
          if (a !== b) deltaBytes++
        }
        
        // Track change frequency for noise detection
        const changeStats = changeCountById.get(id) || { count: 0, lastResetTs: nowMs }
        const timeSinceReset = nowMs - changeStats.lastResetTs
        
        if (timeSinceReset > 1000) {
          // Reset counter every second
          changeCountById.set(id, { count: 1, lastResetTs: nowMs })
        } else {
          const newCount = changeStats.count + 1
          changeCountById.set(id, { count: newCount, lastResetTs: changeStats.lastResetTs })
          // Mark as noisy if > 10 changes per second
          if (newCount > 10) {
            isNoisy = true
          }
        }
      }
    }
    
    // Signal-level change detection (DBC-aware)
    let signalChanged = false
    const changedSignalNames: string[] = []
    
    if (highlightChangesEnabled && dbcEnabled && (highlightMode === "signal" || highlightMode === "both")) {
      const dbcEntry = dbcLookup.get(id)
      if (dbcEntry && dbcEntry.signals.length > 0) {
        // Decode current signals
        const currentSignals: Record<string, number> = {}
        const decoded = store.decodeSignals(id, newBytes)
        for (const sig of decoded) {
          currentSignals[sig.name] = sig.value
        }
        
        // Compare with previous
        const prevSignals = lastDecodedSignalsById.get(id)
        if (prevSignals) {
          for (const sigName in currentSignals) {
            const curr = currentSignals[sigName]
            const prev = prevSignals[sigName]
            if (prev !== undefined && curr !== prev) {
              signalChanged = true
              changedSignalNames.push(sigName)
            }
          }
        }
        
        // Update memory
        lastDecodedSignalsById.set(id, currentSignals)
      }
    }
    
    // Determine final change status based on mode
    let finalPayloadChanged = false
    if (highlightMode === "payload") {
      finalPayloadChanged = payloadChanged
    } else if (highlightMode === "signal") {
      finalPayloadChanged = signalChanged
    } else {
      // both
      finalPayloadChanged = payloadChanged || signalChanged
    }
    
    // Update payload memory
    lastPayloadById.set(id, payloadHex)
    
    const deltaMs = existing && existing._lastRawTs > 0
      ? Math.round((now - existing._lastRawTs) * 1000)
      : 0
    
    const prevCycle = existing?.cycleMs || 0
    const cycleMs = prevCycle > 0
      ? Math.round(prevCycle * 0.7 + deltaMs * 0.3)
      : deltaMs
    
    const newFrame: SnifferFrame = {
      canId: id,
      bytes: newBytes,
      prevBytes: existing ? existing.bytes : newBytes,
      changedIndices,
      lastTimestamp: ts,
      count: (existing?.count || 0) + 1,
      deltaMs,
      dlc: newBytes.length,
      cycleMs,
      _lastRawTs: now,
      payloadChanged: finalPayloadChanged,
      deltaBytes,
      changedAt: finalPayloadChanged ? nowMs : (existing?.changedAt || 0),
      isNoisy,
      changedSignalNames,
      signalChanged,
    }
    
    // Notch tracking: O(dlc) per frame, maps mutated in place (keyed by id)
    if (notchActive) {
      const base = notchBaseline.get(id)
      if (!base) {
        // ID appeared after the notch: its first frame is the reference
        notchBaseline.set(id, newBytes)
      } else {
        const noise = noiseMask.get(id)
        let changedSet = changedSinceNotchById.get(id)
        let counts = changeCountSinceNotchById.get(id)
        for (let i = 0; i < newBytes.length; i++) {
          if (newBytes[i] === base[i]) continue
          if (noise && noise.has(i)) continue
          if (!changedSet) {
            changedSet = new Set<number>()
            changedSinceNotchById.set(id, changedSet)
          }
          if (!counts) {
            counts = []
            changeCountSinceNotchById.set(id, counts)
          }
          changedSet.add(i)
          // Count real transitions only (not every frame differing from baseline)
          if (existing && existing.bytes[i] !== newBytes[i]) {
            counts[i] = (counts[i] || 0) + 1
          } else if (counts[i] === undefined) {
            counts[i] = 1
          }
        }
      }
    }
    

    newMap.set(id, newFrame)
    if (!existing) newIdAppeared = true
  }

  // Re-tri uniquement si un nouvel ID est apparu
  let newSortedIds = sortedIds
  if (newIdAppeared) {
    newSortedIds = Array.from(newMap.keys()).sort((a, b) => {
      const numA = parseInt(a, 16)
      const numB = parseInt(b, 16)
      return numA - numB
    })
  }

  useSnifferStore.setState({
    frameMap: newMap,
    sortedIds: newSortedIds,
    totalMessages: totalMessages + batch.length,
    lastPayloadById,
    lastDecodedSignalsById,
    changeCountById,
  })
}
