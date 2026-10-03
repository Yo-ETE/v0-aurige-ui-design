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
import shlex
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
import db
import hotspot
from auth import SessionAuthMiddleware, require_permission, router as auth_router
from permissions import allows
from validators import valid_git_ref, valid_backup_filename, valid_dbc_id
import dbc_store
import known_frames
from routers.users import router as users_router

# =============================================================================
# Configuration
# =============================================================================

DATA_DIR = Path(os.getenv("AURIGE_DATA_DIR", "/opt/aurige/data"))
MISSIONS_DIR = DATA_DIR / "missions"

MISSIONS_DIR.mkdir(parents=True, exist_ok=True)

# Base SQLite des comptes (auth + RBAC)
DB_PATH = Path(os.getenv("AURIGE_DB_PATH", str(DATA_DIR / "aurige.db")))

# Origines autorisées en CORS : aucune en prod (nginx, même origine), le dev local
# (Next sur :3000, API sur :8000) et celles listées dans AURIGE_CORS_ORIGINS.
CORS_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"] + [
    o.strip() for o in os.getenv("AURIGE_CORS_ORIGINS", "").split(",") if o.strip()
]

# Global state for running processes
class ProcessState:
    candump_process: Optional[asyncio.subprocess.Process] = None
    candump_interface: Optional[str] = None
    capture_process: Optional[asyncio.subprocess.Process] = None
    capture_file: Optional[Path] = None
    capture_start_time: Optional[datetime] = None
    cangen_process: Optional[asyncio.subprocess.Process] = None
    canplayer_process: Optional[asyncio.subprocess.Process] = None
    inject_process: Optional[asyncio.subprocess.Process] = None
    inject_desc: str = ""
    fuzzing_process: Optional[asyncio.subprocess.Process] = None
    websocket_clients: list[WebSocket] = []

state = ProcessState()


@asynccontextmanager
async def lifespan(app: FastAPI):
  """Startup and cleanup"""
  setup_error_logging(DATA_DIR)
  log_info("AURIGE Backend starting up")
  await db.init_db(DB_PATH)
  hotspot_task = asyncio.create_task(hotspot.auto_hotspot_once())
  try:
    yield
  finally:
    hotspot_task.cancel()
    await db.close_db()
  
  # Stop all processes on shutdown
  for proc in [state.candump_process, state.capture_process,
               state.cangen_process, state.canplayer_process, state.fuzzing_process,
               state.inject_process]:
    if proc and proc.returncode is None:
      proc.terminate()
      try:
        await asyncio.wait_for(proc.wait(), timeout=2.0)
      except Exception:
        proc.kill()


app = FastAPI(
    title="AURIGE API",
    description="CAN Bus Analysis API for Raspberry Pi - System Controller",
    version="2.0.0",
    lifespan=lifespan,
)

app.include_router(auth_router)
app.include_router(users_router)
from routers.tailscale import router as tailscale_router  # noqa: E402
app.include_router(tailscale_router)
from routers.system import router as system_router  # noqa: E402
app.include_router(system_router)
from routers.network import router as network_router  # noqa: E402
app.include_router(network_router)
from routers.generator import router as generator_router  # noqa: E402
app.include_router(generator_router)
from routers.replay import router as replay_router  # noqa: E402
app.include_router(replay_router)
from routers.capture import router as capture_router  # noqa: E402
app.include_router(capture_router)
from routers.injection import router as injection_router  # noqa: E402
app.include_router(injection_router)


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
    # Etat du controleur CAN (None pour vcan / si absent) : ERROR-ACTIVE, ERROR-WARNING,
    # ERROR-PASSIVE, BUS-OFF (=> probleme de cablage / terminaison 120 ohm), STOPPED, SLEEPING
    can_state: Optional[str] = None
    berr_tx: Optional[int] = None
    berr_rx: Optional[int] = None
    restarts: Optional[int] = None

    class Config:
        populate_by_name = True


