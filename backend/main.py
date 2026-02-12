"""
AURIGE - CAN Bus Analysis API
FastAPI backend for Raspberry Pi 5

This is the AUTHORITATIVE system controller.
All CAN commands are executed ONLY from this backend.
The frontend NEVER executes shell commands.

CAN commands use Linux can-utils:
- ip link set can0 up/down type can bitrate X
- candump can0 (for sniffing)
- cansend can0 ID#DATA (for single frames)
- canplayer -I file.log (for replay)
- cangen can0 (for traffic generation)
"""

import os
import re
import json
import shutil
import asyncio
import subprocess
import signal
import time
from datetime import datetime
from pathlib import Path
from typing import Optional, List
from uuid import uuid4
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Query, Response, UploadFile, File, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from error_logger import log_error, log_info, setup_error_logging
from dbc_parser import parse_dbc_file

# =============================================================================
# Configuration
# =============================================================================

DATA_DIR = Path(os.getenv("AURIGE_DATA_DIR", "/opt/aurige/data"))
MISSIONS_DIR = DATA_DIR / "missions"

MISSIONS_DIR.mkdir(parents=True, exist_ok=True)

# Global state for running processes
class ProcessState:
    candump_process: Optional[asyncio.subprocess.Process] = None
    candump_interface: Optional[str] = None
    capture_process: Optional[asyncio.subprocess.Process] = None
    capture_file: Optional[Path] = None
    capture_start_time: Optional[datetime] = None
    cangen_process: Optional[asyncio.subprocess.Process] = None
    canplayer_process: Optional[asyncio.subprocess.Process] = None
    fuzzing_process: Optional[asyncio.subprocess.Process] = None
    websocket_clients: list[WebSocket] = []

state = ProcessState()


@asynccontextmanager
async def lifespan(app: FastAPI):
  """Startup and cleanup"""
  setup_error_logging(DATA_DIR)
  log_info("AURIGE Backend starting up")
  yield
  
  # Stop all processes on shutdown
  for proc in [state.candump_process, state.capture_process, 
               state.cangen_process, state.canplayer_process, state.fuzzing_process]:
    if proc and proc.returncode is None:
      proc.terminate()
      try:
        proc.wait(timeout=2.0)
      except:
        proc.kill()


app = FastAPI(
    title="AURIGE API",
    description="CAN Bus Analysis API for Raspberry Pi - System Controller",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# =============================================================================
# Pydantic Models
# =============================================================================

class Vehicle(BaseModel):
    brand: str
    model: str
    year: int
    vin: Optional[str] = None
    fuel: Optional[str] = None
    engine: Optional[str] = None
    trim: Optional[str] = None


class CANConfig(BaseModel):
    interface: str = "can0"
    bitrate: int = 500000


class MissionCreate(BaseModel):
    name: str
    notes: Optional[str] = None
    vehicle: Vehicle
    can_config: CANConfig = Field(default_factory=CANConfig, alias="canConfig")

    class Config:
        populate_by_name = True


class MissionUpdate(BaseModel):
    name: Optional[str] = None
    notes: Optional[str] = None
    vehicle: Optional[Vehicle] = None
    can_config: Optional[CANConfig] = Field(default=None, alias="canConfig")

    class Config:
        populate_by_name = True


class Mission(BaseModel):
    id: str
    name: str
    notes: Optional[str] = None
    vehicle: Vehicle
    can_config: CANConfig = Field(alias="canConfig")
    created_at: datetime = Field(alias="createdAt")
    updated_at: datetime = Field(alias="updatedAt")
    logs_count: int = Field(alias="logsCount")
    frames_count: int = Field(alias="framesCount")
    last_capture_date: Optional[datetime] = Field(default=None, alias="lastCaptureDate")

    class Config:
        populate_by_name = True


class LogEntry(BaseModel):
    id: str
    filename: str
    size: int
    frames_count: int = Field(alias="framesCount")
    created_at: datetime = Field(alias="createdAt")
    duration_seconds: Optional[int] = Field(default=None, alias="durationSeconds")
    description: Optional[str] = None
    parent_id: Optional[str] = Field(default=None, alias="parentId")  # ID of parent log if this is a split
    is_origin: bool = Field(default=False, alias="isOrigin")  # True if this is an origin log (has children)
    tags: list[str] = []
    
    class Config:
        populate_by_name = True


class CANFrame(BaseModel):
    """Single CAN frame for sending"""
    interface: str = "can0"
    can_id: str = Field(alias="canId")  # Hex string like "7DF"
    data: str  # Hex string like "02010C" or "02 01 0C"

    class Config:
        populate_by_name = True


class CANInitRequest(BaseModel):
    interface: str = "can0"
    bitrate: int = 500000


class CaptureStartRequest(BaseModel):
    interface: str = "can0"
    mission_id: str = Field(alias="missionId")
    filename: Optional[str] = None
    description: Optional[str] = None

    class Config:
        populate_by_name = True


class ReplayRequest(BaseModel):
    interface: str = "can0"
    mission_id: str = Field(alias="missionId")
    log_id: str = Field(alias="logId")
    speed: float = 1.0  # Playback speed multiplier

    class Config:
        populate_by_name = True


class FuzzingRequest(BaseModel):
    interface: str = "can0"
    id_start: str = Field(alias="idStart")  # Hex
    id_end: str = Field(alias="idEnd")  # Hex
    data_template: str = Field(alias="dataTemplate", default="")  # Hex (used in static mode)
    iterations: int = 100
    delay_ms: float = Field(alias="delayMs", default=10)
    
    # Data generation mode: "static" | "random" | "range" | "logs"
    data_mode: str = Field(alias="dataMode", default="random")
    
    # For "range" mode: per-byte min/max constraints
    byte_ranges: Optional[list] = Field(alias="byteRanges", default=None)
    
    # For "logs" mode: replay observed data from mission logs
    mission_id: Optional[str] = Field(alias="missionId", default=None)
    log_id: Optional[str] = Field(alias="logId", default=None)
    
    # For single-ID targeted fuzzing
    target_ids: Optional[list] = Field(alias="targetIds", default=None)
    
    # DLC (data length code)
    dlc: int = 8
    
    # Crash detection & recovery
    enable_crash_detection: bool = Field(alias="enableCrashDetection", default=True)
    enable_pre_fuzz_capture: bool = Field(alias="enablePreFuzzCapture", default=True)
    pre_fuzz_duration_sec: int = Field(alias="preFuzzDurationSec", default=5)

    class Config:
        populate_by_name = True


class CrashRecoveryRequest(BaseModel):
    """Request to attempt crash recovery"""
    interface: str = "can0"
    suspect_ids: Optional[list] = Field(alias="suspectIds", default=None)  # IDs to try reset on
    
    class Config:
        populate_by_name = True


class GeneratorRequest(BaseModel):
    interface: str = "can0"
    can_id: Optional[str] = Field(default=None, alias="canId")  # None = random
    data_length: int = Field(alias="dataLength", default=8)
    delay_ms: int = Field(alias="delayMs", default=100)

    class Config:
        populate_by_name = True


class CoOccurrenceRequest(BaseModel):
    """Request for co-occurrence analysis"""
    log_id: str = Field(alias="logId")  # Origin log to analyze
    target_can_id: str = Field(alias="targetCanId")  # The causal frame ID (hex)
    target_timestamp: float = Field(alias="targetTimestamp")  # Timestamp of causal frame
    window_ms: int = Field(alias="windowMs", default=200)  # Window size in ms
    direction: str = "both"  # before, after, both

    class Config:
        populate_by_name = True


class CoOccurrenceFrame(BaseModel):
    """A frame found in co-occurrence analysis"""
    can_id: str = Field(alias="canId")
    count: int  # Number of occurrences in window
    count_before: int = Field(alias="countBefore")  # Occurrences before causal frame
    count_after: int = Field(alias="countAfter")  # Occurrences after causal frame
    avg_delay_ms: float = Field(alias="avgDelayMs")  # Average delay from causal frame
    data_variations: int = Field(alias="dataVariations")  # Number of unique payloads
    sample_data: list[str] = Field(alias="sampleData")  # Sample payloads
    frame_type: str = Field(alias="frameType")  # command, ack, status, unknown
    score: float  # Relevance score

    class Config:
        populate_by_name = True


class EcuFamily(BaseModel):
    """A group of IDs that likely belong to the same ECU"""
    name: str  # e.g. "ECU 0x700-0x70F"
    id_range_start: str = Field(alias="idRangeStart")
    id_range_end: str = Field(alias="idRangeEnd")
    frame_ids: list[str] = Field(alias="frameIds")
    total_frames: int = Field(alias="totalFrames")

    class Config:
        populate_by_name = True


class CoOccurrenceResponse(BaseModel):
    """Response from co-occurrence analysis"""
    target_frame: dict = Field(alias="targetFrame")  # The causal frame info
    window_ms: int = Field(alias="windowMs")
    total_frames_analyzed: int = Field(alias="totalFramesAnalyzed")
    unique_ids_found: int = Field(alias="uniqueIdsFound")
    related_frames: list[CoOccurrenceFrame] = Field(alias="relatedFrames")
    ecu_families: list[EcuFamily] = Field(alias="ecuFamilies")

    class Config:
        populate_by_name = True


class SystemStatus(BaseModel):
    hostname: str
    uptime_seconds: int = Field(alias="uptimeSeconds")
    cpu_usage: float = Field(alias="cpuUsage")
    temperature: float
    memory_used: float = Field(alias="memoryUsed")
    memory_total: float = Field(alias="memoryTotal")
    storage_used: float = Field(alias="storageUsed")
    storage_total: float = Field(alias="storageTotal")
    wifi_connected: bool = Field(alias="wifiConnected")
    wifi_ip: Optional[str] = Field(default=None, alias="wifiIp")
    wifi_ssid: Optional[str] = Field(default=None, alias="wifiSsid")
    wifi_signal: Optional[int] = Field(default=None, alias="wifiSignal")
    wifi_tx_rate: Optional[str] = Field(default=None, alias="wifiTxRate")
    wifi_rx_rate: Optional[str] = Field(default=None, alias="wifiRxRate")
    wifi_is_hotspot: Optional[bool] = Field(default=False, alias="wifiIsHotspot")
    wifi_hotspot_ssid: Optional[str] = Field(default=None, alias="wifiHotspotSsid")
    wifi_internet_source: Optional[str] = Field(default=None, alias="wifiInternetSource")
    wifi_internet_via: Optional[str] = Field(default=None, alias="wifiInternetVia")
    ethernet_connected: bool = Field(alias="ethernetConnected")
    ethernet_ip: Optional[str] = Field(default=None, alias="ethernetIp")
    can0_up: bool = Field(alias="can0Up")
    can0_bitrate: Optional[int] = Field(default=None, alias="can0Bitrate")
    can1_up: bool = Field(alias="can1Up")
    can1_bitrate: Optional[int] = Field(default=None, alias="can1Bitrate")
    vcan0_up: bool = Field(alias="vcan0Up")
    api_running: bool = Field(alias="apiRunning")
    web_running: bool = Field(alias="webRunning")
    
    class Config:
        populate_by_name = True


class CANInterfaceStatus(BaseModel):
    interface: str
    up: bool
    bitrate: Optional[int] = None
    tx_packets: int = Field(alias="txPackets", default=0)
    rx_packets: int = Field(alias="rxPackets", default=0)
    errors: int = 0

    class Config:
        populate_by_name = True


# =============================================================================
# Helper Functions - Filesystem
# =============================================================================

def sanitize_id(value: str) -> str:
    """Sanitize any ID to prevent path traversal"""
    # Remove any path separators or dangerous characters
    safe = re.sub(r'[^a-zA-Z0-9_\-]', '', value)
    if not safe or safe.startswith('.'):
        raise HTTPException(status_code=400, detail=f"ID invalide: {value}")
    return safe

def get_mission_dir(mission_id: str) -> Path:
    """Get mission directory from filesystem"""
    safe_id = sanitize_id(mission_id)
    return MISSIONS_DIR / safe_id


def get_mission_file(mission_id: str) -> Path:
    """Get mission.json path"""
    return get_mission_dir(mission_id) / "mission.json"


def get_mission_logs_dir(mission_id: str) -> Path:
    """Get logs directory for a mission"""
    path = get_mission_dir(mission_id) / "logs"
    path.mkdir(parents=True, exist_ok=True)
    return path


def load_mission(mission_id: str) -> dict:
    """Load mission from filesystem"""
    file_path = get_mission_file(mission_id)
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Mission not found")
    with open(file_path, "r") as f:
        return json.load(f)


def save_mission(mission_id: str, data: dict):
    """Save mission to filesystem"""
    mission_dir = get_mission_dir(mission_id)
    mission_dir.mkdir(parents=True, exist_ok=True)
    file_path = get_mission_file(mission_id)
    with open(file_path, "w") as f:
        json.dump(data, f, indent=2, default=str)


def list_all_missions() -> list[dict]:
    """List all missions from filesystem"""
    missions = []
    for mission_dir in MISSIONS_DIR.iterdir():
        if mission_dir.is_dir():
            mission_file = mission_dir / "mission.json"
            if mission_file.exists():
                try:
                    with open(mission_file, "r") as f:
                        missions.append(json.load(f))
                except Exception:
                    continue
    return sorted(missions, key=lambda x: x.get("updatedAt", ""), reverse=True)


def count_log_frames(log_file: Path) -> int:
    """Count frames in a candump log file"""
    try:
        with open(log_file, "r") as f:
            return sum(1 for line in f if line.strip() and not line.startswith("#"))
    except Exception:
        return 0


def update_mission_stats(mission_id: str, new_capture: bool = False):
    """Update mission log/frame counts and optionally lastCaptureDate"""
    mission = load_mission(mission_id)
    logs_dir = get_mission_logs_dir(mission_id)
    
    logs_count = 0
    frames_count = 0
    latest_log_time = None
    
    for log_file in logs_dir.glob("*.log"):
        logs_count += 1
        frames_count += count_log_frames(log_file)
        # Track latest log modification time
        log_mtime = log_file.stat().st_mtime
        if latest_log_time is None or log_mtime > latest_log_time:
            latest_log_time = log_mtime
    
    mission["logsCount"] = logs_count
    mission["framesCount"] = frames_count
    mission["updatedAt"] = datetime.now().isoformat()
    
    # Update lastCaptureDate if we have logs
    if new_capture or (latest_log_time and not mission.get("lastCaptureDate")):
        mission["lastCaptureDate"] = datetime.now().isoformat()
    elif latest_log_time and logs_count > 0:
        # Set from latest log file if not set
        mission["lastCaptureDate"] = datetime.fromtimestamp(latest_log_time).isoformat()
    
    save_mission(mission_id, mission)


# =============================================================================
# Helper Functions - CAN Commands (Linux can-utils)
# =============================================================================

def run_command(cmd: list[str], check: bool = True, timeout: int = 10) -> subprocess.CompletedProcess:
    """
    Execute a system command.
    This is the ONLY place where shell commands are executed.
    All CAN operations go through here.
    """
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=check,
        )
        return result
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail=f"Command timeout: {' '.join(cmd)}")
    except subprocess.CalledProcessError as e:
        raise HTTPException(
            status_code=500, 
            detail=f"Command failed: {e.stderr or e.stdout or str(e)}"
        )


async def run_command_async(cmd: list[str]) -> asyncio.subprocess.Process:
    """Start an async subprocess"""
    return await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )


def get_can_interface_status(interface: str) -> CANInterfaceStatus:
    """
    Get CAN interface status using `ip -details link show`
    Parses the output to extract state and bitrate.
    
    Note: For vcan interfaces, operstate is "UNKNOWN" (no physical link),
    so we also check the flags for "UP".
    """
    try:
        result = run_command(["ip", "-details", "-json", "link", "show", interface], check=False)
        if result.returncode != 0:
            return CANInterfaceStatus(interface=interface, up=False)
        
        data = json.loads(result.stdout)
        if not data:
            return CANInterfaceStatus(interface=interface, up=False)
        
        iface_data = data[0]
        operstate = iface_data.get("operstate", "DOWN").upper()
        flags = iface_data.get("flags", [])
        
        # Interface is up if operstate is UP, or if it's UNKNOWN but has UP flag
        # (vcan interfaces have operstate=UNKNOWN but flags include "UP")
        up = operstate == "UP" or (operstate == "UNKNOWN" and "UP" in flags)
        
        # Extract bitrate from linkinfo (not applicable for vcan)
        bitrate = None
        linkinfo = iface_data.get("linkinfo", {})
        info_data = linkinfo.get("info_data", {})
        bitrate = info_data.get("bittiming", {}).get("bitrate")
        
        # Get stats
        stats = iface_data.get("stats64", iface_data.get("stats", {}))
        
        return CANInterfaceStatus(
            interface=interface,
            up=up,
            bitrate=bitrate,
            txPackets=stats.get("tx", {}).get("packets", 0),
            rxPackets=stats.get("rx", {}).get("packets", 0),
            errors=stats.get("rx", {}).get("errors", 0) + stats.get("tx", {}).get("errors", 0),
        )
    except Exception:
        return CANInterfaceStatus(interface=interface, up=False)


def can_interface_up(interface: str, bitrate: int):
    """
    Bring up a CAN interface with specified bitrate.
    Uses: ip link set can0 down && ip link set can0 type can bitrate 500000 && ip link set can0 up
    """
    # First bring down if already up
    run_command(["ip", "link", "set", interface, "down"], check=False)
    
    # Set bitrate
    run_command(["ip", "link", "set", interface, "type", "can", "bitrate", str(bitrate)])
    
    # Bring up
    run_command(["ip", "link", "set", interface, "up"])


def can_interface_down(interface: str):
    """
    Bring down a CAN interface.
    Uses: ip link set can0 down
    """
    run_command(["ip", "link", "set", interface, "down"])


def can_send_frame(interface: str, can_id: str, data: str) -> tuple[bool, str]:
    """
    Send a single CAN frame.
    Uses: cansend can0 7DF#02010C
    
    Args:
        interface: CAN interface (can0, can1, vcan0)
        can_id: CAN ID in hex (e.g., "7DF", "18DAF110")
        data: Data bytes in hex (e.g., "02010C" or "02 01 0C")
    
    Returns:
        Tuple of (success: bool, error_message: str)
    """
    # Clean up data - remove spaces
    data_clean = data.replace(" ", "").upper()
    can_id_clean = can_id.replace("0x", "").upper()
    
    # Validate hex format to prevent injection
    if not re.match(r'^[0-9A-F]{1,8}$', can_id_clean):
        return False, f"CAN ID invalide: {can_id_clean}"
    if data_clean and not re.match(r'^[0-9A-F]{0,16}$', data_clean):
        return False, f"Data invalide: {data_clean}"
    
    frame = f"{can_id_clean}#{data_clean}"
    try:
        result = run_command(["cansend", interface, frame], check=False)
        if result.returncode == 0:
            return True, ""
        else:
            error = result.stderr.strip() if result.stderr else f"cansend returned code {result.returncode}"
            return False, error
    except Exception as e:
        return False, str(e)


async def broadcast_to_websockets(message: str):
    """Send message to all connected WebSocket clients"""
    disconnected = []
    for ws in state.websocket_clients:
        try:
            await ws.send_text(message)
        except Exception:
            disconnected.append(ws)
    for ws in disconnected:
        state.websocket_clients.remove(ws)


# =============================================================================
# CAN dump WebSocket Manager
# =============================================================================

