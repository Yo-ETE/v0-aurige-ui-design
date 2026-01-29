"use client"

/**
 * Sniffer Store
 * 
 * Global state for the CAN sniffer terminal.
 * Persists WebSocket connection across page navigation.
 */

import { create } from "zustand"
import { createSnifferWebSocket, type CANMessage } from "./api"

export interface SnifferLine {
  id: number
  timestamp: string
  canId: string
  data: string
  dlc: number
  delta?: number
}

interface SnifferState {
  // Connection state
  isRunning: boolean
  isConnecting: boolean
  selectedInterface: "can0" | "can1"
  error: string | null
  
  // Terminal state
  lines: SnifferLine[]
  isPaused: boolean
  isMinimized: boolean
  isExpanded: boolean
  
  // WebSocket reference (not serialized)
  ws: WebSocket | null
  lineCounter: number
  lastTimestamp: number
  
  // Actions
  setInterface: (iface: "can0" | "can1") => void
  start: () => void
  stop: () => void
  togglePause: () => void
  toggleMinimize: () => void
  toggleExpand: () => void
  clearLines: () => void
}

const MAX_LINES = 500

export const useSnifferStore = create<SnifferState>((set, get) => ({
  isRunning: false,
  isConnecting: false,
  selectedInterface: "can0",
  error: null,
  lines: [],
  isPaused: false,
  isMinimized: false,
  isExpanded: false,
  ws: null,
  lineCounter: 0,
  lastTimestamp: 0,
  
  setInterface: (iface) => {
    const { isRunning, stop } = get()
    if (isRunning) {
      stop()
    }
    set({ selectedInterface: iface })
  },
  
  start: () => {
    const { selectedInterface, ws: existingWs } = get()
    
    // Close existing connection
    if (existingWs) {
      existingWs.close()
    }
    
    set({ isConnecting: true, error: null })
    
    try {
      const ws = createSnifferWebSocket(
        selectedInterface,
        (msg: CANMessage) => {
          const { isPaused, lines, lineCounter, lastTimestamp } = get()
          if (isPaused) return
          
          const now = msg.timestamp || Date.now() / 1000
          const delta = lastTimestamp > 0 ? Math.round((now - lastTimestamp) * 1000) : undefined
          
          const newLine: SnifferLine = {
            id: lineCounter + 1,
            timestamp: new Date(now * 1000).toISOString().substr(11, 12),
            canId: msg.canId,
            data: msg.data,
            dlc: msg.dlc,
            delta,
          }
          
          const newLines = [...lines, newLine].slice(-MAX_LINES)
          
          set({
            lines: newLines,
            lineCounter: lineCounter + 1,
            lastTimestamp: now,
          })
        },
        () => {
          set({
            error: "Connexion perdue avec le Raspberry Pi",
            isRunning: false,
            isConnecting: false,
          })
        },
        () => {
          set({ isRunning: false, isConnecting: false })
        }
      )
      
      ws.onopen = () => {
        set({
          isRunning: true,
          isConnecting: false,
          error: null,
          ws,
          lastTimestamp: 0,
        })
      }
      
      set({ ws })
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Impossible de demarrer le sniffer",
        isConnecting: false,
      })
    }
  },
  
  stop: () => {
    const { ws } = get()
    if (ws) {
      ws.close()
    }
    set({ ws: null, isRunning: false })
  },
  
  togglePause: () => set((state) => ({ isPaused: !state.isPaused })),
  
  toggleMinimize: () => set((state) => ({ isMinimized: !state.isMinimized })),
  
  toggleExpand: () => set((state) => ({ isExpanded: !state.isExpanded })),
  
  clearLines: () => set({ lines: [], lineCounter: 0, lastTimestamp: 0 }),
}))
