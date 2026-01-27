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

export const useMissionStore = create<MissionStore>((set, get) => ({
  missions: [],
  currentMissionId: null,
  isLoading: false,
  error: null,

  fetchMissions: async () => {
    set({ isLoading: true, error: null })
    try {
      const response = await fetch(`${getRaspberryPiUrl()}/api/missions`)
      if (!response.ok) throw new Error("Failed to fetch missions")
      const data = await response.json()
      const missions = data.missions.map(parseMissionDates)
      set({ missions, isLoading: false })
    } catch (error) {
      console.error("Failed to fetch missions:", error)
      set({ error: "Impossible de récupérer les missions", isLoading: false })
    }
  },

  addMission: async (missionData) => {
    set({ isLoading: true, error: null })
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
