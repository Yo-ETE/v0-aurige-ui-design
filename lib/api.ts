/**
 * AURIGE API Client
 * 
 * This module handles ALL communication with the FastAPI backend.
 * The frontend NEVER executes CAN commands directly - all operations
 * go through these API functions.
 * 
 * Architecture:
 * - REST API for CRUD operations and commands
 * - WebSocket for real-time CAN streaming
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "/api"
const WS_BASE = process.env.NEXT_PUBLIC_WS_URL || 
  (typeof window !== "undefined" 
    ? `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`
    : "ws://localhost:8000")

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

export interface CANConfig {
  interface: string
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
  missionId: string
  filename: string
  size: number
  framesCount: number
  createdAt: string
  durationSeconds?: number
  description?: string
}

export interface CANInterfaceInfo {
  name: string
  isUp: boolean
  bitrate?: number
  txPackets: number
  rxPackets: number
  txErrors: number
  rxErrors: number
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
  ethernetConnected: boolean
  canInterfaces: CANInterfaceInfo[]
  apiVersion: string
}

export interface CANFrame {
  timestamp: string
  interface: string
  canId: string
  data: string
  delta: string
}

// ============================================================================
// API Fetch Helper
// ============================================================================

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
    throw new APIError(response.status, error.detail || `API Error: ${response.status}`)
  }

  // Handle empty responses
  const text = await response.text()
  if (!text) return {} as T
  
  return JSON.parse(text)
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
// CAN Interface Control
// ============================================================================

export async function setupCANInterface(
  interfaceName: string,
  bitrate: number
): Promise<{ status: string; interface: string; bitrate: number; isUp: boolean }> {
  return fetchApi("/can/setup", {
    method: "POST",
    body: JSON.stringify({ interface: interfaceName, bitrate }),
  })
}

export async function bringCANDown(
  interfaceName: string
): Promise<{ status: string; interface: string }> {
  return fetchApi(`/can/down?interface=${encodeURIComponent(interfaceName)}`, {
    method: "POST",
  })
}

export async function sendCANFrame(
  interfaceName: string,
  canId: string,
  data: string
): Promise<{ status: string; interface: string; canId: string; data: string }> {
  return fetchApi("/can/send", {
    method: "POST",
    body: JSON.stringify({ interface: interfaceName, canId, data }),
  })
}

// ============================================================================
// Capture Control
// ============================================================================

export interface CaptureStartResponse {
  status: string
  captureId: string
  interface: string
  filename: string
}

export async function startCapture(
  interfaceName: string,
  missionId: string,
  filename: string
): Promise<CaptureStartResponse> {
  return fetchApi("/can/capture/start", {
    method: "POST",
    body: JSON.stringify({ interface: interfaceName, missionId, filename }),
  })
}

export async function stopCapture(captureId: string): Promise<{ status: string; captureId: string }> {
  return fetchApi(`/can/capture/stop?capture_id=${encodeURIComponent(captureId)}`, {
    method: "POST",
  })
}

// ============================================================================
// Replay Control
// ============================================================================

export interface ReplayStartResponse {
  status: string
  replayId: string
  interface: string
  filename: string
  speed: number
  loop: boolean
}

export async function startReplay(
  missionId: string,
  filename: string,
  interfaceName: string,
  speed: number = 1.0,
  loop: boolean = false
): Promise<ReplayStartResponse> {
  return fetchApi("/can/replay/start", {
    method: "POST",
    body: JSON.stringify({ missionId, filename, interface: interfaceName, speed, loop }),
  })
}

export async function stopReplay(replayId: string): Promise<{ status: string; replayId: string }> {
  return fetchApi(`/can/replay/stop?replay_id=${encodeURIComponent(replayId)}`, {
    method: "POST",
  })
}

// ============================================================================
// Generator Control
// ============================================================================

export interface GeneratorStartResponse {
  status: string
  generatorId: string
  interface: string
}

export async function startGenerator(
  interfaceName: string,
  options: {
    canId?: string
    dataLength?: number
    gapMs?: number
    burstCount?: number
  } = {}
): Promise<GeneratorStartResponse> {
  return fetchApi("/can/generator/start", {
    method: "POST",
    body: JSON.stringify({
      interface: interfaceName,
      canId: options.canId,
      dataLength: options.dataLength ?? 8,
      gapMs: options.gapMs ?? 100,
      burstCount: options.burstCount,
    }),
  })
}

export async function stopGenerator(generatorId: string): Promise<{ status: string; generatorId: string }> {
  return fetchApi(`/can/generator/stop?generator_id=${encodeURIComponent(generatorId)}`, {
    method: "POST",
  })
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

export function getLogDownloadUrl(missionId: string, logId: string): string {
  return `${API_BASE}/missions/${missionId}/logs/${logId}/download`
}

export async function deleteLog(missionId: string, logId: string): Promise<void> {
  await fetchApi(`/missions/${missionId}/logs/${logId}`, {
    method: "DELETE",
  })
}

// ============================================================================
// WebSocket - Real-time CAN Streaming
// ============================================================================

export type CANStreamCallback = (frame: CANFrame) => void
export type CANStreamErrorCallback = (error: string) => void
export type CANStreamStatusCallback = (status: "connected" | "disconnected") => void

export interface CANStreamOptions {
  interface: string
  onFrame: CANStreamCallback
  onError?: CANStreamErrorCallback
  onStatus?: CANStreamStatusCallback
}

export class CANStreamClient {
  private ws: WebSocket | null = null
  private options: CANStreamOptions
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectTimeout: NodeJS.Timeout | null = null

  constructor(options: CANStreamOptions) {
    this.options = options
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return
    }

    const wsUrl = `${WS_BASE}/ws/candump?interface=${encodeURIComponent(this.options.interface)}`
    
    try {
      this.ws = new WebSocket(wsUrl)

      this.ws.onopen = () => {
        this.reconnectAttempts = 0
        this.options.onStatus?.("connected")
      }

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data)
          
          if (message.type === "frame") {
            this.options.onFrame(message.data as CANFrame)
          } else if (message.type === "error") {
            this.options.onError?.(message.message)
          } else if (message.type === "status") {
            this.options.onStatus?.(message.status)
          }
        } catch (e) {
          console.error("Failed to parse WebSocket message:", e)
        }
      }

      this.ws.onerror = () => {
        this.options.onError?.("WebSocket connection error")
      }

      this.ws.onclose = () => {
        this.options.onStatus?.("disconnected")
        this.attemptReconnect()
      }
    } catch (e) {
      this.options.onError?.(`Failed to connect: ${e}`)
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.options.onError?.("Max reconnection attempts reached")
      return
    }

    this.reconnectAttempts++
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
    
    this.reconnectTimeout = setTimeout(() => {
      this.connect()
    }, delay)
  }

  disconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
    
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }
}

/**
 * Create a CAN stream client for real-time frame monitoring.
 * 
 * Usage:
 * ```
 * const stream = createCANStream({
 *   interface: "can0",
 *   onFrame: (frame) => console.log(frame),
 *   onError: (err) => console.error(err),
 *   onStatus: (status) => console.log(status),
 * })
 * 
 * stream.connect()
 * // ... later
 * stream.disconnect()
 * ```
 */
export function createCANStream(options: CANStreamOptions): CANStreamClient {
  return new CANStreamClient(options)
}
