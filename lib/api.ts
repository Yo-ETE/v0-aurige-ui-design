/**
 * AURIGE API Client
 * 
 * All communication with the FastAPI backend goes through this client.
 * The frontend NEVER executes shell commands or accesses CAN directly.
 * All CAN operations are delegated to the backend.
 */

import { getApiBaseUrl, getWsBaseUrl } from "./api-config"

// =============================================================================
// Types
// =============================================================================

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

export interface MissionUpdateInput {
  name?: string
  notes?: string
  vehicle?: Vehicle
  canConfig?: CANConfig
}

export interface LogEntry {
  id: string
  filename: string
  size: number
  framesCount: number
  createdAt: string
  durationSeconds?: number
  description?: string
}

export interface SystemStatus {
  hostname: string
  uptimeSeconds: number
  cpuUsage: number
  temperature: number
  memoryUsed: number
  memoryTotal: number
  storageUsed: number
  storageTotal: number
  wifiConnected: boolean
  wifiIp?: string
  ethernetConnected: boolean
  ethernetIp?: string
  can0Up: boolean
  can0Bitrate?: number
  can1Up: boolean
  can1Bitrate?: number
  apiRunning: boolean
  webRunning: boolean
}

export interface CANInterfaceStatus {
  interface: string
  up: boolean
  bitrate?: number
  txPackets: number
  rxPackets: number
  errors: number
}

export interface CANFrame {
  interface: string
  canId: string
  data: string
}

export interface CaptureStatus {
  running: boolean
  filename?: string
  durationSeconds: number
}

export interface ProcessStatus {
  running: boolean
}

// WebSocket message from candump
export interface CANMessage {
  timestamp: string
  interface: string
  canId: string
  data: string
}

// =============================================================================
// API Fetch Helper
// =============================================================================

class APIError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = "APIError"
  }
}

async function fetchApi<T>(
  endpoint: string,
  options?: RequestInit
): Promise<T> {
  const url = `${getApiBaseUrl()}/api${endpoint}`
  
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: "Unknown error" }))
    throw new APIError(response.status, error.detail || `API Error: ${response.status}`)
  }

  // Handle empty responses
  const text = await response.text()
  if (!text) return {} as T
  
  return JSON.parse(text)
}

// =============================================================================
// System Status
// =============================================================================

export async function getSystemStatus(): Promise<SystemStatus> {
  return fetchApi<SystemStatus>("/status")
}

export async function checkHealth(): Promise<{ status: string; timestamp: string; version: string }> {
  return fetchApi("/health")
}

// =============================================================================
// CAN Interface Control
// =============================================================================

export async function getCANStatus(iface: "can0" | "can1"): Promise<CANInterfaceStatus> {
  return fetchApi<CANInterfaceStatus>(`/can/${iface}/status`)
}

export async function initializeCAN(iface: "can0" | "can1", bitrate: number): Promise<{ status: string }> {
  return fetchApi("/can/init", {
    method: "POST",
    body: JSON.stringify({ interface: iface, bitrate }),
  })
}

export async function stopCAN(iface: "can0" | "can1"): Promise<{ status: string }> {
  return fetchApi(`/can/stop?interface=${iface}`, {
    method: "POST",
  })
}

export async function sendCANFrame(frame: CANFrame): Promise<{ status: string }> {
  return fetchApi("/can/send", {
    method: "POST",
    body: JSON.stringify(frame),
  })
}

// =============================================================================
// Capture
// =============================================================================

export async function startCapture(
  missionId: string,
  iface: "can0" | "can1",
  filename?: string,
  description?: string
): Promise<{ status: string; filename: string }> {
  return fetchApi("/capture/start", {
    method: "POST",
    body: JSON.stringify({
      missionId,
      interface: iface,
      filename,
      description,
    }),
  })
}

export async function stopCapture(): Promise<{ status: string; filename?: string; durationSeconds: number }> {
  return fetchApi("/capture/stop", {
    method: "POST",
  })
}

export async function getCaptureStatus(): Promise<CaptureStatus> {
  return fetchApi<CaptureStatus>("/capture/status")
}

// =============================================================================
// Replay
// =============================================================================

export async function startReplay(
  missionId: string,
  logId: string,
  iface: "can0" | "can1",
  speed: number = 1.0
): Promise<{ status: string }> {
  return fetchApi("/replay/start", {
    method: "POST",
    body: JSON.stringify({
      missionId,
      logId,
      interface: iface,
      speed,
    }),
  })
}

