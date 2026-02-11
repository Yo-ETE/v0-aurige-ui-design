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

// CAN interface type - includes vcan0 for testing without hardware
export type CANInterface = "can0" | "can1" | "vcan0"

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
  interface: CANInterface
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
  parentId?: string  // ID of parent log if this is a split
  isOrigin?: boolean  // True if this is an origin log (has children)
  tags?: string[]  // Tags: success, failed, original, etc.
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
  wifiSsid?: string
  wifiSignal?: number
  wifiTxRate?: string
  wifiRxRate?: string
  wifiIsHotspot?: boolean
  wifiHotspotSsid?: string
  wifiInternetSource?: string
  wifiInternetVia?: string
  ethernetConnected: boolean
  ethernetIp?: string
  can0Up: boolean
  can0Bitrate?: number
  can1Up: boolean
  can1Bitrate?: number
  vcan0Up: boolean
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
  // Alias for compatibility
  isUp?: boolean
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

export async function getCANStatus(iface: CANInterface): Promise<CANInterfaceStatus> {
  return fetchApi<CANInterfaceStatus>(`/can/${iface}/status`)
}

export async function initializeCAN(iface: CANInterface, bitrate: number): Promise<{ status: string }> {
  return fetchApi("/can/init", {
    method: "POST",
    body: JSON.stringify({ interface: iface, bitrate }),
  })
}

export async function stopCAN(iface: CANInterface): Promise<{ status: string }> {
  return fetchApi(`/can/stop?interface=${iface}`, {
    method: "POST",
  })
}

export interface BitrateScanResult {
  bitrate: number
  bitrate_label: string
  frames_received: number
  errors: number
  unique_ids: number
  score: number
}

export interface BitrateScanResponse {
  interface: string
  results: BitrateScanResult[]
  best_bitrate: number | null
  best_score: number
  scan_duration_ms: number
}

