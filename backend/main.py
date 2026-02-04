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
import json
import shutil
import asyncio
import subprocess
import signal
import time
from datetime import datetime
from pathlib import Path
from typing import Optional
from uuid import uuid4
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

# =============================================================================
# Configuration
# =============================================================================

DATA_DIR = Path(os.getenv("AURIGE_DATA_DIR", "/opt/aurige/data"))
MISSIONS_DIR = DATA_DIR / "missions"

# Ensure directories exist
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
    """Cleanup on shutdown"""
    yield
    # Stop all processes
    for proc in [state.candump_process, state.capture_process, 
                 state.cangen_process, state.canplayer_process, state.fuzzing_process]:
        if proc and proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=2.0)
            except asyncio.TimeoutError:
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
    data_template: str = Field(alias="dataTemplate")  # Hex
    iterations: int = 100
    delay_ms: int = Field(alias="delayMs", default=10)

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

def get_mission_dir(mission_id: str) -> Path:
    """Get mission directory path"""
    return MISSIONS_DIR / mission_id


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
# System Status Endpoints
# =============================================================================

@app.get("/api/status", response_model=SystemStatus)
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
    
    # Temperature
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
    
    # Build canplayer command
    # -I: input file, -l i: loop count (1 = once), -g gap: gap between frames
    cmd = ["canplayer", "-I", str(log_file)]
    
    if request.speed != 1.0:
        # Adjust timing - canplayer doesn't have direct speed control
        # but we can use -g for gap multiplier
        gap = int(1000 / request.speed)  # microseconds
        cmd.extend(["-g", str(gap)])
    
    # Map interface
    cmd.append(f"{request.interface}={request.interface}")
    
    state.canplayer_process = await run_command_async(cmd)
    
    return {
        "status": "started",
        "missionId": request.mission_id,
        "logId": request.log_id,
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
    Start fuzzing - sends frames with incrementing IDs.
    This uses a Python loop with cansend for precise control.
    """
    if state.fuzzing_process and state.fuzzing_process.returncode is None:
        raise HTTPException(status_code=409, detail="Fuzzing already running")
    
    # Create a temporary script for fuzzing
    script_content = f'''#!/bin/bash
start_id=$((16#{request.id_start}))
end_id=$((16#{request.id_end}))
data="{request.data_template}"
delay_sec=$(echo "scale=6; {request.delay_ms}/1000" | bc)

for ((i=0; i<{request.iterations}; i++)); do
    current_id=$((start_id + (end_id - start_id) * i / {request.iterations}))
    hex_id=$(printf "%03X" $current_id)
    cansend {request.interface} "${{hex_id}}#${{data}}"
    sleep $delay_sec
done
'''
    
    script_path = Path("/tmp/aurige_fuzz.sh")
    with open(script_path, "w") as f:
        f.write(script_content)
    script_path.chmod(0o755)
    
    state.fuzzing_process = await run_command_async(["bash", str(script_path)])
    
    return {
        "status": "started",
        "interface": request.interface,
        "idRange": f"{request.id_start}-{request.id_end}",
        "iterations": request.iterations,
    }


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
    is_running = state.fuzzing_process and state.fuzzing_process.returncode is None
    return {"running": is_running}


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
        if meta.get("parentLog"):
            parent_id = meta.get("parentLog")
        elif meta.get("splitFrom"):
            parent_id = meta.get("splitFrom")
        # Fallback: detect by naming convention (_A, _B suffixes)
        # For nested splits like foo_A_B, parent is foo_A (not foo)
        elif log_stem.endswith(("_A", "_B", "_a", "_b")):
            potential_parent = log_stem[:-2]  # Remove _A, _B, _a, or _b
            if potential_parent in log_names:
                parent_id = potential_parent
        
        # Check if this log has children (is an origin) - check both cases
        if (f"{log_stem}_A" in log_names or f"{log_stem}_B" in log_names or
            f"{log_stem}_a" in log_names or f"{log_stem}_b" in log_names):
            is_origin = True
        
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
        ))
    
    return sorted(logs, key=lambda x: x.created_at, reverse=True)


@app.get("/api/missions/{mission_id}/logs/{log_id}/download")
async def download_log(mission_id: str, log_id: str):
    """Download a log file"""
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
    
    # Find all children recursively (log_A, log_B, log_A_A, log_A_B, etc.)
    def find_children(parent_stem: str):
        for suffix in ["_A", "_B", "_a", "_b"]:  # Check both cases
            child_stem = f"{parent_stem}{suffix}"
            child_file = logs_dir / f"{child_stem}.log"
            if child_file.exists():
                family_files.append(child_file)
                find_children(child_stem)  # Recursively find grandchildren
    
    find_children(log_id)
    
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
            background=None,  # Don't delete immediately
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
    """Delete a log file"""
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
        old_meta_file.rename(new_meta_file)
    
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
    
    # Save metadata
    now = datetime.now().isoformat()
    for log_new_id, parent in [(log_a_id, log_id), (log_b_id, log_id)]:
        meta = {
            "createdAt": now,
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
    return {
        "status": "success" if responses else "sent",
        "message": "VIN request completed" if responses else "VIN request sent, waiting for response",
        "data": responses[0] if responses else None,
        "frames": responses,
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
    return {
        "status": "success" if responses else "sent",
        "message": "DTC read completed" if responses else "DTC request sent",
        "frames": responses,
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
            results["vin"] = vin_result["responses"]
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
            results["dtcs"] = dtc_result["responses"]
        else:
            f.write(f"Error: {dtc_result['error']}\n")
            results["dtcs"] = []
    
    results["logFile"] = str(log_path)
    
    return {
        "status": "completed",
        "message": "Full OBD scan completed",
        "results": results,
    }


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
        
        # Detect internet source by checking default route
        internet_source = ""
        internet_interface = ""
        internet_via = ""
        if is_hotspot:
            # Check default route to find how we get internet
            route_result = run_command(["ip", "route", "show", "default"], check=False)
            if route_result.returncode == 0:
                for line in route_result.stdout.strip().split("\n"):
                    if "default" in line:
                        parts = line.split()
                        # Find interface (after "dev")
                        if "dev" in parts:
                            idx = parts.index("dev")
                            if idx + 1 < len(parts):
                                internet_interface = parts[idx + 1]
                        break
                
                # Determine source type based on interface
                if internet_interface == "eth0":
                    internet_source = "Ethernet"
                elif internet_interface.startswith("usb") or internet_interface.startswith("enx"):
                    internet_source = "USB Tethering"
                elif internet_interface == "wlan1":
                    # Second WiFi adapter - get its SSID
                    ssid_result = run_command(["iwgetid", "-r", internet_interface], check=False)
                    if ssid_result.returncode == 0 and ssid_result.stdout.strip():
                        internet_via = ssid_result.stdout.strip()
                    internet_source = "WiFi (wlan1)"
                elif internet_interface:
                    internet_source = internet_interface
        
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
    """Connect to a Wi-Fi network"""
    try:
        # First check if this network is already saved
        saved_result = run_command(["nmcli", "-t", "-f", "NAME,TYPE", "connection", "show"], check=False)
        is_saved = False
        if saved_result.returncode == 0:
            for line in saved_result.stdout.strip().split("\n"):
                parts = line.split(":")
                if len(parts) >= 2 and parts[0] == request.ssid and parts[1] == "802-11-wireless":
                    is_saved = True
                    break
        
        if is_saved:
            # Network is saved, just activate it (no password needed)
            result = run_command([
                "nmcli", "connection", "up", request.ssid
            ], check=False, timeout=30)
        elif request.password:
            # New network with password - nmcli auto-detects security type
            result = run_command([
                "nmcli", "device", "wifi", "connect", request.ssid,
                "password", request.password
            ], check=False, timeout=30)
        else:
            # Try to connect to open network
            result = run_command([
                "nmcli", "device", "wifi", "connect", request.ssid
            ], check=False, timeout=30)
        
        if result.returncode == 0:
            # Enable autoconnect for this network
            run_command([
                "nmcli", "connection", "modify", request.ssid,
                "connection.autoconnect", "yes",
                "connection.autoconnect-priority", "100"
            ], check=False)
            return {"status": "success", "message": f"Connecte a {request.ssid}"}
        else:
            error_msg = result.stderr.strip() if result.stderr else result.stdout.strip() if result.stdout else "Connexion echouee"
            return {"status": "error", "message": error_msg}
    except Exception as e:
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
async def start_update():
    """Start update by fresh clone and install script"""
    global update_output_store
    if update_output_store["running"]:
        return {"status": "error", "message": "Une mise à jour est déjà en cours"}
    
    update_output_store = {"lines": [], "running": True, "command": "update"}
    
    # GitHub repo URL and target branch
    GITHUB_REPO = "https://github.com/Yo-ETE/v0-aurige-ui-design.git"
    TARGET_BRANCH = "v0/main-37135798"
    
    # Check for saved branch preference
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
            update_output_store["lines"].append(f">>> Checkout de la branche {TARGET_BRANCH}...")
            checkout_proc = await asyncio.create_subprocess_exec(
                "sudo", "git", "-C", GIT_REPO_PATH, "checkout", TARGET_BRANCH,
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
                update_output_store["lines"].append(f">>> Branche {TARGET_BRANCH} non trouvee, utilisation de main")
                fallback_proc = await asyncio.create_subprocess_exec(
                    "sudo", "git", "-C", GIT_REPO_PATH, "checkout", "main",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                )
                await fallback_proc.wait()
            else:
                update_output_store["lines"].append(f"[OK] Branche {TARGET_BRANCH}")
            
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
                update_output_store["lines"].append("[OK] Mise a jour terminee! Rechargez la page.")
            
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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
