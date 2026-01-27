"use client"

import { create } from "zustand"

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
  addMission: (mission: MissionCreateInput) => Mission
  updateMission: (id: string, updates: Partial<Omit<Mission, "id" | "createdAt">>) => void
  updateMissionVehicle: (id: string, vehicle: Vehicle) => void
  deleteMission: (id: string) => void
  setCurrentMission: (id: string | null) => void
  getCurrentMission: () => Mission | null
  duplicateMission: (id: string) => Mission | null
  getMissionById: (id: string) => Mission | undefined
}

// Initial mock missions
const initialMissions: Mission[] = [
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

export const useMissionStore = create<MissionStore>((set, get) => ({
  missions: initialMissions,
  currentMissionId: null,

  addMission: (missionData) => {
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
    }))
    return newMission
  },

  updateMission: (id, updates) => {
    set((state) => ({
      missions: state.missions.map((m) =>
        m.id === id ? { ...m, ...updates, updatedAt: new Date(), lastActivity: new Date() } : m
      ),
    }))
  },

  updateMissionVehicle: (id, vehicle) => {
    set((state) => ({
      missions: state.missions.map((m) =>
        m.id === id ? { ...m, vehicle, updatedAt: new Date(), lastActivity: new Date() } : m
      ),
    }))
  },

  deleteMission: (id) => {
    set((state) => ({
      missions: state.missions.filter((m) => m.id !== id),
      currentMissionId: state.currentMissionId === id ? null : state.currentMissionId,
    }))
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

  duplicateMission: (id) => {
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