class CandumpManager:
    def __init__(self):
        self.process: Optional[asyncio.subprocess.Process] = None
        self.task: Optional[asyncio.Task] = None
        self.interface: Optional[str] = None
        self.clients: List[WebSocket] = []
        self.lock = asyncio.Lock()

    async def _stop_process(self):
        if self.task and not self.task.done():
            self.task.cancel()
        self.task = None

        if self.process and self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                self.process.kill()
        self.process = None
        self.interface = None

    async def ensure_running(self, interface: str):
        async with self.lock:
            if (
                self.process
                and self.process.returncode is None
                and self.interface == interface
                and self.task
                and not self.task.done()
            ):
                return

            await self._stop_process()

            self.process = await asyncio.create_subprocess_exec(
                "candump", "-ta", interface,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            self.interface = interface

            async def reader_loop():
                try:
                    assert self.process and self.process.stdout
                    while True:
                        line = await self.process.stdout.readline()
                        if not line:
                            break

                        decoded = line.decode(errors="ignore").strip()
                        if not decoded:
                            continue

                        parts = decoded.split()
                        if len(parts) < 3:
                            continue

                        timestamp = parts[0].strip("()")
                        iface = parts[1]
                        frame_parts = parts[2].split("#")
                        if len(frame_parts) != 2:
                            continue

                        can_id, data = frame_parts
                        data_formatted = " ".join(data[i:i+2] for i in range(0, len(data), 2))

                        payload = json.dumps({
                            "timestamp": timestamp,
                            "interface": iface,
                            "canId": can_id,
                            "data": data_formatted,
                        })

                        await self.broadcast(payload)

                except asyncio.CancelledError:
                    pass
                except Exception:
                    pass

            self.task = asyncio.create_task(reader_loop())

    async def broadcast(self, message: str):
        dead: List[WebSocket] = []
        for ws in self.clients:
            try:
                await ws.send_text(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            if ws in self.clients:
                self.clients.remove(ws)

    async def add_client(self, ws: WebSocket):
        self.clients.append(ws)

    async def remove_client(self, ws: WebSocket):
        if ws in self.clients:
            self.clients.remove(ws)
        if not self.clients:
            async with self.lock:
                await self._stop_process()


candump_mgr = CandumpManager()


# =============================================================================
# System Status
# =============================================================================

@app.get("/status", response_model=SystemStatus)
@app.get("/api/status", response_model=SystemStatus)  # alias
async def get_system_status():
    """
    Get complete Raspberry Pi system status.
    Reads from /proc and /sys filesystems and uses ip commands.
    """
    # Hostname
    try:
        with open("/etc/hostname", "r") as f:
            hostname = f.read().strip()
    except Exception:
        hostname = "aurige-pi"
    
    # Uptime
    try:
        with open("/proc/uptime", "r") as f:
            uptime_seconds = int(float(f.read().split()[0]))
    except Exception:
        uptime_seconds = 0
    
    # CPU usage
    try:
        with open("/proc/stat", "r") as f:
            cpu_line = f.readline()
            cpu_values = [int(x) for x in cpu_line.split()[1:]]
            idle = cpu_values[3]
            total = sum(cpu_values)
            cpu_usage = 100.0 * (1 - idle / total) if total > 0 else 0.0
    except Exception:
        cpu_usage = 0.0

    # Temp
    try:
        with open("/sys/class/thermal/thermal_zone0/temp", "r") as f:
            temperature = int(f.read().strip()) / 1000.0
    except Exception:
        temperature = 0.0

    # Memory
    try:
        with open("/proc/meminfo", "r") as f:
            meminfo = {}
            for line in f:
                parts = line.split()
                if len(parts) >= 2:
                    meminfo[parts[0].rstrip(":")] = int(parts[1])
            memory_total = meminfo.get("MemTotal", 0) / 1024
            memory_free = meminfo.get("MemAvailable", meminfo.get("MemFree", 0)) / 1024
            memory_used = memory_total - memory_free
    except Exception:
        memory_total = 8192.0
        memory_used = 4096.0

    # Storage
    try:
        statvfs = os.statvfs("/")
        storage_total = (statvfs.f_frsize * statvfs.f_blocks) / (1024 ** 3)
        storage_free = (statvfs.f_frsize * statvfs.f_bavail) / (1024 ** 3)
        storage_used = storage_total - storage_free
    except Exception:
        storage_total = 64.0
        storage_used = 32.0
    
    # Network - WiFi
    wifi_connected = False
    wifi_ip = None
    wifi_ssid = None
    wifi_signal = None
    wifi_tx_rate = None
    wifi_rx_rate = None
    wifi_is_hotspot = False
    wifi_hotspot_ssid = None
    try:
        result = run_command(["ip", "-json", "addr", "show", "wlan0"], check=False)
        if result.returncode == 0:
            data = json.loads(result.stdout)
            if data:
                for addr_info in data[0].get("addr_info", []):
                    if addr_info.get("family") == "inet":
                        wifi_ip = addr_info.get("local")
                        wifi_connected = True
                        # Check if it's a hotspot IP (10.42.0.x)
                        if wifi_ip and wifi_ip.startswith("10.42.0."):
                            wifi_is_hotspot = True
                        break
        
        if wifi_connected:
            # Check nmcli for connection info and mode
            nmcli_result = run_command(["nmcli", "-t", "-f", "NAME,TYPE,DEVICE", "connection", "show", "--active"], check=False)
            for line in nmcli_result.stdout.strip().split("\n"):
                parts = line.split(":")
                if len(parts) >= 3 and parts[2] == "wlan0":
                    conn_name = parts[0]
                    # Check if AP mode
                    mode_result = run_command(["nmcli", "-t", "-f", "802-11-wireless.mode", "connection", "show", conn_name], check=False)
                    mode = mode_result.stdout.strip().split(":")[-1] if mode_result.returncode == 0 else ""
                    if mode == "ap" or "hotspot" in conn_name.lower() or "aurige" in conn_name.lower():
                        wifi_is_hotspot = True
                        # Get actual SSID from connection settings (not connection name)
                        ssid_result = run_command(["nmcli", "-t", "-f", "802-11-wireless.ssid", "connection", "show", conn_name], check=False)
                        if ssid_result.returncode == 0:
                            ssid_line = ssid_result.stdout.strip()
                            wifi_hotspot_ssid = ssid_line.split(":")[-1] if ":" in ssid_line else conn_name
                        else:
                            wifi_hotspot_ssid = conn_name
                    break
            
            if not wifi_is_hotspot:
                # Get SSID using iwgetid
                ssid_result = run_command(["iwgetid", "-r", "wlan0"], check=False)
                if ssid_result.returncode == 0 and ssid_result.stdout.strip():
                    wifi_ssid = ssid_result.stdout.strip()
                
                # Get signal and rates from iw
                iw_result = run_command(["iw", "dev", "wlan0", "link"], check=False)
                for line in iw_result.stdout.split("\n"):
                    if "SSID:" in line and not wifi_ssid:
                        wifi_ssid = line.split("SSID:")[1].strip()
                    if "signal:" in line:
                        try:
                            wifi_signal = int(line.split("signal:")[1].strip().split()[0])
                        except:
                            pass
                    if "tx bitrate:" in line:
                        wifi_tx_rate = line.split("tx bitrate:")[1].strip().split()[0] + " Mbps"
                    if "rx bitrate:" in line:
                        wifi_rx_rate = line.split("rx bitrate:")[1].strip().split()[0] + " Mbps"
    except Exception:
        pass
    
    # Detect internet source if in hotspot mode
    wifi_internet_source = None
    wifi_internet_via = None
    if wifi_is_hotspot:
        try:
            route_result = run_command(["ip", "route", "show", "default"], check=False)
            if route_result.returncode == 0:
                for line in route_result.stdout.strip().split("\n"):
                    if "default" in line:
                        parts = line.split()
                        if "dev" in parts:
                            idx = parts.index("dev")
                            if idx + 1 < len(parts):
                                iface = parts[idx + 1]
                                if iface == "eth0":
                                    wifi_internet_source = "Ethernet"
                                elif iface.startswith("usb") or iface.startswith("enx"):
                                    wifi_internet_source = "USB Tethering"
                                elif iface == "wlan1":
                                    wifi_internet_source = "WiFi (wlan1)"
                                    ssid_r = run_command(["iwgetid", "-r", iface], check=False)
                                    if ssid_r.returncode == 0 and ssid_r.stdout.strip():
                                        wifi_internet_via = ssid_r.stdout.strip()
                                else:
                                    wifi_internet_source = iface
                        break
        except:
            pass
    
    # Network - Ethernet
    ethernet_connected = False
    ethernet_ip = None
    try:
        result = run_command(["ip", "-json", "addr", "show", "eth0"], check=False)
        if result.returncode == 0:
            data = json.loads(result.stdout)
            if data:
                for addr_info in data[0].get("addr_info", []):
                    if addr_info.get("family") == "inet":
                        ethernet_ip = addr_info.get("local")
                        ethernet_connected = True
                        break
    except Exception:
        pass
    
    # CAN interfaces
    can0_status = get_can_interface_status("can0")
    can1_status = get_can_interface_status("can1")
    vcan0_status = get_can_interface_status("vcan0")
    
    # Services
    api_running = True  # We're running
    try:
        result = run_command(["systemctl", "is-active", "aurige-web"], check=False)
        web_running = result.stdout.strip() == "active"
    except Exception:
        web_running = True
    
    return SystemStatus(
        hostname=hostname,
        uptimeSeconds=uptime_seconds,
        cpuUsage=round(cpu_usage, 1),
        temperature=round(temperature, 1),
        memoryUsed=round(memory_used, 0),
        memoryTotal=round(memory_total, 0),
        storageUsed=round(storage_used, 1),
        storageTotal=round(storage_total, 1),
        wifiConnected=wifi_connected,
        wifiIp=wifi_ip,
        wifiSsid=wifi_ssid,
        wifiSignal=wifi_signal,
        wifiTxRate=wifi_tx_rate,
        wifiRxRate=wifi_rx_rate,
        wifiIsHotspot=wifi_is_hotspot,
        wifiHotspotSsid=wifi_hotspot_ssid,
        wifiInternetSource=wifi_internet_source,
        wifiInternetVia=wifi_internet_via,
        ethernetConnected=ethernet_connected,
        ethernetIp=ethernet_ip,
        can0Up=can0_status.up,
        can0Bitrate=can0_status.bitrate,
        can1Up=can1_status.up,
        can1Bitrate=can1_status.bitrate,
        vcan0Up=vcan0_status.up,
        apiRunning=api_running,
        webRunning=web_running,
    )


@app.get("/api/can/{interface}/status", response_model=CANInterfaceStatus)
async def get_can_status(interface: str):
    """Get status of a specific CAN interface"""
    if interface not in ["can0", "can1", "vcan0"]:
        raise HTTPException(status_code=400, detail="Invalid interface. Use can0, can1, or vcan0.")
    return get_can_interface_status(interface)


# =============================================================================
# CAN Control Endpoints
# =============================================================================

@app.post("/api/can/init")
async def initialize_can(request: CANInitRequest):
    """
    Initialize a CAN interface with specified bitrate.
    
    For physical interfaces (can0, can1):
    - ip link set canX down
    - ip link set canX type can bitrate BITRATE
    - ip link set canX up
    
    For virtual interface (vcan0):
    - modprobe vcan (load module)
    - ip link add dev vcan0 type vcan
    - ip link set up vcan0
    """
    if request.interface not in ["can0", "can1", "vcan0"]:
        raise HTTPException(status_code=400, detail="Invalid interface")
    
    if request.interface == "vcan0":
        # Virtual CAN for testing - no bitrate needed
        try:
            subprocess.run(["modprobe", "vcan"], check=False)
            # Check if vcan0 already exists
            result = subprocess.run(["ip", "link", "show", "vcan0"], capture_output=True)
            if result.returncode != 0:
                subprocess.run(["ip", "link", "add", "dev", "vcan0", "type", "vcan"], check=True)
            subprocess.run(["ip", "link", "set", "up", "vcan0"], check=True)
        except subprocess.CalledProcessError as e:
            raise HTTPException(status_code=500, detail=f"Failed to initialize vcan0: {e}")
        return {
            "status": "initialized",
            "interface": "vcan0",
            "bitrate": 0,  # vcan has no bitrate
        }
    
    if request.bitrate not in [20000, 50000, 100000, 125000, 250000, 500000, 800000, 1000000]:
        raise HTTPException(status_code=400, detail="Invalid bitrate")
    
    can_interface_up(request.interface, request.bitrate)
    
    return {
        "status": "initialized",
        "interface": request.interface,
        "bitrate": request.bitrate,
    }


class BitrateScanResult(BaseModel):
    bitrate: int
    bitrate_label: str
    frames_received: int
    errors: int
    unique_ids: int
    score: float  # 0-100
    
class BitrateScanResponse(BaseModel):
    interface: str
    results: list[BitrateScanResult]
    best_bitrate: Optional[int] = None
    best_score: float = 0.0
    scan_duration_ms: int

@app.post("/api/can/scan-bitrate")
async def scan_bitrate(interface: str = Query(default="can0"), timeout: float = Query(default=1.5)):
    """
    Auto-detect CAN bus bitrate by trying each common bitrate and scoring results.
    
    Algorithm:
    1. For each candidate bitrate: bring interface up, listen for frames
    2. Score based on: valid frames received, unique CAN IDs, error count
    3. Return all results sorted by score, with best bitrate highlighted
    """
    if interface not in ["can0", "can1"]:
        raise HTTPException(status_code=400, detail="Scan bitrate uniquement sur interfaces physiques (can0, can1)")
    
    candidate_bitrates = [
        (20000, "20 kbit/s"),
        (50000, "50 kbit/s"),
        (100000, "100 kbit/s"),
        (125000, "125 kbit/s"),
        (250000, "250 kbit/s"),
        (500000, "500 kbit/s"),
        (800000, "800 kbit/s"),
        (1000000, "1 Mbit/s"),
    ]
    
    results = []
    start_time = time.time()
    
    for bitrate, label in candidate_bitrates:
        # Bring interface down first
        run_command(["ip", "link", "set", interface, "down"], check=False)
        await asyncio.sleep(0.1)
        
        try:
            # Set bitrate and bring up
            run_command(["ip", "link", "set", interface, "type", "can", "bitrate", str(bitrate)])
            run_command(["ip", "link", "set", interface, "up"])
            await asyncio.sleep(0.1)
            
            # Listen with candump for timeout seconds
            proc = await asyncio.create_subprocess_exec(
                "candump", interface, "-t", "a",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            
            frames = []
            try:
                # Read frames with timeout
                end_time = asyncio.get_event_loop().time() + timeout
                while asyncio.get_event_loop().time() < end_time:
                    try:
                        line = await asyncio.wait_for(
                            proc.stdout.readline(),
                            timeout=max(0.1, end_time - asyncio.get_event_loop().time())
                        )
                        if line:
                            decoded = line.decode("utf-8", errors="ignore").strip()
                            if decoded:
                                frames.append(decoded)
                    except asyncio.TimeoutError:
                        break
            finally:
                proc.terminate()
                try:
                    await asyncio.wait_for(proc.wait(), timeout=1.0)
                except asyncio.TimeoutError:
                    proc.kill()
            
            # Parse frames and count unique IDs
            unique_ids = set()
            valid_frames = 0
            for frame in frames:
                match = re.search(r"([0-9A-Fa-f]+)#([0-9A-Fa-f]*)", frame)
                if match:
                    valid_frames += 1
                    unique_ids.add(match.group(1).upper())
            
            # Get error count from interface stats
            err_count = 0
            try:
                stat_result = run_command(["ip", "-details", "-json", "link", "show", interface], check=False)
                if stat_result.returncode == 0:
                    stat_data = json.loads(stat_result.stdout)
                    if stat_data:
                        stats = stat_data[0].get("stats64", {})
                        err_count = stats.get("rx", {}).get("errors", 0) + stats.get("tx", {}).get("errors", 0)
            except Exception:
                pass
            
            # Score calculation
            score = 0.0
            if valid_frames > 0:
                # Base score: did we receive frames?
                score += min(40.0, valid_frames * 4.0)
                # Unique IDs bonus: more variety = more confident
                score += min(30.0, len(unique_ids) * 5.0)
                # Low errors bonus
                if err_count == 0:
                    score += 20.0
                elif err_count < 5:
                    score += 10.0
                # Consistency bonus: high frame count relative to time
                frames_per_sec = valid_frames / timeout
                if frames_per_sec > 10:
                    score += 10.0
                elif frames_per_sec > 5:
                    score += 5.0
            
            score = min(100.0, score)
            
            results.append(BitrateScanResult(
                bitrate=bitrate,
                bitrate_label=label,
                frames_received=valid_frames,
                errors=err_count,
                unique_ids=len(unique_ids),
                score=round(score, 1),
            ))
            
        except Exception:
            results.append(BitrateScanResult(
                bitrate=bitrate,
                bitrate_label=label,
                frames_received=0,
                errors=0,
                unique_ids=0,
                score=0.0,
            ))
        
        # Bring down after test
        run_command(["ip", "link", "set", interface, "down"], check=False)
    
    # Sort by score descending
    results.sort(key=lambda r: -r.score)
    
    best = results[0] if results and results[0].score > 0 else None
    scan_ms = int((time.time() - start_time) * 1000)
    
    return BitrateScanResponse(
        interface=interface,
        results=results,
        best_bitrate=best.bitrate if best else None,
        best_score=best.score if best else 0.0,
        scan_duration_ms=scan_ms,
    )


@app.post("/api/can/stop")
async def stop_can(interface: str = Query(default="can0")):
    """Stop a CAN interface"""
    if interface not in ["can0", "can1", "vcan0"]:
        raise HTTPException(status_code=400, detail="Invalid interface")
    
    can_interface_down(interface)
    
    return {"status": "stopped", "interface": interface}


@app.post("/api/can/send")
async def send_can_frame(frame: CANFrame):
    """
    Send a single CAN frame.
    
    Executes: cansend canX ID#DATA
    """
    if frame.interface not in ["can0", "can1", "vcan0"]:
        raise HTTPException(status_code=400, detail="Invalid interface")
    
    success, error = can_send_frame(frame.interface, frame.can_id, frame.data)
    
    if not success:
        raise HTTPException(status_code=500, detail=f"Failed to send frame: {error}")
    
    return {
        "status": "sent",
        "interface": frame.interface,
        "canId": frame.can_id,
        "data": frame.data,
    }


# =============================================================================
# Capture Endpoints
# =============================================================================

@app.post("/api/capture/start")
async def start_capture(request: CaptureStartRequest):
    """
    Start capturing CAN traffic to a log file.
    
    Executes: candump -L canX > mission/logs/filename.log
    """
    if state.capture_process and state.capture_process.returncode is None:
        raise HTTPException(status_code=409, detail="Capture already running")
    
    # Verify mission exists
    load_mission(request.mission_id)
    
    # Generate filename
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = request.filename or f"capture_{timestamp}.log"
    if not filename.endswith(".log"):
        filename += ".log"
    
    logs_dir = get_mission_logs_dir(request.mission_id)
    log_path = logs_dir / filename
    
    # Start candump with log format
    # candump -L outputs in standard log format that canplayer can replay
    state.capture_process = await asyncio.create_subprocess_exec(
        "candump", "-L", request.interface,
        stdout=open(log_path, "w"),
        stderr=asyncio.subprocess.PIPE,
    )
    state.capture_file = log_path
    state.capture_start_time = datetime.now()
    
    # Save metadata
    meta_path = log_path.with_suffix(".meta.json")
    with open(meta_path, "w") as f:
        json.dump({
            "description": request.description,
            "interface": request.interface,
            "startTime": state.capture_start_time.isoformat(),
        }, f)
    
    return {
        "status": "started",
        "missionId": request.mission_id,
        "filename": filename,
        "interface": request.interface,
    }


@app.post("/api/capture/stop")
async def stop_capture():
    """Stop the running capture"""
    if not state.capture_process or state.capture_process.returncode is not None:
        raise HTTPException(status_code=404, detail="No capture running")
    
    # Calculate duration
    duration = 0
    if state.capture_start_time:
        duration = int((datetime.now() - state.capture_start_time).total_seconds())
    
    # Stop process
    state.capture_process.terminate()
    try:
        await asyncio.wait_for(state.capture_process.wait(), timeout=5.0)
    except asyncio.TimeoutError:
        state.capture_process.kill()
    
    # Update metadata with duration
    if state.capture_file:
        meta_path = state.capture_file.with_suffix(".meta.json")
        if meta_path.exists():
            with open(meta_path, "r") as f:
                meta = json.load(f)
            meta["durationSeconds"] = duration
            meta["endTime"] = datetime.now().isoformat()
            with open(meta_path, "w") as f:
                json.dump(meta, f)
        
        # Update mission stats with new capture flag
        mission_id = state.capture_file.parent.parent.name
        update_mission_stats(mission_id, new_capture=True)
        
        filename = state.capture_file.name
    else:
        filename = None
    
    # Clear state
    state.capture_process = None
    state.capture_file = None
    state.capture_start_time = None
    
    return {
        "status": "stopped",
        "filename": filename,
        "durationSeconds": duration,
    }


@app.get("/api/capture/status")
async def get_capture_status():
    """Get current capture status"""
    is_running = state.capture_process and state.capture_process.returncode is None
    duration = 0
    if is_running and state.capture_start_time:
        duration = int((datetime.now() - state.capture_start_time).total_seconds())
    
    return {
        "running": is_running,
        "filename": state.capture_file.name if state.capture_file else None,
        "durationSeconds": duration,
    }


# =============================================================================
# Replay Endpoints
# =============================================================================

@app.post("/api/replay/start")
async def start_replay(request: ReplayRequest):
    """
    Start replaying a log file.
    
    Executes: canplayer -I logfile canX=canX
    """
    if state.canplayer_process and state.canplayer_process.returncode is None:
        raise HTTPException(status_code=409, detail="Replay already running")
    
    # Get log file
    logs_dir = get_mission_logs_dir(request.mission_id)
    log_file = logs_dir / f"{request.log_id}.log"
    
    if not log_file.exists():
        raise HTTPException(status_code=404, detail="Log file not found")
    
    # Parse log file and build a bash script using cansend (like fuzzing does)
    # canplayer is unreliable, cansend works everywhere in the app
    frames = []
    try:
        with open(log_file, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                # Format: (1234.567890) can0 123#DEADBEEF
                parts = line.split()
                if len(parts) >= 3 and '#' in parts[2]:
                    ts_str = parts[0].strip('()')
                    frame_data = parts[2]  # ID#DATA - exact cansend format
                    try:
                        ts = float(ts_str)
                    except ValueError:
                        ts = 0.0
                    frames.append((ts, frame_data))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Cannot parse log: {e}")
    
    if not frames:
        raise HTTPException(status_code=400, detail="Log file contains no frames")
    
    # Build bash script - same pattern as fuzzing which works reliably
    iface = request.interface
    speed = request.speed if request.speed > 0 else 1.0
    
    lines = [f"#!/bin/bash", f"# Replay {len(frames)} frames on {iface}"]
    prev_ts = frames[0][0]
    for i, (ts, frame) in enumerate(frames):
        if i > 0:
            delay = (ts - prev_ts) / speed
            if 0 < delay < 10:
                lines.append(f"sleep {delay:.6f}")
        lines.append(f"cansend {iface} {frame}")
        prev_ts = ts
    
    script_path = Path("/tmp/aurige_replay.sh")
    with open(script_path, "w") as f:
        f.write("\n".join(lines) + "\n")
    script_path.chmod(0o755)
    
    print(f"[REPLAY] {len(frames)} frames on {iface} (speed={speed})")
    state.canplayer_process = await run_command_async(["bash", str(script_path)])
    
    return {
        "status": "started",
        "missionId": request.mission_id,
        "logId": request.log_id,
        "interface": request.interface,
        "speed": request.speed,
    }


@app.post("/api/replay/stop")
async def stop_replay():
    """Stop replay"""
    if not state.canplayer_process or state.canplayer_process.returncode is not None:
        raise HTTPException(status_code=404, detail="No replay running")
    
    state.canplayer_process.terminate()
    try:
        await asyncio.wait_for(state.canplayer_process.wait(), timeout=5.0)
    except asyncio.TimeoutError:
        state.canplayer_process.kill()
    
    state.canplayer_process = None
    
    return {"status": "stopped"}


@app.get("/api/replay/status")
async def get_replay_status():
    """Get replay status"""
    is_running = state.canplayer_process and state.canplayer_process.returncode is None
    return {"running": is_running}


@app.post("/api/replay/force-cleanup")
async def force_cleanup_replay():
    """Force cleanup of replay state (for stuck processes)"""
    # Kill any bash/cansend processes
    try:
        run_command(["pkill", "-f", "aurige_replay.sh"], check=False)
        run_command(["pkill", "-f", "cansend"], check=False)
        await asyncio.sleep(0.5)
    except:
        pass
    
    # Reset state
    if state.canplayer_process:
        try:
            state.canplayer_process.kill()
        except:
            pass
    state.canplayer_process = None
    
    return {"status": "cleaned", "message": "Forced cleanup of replay processes"}


# =============================================================================
# Generator / Fuzzing Endpoints
# =============================================================================

@app.post("/api/generator/start")
async def start_generator(request: GeneratorRequest):
    """
    Start generating CAN traffic.
    
    Executes: cangen canX -g delay -L length [-I id]
    """
    if state.cangen_process and state.cangen_process.returncode is None:
        raise HTTPException(status_code=409, detail="Generator already running")
    
    cmd = [
        "cangen", request.interface,
        "-g", str(request.delay_ms),
        "-L", str(request.data_length),
    ]
    
    if request.can_id:
        # Fixed ID mode
        cmd.extend(["-I", request.can_id])
    
    state.cangen_process = await run_command_async(cmd)
    
    return {
        "status": "started",
        "interface": request.interface,
        "delayMs": request.delay_ms,
    }


@app.post("/api/generator/stop")
async def stop_generator():
    """Stop generator"""
    if not state.cangen_process or state.cangen_process.returncode is not None:
        raise HTTPException(status_code=404, detail="No generator running")
    
    state.cangen_process.terminate()
    try:
        await asyncio.wait_for(state.cangen_process.wait(), timeout=5.0)
    except asyncio.TimeoutError:
        state.cangen_process.kill()
    
    state.cangen_process = None
    
    return {"status": "stopped"}


@app.get("/api/generator/status")
async def get_generator_status():
    """Get generator status"""
    is_running = state.cangen_process and state.cangen_process.returncode is None
    return {"running": is_running}


@app.post("/api/fuzzing/start")
async def start_fuzzing(request: FuzzingRequest):
    """
    Start fuzzing with smart data generation modes:
    - static: send same data_template for all frames
    - random: random bytes for each frame (true fuzzing)
    - range: random bytes within per-byte min/max from log analysis
    - logs: replay actual observed data from mission logs, varying byte by byte
    """
    if state.fuzzing_process and state.fuzzing_process.returncode is None:
        raise HTTPException(status_code=409, detail="Fuzzing already running")
    
    # Validate inputs
    if not re.match(r'^[0-9A-Fa-f]{1,8}$', request.id_start):
        raise HTTPException(status_code=400, detail=f"ID start invalide: {request.id_start}")
    if not re.match(r'^[0-9A-Fa-f]{1,8}$', request.id_end):
        raise HTTPException(status_code=400, detail=f"ID end invalide: {request.id_end}")
    if request.data_template and not re.match(r'^[0-9A-Fa-f]*$', request.data_template):
        raise HTTPException(status_code=400, detail=f"Data template invalide: {request.data_template}")
    if request.interface not in ["can0", "can1", "vcan0"]:
        raise HTTPException(status_code=400, detail="Invalid interface")
    if not (1 <= request.iterations <= 100000):
        raise HTTPException(status_code=400, detail="Iterations must be between 1 and 100000")
    if not (0.1 <= request.delay_ms <= 10000):
        raise HTTPException(status_code=400, detail="Delay must be between 0.1ms and 10000ms")
    
    dlc = max(1, min(request.dlc, 8))
    mode = request.data_mode
    
    # PRE-FUZZ CAPTURE: Record baseline traffic before fuzzing
    pre_fuzz_log_path = None
    if request.enable_pre_fuzz_capture and request.mission_id:
        try:
            from datetime import datetime
            logs_dir = get_mission_logs_dir(request.mission_id)
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            pre_fuzz_log_path = logs_dir / f"pre_fuzz_{timestamp}.log"
            
            # Run candump for N seconds to capture baseline
            duration = request.pre_fuzz_duration_sec
            candump_cmd = [
                "timeout", str(duration),
                "candump", request.interface,
                "-L"
            ]
            
            with open(pre_fuzz_log_path, "w") as log_f:
                result = run_command(candump_cmd, check=False, stdout=log_f)
            
            # Create metadata
            meta_path = logs_dir / f"pre_fuzz_{timestamp}.meta.json"
            with open(meta_path, "w") as meta_f:
                json.dump({
                    "type": "pre_fuzz_capture",
                    "duration": duration,
                    "interface": request.interface,
                    "timestamp": timestamp,
                }, meta_f)
            
            print(f"Pre-fuzz capture saved: {pre_fuzz_log_path}")
        except Exception as e:
            print(f"Pre-fuzz capture failed: {e}")
            # Continue anyway - not critical
    
    # Build Python fuzzing script (more flexible than bash for data generation)
    # Pre-compute data based on mode
    
    # For "logs" mode, extract real samples from mission logs
    log_samples_code = ""
    if mode == "logs" and request.mission_id:
        logs_dir = get_mission_logs_dir(request.mission_id)
        id_samples: dict = {}  # canId -> [data_hex, ...]
        
        log_files = []
        if request.log_id:
            target = logs_dir / f"{request.log_id}.log"
            if target.exists():
                log_files = [target]
        else:
            log_files = list(logs_dir.glob("*.log"))
        
        for log_file in log_files:
            if log_file.name.endswith(".meta.json"):
                continue
            try:
                with open(log_file, "r") as f:
                    for line in f:
                        line = line.strip()
                        if not line or line.startswith("#"):
                            continue
                        try:
                            parts = line.split()
                            if len(parts) >= 3:
                                frame_parts = parts[2].split("#")
                                if len(frame_parts) == 2:
                                    cid = frame_parts[0].upper()
                                    dhex = frame_parts[1].upper()
                                    if cid not in id_samples:
                                        id_samples[cid] = []
                                    if len(id_samples[cid]) < 200:
                                        id_samples[cid].append(dhex)
                        except:
                            continue
            except:
                continue
        
        # Serialize samples into the script
        log_samples_code = f"LOG_SAMPLES = {json.dumps(id_samples)}\n"
    
    # For "range" mode, build per-byte constraints
    byte_ranges_code = ""
    if mode == "range" and request.byte_ranges:
        byte_ranges_code = f"BYTE_RANGES = {json.dumps(request.byte_ranges)}\n"
    
    # For "target_ids" mode with specific IDs
    target_ids = request.target_ids or []
    
    # Prepare mission log paths for during-fuzz capture and history
    during_fuzz_log_path = None
    history_file_path = "/tmp/aurige_fuzz_history.json"  # Fallback
    
    if request.mission_id:
        from datetime import datetime
        logs_dir = get_mission_logs_dir(request.mission_id)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        during_fuzz_log_path = logs_dir / f"during_fuzz_{timestamp}.log"
        history_file_path = str(logs_dir / f"fuzz_history_{timestamp}.json")
    
    script_content = f'''#!/usr/bin/env python3
import subprocess
import time
import random
import sys
import json
import signal
import os

INTERFACE = "{request.interface}"
ID_START = 0x{request.id_start}
ID_END = 0x{request.id_end}
ITERATIONS = {request.iterations}
DELAY_SEC = {request.delay_ms} / 1000.0
DLC = {dlc}
MODE = "{mode}"
DATA_TEMPLATE = "{request.data_template or ''}"
TARGET_IDS = {json.dumps(target_ids)}
MISSION_ID = "{request.mission_id or ''}"
HISTORY_FILE = "{history_file_path}"
DURING_FUZZ_LOG = "{during_fuzz_log_path}" if "{during_fuzz_log_path}" != "None" else None
{log_samples_code}
{byte_ranges_code}

# Initialize history with ALL frames (sent + metadata)
history = {{
    "mission_id": MISSION_ID,
    "started_at": time.time(),
    "stopped_at": None,
    "total_sent": 0,
    "frames_sent": [],
    "during_fuzz_log": DURING_FUZZ_LOG,
}}

# Start candump in background to record all CAN traffic during fuzzing
candump_process = None
candump_log_file = None
if DURING_FUZZ_LOG:
    try:
        candump_log_file = open(DURING_FUZZ_LOG, "w")
        candump_process = subprocess.Popen(
            ["candump", INTERFACE, "-L"],
            stdout=candump_log_file,
            stderr=subprocess.DEVNULL
        )
        print(f"[FUZZ] Recording CAN traffic to {{DURING_FUZZ_LOG}}")
    except Exception as e:
        print(f"[FUZZ] Warning: Could not start candump: {{e}}")

def cleanup():
    """Stop candump on exit"""
    if candump_process:
        candump_process.terminate()
        try:
            candump_process.wait(timeout=2)
        except:
            candump_process.kill()
    if candump_log_file:
        candump_log_file.close()

signal.signal(signal.SIGTERM, lambda s, f: cleanup())
signal.signal(signal.SIGINT, lambda s, f: cleanup())

def generate_data_random():
    return "".join("{{:02X}}".format(random.randint(0, 255)) for _ in range(DLC))

def generate_data_static():
    if DATA_TEMPLATE:
        return DATA_TEMPLATE[:DLC*2].ljust(DLC*2, '0')
    return "00" * DLC

def generate_data_range():
    if not BYTE_RANGES:
        return generate_data_random()
    data = []
    for i in range(DLC):
        matching = [br for br in BYTE_RANGES if br["index"] == i]
        if matching:
            br = matching[0]
            val = random.randint(br["min"], br["max"])
            data.append("{{:02X}}".format(val))
        else:
            data.append("{{:02X}}".format(random.randint(0, 255)))
    return "".join(data)

def generate_data_logs(can_id):
    if not LOG_SAMPLES or can_id not in LOG_SAMPLES:
        return generate_data_random()
    samples = LOG_SAMPLES[can_id]
    return random.choice(samples)

sent = 0
print("Starting fuzzing on {{}}".format(INTERFACE))

try:
    if TARGET_IDS:
        # Targeted mode: cycle through specific IDs
        for i in range(ITERATIONS):
            can_id_hex = TARGET_IDS[i % len(TARGET_IDS)]
            if MODE == "static":
                data = generate_data_static()
            elif MODE == "range":
                data = generate_data_range()
            elif MODE == "logs":
                data = generate_data_logs(can_id_hex)
            else:
                data = generate_data_random()
            
            frame = "{{}}#{{}}".format(can_id_hex, data)
            subprocess.run(["cansend", INTERFACE, frame], capture_output=True)
            sent += 1
            
            history["frames_sent"].append({{
                "index": sent,
                "id": can_id_hex,
                "data": data,
                "timestamp": time.time()
            }})
            
            if sent % 50 == 0:
                sys.stdout.write("\\rSent {{}}/{{}} frames".format(sent, ITERATIONS))
                sys.stdout.flush()
            time.sleep(DELAY_SEC)
    else:
        # Sweep mode: increment through ID range
        id_range = max(1, ID_END - ID_START + 1)
        for i in range(ITERATIONS):
            current_id = ID_START + (i % id_range)
            can_id_hex = "{{:03X}}".format(current_id)
            
            if MODE == "static":
                data = generate_data_static()
            elif MODE == "range":
                data = generate_data_range()
            elif MODE == "logs":
                data = generate_data_logs(can_id_hex)
            else:
                data = generate_data_random()
            
            frame = "{{}}#{{}}".format(can_id_hex, data)
            subprocess.run(["cansend", INTERFACE, frame], capture_output=True)
            sent += 1
            
            history["frames_sent"].append({{
                "index": sent,
                "id": can_id_hex,
                "data": data,
                "timestamp": time.time()
            }})
            
            if sent % 50 == 0:
                sys.stdout.write("\\rSent {{}}/{{}} frames".format(sent, ITERATIONS))
                sys.stdout.flush()
            time.sleep(DELAY_SEC)
finally:
    cleanup()
    
    history["stopped_at"] = time.time()
    history["total_sent"] = sent
    with open(HISTORY_FILE, "w") as f:
        json.dump(history, f)
    
    print("\\nFuzzing complete: {{}} frames sent.".format(sent))
    print("History saved to {{}}".format(HISTORY_FILE))
    if DURING_FUZZ_LOG:
        print("CAN traffic recorded to {{}}".format(DURING_FUZZ_LOG))
'''
    
    # Write script to file
    script_path = Path("/tmp/aurige_fuzz.py")
    with open(script_path, "w") as f:
        f.write(script_content)
    script_path.chmod(0o755)
    
    # Start process
    state.fuzzing_process = subprocess.Popen(
        ["python3", str(script_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True
    )
    
    return {{"status": "started", "iterations": request.iterations}}


@app.post("/api/fuzzing/stop")
async def stop_fuzzing():
    """Stop fuzzing"""
    if not state.fuzzing_process or state.fuzzing_process.returncode is not None:
        raise HTTPException(status_code=404, detail="No fuzzing running")
    
    # Kill the script and any child cansend processes
    state.fuzzing_process.terminate()
    try:
        await asyncio.wait_for(state.fuzzing_process.wait(), timeout=5.0)
    except asyncio.TimeoutError:
        state.fuzzing_process.kill()
    
    state.fuzzing_process = None
    
    return {"status": "stopped"}


@app.get("/api/fuzzing/status")
async def get_fuzzing_status():
    """Get fuzzing status"""
    is_running = state.fuzzing_process is not None and state.fuzzing_process.returncode is None
    return {"running": is_running}


@app.post("/api/fuzzing/force-cleanup")
async def force_cleanup_fuzzing():
    """Force cleanup of fuzzing state (for stuck processes)"""
    # Kill any python/candump/cansend processes related to fuzzing
    try:
        run_command(["pkill", "-f", "aurige_fuzz.py"], check=False)
        run_command(["pkill", "-f", "candump.*during_fuzz"], check=False)
        run_command(["pkill", "-f", "cansend"], check=False)
        await asyncio.sleep(0.5)
    except:
        pass
    
    # Reset state
    if state.fuzzing_process:
        try:
            state.fuzzing_process.kill()
        except:
            pass
    state.fuzzing_process = None
    
    return {"status": "cleaned", "message": "Forced cleanup of fuzzing processes"}


@app.post("/api/fuzzing/crash-recovery")
async def attempt_crash_recovery(request: CrashRecoveryRequest):
    """
    Attempt to recover from a crash by sending reset frames (00 00 00...).
    If suspect_ids provided, only reset those. Otherwise, try common crash IDs.
    """
    iface = request.interface
    suspect_ids = request.suspect_ids or []
    
    # Common crash-related IDs (airbag, powertrain, BSI status)
    common_crash_ids = ["4C8", "5E8", "3B7", "360", "1A0", "0F6"]
    
    ids_to_reset = suspect_ids if suspect_ids else common_crash_ids
    
    results = []
    for can_id_hex in ids_to_reset:
        # Send zero reset frame
        reset_frame = f"{can_id_hex}#0000000000000000"
        try:
            result = run_command(["cansend", iface, reset_frame], check=False)
            results.append({
                "id": can_id_hex,
                "status": "sent" if result.returncode == 0 else "failed",
                "frame": reset_frame,
            })
            # Small delay between resets
            await asyncio.sleep(0.05)
        except Exception as e:
            results.append({
                "id": can_id_hex,
                "status": "error",
                "error": str(e),
            })
    
    return {
        "status": "recovery_attempted",
        "results": results,
        "message": f"Sent {len([r for r in results if r['status'] == 'sent'])} reset frames",
    }


@app.get("/api/fuzzing/history")
async def get_fuzzing_history(mission_id: Optional[str] = None):
    """
    Get the last fuzzing history (frames sent before potential crash).
    If mission_id provided, reads the most recent history file from that mission's logs.
    Otherwise falls back to /tmp/aurige_fuzz_history.json.
    """
    history_file = None
    
    # Try mission-specific history first
    if mission_id:
        try:
            logs_dir = get_mission_logs_dir(mission_id)
            history_files = sorted(logs_dir.glob("fuzz_history_*.json"), reverse=True)
            if history_files:
                history_file = history_files[0]  # Most recent
        except:
            pass
    
    # Fallback to global temp file
    if not history_file or not history_file.exists():
        history_file = Path("/tmp/aurige_fuzz_history.json")
    
    if not history_file.exists():
        return {
            "exists": False,
            "frames_sent": [],
            "message": "No fuzzing history found. Run fuzzing with crash detection enabled.",
        }
    
    try:
        with open(history_file, "r") as f:
            data = json.load(f)
        return {
            "exists": True,
            "frames_sent": data.get("frames_sent", data.get("frames", [])),
            "started_at": data.get("started_at"),
            "stopped_at": data.get("stopped_at"),
            "total_sent": data.get("total_sent", 0),
            "mission_id": data.get("mission_id"),
            "during_fuzz_log": data.get("during_fuzz_log"),
        }
    except Exception as e:
        return {
            "exists": True,
            "error": str(e),
            "frames_sent": [],
        }


@app.post("/api/fuzzing/analyze-crash")
async def analyze_crash(mission_id: str, pre_fuzz_log_id: str, during_fuzz_log_id: str):
    """
    Advanced crash analysis: compare pre-fuzz and during-fuzz logs
    to detect anomalies and identify the culprit frame.
    
    Detects:
    - IDs that disappeared (critical systems stopped responding)
    - Sudden value drops (RPM → 0, speed → 0)
    - New error IDs that appeared
    - Timing anomalies
    """
    logs_dir = get_mission_logs_dir(mission_id)
    pre_log = logs_dir / f"{{pre_fuzz_log_id}}.log"
    during_log = logs_dir / f"{{during_fuzz_log_id}}.log"
    
    if not pre_log.exists() or not during_log.exists():
        raise HTTPException(status_code=404, detail="Log files not found")
    
    # Parse pre-fuzz baseline
    pre_data = {{}}  # {{id: [payloads...]}}
    try:
        with open(pre_log, "r") as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) >= 3:
                    frame_parts = parts[2].split("#")
                    if len(frame_parts) == 2:
                        cid = frame_parts[0].upper()
                        payload = frame_parts[1].upper()
                        if cid not in pre_data:
                            pre_data[cid] = []
                        pre_data[cid].append(payload)
    except:
        pass
    
    # Parse during-fuzz traffic
    during_data = {{}}
    during_timeline = []  # [(timestamp, id, payload)]
    try:
        with open(during_log, "r") as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) >= 3:
                    timestamp = float(parts[0].strip("()"))
                    frame_parts = parts[2].split("#")
                    if len(frame_parts) == 2:
                        cid = frame_parts[0].upper()
                        payload = frame_parts[1].upper()
                        if cid not in during_data:
                            during_data[cid] = []
                        during_data[cid].append(payload)
                        during_timeline.append((timestamp, cid, payload))
    except:
        pass
    
    # Detect anomalies
    anomalies = []
    
    # 1. IDs that disappeared
    disappeared_ids = set(pre_data.keys()) - set(during_data.keys())
    for cid in disappeared_ids:
        anomalies.append({{
            "type": "disappeared",
            "id": cid,
            "severity": "critical",
            "description": f"ID {{cid}} stopped responding during fuzzing"
        }})
    
    # 2. IDs with all-zero payloads (likely crash)
    for cid, payloads in during_data.items():
        if cid in pre_data:
            pre_non_zero = any(p != "0" * len(p) for p in pre_data[cid][:50])
            during_all_zero = all(p == "0" * len(p) for p in payloads[-20:])
            if pre_non_zero and during_all_zero:
                anomalies.append({{
                    "type": "zeroed",
                    "id": cid,
                    "severity": "critical",
                    "description": f"ID {{cid}} data went to all zeros"
                }})
    
    # 3. New error IDs (5xx, 7xx ranges)
    new_error_ids = []
    for cid in during_data.keys():
        if cid not in pre_data:
            cid_int = int(cid, 16)
            if (0x500 <= cid_int <= 0x5FF) or (0x700 <= cid_int <= 0x7FF):
                new_error_ids.append(cid)
                anomalies.append({{
                    "type": "new_error",
                    "id": cid,
                    "severity": "high",
                    "description": f"New error ID {{cid}} appeared during fuzzing"
                }})
    
    # Load fuzzing history to correlate
    history_file = Path("/tmp/aurige_fuzz_history.json")
    fuzz_frames = []
    if history_file.exists():
        with open(history_file, "r") as f:
            data = json.load(f)
            fuzz_frames = data.get("frames_sent", [])
    
    # Find the culprit: correlate anomaly timing with sent frames
    culprits = []
    if anomalies and fuzz_frames:
        for anomaly in anomalies[:5]:  # Top 5 anomalies
            # Find when the anomaly ID went bad in timeline
            anom_id = anomaly["id"]
            bad_timestamp = None
            for ts, cid, payload in during_timeline:
                if cid == anom_id:
                    if anomaly["type"] == "zeroed" and payload == "0" * len(payload):
                        bad_timestamp = ts
                        break
            
            if bad_timestamp:
                # Find frames sent just before
                suspects = []
                for frame in fuzz_frames:
                    if abs(frame["timestamp"] - bad_timestamp) < 1.0:
                        suspects.append(frame)
                
                if suspects:
                    culprits.append({{
                        "anomaly": anomaly,
                        "suspect_frames": suspects[:10],
                        "timing_delta": bad_timestamp - suspects[0]["timestamp"] if suspects else 0
                    }})
    
    return {{
        "mission_id": mission_id,
        "anomalies": anomalies,
        "disappeared_ids": list(disappeared_ids),
        "new_error_ids": new_error_ids,
        "culprits": culprits,
        "pre_fuzz_ids": sorted(list(pre_data.keys())),
        "during_fuzz_ids": sorted(list(during_data.keys())),
        "message": f"Found {{len(anomalies)}} anomalies, {{len(culprits)}} culprits identified"
    }}


@app.post("/api/fuzzing/compare-logs")
async def compare_logs_with_fuzzing(mission_id: str, log_id: str):
    """
    Compare a pre-fuzz log with fuzzing history to identify suspect IDs.
    Returns IDs that appeared during fuzzing but not in normal operation.
    """
    # Read pre-fuzz log
    logs_dir = get_mission_logs_dir(mission_id)
    log_file = logs_dir / f"{log_id}.log"
    
    if not log_file.exists():
        raise HTTPException(status_code=404, detail="Log file not found")
    
    # Extract IDs from pre-fuzz log
    pre_fuzz_ids = set()
    try:
        with open(log_file, "r") as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) >= 3:
                    frame_parts = parts[2].split("#")
                    if len(frame_parts) == 2:
                        pre_fuzz_ids.add(frame_parts[0].upper())
    except:
        pass
    
    # Read fuzzing history
    history_file = Path("/tmp/aurige_fuzz_history.json")
    fuzzing_ids = set()
    if history_file.exists():
        try:
            with open(history_file, "r") as f:
                data = json.load(f)
            for frame_info in data.get("frames", []):
                fuzzing_ids.add(frame_info["id"].upper())
        except:
            pass
    
    # Find suspects: in fuzzing but not in pre-fuzz
    suspects = list(fuzzing_ids - pre_fuzz_ids)
    suspects.sort()
    
    return {
        "pre_fuzz_ids": sorted(list(pre_fuzz_ids)),
        "fuzzing_ids": sorted(list(fuzzing_ids)),
        "suspect_ids": suspects,
        "message": f"Found {len(suspects)} suspect IDs not present in normal operation",
    }


@app.get("/api/missions/{mission_id}/logs-analysis")
async def analyze_mission_logs(mission_id: str, log_id: Optional[str] = None):
    """
    Analyze mission logs to extract CAN ID + data patterns for intelligent fuzzing.
    Returns unique IDs with their observed data values, byte ranges, and frequencies.
    Optionally filter by a specific log_id.
    """
    load_mission(mission_id)
    logs_dir = get_mission_logs_dir(mission_id)
    
    if not logs_dir.exists():
        return {"mission_id": mission_id, "ids": [], "totalFrames": 0}
    
    # Collect data per CAN ID
    id_data: dict = {}  # canId -> { "samples": [data_hex_list], "count": int }
    total_frames = 0
    
    log_files = []
    if log_id:
        target = logs_dir / f"{log_id}.log"
        if target.exists():
            log_files = [target]
        else:
            raise HTTPException(status_code=404, detail=f"Log not found: {log_id}")
    else:
        log_files = list(logs_dir.glob("*.log"))
    
    for log_file in log_files:
        if log_file.name.endswith(".meta.json"):
            continue
        try:
            with open(log_file, "r") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    total_frames += 1
                    
                    # Parse candump format: (timestamp) interface canid#data
                    try:
                        parts = line.split()
                        if len(parts) >= 3:
                            frame_parts = parts[2].split("#")
                            if len(frame_parts) == 2:
                                can_id = frame_parts[0].upper()
                                data_hex = frame_parts[1].upper()
                                
                                if can_id not in id_data:
                                    id_data[can_id] = {
                                        "count": 0,
                                        "samples": [],
                                        "dlc_set": set(),
                                    }
                                
                                entry = id_data[can_id]
                                entry["count"] += 1
                                entry["dlc_set"].add(len(data_hex) // 2)
                                
                                # Keep up to 50 unique data samples per ID
                                if data_hex not in entry["samples"] and len(entry["samples"]) < 50:
                                    entry["samples"].append(data_hex)
                    except Exception:
                        continue
        except Exception:
            continue
    
    # Build byte-range analysis per ID
    result_ids = []
    for can_id, entry in sorted(id_data.items(), key=lambda x: x[1]["count"], reverse=True):
        # Analyze byte ranges from samples
        byte_ranges = []
        if entry["samples"]:
            max_bytes = max(len(s) // 2 for s in entry["samples"])
            for byte_idx in range(max_bytes):
                byte_values = set()
                for sample in entry["samples"]:
                    if byte_idx * 2 + 2 <= len(sample):
                        byte_values.add(int(sample[byte_idx * 2:byte_idx * 2 + 2], 16))
                if byte_values:
                    byte_ranges.append({
                        "index": byte_idx,
                        "min": min(byte_values),
                        "max": max(byte_values),
                        "unique": len(byte_values),
                    })
        
        result_ids.append({
            "canId": can_id,
            "count": entry["count"],
            "sampleCount": len(entry["samples"]),
            "samples": entry["samples"][:10],  # Return top 10 for UI preview
            "dlcs": sorted(entry["dlc_set"]),
            "byteRanges": byte_ranges,
        })
    
    return {
        "mission_id": mission_id,
        "ids": result_ids,
        "totalFrames": total_frames,
        "totalUniqueIds": len(result_ids),
    }


# =============================================================================
# Mission CRUD Endpoints
# =============================================================================

@app.get("/api/missions")
async def list_missions():
    """List all missions"""
    missions = list_all_missions()
    return {"missions": missions}


@app.post("/api/missions", response_model=Mission)
async def create_mission(mission_data: MissionCreate):
    """Create a new mission with filesystem storage"""
    mission_id = str(uuid4())
    now = datetime.now().isoformat()
    
    mission = {
        "id": mission_id,
        "name": mission_data.name,
        "notes": mission_data.notes,
        "vehicle": mission_data.vehicle.model_dump(),
        "canConfig": mission_data.can_config.model_dump(),
        "createdAt": now,
        "updatedAt": now,
        "logsCount": 0,
        "framesCount": 0,
    }
    
    save_mission(mission_id, mission)
    get_mission_logs_dir(mission_id)  # Create logs directory
    
    return Mission(**mission)


@app.get("/api/missions/{mission_id}", response_model=Mission)
async def get_mission(mission_id: str):
    """Get a single mission"""
    mission = load_mission(mission_id)
    update_mission_stats(mission_id)
    mission = load_mission(mission_id)  # Reload after stats update
    return Mission(**mission)


@app.patch("/api/missions/{mission_id}", response_model=Mission)
async def update_mission(mission_id: str, updates: MissionUpdate):
    """Update a mission"""
    mission = load_mission(mission_id)
    
    if updates.name is not None:
        mission["name"] = updates.name
    if updates.notes is not None:
        mission["notes"] = updates.notes
    if updates.vehicle is not None:
        mission["vehicle"] = updates.vehicle.model_dump()
    if updates.can_config is not None:
        mission["canConfig"] = updates.can_config.model_dump()
    
    mission["updatedAt"] = datetime.now().isoformat()
    save_mission(mission_id, mission)
    
    return Mission(**mission)


@app.delete("/api/missions/{mission_id}")
async def delete_mission(mission_id: str):
    """Delete a mission and all its data"""
    mission_dir = get_mission_dir(mission_id)
    if not mission_dir.exists():
        raise HTTPException(status_code=404, detail="Mission not found")
    
    shutil.rmtree(mission_dir)
    
    return {"status": "deleted", "id": mission_id}


@app.post("/api/missions/{mission_id}/duplicate", response_model=Mission)
async def duplicate_mission(mission_id: str):
    """Duplicate a mission (without logs)"""
    original = load_mission(mission_id)
    
    new_id = str(uuid4())
    now = datetime.now().isoformat()
    
    new_mission = {
        **original,
        "id": new_id,
        "name": f"{original['name']} (copie)",
        "createdAt": now,
        "updatedAt": now,
        "logsCount": 0,
        "framesCount": 0,
        "lastCaptureDate": None,  # Reset for duplicated mission
    }
    
    save_mission(new_id, new_mission)
    get_mission_logs_dir(new_id)
    
    return Mission(**new_mission)


# =============================================================================
# Log Endpoints
# =============================================================================

@app.get("/api/missions/{mission_id}/logs", response_model=list[LogEntry])
async def list_mission_logs(mission_id: str):
    """List all logs for a mission, with parent/child relationships detected"""
    load_mission(mission_id)  # Verify exists
    
    logs_dir = get_mission_logs_dir(mission_id)
    logs = []
    log_names = set()
    
    # First pass: collect all log names
    for log_file in logs_dir.glob("*.log"):
        log_names.add(log_file.stem)
    
    for log_file in logs_dir.glob("*.log"):
        stat = log_file.stat()
        frames_count = count_log_frames(log_file)
        
        # Load metadata if exists
        meta = {}
        meta_file = log_file.with_suffix(".meta.json")
        if meta_file.exists():
            try:
                with open(meta_file, "r") as f:
                    meta = json.load(f)
            except Exception:
                pass
        
        log_stem = log_file.stem
        parent_id = None
        is_origin = False
        
        # First check metadata for parent info (most reliable)
        # Check parentId, parentLog, and splitFrom in order of priority
        meta_parent_ref = meta.get("parentId") or meta.get("parentLog") or meta.get("splitFrom")
        if meta_parent_ref:
            # parentId/parentLog from metadata (set by split or updated by rename)
            pid = meta_parent_ref
            if pid in log_names:
                parent_id = pid
            else:
                # parentId might reference old (pre-rename) ID, search for actual file
                # by checking if any log has oldId matching pid
                for other_stem in log_names:
                    other_meta_file = logs_dir / f"{other_stem}.meta.json"
                    if other_meta_file.exists():
                        try:
                            with open(other_meta_file, "r") as omf:
                                other_meta = json.load(omf)
                            if other_meta.get("oldId") == pid:
                                parent_id = other_stem
                                break
                        except Exception:
                            pass
                if not parent_id:
                    parent_id = pid  # Keep it even if not found
        elif meta.get("parentLog"):
            parent_id = meta.get("parentLog") if meta.get("parentLog") in log_names else meta.get("parentLog")
        elif meta.get("splitFrom"):
            parent_id = meta.get("splitFrom") if meta.get("splitFrom") in log_names else meta.get("splitFrom")
        # Fallback: detect by naming convention (_A, _B suffixes)
        elif log_stem.endswith(("_A", "_B", "_a", "_b")):
            potential_parent = log_stem[:-2]
            if potential_parent in log_names:
                parent_id = potential_parent
        
        # Check if this log has children (is an origin) - check naming, metadata, and oldId
        if (f"{log_stem}_A" in log_names or f"{log_stem}_B" in log_names or
            f"{log_stem}_a" in log_names or f"{log_stem}_b" in log_names):
            is_origin = True
        
        # Also check via metadata: if any other log references this as parent
        if not is_origin:
            for other_stem in log_names:
                if other_stem == log_stem:
                    continue
                other_meta_path = logs_dir / f"{other_stem}.meta.json"
                if other_meta_path.exists():
                    try:
                        with open(other_meta_path, "r") as omf:
                            other_m = json.load(omf)
                        other_parent = other_m.get("parentId") or other_m.get("parentLog") or other_m.get("splitFrom")
                        if other_parent == log_stem:
                            is_origin = True
                            break
                        # Also check if other_parent matches our oldId
                        if meta.get("oldId") and other_parent == meta.get("oldId"):
                            is_origin = True
                            break
                    except Exception:
                        pass
        
        logs.append(LogEntry(
            id=log_stem,
            filename=log_file.name,
            size=stat.st_size,
            framesCount=frames_count,
            createdAt=datetime.fromtimestamp(stat.st_ctime),
            durationSeconds=meta.get("durationSeconds"),
            description=meta.get("description"),
            parentId=parent_id,
            isOrigin=is_origin,
            tags=meta.get("tags", []),
        ))

    return sorted(logs, key=lambda x: x.created_at, reverse=True)


@app.get("/missions/{mission_id}/logs/{log_id}/download")
@app.get("/api/missions/{mission_id}/logs/{log_id}/download")  # alias
async def download_log(mission_id: str, log_id: str):
    load_mission(mission_id)

    logs_dir = get_mission_logs_dir(mission_id)
    log_file = logs_dir / f"{log_id}.log"

    if not log_file.exists():
        raise HTTPException(status_code=404, detail="Log not found")

    return FileResponse(
        path=str(log_file),
        filename=f"{log_id}.log",
        media_type="text/plain",
    )


@app.get("/api/missions/{mission_id}/logs/{log_id}/download-family")
async def download_log_family(mission_id: str, log_id: str):
    """Download a log and all its children (splits) as a ZIP file"""
    import zipfile
    import tempfile
    
    load_mission(mission_id)
    logs_dir = get_mission_logs_dir(mission_id)
    
    # Find all files that belong to this family
    family_files = []
    
    # Add the main log
    main_log = logs_dir / f"{log_id}.log"
    if main_log.exists():
        family_files.append(main_log)
    
    # Build a map of parentId -> children by reading metadata files
    all_metas = {}
    for meta_file in logs_dir.glob("*.meta.json"):
        try:
            with open(meta_file, "r") as f:
                meta = json.load(f)
            stem = meta_file.stem.replace(".meta", "")
            all_metas[stem] = meta
        except Exception:
            pass
    
    # Find all children recursively using parentId/parentLog/splitFrom metadata
    def find_children_by_meta(parent_id: str):
        for stem, meta in all_metas.items():
            # Check all possible parent reference fields
            meta_parent = meta.get("parentId") or meta.get("parentLog") or meta.get("splitFrom")
            if meta_parent == parent_id:
                child_file = logs_dir / f"{stem}.log"
                if child_file.exists() and child_file not in family_files:
                    family_files.append(child_file)
                    find_children_by_meta(stem)
    
    find_children_by_meta(log_id)
    
    # Also check if this log was renamed (has oldId) and search children by old name
    parent_meta = all_metas.get(log_id, {})
    old_id = parent_meta.get("oldId")
    if old_id and old_id != log_id:
        find_children_by_meta(old_id)
    
    # Fallback: also try the old naming convention approach with both current and old IDs
    def find_children_by_name(parent_stem: str):
        for suffix in ["_A", "_B", "_a", "_b"]:
            child_stem = f"{parent_stem}{suffix}"
            child_file = logs_dir / f"{child_stem}.log"
            if child_file.exists() and child_file not in family_files:
                family_files.append(child_file)
                find_children_by_name(child_stem)
    
    find_children_by_name(log_id)
    if old_id and old_id != log_id:
        find_children_by_name(old_id)
    
    if not family_files:
        raise HTTPException(status_code=404, detail="Log not found")
    
    # Create ZIP file
    with tempfile.NamedTemporaryFile(delete=False, suffix=".zip") as tmp:
        with zipfile.ZipFile(tmp.name, 'w', zipfile.ZIP_DEFLATED) as zf:
            for log_file in family_files:
                zf.write(log_file, log_file.name)
        
        return FileResponse(
            path=tmp.name,
            filename=f"{log_id}_famille.zip",
            media_type="application/zip",
            background=None,
        )


@app.get("/api/missions/{mission_id}/logs/{log_id}/content")
async def get_log_content(mission_id: str, log_id: str, limit: int = 500, offset: int = 0):
    """Get parsed content of a log file (CAN frames)"""
    load_mission(mission_id)
    
    logs_dir = get_mission_logs_dir(mission_id)
    log_file = logs_dir / f"{log_id}.log"
    
    if not log_file.exists():
        raise HTTPException(status_code=404, detail="Log not found")
    
    frames = []
    total_count = 0
    
    with open(log_file, "r") as f:
        for i, line in enumerate(f):
            total_count += 1
            if i < offset:
                continue
            if len(frames) >= limit:
                continue  # Keep counting total
            
            line = line.strip()
            if not line:
                continue
            
            # Parse candump format: (timestamp) interface canid#data
            # Example: (1234567890.123456) can0 7DF#02010C
            try:
                parts = line.split()
                if len(parts) >= 3:
                    timestamp = parts[0].strip("()")
                    interface = parts[1]
                    frame_parts = parts[2].split("#")
                    if len(frame_parts) == 2:
                        frames.append({
                            "timestamp": timestamp,
                            "interface": interface,
                            "canId": frame_parts[0],
                            "data": frame_parts[1],
                            "raw": line,
                        })
            except Exception:
                # If parsing fails, just include raw line
                frames.append({"raw": line})
    
    return {
        "frames": frames,
        "totalCount": total_count,
        "offset": offset,
        "limit": limit,
    }


@app.delete("/api/missions/{mission_id}/logs/{log_id}")
async def delete_log(mission_id: str, log_id: str):
    load_mission(mission_id)

    logs_dir = get_mission_logs_dir(mission_id)
    log_file = logs_dir / f"{log_id}.log"
    meta_file = logs_dir / f"{log_id}.meta.json"

    if not log_file.exists():
        raise HTTPException(status_code=404, detail="Log not found")

    log_file.unlink()
    if meta_file.exists():
        meta_file.unlink()
    
    update_mission_stats(mission_id)
    
    return {"status": "deleted", "id": log_id}


class CreateFrameLogRequest(BaseModel):
    can_id: str
    data: str
    timestamp: Optional[str] = None
    name: Optional[str] = None
    interface: str = "can0"

@app.post("/api/missions/{mission_id}/logs/create-frame")
async def create_frame_log(mission_id: str, request: CreateFrameLogRequest):
    """Create a .log file containing a single CAN frame. Used for success frame extraction."""
    load_mission(mission_id)
    logs_dir = get_mission_logs_dir(mission_id)
    
    ts = request.timestamp or f"{time.time():.6f}"
    iface = request.interface
    name = request.name or f"success_{request.can_id}_{datetime.now().strftime('%H%M%S')}"
    if not name.endswith(".log"):
        name = name
    
    log_id = name
    log_file = logs_dir / f"{log_id}.log"
    
    # Avoid overwriting
    counter = 1
    while log_file.exists():
        log_id = f"{name}_{counter}"
        log_file = logs_dir / f"{log_id}.log"
        counter += 1
    
    # Write the .log file in standard candump format
    line = f"({ts}) {iface} {request.can_id}#{request.data}\n"
    with open(log_file, "w") as f:
        f.write(line)
    
    # Write meta with success tag
    meta_file = logs_dir / f"{log_id}.meta.json"
    meta = {
        "tags": ["success"],
        "description": f"Trame isolee {request.can_id}#{request.data}",
    }
    with open(meta_file, "w") as f:
        json.dump(meta, f, indent=2)
    
    update_mission_stats(mission_id)
    
    return {"status": "ok", "logId": log_id, "filename": f"{log_id}.log"}


class UpdateLogTagsRequest(BaseModel):
    tags: list[str]

@app.put("/api/missions/{mission_id}/logs/{log_id}/tags")
async def update_log_tags(mission_id: str, log_id: str, request: UpdateLogTagsRequest):
    """Update tags for a log (success, failed, original, etc.)"""
    load_mission(mission_id)
    logs_dir = get_mission_logs_dir(mission_id)
    meta_file = logs_dir / f"{log_id}.meta.json"
    log_file = logs_dir / f"{log_id}.log"
    
    if not log_file.exists():
        raise HTTPException(status_code=404, detail="Log not found")
    
    # Load or create meta
    meta = {}
    if meta_file.exists():
        try:
            with open(meta_file, "r") as f:
                meta = json.load(f)
        except Exception:
            meta = {}
    
    meta["tags"] = request.tags
    
    with open(meta_file, "w") as f:
        json.dump(meta, f, indent=2)
    
    return {"status": "ok", "tags": request.tags}


class RenameLogRequest(BaseModel):
    new_name: str = Field(alias="newName")
    
    class Config:
        populate_by_name = True


@app.post("/api/missions/{mission_id}/logs/{log_id}/rename")
async def rename_log(mission_id: str, log_id: str, request: RenameLogRequest):
    """Rename a log file"""
    load_mission(mission_id)
    
    logs_dir = get_mission_logs_dir(mission_id)
    old_log_file = logs_dir / f"{log_id}.log"
    old_meta_file = logs_dir / f"{log_id}.meta.json"
    
    if not old_log_file.exists():
        raise HTTPException(status_code=404, detail="Log not found")
    
    # Clean new name and create new ID
    new_name = request.new_name.strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="New name cannot be empty")
    
    # Keep the same ID but update meta with display name
    # Or rename the file if you want to change the filename
    new_id = new_name.replace(" ", "_").replace(".log", "")
    new_log_file = logs_dir / f"{new_id}.log"
    new_meta_file = logs_dir / f"{new_id}.meta.json"
    
    # Check if new name already exists
    if new_log_file.exists() and new_log_file != old_log_file:
        raise HTTPException(status_code=409, detail="A log with this name already exists")
    
    # Rename log file
    old_log_file.rename(new_log_file)
    
    # Rename or update meta file
    if old_meta_file.exists():
        # Update parentId references in the meta
        try:
            with open(old_meta_file, "r") as f:
                meta = json.load(f)
            meta["oldId"] = log_id
            with open(old_meta_file, "w") as f:
                json.dump(meta, f, indent=2)
        except Exception:
            pass
        old_meta_file.rename(new_meta_file)
    
    # Update children metadata: any log referencing log_id as parent should now reference new_id
    for meta_file in logs_dir.glob("*.meta.json"):
        try:
            with open(meta_file, "r") as f:
                meta = json.load(f)
            changed = False
            for key in ["parentId", "parentLog", "splitFrom"]:
                if meta.get(key) == log_id:
                    meta[key] = new_id
                    changed = True
            if changed:
                with open(meta_file, "w") as f:
                    json.dump(meta, f, indent=2)
        except Exception:
            pass
    
    return {"status": "renamed", "oldId": log_id, "newId": new_id, "newName": f"{new_id}.log"}


class SplitLogRequest(BaseModel):
    """Request to split a log file in half"""
    pass  # No extra params needed, we split in half


class SplitLogResponse(BaseModel):
    """Response with the two new log IDs"""
    log_a_id: str = Field(alias="logAId")
    log_a_name: str = Field(alias="logAName")
    log_a_frames: int = Field(alias="logAFrames")
    log_b_id: str = Field(alias="logBId")
    log_b_name: str = Field(alias="logBName")
    log_b_frames: int = Field(alias="logBFrames")
    
    class Config:
        populate_by_name = True


@app.post("/api/missions/{mission_id}/logs/{log_id}/split", response_model=SplitLogResponse)
async def split_log(mission_id: str, log_id: str):
    """
    Split a log file in half for binary isolation.
    
    Creates two new log files:
    - {log_id}_A.log - First half of frames
    - {log_id}_B.log - Second half of frames
    
    The original log is preserved.
    """
    load_mission(mission_id)
    
    logs_dir = get_mission_logs_dir(mission_id)
    source_file = logs_dir / f"{log_id}.log"
    
    if not source_file.exists():
        raise HTTPException(status_code=404, detail="Log not found")
    
    # Read all lines from source
    with open(source_file, "r") as f:
        lines = f.readlines()
    
    if len(lines) < 2:
        raise HTTPException(status_code=400, detail="Log has too few frames to split")
    
    # Split in half
    mid = len(lines) // 2
    lines_a = lines[:mid]
    lines_b = lines[mid:]
    
    # Generate IDs for new logs
    log_a_id = f"{log_id}_A"
    log_b_id = f"{log_id}_B"
    
    # Write first half
    file_a = logs_dir / f"{log_a_id}.log"
    with open(file_a, "w") as f:
        f.writelines(lines_a)
    
    # Write second half
    file_b = logs_dir / f"{log_b_id}.log"
    with open(file_b, "w") as f:
        f.writelines(lines_b)
    
    # Save metadata - include parentId for ZIP/rename compatibility
    now = datetime.now().isoformat()
    for log_new_id, parent in [(log_a_id, log_id), (log_b_id, log_id)]:
        meta = {
            "createdAt": now,
            "parentId": parent,
            "parentLog": parent,
            "splitFrom": log_id,
        }
        with open(logs_dir / f"{log_new_id}.meta.json", "w") as f:
            json.dump(meta, f, indent=2)
    
    update_mission_stats(mission_id)
    
    return SplitLogResponse(
        logAId=log_a_id,
        logAName=f"{log_a_id}.log",
        logAFrames=len(lines_a),
        logBId=log_b_id,
        logBName=f"{log_b_id}.log",
        logBFrames=len(lines_b),
    )


# =============================================================================
# Co-occurrence Analysis
# =============================================================================

@app.post("/api/missions/{mission_id}/logs/{log_id}/co-occurrence", response_model=CoOccurrenceResponse)
async def analyze_co_occurrence(mission_id: str, log_id: str, request: CoOccurrenceRequest):
    """
    Analyze frames that co-occur with a causal frame within a time window.
    
    This helps identify:
    - ACK frames (appear just after the causal frame)
    - Status frames (appear during the action)
    - Related ECU traffic (similar ID ranges)
    """
    load_mission(mission_id)
    logs_dir = get_mission_logs_dir(mission_id)
    log_file = logs_dir / f"{log_id}.log"
    
    if not log_file.exists():
        raise HTTPException(status_code=404, detail="Log not found")
    
    # Parse the log file
    frames = []
    with open(log_file, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            # Format: (timestamp) interface canId#data
            try:
                parts = line.split()
                if len(parts) >= 3:
                    ts_str = parts[0].strip("()")
                    timestamp = float(ts_str)
                    can_part = parts[2]  # canId#data
                    if "#" in can_part:
                        can_id, data = can_part.split("#", 1)
                        frames.append({
                            "timestamp": timestamp,
                            "canId": can_id.upper(),
                            "data": data.upper()
                        })
            except (ValueError, IndexError):
                continue
    
    if not frames:
        raise HTTPException(status_code=400, detail="No frames in log")
    
    # Find frames within the time window
    target_ts = request.target_timestamp
    window_sec = request.window_ms / 1000.0
    target_can_id = request.target_can_id.upper()
    
    # Determine window bounds based on direction
    if request.direction == "before":
        ts_start = target_ts - window_sec
        ts_end = target_ts
    elif request.direction == "after":
        ts_start = target_ts
        ts_end = target_ts + window_sec
    else:  # both
        ts_start = target_ts - window_sec
        ts_end = target_ts + window_sec
    
    # Collect frames in window, grouped by CAN ID
    id_data: dict[str, list[dict]] = {}
    for frame in frames:
        if ts_start <= frame["timestamp"] <= ts_end:
            can_id = frame["canId"]
            if can_id not in id_data:
                id_data[can_id] = []
            id_data[can_id].append({
                "timestamp": frame["timestamp"],
                "data": frame["data"],
                "delay_ms": (frame["timestamp"] - target_ts) * 1000
            })
    
    # Analyze each ID
    related_frames: list[CoOccurrenceFrame] = []
    for can_id, occurrences in id_data.items():
        if can_id == target_can_id:
            continue  # Skip the target frame itself
        
        count_before = sum(1 for o in occurrences if o["delay_ms"] < 0)
        count_after = sum(1 for o in occurrences if o["delay_ms"] > 0)
        avg_delay = sum(o["delay_ms"] for o in occurrences) / len(occurrences)
        unique_data = set(o["data"] for o in occurrences)
        
        # Determine frame type based on heuristics
        frame_type = "unknown"
        score = 0.0
        
        # ACK: appears just after (0-50ms) with few variations
        if count_after > 0 and count_before == 0 and 0 < avg_delay < 50:
            frame_type = "ack"
            score = 0.9 - (len(unique_data) * 0.1)
        # Command: appears just before with few variations
        elif count_before > 0 and count_after == 0 and -50 < avg_delay < 0:
            frame_type = "command"
            score = 0.8 - (len(unique_data) * 0.1)
        # Status: appears both before and after, often with variations
        elif count_before > 0 and count_after > 0:
            frame_type = "status"
            score = 0.5 + (len(unique_data) * 0.05)
        # Unknown but present
        else:
            score = 0.3
        
        # Boost score for IDs close to target
        try:
            target_int = int(target_can_id, 16)
            can_int = int(can_id, 16)
            if abs(target_int - can_int) <= 0x10:
                score += 0.2
            elif abs(target_int - can_int) <= 0x20:
                score += 0.1
        except ValueError:
            pass
        
        related_frames.append(CoOccurrenceFrame(
            canId=can_id,
            count=len(occurrences),
            countBefore=count_before,
            countAfter=count_after,
            avgDelayMs=round(avg_delay, 2),
            dataVariations=len(unique_data),
            sampleData=list(unique_data)[:5],
            frameType=frame_type,
            score=round(min(score, 1.0), 2)
        ))
    
    # Sort by score descending
    related_frames.sort(key=lambda x: x.score, reverse=True)
    
    # Group IDs into ECU families (IDs within 0x10 of each other)
    ecu_families: list[EcuFamily] = []
    used_ids = set()
    
    for frame in related_frames:
        if frame.can_id in used_ids:
            continue
        
        try:
            base_int = int(frame.can_id, 16)
        except ValueError:
            continue
        
        # Find all IDs within range
        family_ids = [frame.can_id]
        family_count = frame.count
        
        for other in related_frames:
            if other.can_id in used_ids or other.can_id == frame.can_id:
                continue
            try:
                other_int = int(other.can_id, 16)
                if abs(base_int - other_int) <= 0x10:
                    family_ids.append(other.can_id)
                    family_count += other.count
                    used_ids.add(other.can_id)
            except ValueError:
                continue
        
        used_ids.add(frame.can_id)
        
        if len(family_ids) >= 2:
            # Sort IDs and get range
            sorted_ids = sorted(family_ids, key=lambda x: int(x, 16))
            ecu_families.append(EcuFamily(
                name=f"ECU 0x{sorted_ids[0]}-0x{sorted_ids[-1]}",
                idRangeStart=sorted_ids[0],
                idRangeEnd=sorted_ids[-1],
                frameIds=sorted_ids,
                totalFrames=family_count
            ))
    
    return CoOccurrenceResponse(
        targetFrame={
            "canId": target_can_id,
            "timestamp": target_ts
        },
        windowMs=request.window_ms,
        totalFramesAnalyzed=sum(len(v) for v in id_data.values()),
        uniqueIdsFound=len(id_data),
        relatedFrames=related_frames[:20],  # Top 20
        ecuFamilies=ecu_families
    )


# =============================================================================
# WebSocket - Live CAN Sniffer
# =============================================================================

@app.websocket("/ws/candump")
async def websocket_candump(websocket: WebSocket, interface: str = Query(default="can0")):
    """
    WebSocket endpoint for live CAN traffic streaming.
    
    Starts candump and streams output to connected clients.
    Multiple clients can connect and receive the same stream.
    
    Message format (JSON):
    {
        "timestamp": "1706000000.123456",
        "interface": "can0",
        "canId": "7DF",
        "data": "02 01 0C"
    }
    """
    await websocket.accept()
    state.websocket_clients.append(websocket)
    
    try:
        # Start candump if not already running for this interface
        if state.candump_process is None or state.candump_interface != interface:
            # Stop existing if different interface
            if state.candump_process and state.candump_process.returncode is None:
                state.candump_process.terminate()
                await state.candump_process.wait()
            
            # Start new candump
            # -ta: absolute timestamps
            state.candump_process = await asyncio.create_subprocess_exec(
                "candump", "-ta", interface,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            state.candump_interface = interface
        
        # Read and broadcast
        while True:
            if state.candump_process.stdout:
                line = await state.candump_process.stdout.readline()
                if not line:
                    break
                
                # Parse candump output
                # Format: (1706000000.123456) can0 7DF#02010C
                try:
                    decoded = line.decode().strip()
                    if decoded:
                        parts = decoded.split()
                        if len(parts) >= 3:
                            timestamp = parts[0].strip("()")
                            iface = parts[1]
                            frame_parts = parts[2].split("#")
                            if len(frame_parts) == 2:
                                can_id = frame_parts[0]
                                data = frame_parts[1]
                                # Format data with spaces
                                data_formatted = " ".join(
                                    data[i:i+2] for i in range(0, len(data), 2)
                                )
                                
                                message = json.dumps({
                                    "timestamp": timestamp,
                                    "interface": iface,
                                    "canId": can_id,
                                    "data": data_formatted,
                                })
                                await broadcast_to_websockets(message)
                except Exception:
                    pass
            else:
                await asyncio.sleep(0.1)
                
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in state.websocket_clients:
            state.websocket_clients.remove(websocket)
        
        # Stop candump if no more clients
        if not state.websocket_clients and state.candump_process:
            state.candump_process.terminate()
            state.candump_process = None
            state.candump_interface = None


@app.post("/api/sniffer/start")
async def start_sniffer(interface: str = "can0"):
    """Start the CAN sniffer (for clients that will connect via WebSocket)"""
    if state.candump_process and state.candump_process.returncode is None:
        if state.candump_interface == interface:
            return {"status": "already_running", "interface": interface}
        # Stop existing
        state.candump_process.terminate()
        await state.candump_process.wait()
    
    state.candump_process = await asyncio.create_subprocess_exec(
        "candump", "-ta", interface,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    state.candump_interface = interface
    
    return {"status": "started", "interface": interface}


@app.post("/api/sniffer/stop")
async def stop_sniffer():
    """Stop the CAN sniffer"""
    if not state.candump_process or state.candump_process.returncode is not None:
        return {"status": "not_running"}
    
    state.candump_process.terminate()
    try:
        await asyncio.wait_for(state.candump_process.wait(), timeout=5.0)
    except asyncio.TimeoutError:
        state.candump_process.kill()
    
    state.candump_process = None
    state.candump_interface = None
    
    return {"status": "stopped"}


# =============================================================================
# OBD-II Diagnostic Endpoints
# =============================================================================

class OBDRequest(BaseModel):
    interface: str = "can0"
    timeout_ms: int = Field(alias="timeoutMs", default=1000)

    class Config:
        populate_by_name = True


async def obd_send_with_flow_control(interface: str, request_id: str, request_data: str, response_id: str = "7E8") -> dict:
    """
    Send an OBD-II request and handle ISO-TP flow control for multi-frame responses.
    
    For multi-frame responses:
    1. First frame starts with 0x10 (indicates more frames coming)
    2. We send flow control: targetID#3000000000000000
    3. Consecutive frames start with 0x21, 0x22, etc.
    
    Returns:
        dict with 'success', 'responses', and 'error' keys
    """
    # Calculate flow control target (response_id - 8)
    flow_target = f"{int(response_id, 16) - 8:03X}"
    
    # Start candump to capture response
    log_file = Path(f"/tmp/obd_response_{int(time.time())}.log")
    log_handle = None
    candump = None
    
    try:
        log_handle = open(log_file, "w")
        candump = await asyncio.create_subprocess_exec(
            "candump", "-L", "-ta", interface,
            stdout=log_handle,
            stderr=asyncio.subprocess.DEVNULL,
        )
    except Exception as e:
        if log_handle:
            log_handle.close()
        return {"success": False, "responses": [], "error": f"Failed to start candump: {e}"}
    
    send_error = None
    try:
        await asyncio.sleep(0.1)  # Let candump start
        
        # Send the OBD request
        success, error = can_send_frame(interface, request_id, request_data)
        if not success:
            send_error = f"Failed to send frame on {interface}: {error}"
        else:
            await asyncio.sleep(0.1)
            
            # Send flow control for multi-frame responses
            _, _ = can_send_frame(interface, flow_target, "3000000000000000")
            
            # Wait for response
            await asyncio.sleep(0.5)
        
    finally:
        if candump:
            candump.terminate()
            try:
                await asyncio.wait_for(candump.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                candump.kill()
        if log_handle:
            log_handle.close()
    
    if send_error:
        if log_file.exists():
            log_file.unlink()
        return {"success": False, "responses": [], "error": send_error}
    
    # Read captured response
    responses = []
    if log_file.exists():
        with open(log_file, "r") as f:
            for line in f:
                line = line.strip()
                if line:
                    responses.append(line)
        log_file.unlink()
    
    return {"success": True, "responses": responses, "error": None}


def parse_candump_line(line: str):
    """Parse a candump -L line: (timestamp) interface ID#DATA"""
    line = line.strip()
    if not line:
        return None
    # Format: (1770403100.903541) vcan0 7E8#1014490249574631
    parts = line.split()
    if len(parts) < 3:
        return None
    id_data = parts[2] if '#' in parts[2] else (parts[3] if len(parts) > 3 and '#' in parts[3] else None)
    if not id_data:
        return None
    can_id, data_hex = id_data.split('#', 1)
    return {"id": can_id.upper(), "data": data_hex.upper()}


def decode_vin_from_frames(responses: list) -> str:
    """
    Decode VIN from ISO-TP multi-frame CAN responses.
    
    VIN response on 7E8:
    - First frame:  7E8#1014490249 + first VIN bytes
    - Consecutive:  7E8#21xxxxxxxx  7E8#22xxxxxxxx etc.
    
    The VIN is 17 ASCII characters.
    """
    # Filter only 7E8 responses (ECU response)
    frames = []
    for line in responses:
        parsed = parse_candump_line(line) if isinstance(line, str) else line
        if parsed and parsed["id"] in ("7E8", "7E9", "7EA", "7EB"):
            frames.append(parsed["data"])
    
    if not frames:
        return ""
    
    vin_bytes = []
    
    for data in frames:
        # Convert hex string to byte list
        byte_list = [data[i:i+2] for i in range(0, len(data), 2)]
        
        if not byte_list:
            continue
        
        first_byte = int(byte_list[0], 16)
        
        if first_byte == 0x10:
            # First frame of multi-frame: 10 14 49 02 01 VIN_BYTE1 VIN_BYTE2 ...
            # Skip: 10 (PCI), length byte, 49 (response SID), 02 (PID), 01 (message count)
            if len(byte_list) > 5:
                vin_bytes.extend(byte_list[5:])
        elif (first_byte & 0xF0) == 0x20:
            # Consecutive frame: 21 xx xx xx xx xx xx xx
            vin_bytes.extend(byte_list[1:])
        elif byte_list[0] == "07" or (len(byte_list) > 1 and byte_list[1] == "49"):
            # Single frame response: 07 49 02 01 VIN...
            # Skip: length, 49, 02, 01
            if len(byte_list) > 4:
                vin_bytes.extend(byte_list[4:])
    
    # Convert to ASCII
    vin = ""
    for b in vin_bytes:
        try:
            val = int(b, 16)
            if 0x20 <= val <= 0x7E:  # Printable ASCII
                vin += chr(val)
        except ValueError:
            pass
    
    return vin[:17] if len(vin) >= 17 else vin


def decode_dtcs_from_frames(responses: list) -> list:
    """
    Decode DTCs from OBD-II Service 03 response.
    
    DTC encoding: 2 bytes per DTC
    First byte upper nibble:
      00 = P0xxx, 01 = P1xxx, 10 = P2xxx, 11 = P3xxx
      C, B, U prefixes for other modules.
    
    Example: 7E8#0443010301030000
    04 = 4 bytes follow, 43 = response to service 03, 0103 = P0103, 0103 = P0103
    """
    frames = []
    for line in responses:
        parsed = parse_candump_line(line) if isinstance(line, str) else line
        if parsed and parsed["id"] in ("7E8", "7E9", "7EA", "7EB"):
            frames.append(parsed["data"])
    
    if not frames:
        return []
    
    dtc_codes = []
    dtc_type_map = {0: "P0", 1: "P1", 2: "P2", 3: "P3",
                    4: "C0", 5: "C1", 6: "C2", 7: "C3",
                    8: "B0", 9: "B1", 10: "B2", 11: "B3",
                    12: "U0", 13: "U1", 14: "U2", 15: "U3"}
    
    for data in frames:
        byte_list = [data[i:i+2] for i in range(0, len(data), 2)]
        if len(byte_list) < 2:
            continue
        
        first_byte = int(byte_list[0], 16)
        
        # Single frame: first byte is length, second should be 0x43 (response to service 03)
        if first_byte <= 7 and len(byte_list) > 1 and byte_list[1].upper() == "43":
            num_bytes = first_byte - 1  # Subtract 1 for the service byte
            dtc_data = byte_list[2:]
            # Each DTC is 2 bytes
            for i in range(0, min(num_bytes, len(dtc_data)), 2):
                if i + 1 < len(dtc_data):
                    b1 = int(dtc_data[i], 16)
                    b2 = int(dtc_data[i + 1], 16)
                    if b1 == 0 and b2 == 0:
                        continue  # No DTC
                    upper_nibble = (b1 >> 4) & 0x0F
                    prefix = dtc_type_map.get(upper_nibble >> 2, "P0")
                    # The rest: lower 2 bits of upper nibble + lower nibble + second byte
                    code_num = ((b1 & 0x3F) << 8) | b2
                    dtc_codes.append(f"{prefix}{code_num:03X}")
        
        # Multi-frame first frame
        elif first_byte == 0x10:
            if len(byte_list) > 2 and byte_list[2].upper() == "43":
                dtc_data = byte_list[3:]
                for i in range(0, len(dtc_data), 2):
                    if i + 1 < len(dtc_data):
                        b1 = int(dtc_data[i], 16)
                        b2 = int(dtc_data[i + 1], 16)
                        if b1 == 0 and b2 == 0:
                            continue
                        upper_nibble = (b1 >> 4) & 0x0F
                        prefix = dtc_type_map.get(upper_nibble >> 2, "P0")
                        code_num = ((b1 & 0x3F) << 8) | b2
                        dtc_codes.append(f"{prefix}{code_num:03X}")
    
    return dtc_codes


@app.post("/api/obd/vin")
async def read_vin(request: OBDRequest):
    """
    Read Vehicle Identification Number via OBD-II.
    
    Protocol:
    1. Send: 7DF#0209020000000000 (Service 09, PID 02 - VIN request)
    2. Send: 7E0#3000000000000000 (Flow control)
    3. Receive multi-frame response on 7E8
    """
    result = await obd_send_with_flow_control(
        request.interface,
        "7DF",
        "0209020000000000",
        "7E8"
    )
    
    if not result["success"]:
        return {
            "status": "error",
            "message": result["error"],
            "data": None,
            "frames": [],
        }
    
    responses = result["responses"]
    decoded_vin = decode_vin_from_frames(responses) if responses else ""
    
    return {
        "status": "success" if decoded_vin else ("sent" if responses else "sent"),
        "message": f"VIN: {decoded_vin}" if decoded_vin else ("VIN request sent, waiting for response" if not responses else "VIN response received but could not decode"),
        "data": decoded_vin if decoded_vin else (responses[0] if responses else None),
        "frames": responses,
        "decoded": True if decoded_vin else False,
    }


@app.post("/api/obd/dtc/read")
async def read_dtc(request: OBDRequest):
    """
    Read Diagnostic Trouble Codes.
    
    Protocol:
    1. Send: 7DF#0103000000000000 (Service 03 - Read DTCs)
    2. Send: 7E0#3000000000000000 (Flow control)
    3. Receive response on 7E8
    """
    result = await obd_send_with_flow_control(
        request.interface,
        "7DF",
        "0103000000000000",
        "7E8"
    )
    
    if not result["success"]:
        return {
            "status": "error",
            "message": result["error"],
            "frames": [],
        }
    
    responses = result["responses"]
    decoded_dtcs = decode_dtcs_from_frames(responses) if responses else []
    
    return {
        "status": "success" if responses else "sent",
        "message": f"DTC read completed: {len(decoded_dtcs)} code(s) detecte(s)" if decoded_dtcs else ("No DTC found" if responses else "DTC request sent"),
        "data": ",".join(decoded_dtcs) if decoded_dtcs else None,
        "frames": responses,
        "dtcs": decoded_dtcs,
    }


@app.post("/api/obd/dtc/clear")
async def clear_dtc(request: OBDRequest):
    """
    Clear Diagnostic Trouble Codes.
    
    Sends: 7DF#0104000000000000 (Service 04 - Clear DTCs)
    WARNING: This clears all stored DTCs and freeze frame data!
    """
    success, error = can_send_frame(request.interface, "7DF", "0104000000000000")
    await asyncio.sleep(0.1)
    
    if not success:
        return {
            "status": "error",
            "message": f"Failed to send frame on {request.interface}: {error}",
        }
    
    return {
        "status": "sent",
        "message": "DTC clear request sent.",
        "warning": "All stored DTCs and freeze frame data may be cleared",
    }


@app.post("/api/obd/reset")
async def reset_ecu(request: OBDRequest):
    """
    Request ECU reset (soft reset).
    
    Sends: 7DF#0211010000000000 (Service 11, subfunction 01 - Hard reset)
    WARNING: This may cause the vehicle to enter a temporary non-operational state!
    """
    success, error = can_send_frame(request.interface, "7DF", "0211010000000000")
    
    if not success:
        return {
            "status": "error",
            "message": f"Failed to send frame on {request.interface}: {error}",
        }
    
    return {
        "status": "sent",
        "message": "ECU reset request sent.",
        "warning": "Vehicle may enter temporary non-operational state",
    }


@app.post("/api/obd/scan-pids")
async def scan_all_pids(request: OBDRequest):
    """
    Scan all Service 01 PIDs (0x00 to 0xE0).
    
    This mimics your bash script:
    - Sends requests for PIDs 0-224
    - Captures responses
    - Identifies which PIDs are supported
    """
    supported_pids = []
    
    # Start candump to capture all responses
    log_file = Path(f"/tmp/pid_scan_{int(time.time())}.log")
    
    candump = await asyncio.create_subprocess_exec(
        "candump", "-L", "-ta", f"{request.interface},7DF:7FF,7E8:7E8",
        stdout=open(log_file, "w"),
        stderr=asyncio.subprocess.DEVNULL,
    )
    
    try:
        await asyncio.sleep(0.05)
        
        # Scan PIDs 0x00 to 0xE0 (0-224 decimal)
        for pid in range(0, 225):
            pid_hex = f"{pid:02X}"
            _, _ = can_send_frame(request.interface, "7DF", f"0201{pid_hex}0000000000")
            await asyncio.sleep(0.05)  # 50ms delay between requests
        
        # Final wait for responses
        await asyncio.sleep(0.5)
        
    finally:
        candump.terminate()
        try:
            await asyncio.wait_for(candump.wait(), timeout=2.0)
        except asyncio.TimeoutError:
            candump.kill()
    
    # Parse responses to find supported PIDs
    if log_file.exists():
        with open(log_file, "r") as f:
            for line in f:
                if "7e8" in line.lower():
                    # Extract PID from response
                    parts = line.strip().split()
                    if len(parts) >= 4:
                        supported_pids.append(line.strip())
        log_file.unlink()
    
    return {
        "status": "completed",
        "message": f"Scanned {225} PIDs, found {len(supported_pids)} responses",
        "responsesCount": len(supported_pids),
        "responses": supported_pids[:50],  # Limit to first 50 for API response
    }


@app.post("/api/obd/full-scan")
async def full_obd_scan(request: OBDRequest):
    """
    Perform a complete OBD-II scan similar to your bash script:
    1. Request VIN
    2. Scan all Service 01 PIDs
    3. Request DTCs
    
    Results are saved to aurige_obd.log in the mission logs directory.
    """
    results = {
        "vin": None,
        "pids": [],
        "dtcs": [],
        "logFile": None,
    }
    
    # Use /tmp for the scan log
    log_path = Path(f"/tmp/aurige_obd_{int(time.time())}.log")
    
    with open(log_path, "w") as f:
        f.write("########## VIN DU VEHICULE ##########\n")
        
        # 1. Request VIN
        vin_result = await obd_send_with_flow_control(
            request.interface, "7DF", "0209020000000000", "7E8"
        )
        if vin_result["success"]:
            for line in vin_result["responses"]:
                f.write(line + "\n")
            decoded_vin = decode_vin_from_frames(vin_result["responses"])
            results["vin"] = [decoded_vin] if decoded_vin else vin_result["responses"]
            results["vin_raw"] = vin_result["responses"]
        else:
            f.write(f"Error: {vin_result['error']}\n")
            results["vin"] = []
        
        f.write("\n########## SCAN DES PIDS ##########\n")
        
        # 2. Scan PIDs (shortened for API response time)
        # Scan key PIDs only: 0x00, 0x01, 0x05, 0x0C, 0x0D, 0x0F, 0x11
        key_pids = [0x00, 0x01, 0x05, 0x0C, 0x0D, 0x0F, 0x11, 0x1F, 0x2F]
        
        candump = await asyncio.create_subprocess_exec(
            "candump", "-L", "-ta", f"{request.interface},7DF:7FF,7E8:7E8",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        
        await asyncio.sleep(0.05)
        
        for pid in key_pids:
            _, _ = can_send_frame(request.interface, "7DF", f"0201{pid:02X}0000000000")
            await asyncio.sleep(0.1)
        
        await asyncio.sleep(0.5)
        candump.terminate()
        
        f.write("\n########## DTCs DU VEHICULE ##########\n")
        
        # 3. Request DTCs
        dtc_result = await obd_send_with_flow_control(
            request.interface, "7DF", "0103000000000000", "7E8"
        )
        if dtc_result["success"]:
            for line in dtc_result["responses"]:
                f.write(line + "\n")
            decoded_dtcs = decode_dtcs_from_frames(dtc_result["responses"])
            results["dtcs"] = decoded_dtcs if decoded_dtcs else dtc_result["responses"]
            results["dtcs_raw"] = dtc_result["responses"]
        else:
            f.write(f"Error: {dtc_result['error']}\n")
            results["dtcs"] = []
    
    results["logFile"] = str(log_path)
    
    # Also save as JSON report for later retrieval
    report_path = Path("/tmp/aurige_last_obd_report.json")
    import json as json_mod
    report_data = {
        "timestamp": time.time(),
        "interface": request.interface,
        "vin": results["vin"],
        "vin_raw": results.get("vin_raw", []),
        "pids": results["pids"],
        "dtcs": results["dtcs"],
        "dtcs_raw": results.get("dtcs_raw", []),
        "logFile": str(log_path),
    }
    with open(report_path, "w") as rf:
        json_mod.dump(report_data, rf, indent=2)
    
    return {
        "status": "completed",
        "message": "Full OBD scan completed",
        "results": results,
    }


@app.get("/api/obd/last-report")
async def get_last_obd_report():
    """Get the last OBD-II scan report if available"""
    import json as json_mod
    report_path = Path("/tmp/aurige_last_obd_report.json")
    if not report_path.exists():
        return {"status": "not_found", "message": "Aucun rapport OBD disponible"}
    try:
        with open(report_path, "r") as f:
            report = json_mod.load(f)
        return {"status": "success", "report": report}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.post("/api/obd/pid")
async def read_obd_pid(
    interface: str = "can0",
    service: str = "01",  # Service 01 = Current Data
    pid: str = "0C",  # PID 0C = Engine RPM
):
    """
    Read a specific OBD-II PID.
    
    Common PIDs:
    - 01 0C: Engine RPM
    - 01 0D: Vehicle Speed
    - 01 05: Engine Coolant Temp
    - 01 0F: Intake Air Temp
    - 01 2F: Fuel Level
    """
    # Format: Length + Service + PID + padding
    data = f"02{service}{pid}0000000000"[:16]
    _, _ = can_send_frame(interface, "7DF", data)
    
    return {
        "status": "sent",
        "service": service,
        "pid": pid,
        "message": f"OBD-II request sent for service {service}, PID {pid}",
    }


# =============================================================================
# WebSocket - cansniffer (live CAN view for terminal)
# =============================================================================

class SnifferState:
    process: Optional[asyncio.subprocess.Process] = None
    interface: Optional[str] = None
    clients: list[WebSocket] = []

sniffer_state = SnifferState()


@app.websocket("/ws/cansniffer")
async def websocket_cansniffer(websocket: WebSocket, interface: str = Query(default="can0")):
    """
    WebSocket endpoint for live CAN traffic view.
    
    Uses candump with timestamp for live monitoring.
    This is for the floating terminal, NOT for recording.
    """
    await websocket.accept()
    sniffer_state.clients.append(websocket)
    
    # Each client gets its own candump process for isolation
    process = None
    
    try:
        # Start candump for this client
        # -t a: absolute timestamp, -x: extended info
        process = await asyncio.create_subprocess_exec(
            "candump", "-ta", interface,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        
        # Read and send to this websocket
        while True:
            if process and process.stdout:
                line = await process.stdout.readline()
                if not line:
                    # Process ended
                    break
                
                try:
                    decoded = line.decode().strip()
                    if decoded and not decoded.startswith("interface"):
                        # Parse candump output: (timestamp) interface canid#data
                        # Example: (1234567890.123456)  can0  7DF   [8]  02 01 0C 00 00 00 00 00
                        parts = decoded.split()
                        if len(parts) >= 4:
                            timestamp = parts[0].strip("()")
                            can_id = parts[2]
                            # Find data after [dlc]
                            try:
                                dlc_idx = decoded.index("[")
                                dlc_end = decoded.index("]")
                                dlc = int(decoded[dlc_idx+1:dlc_end])
                                data_part = decoded[dlc_end+1:].strip().replace(" ", "")
                            except (ValueError, IndexError):
                                dlc = 8
                                data_part = "".join(parts[4:]) if len(parts) > 4 else ""
                            
                            msg = json.dumps({
                                "timestamp": float(timestamp) if timestamp else time.time(),
                                "canId": can_id,
                                "data": data_part.upper(),
                                "dlc": dlc,
                            })
                            await websocket.send_text(msg)
                except Exception as e:
                    # Skip malformed lines
                    pass
            else:
                await asyncio.sleep(0.01)
                
    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await websocket.send_text(json.dumps({"error": str(e)}))
        except:
            pass
    finally:
        if websocket in sniffer_state.clients:
            sniffer_state.clients.remove(websocket)
        
        if process and process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                process.kill()


# =============================================================================
# Health Check
# =============================================================================

@app.get("/api/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "timestamp": datetime.now().isoformat(),
        "version": "2.0.0",
        "dataDir": str(DATA_DIR),
    }


# =============================================================================
# Network Configuration Endpoints
# =============================================================================

@app.get("/api/network/wifi/scan")
async def scan_wifi_networks():
    """Scan for available Wi-Fi networks"""
    try:
        # Use nmcli to scan for networks
        result = run_command(["nmcli", "-t", "-f", "SSID,SIGNAL,SECURITY,BSSID", "device", "wifi", "list", "--rescan", "yes"], check=False)
        if result.returncode != 0:
            return {"status": "error", "message": "Failed to scan Wi-Fi networks", "networks": []}
        
        networks = []
        seen_ssids = set()
        for line in result.stdout.strip().split("\n"):
            if not line:
                continue
            parts = line.split(":")
            if len(parts) >= 4:
                ssid = parts[0]
                if ssid and ssid not in seen_ssids:
                    seen_ssids.add(ssid)
                    networks.append({
                        "ssid": ssid,
                        "signal": int(parts[1]) if parts[1].isdigit() else 0,
                        "security": parts[2] if parts[2] else "Open",
                        "bssid": parts[3] if len(parts) > 3 else "",
                    })
        
        # Sort by signal strength
        networks.sort(key=lambda x: x["signal"], reverse=True)
        return {"status": "success", "networks": networks}
    except Exception as e:
        return {"status": "error", "message": str(e), "networks": []}


@app.get("/api/network/wifi/status")
async def get_wifi_status():
    """Get current Wi-Fi connection status with detailed info"""
    try:
        # Check if wlan0 is in AP (hotspot) mode or client mode
        # AP mode typically has IP 10.42.0.1
        is_hotspot = False
        hotspot_ssid = ""
        client_ssid = ""
        client_signal = 0
        tx_rate = ""
        rx_rate = ""
        ip_local = ""
        
        # Check wlan0 IP
        ip_result = run_command(["ip", "-4", "addr", "show", "wlan0"], check=False)
        for line in ip_result.stdout.split("\n"):
            if "inet " in line:
                ip_local = line.strip().split()[1].split("/")[0]
                # 10.42.0.1 is the typical hotspot IP
                if ip_local.startswith("10.42.0."):
                    is_hotspot = True
                break
        
        # Check nmcli for connection info
        nmcli_result = run_command(["nmcli", "-t", "-f", "NAME,TYPE,DEVICE", "connection", "show", "--active"], check=False)
        for line in nmcli_result.stdout.strip().split("\n"):
            parts = line.split(":")
            if len(parts) >= 3:
                conn_name, conn_type, device = parts[0], parts[1], parts[2]
                if device == "wlan0":
                    if conn_type == "802-11-wireless" or "wifi" in conn_type.lower():
                        # Check if this is AP or client
                        # AP connections typically have "Hotspot" in name or we can check mode
                        mode_result = run_command(["nmcli", "-t", "-f", "802-11-wireless.mode", "connection", "show", conn_name], check=False)
                        mode = mode_result.stdout.strip().split(":")[-1] if mode_result.returncode == 0 else ""
                        if mode == "ap" or "hotspot" in conn_name.lower() or "aurige" in conn_name.lower():
                            is_hotspot = True
                            # Get actual SSID from connection settings (not connection name)
                            ssid_r = run_command(["nmcli", "-t", "-f", "802-11-wireless.ssid", "connection", "show", conn_name], check=False)
                            if ssid_r.returncode == 0:
                                ssid_line = ssid_r.stdout.strip()
                                hotspot_ssid = ssid_line.split(":")[-1] if ":" in ssid_line else conn_name
                            else:
                                hotspot_ssid = conn_name
                        else:
                            client_ssid = conn_name
        
        # If in client mode, get actual SSID and signal
        if not is_hotspot and ip_local:
            # Try iwgetid for SSID
            ssid_result = run_command(["iwgetid", "-r", "wlan0"], check=False)
            if ssid_result.returncode == 0 and ssid_result.stdout.strip():
                client_ssid = ssid_result.stdout.strip()
            
            # Get signal and rates from iw
            iw_result = run_command(["iw", "dev", "wlan0", "link"], check=False)
            for line in iw_result.stdout.split("\n"):
                if "SSID:" in line and not client_ssid:
                    client_ssid = line.split("SSID:")[1].strip()
                if "signal:" in line:
                    try:
                        client_signal = int(line.split("signal:")[1].strip().split()[0])
                    except:
                        pass
                if "tx bitrate:" in line:
                    tx_rate = line.split("tx bitrate:")[1].strip().split()[0] + " Mbps"
                if "rx bitrate:" in line:
                    rx_rate = line.split("rx bitrate:")[1].strip().split()[0] + " Mbps"
        
        # Get public IP
        ip_public = ""
        try:
            pub_result = run_command(["curl", "-s", "--max-time", "3", "ifconfig.me"], check=False)
            if pub_result.returncode == 0:
                ip_public = pub_result.stdout.strip()
        except:
            pass
        
        # Detect ALL network interfaces and their status
        internet_source = ""
        internet_interface = ""
        internet_via = ""
        
        # Gather info on all secondary interfaces (not wlan0 hotspot)
        secondary_interfaces = []
        
        # Check wlan1 (TP-Link USB dongle)
        wlan1_ssid = ""
        wlan1_ip = ""
        wlan1_signal = 0
        try:
            wlan1_ip_result = run_command(["ip", "-4", "addr", "show", "wlan1"], check=False)
            if wlan1_ip_result.returncode == 0:
                for wline in wlan1_ip_result.stdout.split("\n"):
                    if "inet " in wline:
                        wlan1_ip = wline.strip().split()[1].split("/")[0]
                        break
            ssid_result = run_command(["iwgetid", "-r", "wlan1"], check=False)
            if ssid_result.returncode == 0 and ssid_result.stdout.strip():
                wlan1_ssid = ssid_result.stdout.strip()
            if wlan1_ssid or wlan1_ip:
                # Get signal strength
                iw_result = run_command(["iw", "dev", "wlan1", "link"], check=False)
                if iw_result.returncode == 0:
                    for wline in iw_result.stdout.split("\n"):
                        if "signal:" in wline:
                            try:
                                wlan1_signal = int(wline.split("signal:")[1].strip().split()[0])
                            except:
                                pass
                secondary_interfaces.append({
                    "name": "wlan1",
                    "type": "wifi",
                    "label": "WiFi USB (TP-Link)",
                    "ssid": wlan1_ssid,
                    "ip": wlan1_ip,
                    "signal": wlan1_signal,
                    "connected": bool(wlan1_ssid),
                })
        except:
            pass
        
        # Check USB interfaces (Huawei router, phone tethering)
        try:
            ip_link_result = run_command(["ip", "-j", "link", "show"], check=False)
            if ip_link_result.returncode == 0:
                all_links = json.loads(ip_link_result.stdout)
                for link in all_links:
                    iface_name = link.get("ifname", "")
                    if iface_name.startswith("usb") or iface_name.startswith("enx"):
                        usb_ip = ""
                        usb_ip_result = run_command(["ip", "-4", "addr", "show", iface_name], check=False)
                        if usb_ip_result.returncode == 0:
                            for wline in usb_ip_result.stdout.split("\n"):
                                if "inet " in wline:
                                    usb_ip = wline.strip().split()[1].split("/")[0]
                                    break
                        
                        # Identify USB device
                        usb_device_name = ""
                        try:
                            usb_result = run_command(["lsusb"], check=False)
                            if usb_result.returncode == 0:
                                for uline in usb_result.stdout.split("\n"):
                                    uline_lower = uline.lower()
                                    if any(kw in uline_lower for kw in ["huawei", "hilink", "rndis", "cdc ether", "android", "apple", "iphone", "samsung", "xiaomi"]):
                                        parts = uline.split(" ", 6)
                                        if len(parts) >= 7:
                                            usb_device_name = parts[6].strip()
                                        break
                        except:
                            pass
                        
                        operstate = link.get("operstate", "").upper()
                        secondary_interfaces.append({
                            "name": iface_name,
                            "type": "usb",
                            "label": usb_device_name or f"USB ({iface_name})",
                            "ssid": "",
                            "ip": usb_ip,
                            "signal": 0,
                            "connected": operstate == "UP" or bool(usb_ip),
                        })
        except:
            pass
        
        # Check eth0
        try:
            eth_result = run_command(["ip", "-4", "addr", "show", "eth0"], check=False)
            if eth_result.returncode == 0:
                eth_ip = ""
                for wline in eth_result.stdout.split("\n"):
                    if "inet " in wline:
                        eth_ip = wline.strip().split()[1].split("/")[0]
                        break
                if eth_ip:
                    secondary_interfaces.append({
                        "name": "eth0",
                        "type": "ethernet",
                        "label": "Ethernet",
                        "ssid": "",
                        "ip": eth_ip,
                        "signal": 0,
                        "connected": True,
                    })
        except:
            pass
        
        # Find which interface provides the default route (= internet)
        route_result = run_command(["ip", "route", "show", "default"], check=False)
        if route_result.returncode == 0:
            for line in route_result.stdout.strip().split("\n"):
                if "default" in line:
                    parts = line.split()
                    if "dev" in parts:
                        idx = parts.index("dev")
                        if idx + 1 < len(parts):
                            internet_interface = parts[idx + 1]
                    break
        
        # Label the internet source from the default route interface
        for si in secondary_interfaces:
            if si["name"] == internet_interface:
                si["isDefaultRoute"] = True
                internet_source = si["label"]
                if si["ssid"]:
                    internet_via = si["ssid"]
                break
        else:
            if internet_interface:
                internet_source = internet_interface
        
        # Test internet connectivity with ping
        has_internet = False
        ping_ms = 0
        try:
            ping_result = run_command(["ping", "-c", "1", "-W", "2", "8.8.8.8"], check=False)
            if ping_result.returncode == 0:
                has_internet = True
                # Parse ping time
                for pline in ping_result.stdout.split("\n"):
                    if "time=" in pline:
                        try:
                            ping_ms = float(pline.split("time=")[1].split()[0])
                        except:
                            pass
        except:
            pass
        
        # Quick download speed test (download a small file)
        download_speed = ""
        if has_internet:
            try:
                speed_result = run_command(
                    ["curl", "-s", "-w", "%{speed_download}", "-o", "/dev/null",
                     "--max-time", "5", "http://speedtest.tele2.net/1MB.zip"],
                    check=False
                )
                if speed_result.returncode == 0 and speed_result.stdout.strip():
                    speed_bps = float(speed_result.stdout.strip())
                    speed_mbps = (speed_bps * 8) / 1_000_000
                    if speed_mbps >= 1:
                        download_speed = f"{speed_mbps:.1f} Mbps"
                    else:
                        speed_kbps = (speed_bps * 8) / 1000
                        download_speed = f"{speed_kbps:.0f} kbps"
            except:
                pass
        
        return {
            "connected": bool(ip_local),
            "isHotspot": is_hotspot,
            "hotspotSsid": hotspot_ssid if is_hotspot else "",
            "ssid": client_ssid if not is_hotspot else "",
            "signal": client_signal,
            "txRate": tx_rate,
            "rxRate": rx_rate,
            "ipLocal": ip_local,
            "ipPublic": ip_public,
            "internetSource": internet_source,
            "internetInterface": internet_interface,
            "internetVia": internet_via,
            "hasInternet": has_internet,
            "pingMs": round(ping_ms, 1),
            "downloadSpeed": download_speed,
            "secondaryInterfaces": secondary_interfaces,
        }
    except Exception as e:
        return {"connected": False, "ssid": "", "signal": 0, "error": str(e)}


@app.get("/api/network/ethernet/status")
async def get_ethernet_status():
    """Get current Ethernet connection status"""
    try:
        connected = False
        ip_local = ""
        
        # Check eth0 status
        result = run_command(["ip", "-json", "addr", "show", "eth0"], check=False)
        if result.returncode == 0:
            data = json.loads(result.stdout)
            if data:
                for addr_info in data[0].get("addr_info", []):
                    if addr_info.get("family") == "inet":
                        ip_local = addr_info.get("local", "")
                        connected = True
                        break
        
        return {
            "connected": connected,
            "ipLocal": ip_local,
        }
    except Exception as e:
        return {"connected": False, "ipLocal": "", "error": str(e)}


class WifiConnectRequest(BaseModel):
    ssid: str
    password: str


@app.get("/api/network/wifi/saved")
async def get_saved_networks():
    """Get list of saved Wi-Fi networks"""
    try:
        result = run_command(["nmcli", "-t", "-f", "NAME,TYPE", "connection", "show"], check=False)
        saved = []
        if result.returncode == 0:
            for line in result.stdout.strip().split("\n"):
                parts = line.split(":")
                if len(parts) >= 2 and parts[1] == "802-11-wireless":
                    saved.append(parts[0])
        return {"saved": saved}
    except Exception as e:
        return {"saved": [], "error": str(e)}


@app.post("/api/network/wifi/connect")
async def connect_to_wifi(request: WifiConnectRequest):
    """Connect to a Wi-Fi network, handling hotspot->client transition safely"""
    try:
        # Detect if currently in hotspot mode
        was_hotspot = False
        active_result = run_command(["nmcli", "-t", "-f", "NAME,TYPE,DEVICE", "connection", "show", "--active"], check=False)
        hotspot_conn_name = None
        if active_result.returncode == 0:
            for line in active_result.stdout.strip().split("\n"):
                parts = line.split(":")
                if len(parts) >= 3 and parts[2] == "wlan0":
                    conn_name = parts[0]
                    if "hotspot" in conn_name.lower() or "aurige" in conn_name.lower():
                        was_hotspot = True
                        hotspot_conn_name = conn_name
                    # Also check if in AP mode
                    mode_check = run_command(["nmcli", "-t", "-f", "GENERAL.MODE", "connection", "show", conn_name], check=False)
                    if mode_check.returncode == 0 and "ap" in mode_check.stdout.lower():
                        was_hotspot = True
                        hotspot_conn_name = conn_name
        
        # If in hotspot mode, disable it first to free wlan0
        if was_hotspot and hotspot_conn_name:
            run_command(["nmcli", "connection", "down", hotspot_conn_name], check=False, timeout=10)
            # Wait for interface to be released
            import time
            time.sleep(2)
            # Rescan wifi networks after disabling hotspot
            run_command(["nmcli", "device", "wifi", "rescan"], check=False, timeout=10)
            time.sleep(2)
        
        # Check if this network is already saved
        saved_result = run_command(["nmcli", "-t", "-f", "NAME,TYPE", "connection", "show"], check=False)
        is_saved = False
        if saved_result.returncode == 0:
            for line in saved_result.stdout.strip().split("\n"):
                parts = line.split(":")
                if len(parts) >= 2 and parts[0] == request.ssid and parts[1] == "802-11-wireless":
                    is_saved = True
                    break
        
        if is_saved:
            result = run_command([
                "nmcli", "connection", "up", request.ssid
            ], check=False, timeout=30)
        elif request.password:
            result = run_command([
                "nmcli", "device", "wifi", "connect", request.ssid,
                "password", request.password
            ], check=False, timeout=30)
        else:
            result = run_command([
                "nmcli", "device", "wifi", "connect", request.ssid
            ], check=False, timeout=30)
        
        if result.returncode == 0:
            # Enable autoconnect with high priority for this network
            run_command([
                "nmcli", "connection", "modify", request.ssid,
                "connection.autoconnect", "yes",
                "connection.autoconnect-priority", "100"
            ], check=False)
            return {"status": "success", "message": f"Connecte a {request.ssid}"}
        else:
            error_msg = result.stderr.strip() if result.stderr else result.stdout.strip() if result.stdout else "Connexion echouee"
            
            # FALLBACK: If connection failed and we disabled hotspot, re-enable it
            if was_hotspot and hotspot_conn_name:
                run_command(["nmcli", "connection", "up", hotspot_conn_name], check=False, timeout=15)
                error_msg += " (Hotspot reactive)"
            
            return {"status": "error", "message": error_msg}
    except Exception as e:
        # FALLBACK: Re-enable hotspot on any exception
        if was_hotspot and hotspot_conn_name:
            try:
                run_command(["nmcli", "connection", "up", hotspot_conn_name], check=False, timeout=15)
            except Exception:
                pass
        return {"status": "error", "message": str(e)}


# =============================================================================
# System Administration Endpoints
# =============================================================================

# Store for apt process output
apt_output_store: dict = {"lines": [], "running": False, "command": ""}


@app.post("/api/system/apt/update")
async def apt_update():
    """Run apt update"""
    global apt_output_store
    if apt_output_store["running"]:
        return {"status": "error", "message": "Une commande apt est déjà en cours"}
    
    apt_output_store = {"lines": [], "running": True, "command": "apt update"}
    
    async def run_apt():
        global apt_output_store
        try:
            process = await asyncio.create_subprocess_exec(
                "sudo", "apt", "update",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            while True:
                line = await process.stdout.readline()
                if not line:
                    break
                apt_output_store["lines"].append(line.decode().strip())
            await process.wait()
            apt_output_store["lines"].append(f"--- Terminé (code: {process.returncode}) ---")
        except Exception as e:
            apt_output_store["lines"].append(f"Erreur: {str(e)}")
        finally:
            apt_output_store["running"] = False
    
    asyncio.create_task(run_apt())
    return {"status": "started", "message": "apt update démarré"}


@app.post("/api/system/apt/upgrade")
async def apt_upgrade():
    """Run apt upgrade -y"""
    global apt_output_store
    if apt_output_store["running"]:
        return {"status": "error", "message": "Une commande apt est déjà en cours"}
    
    apt_output_store = {"lines": [], "running": True, "command": "apt upgrade"}
    
    async def run_apt():
        global apt_output_store
        try:
            process = await asyncio.create_subprocess_exec(
                "sudo", "apt", "upgrade", "-y",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            while True:
                line = await process.stdout.readline()
                if not line:
                    break
                apt_output_store["lines"].append(line.decode().strip())
            await process.wait()
            apt_output_store["lines"].append(f"--- Terminé (code: {process.returncode}) ---")
        except Exception as e:
            apt_output_store["lines"].append(f"Erreur: {str(e)}")
        finally:
            apt_output_store["running"] = False
    
    asyncio.create_task(run_apt())
    return {"status": "started", "message": "apt upgrade démarré"}


@app.get("/api/system/apt/output")
async def get_apt_output():
    """Get apt command output"""
    return {
        "running": apt_output_store["running"],
        "command": apt_output_store["command"],
        "lines": apt_output_store["lines"],
    }


# =============================================================================
# Tailscale VPN Management
# =============================================================================

@app.get("/api/tailscale/status")
async def tailscale_status():
    """Get Tailscale VPN status including peers, IP, and connection info"""
    # Check if tailscale is installed
    which_result = run_command(["which", "tailscale"], check=False)
    if which_result.returncode != 0:
        return {
            "installed": False,
            "running": False,
            "hostname": "",
            "tailscaleIp": "",
            "magicDns": "",
            "online": False,
            "exitNode": False,
            "os": "",
            "version": "",
            "peers": [],
            "authUrl": "",
        }
    
    # Get version
    version = ""
    ver_result = run_command(["tailscale", "version"], check=False)
    if ver_result.returncode == 0:
        version = ver_result.stdout.strip().split("\n")[0]
    
    # Get status as JSON
    result = run_command(["tailscale", "status", "--json"], check=False)
    if result.returncode != 0:
        return {
            "installed": True,
            "running": False,
            "hostname": "",
            "tailscaleIp": "",
            "magicDns": "",
            "online": False,
            "exitNode": False,
            "os": "",
            "version": version,
            "peers": [],
            "authUrl": "",
        }
    
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        return {
            "installed": True,
            "running": False,
            "hostname": "",
            "tailscaleIp": "",
            "magicDns": "",
            "online": False,
            "exitNode": False,
            "os": "",
            "version": version,
            "peers": [],
            "authUrl": "",
        }
    
    # Parse self info
    self_info = data.get("Self", {})
    ts_ips = self_info.get("TailscaleIPs", [])
    tailscale_ip = ts_ips[0] if ts_ips else ""
    dns_name = self_info.get("DNSName", "").rstrip(".")
    is_online = self_info.get("Online", False)
    hostname = self_info.get("HostName", "")
    ts_os = self_info.get("OS", "")
    backend_state = data.get("BackendState", "")
    
    # Check if using an exit node
    exit_node_active = False
    prefs = data.get("Prefs", {})
    if prefs:
        exit_node_id = prefs.get("ExitNodeID", "")
        exit_node_active = bool(exit_node_id)
    
    # Auth URL (if needs re-auth)
    auth_url = data.get("AuthURL", "")
    
    # Parse peers
    peers = []
    peer_map = data.get("Peer", {})
    for peer_id, peer in peer_map.items():
        peer_ips = peer.get("TailscaleIPs", [])
        peer_dns = peer.get("DNSName", "").rstrip(".")
        peer_online = peer.get("Online", False)
        peer_hostname = peer.get("HostName", "")
        peer_os = peer.get("OS", "")
        peer_exit = peer.get("ExitNode", False)
        peer_exit_offer = peer.get("ExitNodeOption", False)
        
        # Calculate last seen
        last_seen = peer.get("LastSeen", "")
        
        # Rx/Tx bytes
        rx_bytes = peer.get("RxBytes", 0)
        tx_bytes = peer.get("TxBytes", 0)
        
        peers.append({
            "id": peer_id,
            "hostname": peer_hostname,
            "dnsName": peer_dns,
            "os": peer_os,
            "online": peer_online,
            "ip": peer_ips[0] if peer_ips else "",
            "isExitNode": peer_exit,
            "exitNodeOption": peer_exit_offer,
            "lastSeen": last_seen,
            "rxBytes": rx_bytes,
            "txBytes": tx_bytes,
        })
    
    # Sort: online first, then by hostname
    peers.sort(key=lambda p: (not p["online"], p["hostname"].lower()))
    
    return {
        "installed": True,
        "running": backend_state == "Running",
        "backendState": backend_state,
        "hostname": hostname,
        "tailscaleIp": tailscale_ip,
        "magicDns": dns_name,
        "online": is_online,
        "exitNode": exit_node_active,
        "os": ts_os,
        "version": version,
        "peers": peers,
        "authUrl": auth_url,
    }


@app.post("/api/tailscale/up")
async def tailscale_up():
    """Start Tailscale / connect to the network"""
    result = run_command(["sudo", "tailscale", "up", "--accept-routes"], check=False, timeout=15)
    if result.returncode == 0:
        return {"status": "success", "message": "Tailscale connecte"}
    
    # Check if needs auth
    if "https://" in (result.stderr or result.stdout or ""):
        # Extract auth URL
        output = result.stderr or result.stdout or ""
        url = ""
        for word in output.split():
            if word.startswith("https://"):
                url = word
                break
        return {"status": "auth_needed", "message": "Authentification requise", "authUrl": url}
    
    return {"status": "error", "message": result.stderr or result.stdout or "Erreur inconnue"}


@app.post("/api/tailscale/down")
async def tailscale_down():
    """Disconnect Tailscale"""
    result = run_command(["sudo", "tailscale", "down"], check=False, timeout=10)
    if result.returncode == 0:
        return {"status": "success", "message": "Tailscale deconnecte"}
    return {"status": "error", "message": result.stderr or "Erreur"}


@app.post("/api/tailscale/logout")
async def tailscale_logout():
    """Logout from Tailscale (will need re-auth)"""
    result = run_command(["sudo", "tailscale", "logout"], check=False, timeout=10)
    if result.returncode == 0:
        return {"status": "success", "message": "Deconnexion du compte Tailscale"}
    return {"status": "error", "message": result.stderr or "Erreur"}


@app.post("/api/tailscale/set-exit-node")
async def tailscale_set_exit_node(peer_ip: str = Query(default="")):
    """Set or clear exit node"""
    if peer_ip:
        result = run_command(
            ["sudo", "tailscale", "set", "--exit-node", peer_ip],
            check=False, timeout=10
        )
    else:
        result = run_command(
            ["sudo", "tailscale", "set", "--exit-node="],
            check=False, timeout=10
        )
    
    if result.returncode == 0:
        msg = f"Exit node: {peer_ip}" if peer_ip else "Exit node desactive"
        return {"status": "success", "message": msg}
    return {"status": "error", "message": result.stderr or "Erreur"}


@app.post("/api/system/reboot")
async def system_reboot():
    """Reboot the Raspberry Pi"""
    try:
        # Schedule reboot in 2 seconds to allow response
        asyncio.create_task(asyncio.create_subprocess_exec("sudo", "shutdown", "-r", "+0"))
        return {"status": "success", "message": "Redémarrage en cours..."}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.post("/api/system/shutdown")
async def system_shutdown():
    """Shutdown the Raspberry Pi"""
    try:
        asyncio.create_task(asyncio.create_subprocess_exec("sudo", "shutdown", "-h", "+0"))
        return {"status": "success", "message": "Arrêt en cours..."}
    except Exception as e:
        return {"status": "error", "message": str(e)}


# =============================================================================
# Update and Backup Endpoints
# =============================================================================

# Store for update process output
update_output_store: dict = {"lines": [], "running": False, "command": ""}


# Git repo is in /tmp/aurige, not /opt/aurige
GIT_REPO_PATH = "/opt/aurige/repo"


@app.get("/api/system/branches")
async def get_git_branches():
    """List remote branches from GitHub repo"""
    GITHUB_REPO = "https://github.com/Yo-ETE/v0-aurige-ui-design.git"
    INSTALLED_REPO = "/opt/aurige/repo"
    repo_to_check = INSTALLED_REPO if Path(f"{INSTALLED_REPO}/.git").exists() else GIT_REPO_PATH
    
    try:
        # Try to get branches from an existing local repo first (faster)
        if Path(f"{repo_to_check}/.git").exists():
            run_command(["git", "config", "--global", "--add", "safe.directory", repo_to_check], check=False)
            run_command(["git", "-C", repo_to_check, "fetch", "--prune", "origin"], check=False)
            result = run_command(["git", "-C", repo_to_check, "branch", "-r", "--format=%(refname:short)"], check=False)
            if result.returncode == 0 and result.stdout.strip():
                branches = []
                for line in result.stdout.strip().split("\n"):
                    branch = line.strip()
                    if branch and not branch.endswith("/HEAD"):
                        # Remove "origin/" prefix
                        branch_name = branch.replace("origin/", "", 1) if branch.startswith("origin/") else branch
                        if branch_name:
                            branches.append(branch_name)
                
                # Get currently saved branch preference
                saved_branch = ""
                saved_branch_file = Path("/opt/aurige/branch.txt")
                if saved_branch_file.exists():
                    saved_branch = saved_branch_file.read_text().strip()
                
                return {
                    "branches": sorted(set(branches)),
                    "current": saved_branch or "v0/yo-ete-5c91d9cb",
                }
        
        # Fallback: use git ls-remote (works without local clone)
        result = run_command(["git", "ls-remote", "--heads", GITHUB_REPO], check=False)
        if result.returncode == 0 and result.stdout.strip():
            branches = []
            for line in result.stdout.strip().split("\n"):
                parts = line.strip().split("\t")
                if len(parts) == 2:
                    ref = parts[1]
                    branch_name = ref.replace("refs/heads/", "")
                    if branch_name:
                        branches.append(branch_name)
            
            saved_branch = ""
            saved_branch_file = Path("/opt/aurige/branch.txt")
            if saved_branch_file.exists():
                saved_branch = saved_branch_file.read_text().strip()
            
            return {
                "branches": sorted(branches),
                "current": saved_branch or "v0/yo-ete-5c91d9cb",
            }
        
        return {"branches": [], "current": "", "error": "Impossible de lister les branches"}
    except Exception as e:
        return {"branches": [], "current": "", "error": str(e)}


@app.get("/api/system/version")
async def get_system_version():
    """Get current git version info - checks installed version in /opt/aurige/repo"""
    # Prefer the installed repo over /tmp/aurige
    INSTALLED_REPO = "/opt/aurige/repo"
    repo_to_check = INSTALLED_REPO if Path(f"{INSTALLED_REPO}/.git").exists() else GIT_REPO_PATH
    
    try:
        # Check if git repo exists
        if not Path(repo_to_check).exists() or not Path(f"{repo_to_check}/.git").exists():
            return {"branch": "non installe", "commit": "-", "commitsBehind": 0, "updateAvailable": False, "error": "Aucun depot git trouve"}
        
        # Add safe.directory to avoid "dubious ownership" error
        run_command(["git", "config", "--global", "--add", "safe.directory", repo_to_check], check=False)
        
        # Get current branch
        branch_result = run_command(["git", "-C", repo_to_check, "branch", "--show-current"], check=False)
        branch = branch_result.stdout.strip() if branch_result.returncode == 0 else "unknown"
        
        # Also check saved branch preference
        saved_branch_file = Path("/opt/aurige/branch.txt")
        saved_branch = ""
        if saved_branch_file.exists():
            saved_branch = saved_branch_file.read_text().strip()
        
        # Get current commit hash
        commit_result = run_command(["git", "-C", repo_to_check, "rev-parse", "--short", "HEAD"], check=False)
        commit = commit_result.stdout.strip() if commit_result.returncode == 0 else "unknown"
        
        # Get commit date
        date_result = run_command(["git", "-C", repo_to_check, "log", "-1", "--format=%ci"], check=False)
        commit_date = date_result.stdout.strip() if date_result.returncode == 0 else ""
        
        # Check if there are updates available by fetching from remote
        run_command(["git", "-C", repo_to_check, "fetch", "origin"], check=False)
        
        # Use saved branch preference or current branch
        check_branch = saved_branch or branch
        remote_branch = f"origin/{check_branch}" if check_branch and check_branch != "unknown" else "origin/main"
        behind_result = run_command(["git", "-C", repo_to_check, "rev-list", "--count", f"HEAD..{remote_branch}"], check=False)
        
        # If that fails (branch doesn't exist on remote), try origin/main
        if behind_result.returncode != 0 or not behind_result.stdout.strip().isdigit():
            remote_branch = "origin/main"
            behind_result = run_command(["git", "-C", repo_to_check, "rev-list", "--count", "HEAD..origin/main"], check=False)
        
        commits_behind = int(behind_result.stdout.strip()) if behind_result.returncode == 0 and behind_result.stdout.strip().isdigit() else 0
        
        return {
            "branch": saved_branch or branch,
            "commit": commit,
            "commitDate": commit_date,
            "commitsBehind": commits_behind,
            "updateAvailable": commits_behind > 0,
            "repoPath": repo_to_check,
        }
    except Exception as e:
        return {"branch": "unknown", "commit": "unknown", "error": str(e)}


@app.get("/api/system/data-info")
async def get_data_info():
    """Get info about the data directory for debugging"""
    try:
        data_files = []
        total_size = 0
        for f in DATA_DIR.rglob("*"):
            if f.is_file():
                size = f.stat().st_size
                total_size += size
                data_files.append({
                    "path": str(f.relative_to(DATA_DIR)),
                    "size": size,
                })
        
        return {
            "dataDir": str(DATA_DIR),
            "exists": DATA_DIR.exists(),
            "fileCount": len(data_files),
            "totalSize": total_size,
            "files": data_files[:50],  # Limit to first 50 files
        }
    except Exception as e:
        return {"error": str(e), "dataDir": str(DATA_DIR)}


@app.get("/api/system/backups")
async def list_backups():
    """List available backup files"""
    try:
        backup_dir = Path("/opt/aurige")
        backups = []
        for f in backup_dir.glob("data-backup-*.tar.gz"):
            # Use stat command to get file size (works better with sudo-created files)
            stat_result = run_command(["stat", "-c", "%s %Y", str(f)], check=False)
            if stat_result.returncode == 0:
                parts = stat_result.stdout.strip().split()
                size = int(parts[0]) if parts else 0
                mtime = int(parts[1]) if len(parts) > 1 else 0
            else:
                try:
                    stat = f.stat()
                    size = stat.st_size
                    mtime = int(stat.st_mtime)
                except:
                    size = 0
                    mtime = 0
            
            backups.append({
                "filename": f.name,
                "size": size,
                "created": datetime.fromtimestamp(mtime).isoformat() if mtime else "",
            })
        backups.sort(key=lambda x: x["created"], reverse=True)
        return {"backups": backups}
    except Exception as e:
        return {"backups": [], "error": str(e)}


@app.post("/api/system/backup")
async def create_backup():
    """Create a backup of the data directory"""
    try:
        timestamp = datetime.now().strftime("%Y-%m-%d-%H%M")
        backup_file = f"/opt/aurige/data-backup-{timestamp}.tar.gz"
        
        # Use the actual DATA_DIR that the app uses
        data_dir = DATA_DIR
        parent_dir = data_dir.parent  # /opt/aurige
        data_folder_name = data_dir.name  # data
        
        # Check if data directory exists
        if not data_dir.exists():
            return {"status": "error", "message": f"Le dossier {data_dir} n'existe pas"}
        
        # Check if data directory has any content
        data_files = list(data_dir.rglob("*"))
        file_count = len([f for f in data_files if f.is_file()])
        
        # Calculate total size before backup
        total_size = sum(f.stat().st_size for f in data_files if f.is_file())
        
        if file_count == 0:
            return {"status": "error", "message": f"Le dossier {data_dir} est vide, rien a sauvegarder"}
        
        # Create backup - use tar with sudo to ensure we can read all files
        result = run_command([
            "sudo", "tar", "-czf", backup_file, "-C", str(parent_dir), data_folder_name
        ], check=False)
        
        # Fix permissions so we can read it
        if result.returncode == 0:
            run_command(["sudo", "chmod", "644", backup_file], check=False)
        
        if result.returncode == 0:
            # Get file size
            try:
                size = Path(backup_file).stat().st_size
            except:
                stat_result = run_command(["stat", "-c", "%s", backup_file], check=False)
                size = int(stat_result.stdout.strip()) if stat_result.returncode == 0 else 0
            
            return {
                "status": "success",
                "message": f"Sauvegarde creee ({file_count} fichiers, {total_size/1024:.1f} Ko source)",
                "filename": f"data-backup-{timestamp}.tar.gz",
                "size": size,
            }
        else:
            return {"status": "error", "message": f"Erreur tar: {result.stderr or result.stdout}"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.delete("/api/system/backups/{filename}")
async def delete_backup(filename: str):
    """Delete a backup file"""
    try:
        # Security: only allow deleting backup files with proper naming
        if not filename.startswith("data-backup-") or not filename.endswith(".tar.gz"):
            raise HTTPException(status_code=400, detail="Nom de fichier invalide")
        
        backup_path = Path("/opt/aurige") / filename
        if not backup_path.exists():
            raise HTTPException(status_code=404, detail="Sauvegarde introuvable")
        
        # Try normal delete, then sudo if needed
        try:
            backup_path.unlink()
        except PermissionError:
            run_command(["sudo", "rm", str(backup_path)], check=False)
        
        return {"status": "success", "message": f"Sauvegarde {filename} supprimee"}
    except HTTPException:
        raise
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.post("/api/system/backups/{filename}/restore")
async def restore_backup(filename: str):
    """Restore a backup file"""
    try:
        # Security: only allow restoring backup files with proper naming
        if not filename.startswith("data-backup-") or not filename.endswith(".tar.gz"):
            raise HTTPException(status_code=400, detail="Nom de fichier invalide")
        
        backup_path = Path("/opt/aurige") / filename
        if not backup_path.exists():
            raise HTTPException(status_code=404, detail="Sauvegarde introuvable")
        
        # Extract backup to /opt/aurige (will overwrite data folder)
        result = run_command([
            "sudo", "tar", "-xzf", str(backup_path), "-C", "/opt/aurige"
        ], check=False)
        
        if result.returncode == 0:
            return {"status": "success", "message": f"Sauvegarde {filename} restauree. Redemarrez les services."}
        else:
            return {"status": "error", "message": result.stderr or "Erreur lors de la restauration"}
    except HTTPException:
        raise
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.post("/api/system/update")
async def start_update(request: Request):
    """Start update by fresh clone and install script. Optionally accepts JSON body with {branch: "..."} """
    global update_output_store
    if update_output_store["running"]:
        return {"status": "error", "message": "Une mise à jour est déjà en cours"}
    
    update_output_store = {"lines": [], "running": True, "command": "update"}
    
    # GitHub repo URL and target branch
    GITHUB_REPO = "https://github.com/Yo-ETE/v0-aurige-ui-design.git"
    TARGET_BRANCH = "v0/yo-ete-5c91d9cb"
    
    # Check if a specific branch was requested in the body
    try:
        body = await request.json()
        if body.get("branch"):
            TARGET_BRANCH = body["branch"]
            # Save the branch preference immediately
            save_branch_file = Path("/opt/aurige/branch.txt")
            try:
                save_branch_file.parent.mkdir(parents=True, exist_ok=True)
                save_branch_file.write_text(TARGET_BRANCH)
            except:
                pass
    except:
        pass
    
    # If no branch in body, check for saved branch preference
    if TARGET_BRANCH == "v0/yo-ete-5c91d9cb":
        saved_branch_file = Path("/opt/aurige/branch.txt")
        if saved_branch_file.exists():
            saved = saved_branch_file.read_text().strip()
            if saved:
                TARGET_BRANCH = saved
    
    async def run_update():
        global update_output_store
        try:
            # Note: We do NOT stop services here - install_pi.sh handles that
            # Stopping here would cause 502 errors for the frontend
            
            # Step 1: Remove old /tmp/aurige if exists
            update_output_store["lines"].append(">>> Nettoyage du dossier temporaire...")
            rm_proc = await asyncio.create_subprocess_exec(
                "sudo", "rm", "-rf", GIT_REPO_PATH,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            await rm_proc.wait()
            update_output_store["lines"].append("[OK] Dossier nettoye")
            
            # Step 2: Fresh clone from GitHub
            update_output_store["lines"].append(f">>> Clonage depuis GitHub...")
            clone_proc = await asyncio.create_subprocess_exec(
                "sudo", "git", "clone", GITHUB_REPO, GIT_REPO_PATH,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            while True:
                line = await clone_proc.stdout.readline()
                if not line:
                    break
                text = line.decode().strip()
                if text:
                    update_output_store["lines"].append(text)
            await clone_proc.wait()
            
            if clone_proc.returncode != 0:
                update_output_store["lines"].append(f"[ERROR] Erreur de clonage (code: {clone_proc.returncode})")
                update_output_store["running"] = False
                return
            
            update_output_store["lines"].append("[OK] Depot clone")
            
            # Step 3: Checkout the target branch
            # After a fresh clone, remote branches are origin/<name>
            # Use -B to create/force local branch tracking the remote
            update_output_store["lines"].append(f">>> Checkout de la branche {TARGET_BRANCH}...")
            checkout_proc = await asyncio.create_subprocess_exec(
                "sudo", "git", "-C", GIT_REPO_PATH, "checkout", "-B", TARGET_BRANCH, f"origin/{TARGET_BRANCH}",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            while True:
                line = await checkout_proc.stdout.readline()
                if not line:
                    break
                text = line.decode().strip()
                if text:
                    update_output_store["lines"].append(text)
            await checkout_proc.wait()
            
            if checkout_proc.returncode != 0:
                # Try direct checkout (works for branches like main)
                update_output_store["lines"].append(f">>> -B echoue, essai checkout direct {TARGET_BRANCH}...")
                checkout2_proc = await asyncio.create_subprocess_exec(
                    "sudo", "git", "-C", GIT_REPO_PATH, "checkout", TARGET_BRANCH,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                )
                await checkout2_proc.wait()
                if checkout2_proc.returncode != 0:
                    update_output_store["lines"].append(f">>> Branche {TARGET_BRANCH} non trouvee, utilisation de main")
                    fallback_proc = await asyncio.create_subprocess_exec(
                        "sudo", "git", "-C", GIT_REPO_PATH, "checkout", "main",
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.STDOUT,
                    )
                    await fallback_proc.wait()
                else:
                    update_output_store["lines"].append(f"[OK] Branche {TARGET_BRANCH}")
            else:
                update_output_store["lines"].append(f"[OK] Branche {TARGET_BRANCH}")
            
            # Save branch preference to branch.txt before install_pi.sh runs
            save_branch_proc = await asyncio.create_subprocess_exec(
                "sudo", "bash", "-c", f"echo '{TARGET_BRANCH}' > /opt/aurige/branch.txt",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            await save_branch_proc.wait()
            update_output_store["lines"].append(f"[OK] branch.txt sauvegarde: {TARGET_BRANCH}")
            
            # Step 4: Run install script (this will stop/restart services at the end)
            update_output_store["lines"].append(">>> Execution du script d'installation...")
            update_output_store["lines"].append(">>> (Les services redemarreront automatiquement)")
            
            process = await asyncio.create_subprocess_exec(
                "sudo", "bash", f"{GIT_REPO_PATH}/scripts/install_pi.sh",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                cwd=GIT_REPO_PATH,
            )
            while True:
                line = await process.stdout.readline()
                if not line:
                    break
                decoded = line.decode().strip()
                if decoded:
                    update_output_store["lines"].append(decoded)
            await process.wait()
            
            if process.returncode != 0:
                update_output_store["lines"].append(f"[ERROR] Erreur install_pi.sh (code: {process.returncode})")
            else:
                update_output_store["lines"].append("[OK] Mise a jour terminee!")
                update_output_store["lines"].append(">>> Redemarrage automatique des services dans 3 secondes...")
                
                # Use systemd-run to create a completely independent transient service
                # This survives when aurige-api is killed
                import subprocess
                
                # Create restart script
                restart_script = "/tmp/aurige_restart_services.sh"
                with open(restart_script, "w") as f:
                    f.write("#!/bin/bash\n")
                    f.write("sleep 3\n")
                    f.write("systemctl restart aurige-web.service\n")
                    f.write("sleep 2\n")
                    f.write("systemctl restart aurige-api.service\n")
                os.chmod(restart_script, 0o755)
                
                # Use systemd-run to execute the script as a transient service
                result = subprocess.run(
                    ["systemd-run", "--no-block", "--unit=aurige-restart-temp", "/bin/bash", restart_script],
                    capture_output=True,
                    text=True
                )
                
                if result.returncode == 0:
                    update_output_store["lines"].append("[OK] Services vont redemarrer automatiquement. Rechargez la page dans 5-10 secondes.")
                else:
                    # Fallback: try with at command
                    at_result = subprocess.run(
                        ["bash", "-c", f"echo '{restart_script}' | at now + 1 minute 2>/dev/null || echo 'at failed'"],
                        capture_output=True,
                        text=True
                    )
                    if "at failed" not in at_result.stdout:
                        update_output_store["lines"].append("[OK] Services vont redemarrer dans 1 minute. Rechargez la page.")
                    else:
                        update_output_store["lines"].append("[WARNING] Redemarrage auto echoue. Utilisez le bouton 'Redemarrer services'.")
            
        except Exception as e:
            update_output_store["lines"].append(f"[ERROR] {str(e)}")
        finally:
            update_output_store["running"] = False
    
    asyncio.create_task(run_update())
    return {"status": "started", "message": "Mise à jour démarrée"}


@app.get("/api/system/update/output")
async def get_update_output():
    """Get update command output"""
    lines = update_output_store["lines"]
    # Determine success/error status
    success = any("[OK] Mise a jour terminee" in line for line in lines)
    error = any("[ERROR]" in line for line in lines)
    
    return {
        "running": update_output_store["running"],
        "lines": lines,
        "success": success and not error,
        "error": "Erreur lors de la mise a jour" if error else None,
    }


@app.post("/api/system/restart-services")
async def restart_services():
    """Restart Aurige services (API and Web)"""
    try:
        results = []
        for service in ["aurige-api", "aurige-web"]:
            result = run_command(["sudo", "systemctl", "restart", service], check=False)
            if result.returncode == 0:
                results.append(f"{service}: OK")
            else:
                results.append(f"{service}: Erreur")
        return {"status": "success", "message": f"Services redemarres: {', '.join(results)}"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


# =============================================================================
# DBC Analysis - Diff AVANT/APRES et signaux
# =============================================================================

class ByteDiff(BaseModel):
    byte_index: int
    value_before: str
    value_after: str
    changed_bits: list[int]  # Liste des bits qui ont change (0-7)

class FrameDiff(BaseModel):
    can_id: str
    count_before: int
    count_ack: int  # Count in ACK window
    count_status: int  # Count in STATUS window
    bytes_diff: list[ByteDiff]
    classification: str  # "status", "ack", "info", "unchanged"
    confidence: float  # 0-100 confidence score
    sample_before: str
    sample_ack: str
    sample_status: str
    persistence: str  # "persistent", "transient", "none"

class FamilyAnalysisResponse(BaseModel):
    family_name: str
    frame_ids: list[str]
    frames_analysis: list[FrameDiff]
    summary: dict
    t0_timestamp: float  # Reference timestamp for UI

class AnalyzeFamilyRequest(BaseModel):
    mission_id: str
    log_id: str
    family_ids: list[str]
    t0_timestamp: float  # Reference timestamp (causal frame)
    before_offset_ms: list[float] = [-500, -50]  # t0-500ms to t0-50ms
    ack_offset_ms: list[float] = [0, 100]  # t0 to t0+100ms
    status_offset_ms: list[float] = [200, 1500]  # t0+200ms to t0+1500ms

@app.post("/api/analysis/family-diff")
async def analyze_family_diff(request: AnalyzeFamilyRequest) -> FamilyAnalysisResponse:
    """
    Analyse les differences AVANT/ACK/STATUS pour une famille d'IDs.
    Compare les payloads dans trois fenetres temporelles autour de t0.
    """
    import traceback
    try:
        print(f"[DEBUG] family-diff request: mission={request.mission_id}, log={request.log_id}, t0={request.t0_timestamp}")
        print(f"[DEBUG] family_ids: {request.family_ids}")
        print(f"[DEBUG] offsets: before={request.before_offset_ms}, ack={request.ack_offset_ms}, status={request.status_offset_ms}")
        
        mission_dir = Path(MISSIONS_DIR) / request.mission_id / "logs"
        if not mission_dir.exists():
            raise HTTPException(status_code=404, detail=f"Mission non trouvee: {mission_dir}")
        
        # Find log file
        log_file = None
        for f in mission_dir.glob("*.log"):
            if f.stem == request.log_id or f.name == request.log_id:
                log_file = f
                break
        
        if not log_file:
            available_logs = [f.name for f in mission_dir.glob("*.log")]
            raise HTTPException(status_code=404, detail=f"Log non trouve: {request.log_id}. Disponibles: {available_logs}")
        
        print(f"[DEBUG] Found log file: {log_file}")
        
        # Calculate absolute timestamps from t0 and offsets
        t0 = request.t0_timestamp
        before_start = t0 + request.before_offset_ms[0] / 1000
        before_end = t0 + request.before_offset_ms[1] / 1000
        ack_start = t0 + request.ack_offset_ms[0] / 1000
        ack_end = t0 + request.ack_offset_ms[1] / 1000
        status_start = t0 + request.status_offset_ms[0] / 1000
        status_end = t0 + request.status_offset_ms[1] / 1000
        
        # Parse log and extract frames in 3 windows
        frames_before: dict[str, list[str]] = {id: [] for id in request.family_ids}
        frames_ack: dict[str, list[str]] = {id: [] for id in request.family_ids}
        frames_status: dict[str, list[str]] = {id: [] for id in request.family_ids}
        
        with open(log_file, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                
                match = re.match(r"\((\d+\.\d+)\)\s+\w+\s+([0-9A-Fa-f]+)#([0-9A-Fa-f]*)", line)
                if not match:
                    continue
                
                ts = float(match.group(1))
                can_id = match.group(2).upper()
                data = match.group(3).upper()
                
                if can_id not in request.family_ids:
                    continue
                
                # Classify into 3 windows
                if before_start <= ts <= before_end:
                    frames_before[can_id].append(data)
                if ack_start <= ts <= ack_end:
                    frames_ack[can_id].append(data)
                if status_start <= ts <= status_end:
                    frames_status[can_id].append(data)
        
        # Helper to get representative payload
        def get_representative(data_list: list[str]) -> str:
            if not data_list:
                return ""
            from collections import Counter
            return Counter(data_list).most_common(1)[0][0]
        
        # Analyze differences for each ID
        frames_analysis = []
        status_count = 0
        ack_count = 0
        info_count = 0
        unchanged_count = 0
        
        for can_id in request.family_ids:
            before_data = frames_before.get(can_id, [])
            ack_data = frames_ack.get(can_id, [])
            status_data = frames_status.get(can_id, [])
            
            sample_before = get_representative(before_data) or ""
            sample_ack = get_representative(ack_data) or ""
            sample_status = get_representative(status_data) or ""
            
            # Keep original payload lengths - no padding to 16
            # Only pad to match lengths between samples for comparison
            max_len = max(len(sample_before), len(sample_ack), len(sample_status)) or 16
            
            # Calculate byte-level diff (BEFORE vs STATUS for persistence)
            bytes_diff = []
            compare_before = sample_before.ljust(max_len, "0") if sample_before else "0" * max_len
            compare_after = (sample_status or sample_ack or "").ljust(max_len, "0") if (sample_status or sample_ack) else "0" * max_len
            
            for i in range(0, min(len(compare_before), len(compare_after)), 2):
                byte_before = compare_before[i:i+2] if i+2 <= len(compare_before) else "00"
                byte_after = compare_after[i:i+2] if i+2 <= len(compare_after) else "00"
                
                if byte_before != byte_after:
                    try:
                        val_before = int(byte_before, 16)
                        val_after = int(byte_after, 16)
                        xor = val_before ^ val_after
                        changed_bits = [b for b in range(8) if xor & (1 << b)]
                    except ValueError:
                        changed_bits = []
                    
                    bytes_diff.append(ByteDiff(
                        byte_index=i // 2,
                        value_before=byte_before,
                        value_after=byte_after,
                        changed_bits=changed_bits
                    ))
            
            # Classification based on 3-window persistence
            has_before = len(before_data) > 0
            has_ack = len(ack_data) > 0
            has_status = len(status_data) > 0
            
            # Check if ACK differs from BEFORE
            ack_differs = sample_ack and sample_before and sample_ack != sample_before
            # Check if STATUS differs from BEFORE
            status_differs = sample_status and sample_before and sample_status != sample_before
            # Check if ACK same as STATUS (persistent change)
            ack_persists = sample_ack and sample_status and sample_ack == sample_status
            
            # Classification logic based on persistence
            confidence = 0.0
            persistence = "none"
            
            if status_differs and has_status:
                # STATUS: payload different in STATUS window = persistent state change
                classification = "status"
                status_count += 1
                persistence = "persistent"
                confidence = 90.0 if (has_before and len(status_data) > 3) else 70.0
            elif ack_differs and has_ack and not status_differs:
                # ACK: changes in ACK window but not persistent in STATUS
                classification = "ack"
                ack_count += 1
                persistence = "transient"
                confidence = 80.0 if len(ack_data) > 1 else 50.0
            elif not has_before and (has_ack or has_status):
                # New frame appearing after t0
                if has_status:
                    classification = "status"
                    status_count += 1
                    persistence = "persistent"
                    confidence = 60.0
                else:
                    classification = "ack"
                    ack_count += 1
                    persistence = "transient"
                    confidence = 50.0
            elif len(bytes_diff) > 0:
                # Some change detected
                classification = "info"
                info_count += 1
                confidence = 40.0
            else:
                classification = "unchanged"
                unchanged_count += 1
                confidence = 100.0
            
            frames_analysis.append(FrameDiff(
                can_id=can_id,
                count_before=len(before_data),
                count_ack=len(ack_data),
                count_status=len(status_data),
                bytes_diff=bytes_diff,
                classification=classification,
                confidence=confidence,
                sample_before=sample_before or "N/A",
                sample_ack=sample_ack or "N/A",
                sample_status=sample_status or "N/A",
                persistence=persistence
            ))
        
        # Sort by: classification priority, then confidence desc, then number of changes
        priority = {"status": 0, "ack": 1, "info": 2, "unchanged": 3}
        frames_analysis.sort(key=lambda x: (priority.get(x.classification, 4), -x.confidence, -len(x.bytes_diff)))
        
        return FamilyAnalysisResponse(
            family_name=f"ECU 0x{request.family_ids[0]}-0x{request.family_ids[-1]}" if len(request.family_ids) > 1 else f"ID 0x{request.family_ids[0]}",
            frame_ids=request.family_ids,
            frames_analysis=frames_analysis,
            summary={
                "total": len(request.family_ids),
                "status": status_count,
                "ack": ack_count,
                "info": info_count,
                "unchanged": unchanged_count
            },
            t0_timestamp=t0
        )
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] family-diff failed: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erreur interne: {str(e)}")


# DBC Signal storage
class DBCSignal(BaseModel):
    id: str = ""
    can_id: str
    name: str
    start_bit: int
    length: int
    byte_order: str = "little_endian"  # or big_endian
    is_signed: bool = False
    scale: float = 1.0
    offset: float = 0.0
    min_val: float = 0.0
    max_val: float = 0.0
    unit: str = ""
    comment: str = ""
    # Sample payload data for replay
    sample_before: str = ""   # Full payload AVANT t0
    sample_ack: str = ""      # Full payload ACK
    sample_status: str = ""   # Full payload STATUS

class DBCMessage(BaseModel):
    can_id: str
    name: str
    dlc: int = 8
    signals: list[DBCSignal] = []
    comment: str = ""

class MissionDBC(BaseModel):
    mission_id: str
    messages: list[DBCMessage] = []
    created_at: str = ""
    updated_at: str = ""

@app.get("/api/missions/{mission_id}/dbc")
async def get_mission_dbc(mission_id: str) -> MissionDBC:
    """Get DBC data for a mission"""
    dbc_file = Path(MISSIONS_DIR) / mission_id / "dbc.json"
    
    if not dbc_file.exists():
        return MissionDBC(mission_id=mission_id, messages=[], created_at="", updated_at="")
    
    with open(dbc_file, "r") as f:
        data = json.load(f)
    
    # Normalize signal fields from DBC import format to internal format
    for msg in data.get("messages", []):
        for sig in msg.get("signals", []):
            # bit_length -> length
            if "bit_length" in sig and "length" not in sig:
                sig["length"] = sig.pop("bit_length")
            # factor -> scale
            if "factor" in sig and "scale" not in sig:
                sig["scale"] = sig.pop("factor")
            # min -> min_val
            if "min" in sig and "min_val" not in sig:
                sig["min_val"] = sig.pop("min")
            # max -> max_val
            if "max" in sig and "max_val" not in sig:
                sig["max_val"] = sig.pop("max")
            # Normalize byte_order
            bo = sig.get("byte_order", "little_endian")
            if bo in ("little", "1"):
                sig["byte_order"] = "little_endian"
            elif bo in ("big", "0"):
                sig["byte_order"] = "big_endian"
            # Ensure can_id exists on signal
            if "can_id" not in sig:
                sig["can_id"] = msg.get("can_id", "")
            # Remove extra fields not in model
            for key in list(sig.keys()):
                if key not in ("id", "can_id", "name", "start_bit", "length",
                               "byte_order", "is_signed", "scale", "offset",
                               "min_val", "max_val", "unit", "comment",
                               "sample_before", "sample_ack", "sample_status"):
                    del sig[key]
    
    return MissionDBC(**data)

@app.post("/api/missions/{mission_id}/dbc/import")
async def import_dbc_file_endpoint(mission_id: str, file: UploadFile = File(...)):
  """Import an official .dbc file (Vector format) into mission DBC."""
  try:
    if not file.filename.endswith('.dbc'):
      raise HTTPException(status_code=400, detail="File must be a .dbc file")

    content = await file.read()
    dbc_content = content.decode('utf-8', errors='ignore')

    log_info(f"Importing DBC file: {file.filename} for mission {mission_id}")
    parsed = parse_dbc_file(dbc_content)

    dbc_file = Path(MISSIONS_DIR) / mission_id / "dbc.json"
    if dbc_file.exists():
      with open(dbc_file, 'r') as f:
        existing_dbc = json.load(f)
    else:
      existing_dbc = {
        "mission_id": mission_id,
        "messages": [],
        "created_at": datetime.now().isoformat(),
        "updated_at": ""
      }

    imported_count = 0
    for msg in parsed['messages']:
      existing_msg = next((m for m in existing_dbc['messages'] if m['can_id'] == msg['id']), None)
      if not existing_msg:
        existing_msg = {
          "can_id": msg['id'],
          "name": msg['name'],
          "dlc": msg['dlc'],
          "sender": msg.get('sender', ''),
          "comment": msg.get('comment', ''),
          "signals": []
        }
        existing_dbc['messages'].append(existing_msg)

      for sig in msg['signals']:
        # Map DBC parser fields to DBCSignal model fields
        byte_order_raw = sig.get('byte_order', 'little_endian')
        if byte_order_raw in ('little', 'little_endian', '1'):
          byte_order_val = 'little_endian'
        else:
          byte_order_val = 'big_endian'

        signal_dict = {
          "id": f"{msg['id']}_{sig['name']}",
          "can_id": msg['id'],
          "name": sig['name'],
          "start_bit": sig['start_bit'],
          "length": sig['bit_length'],
          "byte_order": byte_order_val,
          "is_signed": sig.get('value_type') == 'signed',
          "scale": sig.get('factor', 1),
          "offset": sig.get('offset', 0),
          "min_val": sig.get('min', 0),
          "max_val": sig.get('max', 0),
          "unit": sig.get('unit', ''),
          "comment": sig.get('comment', ''),
        }
        existing_idx = next((i for i, s in enumerate(existing_msg['signals'])
                           if s.get('name') == sig['name']), None)
        if existing_idx is not None:
          existing_msg['signals'][existing_idx] = signal_dict
        else:
          existing_msg['signals'].append(signal_dict)
        imported_count += 1

    existing_dbc['updated_at'] = datetime.now().isoformat()
    dbc_file.parent.mkdir(parents=True, exist_ok=True)
    with open(dbc_file, 'w') as f:
      json.dump(existing_dbc, f, indent=2)

    log_info(f"Imported {imported_count} signals from {file.filename}")
    return {
      "status": "success",
      "imported_signals": imported_count,
      "total_messages": len(parsed['messages']),
      "filename": file.filename
    }
  except HTTPException:
    raise
  except Exception as e:
    log_error(f"DBC import failed: {str(e)}", e)
    raise HTTPException(status_code=500, detail=f"Failed to import DBC: {str(e)}")


@app.post("/api/missions/{mission_id}/dbc/signal")
async def add_dbc_signal(mission_id: str, signal: DBCSignal):
  """Add or update a signal in the mission DBC"""
  mission_dir = Path(MISSIONS_DIR) / mission_id
  dbc_file = mission_dir / "dbc.json"
  
  if not mission_dir.exists():
    raise HTTPException(status_code=404, detail="Mission non trouvee")
  
  # Load existing or create new
  if dbc_file.exists():
    with open(dbc_file, "r") as f:
      data = json.load(f)
  else:
    data = {
      "mission_id": mission_id,
      "messages": [],
      "created_at": datetime.now().isoformat(),
      "updated_at": ""
    }
  
  # Find or create message for this CAN ID
  message = None
  for msg in data["messages"]:
    if msg["can_id"] == signal.can_id:
      message = msg
      break
    
    if not message:
        message = {
            "can_id": signal.can_id,
            "name": f"MSG_{signal.can_id}",
            "dlc": 8,
            "signals": [],
            "comment": ""
        }
        data["messages"].append(message)
    
    # Generate unique ID if not provided
    if not signal.id:
        unique_suffix = datetime.now().strftime("%H%M%S") + str(int(time.time() * 1000) % 1000)
        signal.id = f"{signal.can_id}_{signal.name}_{unique_suffix}"
    
    # Match par ID exact uniquement (permet d'avoir plusieurs signaux sur le meme octet)
    signal_dict = signal.model_dump()
    existing_idx = None
    for idx, s in enumerate(message["signals"]):
        if s.get("id") and s["id"] == signal.id:
            existing_idx = idx
            break
    
    if existing_idx is not None:
        message["signals"][existing_idx] = signal_dict
    else:
        message["signals"].append(signal_dict)
    
    data["updated_at"] = datetime.now().isoformat()
    
    with open(dbc_file, "w") as f:
        json.dump(data, f, indent=2)
    
    return {"status": "ok", "signal_id": signal.id}

@app.delete("/api/missions/{mission_id}/dbc/signal/{signal_id}")
async def delete_dbc_signal(mission_id: str, signal_id: str):
    """Delete a signal from the mission DBC"""
    dbc_file = Path(MISSIONS_DIR) / mission_id / "dbc.json"
    
    if not dbc_file.exists():
        raise HTTPException(status_code=404, detail="DBC non trouve")
    
    with open(dbc_file, "r") as f:
        data = json.load(f)
    
    # Find and remove signal
    for msg in data["messages"]:
        msg["signals"] = [s for s in msg["signals"] if s.get("id") != signal_id]
    
    # Remove empty messages
    data["messages"] = [m for m in data["messages"] if m["signals"]]
    data["updated_at"] = datetime.now().isoformat()
    
    with open(dbc_file, "w") as f:
        json.dump(data, f, indent=2)
    
    return {"status": "ok"}

@app.delete("/api/missions/{mission_id}/dbc/message/{can_id}")
async def delete_dbc_message(mission_id: str, can_id: str):
  """Delete an entire message (all its signals) from the mission DBC"""
  dbc_file = Path(MISSIONS_DIR) / mission_id / "dbc.json"
  
  if not dbc_file.exists():
    raise HTTPException(status_code=404, detail="DBC non trouve")
  
  with open(dbc_file, "r") as f:
    data = json.load(f)
  
  original_count = len(data["messages"])
  data["messages"] = [m for m in data["messages"] if m.get("can_id") != can_id]
  removed = original_count - len(data["messages"])
  
  data["updated_at"] = datetime.now().isoformat()
  
  with open(dbc_file, "w") as f:
    json.dump(data, f, indent=2)
  
  return {"status": "ok", "removed_messages": removed}


@app.delete("/api/missions/{mission_id}/dbc")
async def clear_mission_dbc(mission_id: str):
  """Delete all signals and messages from the mission DBC"""
  dbc_file = Path(MISSIONS_DIR) / mission_id / "dbc.json"
  
  if not dbc_file.exists():
    raise HTTPException(status_code=404, detail="DBC non trouve")
  
  data = {
    "mission_id": mission_id,
    "messages": [],
    "created_at": datetime.now().isoformat(),
    "updated_at": datetime.now().isoformat()
  }
  
  with open(dbc_file, "w") as f:
    json.dump(data, f, indent=2)
  
  return {"status": "ok", "message": "All signals cleared"}


@app.get("/api/missions/{mission_id}/dbc/export")
async def export_dbc(mission_id: str):
    """Export mission DBC to .dbc file format"""
    dbc_file = Path(MISSIONS_DIR) / mission_id / "dbc.json"
    
    if not dbc_file.exists():
        raise HTTPException(status_code=404, detail="DBC non trouve")
    
    with open(dbc_file, "r") as f:
        data = json.load(f)
    
    # Generate DBC content
    lines = []
    lines.append('VERSION ""')
    lines.append("")
    lines.append("NS_ :")
    lines.append("")
    lines.append("BS_:")
    lines.append("")
    lines.append("BU_:")
    lines.append("")
    
    # Messages and signals
    for msg in data.get("messages", []):
        can_id = int(msg["can_id"], 16)
        dlc = msg.get("dlc", 8)
        name = msg.get("name", f"MSG_{msg['can_id']}").replace(" ", "_")
        
        lines.append(f"BO_ {can_id} {name}: {dlc} Vector__XXX")
        
        for sig in msg.get("signals", []):
            sig_name = sig["name"].replace(" ", "_")
            start_bit = sig["start_bit"]
            length = sig["length"]
            byte_order = 1 if sig.get("byte_order") == "little_endian" else 0
            sign = "-" if sig.get("is_signed") else "+"
            scale = sig.get("scale", 1.0)
            offset = sig.get("offset", 0.0)
            min_val = sig.get("min_val", 0.0)
            max_val = sig.get("max_val", 0.0)
            unit = sig.get("unit", "")
            
            lines.append(f' SG_ {sig_name} : {start_bit}|{length}@{byte_order}{sign} ({scale},{offset}) [{min_val}|{max_val}] "{unit}" Vector__XXX')
        
        lines.append("")
    
    # Comments
    lines.append("")
    for msg in data.get("messages", []):
        if msg.get("comment"):
            can_id = int(msg["can_id"], 16)
            lines.append(f'CM_ BO_ {can_id} "{msg["comment"]}";')
        for sig in msg.get("signals", []):
            if sig.get("comment"):
                can_id = int(msg["can_id"], 16)
                lines.append(f'CM_ SG_ {can_id} {sig["name"]} "{sig["comment"]}";')
    
    dbc_content = "\n".join(lines)
    
    return Response(
        content=dbc_content,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="mission_{mission_id}.dbc"'
        }
    )


@app.get("/api/missions/{mission_id}/dbc/active")
async def get_active_dbc_ids(mission_id: str):
    """
    Get lightweight list of known CAN IDs from DBC for sniffer overlay.
    Returns message IDs and names for quick lookup, without full signal details.
    """
    dbc_file = Path(MISSIONS_DIR) / mission_id / "dbc.json"
    
    if not dbc_file.exists():
        return {"mission_id": mission_id, "known_ids": [], "total_signals": 0}
    
    with open(dbc_file, "r") as f:
        data = json.load(f)
    
    known_ids = []
    total_signals = 0
    for msg in data.get("messages", []):
        sig_count = len(msg.get("signals", []))
        total_signals += sig_count
        known_ids.append({
            "can_id": msg["can_id"],
            "name": msg.get("name", f"MSG_{msg['can_id']}"),
            "dlc": msg.get("dlc", 8),
            "signal_count": sig_count,
        })
    
    return {
        "mission_id": mission_id,
        "known_ids": known_ids,
        "total_signals": total_signals,
    }


# =============================================================================
# LOG COMPARISON - Compare two logs to find differential frames
# =============================================================================

class CompareLogsRequest(BaseModel):
    mission_id: str
    log_a_id: str  # e.g. "ouverture" log
    log_b_id: str  # e.g. "fermeture" log

class CompareFrameDiff(BaseModel):
    can_id: str
    payload_a: str  # Most common payload in log A
    payload_b: str  # Most common payload in log B
    count_a: int    # Number of frames in log A
    count_b: int    # Number of frames in log B
    bytes_changed: list[int]  # Indices of bytes that changed
    classification: str  # "differential", "only_a", "only_b", "identical"
    confidence: float
    # New: stability & variance metrics for smarter reverse engineering
    unique_payloads_a: int = 0   # How many distinct payloads in log A
    unique_payloads_b: int = 0   # How many distinct payloads in log B
    stability_score: float = 0.0  # 0-100: higher = more stable (fewer variations, better for reverse)
    dominant_ratio_a: float = 0.0 # % of frames matching the most common payload in A
    dominant_ratio_b: float = 0.0 # % of frames matching the most common payload in B
    byte_change_detail: list[dict] = []  # Per changed byte: {index, val_a, val_b, hex_diff}
    # Commande probable: rare/exclusif scoring
    command_score: float = 0.0             # 0-100: higher = more likely a command frame
    rare_payloads_a: list[dict] = []       # [{payload, count, ts_preview}]
    rare_payloads_b: list[dict] = []
    exclusive_rare_a: list[dict] = []      # [{payload, count, ts_preview}]
    exclusive_rare_b: list[dict] = []

class CompareLogsResponse(BaseModel):
    log_a_name: str
    log_b_name: str
    total_ids_a: int
    total_ids_b: int
    differential_count: int  # IDs with different payloads
    only_a_count: int        # IDs only in log A
    only_b_count: int        # IDs only in log B
    identical_count: int     # IDs with same payload in both
    frames: list[CompareFrameDiff]

@app.post("/api/missions/{mission_id}/compare-logs", response_model=CompareLogsResponse)
async def compare_logs(mission_id: str, request: CompareLogsRequest):
    """Compare two logs to identify differential frames between states (e.g., open vs closed)"""
    from collections import Counter, defaultdict
    
    mission_dir = Path(MISSIONS_DIR) / sanitize_id(mission_id)
    if not mission_dir.exists():
        raise HTTPException(status_code=404, detail="Mission non trouvee")
    
    log_a_file = mission_dir / "logs" / f"{sanitize_id(request.log_a_id)}.log"
    log_b_file = mission_dir / "logs" / f"{sanitize_id(request.log_b_id)}.log"
    
    if not log_a_file.exists():
        raise HTTPException(status_code=404, detail=f"Log A non trouve: {request.log_a_id}")
    if not log_b_file.exists():
        raise HTTPException(status_code=404, detail=f"Log B non trouve: {request.log_b_id}")
    
    def parse_log(log_file: Path) -> tuple[dict[str, list[str]], dict[str, dict[str, list[float]]]]:
        """Parse log and return:
        - dict of can_id -> list of payloads
        - dict of can_id -> { payload -> [timestamps] }
        """
        frames = defaultdict(list)
        payload_timestamps = defaultdict(lambda: defaultdict(list))
        with open(log_file, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                match = re.match(r"\((\d+\.\d+)\)\s+\w+\s+([0-9A-Fa-f]+)#([0-9A-Fa-f]*)", line)
                if match:
                    ts = float(match.group(1))
                    can_id = match.group(2).upper()
                    data = match.group(3).upper()
                    frames[can_id].append(data)
                    payload_timestamps[can_id][data].append(ts)
        return dict(frames), dict(payload_timestamps)
    
    def get_most_common(data_list: list[str]) -> str:
        if not data_list:
            return ""
        return Counter(data_list).most_common(1)[0][0]
    
    def analyze_byte_stability(payloads: list[str]) -> list[dict]:
        """
        Analyze each byte position across all payloads.
        Returns per-byte: unique values, most common value, stability ratio.
        
        A byte is 'stable' if it has the same value in >80% of payloads.
        A byte is 'variable' (counter/timestamp) if it has many unique values.
        """
        if not payloads:
            return []
        
        # Normalize payload length
        max_bytes = max(len(p) // 2 for p in payloads) if payloads else 0
        result = []
        
        for byte_idx in range(max_bytes):
            values = []
            for p in payloads:
                start = byte_idx * 2
                if start + 2 <= len(p):
                    values.append(p[start:start+2])
                else:
                    values.append("00")
            
            counter = Counter(values)
            most_common_val = counter.most_common(1)[0][0]
            most_common_count = counter.most_common(1)[0][1]
            unique_count = len(counter)
            stability = round(most_common_count / len(values) * 100, 1) if values else 0
            
            result.append({
                "index": byte_idx,
                "most_common": most_common_val,
                "unique_count": unique_count,
                "stability": stability,
                "is_stable": stability >= 70,  # >70% = stable byte
                "is_counter": unique_count > len(values) * 0.3,  # Many unique = counter
            })
        
        return result
    
    def build_representative_payload(byte_analysis: list[dict]) -> str:
        """Build a representative payload from per-byte analysis."""
        return "".join(b["most_common"] for b in byte_analysis)
    
    # Parse both logs (with timestamps)
    frames_a, ts_map_a = parse_log(log_a_file)
    frames_b, ts_map_b = parse_log(log_b_file)
    
    # Get all unique CAN IDs
    all_ids = set(frames_a.keys()) | set(frames_b.keys())
    
    # Compare each ID
    results = []
    differential_count = 0
    only_a_count = 0
    only_b_count = 0
    identical_count = 0
    
    for can_id in sorted(all_ids):
        payloads_a = frames_a.get(can_id, [])
        payloads_b = frames_b.get(can_id, [])
        
        # Per-byte stability analysis (key improvement)
        bytes_analysis_a = analyze_byte_stability(payloads_a)
        bytes_analysis_b = analyze_byte_stability(payloads_b)
        
        # Build representative payloads from most common byte values
        payload_a = build_representative_payload(bytes_analysis_a) if bytes_analysis_a else ""
        payload_b = build_representative_payload(bytes_analysis_b) if bytes_analysis_b else ""
        
        # Count unique payloads in each log
        unique_a = len(set(payloads_a)) if payloads_a else 0
        unique_b = len(set(payloads_b)) if payloads_b else 0
        
        # Dominant ratio: how much the most common payload dominates
        dominant_a = 0.0
        dominant_b = 0.0
        if payloads_a:
            counter_a = Counter(payloads_a)
            dominant_a = round(counter_a.most_common(1)[0][1] / len(payloads_a) * 100, 1)
        if payloads_b:
            counter_b = Counter(payloads_b)
            dominant_b = round(counter_b.most_common(1)[0][1] / len(payloads_b) * 100, 1)
        
        # ============================================================
        # SMART CLASSIFICATION
        # Compare per-byte using two approaches:
        # 1. Stable bytes: flag if stable in both but different
        # 2. Variable bytes: compare MEDIAN values - if distributions
        #    are significantly separated, flag as differential
        # This catches sensor values that shift range between states.
        # ============================================================
        if not payloads_a:
            classification = "only_b"
            only_b_count += 1
            confidence = 80.0
        elif not payloads_b:
            classification = "only_a"
            only_a_count += 1
            confidence = 80.0
        else:
            max_bytes = max(len(bytes_analysis_a), len(bytes_analysis_b))
            stable_diff_count = 0
            variable_diff_count = 0
            any_stable_diff = False
            any_variable_diff = False
            
            for i in range(max_bytes):
                ba = bytes_analysis_a[i] if i < len(bytes_analysis_a) else None
                bb = bytes_analysis_b[i] if i < len(bytes_analysis_b) else None
                
                if ba and bb:
                    both_stable = ba["is_stable"] and bb["is_stable"]
                    values_differ = ba["most_common"] != bb["most_common"]
                    is_counter = ba.get("is_counter", False) or bb.get("is_counter", False)
                    
                    if both_stable and values_differ:
                        # Case 1: Both bytes are stable but have different dominant values
                        stable_diff_count += 1
                        any_stable_diff = True
                    elif not both_stable:
                        # Case 2+3: Byte is not stable in at least one log
                        # Compare the VALUE DISTRIBUTIONS between logs
                        # This catches: toggle bytes (95/55), state bytes, counters, sensors
                        vals_a_hex = []
                        vals_b_hex = []
                        vals_a_int = []
                        vals_b_int = []
                        for p in payloads_a:
                            start = i * 2
                            if start + 2 <= len(p):
                                hv = p[start:start+2]
                                vals_a_hex.append(hv)
                                try:
                                    vals_a_int.append(int(hv, 16))
                                except ValueError:
                                    pass
                        for p in payloads_b:
                            start = i * 2
                            if start + 2 <= len(p):
                                hv = p[start:start+2]
                                vals_b_hex.append(hv)
                                try:
                                    vals_b_int.append(int(hv, 16))
                                except ValueError:
                                    pass
                        
                        if vals_a_int and vals_b_int:
                            # For non-counter bytes (toggle/state with few values):
                            # Compare value distribution directly
                            counter_a = Counter(vals_a_hex)
                            counter_b = Counter(vals_b_hex)
                            
                            # Calculate distribution similarity using frequency comparison
                            all_vals = set(counter_a.keys()) | set(counter_b.keys())
                            total_a = len(vals_a_hex)
                            total_b = len(vals_b_hex)
                            
                            distribution_diff = 0.0
                            for v in all_vals:
                                freq_a = counter_a.get(v, 0) / total_a if total_a else 0
                                freq_b = counter_b.get(v, 0) / total_b if total_b else 0
                                distribution_diff += abs(freq_a - freq_b)
                            
                            # distribution_diff ranges 0-2 (0=identical, 2=completely different)
                            
                            sorted_a = sorted(vals_a_int)
                            sorted_b = sorted(vals_b_int)
                            median_a = sorted_a[len(sorted_a) // 2]
                            median_b = sorted_b[len(sorted_b) // 2]
                            median_diff = abs(median_a - median_b)
                            
                            # Check range overlap
                            min_a, max_a = min(vals_a_int), max(vals_a_int)
                            min_b, max_b = min(vals_b_int), max(vals_b_int)
                            overlap_start = max(min_a, min_b)
                            overlap_end = min(max_a, max_b)
                            range_a = max_a - min_a + 1
                            range_b = max_b - min_b + 1
                            overlap = max(0, overlap_end - overlap_start + 1)
                            max_range = max(range_a, range_b, 1)
                            overlap_ratio = overlap / max_range
                            
                            # Flag as differential if ANY of these conditions:
                            # - Distribution significantly different (>0.5 on 0-2 scale)
                            # - Medians differ by >15 (sensor shift)
                            # - Ranges barely overlap (<30%) with some median diff
                            # - Most common value is different AND byte has few unique vals (toggle)
                            is_toggle = (ba["unique_count"] <= 5 and bb["unique_count"] <= 5)
                            most_common_differs = ba["most_common"] != bb["most_common"]
                            
                            if (distribution_diff > 0.5
                                or median_diff > 15
                                or (overlap_ratio < 0.3 and median_diff > 5)
                                or (is_toggle and most_common_differs and distribution_diff > 0.3)):
                                variable_diff_count += 1
                                any_variable_diff = True
            
            if any_stable_diff or any_variable_diff:
                classification = "differential"
                differential_count += 1
                total_diffs = stable_diff_count + variable_diff_count
                confidence = min(95.0, 60.0 + total_diffs * 8 + min(len(payloads_a), len(payloads_b)) * 0.5)
                if any_variable_diff and not any_stable_diff:
                    # Lower confidence for variable-only diffs
                    confidence = min(85.0, confidence)
            elif payload_a == payload_b:
                classification = "identical"
                identical_count += 1
                confidence = 95.0
            else:
                # Payloads differ but only on counter/variable bytes with overlapping ranges
                classification = "identical"
                identical_count += 1
                confidence = 70.0
        
        # Find changed bytes with detail
        # Flag stable bytes that differ AND variable bytes with distribution shift
        bytes_changed = []
        byte_change_detail = []
        if payload_a and payload_b:
            max_len = max(len(payload_a), len(payload_b))
            pa = payload_a.ljust(max_len, "0")
            pb = payload_b.ljust(max_len, "0")
            for i in range(0, max_len, 2):
                byte_a = pa[i:i+2]
                byte_b = pb[i:i+2]
                byte_idx = i // 2
                
                # Check if this byte is a counter/variable
                ba = bytes_analysis_a[byte_idx] if byte_idx < len(bytes_analysis_a) else None
                bb = bytes_analysis_b[byte_idx] if byte_idx < len(bytes_analysis_b) else None
                is_counter = False
                if ba and bb:
                    is_counter = ba.get("is_counter", False) or bb.get("is_counter", False)
                
                # For unstable bytes, check if distributions are significantly different
                is_significant_diff = False
                both_stable_here = False
                if ba and bb:
                    both_stable_here = ba["is_stable"] and bb["is_stable"]
                
                if not both_stable_here and ba and bb:
                    vals_a_hex = []
                    vals_b_hex = []
                    vals_a_int = []
                    vals_b_int = []
                    for p in payloads_a:
                        start = byte_idx * 2
                        if start + 2 <= len(p):
                            hv = p[start:start+2]
                            vals_a_hex.append(hv)
                            try:
                                vals_a_int.append(int(hv, 16))
                            except ValueError:
                                pass
                    for p in payloads_b:
                        start = byte_idx * 2
                        if start + 2 <= len(p):
                            hv = p[start:start+2]
                            vals_b_hex.append(hv)
                            try:
                                vals_b_int.append(int(hv, 16))
                            except ValueError:
                                pass
                    if vals_a_int and vals_b_int:
                        counter_va = Counter(vals_a_hex)
                        counter_vb = Counter(vals_b_hex)
                        total_a = len(vals_a_hex)
                        total_b = len(vals_b_hex)
                        all_vals = set(counter_va.keys()) | set(counter_vb.keys())
                        distribution_diff = 0.0
                        for v in all_vals:
                            freq_a = counter_va.get(v, 0) / total_a if total_a else 0
                            freq_b = counter_vb.get(v, 0) / total_b if total_b else 0
                            distribution_diff += abs(freq_a - freq_b)
                        
                        median_a = sorted(vals_a_int)[len(vals_a_int) // 2]
                        median_b = sorted(vals_b_int)[len(vals_b_int) // 2]
                        median_diff = abs(median_a - median_b)
                        min_a, max_a = min(vals_a_int), max(vals_a_int)
                        min_b, max_b = min(vals_b_int), max(vals_b_int)
                        overlap_start = max(min_a, min_b)
                        overlap_end = min(max_a, max_b)
                        overlap = max(0, overlap_end - overlap_start + 1)
                        max_range = max(max_a - min_a + 1, max_b - min_b + 1, 1)
                        overlap_ratio = overlap / max_range
                        
                        is_toggle = (ba["unique_count"] <= 5 and bb["unique_count"] <= 5)
                        most_common_differs = ba["most_common"] != bb["most_common"]
                        
                        if (distribution_diff > 0.5
                            or median_diff > 15
                            or (overlap_ratio < 0.3 and median_diff > 5)
                            or (is_toggle and most_common_differs and distribution_diff > 0.3)):
                            is_significant_diff = True
                
                # Include byte as changed if:
                # - It's a stable byte that differs
                # - Or it's an unstable byte with significant distribution change
                if byte_a != byte_b and (both_stable_here or is_significant_diff):
                    bytes_changed.append(byte_idx)
                    try:
                        val_a = int(byte_a, 16)
                        val_b = int(byte_b, 16)
                        byte_change_detail.append({
                            "index": byte_idx,
                            "val_a": byte_a,
                            "val_b": byte_b,
                            "hex_diff": f"{abs(val_a - val_b):02X}",
                            "decimal_diff": abs(val_a - val_b),
                        })
                    except ValueError:
                        byte_change_detail.append({
                            "index": byte_idx,
                            "val_a": byte_a,
                            "val_b": byte_b,
                            "hex_diff": "??",
                            "decimal_diff": 0,
                        })
        
        # ============================================================
        # STABILITY SCORE (0-100)
        # Higher = better candidate for reverse engineering
        #
        # Uses per-byte analysis: a perfect candidate has
        #   - Stable bytes that differ cleanly between A and B
        #   - Few bytes changed (targeted signal)
        #   - High sample count for confidence
        # ============================================================
        stability = 0.0
        
        if classification == "differential":
            # 1. Byte-level stability (40 pts max)
            #    Average stability of the CHANGED bytes
            if bytes_changed:
                changed_stabilities = []
                for bi in bytes_changed:
                    sa = bytes_analysis_a[bi]["stability"] if bi < len(bytes_analysis_a) else 0
                    sb = bytes_analysis_b[bi]["stability"] if bi < len(bytes_analysis_b) else 0
                    changed_stabilities.append((sa + sb) / 2)
                avg_stability = sum(changed_stabilities) / len(changed_stabilities)
                stability += min(40.0, avg_stability * 0.4)
            
            # 2. Targeted change (30 pts max)
            #    Fewer stable bytes changed = more precise signal
            n_bytes_changed = len(bytes_changed)
            if n_bytes_changed == 1:
                stability += 30.0  # Perfect: single byte toggle
            elif n_bytes_changed == 2:
                stability += 22.0
            elif n_bytes_changed <= 4:
                stability += 12.0
            elif n_bytes_changed <= 6:
                stability += 5.0
            
            # 3. Sample count (20 pts max)
            min_count = min(len(payloads_a), len(payloads_b))
            if min_count >= 50:
                stability += 20.0
            elif min_count >= 20:
                stability += 14.0
            elif min_count >= 10:
                stability += 8.0
            elif min_count >= 5:
                stability += 4.0
            
            # 4. Clean separation bonus (10 pts max)
            #    If changed bytes have no overlap in values between A and B
            if bytes_changed and len(payloads_a) >= 3 and len(payloads_b) >= 3:
                clean_separation = True
                for bi in bytes_changed:
                    vals_a = set()
                    vals_b = set()
                    for p in payloads_a:
                        start = bi * 2
                        if start + 2 <= len(p):
                            vals_a.add(p[start:start+2])
                    for p in payloads_b:
                        start = bi * 2
                        if start + 2 <= len(p):
                            vals_b.add(p[start:start+2])
                    if vals_a & vals_b:  # Overlap
                        clean_separation = False
                        break
                if clean_separation:
                    stability += 10.0
            
            stability = min(100.0, round(stability, 1))
        
        elif classification in ("only_a", "only_b"):
            # Frames only in one log: could be interesting if very stable
            payloads = payloads_a if classification == "only_a" else payloads_b
            dominant = dominant_a if classification == "only_a" else dominant_b
            unique = unique_a if classification == "only_a" else unique_b
            
            if unique <= 1:
                stability = 70.0
            elif unique <= 3:
                stability = 50.0
            else:
                stability = max(10.0, dominant * 0.3)
            stability = round(stability, 1)
        
        # ============================================================
        # COMMANDE PROBABLE: rare/exclusif analysis
        # Payloads rares = count <= rareThreshold (default 1)
        # Exclusifs = rares dans A absents de B (et vice versa)
        # ============================================================
        rare_threshold = 1  # configurable via frontend later
        
        payload_counts_a = Counter(payloads_a) if payloads_a else Counter()
        payload_counts_b = Counter(payloads_b) if payloads_b else Counter()
        ts_a = ts_map_a.get(can_id, {})
        ts_b = ts_map_b.get(can_id, {})
        
        def make_rare_list(payload_counter, ts_map_for_id, threshold):
            rares = []
            for payload, count in payload_counter.items():
                if count <= threshold:
                    timestamps = ts_map_for_id.get(payload, [])
                    rares.append({
                        "payload": payload,
                        "count": count,
                        "ts_preview": [round(t, 4) for t in timestamps[:3]]
                    })
            return rares
        
        rare_a = make_rare_list(payload_counts_a, ts_a, rare_threshold)
        rare_b = make_rare_list(payload_counts_b, ts_b, rare_threshold)
        
        rare_a_payloads = {r["payload"] for r in rare_a}
        rare_b_payloads = {r["payload"] for r in rare_b}
        
        exclusive_a = [r for r in rare_a if r["payload"] not in payload_counts_b]
        exclusive_b = [r for r in rare_b if r["payload"] not in payload_counts_a]
        
        # Command score calculation (0-100)
        cmd_score = 0.0
        
        # Boost principal: exclusifs presents
        if exclusive_a:
            cmd_score += 45
        if exclusive_b:
            cmd_score += 45
        
        # Rarete: bonus par payload exclusif
        for ep in exclusive_a + exclusive_b:
            if ep["count"] == 1:
                cmd_score += 15
            elif ep["count"] == 2:
                cmd_score += 8
        
        # Concentration temporelle: si tous les timestamps d'un payload exclusif
        # sont concentres en < 0.5s -> boost
        for ep in exclusive_a:
            tsl = ts_a.get(ep["payload"], [])
            if len(tsl) >= 1 and (max(tsl) - min(tsl)) < 0.5:
                cmd_score += 10
        for ep in exclusive_b:
            tsl = ts_b.get(ep["payload"], [])
            if len(tsl) >= 1 and (max(tsl) - min(tsl)) < 0.5:
                cmd_score += 10
        
        # Malus trame d'etat cyclique
        total_frames_both = len(payloads_a) + len(payloads_b)
        if payloads_a:
            top_count_a = payload_counts_a.most_common(1)[0][1]
            top_pct_a = top_count_a / len(payloads_a)
        else:
            top_pct_a = 0
        if payloads_b:
            top_count_b = payload_counts_b.most_common(1)[0][1]
            top_pct_b = top_count_b / len(payloads_b)
        else:
            top_pct_b = 0
        top_pct = max(top_pct_a, top_pct_b)
        
        if total_frames_both > 300 and top_pct > 0.85:
            cmd_score -= 35
        elif total_frames_both > 150 and top_pct > 0.7:
            cmd_score -= 25
        
        cmd_score = min(100.0, max(0.0, cmd_score))
        
        # Only include interesting frames (not identical unless few)
        if classification != "identical" or len(all_ids) < 50:
            results.append(CompareFrameDiff(
                can_id=can_id,
                payload_a=payload_a,
                payload_b=payload_b,
                count_a=len(payloads_a),
                count_b=len(payloads_b),
                bytes_changed=bytes_changed,
                classification=classification,
                confidence=confidence,
                unique_payloads_a=unique_a,
                unique_payloads_b=unique_b,
                stability_score=stability,
                dominant_ratio_a=dominant_a,
                dominant_ratio_b=dominant_b,
                byte_change_detail=byte_change_detail,
                command_score=round(cmd_score, 1),
                rare_payloads_a=rare_a,
                rare_payloads_b=rare_b,
                exclusive_rare_a=exclusive_a,
                exclusive_rare_b=exclusive_b,
            ))
    
    # Sort: differential first, then by stability_score DESC (most stable = best for reverse)
    priority = {"differential": 0, "only_a": 1, "only_b": 2, "identical": 3}
    results.sort(key=lambda x: (priority.get(x.classification, 4), -x.stability_score, -x.confidence))
    
    return CompareLogsResponse(
        log_a_name=request.log_a_id,
        log_b_name=request.log_b_id,
        total_ids_a=len(frames_a),
        total_ids_b=len(frames_b),
        differential_count=differential_count,
        only_a_count=only_a_count,
        only_b_count=only_b_count,
        identical_count=identical_count,
        frames=results
    )


# =============================================================================
# LOG IMPORT - Upload external log files
# =============================================================================

class ImportLogResponse(BaseModel):
    id: str
    filename: str
    frames_count: int
    message: str

@app.post("/api/missions/{mission_id}/import-log", response_model=ImportLogResponse)
async def import_log(mission_id: str, file: UploadFile = File(...)):
    """Import an external log file into a mission"""
    mission_dir = Path(MISSIONS_DIR) / sanitize_id(mission_id)
    if not mission_dir.exists():
        raise HTTPException(status_code=404, detail="Mission non trouvee")
    
    logs_dir = mission_dir / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    
    # Validate file extension
    if not file.filename:
        raise HTTPException(status_code=400, detail="Nom de fichier requis")
    
    if not file.filename.endswith(".log"):
        raise HTTPException(status_code=400, detail="Le fichier doit etre un .log")
    
    # Generate unique filename to avoid conflicts
    base_name = file.filename.replace(".log", "")
    safe_name = re.sub(r'[^a-zA-Z0-9_-]', '_', base_name)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_id = f"imported_{safe_name}_{timestamp}"
    log_filename = f"{log_id}.log"
    log_path = logs_dir / log_filename
    
    # Read and validate content (max 100MB)
    content = await file.read()
    if len(content) > 100 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Fichier trop volumineux (max 100 Mo)")
    try:
        text_content = content.decode("utf-8")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="Le fichier doit etre en UTF-8")
    
    # Count valid CAN frames
    frames_count = 0
    valid_lines = []
    for line in text_content.split("\n"):
        line = line.strip()
        if not line:
            continue
        # Validate CAN log format: (timestamp) interface CANID#DATA
        match = re.match(r"\((\d+\.?\d*)\)\s+\w+\s+([0-9A-Fa-f]+)#([0-9A-Fa-f]*)", line)
        if match:
            frames_count += 1
            valid_lines.append(line)
    
    if frames_count == 0:
        raise HTTPException(status_code=400, detail="Aucune trame CAN valide trouvee dans le fichier")
    
    # Save the file
    with open(log_path, "w") as f:
        f.write("\n".join(valid_lines))
    
    return ImportLogResponse(
        id=log_id,
        filename=log_filename,
        frames_count=frames_count,
        message=f"Log importe avec {frames_count} trames"
    )


# =============================================================================
# SAVED COMPARISONS - CRUD for comparison results
# =============================================================================

class SavedComparisonRequest(BaseModel):
    name: str
    log_a_id: str
    log_a_name: str
    log_b_id: str
    log_b_name: str
    result: dict  # Full CompareLogsResponse as dict

class SavedComparison(BaseModel):
    id: str
    name: str
    log_a_id: str
    log_a_name: str
    log_b_id: str
    log_b_name: str
    created_at: str
    result: dict

def get_comparisons_file(mission_id: str) -> Path:
    return Path(MISSIONS_DIR) / sanitize_id(mission_id) / "comparisons.json"

def load_comparisons(mission_id: str) -> list[dict]:
    f = get_comparisons_file(mission_id)
    if f.exists():
        with open(f, "r") as fh:
            return json.load(fh)
    return []

def save_comparisons(mission_id: str, comparisons: list[dict]):
    f = get_comparisons_file(mission_id)
    with open(f, "w") as fh:
        json.dump(comparisons, fh, indent=2)

@app.get("/api/missions/{mission_id}/comparisons")
async def list_comparisons(mission_id: str):
    """List all saved comparisons for a mission"""
    mission_dir = Path(MISSIONS_DIR) / mission_id
    if not mission_dir.exists():
        raise HTTPException(status_code=404, detail="Mission non trouvee")
    comparisons = load_comparisons(mission_id)
    # Return without full result data for list view
    return [
        {
            "id": c["id"],
            "name": c["name"],
            "log_a_id": c["log_a_id"],
            "log_a_name": c["log_a_name"],
            "log_b_id": c["log_b_id"],
            "log_b_name": c["log_b_name"],
            "created_at": c["created_at"],
            "differential_count": c.get("result", {}).get("differential_count", 0),
            "only_a_count": c.get("result", {}).get("only_a_count", 0),
            "only_b_count": c.get("result", {}).get("only_b_count", 0),
            "identical_count": c.get("result", {}).get("identical_count", 0),
        }
        for c in comparisons
    ]

@app.post("/api/missions/{mission_id}/comparisons")
async def save_comparison(mission_id: str, req: SavedComparisonRequest):
    """Save a comparison result"""
    mission_dir = Path(MISSIONS_DIR) / mission_id
    if not mission_dir.exists():
        raise HTTPException(status_code=404, detail="Mission non trouvee")
    
    comparisons = load_comparisons(mission_id)
    
    comp_id = f"comp_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{len(comparisons)}"
    new_comp = {
        "id": comp_id,
        "name": req.name,
        "log_a_id": req.log_a_id,
        "log_a_name": req.log_a_name,
        "log_b_id": req.log_b_id,
        "log_b_name": req.log_b_name,
        "created_at": datetime.now().isoformat(),
        "result": req.result,
    }
    comparisons.append(new_comp)
    save_comparisons(mission_id, comparisons)
    
    return new_comp

@app.get("/api/missions/{mission_id}/comparisons/{comparison_id}")
async def get_comparison(mission_id: str, comparison_id: str):
    """Get a single saved comparison with full result"""
    comparisons = load_comparisons(mission_id)
    for c in comparisons:
        if c["id"] == comparison_id:
            return c
    raise HTTPException(status_code=404, detail="Comparaison non trouvee")

@app.delete("/api/missions/{mission_id}/comparisons/{comparison_id}")
async def delete_comparison(mission_id: str, comparison_id: str):
    """Delete a saved comparison"""
    comparisons = load_comparisons(mission_id)
    new_comparisons = [c for c in comparisons if c["id"] != comparison_id]
    if len(new_comparisons) == len(comparisons):
        raise HTTPException(status_code=404, detail="Comparaison non trouvee")
    save_comparisons(mission_id, new_comparisons)
    return {"status": "deleted", "id": comparison_id}


# Service management endpoints
@app.post("/api/system/restart-services")
async def restart_services():
    """Restart aurige-web and aurige-api services after update"""
    import subprocess
    try:
        # Create a script that will restart services after a delay
        # This allows the API to respond before being killed
        script = """
#!/bin/bash
sleep 2
systemctl restart aurige-web
# Note: we don't restart aurige-api here as it would kill this script
"""
        script_path = "/tmp/restart_services.sh"
        with open(script_path, "w") as f:
            f.write(script)
        os.chmod(script_path, 0o755)
        
        # Run in background
        subprocess.Popen(["sudo", script_path], 
                        stdout=subprocess.DEVNULL, 
                        stderr=subprocess.DEVNULL,
                        start_new_session=True)
        
        return {"success": True, "message": "Services will restart in 2 seconds"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to restart: {str(e)}")

@app.get("/api/system/check-update")
async def check_update():
    """Check if there's a new version available via git"""
    import subprocess
    try:
        repo_dir = Path("/opt/aurige/repo")
        if not repo_dir.exists():
            return {"has_update": False, "message": "No git repo found"}
        
        # Fetch latest
        subprocess.run(["git", "fetch", "origin"], cwd=repo_dir, capture_output=True)
        
        # Compare with remote
        local = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo_dir, capture_output=True, text=True)
        remote = subprocess.run(["git", "rev-parse", "origin/HEAD"], cwd=repo_dir, capture_output=True, text=True)
        
        local_hash = local.stdout.strip()
        remote_hash = remote.stdout.strip()
        
        return {
            "has_update": local_hash != remote_hash,
            "local_version": local_hash[:8],
            "remote_version": remote_hash[:8] if remote_hash else "unknown"
        }
    except Exception as e:
        return {"has_update": False, "error": str(e)}


# Mission Global Export
@app.get("/api/missions/{mission_id}/export")
async def export_mission(mission_id: str):
    """Export all mission data as a ZIP archive"""
    import zipfile
    import io
    import re
    from datetime import datetime
    
    try:
        mission_dir = MISSIONS_DIR / mission_id
        if not mission_dir.exists():
            raise HTTPException(status_code=404, detail="Mission not found")
        
        # Load mission metadata
        metadata_file = mission_dir / "mission.json"
        mission_name = mission_id
        if metadata_file.exists():
            with open(metadata_file, "r") as f:
                meta = json.load(f)
                mission_name = meta.get("name", mission_id)
        
        # Sanitize mission name for filesystem
        safe_name = re.sub(r'[^\w\-_]', '_', mission_name)
        
        # Create ZIP in memory
        buffer = io.BytesIO()
        
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            # Add mission metadata
            if metadata_file.exists():
                zf.write(metadata_file, f"{safe_name}/mission.json")
            
            # Add all .log files (CAN captures)
            logs_dir = mission_dir / "logs"
            if logs_dir.exists():
                for log_file in logs_dir.glob("*.log"):
                    zf.write(log_file, f"{safe_name}/logs/{log_file.name}")
            
            # Add isolation logs
            isolation_dir = mission_dir / "isolation"
            if isolation_dir.exists():
                for log_file in isolation_dir.rglob("*.log"):
                    rel_path = log_file.relative_to(isolation_dir)
                    zf.write(log_file, f"{safe_name}/isolation/{rel_path}")
            
            # Add DBC file if exists
            dbc_file = mission_dir / "dbc.json"
            if dbc_file.exists():
                zf.write(dbc_file, f"{safe_name}/dbc.json")
                
                # Also generate and include the actual DBC file
                try:
                    with open(dbc_file, "r") as f:
                        dbc_data = json.load(f)
                    
                    # Generate DBC content
                    dbc_lines = [
                        'VERSION ""',
                        '',
                        'NS_ :',
                        '',
                        'BS_:',
                        '',
                        'BU_:',
                        '',
                    ]
                    
                    # Get messages with signals from the dbc.json structure
                    messages = dbc_data.get("messages", [])
                    signals_by_id = {}
                    for msg in messages:
                        can_id = msg.get("can_id", "000")
                        if can_id not in signals_by_id:
                            signals_by_id[can_id] = []
                        signals_by_id[can_id].extend(msg.get("signals", []))
                    
                    # Generate BO_ (message) and SG_ (signal) entries
                    for can_id, sigs in signals_by_id.items():
                        can_id_int = int(can_id, 16)
                        msg_name = f"MSG_{can_id}"
                        dbc_lines.append(f'BO_ {can_id_int} {msg_name}: 8 Vector__XXX')
                        
                        for sig in sigs:
                            name = sig.get("name", f"SIG_{can_id}")
                            start_bit = sig.get("start_bit", 0)
                            length = sig.get("length", 8)
                            byte_order = 1 if sig.get("byte_order") == "little_endian" else 0
                            is_signed = "-" if sig.get("is_signed") else "+"
                            scale = sig.get("scale", 1)
                            offset = sig.get("offset", 0)
                            min_val = sig.get("min_val", 0)
                            max_val = sig.get("max_val", 255)
                            unit = sig.get("unit", "")
                            
                            dbc_lines.append(f' SG_ {name} : {start_bit}|{length}@{byte_order}{is_signed} ({scale},{offset}) [{min_val}|{max_val}] "{unit}" Vector__XXX')
                        
                        dbc_lines.append('')
                    
                    # Add comments
                    dbc_lines.append('')
                    for can_id, sigs in signals_by_id.items():
                        for sig in sigs:
                            comment = sig.get("comment", "")
                            if comment:
                                can_id_int = int(can_id, 16)
                                name = sig.get("name", f"SIG_{can_id}")
                                dbc_lines.append(f'CM_ SG_ {can_id_int} {name} "{comment}";')
                    
                    dbc_content = "\n".join(dbc_lines)
                    zf.writestr(f"{safe_name}/{safe_name}.dbc", dbc_content)
                except Exception as e:
                    print(f"[WARNING] Could not generate DBC: {e}")
            
            # Add comparisons file if exists
            comp_file = mission_dir / "comparisons.json"
            if comp_file.exists():
                zf.write(comp_file, f"{safe_name}/comparisons.json")
            
            # Add a README
            readme = f"""# Mission Export: {mission_name}
Exported: {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}

## Contents:
- mission.json: Mission metadata
- logs/: CAN bus capture files (.log)
- isolation/: Isolated log files from analysis
- dbc.json: DBC signals data (JSON format)
- {safe_name}.dbc: Generated DBC file (standard format)
- comparisons.json: Saved log comparisons

## Usage:
- Import .log files into any CAN analysis tool
- Use the .dbc file with CANalyzer, SavvyCAN, or similar tools
"""
            zf.writestr(f"{safe_name}/README.txt", readme)
        
        buffer.seek(0)
        
        # Generate filename
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"{safe_name}_{timestamp}.zip"
        
        return Response(
            content=buffer.getvalue(),
            media_type="application/zip",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"'
            }
        )
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Export mission failed: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Export failed: {str(e)}")


# =============================================================================
# Signal Finder - OBD/CAN Correlation Engine
# =============================================================================

# PID decode formulas: { pid_hex: (name, unit, decode_fn(A, B)) }
OBD_PID_DECODERS = {
    "05": ("Coolant Temp", "C", lambda a, b: a - 40),
    "0C": ("RPM", "tr/min", lambda a, b: ((a * 256) + b) / 4),
    "0D": ("Speed", "km/h", lambda a, b: a),
    "0F": ("Intake Air Temp", "C", lambda a, b: a - 40),
    "10": ("MAF", "g/s", lambda a, b: ((a * 256) + b) / 100),
    "11": ("Throttle", "%", lambda a, b: (a * 100) / 255),
    "2F": ("Fuel Level", "%", lambda a, b: (a * 100) / 255),
    "04": ("Engine Load", "%", lambda a, b: (a * 100) / 255),
    "06": ("Short Fuel Trim 1", "%", lambda a, b: (a / 1.28) - 100),
    "0A": ("Fuel Pressure", "kPa", lambda a, b: a * 3),
    "0B": ("MAP", "kPa", lambda a, b: a),
    "0E": ("Timing Advance", "deg", lambda a, b: (a / 2) - 64),
    "1F": ("Run Time", "s", lambda a, b: (a * 256) + b),
    "21": ("Dist with MIL", "km", lambda a, b: (a * 256) + b),
    "33": ("Baro Pressure", "kPa", lambda a, b: a),
    "42": ("Control Module V", "V", lambda a, b: ((a * 256) + b) / 1000),
    "46": ("Ambient Temp", "C", lambda a, b: a - 40),
}

# IDs OBD a exclure du trafic broadcast CAN
OBD_FILTER_IDS = {"7DF", "7E0", "7E1", "7E2", "7E3", "7E4", "7E5", "7E6", "7E7",
                   "7E8", "7E9", "7EA", "7EB", "7EC", "7ED", "7EE", "7EF"}


class SignalFinderOBDSample(BaseModel):
    timestamp: float
    value: float

class SignalFinderCorrelationRequest(BaseModel):
    mission_id: Optional[str] = None
    log_path: Optional[str] = None
    obd_samples: List[SignalFinderOBDSample]
    window_ms: int = 50
    target_ids: Optional[List[str]] = None
    pid: Optional[str] = None


def _pearson(x: list, y: list) -> float:
    """Pearson correlation coefficient (pure Python, no numpy)."""
    n = len(x)
    if n < 3:
        return 0.0
    mx = sum(x) / n
    my = sum(y) / n
    sx = sum((xi - mx) ** 2 for xi in x)
    sy = sum((yi - my) ** 2 for yi in y)
    if sx == 0 or sy == 0:
        return 0.0
    sxy = sum((xi - mx) * (yi - my) for xi, yi in zip(x, y))
    return sxy / (sx * sy) ** 0.5


def _rank(data: list) -> list:
    """Compute ranks for Spearman correlation."""
    indexed = sorted(enumerate(data), key=lambda t: t[1])
    ranks = [0.0] * len(data)
    i = 0
    while i < len(indexed):
        j = i
        while j < len(indexed) - 1 and indexed[j + 1][1] == indexed[j][1]:
            j += 1
        avg_rank = (i + j) / 2.0 + 1
        for k in range(i, j + 1):
            ranks[indexed[k][0]] = avg_rank
        i = j + 1
    return ranks


def _spearman(x: list, y: list) -> float:
    """Spearman rank correlation coefficient."""
    if len(x) < 3:
        return 0.0
    rx = _rank(x)
    ry = _rank(y)
    return _pearson(rx, ry)


def _linear_fit(x: list, y: list) -> tuple:
    """Simple linear regression: returns (scale, offset)."""
    n = len(x)
    if n < 2:
        return (1.0, 0.0)
    mx = sum(x) / n
    my = sum(y) / n
    sx2 = sum((xi - mx) ** 2 for xi in x)
    if sx2 == 0:
        return (1.0, my - mx)
    sxy = sum((xi - mx) * (yi - my) for xi, yi in zip(x, y))
    scale = sxy / sx2
    offset = my - scale * mx
    return (round(scale, 6), round(offset, 4))


def _parse_log_for_correlation(log_file_path: str) -> dict:
    """
    Parse a candump log file and extract per-ID, per-byte time series.
    Returns: { can_id: [ { timestamp, bytes: [b0, b1, ...] }, ... ] }
    """
    result = {}
    with open(log_file_path, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            match = re.match(r"\((\d+\.\d+)\)\s+\w+\s+([0-9A-Fa-f]+)#([0-9A-Fa-f]*)", line)
            if not match:
                continue
            ts = float(match.group(1))
            can_id = match.group(2).upper()
            data_hex = match.group(3).upper()
            if can_id in OBD_FILTER_IDS:
                continue
            byte_values = []
            for i in range(0, len(data_hex), 2):
                if i + 2 <= len(data_hex):
                    byte_values.append(int(data_hex[i:i+2], 16))
            if not byte_values:
                continue
            if can_id not in result:
                result[can_id] = []
            result[can_id].append({"timestamp": ts, "bytes": byte_values})
    return result


def _correlate_obd_with_can(
    can_data: dict,
    obd_samples: list,
    window_ms: int = 50,
    target_ids: list = None,
) -> list:
    """
    Core correlation algorithm.
    For each (can_id, byte_model) candidate, align CAN values with OBD timestamps,
    compute Pearson/Spearman, fit linear regression.
    Returns list of candidates sorted by confidence.
    """
    window_s = window_ms / 1000.0
    obd_ts = [s["timestamp"] for s in obd_samples]
    obd_vals = [s["value"] for s in obd_samples]
    
    if len(obd_samples) < 3:
        return []
    
    ids_to_test = target_ids if target_ids else list(can_data.keys())
    
    candidates = []
    
    for can_id in ids_to_test:
        if can_id not in can_data:
            continue
        frames = can_data[can_id]
        if len(frames) < 5:
            continue
        
        can_timestamps = [f["timestamp"] for f in frames]
        dlc = max(len(f["bytes"]) for f in frames)
        
        # Test models for each byte position
        models_to_test = []
        for byte_i in range(dlc):
            models_to_test.append(("single_byte", byte_i, byte_i))
        for byte_i in range(dlc - 1):
            models_to_test.append(("two_byte_be", byte_i, byte_i + 1))
            models_to_test.append(("two_byte_le", byte_i, byte_i + 1))
        
        for model_type, bi, bj in models_to_test:
            aligned_obd = []
            aligned_can = []
            aligned_ts = []
            
            for idx, ots in enumerate(obd_ts):
                # Find closest CAN frame within window
                best_frame = None
                best_dist = float("inf")
                for frame in frames:
                    dist = abs(frame["timestamp"] - ots)
                    if dist < best_dist and dist <= window_s:
                        best_dist = dist
                        best_frame = frame
                
                if best_frame is not None and bi < len(best_frame["bytes"]):
                    if model_type == "single_byte":
                        can_val = best_frame["bytes"][bi]
                    elif model_type == "two_byte_be":
                        if bj < len(best_frame["bytes"]):
                            can_val = (best_frame["bytes"][bi] << 8) | best_frame["bytes"][bj]
                        else:
                            continue
                    elif model_type == "two_byte_le":
                        if bj < len(best_frame["bytes"]):
                            can_val = best_frame["bytes"][bi] | (best_frame["bytes"][bj] << 8)
                        else:
                            continue
                    else:
                        continue
                    
                    aligned_obd.append(obd_vals[idx])
                    aligned_can.append(float(can_val))
                    aligned_ts.append(ots)
            
            if len(aligned_obd) < 3:
                continue
            
            # Check if CAN values have some variation
            if len(set(aligned_can)) < 2:
                continue
            
            pearson = _pearson(aligned_can, aligned_obd)
            spearman = _spearman(aligned_can, aligned_obd)
            
            abs_pearson = abs(pearson)
            abs_spearman = abs(spearman)
            
            if abs_pearson < 0.3 and abs_spearman < 0.3:
                continue
            
            scale, offset = _linear_fit(aligned_can, aligned_obd)
            can_transformed = [round(scale * c + offset, 4) for c in aligned_can]
            
            confidence = round(0.6 * abs_pearson + 0.4 * abs_spearman, 4)
            
            model_label = model_type
            if model_type == "two_byte_be":
                model_label = f"2 bytes BE [{bi}:{bj}]"
            elif model_type == "two_byte_le":
                model_label = f"2 bytes LE [{bi}:{bj}]"
            else:
                model_label = f"1 byte [{bi}]"
            
            candidates.append({
                "can_id": can_id,
                "byte_index": bi,
                "byte_end": bj,
                "model": model_label,
                "model_type": model_type,
                "scale": scale,
                "offset": offset,
                "pearson": round(pearson, 4),
                "spearman": round(spearman, 4),
                "confidence": confidence,
                "n_samples": len(aligned_obd),
                "obd_values": [round(v, 4) for v in aligned_obd],
                "can_values": [round(v, 4) for v in aligned_can],
                "can_transformed": can_transformed,
                "timestamps": [round(t, 6) for t in aligned_ts],
            })
    
    # Sort by confidence descending, take top 20
    candidates.sort(key=lambda c: c["confidence"], reverse=True)
    return candidates[:20]


@app.post("/api/analysis/correlate-obd")
async def correlate_obd_endpoint(request: SignalFinderCorrelationRequest):
    """
    Offline correlation: match OBD-II samples with CAN log data.
    Accepts OBD samples + either a mission log path or a raw log path.
    Returns top correlation candidates with visualization data.
    """
    start_time = time.time()
    
    log_path = None
    
    # Find the log file
    if request.log_path:
        log_path = Path(request.log_path)
    elif request.mission_id:
        mission_dir = MISSIONS_DIR / request.mission_id
        if not mission_dir.exists():
            raise HTTPException(status_code=404, detail=f"Mission non trouvee: {request.mission_id}")
        logs_dir = mission_dir / "logs"
        if logs_dir.exists():
            log_files = sorted(logs_dir.glob("*.log"), key=lambda f: f.stat().st_mtime, reverse=True)
            if log_files:
                log_path = log_files[0]
    
    if not log_path or not log_path.exists():
        raise HTTPException(status_code=400, detail="Aucun fichier log CAN trouve. Fournissez log_path ou mission_id avec des logs.")
    
    obd_samples = [{"timestamp": s.timestamp, "value": s.value} for s in request.obd_samples]
    
    if len(obd_samples) < 3:
        raise HTTPException(status_code=400, detail="Minimum 3 echantillons OBD requis pour la correlation.")
    
    # Parse the CAN log
    can_data = _parse_log_for_correlation(str(log_path))
    
    total_ids = len(can_data)
    total_frames = sum(len(frames) for frames in can_data.values())
    
    target_ids = request.target_ids if request.target_ids else None
    
    candidates = _correlate_obd_with_can(
        can_data,
        obd_samples,
        window_ms=request.window_ms,
        target_ids=target_ids,
    )
    
    elapsed = round((time.time() - start_time) * 1000, 1)
    
    return {
        "status": "success",
        "candidates": candidates,
        "total_ids_analyzed": total_ids,
        "total_frames_processed": total_frames,
        "elapsed_ms": elapsed,
        "log_file": str(log_path),
        "obd_sample_count": len(obd_samples),
    }


OBD_RESPONSE_IDS = {"7E8", "7E9", "7EA", "7EB", "7EC", "7ED", "7EE", "7EF"}


def _extract_obd_samples_from_log(log_file_path: str, pid: str) -> list:
    """
    Parse a candump log and extract decoded OBD-II response values for a given PID.
    Looks for 7E8-7EF response frames containing service 01 responses (0x41).
    Returns list of { timestamp, value } samples.
    """
    pid_upper = pid.upper()
    decoder = OBD_PID_DECODERS.get(pid_upper)
    samples = []

    with open(log_file_path, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            match = re.match(r"\((\d+\.\d+)\)\s+\w+\s+([0-9A-Fa-f]+)#([0-9A-Fa-f]*)", line)
            if not match:
                continue
            ts = float(match.group(1))
            can_id = match.group(2).upper()
            data_hex = match.group(3).upper()

            if can_id not in OBD_RESPONSE_IDS:
                continue

            byte_list = []
            for i in range(0, len(data_hex), 2):
                if i + 2 <= len(data_hex):
                    byte_list.append(int(data_hex[i:i + 2], 16))

            # OBD response format: [length, 0x41, PID, A, B, ...]
            if len(byte_list) < 4:
                continue
            if byte_list[1] != 0x41:
                continue
            resp_pid = f"{byte_list[2]:02X}"
            if resp_pid != pid_upper:
                continue

            a_val = byte_list[3] if len(byte_list) > 3 else 0
            b_val = byte_list[4] if len(byte_list) > 4 else 0

            if decoder:
                try:
                    value = round(decoder[2](a_val, b_val), 2)
                except Exception:
                    value = float(a_val)
            else:
                value = float(a_val)

            samples.append({"timestamp": ts, "value": value})

    return samples


@app.post("/api/signal-finder/extract-obd-from-log")
async def extract_obd_from_log(
    mission_id: Optional[str] = None,
    log_path: Optional[str] = None,
    pid: str = "0C",
):
    """
    Parse a CAN log file and extract OBD-II response samples for a given PID.
    Returns decoded timestamp + value pairs that can be used directly for correlation.
    """
    resolved_path = None

    if log_path:
        resolved_path = Path(log_path)
    elif mission_id:
        mission_dir = MISSIONS_DIR / mission_id
        if not mission_dir.exists():
            raise HTTPException(status_code=404, detail=f"Mission non trouvee: {mission_id}")
        logs_dir = mission_dir / "logs"
        if logs_dir.exists():
            log_files = sorted(logs_dir.glob("*.log"), key=lambda f: f.stat().st_mtime, reverse=True)
            if log_files:
                resolved_path = log_files[0]

    if not resolved_path or not resolved_path.exists():
        raise HTTPException(status_code=400, detail="Aucun fichier log CAN trouve.")

    samples = _extract_obd_samples_from_log(str(resolved_path), pid)

    decoder = OBD_PID_DECODERS.get(pid.upper())

    return {
        "status": "success",
        "pid": pid.upper(),
        "name": decoder[0] if decoder else f"PID {pid.upper()}",
        "unit": decoder[1] if decoder else "",
        "samples": samples,
        "count": len(samples),
        "log_file": str(resolved_path),
    }


@app.post("/api/signal-finder/read-pid")
async def signal_finder_read_pid(
    interface: str = "can0",
    pid: str = "0C",
    service: str = "01",
):
    """
    Read a specific OBD-II PID and return the decoded value.
    Used by Signal Finder to collect OBD samples in live mode.
    """
    ts = time.time()
    
    pid_upper = pid.upper()
    decoder = OBD_PID_DECODERS.get(pid_upper)
    
    data = f"02{service}{pid_upper}0000000000"[:16]
    
    result = await obd_send_with_flow_control(
        interface, "7DF", data, "7E8"
    )
    
    if not result["success"]:
        return {
            "success": False,
            "timestamp": ts,
            "pid": pid_upper,
            "raw_hex": "",
            "decoded_value": None,
            "unit": decoder[1] if decoder else "",
            "name": decoder[0] if decoder else f"PID {pid_upper}",
            "error": result["error"],
        }
    
    # Parse response to extract data bytes
    decoded_value = None
    raw_hex = ""
    for resp_line in result["responses"]:
        parsed = parse_candump_line(resp_line) if isinstance(resp_line, str) else resp_line
        if parsed and parsed["id"] in ("7E8", "7E9", "7EA", "7EB"):
            data_hex = parsed["data"]
            raw_hex = data_hex
            byte_list = [int(data_hex[i:i+2], 16) for i in range(0, len(data_hex), 2)]
            
            # Check response: byte[1] should be 0x41 (response to service 01)
            # Format: [length, 0x41, PID, A, B, ...]
            if len(byte_list) >= 3 and byte_list[1] == 0x41:
                resp_pid = f"{byte_list[2]:02X}"
                if resp_pid == pid_upper:
                    a_val = byte_list[3] if len(byte_list) > 3 else 0
                    b_val = byte_list[4] if len(byte_list) > 4 else 0
                    if decoder:
                        try:
                            decoded_value = round(decoder[2](a_val, b_val), 2)
                        except Exception:
                            decoded_value = a_val
                    else:
                        decoded_value = a_val
                    break
    
    return {
        "success": decoded_value is not None,
        "timestamp": ts,
        "pid": pid_upper,
        "raw_hex": raw_hex,
        "decoded_value": decoded_value,
        "unit": decoder[1] if decoder else "",
        "name": decoder[0] if decoder else f"PID {pid_upper}",
        "error": None if decoded_value is not None else "Pas de reponse OBD valide",
        "frames": result["responses"],
    }


# =============================================================================
# Signal Finder WebSocket - Live correlation
# =============================================================================

class SignalFinderState:
    """Tracks active Signal Finder live sessions."""
    active: bool = False
    process: Optional[asyncio.subprocess.Process] = None

signal_finder_state = SignalFinderState()


@app.websocket("/ws/signal-finder")
async def websocket_signal_finder(websocket: WebSocket, interface: str = Query(default="can0")):
    """
    WebSocket for live OBD/CAN correlation.
    
    Client sends:
      { "action": "start", "pid": "0C", "interface": "can0", "intervalMs": 200 }
      { "action": "stop" }
    
    Server sends:
      { "type": "obd_sample", "timestamp": ..., "value": ..., "unit": "...", "pid": "..." }
      { "type": "can_frame", ... }
      { "type": "correlation_update", "candidates": [...], "sampleCount": N }
      { "type": "status", "message": "..." }
    """
    await websocket.accept()
    
    candump_proc = None
    running = False
    obd_samples = []
    can_buffer = {}  # { can_id: [ { timestamp, bytes } ] }
    
    async def capture_can_traffic(iface: str):
        """Background task to capture CAN frames."""
        nonlocal candump_proc, can_buffer
        try:
            candump_proc = await asyncio.create_subprocess_exec(
                "candump", "-ta", iface,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            while running and candump_proc and candump_proc.stdout:
                line = await candump_proc.stdout.readline()
                if not line:
                    break
                decoded = line.decode().strip()
                if not decoded:
                    continue
                parts = decoded.split()
                if len(parts) < 4:
                    continue
                try:
                    timestamp = float(parts[0].strip("()"))
                    can_id = parts[2].upper()
                    if can_id in OBD_FILTER_IDS:
                        continue
                    dlc_idx = decoded.index("[")
                    dlc_end = decoded.index("]")
                    data_part = decoded[dlc_end+1:].strip().replace(" ", "").upper()
                    byte_values = []
                    for i in range(0, len(data_part), 2):
                        if i + 2 <= len(data_part):
                            byte_values.append(int(data_part[i:i+2], 16))
                    if can_id not in can_buffer:
                        can_buffer[can_id] = []
                    can_buffer[can_id].append({"timestamp": timestamp, "bytes": byte_values})
                    # Keep only last 500 frames per ID to limit memory
                    if len(can_buffer[can_id]) > 500:
                        can_buffer[can_id] = can_buffer[can_id][-500:]
                    # Send frame to client
                    await websocket.send_text(json.dumps({
                        "type": "can_frame",
                        "timestamp": timestamp,
                        "canId": can_id,
                        "data": data_part,
                    }))
                except Exception:
                    pass
        except asyncio.CancelledError:
            pass
        except Exception:
            pass
    
    can_task = None
    
    try:
        while True:
            raw = await websocket.receive_text()
            msg = json.loads(raw)
            action = msg.get("action")
            
            if action == "start":
                pid = msg.get("pid", "0C").upper()
                iface = msg.get("interface", interface)
                interval_ms = msg.get("intervalMs", 300)
                interval_s = max(interval_ms / 1000.0, 0.15)
                correlation_interval = msg.get("correlationIntervalS", 3)
                
                running = True
                obd_samples.clear()
                can_buffer.clear()
                
                await websocket.send_text(json.dumps({
                    "type": "status",
                    "message": f"Demarrage capture CAN + lecture PID {pid} toutes les {interval_ms}ms",
                }))
                
                # Start CAN capture task
                can_task = asyncio.create_task(capture_can_traffic(iface))
                
                # OBD read loop
                last_correlation_time = time.time()
                
                while running:
                    ts = time.time()
                    decoder = OBD_PID_DECODERS.get(pid)
                    data_str = f"02{msg.get('service', '01')}{pid}0000000000"[:16]
                    
                    result = await obd_send_with_flow_control(iface, "7DF", data_str, "7E8")
                    
                    if result["success"]:
                        for resp_line in result["responses"]:
                            parsed = parse_candump_line(resp_line) if isinstance(resp_line, str) else resp_line
                            if parsed and parsed["id"] in ("7E8", "7E9", "7EA", "7EB"):
                                data_hex = parsed["data"]
                                byte_list = [int(data_hex[i:i+2], 16) for i in range(0, len(data_hex), 2)]
                                if len(byte_list) >= 3 and byte_list[1] == 0x41:
                                    resp_pid = f"{byte_list[2]:02X}"
                                    if resp_pid == pid:
                                        a_val = byte_list[3] if len(byte_list) > 3 else 0
                                        b_val = byte_list[4] if len(byte_list) > 4 else 0
                                        if decoder:
                                            try:
                                                val = round(decoder[2](a_val, b_val), 2)
                                            except Exception:
                                                val = float(a_val)
                                        else:
                                            val = float(a_val)
                                        
                                        sample = {"timestamp": ts, "value": val}
                                        obd_samples.append(sample)
                                        
                                        await websocket.send_text(json.dumps({
                                            "type": "obd_sample",
                                            "timestamp": ts,
                                            "value": val,
                                            "unit": decoder[1] if decoder else "",
                                            "pid": pid,
                                            "name": decoder[0] if decoder else f"PID {pid}",
                                            "sampleCount": len(obd_samples),
                                        }))
                                        break
                    
                    # Periodic correlation
                    if time.time() - last_correlation_time >= correlation_interval and len(obd_samples) >= 5:
                        last_correlation_time = time.time()
                        corr_candidates = _correlate_obd_with_can(
                            can_buffer, obd_samples,
                            window_ms=100,
                        )
                        await websocket.send_text(json.dumps({
                            "type": "correlation_update",
                            "candidates": corr_candidates[:10],
                            "sampleCount": len(obd_samples),
                            "canIdsCount": len(can_buffer),
                        }))
                    
                    # Check for stop command (non-blocking)
                    try:
                        check_msg = await asyncio.wait_for(websocket.receive_text(), timeout=interval_s)
                        check_data = json.loads(check_msg)
                        if check_data.get("action") == "stop":
                            running = False
                            # Final correlation
                            if len(obd_samples) >= 3:
                                final_candidates = _correlate_obd_with_can(
                                    can_buffer, obd_samples, window_ms=100,
                                )
                                await websocket.send_text(json.dumps({
                                    "type": "correlation_update",
                                    "candidates": final_candidates[:10],
                                    "sampleCount": len(obd_samples),
                                    "canIdsCount": len(can_buffer),
                                    "final": True,
                                }))
                            await websocket.send_text(json.dumps({
                                "type": "status",
                                "message": f"Arret - {len(obd_samples)} echantillons collectes",
                            }))
                    except asyncio.TimeoutError:
                        pass
            
            elif action == "stop":
                running = False
                await websocket.send_text(json.dumps({
                    "type": "status",
                    "message": "Session arretee",
                }))
    
    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await websocket.send_text(json.dumps({"type": "error", "message": str(e)}))
        except Exception:
            pass
    finally:
        running = False
        if can_task and not can_task.done():
            can_task.cancel()
            try:
                await can_task
            except asyncio.CancelledError:
                pass
        if candump_proc and candump_proc.returncode is None:
            candump_proc.terminate()
            try:
                await asyncio.wait_for(candump_proc.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                candump_proc.kill()


# =============================================================================
# Analyse CAN - Heatmap de variabilite + Auto-detection de signaux
# =============================================================================

import math as _math

class HeatmapRequest(BaseModel):
    mission_id: Optional[str] = None
    log_path: Optional[str] = None
    log_id: Optional[str] = None
    sample_limit: int = 50000


class AutoDetectRequest(BaseModel):
    mission_id: Optional[str] = None
    log_path: Optional[str] = None
    log_id: Optional[str] = None
    target_ids: Optional[List[str]] = None
    min_entropy: float = 0.5
    correlation_threshold: float = 0.85


def _resolve_log_path(mission_id: Optional[str], log_path: Optional[str], log_id: Optional[str]) -> Path:
    """Helper to find the log file from various input combos."""
    if log_path:
        p = Path(log_path)
        if p.exists():
            return p
    if mission_id:
        mission_dir = MISSIONS_DIR / mission_id
        if not mission_dir.exists():
            raise HTTPException(status_code=404, detail=f"Mission non trouvee: {mission_id}")
        logs_dir = mission_dir / "logs"
        if logs_dir.exists():
            if log_id:
                # match by filename
                for f in logs_dir.glob("*.log"):
                    if f.name == log_id or f.stem == log_id:
                        return f
            # fallback: latest log
            log_files = sorted(logs_dir.glob("*.log"), key=lambda f: f.stat().st_mtime, reverse=True)
            if log_files:
                return log_files[0]
    raise HTTPException(status_code=400, detail="Aucun fichier log CAN trouve.")


def _shannon_entropy(values: list) -> float:
    """Shannon entropy in bits (0 = constant, 8 = uniform over 256 values)."""
    n = len(values)
    if n == 0:
        return 0.0
    freq = {}
    for v in values:
        freq[v] = freq.get(v, 0) + 1
    ent = 0.0
    for count in freq.values():
        p = count / n
        if p > 0:
            ent -= p * _math.log2(p)
    return round(ent, 4)


def _change_rate(values: list) -> float:
    """Fraction of consecutive frames where the value changes."""
    if len(values) < 2:
        return 0.0
    changes = sum(1 for i in range(1, len(values)) if values[i] != values[i - 1])
    return round(changes / (len(values) - 1), 4)


@app.post("/api/analysis/byte-heatmap")
async def byte_heatmap_endpoint(request: HeatmapRequest):
    """
    Analyse un log CAN et retourne une matrice de variabilite par (CAN_ID, byte).
    Pour chaque byte: change_rate, entropie de Shannon, min/max, nb unique.
    """
    start_time = time.time()
    log_path = _resolve_log_path(request.mission_id, request.log_path, request.log_id)

    # Parse log
    can_data = _parse_log_for_correlation(str(log_path))

    total_frames = sum(len(frames) for frames in can_data.values())

    ids_result = []
    for can_id in sorted(can_data.keys()):
        frames = can_data[can_id]
        if not frames:
            continue
        # Limit frames if needed
        if len(frames) > request.sample_limit:
            frames = frames[:request.sample_limit]

        dlc = max(len(f["bytes"]) for f in frames)
        frame_count = len(frames)

        # frequency estimation
        if frame_count >= 2:
            duration = frames[-1]["timestamp"] - frames[0]["timestamp"]
            freq_hz = round(frame_count / duration, 1) if duration > 0 else 0.0
        else:
            freq_hz = 0.0

        bytes_info = []
        for bi in range(dlc):
            byte_vals = [f["bytes"][bi] for f in frames if bi < len(f["bytes"])]
            if not byte_vals:
                bytes_info.append({
                    "index": bi, "change_rate": 0, "entropy": 0,
                    "min": 0, "max": 0, "unique_count": 0, "is_constant": True,
                })
                continue
            cr = _change_rate(byte_vals)
            ent = _shannon_entropy(byte_vals)
            bytes_info.append({
                "index": bi,
                "change_rate": cr,
                "entropy": round(ent, 4),
                "min": min(byte_vals),
                "max": max(byte_vals),
                "unique_count": len(set(byte_vals)),
                "is_constant": cr == 0,
            })

        ids_result.append({
            "can_id": can_id,
            "frame_count": frame_count,
            "dlc": dlc,
            "frequency_hz": freq_hz,
            "bytes": bytes_info,
        })

    # Sort by frequency descending
    ids_result.sort(key=lambda x: x["frequency_hz"], reverse=True)

    elapsed = round((time.time() - start_time) * 1000, 1)
    return {
        "status": "success",
        "ids": ids_result,
        "total_frames": total_frames,
        "total_ids": len(ids_result),
        "elapsed_ms": elapsed,
    }


@app.post("/api/analysis/auto-detect-signals")
async def auto_detect_signals_endpoint(request: AutoDetectRequest):
    """
    Detecte automatiquement les frontieres de signaux dans les messages CAN
    en utilisant l'entropie, le change_rate, et la correlation temporelle entre bytes adjacents.
    """
    start_time = time.time()
    log_path = _resolve_log_path(request.mission_id, request.log_path, request.log_id)

    can_data = _parse_log_for_correlation(str(log_path))

    ids_to_analyze = request.target_ids if request.target_ids else sorted(can_data.keys())

    detected_signals = []

    for can_id in ids_to_analyze:
        if can_id not in can_data:
            continue
        frames = can_data[can_id]
        if len(frames) < 10:
            continue

        dlc = max(len(f["bytes"]) for f in frames)

        # --- Step 1: per-byte metrics ---
        byte_series = {}
        for bi in range(dlc):
            byte_series[bi] = [f["bytes"][bi] for f in frames if bi < len(f["bytes"])]

        byte_metrics = {}
        for bi in range(dlc):
            vals = byte_series[bi]
            if not vals:
                continue
            ent = _shannon_entropy(vals)
            cr = _change_rate(vals)
            byte_metrics[bi] = {"entropy": ent, "change_rate": cr, "values": vals}

        # --- Step 2: identify active bytes (above entropy threshold) ---
        active_bytes = []
        for bi in range(dlc):
            if bi in byte_metrics and byte_metrics[bi]["entropy"] >= request.min_entropy:
                active_bytes.append(bi)

        if not active_bytes:
            continue

        # --- Step 3: compute temporal correlation between adjacent active bytes ---
        # Two bytes belong to the same multi-byte signal if they change at the same time
        adjacency_corr = {}
        for i in range(len(active_bytes) - 1):
            bi = active_bytes[i]
            bj = active_bytes[i + 1]
            if bj != bi + 1:
                # Non-adjacent: skip
                continue
            vals_i = byte_metrics[bi]["values"]
            vals_j = byte_metrics[bj]["values"]
            n = min(len(vals_i), len(vals_j))
            if n < 5:
                continue
            # Compute change correlation: do they change at the same frames?
            changes_i = [1 if vals_i[k] != vals_i[k - 1] else 0 for k in range(1, n)]
            changes_j = [1 if vals_j[k] != vals_j[k - 1] else 0 for k in range(1, n)]
            # Jaccard similarity of change positions
            both = sum(1 for a, b in zip(changes_i, changes_j) if a == 1 and b == 1)
            either = sum(1 for a, b in zip(changes_i, changes_j) if a == 1 or b == 1)
            corr = both / either if either > 0 else 0.0
            adjacency_corr[(bi, bj)] = corr

        # --- Step 4: Cluster adjacent correlated bytes into signal groups ---
        groups = []
        visited = set()
        for bi in active_bytes:
            if bi in visited:
                continue
            group = [bi]
            visited.add(bi)
            current = bi
            while True:
                nxt = current + 1
                if nxt in visited or nxt not in active_bytes:
                    break
                corr = adjacency_corr.get((current, nxt), 0)
                if corr >= request.correlation_threshold:
                    group.append(nxt)
                    visited.add(nxt)
                    current = nxt
                else:
                    break
            groups.append(group)

        # --- Step 5: For each signal group, determine properties ---
        for group in groups:
            start_byte = group[0]
            length_bytes = len(group)
            bit_length = length_bytes * 8
            start_bit = start_byte * 8

            # Gather all values from the group
            all_vals_be = []
            all_vals_le = []
            for frame in frames:
                b = frame["bytes"]
                if start_byte + length_bytes > len(b):
                    continue
                # Big Endian
                val_be = 0
                for gi, gbi in enumerate(group):
                    val_be = (val_be << 8) | b[gbi]
                all_vals_be.append(val_be)
                # Little Endian
                val_le = 0
                for gi, gbi in enumerate(reversed(group)):
                    val_le = (val_le << 8) | b[gbi]
                all_vals_le.append(val_le)

            if not all_vals_be:
                continue

            # Determine endianness: prefer the one with smoother transitions
            def _smoothness(vals):
                if len(vals) < 2:
                    return 0.0
                diffs = [abs(vals[i] - vals[i - 1]) for i in range(1, len(vals))]
                return sum(diffs) / len(diffs) if diffs else 0.0

            smooth_be = _smoothness(all_vals_be)
            smooth_le = _smoothness(all_vals_le)
            # Lower avg diff = smoother = more likely correct
            if smooth_le < smooth_be and length_bytes > 1:
                byte_order = "little_endian"
                all_vals = all_vals_le
            else:
                byte_order = "big_endian"
                all_vals = all_vals_be

            # Signed detection: if values span the upper half of range, might be signed
            max_unsigned = (1 << bit_length) - 1
            threshold_sign = max_unsigned * 0.6
            is_signed = any(v > threshold_sign for v in all_vals) and min(all_vals) < max_unsigned * 0.3

            val_min = min(all_vals)
            val_max = max(all_vals)

            # Confidence based on entropy + change_rate of constituent bytes
            avg_entropy = sum(byte_metrics[bi]["entropy"] for bi in group) / len(group)
            avg_cr = sum(byte_metrics[bi]["change_rate"] for bi in group) / len(group)
            confidence = round(0.5 * min(avg_entropy / 8.0, 1.0) + 0.5 * avg_cr, 4)

            # Sample values (evenly spaced, max 8)
            step = max(1, len(all_vals) // 8)
            sample_vals = [all_vals[i] for i in range(0, len(all_vals), step)][:8]

            name = f"Sig_{can_id}_B{start_byte}_{bit_length}b"

            detected_signals.append({
                "can_id": can_id,
                "name": name,
                "start_byte": start_byte,
                "length_bytes": length_bytes,
                "start_bit": start_bit,
                "bit_length": bit_length,
                "byte_order": byte_order,
                "is_signed": is_signed,
                "entropy": round(avg_entropy, 4),
                "change_rate": round(avg_cr, 4),
                "value_range": [val_min, val_max],
                "sample_values": sample_vals,
                "confidence": confidence,
            })

    # Sort by confidence descending
    detected_signals.sort(key=lambda s: s["confidence"], reverse=True)

    elapsed = round((time.time() - start_time) * 1000, 1)
    return {
        "status": "success",
        "detected_signals": detected_signals,
        "total_ids_analyzed": len(ids_to_analyze),
        "total_signals_found": len(detected_signals),
        "elapsed_ms": elapsed,
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