# Router extrait (inclus ici car il importe CANInterfaceStatus defini au-dessus)
from routers.can import router as can_router  # noqa: E402
app.include_router(can_router)
from routers.fuzzing import router as fuzzing_router  # noqa: E402
app.include_router(fuzzing_router)
from routers.obd import router as obd_router  # noqa: E402
app.include_router(obd_router)


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
        
        # Etat du controleur + compteurs d'erreurs bus (absents pour vcan)
        raw_state = info_data.get("state")
        can_state = str(raw_state).upper() if raw_state else None
        bc = info_data.get("berr_counter") or {}
        berr_tx = bc.get("tx")
        berr_rx = bc.get("rx")
        restarts = info_data.get("restart_cnt")
        
        # Get stats
        stats = iface_data.get("stats64", iface_data.get("stats", {}))
        
        return CANInterfaceStatus(
            interface=interface,
            up=up,
            bitrate=bitrate,
            can_state=can_state,
            berr_tx=berr_tx,
            berr_rx=berr_rx,
            restarts=restarts,
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


_HEX2_RE = re.compile(r"^[0-9A-Fa-f]{2}$")
OBD_READ_ONLY_SERVICES = {"01", "09"}


def validate_obd_params(service: str, pid: str) -> tuple[str, str]:
    """Valide service/pid OBD (exactement 2 hex chacun). Retourne (service, pid) en majuscules."""
    if not isinstance(service, str) or not isinstance(pid, str)             or not _HEX2_RE.match(service) or not _HEX2_RE.match(pid):
        raise ValueError("service et pid doivent etre exactement 2 caracteres hexadecimaux")
    return service.upper(), pid.upper()


def obd_service_needs_write(service: str) -> bool:
    """Tout service OBD hors 01/09 (ex. 04 effacement DTC, 11 reset ECU) exige obd_write."""
    return service not in OBD_READ_ONLY_SERVICES


def guard_obd_http(request: Request, service: str, pid: str) -> tuple[str, str]:
    try:
        service, pid = validate_obd_params(service, pid)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if obd_service_needs_write(service):
        require_permission(request, "obd_write")
    return service, pid


def ws_user_may_obd_write(websocket: WebSocket) -> bool:
    user = (websocket.scope.get("state") or {}).get("user")
    if not user:
        return False
    return user["role"] == "admin" or allows(user["role"], user["permissions"], ["obd_write"])


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


# =============================================================================
# CAN Control Endpoints
# =============================================================================

# =============================================================================
# Capture Endpoints
# =============================================================================

def _count_log_frames(path) -> int:
    """Compte les lignes (= trames candump -L) d'un fichier log, 0 si illisible."""
    try:
        r = run_command(["wc", "-l", str(path)], check=False)
        if r.returncode == 0 and r.stdout.strip():
            return int(r.stdout.strip().split()[0])
    except Exception:
        pass
    return 0


# =============================================================================
# Replay Endpoints
# =============================================================================

# =============================================================================
# Injection de fond (boucle d'une trame ou keep-alive d'un log)
# =============================================================================

INJECT_SCRIPT_PATH = DATA_DIR / "aurige_inject.sh"  # distinct du replay, hors /tmp (symlink/race)
INJECT_MAX_FRAMES = 5000
# Toujours fullmatch (jamais ^...$ : $ accepte un saut de ligne final)
_HEX_ID = re.compile(r"[0-9A-Fa-f]{1,8}")
_HEX_DATA = re.compile(r"([0-9A-Fa-f]{2}){0,8}")
_IFACE_RE = re.compile(r"[A-Za-z0-9_.-]{1,15}")
_SAFE_ID_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]*")  # pas de '.' initial ni de separateur
_LOG_FRAME_RE = re.compile(r"[0-9A-Fa-f]{1,8}#([0-9A-Fa-f]{2}){0,8}")


def _injectable_or_block(frames: list[str]) -> Optional[str]:
    """Point de garde unique pour toute injection de fond.
    AUD-06 (is_id_blocked) se branchera ICI. Retourne None = autorise,
    sinon un message de refus. Pour l'instant : aucun blocage."""
    return None


