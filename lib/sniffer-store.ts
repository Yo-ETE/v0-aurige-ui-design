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
import { createSnifferWebSocket, getCANStatus, type CANMessage } from "./api"

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
  
  // Terminal state
  isPaused: boolean
  isMinimized: boolean
  isExpanded: boolean
  totalMessages: number
  
  // WebSocket reference (not serialized)
  ws: WebSocket | null
  
  // Actions
  setInterface: (iface: "can0" | "can1" | "vcan0") => void
  start: () => Promise<void>
  stop: () => void
  togglePause: () => void
  toggleMinimize: () => void
  toggleExpand: () => void
  clearFrames: () => void
}

export const useSnifferStore = create<SnifferState>((set, get) => ({
  isRunning: false,
  isConnecting: false,
  selectedInterface: "can1",
  error: null,
  frameMap: new Map(),
  sortedIds: [],
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
    set({ selectedInterface: iface })
  },
  
  start: async () => {
    const { selectedInterface, ws: existingWs, isRunning, isConnecting } = get()
    
    if (isRunning || isConnecting) return
    
    if (existingWs) {
      try { existingWs.close() } catch { /* ignore */ }
      set({ ws: null })
    }
    
    set({ isConnecting: true, error: null })
    
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
          const { isPaused, frameMap, sortedIds, totalMessages } = get()
          if (isPaused) return
          
          const id = msg.canId.toUpperCase()
          const newBytes = (msg.data || "").match(/.{1,2}/g) || []
          const now = typeof msg.timestamp === "number" 
            ? msg.timestamp 
            : Date.now() / 1000
          const ts = new Date(now * 1000).toISOString().substr(11, 12)
          
          const existing = frameMap.get(id)
          
          const changedIndices = new Set<number>()
          if (existing) {
            for (let i = 0; i < newBytes.length; i++) {
              if (existing.bytes[i] !== newBytes[i]) {
                changedIndices.add(i)
              }
            }
          }
          
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
          }
          
          const newMap = new Map(frameMap)
          newMap.set(id, newFrame)
          
          // Only re-sort if new ID appeared
          let newSortedIds = sortedIds
          if (!existing) {
            newSortedIds = Array.from(newMap.keys()).sort((a, b) => {
              const numA = parseInt(a, 16)
              const numB = parseInt(b, 16)
              return numA - numB
            })
          }
          
          set({
            frameMap: newMap,
            sortedIds: newSortedIds,
            totalMessages: totalMessages + 1,
          })
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
    const { ws } = get()
    if (ws) {
      try { ws.close() } catch { /* ignore */ }
    }
    set({ ws: null, isRunning: false, isConnecting: false })
  },
  
  togglePause: () => set((state) => ({ isPaused: !state.isPaused })),
  
  toggleMinimize: () => set((state) => ({ isMinimized: !state.isMinimized })),
  
  toggleExpand: () => set((state) => ({ isExpanded: !state.isExpanded })),
  
  clearFrames: () => set({ frameMap: new Map(), sortedIds: [], totalMessages: 0 }),
}))
