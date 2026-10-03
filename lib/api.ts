/**
 * AURIGE API Client
 * 
 * All communication with the FastAPI backend goes through this client.
 * The frontend NEVER executes shell commands or accesses CAN directly.
 * All CAN operations are delegated to the backend.
 */

import { AUTH_REQUIRED_EVENT, apiFetch, getApiBaseUrl, getWsBaseUrl } from "./api-config"


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
  lastCaptureDate?: string | null
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
  interface?: string  // Interface CAN de capture (can0, can1...)
  bitrate?: number  // Bitrate au moment de la capture
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
  // Etat du controleur CAN (absent pour vcan)
  can_state?: string
  berr_tx?: number
  berr_rx?: number
  restarts?: number
  // Alias for compatibility
  isUp?: boolean
}

export interface CANFrame {
  interface: string
  canId: string
  data: string
}

export interface CaptureSlotStatus {
  interface: string
  running: boolean
  filename?: string
  durationSeconds: number
  framesCount?: number
}

export interface CaptureStatus {
  captures: CaptureSlotStatus[]
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

export class APIError extends Error {
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
  
  const response = await apiFetch(url, {
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
// Authentification (comptes utilisateurs, cookie HttpOnly posé par le backend)
// =============================================================================

export const ALL_PERMISSION_FLAGS = [
  "area_dashboard","area_missions","area_control","area_analysis","area_capture",
  "area_configuration","area_administration","can_inject","fuzzing_run",
  "crash_recovery_run","causality_validate","capture_run","replay_run",
  "missions_create","missions_edit","missions_delete","dbc_manage","obd_write",
  "system_update","system_reboot","system_network","system_backup",
] as const
export type PermissionFlag = (typeof ALL_PERMISSION_FLAGS)[number]
export type UserPermissions = Partial<Record<PermissionFlag, boolean>>

// Presets partagés (source unique : éditeur, création de compte, contexte auth)
export const VIEWER_PRESET: UserPermissions = {
  area_dashboard: true, area_missions: true, area_analysis: true, area_capture: true,
}
const OPERATOR_DENIED: readonly PermissionFlag[] = [
  "area_administration", "system_update", "system_reboot", "system_network", "system_backup",
]
export const OPERATOR_PRESET: UserPermissions = Object.fromEntries(
  ALL_PERMISSION_FLAGS.map((f) => [f, !OPERATOR_DENIED.includes(f)]),
) as UserPermissions

export interface AuthUser {
  id: number
  username: string
  role: "admin" | "viewer"
  permissions: UserPermissions | null
}
export interface ManagedUser extends AuthUser {
  is_active: boolean
  last_login: string | null
}

export async function login(username: string, password: string): Promise<{ user: AuthUser }> {
  return fetchApi("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  })
}
export async function logout(): Promise<void> {
  await fetchApi("/auth/logout", { method: "POST" })
  if (typeof window !== "undefined") window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT))
}
export async function getMe(): Promise<AuthUser> {
  return fetchApi("/auth/me", { cache: "no-store" })
}
export async function listUsers(): Promise<ManagedUser[]> {
  return fetchApi("/auth/users", { cache: "no-store" })
}
export async function createUser(input: {
  username: string; password: string; role: "admin" | "viewer"; permissions: UserPermissions | null
}): Promise<{ id: number }> {
  return fetchApi("/auth/users", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  })
}
export async function updateUser(id: number, patch: {
  password?: string; role?: "admin" | "viewer"; permissions?: UserPermissions | null; is_active?: boolean
}): Promise<void> {
  await fetchApi(`/auth/users/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
  })
}
export async function deleteUser(id: number): Promise<void> {
  await fetchApi(`/auth/users/${id}`, { method: "DELETE" })
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

export interface BusIdRange {
  "0x000-0x0FF": number
  "0x100-0x3FF": number
  "0x400-0x7FF": number
  extended: number
}

export interface BusIdTop {
  id: string
  count: number
}

export interface BusIdentifyResult {
  status: string
  interface: CANInterface
  durationSec: number
  frameCount: number
  uniqueIds: number
  loadHz: number
  idRanges: BusIdRange
  topIds: BusIdTop[]
  estimate: string
}

/** Écoute passive d'un bus inconnu (charge, répartition des IDs, profil estimé). Lecture seule. */
export async function identifyBus(iface: CANInterface, durationSec = 2): Promise<BusIdentifyResult> {
  return fetchApi("/can/identify", {
    method: "POST",
    body: JSON.stringify({ interface: iface, durationSec }),
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

// Interface en query (?interface=) ; optionnelle si une seule capture tourne
export async function stopCapture(iface?: CANInterface): Promise<{ status: string; filename?: string; durationSeconds: number; framesCount?: number }> {
  const qs = iface ? `?interface=${encodeURIComponent(iface)}` : ""
  return fetchApi(`/capture/stop${qs}`, {
    method: "POST",
  })
}

export async function getCaptureStatus(): Promise<{ captures: CaptureSlotStatus[] }> {
  return fetchApi<{ captures: CaptureSlotStatus[] }>("/capture/status")
}

// =============================================================================
// Replay
// =============================================================================

export async function startReplay(
  missionId: string,
  logId: string,
  iface: CANInterface,
  speed: number = 1.0,
  loop: number = 1
): Promise<{ status: string }> {
  return fetchApi("/replay/start", {
    method: "POST",
    body: JSON.stringify({
      missionId,
      logId,
      interface: iface,
      speed,
      loop,
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

export type GeneratorIdMode = "random" | "fixed" | "increment"
export type GeneratorDataMode = "random" | "fixed" | "increment"

export interface GeneratorOptions {
  delayMs: number
  dataLength: number
  idMode?: GeneratorIdMode // defaut backend : fixed si canId fourni, sinon random
  canId?: string // utilise uniquement si idMode === "fixed"
  dataMode?: GeneratorDataMode
  dataValue?: string // hex, si dataMode === "fixed"
  count?: number // arrete cangen apres N trames
}

export async function startGenerator(
  iface: CANInterface,
  opts: GeneratorOptions
): Promise<{ status: string }> {
  return fetchApi("/generator/start", {
    method: "POST",
    body: JSON.stringify({
      interface: iface,
      delayMs: opts.delayMs,
      dataLength: opts.dataLength,
      idMode: opts.idMode,
      canId: opts.canId,
      dataMode: opts.dataMode,
      dataValue: opts.dataValue,
      count: opts.count,
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
  dtc_details?: OBDDtc[]
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

// --- Valise OBD : DTC en attente/permanents, valeur PID, statut, freeze frame ---

export interface OBDDtc { code: string; description: string; category: string }
export interface OBDPidValue { status: string; pid: string; label?: string; value: number | null; unit?: string }
export interface OBDStatusInfo { status: string; mil_on: boolean; dtc_count: number; monitors: { name: string; available: boolean; complete: boolean }[] }

export async function readDTCsPending(iface: CANInterface): Promise<{ status: string; message: string; dtcs: string[]; dtc_details: OBDDtc[] }> {
  return fetchApi("/obd/dtc/pending", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ interface: iface }) })
}
export async function readDTCsPermanent(iface: CANInterface): Promise<{ status: string; message: string; dtcs: string[]; dtc_details: OBDDtc[] }> {
  return fetchApi("/obd/dtc/permanent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ interface: iface }) })
}
export async function readOBDPidValue(iface: CANInterface, pid: string): Promise<OBDPidValue> {
  return fetchApi("/obd/pid-read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ interface: iface, pid }) })
}
export async function getOBDStatus(iface: CANInterface): Promise<OBDStatusInfo> {
  return fetchApi("/obd/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ interface: iface }) })
}
export async function getFreezeFrame(iface: CANInterface, pid: string): Promise<OBDPidValue> {
  return fetchApi("/obd/freeze-frame", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ interface: iface, pid }) })
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
  hasInternet?: boolean
  pingMs?: number
  downloadSpeed?: string
  secondaryInterfaces?: WifiSecondaryInterface[]
}

export interface WifiSecondaryInterface {
  name: string
  type: string
  label: string
  ssid: string
  ip: string
  signal: number
  connected: boolean
  isDefaultRoute?: boolean
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

export interface HotspotStatus { active: boolean; ssid: string; interface: string; clients: number }
export async function getHotspotStatus(): Promise<HotspotStatus> { return fetchApi("/network/hotspot/status", { cache: "no-store" }) }
export async function getHotspotCredentials(): Promise<{ ssid: string; password: string }> { return fetchApi("/network/hotspot/credentials", { cache: "no-store" }) }
export async function setHotspotPassword(password: string): Promise<void> { await fetchApi("/network/hotspot/credentials", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) }) }
export async function startHotspot(): Promise<{ status: string; detail: string }> { return fetchApi("/network/hotspot/start", { method: "POST" }) }
export async function stopHotspot(): Promise<{ status: string; detail: string }> { return fetchApi("/network/hotspot/stop", { method: "POST" }) }

export async function runAptUpdate():Promise<{ status: string; message: string }> {
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

export interface GitCommit {
  hash: string
  message: string
  date: string
  author: string
}

export interface VersionInfo {
  branch: string
  commit: string
  commitDate?: string
  commitMessage?: string
  commitAuthor?: string
  commitsBehind: number
  updateAvailable: boolean
  latestCommits?: GitCommit[]
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

// URL de téléchargement direct d'une archive (le navigateur gère le download).
export function backupDownloadUrl(filename: string): string {
  return `${getApiBaseUrl()}/api/system/backups/${encodeURIComponent(filename)}/download`
}

// Import d'une archive .tar.gz depuis le poste client (multipart).
export async function uploadBackup(
  file: File,
): Promise<{ status: string; message: string; filename?: string; size?: number }> {
  const form = new FormData()
  form.append("file", file)
  const res = await apiFetch(`${getApiBaseUrl()}/api/system/backups/upload`, {
    method: "POST",
    body: form,
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : {}
  if (!res.ok) {
    throw new APIError(res.status, data.detail || `API Error: ${res.status}`)
  }
  return data
}

export async function startUpdate(branch?: string, commit?: string): Promise<{ status: string; message: string }> {
  const payload: { branch?: string; commit?: string } = {}
  if (branch) payload.branch = branch
  if (commit) payload.commit = commit
  return fetchApi("/system/update", {
    method: "POST",
    ...(Object.keys(payload).length ? { body: JSON.stringify(payload) } : {}),
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
  
  const response = await apiFetch(`${getApiBaseUrl()}/api/analysis/family-diff`, {
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
  // Payloads complets servant au replay (diff de familles / isolation)
  sample_before?: string
  sample_ack?: string
  sample_status?: string
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

export async function deleteDBCMessage(missionId: string, canId: string): Promise<{ status: string }> {
  return fetchApi(`/missions/${missionId}/dbc/message/${canId}`, {
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

export interface DBCLibrarySummary {
  id: string
  name: string
  message_count: number
  signal_count: number
  updated_at: string
}

export interface DBCLibraryDoc {
  id: string
  name: string
  messages: DBCMessage[]
  created_at: string
  updated_at: string
}

// --- Édition message (mission) ---
export async function addDBCMessage(
  missionId: string,
  meta: { can_id: string; name?: string; dlc?: number; comment?: string },
): Promise<{ status: string; can_id: string }> {
  return fetchApi(`/missions/${missionId}/dbc/message`, { method: "POST", body: JSON.stringify(meta) })
}

// --- Bibliothèque DBC autonome ---
export async function listDBCLibraries(): Promise<{ libraries: DBCLibrarySummary[] }> {
  return fetchApi(`/dbc`)
}
export async function createDBCLibrary(name: string): Promise<{ id: string; name: string }> {
  return fetchApi(`/dbc`, { method: "POST", body: JSON.stringify({ name }) })
}
export async function getDBCLibrary(dbcId: string): Promise<DBCLibraryDoc> {
  return fetchApi(`/dbc/${dbcId}`)
}
export async function renameDBCLibrary(dbcId: string, name: string): Promise<{ id: string; name: string }> {
  return fetchApi(`/dbc/${dbcId}`, { method: "PATCH", body: JSON.stringify({ name }) })
}
export async function deleteDBCLibrary(dbcId: string): Promise<{ status: string }> {
  return fetchApi(`/dbc/${dbcId}`, { method: "DELETE" })
}
export async function addLibDBCSignal(dbcId: string, signal: Partial<DBCSignal>): Promise<{ status: string; signal_id: string }> {
  return fetchApi(`/dbc/${dbcId}/signal`, { method: "POST", body: JSON.stringify(signal) })
}
export async function deleteLibDBCSignal(dbcId: string, signalId: string): Promise<{ status: string }> {
  return fetchApi(`/dbc/${dbcId}/signal/${signalId}`, { method: "DELETE" })
}
export async function addLibDBCMessage(dbcId: string, meta: { can_id: string; name?: string; dlc?: number; comment?: string }): Promise<{ status: string }> {
  return fetchApi(`/dbc/${dbcId}/message`, { method: "POST", body: JSON.stringify(meta) })
}
export async function deleteLibDBCMessage(dbcId: string, canId: string): Promise<{ status: string }> {
  return fetchApi(`/dbc/${dbcId}/message/${canId}`, { method: "DELETE" })
}
export function getLibDBCExportUrl(dbcId: string): string {
  return `${getApiBaseUrl()}/api/dbc/${dbcId}/export`
}
export async function dbcFromMission(dbcId: string, missionId: string): Promise<{ status: string; message_count: number }> {
  return fetchApi(`/dbc/${dbcId}/from-mission/${missionId}`, { method: "POST" })
}
export async function missionDbcFromLibrary(missionId: string, dbcId: string): Promise<{ status: string; message_count: number }> {
  return fetchApi(`/missions/${missionId}/dbc/from-library/${dbcId}`, { method: "POST" })
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
  changed_bits?: number[]
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
  const response = await apiFetch(url, {
    method: "POST",
    body: formData,
  })
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: "Erreur inconnue" }))
    throw new Error(error.detail || `Erreur API: ${response.status}`)
  }
  
  return response.json()
}

// =============================================================================
// Signal Finder - OBD/CAN Correlation API
// =============================================================================

export interface OBDSample {
  timestamp: number
  value: number
}

export interface CorrelationCandidate {
  can_id: string
  byte_index: number
  byte_end: number
  model: string
  model_type: string
  scale: number
  offset: number
  pearson: number
  spearman: number
  confidence: number
  n_samples: number
  obd_values: number[]
  can_values: number[]
  can_transformed: number[]
  timestamps: number[]
}

export interface CorrelationResult {
  status: string
  candidates: CorrelationCandidate[]
  total_ids_analyzed: number
  total_frames_processed: number
  elapsed_ms: number
  log_file: string
  obd_sample_count: number
}

export interface OBDPidReading {
  success: boolean
  timestamp: number
  pid: string
  raw_hex: string
  decoded_value: number | null
  unit: string
  name: string
  error?: string | null
  frames?: string[]
}

export async function correlateOBDWithCAN(params: {
  missionId?: string
  logPath?: string
  obdSamples: OBDSample[]
  windowMs?: number
  targetIds?: string[]
  pid?: string
}): Promise<CorrelationResult> {
  return fetchApi("/analysis/correlate-obd", {
    method: "POST",
    body: JSON.stringify({
      mission_id: params.missionId || null,
      log_path: params.logPath || null,
      obd_samples: params.obdSamples,
      window_ms: params.windowMs ?? 50,
      target_ids: params.targetIds || null,
      pid: params.pid || null,
    }),
  })
}

export async function readOBDPidDecoded(
  iface: CANInterface,
  pid: string,
  service: string = "01"
): Promise<OBDPidReading> {
  return fetchApi(
    `/signal-finder/read-pid?interface=${iface}&pid=${pid}&service=${service}`,
    { method: "POST" }
  )
}

export interface ExtractOBDFromLogResult {
  status: string
  pid: string
  name: string
  unit: string
  samples: OBDSample[]
  count: number
  log_file: string
}

export async function extractOBDFromLog(params: {
  missionId?: string
  logPath?: string
  pid: string
}): Promise<ExtractOBDFromLogResult> {
  const qs = new URLSearchParams()
  if (params.missionId) qs.set("mission_id", params.missionId)
  if (params.logPath) qs.set("log_path", params.logPath)
  qs.set("pid", params.pid)
  return fetchApi(`/signal-finder/extract-obd-from-log?${qs.toString()}`, {
    method: "POST",
  })
}

export function getSignalFinderWsUrl(iface: CANInterface = "can0"): string {
  const base = getApiBaseUrl().replace(/^http/, "ws")
  return `${base}/ws/signal-finder?interface=${iface}`
}

// =============================================================================
// Analyse CAN - Heatmap + Auto-Detect
// =============================================================================

export interface HeatmapByteInfo {
  index: number
  change_rate: number
  entropy: number
  min: number
  max: number
  unique_count: number
  is_constant: boolean
}

export interface HeatmapIdEntry {
  can_id: string
  frame_count: number
  dlc: number
  frequency_hz: number
  bytes: HeatmapByteInfo[]
}

export interface HeatmapResult {
  status: string
  ids: HeatmapIdEntry[]
  total_frames: number
  total_ids: number
  elapsed_ms: number
}

export interface DetectedSignal {
  can_id: string
  name: string
  start_byte: number
  length_bytes: number
  start_bit: number
  bit_length: number
  byte_order: "big_endian" | "little_endian"
  is_signed: boolean
  entropy: number
  change_rate: number
  value_range: [number, number]
  sample_values: number[]
  confidence: number
}

export interface ExcludedByteInfo {
  type: "counter" | "checksum"
  mode?: string
  ratio?: number
  algo?: string
  match_rate?: number
}

export interface AutoDetectResult {
  status: string
  detected_signals: DetectedSignal[]
  excluded_bytes: Record<string, Record<string, ExcludedByteInfo>>
  total_ids_analyzed: number
  total_signals_found: number
  elapsed_ms: number
}

export async function autoDetectSignals(params: {
  missionId?: string
  logPath?: string
  logId?: string
  targetIds?: string[]
  minEntropy?: number
  correlationThreshold?: number
  excludeCounters?: boolean
  excludeChecksums?: boolean
}): Promise<AutoDetectResult> {
  return fetchApi("/analysis/auto-detect-signals", {
    method: "POST",
    body: JSON.stringify({
      mission_id: params.missionId || null,
      log_path: params.logPath || null,
      log_id: params.logId || null,
      target_ids: params.targetIds || null,
      min_entropy: params.minEntropy ?? 0.5,
      correlation_threshold: params.correlationThreshold ?? 0.85,
      exclude_counters: params.excludeCounters ?? true,
      exclude_checksums: params.excludeChecksums ?? true,
    }),
  })
}

export async function getByteHeatmap(params: {
  missionId?: string
  logPath?: string
  logId?: string
}): Promise<HeatmapResult> {
  return fetchApi("/analysis/byte-heatmap", {
    method: "POST",
    body: JSON.stringify({
      mission_id: params.missionId || null,
      log_path: params.logPath || null,
      log_id: params.logId || null,
    }),
  })
}

// =============================================================================
// Inter-ID Dependency Detection
// =============================================================================

export interface DependencyEdge {
  source: string
  target: string
  co_occurrences: number
  source_events: number
  target_events: number
  p_react: number
  lift: number
  score: number
}

export interface DependencyNode {
  id: string
  event_count: number
  out_degree: number
  in_degree: number
  role: "source" | "target" | "both"
}

export interface DependencyResult {
  status: string
  edges: DependencyEdge[]
  nodes: DependencyNode[]
  total_frames: number
  active_ids: number
  duration_s: number
  elapsed_ms: number
}

// =============================================================================
// Causality Validation
// =============================================================================

export interface CausalityAttempt {
  attempt: number
  injected: boolean
  error: string | null
  reaction: boolean
  lag_ms: number | null
}

export interface CausalityResult {
  status: string
  source_id: string
  target_id: string
  source_payload: string
  attempts: number
  successes: number
  success_rate: number
  median_lag_ms: number | null
  min_lag_ms: number | null
  max_lag_ms: number | null
  classification: "high" | "moderate" | "low"
  details: CausalityAttempt[]
}

export async function validateCausality(params: {
  sourceId: string
  targetId: string
  iface?: string
  windowMs?: number
  repeat?: number
  pauseMs?: number
  missionId?: string
  logId?: string
}): Promise<CausalityResult> {
  return fetchApi("/analysis/validate-causality", {
    method: "POST",
    body: JSON.stringify({
      source_id: params.sourceId,
      target_id: params.targetId,
      interface: params.iface ?? "can0",
      window_ms: params.windowMs ?? 50,
      repeat: params.repeat ?? 5,
      pause_ms: params.pauseMs ?? 200,
      mission_id: params.missionId || null,
      log_id: params.logId || null,
    }),
  })
}

export interface InterBusPair {
  id_a: string
  id_b: string
  co: number
  avg_delay_ms: number
  p_forward: number
  kind: "relay" | "translated"
}

export interface InterBusResult {
  status: string
  pairs: InterBusPair[]
  blocked_ids: string[]
  total_a: number
  total_b: number
  elapsed_ms: number
}

export async function interBusCorrelation(
  missionId: string,
  logAId: string,
  logBId: string,
  windowMs = 20
): Promise<InterBusResult> {
  return fetchApi("/analysis/inter-bus-correlation", {
    method: "POST",
    body: JSON.stringify({
      mission_id: missionId,
      log_a_id: logAId,
      log_b_id: logBId,
      window_ms: windowMs,
    }),
  })
}

export async function getInterIdDependencies(params: {
  missionId?: string
  logPath?: string
  logId?: string
  windowMs?: number
  minScore?: number
  topN?: number
}): Promise<DependencyResult> {
  return fetchApi("/analysis/inter-id-dependencies", {
    method: "POST",
    body: JSON.stringify({
      mission_id: params.missionId || null,
      log_path: params.logPath || null,
      log_id: params.logId || null,
      window_ms: params.windowMs ?? 10,
      min_score: params.minScore ?? 0.1,
      top_n: params.topN ?? 30,
    }),
  })
}



// =============================================================================
// Injection de fond (frame loop / rejeu de log en boucle)
// =============================================================================

export interface InjectStatus {
  running: boolean
  description: string
}

export async function startInjectFrame(
  iface: CANInterface,
  canId: string,
  data: string,
  intervalMs = 100
): Promise<{ status: string }> {
  return fetchApi("/inject/start", {
    method: "POST",
    body: JSON.stringify({ interface: iface, mode: "frame", canId, data, intervalMs }),
  })
}

export async function startInjectLog(
  iface: CANInterface,
  missionId: string,
  logId: string,
  intervalMs = 100
): Promise<{ status: string }> {
  return fetchApi("/inject/start", {
    method: "POST",
    body: JSON.stringify({ interface: iface, mode: "log", missionId, logId, intervalMs }),
  })
}

export async function stopInject(): Promise<{ status: string }> {
  return fetchApi("/inject/stop", {
    method: "POST",
  })
}

export async function getInjectStatus(): Promise<InjectStatus> {
  return fetchApi("/inject/status")
}

// =============================================================================
// AUD-06 : liste de blocage d'IDs + bibliotheque de trames connues
// =============================================================================

export interface KnownFrame {
  id: string
  can_id: string
  crash_data: string
  reset_data?: string
  label: string
  severity: "info" | "warning" | "danger"
  notes?: string
  created_at: string
}

export interface AUD06Blocklist {
  ids: string[]
}

export interface KnownFrameInput {
  can_id: string
  crash_data: string
  reset_data?: string
  label: string
  severity?: string
  notes?: string
}

export async function getBlocklist(): Promise<AUD06Blocklist> {
  return fetchApi<AUD06Blocklist>("/aud06/blocklist")
}

export async function setBlocklist(ids: string[]): Promise<AUD06Blocklist> {
  return fetchApi<AUD06Blocklist>("/aud06/blocklist", {
    method: "PUT",
    body: JSON.stringify({ ids }),
  })
}

export async function listKnownFrames(): Promise<{ frames: KnownFrame[] }> {
  return fetchApi<{ frames: KnownFrame[] }>("/known-frames")
}

export async function createKnownFrame(p: KnownFrameInput): Promise<KnownFrame> {
  return fetchApi<KnownFrame>("/known-frames", {
    method: "POST",
    body: JSON.stringify(p),
  })
}

export async function updateKnownFrame(fid: string, p: Partial<KnownFrameInput>): Promise<KnownFrame> {
  return fetchApi<KnownFrame>(`/known-frames/${fid}`, {
    method: "PATCH",
    body: JSON.stringify(p),
  })
}

export async function deleteKnownFrame(fid: string): Promise<{ status: string }> {
  return fetchApi<{ status: string }>(`/known-frames/${fid}`, { method: "DELETE" })
}

// Rejeu one-shot ou en boucle d'une trame crash/reinit (garde AUD-06 cote backend)
export async function replayKnownFrame(
  fid: string,
  opts: { interface: CANInterface; kind: "crash" | "reset"; loop?: boolean; intervalMs?: number }
): Promise<{ status: string }> {
  return fetchApi<{ status: string }>(`/known-frames/${fid}/replay`, {
    method: "POST",
    body: JSON.stringify({
      interface: opts.interface,
      kind: opts.kind,
      loop: opts.loop,
      intervalMs: opts.intervalMs,
    }),
  })
}

// =============================================================================
// Analyse IA (config provider + analyse)
// =============================================================================

export interface AIConfig {
  provider: string
  base_url: string
  model: string
  has_key: boolean
}

export interface AIConfigInput {
  provider: string
  base_url?: string
  model: string
  api_key?: string
  clear_key?: boolean
}

export async function getAIConfig(): Promise<AIConfig> {
  return fetchApi<AIConfig>("/ai/config", { cache: "no-store" })
}

export async function setAIConfig(input: AIConfigInput): Promise<AIConfig> {
  return fetchApi<AIConfig>("/ai/config", {
    method: "PUT",
    body: JSON.stringify(input),
  })
}

export async function aiAnalyze(context: string, question: string): Promise<{ answer: string }> {
  return fetchApi<{ answer: string }>("/ai/analyze", {
    method: "POST",
    body: JSON.stringify({ context, question }),
  })
}