async def _start_inject_frames(interface: str, frames: list[str], interval_ms: int, desc: str) -> dict:
    """Demarre la boucle d'injection de fond (mecanisme unique, un seul producteur a
    la fois) pour une liste de trames deja validees "CANID#DATA" (hex uniquement).
    Factorise pour etre reutilise par /api/inject/start (modes frame/log) ET par le
    rejeu en boucle de /api/known-frames/{fid}/replay, sans dupliquer la construction
    du script shell."""
    if state.inject_process and state.inject_process.returncode is None:
        raise HTTPException(status_code=409, detail="Injection de fond deja en cours")
    interval = max(10, min(5000, int(interval_ms)))
    sleep_s = interval / 1000.0
    qiface = shlex.quote(interface)
    body = "\n".join(f"  cansend {qiface} {shlex.quote(f)}\n  sleep {sleep_s}" for f in frames)
    script = f"#!/bin/bash\nwhile true; do\n{body}\ndone\n"
    # Script prive : dossier cree si besoin, ancien fichier supprime (pas de suivi de symlink)
    INJECT_SCRIPT_PATH.parent.mkdir(parents=True, exist_ok=True)
    try:
        INJECT_SCRIPT_PATH.unlink()
    except FileNotFoundError:
        pass
    INJECT_SCRIPT_PATH.write_text(script)
    try:
        INJECT_SCRIPT_PATH.chmod(0o700)
    except OSError:
        pass
    state.inject_process = await run_command_async(["bash", str(INJECT_SCRIPT_PATH)])
    state.inject_desc = desc
    return {"status": "started", "description": desc}


# =============================================================================
# Bibliotheque globale de trames connues (crash / reinit) - rejouables
# Ex. Peugeot : 4C8#0003000000000000 (crash) / 4C8#0000000000000000 (reset).
# =============================================================================

# =============================================================================
# AUD-06 : liste critique d'IDs (bloque le fuzzing/balayage aveugle uniquement)
# =============================================================================

# Chemin module-level (monkeypatchable dans les tests)
BLOCKLIST_PATH = DATA_DIR / "aud06_blocklist.json"
FUZZ_SCRIPT_PATH = Path("/tmp/aurige_fuzz.py")


def _norm_id(s: str) -> str:
    """Normalise un ID CAN : trim, majuscules, retire le prefixe 0X."""
    n = str(s).strip().upper()
    if n.startswith("0X"):
        n = n[2:]
    return n


def _id_int(s: str) -> Optional[int]:
    try:
        return int(_norm_id(s), 16)
    except ValueError:
        return None


