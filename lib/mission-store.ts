"use client"

/**
 * Mission Store
 * 
 * All mission data is stored on the Raspberry Pi filesystem.
 * This store communicates ONLY with the FastAPI backend.
 * NO mock data, NO localStorage, NO in-memory persistence.
 * 
 * Configure API URL via environment variable:
 * NEXT_PUBLIC_API_URL=http://192.168.1.100:8000
 */

import { create } from "zustand"

// API base URL - defaults to same origin in production
const API_BASE = process.env.NEXT_PUBLIC_API_URL || ""

export interface Vehicle {
  brand: string
  model: string
  year: number
  vin?: string
  fuel?: string
  engine?: string
  trim?: string
}

export interface CANConfig {
  interface: "can0" | "can1"
  bitrate: number
}

export interface Mission {
  id: string
  name: string
  notes?: string
  vehicle: Vehicle
  canConfig: CANConfig
  createdAt: string
  updatedAt: string
  logsCount: number
  framesCount: number
}

export interface MissionCreateInput {
  name: string
  notes?: string
  vehicle: Vehicle
  canConfig?: CANConfig
}

interface MissionStore {
  missions: Mission[]
  currentMissionId: string | null
  isLoading: boolean
  error: string | null
  
  // CRUD operations - all go to API
  fetchMissions: () => Promise<void>
  addMission: (mission: MissionCreateInput) => Promise<Mission | null>
  updateMission: (id: string, updates: Partial<MissionCreateInput>) => Promise<void>
  deleteMission: (id: string) => Promise<void>
  duplicateMission: (id: string) => Promise<Mission | null>
  
  // Local state only
  setCurrentMission: (id: string | null) => void
  getCurrentMission: () => Mission | null
  getMissionById: (id: string) => Mission | undefined
}

export const useMissionStore = create<MissionStore>((set, get) => ({
  missions: [],
  currentMissionId: null,
  isLoading: false,
  error: null,

  fetchMissions: async () => {
    set({ isLoading: true, error: null })
    try {
      const response = await fetch(`${API_BASE}/api/missions`, {
        signal: AbortSignal.timeout(5000),
      })
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
      
      const data = await response.json()
      set({ missions: data.missions || [], isLoading: false })
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erreur de connexion"
      set({ 
        error: `Impossible de récupérer les missions: ${message}`, 
        isLoading: false,
        missions: [],
      })
    }
  },

  addMission: async (missionData) => {
    set({ isLoading: true, error: null })
    try {
      const response = await fetch(`${API_BASE}/api/missions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: missionData.name,
          notes: missionData.notes,
          vehicle: missionData.vehicle,
          canConfig: missionData.canConfig || { interface: "can0", bitrate: 500000 },
        }),
      })
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
      
      const newMission = await response.json()
      set((state) => ({
        missions: [newMission, ...state.missions],
        isLoading: false,
      }))
      return newMission
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erreur de connexion"
      set({ error: `Impossible de créer la mission: ${message}`, isLoading: false })
      return null
    }
  },

  updateMission: async (id, updates) => {
    set({ error: null })
    try {
      const response = await fetch(`${API_BASE}/api/missions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      })
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
      
      const updatedMission = await response.json()
      set((state) => ({
        missions: state.missions.map((m) => (m.id === id ? updatedMission : m)),
      }))
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erreur de connexion"
      set({ error: `Impossible de mettre à jour la mission: ${message}` })
    }
  },

  deleteMission: async (id) => {
    set({ error: null })
    try {
      const response = await fetch(`${API_BASE}/api/missions/${id}`, {
        method: "DELETE",
      })
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
      
      set((state) => ({
        missions: state.missions.filter((m) => m.id !== id),
        currentMissionId: state.currentMissionId === id ? null : state.currentMissionId,
      }))
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erreur de connexion"
      set({ error: `Impossible de supprimer la mission: ${message}` })
    }
  },

  duplicateMission: async (id) => {
    set({ isLoading: true, error: null })
    try {
      const response = await fetch(`${API_BASE}/api/missions/${id}/duplicate`, {
        method: "POST",
      })
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
      
      const newMission = await response.json()
      set((state) => ({
        missions: [newMission, ...state.missions],
        isLoading: false,
      }))
      return newMission
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erreur de connexion"
      set({ error: `Impossible de dupliquer la mission: ${message}`, isLoading: false })
      return null
    }
  },

  setCurrentMission: (id) => {
    set({ currentMissionId: id })
  },

  getCurrentMission: () => {
    const { missions, currentMissionId } = get()
    return missions.find((m) => m.id === currentMissionId) ?? null
  },

  getMissionById: (id) => {
    const { missions } = get()
    return missions.find((m) => m.id === id)
  },
}))