export async function stopReplay(): Promise<{ status: string }> {
  return fetchApi("/replay/stop", {
    method: "POST",
  })
}

export async function getReplayStatus(): Promise<ProcessStatus> {
  return fetchApi<ProcessStatus>("/replay/status")
}

// =============================================================================
// Generator
// =============================================================================

export async function startGenerator(
  iface: "can0" | "can1",
  delayMs: number,
  dataLength: number,
  canId?: string
): Promise<{ status: string }> {
  return fetchApi("/generator/start", {
    method: "POST",
    body: JSON.stringify({
      interface: iface,
      delayMs,
      dataLength,
      canId,
    }),
  })
}

export async function stopGenerator(): Promise<{ status: string }> {
  return fetchApi("/generator/stop", {
    method: "POST",
  })
}

export async function getGeneratorStatus(): Promise<ProcessStatus> {
  return fetchApi<ProcessStatus>("/generator/status")
}

// =============================================================================
// Fuzzing
// =============================================================================

export async function startFuzzing(
  iface: "can0" | "can1",
  idStart: string,
  idEnd: string,
  dataTemplate: string,
  iterations: number,
  delayMs: number
): Promise<{ status: string }> {
  return fetchApi("/fuzzing/start", {
    method: "POST",
    body: JSON.stringify({
      interface: iface,
      idStart,
      idEnd,
      dataTemplate,
      iterations,
      delayMs,
    }),
  })
}

export async function stopFuzzing(): Promise<{ status: string }> {
  return fetchApi("/fuzzing/stop", {
    method: "POST",
  })
}

export async function getFuzzingStatus(): Promise<ProcessStatus> {
  return fetchApi<ProcessStatus>("/fuzzing/status")
}

// =============================================================================
// Sniffer
// =============================================================================

export async function startSniffer(iface: "can0" | "can1"): Promise<{ status: string }> {
  return fetchApi(`/sniffer/start?interface=${iface}`, {
    method: "POST",
  })
}

export async function stopSniffer(): Promise<{ status: string }> {
  return fetchApi("/sniffer/stop", {
    method: "POST",
  })
}

// =============================================================================
// Missions
// =============================================================================

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

// =============================================================================
// Logs
// =============================================================================

export async function listMissionLogs(missionId: string): Promise<LogEntry[]> {
  return fetchApi<LogEntry[]>(`/missions/${missionId}/logs`)
}

export function getLogDownloadUrl(missionId: string, logId: string): string {
  return `${getApiBaseUrl()}/api/missions/${missionId}/logs/${logId}/download`
}

export async function deleteLog(missionId: string, logId: string): Promise<void> {
  await fetchApi(`/missions/${missionId}/logs/${logId}`, {
    method: "DELETE",
  })
}

// =============================================================================
// OBD-II Diagnostics
// =============================================================================

export interface OBDResponse {
  status: "sent" | "success" | "error"
  message: string
  data?: string
  warning?: string
}

export async function requestVIN(iface: "can0" | "can1" = "can0"): Promise<OBDResponse> {
  return fetchApi<OBDResponse>("/obd/vin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ interface: iface }),
  })
}

export async function readDTCs(iface: "can0" | "can1" = "can0"): Promise<OBDResponse> {
  return fetchApi<OBDResponse>("/obd/dtc/read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ interface: iface }),
  })
}

export async function clearDTCs(iface: "can0" | "can1" = "can0"): Promise<OBDResponse> {
  return fetchApi<OBDResponse>("/obd/dtc/clear", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ interface: iface }),
  })
}

export async function resetECU(iface: "can0" | "can1" = "can0"): Promise<OBDResponse> {
  return fetchApi<OBDResponse>("/obd/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ interface: iface }),
  })
}

// =============================================================================
// WebSocket Helper
// =============================================================================

export function createCANWebSocket(
  iface: "can0" | "can1",
  onMessage: (msg: CANMessage) => void,
  onError?: (error: Event) => void,
  onClose?: () => void
): WebSocket {
  const wsBaseUrl = getWsBaseUrl()
  const ws = new WebSocket(`${wsBaseUrl}/ws/candump?interface=${iface}`)
  
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data) as CANMessage
      onMessage(msg)
    } catch {
      // Ignore parse errors
    }
  }
  
  if (onError) {
    ws.onerror = onError
  }
  
  if (onClose) {
    ws.onclose = onClose
  }
  
  return ws
}