def _load_blocklist() -> list:
    """Charge la liste critique (defaut : vide)."""
    try:
        with open(BLOCKLIST_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        ids = data.get("ids", []) if isinstance(data, dict) else []
        return [_norm_id(i) for i in ids if isinstance(i, str)]
    except FileNotFoundError:
        return []
    except (ValueError, OSError) as e:
        # Fichier present mais illisible : la garde ne doit pas planter, mais on le signale
        log_error("aud06_blocklist.json corrompu — garde AUD-06 potentiellement inactive", e)
        return []


def _save_blocklist(ids: list) -> None:
    """Sauvegarde atomique (fichier temporaire + os.replace)."""
    path = Path(BLOCKLIST_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"ids": ids}, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def is_id_blocked(can_id: str) -> bool:
    """True si l'ID est dans la liste critique. Les IDs OBD ne sont JAMAIS bloques."""
    n = _norm_id(can_id)
    v = _id_int(n)
    if n in OBD_FILTER_IDS or (v is not None and any(v == int(o, 16) for o in OBD_FILTER_IDS)):
        return False
    bl = _load_blocklist()
    if n in bl:
        return True
    return v is not None and any(_id_int(b) == v for b in bl)


# =============================================================================
# Generator / Fuzzing Endpoints
# =============================================================================

# =============================================================================
# Mission CRUD Endpoints
# =============================================================================

# =============================================================================
# Log Endpoints
# =============================================================================

class CreateFrameLogRequest(BaseModel):
    can_id: str
    data: str
    timestamp: Optional[str] = None
    name: Optional[str] = None
    interface: str = "can0"

class UpdateLogTagsRequest(BaseModel):
    tags: list[str]

class RenameLogRequest(BaseModel):
    new_name: str = Field(alias="newName")
    
    class Config:
        populate_by_name = True


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


# =============================================================================
# Co-occurrence Analysis
# =============================================================================

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


DTC_DESCRIPTIONS = {
    # Sélection de codes génériques OBD-II (FR). Fallback générique sinon.
    "P0100": "Débit/volume d'air (MAF) — circuit",
    "P0101": "Débit/volume d'air (MAF) — plage/performance",
    "P0105": "Pression collecteur (MAP) — circuit",
    "P0110": "Température air admission — circuit",
    "P0115": "Température liquide refroidissement — circuit",
    "P0120": "Position papillon/pédale — circuit",
    "P0130": "Sonde O2 (banc1 capteur1) — circuit",
    "P0171": "Système trop pauvre (banc 1)",
    "P0172": "Système trop riche (banc 1)",
    "P0300": "Ratés d'allumage aléatoires/multiples",
    "P0301": "Raté d'allumage cylindre 1",
    "P0302": "Raté d'allumage cylindre 2",
    "P0303": "Raté d'allumage cylindre 3",
    "P0304": "Raté d'allumage cylindre 4",
    "P0335": "Capteur position vilebrequin — circuit",
    "P0340": "Capteur position arbre à cames — circuit",
    "P0420": "Rendement catalyseur sous seuil (banc 1)",
    "P0442": "Fuite EVAP (petite)",
    "P0500": "Capteur vitesse véhicule",
    "P0505": "Régulation ralenti",
    "U0100": "Perte de communication avec l'ECM/PCM",
    "U0121": "Perte de communication avec l'ABS",
    "C0035": "Capteur vitesse roue avant gauche",
    "B0001": "Déploiement airbag conducteur",
}


def dtc_description(code: str) -> str:
    """Description FR d'un code DTC, avec fallback générique par catégorie."""
    if code in DTC_DESCRIPTIONS:
        return DTC_DESCRIPTIONS[code]
    cat = code[:1]
    famille = {"P": "Groupe motopropulseur", "C": "Châssis", "B": "Carrosserie", "U": "Réseau/communication"}.get(cat, "")
    generique = " (code générique)" if len(code) > 1 and code[1] == "0" else " (code constructeur)"
    return f"{famille}{generique} — voir documentation" if famille else "Code inconnu"


def _dtc_from_bytes(b1: int, b2: int):
    if b1 == 0 and b2 == 0:
        return None
    letter = "PCBU"[(b1 >> 6) & 0x3]
    first_digit = (b1 >> 4) & 0x3
    code = f"{letter}{first_digit}{(b1 & 0x0F):X}{b2:02X}"
    return {"code": code, "description": dtc_description(code), "category": letter}


def decode_dtcs_from_frames(responses: list, response_service: int = 0x43) -> list:
    """Décode les DTC d'une réponse OBD (Mode 03/07/0A selon response_service)."""
    svc = f"{response_service:02X}"
    frames = []
    for line in responses:
        parsed = parse_candump_line(line) if isinstance(line, str) else line
        if parsed and parsed["id"] in ("7E8", "7E9", "7EA", "7EB"):
            frames.append(parsed["data"])
    if not frames:
        return []
    out = []
    for data in frames:
        bl = [data[i:i+2] for i in range(0, len(data), 2)]
        if len(bl) < 2:
            continue
        first = int(bl[0], 16)
        if first <= 7 and bl[1].upper() == svc:
            dtc_data = bl[2:1 + first]  # borne PCI : ignore le padding
        elif first == 0x10 and len(bl) > 2 and bl[2].upper() == svc:
            dtc_data = bl[3:]
        else:
            continue
        for i in range(0, len(dtc_data) - 1, 2):
            d = _dtc_from_bytes(int(dtc_data[i], 16), int(dtc_data[i+1], 16))
            if d:
                out.append(d)
    return out


async def _read_dtcs(interface: str, mode: str):
    """Lit les DTC d'un mode OBD (03 stockés, 07 en attente, 0A permanents).

    Retourne (codes, details, frames, error) ; error est None en cas de succès.
    """
    result = await obd_send_with_flow_control(interface, "7DF", f"01{mode}000000000000", "7E8")
    if not result["success"]:
        return None, None, None, result["error"]
    responses = result["responses"]
    service = int(mode, 16) + 0x40
    details = decode_dtcs_from_frames(responses, response_service=service) if responses else []
    return [d["code"] for d in details], details, responses, None


def _mode_value_bytes(responses: list, service_hex: str, pid: str):
    """Trouve la réponse single-frame <service><pid> d'un ECU et renvoie (A, B) ou None.

    Mode 01 : [len][41][pid][A][B]...   Mode 02 : [len][42][pid][frame][A][B]...
    """
    skip = 1 if service_hex.upper() == "42" else 0  # octet "frame" du freeze frame
    for line in responses:
        parsed = parse_candump_line(line) if isinstance(line, str) else line
        if not parsed or parsed["id"] not in ("7E8", "7E9", "7EA", "7EB"):
            continue
        data = parsed["data"]
        bl = [data[i:i + 2] for i in range(0, len(data), 2)]
        if len(bl) >= 4 + skip and bl[1].upper() == service_hex.upper() and bl[2].upper() == pid.upper():
            try:
                a = int(bl[3 + skip], 16)
                b = int(bl[4 + skip], 16) if len(bl) > 4 + skip else 0
            except ValueError:
                continue
            return a, b
    return None


async def _obd_body(request: Request) -> tuple:
    """Lit interface/pid depuis le corps JSON ; valide le PID (2 hex)."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    interface = str(body.get("interface") or "can0")
    pid = str(body.get("pid") or "0C").upper()
    if not re.fullmatch(r"[0-9A-F]{2}", pid):
        raise HTTPException(status_code=400, detail="PID invalide (2 caracteres hexadecimaux attendus)")
    return interface, pid


async def _read_pid_value(interface: str, pid: str, service_hex: str, request_frame: str) -> dict:
    # can_send_frame refuse plus de 16 caracteres hex
    assert len(request_frame) <= 16
    result = await obd_send_with_flow_control(interface, "7DF", request_frame, "7E8")
    if not result["success"]:
        return {"status": "error", "message": result.get("error"), "pid": pid, "value": None}
    ab = _mode_value_bytes(result["responses"], service_hex, pid)
    dec = OBD_PID_DECODERS.get(pid)
    if ab is None or dec is None:
        return {"status": "no_data", "pid": pid, "label": dec[0] if dec else pid,
                "unit": dec[1] if dec else "", "value": None, "raw": result["responses"]}
    label, unit, fn = dec
    return {"status": "success", "pid": pid, "label": label, "unit": unit,
            "value": fn(ab[0], ab[1]), "raw": result["responses"]}


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

# =============================================================================
# System Administration Endpoints
# =============================================================================

# Store for apt process output
apt_output_store: dict = {"lines": [], "running": False, "command": ""}


def _set_apt_output(d: dict) -> None:
    """Reaffecte le store apt (utilise par routers/system.py)."""
    global apt_output_store
    apt_output_store = d




# =============================================================================
# Update and Backup Endpoints
# =============================================================================

# Store for update process output
update_output_store: dict = {"lines": [], "running": False, "command": ""}


def _set_update_output(d: dict) -> None:
    """Reaffecte le store de mise a jour (utilise par routers/system.py)."""
    global update_output_store
    update_output_store = d


# Git repo is in /tmp/aurige, not /opt/aurige
GIT_REPO_PATH = "/opt/aurige/repo"






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


def _merge_parsed_dbc(doc: dict, parsed: dict) -> int:
    """Fusionne un DBC parse (parse_dbc_file) dans un document ; retourne le nombre de signaux importes."""
    imported_count = 0
    for msg in parsed['messages']:
      existing_msg = next((m for m in doc['messages'] if m['can_id'] == msg['id']), None)
      if not existing_msg:
        existing_msg = {
          "can_id": msg['id'],
          "name": msg['name'],
          "dlc": msg['dlc'],
          "sender": msg.get('sender', ''),
          "comment": msg.get('comment', ''),
          "signals": []
        }
        doc['messages'].append(existing_msg)

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
    return imported_count


def _import_dbc_into_doc(doc: dict, content_bytes: bytes, stats: Optional[dict] = None) -> int:
    """Parse un fichier .dbc (octets) et le fusionne dans `doc` ; retourne le nombre de signaux importes.
    `stats` (optionnel) recoit `total_messages` (nombre de messages du fichier)."""
    parsed = parse_dbc_file(content_bytes.decode('utf-8', errors='ignore'))
    if stats is not None:
        stats["total_messages"] = len(parsed['messages'])
    doc.setdefault("messages", [])
    n = _merge_parsed_dbc(doc, parsed)
    doc["updated_at"] = datetime.now().isoformat()
    return n




_CAN_ID_RE = re.compile(r"^[0-9A-Fa-f]{1,8}$")


def _valid_can_id(s) -> bool:
    """CAN ID hexadecimal de 1 a 8 caracteres."""
    return isinstance(s, str) and bool(_CAN_ID_RE.fullmatch(s.strip()))


class DBCMessageMeta(BaseModel):
    can_id: str
    name: Optional[str] = None
    dlc: Optional[int] = None
    comment: Optional[str] = None







# ---------------------------------------------------------------------------
# Bibliotheque DBC autonome ({DATA_DIR}/dbc/<dbc_id>.json) + ponts mission
# ---------------------------------------------------------------------------
def _dbc_lib_dir() -> Path:
    d = Path(os.environ.get("AURIGE_DATA_DIR", "/opt/aurige/data")) / "dbc"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _dbc_lib_path(dbc_id: str) -> Path:
    """Chemin sur d'une bibliotheque DBC (id valide + confinement dans le dossier dbc)."""
    if not valid_dbc_id(dbc_id):
        raise HTTPException(status_code=400, detail="Identifiant DBC invalide")
    base = _dbc_lib_dir().resolve()
    p = (base / f"{dbc_id}.json").resolve()
    if base not in p.parents:
        raise HTTPException(status_code=400, detail="Chemin DBC invalide")
    return p


def _lib_doc_or_404(dbc_id: str):
    p = _dbc_lib_path(dbc_id)
    if not p.exists():
        raise HTTPException(status_code=404, detail="DBC introuvable")
    return p, dbc_store.load_doc(p)


def _mission_dbc_path(mission_id: str) -> Path:
    """Chemin dbc.json d'une mission ; refuse les identifiants avec separateurs/traversal."""
    if not isinstance(mission_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", mission_id):
        raise HTTPException(status_code=400, detail="Identifiant de mission invalide")
    return Path(MISSIONS_DIR) / mission_id / "dbc.json"


class DBCLibCreate(BaseModel):
    name: str


def _slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    return s[:40] or "dbc"








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



# =============================================================================
# LOG IMPORT - Upload external log files
# =============================================================================

class ImportLogResponse(BaseModel):
    id: str
    filename: str
    frames_count: int
    message: str



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




# =============================================================================
# Signal Finder WebSocket - Live correlation
# =============================================================================


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
                try:
                    ws_service, pid = validate_obd_params(str(msg.get("service", "01")), str(msg.get("pid", "0C")))
                except ValueError as e:
                    await websocket.send_text(json.dumps({"type": "error", "message": str(e)}))
                    continue
                if obd_service_needs_write(ws_service) and not ws_user_may_obd_write(websocket):
                    await websocket.send_text(json.dumps({"type": "error", "message": "Permission refusee (obd_write requis)"}))
                    continue
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
                    data_str = f"02{ws_service}{pid}0000000000"[:16]
                    
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
    exclude_counters: bool = True
    exclude_checksums: bool = True
    counter_threshold: float = 0.75
    checksum_threshold: float = 0.70


def _detect_counter_bytes(byte_series: dict, dlc: int, threshold: float = 0.75) -> dict:
    """
    Detect rolling counter bytes/nibbles.
    Returns { byte_index: { "type": "counter", "mode": "byte"|"nibble_lo", "ratio": float } }
    """
    counters = {}
    for bi in range(dlc):
        vals = byte_series.get(bi, [])
        if len(vals) < 10:
            continue
        # Full byte increment: v[t+1] == (v[t]+1) % 256
        inc_byte = sum(
            1 for i in range(1, len(vals))
            if vals[i] == (vals[i - 1] + 1) % 256
        )
        ratio_byte = inc_byte / (len(vals) - 1)
        # Low nibble increment: (v[t+1] & 0x0F) == ((v[t] & 0x0F) + 1) % 16
        inc_nib = sum(
            1 for i in range(1, len(vals))
            if (vals[i] & 0x0F) == ((vals[i - 1] & 0x0F) + 1) % 16
        )
        ratio_nib = inc_nib / (len(vals) - 1)
        best_ratio = max(ratio_byte, ratio_nib)
        if best_ratio >= threshold:
            mode = "byte" if ratio_byte >= ratio_nib else "nibble_lo"
            counters[bi] = {
                "type": "counter",
                "mode": mode,
                "ratio": round(best_ratio, 4),
            }
    return counters


def _detect_checksum_bytes(byte_series: dict, dlc: int, threshold: float = 0.70) -> dict:
    """
    Detect simple checksum bytes (XOR8 or SUM8).
    For each byte k, test if XOR or SUM of all other bytes matches byte[k].
    Returns { byte_index: { "type": "checksum", "algo": "xor8"|"sum8", "match_rate": float } }
    """
    checksums = {}
    # Need at least 2 bytes to test checksum
    if dlc < 2:
        return checksums
    # Build frame-level byte arrays
    n_frames = min(len(v) for v in byte_series.values() if v) if byte_series else 0
    if n_frames < 10:
        return checksums

    # Guard 1: enough payload diversity (unique full payloads >= 4)
    payloads_set = set()
    for fi in range(min(n_frames, 500)):
        payload = tuple(byte_series.get(bi, [0])[fi] if fi < len(byte_series.get(bi, [])) else 0 for bi in range(dlc))
        payloads_set.add(payload)
    if len(payloads_set) < 4:
        return checksums

    # Guard 2: at least one non-candidate byte must have entropy > 0.5
    byte_entropies = {}
    for bi in range(dlc):
        vals = byte_series.get(bi, [])
        byte_entropies[bi] = _shannon_entropy(vals) if vals else 0.0

    max_other_entropy = max((byte_entropies.get(bi, 0) for bi in range(dlc)), default=0)
    if max_other_entropy < 0.5:
        return checksums

    best_k = -1
    best_algo = ""
    best_rate = 0.0

    for k in range(dlc):
        if k not in byte_series or not byte_series[k]:
            continue
        # Guard 3: candidate byte must have entropy > 0.5 (not constant)
        if byte_entropies.get(k, 0) < 0.5:
            continue
        # Guard 4: at least one OTHER byte must vary (entropy > 0.5)
        other_max_ent = max((byte_entropies.get(bi, 0) for bi in range(dlc) if bi != k), default=0)
        if other_max_ent < 0.5:
            continue
        match_xor = 0
        match_sum = 0
        for fi in range(n_frames):
            xor_val = 0
            sum_val = 0
            valid = True
            for bi in range(dlc):
                if bi == k:
                    continue
                if bi not in byte_series or fi >= len(byte_series[bi]):
                    valid = False
                    break
                xor_val ^= byte_series[bi][fi]
                sum_val = (sum_val + byte_series[bi][fi]) & 0xFF
            if not valid:
                continue
            target = byte_series[k][fi]
            if xor_val == target:
                match_xor += 1
            if sum_val == target:
                match_sum += 1
        rate_xor = match_xor / n_frames if n_frames > 0 else 0
        rate_sum = match_sum / n_frames if n_frames > 0 else 0
        local_best = max(rate_xor, rate_sum)
        if local_best >= threshold and local_best > best_rate:
            best_rate = local_best
            best_k = k
            best_algo = "xor8" if rate_xor >= rate_sum else "sum8"

    if best_k >= 0:
        checksums[best_k] = {
            "type": "checksum",
            "algo": best_algo,
            "match_rate": round(best_rate, 4),
        }
    return checksums


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




# =============================================================================
# Inter-ID Dependency Detection
# =============================================================================

class DependencyRequest(BaseModel):
    mission_id: Optional[str] = None
    log_path: Optional[str] = None
    log_id: Optional[str] = None
    window_ms: float = 10.0
    min_score: float = 0.1
    top_n: int = 30



# =============================================================================
# Causality Validation (inject source, observe target reaction)
# =============================================================================

class CausalityRequest(BaseModel):
    source_id: str
    target_id: str
    interface: str = "can0"
    window_ms: float = 50.0
    repeat: int = 5
    pause_ms: float = 200.0
    mission_id: Optional[str] = None
    log_id: Optional[str] = None



# SessionAuthMiddleware (ASGI pur, couvre les WebSocket) enveloppe l'app, et CORS
# enveloppe l'auth : 401/403 portent les en-tetes CORS. Ne rien declarer apres.
from routers.missions_core import router as missions_core_router  # noqa: E402
app.include_router(missions_core_router)
from routers.missions_dbc import router as missions_dbc_router  # noqa: E402
app.include_router(missions_dbc_router)
from routers.missions_compare import router as missions_compare_router  # noqa: E402
app.include_router(missions_compare_router)
from routers.dbc import router as dbc_router  # noqa: E402
app.include_router(dbc_router)
from routers.analysis import router as analysis_router  # noqa: E402
app.include_router(analysis_router)
fastapi_app = app
app = CORSMiddleware(
    SessionAuthMiddleware(fastapi_app),
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
