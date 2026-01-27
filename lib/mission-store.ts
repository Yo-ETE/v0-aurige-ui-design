"use client"

import { create } from "zustand"
import { getRaspberryPiUrl } from "./api-config"

export interface Vehicle {
  brand: string
  model: string
  year: number
  vin?: string
  fuel?: string
  engine?: string
  trim?: string
}

export interface Mission {
  id: string
  name: string
  notes?: string
  vehicle: Vehicle
  canInterface: "can0" | "can1"
  bitrate: number
  createdAt: Date
  updatedAt: Date
  lastActivity: Date
  logsCount: number
  framesCount: number
  lastCaptureDate?: Date
}

export interface MissionCreateInput {
  name: string
  notes?: string
  vehicle: Vehicle
  canInterface?: "can0" | "can1"
  bitrate?: number
}

interface MissionStore {
  missions: Mission[]
  currentMissionId: string | null
  isLoading: boolean
  error: string | null
  fetchMissions: () => Promise<void>
  addMission: (mission: MissionCreateInput) => Promise<Mission | null>
  updateMission: (id: string, updates: Partial<Omit<Mission, "id" | "createdAt">>) => Promise<void>
  updateMissionVehicle: (id: string, vehicle: Vehicle) => Promise<void>
  deleteMission: (id: string) => Promise<void>
  setCurrentMission: (id: string | null) => void
  getCurrentMission: () => Mission | null
  duplicateMission: (id: string) => Promise<Mission | null>
  getMissionById: (id: string) => Mission | undefined
}

// Helper to convert API dates to Date objects
function parseMissionDates(mission: Mission): Mission {
  return {
    ...mission,
    createdAt: new Date(mission.createdAt),
    updatedAt: new Date(mission.updatedAt),
    lastActivity: new Date(mission.lastActivity),
    lastCaptureDate: mission.lastCaptureDate ? new Date(mission.lastCaptureDate) : undefined,
  }
}

// Initial mock missions for demo/fallback when API is unavailable
const mockMissions: Mission[] = [
  {
    id: "1",
    name: "BMW Série 1 - Diagnostic ABS",
    notes: "Véhicule client - diagnostic ABS",
    vehicle: {
      brand: "BMW",
      model: "Série 1",
      year: 2019,
      vin: "WBA1234567890ABCD",
      fuel: "Diesel",
      engine: "2.0L 150ch",
    },
    canInterface: "can0",
    bitrate: 500000,
    createdAt: new Date("2025-01-15"),
    updatedAt: new Date("2025-01-27"),
    lastActivity: new Date("2025-01-27"),
    logsCount: 12,
    framesCount: 847,
    lastCaptureDate: new Date("2025-01-26"),
  },
  {
    id: "2",
    name: "Peugeot 308 - Analyse BSI",
    vehicle: {
      brand: "Peugeot",
      model: "308",
      year: 2021,
      fuel: "Essence",
    },
    canInterface: "can0",
    bitrate: 500000,
    createdAt: new Date("2025-01-20"),
    updatedAt: new Date("2025-01-22"),
    lastActivity: new Date("2025-01-22"),
    logsCount: 3,
    framesCount: 234,
  },
  {
    id: "3",
    name: "Renault Clio V - Test ECU",
    notes: "Test communication ECU moteur",
    vehicle: {
      brand: "Renault",
      model: "Clio V",
      year: 2022,
      vin: "VF1RJA00067890123",
      fuel: "Essence",
      engine: "1.0L TCe 100ch",
      trim: "Intens",
    },
    canInterface: "can1",
    bitrate: 250000,
    createdAt: new Date("2025-01-10"),
    updatedAt: new Date("2025-01-12"),
    lastActivity: new Date("2025-01-12"),
    logsCount: 5,
    framesCount: 412,
    lastCaptureDate: new Date("2025-01-11"),
  },
]

// Track if we're using mock mode (API unavailable)
let useMockMode = false

