/**
 * AURIGE API Client
 * Handles all communication with the FastAPI backend
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "/api"

// ============================================================================
// Types
// ============================================================================

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
  createdAt: string
  updatedAt: string
  lastActivity: string
  logsCount: number
  framesCount: number
  lastCaptureDate?: string
}

export interface MissionCreateInput {
  name: string
  notes?: string
  vehicle: Vehicle
  canInterface?: "can0" | "can1"
  bitrate?: number
}

export interface MissionUpdateInput {
  name?: string
  notes?: string
  vehicle?: Vehicle
  canInterface?: "can0" | "can1"
  bitrate?: number
}

export interface LogEntry {
  id: string
  missionId: string
  filename: string
  size: number
  framesCount: number
  createdAt: string
  durationSeconds?: number
  description?: string
}

export interface SystemStatus {
  wifiConnected: boolean
  ethernetConnected: boolean
  cpuUsage: number
  temperature: number
  memoryUsed: number
  memoryTotal: number
  storageUsed: number
  storageTotal: number
  uptimeSeconds: number
  can0Up: boolean
  can1Up: boolean
  vehicleConnected: boolean
  ecuResponding: boolean
  apiRunning: boolean
  webRunning: boolean
}

// ============================================================================
// API Functions
// ============================================================================

async function fetchApi<T>(
  endpoint: string,
  options?: RequestInit
): Promise<T> {
  const url = `${API_BASE}${endpoint}`
  
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: "Unknown error" }))
    throw new Error(error.detail || `API Error: ${response.status}`)
  }

  return response.json()
}

// ============================================================================
// System Status
// ============================================================================

export async function getSystemStatus(): Promise<SystemStatus> {
  return fetchApi<SystemStatus>("/status")
}

export async function checkHealth(): Promise<{ status: string; timestamp: string; version: string }> {
  return fetchApi("/health")
}

// ============================================================================
// Missions
// ============================================================================

export async function listMissions(): Promise<Mission[]> {
  return fetchApi<Mission[]>("/missions")
}

export async function getMission(id: string): Promise<Mission> {
  return fetchApi<Mission>(`/missions/${id}`)
}

export async function createMission(data: MissionCreateInput): Promise<Mission> {
  return fetchApi<Mission>("/missions", {
    method: "POST",
    body: JSON.stringify(data),
  })
}

export async function updateMission(id: string, data: MissionUpdateInput): Promise<Mission> {
  return fetchApi<Mission>(`/missions/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  })
}

export async function deleteMission(id: string): Promise<void> {
  await fetchApi(`/missions/${id}`, {
    method: "DELETE",
  })
}

export async function duplicateMission(id: string): Promise<Mission> {
  return fetchApi<Mission>(`/missions/${id}/duplicate`, {
    method: "POST",
  })
}

// ============================================================================
// Logs
// ============================================================================

export async function listMissionLogs(missionId: string): Promise<LogEntry[]> {
  return fetchApi<LogEntry[]>(`/missions/${missionId}/logs`)
}

export async function downloadLogUrl(missionId: string, logId: string): string {
  return `${API_BASE}/missions/${missionId}/logs/${logId}/download`
}

export async function deleteLog(missionId: string, logId: string): Promise<void> {
  await fetchApi(`/missions/${missionId}/logs/${logId}`, {
    method: "DELETE",
  })
}