export async function scanBitrate(iface: "can0" | "can1", timeout?: number): Promise<BitrateScanResponse> {
  const params = new URLSearchParams({ interface: iface })
  if (timeout) params.set("timeout", timeout.toString())
  return fetchApi(`/can/scan-bitrate?${params}`, {
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
  iface: CANInterface,
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
  iface: CANInterface,
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

export async function forceCleanupReplay(): Promise<{ status: string; message: string }> {
  return fetchApi("/replay/force-cleanup", {
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
  iface: CANInterface,
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

export async function forceCleanupGenerator(): Promise<{ status: string; message: string }> {
  return fetchApi("/generator/force-cleanup", {
    method: "POST",
  })
}

export async function getGeneratorStatus(): Promise<ProcessStatus> {
  return fetchApi<ProcessStatus>("/generator/status")
}

// =============================================================================
// Fuzzing
// =============================================================================

export type FuzzDataMode = "static" | "random" | "range" | "logs"

export interface FuzzingParams {
  interface: CANInterface
  idStart: string
  idEnd: string
  dataTemplate?: string
  iterations: number
  delayMs: number
  dataMode: FuzzDataMode
  byteRanges?: { index: number; min: number; max: number }[]
  missionId?: string
  logId?: string
  targetIds?: string[]
  dlc?: number
  enablePreFuzzCapture?: boolean
  preFuzzDurationSec?: number
}

export async function startFuzzing(params: FuzzingParams): Promise<{ status: string }> {
  return fetchApi("/fuzzing/start", {
    method: "POST",
    body: JSON.stringify(params),
  })
}

export async function stopFuzzing(): Promise<{ status: string }> {
  return fetchApi("/fuzzing/stop", {
    method: "POST",
  })
}

export async function forceCleanupFuzzing(): Promise<{ status: string; message: string }> {
  return fetchApi("/fuzzing/force-cleanup", {
    method: "POST",
  })
}

export async function getFuzzingStatus(): Promise<ProcessStatus> {
  return fetchApi<ProcessStatus>("/fuzzing/status")
}

// =============================================================================
// Logs Analysis (for intelligent fuzzing)
// =============================================================================

export interface LogByteRange {
  index: number
  min: number
  max: number
  unique: number
}

export interface LogIdAnalysis {
  canId: string
  count: number
  sampleCount: number
  samples: string[]
  dlcs: number[]
  byteRanges: LogByteRange[]
}

export interface LogsAnalysis {
  mission_id: string
  ids: LogIdAnalysis[]
  totalFrames: number
  totalUniqueIds: number
}

export async function getLogsAnalysis(missionId: string, logId?: string): Promise<LogsAnalysis> {
  const params = logId ? `?log_id=${logId}` : ""
  return fetchApi(`/missions/${missionId}/logs-analysis${params}`)
}

// =============================================================================
// Crash Recovery
// =============================================================================

export interface FuzzingHistoryFrame {
  index?: number
  id: string
  data: string
  timestamp: number
}

export interface FuzzingHistory {
  exists: boolean
  frames?: FuzzingHistoryFrame[]  // Legacy format (limited to 1000)
  frames_sent?: FuzzingHistoryFrame[]  // New format (all frames with index)
  started_at?: number
  stopped_at?: number
  total_sent?: number
  message?: string
  mission_id?: string
  during_fuzz_log?: string
}

export interface CrashRecoveryResult {
  id: string
  status: string
  frame?: string
  error?: string
}

export interface CrashRecoveryResponse {
  status: string
  results: CrashRecoveryResult[]
  message: string
}

export interface LogComparisonResult {
  pre_fuzz_ids: string[]
  fuzzing_ids: string[]
  suspect_ids: string[]
  message: string
}

export async function attemptCrashRecovery(
  iface: CANInterface,
  suspectIds?: string[]
): Promise<CrashRecoveryResponse> {
  return fetchApi("/fuzzing/crash-recovery", {
    method: "POST",
    body: JSON.stringify({
      interface: iface,
      suspectIds,
    }),
  })
}

export async function getFuzzingHistory(missionId?: string): Promise<FuzzingHistory> {
  const params = missionId ? `?mission_id=${missionId}` : ""
  return fetchApi(`/fuzzing/history${params}`)
}

export async function compareLogsWithFuzzing(
  missionId: string,
  logId: string
): Promise<LogComparisonResult> {
  return fetchApi(`/fuzzing/compare-logs?mission_id=${missionId}&log_id=${logId}`, {
    method: "POST",
  })
}

export interface CrashAnomaly {
  type: "disappeared" | "zeroed" | "new_error"
  id: string
  severity: "critical" | "high" | "medium"
  description: string
}

export interface CrashCulprit {
  anomaly: CrashAnomaly
  suspect_frames: FuzzingHistoryFrame[]
  timing_delta: number
}

export interface CrashAnalysisResult {
  mission_id: string
  anomalies: CrashAnomaly[]
  disappeared_ids: string[]
  new_error_ids: string[]
  culprits: CrashCulprit[]
  pre_fuzz_ids: string[]
  during_fuzz_ids: string[]
  message: string
}

export async function analyzeCrash(
  missionId: string,
  preFuzzLogId: string,
  duringFuzzLogId: string
): Promise<CrashAnalysisResult> {
  return fetchApi(
    `/fuzzing/analyze-crash?mission_id=${missionId}&pre_fuzz_log_id=${preFuzzLogId}&during_fuzz_log_id=${duringFuzzLogId}`,
    { method: "POST" }
  )
}

// =============================================================================
// Sniffer
// =============================================================================

export async function startSniffer(iface: CANInterface): Promise<{ status: string }> {
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

export function getLogFamilyDownloadUrl(missionId: string, logId: string): string {
  return `${getApiBaseUrl()}/api/missions/${missionId}/logs/${logId}/download-family`
}

export async function updateLogTags(missionId: string, logId: string, tags: string[]): Promise<void> {
  await fetchApi(`/missions/${missionId}/logs/${logId}/tags`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tags }),
  })
}

export async function createFrameLog(missionId: string, params: {
  canId: string
  data: string
  timestamp?: string
  name?: string
  interface?: string
}): Promise<{ status: string; logId: string; filename: string }> {
  return fetchApi(`/missions/${missionId}/logs/create-frame`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      can_id: params.canId,
      data: params.data,
      timestamp: params.timestamp,
      name: params.name,
      interface: params.interface,
    }),
  })
}

export async function deleteLog(missionId: string, logId: string): Promise<void> {
  await fetchApi(`/missions/${missionId}/logs/${logId}`, {
    method: "DELETE",
  })
}

export interface LogFrame {
  timestamp?: string
  interface?: string
  canId?: string
  data?: string
  raw: string
}

export interface LogContentResponse {
  frames: LogFrame[]
  totalCount: number
  offset: number
  limit: number
}

export async function getLogContent(missionId: string, logId: string, limit = 500, offset = 0): Promise<LogContentResponse> {
  return fetchApi<LogContentResponse>(`/missions/${missionId}/logs/${logId}/content?limit=${limit}&offset=${offset}`)
}

export interface RenameLogResult {
  status: string
  oldId: string
  newId: string
  newName: string
}

export async function renameLog(missionId: string, logId: string, newName: string): Promise<RenameLogResult> {
  return fetchApi(`/missions/${missionId}/logs/${logId}/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newName }),
  })
}

export interface SplitLogResult {
  logAId: string
  logAName: string
  logAFrames: number
  logBId: string
  logBName: string
  logBFrames: number
}

export async function splitLog(missionId: string, logId: string): Promise<SplitLogResult> {
  return fetchApi<SplitLogResult>(`/missions/${missionId}/logs/${logId}/split`, {
    method: "POST",
  })
}

// =============================================================================
// Co-occurrence Analysis
// =============================================================================

export interface CoOccurrenceRequest {
  logId: string
  targetCanId: string
  targetTimestamp: number
  windowMs?: number
  direction?: "before" | "after" | "both"
}

export interface CoOccurrenceFrame {
  canId: string
  count: number
  countBefore: number
  countAfter: number
  avgDelayMs: number
  dataVariations: number
  sampleData: string[]
  frameType: "command" | "ack" | "status" | "unknown"
  score: number
}

export interface EcuFamily {
  name: string
  idRangeStart: string
  idRangeEnd: string
  frameIds: string[]
  totalFrames: number
}

export interface CoOccurrenceResponse {
  targetFrame: { canId: string; timestamp: number }
  windowMs: number
  totalFramesAnalyzed: number
  uniqueIdsFound: number
  relatedFrames: CoOccurrenceFrame[]
  ecuFamilies: EcuFamily[]
}

export async function analyzeCoOccurrence(
  missionId: string, 
  logId: string, 
  request: CoOccurrenceRequest
): Promise<CoOccurrenceResponse> {
  return fetchApi<CoOccurrenceResponse>(`/missions/${missionId}/logs/${logId}/co-occurrence`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
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

export async function requestVIN(iface: CANInterface = "can0"): Promise<OBDResponse> {
  return fetchApi<OBDResponse>("/obd/vin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ interface: iface }),
  })
}

export async function readDTCs(iface: CANInterface = "can0"): Promise<OBDResponse> {
  return fetchApi<OBDResponse>("/obd/dtc/read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ interface: iface }),
  })
}

export async function clearDTCs(iface: CANInterface = "can0"): Promise<OBDResponse> {
  return fetchApi<OBDResponse>("/obd/dtc/clear", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ interface: iface }),
  })
}

export async function resetECU(iface: CANInterface = "can0"): Promise<OBDResponse> {
  return fetchApi<OBDResponse>("/obd/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ interface: iface }),
  })
}

export interface PIDScanResponse {
  status: string
  message: string
  responsesCount: number
  responses: string[]
}

export async function scanAllPIDs(iface: CANInterface = "can0"): Promise<PIDScanResponse> {
  return fetchApi<PIDScanResponse>("/obd/scan-pids", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ interface: iface }),
  })
}

export interface FullScanResponse {
  status: string
  message: string
  results: {
    vin: string[] | null
    pids: string[]
    dtcs: string[]
    logFile: string | null
  }
}

export async function fullOBDScan(iface: CANInterface = "can0"): Promise<FullScanResponse> {
  return fetchApi<FullScanResponse>("/obd/full-scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ interface: iface }),
  })
}

export interface OBDReport {
  timestamp: number
  interface: string
  vin: string[]
  pids: string[]
  dtcs: string[]
  logFile: string
}

export async function getLastOBDReport(): Promise<{ status: string; report?: OBDReport; message?: string }> {
  return fetchApi<{ status: string; report?: OBDReport; message?: string }>("/obd/last-report")
}

// =============================================================================
// Network Configuration
// =============================================================================

export interface WifiNetwork {
  ssid: string
  signal: number
  security: string
  bssid: string
}

export interface WifiStatus {
  connected: boolean
  isHotspot: boolean
  hotspotSsid: string
  ssid: string
  signal: number
  txRate: string
  rxRate: string
  ipLocal: string
  ipPublic: string
  internetSource?: string
  internetInterface?: string
  internetVia?: string
}

export interface EthernetStatus {
  connected: boolean
  ipLocal: string
}

export interface AptOutput {
  running: boolean
  command: string
  lines: string[]
}

export async function scanWifiNetworks(): Promise<{ status: string; networks: WifiNetwork[]; message?: string }> {
  return fetchApi("/network/wifi/scan")
}

export async function getWifiStatus(): Promise<WifiStatus> {
  return fetchApi("/network/wifi/status")
}

export async function getEthernetStatus(): Promise<EthernetStatus> {
  return fetchApi("/network/ethernet/status")
}

export async function getSavedNetworks(): Promise<{ saved: string[] }> {
  return fetchApi("/network/wifi/saved")
}

export async function connectToWifi(ssid: string, password: string): Promise<{ status: string; message: string }> {
  return fetchApi("/network/wifi/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ssid, password }),
  })
}

export async function runAptUpdate(): Promise<{ status: string; message: string }> {
  return fetchApi("/system/apt/update", { method: "POST" })
}

export async function runAptUpgrade(): Promise<{ status: string; message: string }> {
  return fetchApi("/system/apt/upgrade", { method: "POST" })
}

export async function getAptOutput(): Promise<AptOutput> {
  return fetchApi("/system/apt/output")
}

export async function systemReboot(): Promise<{ status: string; message: string }> {
  return fetchApi("/system/reboot", { method: "POST" })
}

export async function systemShutdown(): Promise<{ status: string; message: string }> {
  return fetchApi("/system/shutdown", { method: "POST" })
}

export async function restartServices(): Promise<{ success: boolean; message: string }> {
  return fetchApi("/system/restart-services", { method: "POST" })
}

// =============================================================================
// Tailscale VPN
// =============================================================================

export interface TailscalePeer {
  id: string
  hostname: string
  dnsName: string
  os: string
  online: boolean
  ip: string
  isExitNode: boolean
  exitNodeOption: boolean
  lastSeen: string
  rxBytes: number
  txBytes: number
}

export interface TailscaleStatus {
  installed: boolean
  running: boolean
  backendState?: string
  hostname: string
  tailscaleIp: string
  magicDns: string
  online: boolean
  exitNode: boolean
  os: string
  version: string
  peers: TailscalePeer[]
  authUrl: string
}

export async function getTailscaleStatus(): Promise<TailscaleStatus> {
  return fetchApi("/tailscale/status")
}

export async function tailscaleUp(): Promise<{ status: string; message: string; authUrl?: string }> {
  return fetchApi("/tailscale/up", { method: "POST" })
}

export async function tailscaleDown(): Promise<{ status: string; message: string }> {
  return fetchApi("/tailscale/down", { method: "POST" })
}

export async function tailscaleLogout(): Promise<{ status: string; message: string }> {
  return fetchApi("/tailscale/logout", { method: "POST" })
}

export async function tailscaleSetExitNode(peerIp: string): Promise<{ status: string; message: string }> {
  return fetchApi(`/tailscale/set-exit-node?peer_ip=${encodeURIComponent(peerIp)}`, { method: "POST" })
}

// =============================================================================
// Update and Backup
// =============================================================================

export interface VersionInfo {
  branch: string
  commit: string
  commitDate?: string
  commitsBehind: number
  updateAvailable: boolean
}

export interface BackupInfo {
  filename: string
  size: number
  created: string
}

export interface UpdateOutput {
  running: boolean
  lines: string[]
  success?: boolean
  error?: string
}

export interface GitBranches {
  branches: string[]
  current: string
  error?: string
}

export async function getGitBranches(): Promise<GitBranches> {
  return fetchApi("/system/branches")
}

export async function getVersionInfo(): Promise<VersionInfo> {
  return fetchApi("/system/version")
}

export async function listBackups(): Promise<{ backups: BackupInfo[] }> {
  return fetchApi("/system/backups")
}

export async function createBackup(): Promise<{ status: string; message: string; filename?: string; size?: number }> {
  return fetchApi("/system/backup", { method: "POST" })
}

export async function deleteBackup(filename: string): Promise<{ status: string; message: string }> {
  return fetchApi(`/system/backups/${filename}`, { method: "DELETE" })
}

export async function restoreBackup(filename: string): Promise<{ status: string; message: string }> {
  return fetchApi(`/system/backups/${filename}/restore`, { method: "POST" })
}

export async function startUpdate(branch?: string): Promise<{ status: string; message: string }> {
  return fetchApi("/system/update", { 
    method: "POST",
    ...(branch ? { body: JSON.stringify({ branch }) } : {}),
  })
}

export async function getUpdateOutput(): Promise<UpdateOutput> {
  return fetchApi("/system/update/output")
}

// =============================================================================
// WebSocket Helpers
// =============================================================================

/**
 * Create WebSocket for cansniffer (live view only, no recording)
 * Used by the floating terminal for real-time CAN traffic monitoring
 */
export function createSnifferWebSocket(
  iface: CANInterface,
  onMessage: (msg: CANMessage) => void,
  onError?: (error: Event) => void,
  onClose?: () => void
): WebSocket {
  const wsBaseUrl = getWsBaseUrl()
  const ws = new WebSocket(`${wsBaseUrl}/ws/cansniffer?interface=${iface}`)
  
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

/**
 * Create WebSocket for candump (used during capture for live preview)
 * Note: For actual capture/recording, use startCapture() API
 */
export function createCandumpWebSocket(
  iface: CANInterface,
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

// Alias for backward compatibility
export const createCANWebSocket = createCandumpWebSocket

// =============================================================================
// DBC Analysis - Diff AVANT/APRES
// =============================================================================

export interface ByteDiff {
  byte_index: number
  value_before: string
  value_after: string
  changed_bits: number[]
}

export interface FrameDiff {
  can_id: string
  count_before: number
  count_ack: number
  count_status: number
  bytes_diff: ByteDiff[]
  classification: "status" | "ack" | "info" | "unchanged"
  confidence: number
  sample_before: string
  sample_ack: string
  sample_status: string
  persistence: "persistent" | "transient" | "none"
}

export interface FamilyAnalysisResponse {
  family_name: string
  frame_ids: string[]
  frames_analysis: FrameDiff[]
  summary: {
    total: number
    status: number
    ack: number
    info: number
    unchanged: number
  }
  t0_timestamp: number
}

export interface AnalyzeFamilyRequest {
  mission_id: string
  log_id: string
  family_ids: string[]
  t0_timestamp: number
  before_offset_ms: [number, number]
  ack_offset_ms: [number, number]
  status_offset_ms: [number, number]
}

export async function analyzeFamilyDiff(request: AnalyzeFamilyRequest): Promise<FamilyAnalysisResponse> {
  const body = JSON.stringify(request)
  
  const response = await fetch(`${getApiBaseUrl()}/api/analysis/family-diff`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  })
  
  if (!response.ok) {
    const errorText = await response.text()
    console.error("[v0] analyzeFamilyDiff error response:", errorText)
    throw new Error(`API error ${response.status}: ${errorText}`)
  }
  
  return response.json()
}

// =============================================================================
// Saved Comparisons API
// =============================================================================

export interface SavedComparisonSummary {
  id: string
  name: string
  log_a_id: string
  log_a_name: string
  log_b_id: string
  log_b_name: string
  created_at: string
  differential_count: number
  only_a_count: number
  only_b_count: number
  identical_count: number
}

export interface SavedComparison extends SavedComparisonSummary {
  result: CompareLogsResponse
}

export async function listComparisons(missionId: string): Promise<SavedComparisonSummary[]> {
  return fetchApi(`/missions/${missionId}/comparisons`)
}

export async function getComparison(missionId: string, comparisonId: string): Promise<SavedComparison> {
  return fetchApi(`/missions/${missionId}/comparisons/${comparisonId}`)
}

export async function saveComparison(
  missionId: string,
  name: string,
  logAId: string,
  logAName: string,
  logBId: string,
  logBName: string,
  result: CompareLogsResponse
): Promise<SavedComparison> {
  return fetchApi(`/missions/${missionId}/comparisons`, {
    method: "POST",
    body: JSON.stringify({
      name,
      log_a_id: logAId,
      log_a_name: logAName,
      log_b_id: logBId,
      log_b_name: logBName,
      result,
    }),
  })
}

export async function deleteComparison(missionId: string, comparisonId: string): Promise<void> {
  return fetchApi(`/missions/${missionId}/comparisons/${comparisonId}`, {
    method: "DELETE",
  })
}

export interface DBCSignal {
  id: string
  can_id: string
  name: string
  start_bit: number
  length: number
  byte_order: "little_endian" | "big_endian"
  is_signed: boolean
  scale: number
  offset: number
  min_val: number
  max_val: number
  unit: string
  comment: string
}

export interface DBCMessage {
  can_id: string
  name: string
  dlc: number
  signals: DBCSignal[]
  comment: string
}

export interface MissionDBC {
  mission_id: string
  messages: DBCMessage[]
  created_at: string
  updated_at: string
}

export async function getMissionDBC(missionId: string): Promise<MissionDBC> {
  return fetchApi(`/missions/${missionId}/dbc`)
}

export async function addDBCSignal(missionId: string, signal: Partial<DBCSignal>): Promise<{ status: string; signal_id: string }> {
  return fetchApi(`/missions/${missionId}/dbc/signal`, {
    method: "POST",
    body: JSON.stringify(signal),
  })
}

export async function deleteDBCSignal(missionId: string, signalId: string): Promise<{ status: string }> {
  return fetchApi(`/missions/${missionId}/dbc/signal/${signalId}`, {
    method: "DELETE",
  })
}

export async function clearMissionDBC(missionId: string): Promise<{ status: string }> {
  return fetchApi(`/missions/${missionId}/dbc`, {
    method: "DELETE",
  })
}

export function getDBCExportUrl(missionId: string): string {
  return `${getApiBaseUrl()}/api/missions/${missionId}/dbc/export`
}

export function getMissionExportUrl(missionId: string): string {
  return `${getApiBaseUrl()}/api/missions/${missionId}/export`
}

// =============================================================================
// Log Comparison API
// =============================================================================

export interface ByteChangeDetail {
  index: number
  val_a: string
  val_b: string
  hex_diff: string
  decimal_diff: number
}

export interface RarePayloadInfo {
  payload: string
  count: number
  ts_preview: number[]
}

export interface CompareFrameDiff {
  can_id: string
  payload_a: string
  payload_b: string
  count_a: number
  count_b: number
  bytes_changed: number[]
  classification: "differential" | "only_a" | "only_b" | "identical"
  confidence: number
  // Stability & variance metrics
  unique_payloads_a: number
  unique_payloads_b: number
  stability_score: number       // 0-100: higher = more stable = better for reverse
  dominant_ratio_a: number      // % of frames matching most common payload in A
  dominant_ratio_b: number      // % of frames matching most common payload in B
  byte_change_detail: ByteChangeDetail[]
  // Commande probable: rare/exclusif scoring
  command_score: number
  rare_payloads_a: RarePayloadInfo[]
  rare_payloads_b: RarePayloadInfo[]
  exclusive_rare_a: RarePayloadInfo[]
  exclusive_rare_b: RarePayloadInfo[]
}

export interface CompareLogsResponse {
  log_a_name: string
  log_b_name: string
  total_ids_a: number
  total_ids_b: number
  differential_count: number
  only_a_count: number
  only_b_count: number
  identical_count: number
  frames: CompareFrameDiff[]
}

export async function compareLogs(
  missionId: string,
  logAId: string,
  logBId: string
): Promise<CompareLogsResponse> {
  return fetchApi(`/missions/${missionId}/compare-logs`, {
    method: "POST",
    body: JSON.stringify({
      mission_id: missionId,
      log_a_id: logAId,
      log_b_id: logBId,
    }),
  })
}

// =============================================================================
// Log Import API
// =============================================================================

export interface ImportLogResponse {
  id: string
  filename: string
  frames_count: number
  message: string
}

export async function importLog(
  missionId: string,
  file: File
): Promise<ImportLogResponse> {
  const formData = new FormData()
  formData.append("file", file)
  
  const url = `${getApiBaseUrl()}/api/missions/${missionId}/import-log`
  const response = await fetch(url, {
    method: "POST",
    body: formData,
  })
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: "Erreur inconnue" }))
    throw new Error(error.detail || `Erreur API: ${response.status}`)
  }
  
  return response.json()
}
