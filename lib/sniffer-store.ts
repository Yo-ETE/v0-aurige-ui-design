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
    const { selectedInterface, ws: existingWs, isRunning, isConnecting } = get()
    
    // Prevent multiple starts
    if (isRunning || isConnecting) {
      console.log("[v0] Sniffer already running or connecting, ignoring start")
      return
    }
    
    // Close existing connection if any
    if (existingWs) {
      try {
        existingWs.close()
      } catch {
        // Ignore close errors on already closed socket
      }
      set({ ws: null })
    }
    
    set({ isConnecting: true, error: null })
    console.log("[v0] Starting sniffer on", selectedInterface)
    
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
        (err) => {
          console.log("[v0] Sniffer WebSocket error:", err)
          set({
            error: "Connexion perdue avec le Raspberry Pi",
            isRunning: false,
            isConnecting: false,
            ws: null,
          })
        },
        () => {
          console.log("[v0] Sniffer WebSocket closed")
          set({ isRunning: false, isConnecting: false, ws: null })
        }
      )
      
      ws.onopen = () => {
        console.log("[v0] Sniffer WebSocket connected")
        set({
          isRunning: true,
          isConnecting: false,
          error: null,
          ws,
          lastTimestamp: 0,
        })
      }
      
      // Also handle onerror in case connection fails immediately
      ws.onerror = (err) => {
        console.log("[v0] Sniffer WebSocket connection error:", err)
        set({
          error: "Impossible de se connecter au Raspberry Pi",
          isRunning: false,
          isConnecting: false,
          ws: null,
        })
      }
      
    } catch (err) {
      console.log("[v0] Sniffer start exception:", err)
      set({
        error: err instanceof Error ? err.message : "Impossible de demarrer le sniffer",
        isConnecting: false,
        ws: null,
      })
    }
  },
  
  stop: () => {
    const { ws } = get()
    console.log("[v0] Stopping sniffer")
    if (ws) {
      try {
        ws.close()
      } catch {
        // Ignore close errors
      }
    }
    set({ ws: null, isRunning: false, isConnecting: false })
  },
  
  togglePause: () => set((state) => ({ isPaused: !state.isPaused })),
  
  toggleMinimize: () => set((state) => ({ isMinimized: !state.isMinimized })),
  
  toggleExpand: () => set((state) => ({ isExpanded: !state.isExpanded })),
  
  clearLines: () => set({ lines: [], lineCounter: 0, lastTimestamp: 0 }),
}))