export const useMissionStore = create<MissionStore>((set, get) => ({
  missions: [],
  currentMissionId: null,
  isLoading: false,
  error: null,

  fetchMissions: async () => {
    set({ isLoading: true, error: null })
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 2000)
      
      const response = await fetch(`${getRaspberryPiUrl()}/api/missions`, {
        signal: controller.signal,
      })
      clearTimeout(timeoutId)
      
      if (!response.ok) throw new Error("Failed to fetch missions")
      const data = await response.json()
      const missions = data.missions.map(parseMissionDates)
      useMockMode = false
      set({ missions, isLoading: false })
    } catch {
      // Fallback to mock data when API is unavailable
      useMockMode = true
      set({ missions: mockMissions, isLoading: false, error: null })
    }
  },

  addMission: async (missionData) => {
    set({ isLoading: true, error: null })
    
    // If in mock mode, create locally
    if (useMockMode) {
      const now = new Date()
      const newMission: Mission = {
        id: crypto.randomUUID(),
        name: missionData.name,
        notes: missionData.notes,
        vehicle: missionData.vehicle,
        canInterface: missionData.canInterface ?? "can0",
        bitrate: missionData.bitrate ?? 500000,
        createdAt: now,
        updatedAt: now,
        lastActivity: now,
        logsCount: 0,
        framesCount: 0,
      }
      set((state) => ({
        missions: [newMission, ...state.missions],
        isLoading: false,
      }))
      return newMission
    }
    
    try {
      const response = await fetch(`${getRaspberryPiUrl()}/api/missions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(missionData),
      })
      if (!response.ok) throw new Error("Failed to create mission")
      const newMission = parseMissionDates(await response.json())
      set((state) => ({
        missions: [newMission, ...state.missions],
        isLoading: false,
      }))
      return newMission
    } catch (error) {
      console.error("Failed to create mission:", error)
      set({ error: "Impossible de créer la mission", isLoading: false })
      return null
    }
  },

  updateMission: async (id, updates) => {
    set({ error: null })
    
    // If in mock mode, update locally
    if (useMockMode) {
      set((state) => ({
        missions: state.missions.map((m) =>
          m.id === id ? { ...m, ...updates, updatedAt: new Date(), lastActivity: new Date() } : m
        ),
      }))
      return
    }
    
    try {
      const response = await fetch(`${getRaspberryPiUrl()}/api/missions/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      })
      if (!response.ok) throw new Error("Failed to update mission")
      const updatedMission = parseMissionDates(await response.json())
      set((state) => ({
        missions: state.missions.map((m) => (m.id === id ? updatedMission : m)),
      }))
    } catch (error) {
      console.error("Failed to update mission:", error)
      set({ error: "Impossible de mettre à jour la mission" })
    }
  },

  updateMissionVehicle: async (id, vehicle) => {
    await get().updateMission(id, { vehicle })
  },

  deleteMission: async (id) => {
    set({ error: null })
    
    // If in mock mode, delete locally
    if (useMockMode) {
      set((state) => ({
        missions: state.missions.filter((m) => m.id !== id),
        currentMissionId: state.currentMissionId === id ? null : state.currentMissionId,
      }))
      return
    }
    
    try {
      const response = await fetch(`${getRaspberryPiUrl()}/api/missions/${id}`, {
        method: "DELETE",
      })
      if (!response.ok) throw new Error("Failed to delete mission")
      set((state) => ({
        missions: state.missions.filter((m) => m.id !== id),
        currentMissionId: state.currentMissionId === id ? null : state.currentMissionId,
      }))
    } catch (error) {
      console.error("Failed to delete mission:", error)
      set({ error: "Impossible de supprimer la mission" })
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

  duplicateMission: async (id) => {
    const { missions, addMission } = get()
    const mission = missions.find((m) => m.id === id)
    if (!mission) return null
    
    return addMission({
      name: `${mission.name} (copie)`,
      notes: mission.notes,
      vehicle: { ...mission.vehicle },
      canInterface: mission.canInterface,
      bitrate: mission.bitrate,
    })
  },
}))
