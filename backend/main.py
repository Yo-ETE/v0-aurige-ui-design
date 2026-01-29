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
    ethernet_connected: bool = Field(alias="ethernetConnected")
    ethernet_ip: Optional[str] = Field(default=None, alias="ethernetIp")
    can0_up: bool = Field(alias="can0Up")
    can0_bitrate: Optional[int] = Field(default=None, alias="can0Bitrate")
    can1_up: bool = Field(alias="can1Up")
    can1_bitrate: Optional[int] = Field(default=None, alias="can1Bitrate")
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


def update_mission_stats(mission_id: str):
    """Update mission log/frame counts"""
    mission = load_mission(mission_id)
    logs_dir = get_mission_logs_dir(mission_id)
    
    logs_count = 0
    frames_count = 0
    for log_file in logs_dir.glob("*.log"):
        logs_count += 1
        frames_count += count_log_frames(log_file)
    
    mission["logsCount"] = logs_count
    mission["framesCount"] = frames_count
    mission["updatedAt"] = datetime.now().isoformat()
    save_mission(mission_id, mission)


# =============================================================================
# Helper Functions - CAN Commands (Linux can-utils)
# =============================================================================

def run_command(cmd: list[str], check: bool = True) -> subprocess.CompletedProcess:
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
            timeout=10,
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
    """
    try:
        result = run_command(["ip", "-details", "-json", "link", "show", interface], check=False)
        if result.returncode != 0:
            return CANInterfaceStatus(interface=interface, up=False)
        
        data = json.loads(result.stdout)
        if not data:
            return CANInterfaceStatus(interface=interface, up=False)
        
        iface_data = data[0]
        operstate = iface_data.get("operstate", "DOWN")
        up = operstate.upper() == "UP"
        
        # Extract bitrate from linkinfo
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


def can_send_frame(interface: str, can_id: str, data: str):
    """
    Send a single CAN frame.
    Uses: cansend can0 7DF#02010C
    
    Args:
        interface: CAN interface (can0, can1)
        can_id: CAN ID in hex (e.g., "7DF", "18DAF110")
        data: Data bytes in hex (e.g., "02010C" or "02 01 0C")
    """
    # Clean up data - remove spaces
    data_clean = data.replace(" ", "").upper()
    can_id_clean = can_id.replace("0x", "").upper()
    
    frame = f"{can_id_clean}#{data_clean}"
    run_command(["cansend", interface, frame])


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
    try:
        result = run_command(["ip", "-json", "addr", "show", "wlan0"], check=False)
        if result.returncode == 0:
            data = json.loads(result.stdout)
            if data:
                for addr_info in data[0].get("addr_info", []):
                    if addr_info.get("family") == "inet":
                        wifi_ip = addr_info.get("local")
                        wifi_connected = True
                        break
    except Exception:
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
        ethernetConnected=ethernet_connected,
        ethernetIp=ethernet_ip,
        can0Up=can0_status.up,
        can0Bitrate=can0_status.bitrate,
        can1Up=can1_status.up,
        can1Bitrate=can1_status.bitrate,
        apiRunning=api_running,
        webRunning=web_running,
    )


@app.get("/api/can/{interface}/status", response_model=CANInterfaceStatus)
async def get_can_status(interface: str):
    """Get status of a specific CAN interface"""
    if interface not in ["can0", "can1"]:
        raise HTTPException(status_code=400, detail="Invalid interface. Use can0 or can1.")
    return get_can_interface_status(interface)


# =============================================================================
# CAN Control Endpoints
# =============================================================================

@app.post("/api/can/init")
async def initialize_can(request: CANInitRequest):
    """
    Initialize a CAN interface with specified bitrate.
    
    Executes:
    - ip link set canX down
    - ip link set canX type can bitrate BITRATE
    - ip link set canX up
    """
    if request.interface not in ["can0", "can1"]:
        raise HTTPException(status_code=400, detail="Invalid interface")
    
    if request.bitrate not in [20000, 50000, 100000, 125000, 250000, 500000, 800000, 1000000]:
        raise HTTPException(status_code=400, detail="Invalid bitrate")
    
    can_interface_up(request.interface, request.bitrate)
    
    return {
        "status": "initialized",
        "interface": request.interface,
        "bitrate": request.bitrate,
    }


@app.post("/api/can/stop")
async def stop_can(interface: str = "can0"):
    """
    Stop a CAN interface.
    
    Executes: ip link set canX down
    """
    if interface not in ["can0", "can1"]:
        raise HTTPException(status_code=400, detail="Invalid interface")
    
    can_interface_down(interface)
    
    return {"status": "stopped", "interface": interface}


@app.post("/api/can/send")
async def send_can_frame(frame: CANFrame):
    """
    Send a single CAN frame.
    
    Executes: cansend canX ID#DATA
    """
    if frame.interface not in ["can0", "can1"]:
        raise HTTPException(status_code=400, detail="Invalid interface")
    
    can_send_frame(frame.interface, frame.can_id, frame.data)
    
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
        
        # Update mission stats
        mission_id = state.capture_file.parent.parent.name
        update_mission_stats(mission_id)
        
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
    }
    
    save_mission(new_id, new_mission)
    get_mission_logs_dir(new_id)
    
    return Mission(**new_mission)


# =============================================================================
# Log Endpoints
# =============================================================================

@app.get("/api/missions/{mission_id}/logs", response_model=list[LogEntry])
async def list_mission_logs(mission_id: str):
    """List all logs for a mission"""
    load_mission(mission_id)  # Verify exists
    
    logs_dir = get_mission_logs_dir(mission_id)
    logs = []
    
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
        
        logs.append(LogEntry(
            id=log_file.stem,
            filename=log_file.name,
            size=stat.st_size,
            framesCount=frames_count,
            createdAt=datetime.fromtimestamp(stat.st_ctime),
            durationSeconds=meta.get("durationSeconds"),
            description=meta.get("description"),
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


async def obd_send_with_flow_control(interface: str, request_id: str, request_data: str, response_id: str = "7E8") -> list[str]:
    """
    Send an OBD-II request and handle ISO-TP flow control for multi-frame responses.
    
    For multi-frame responses:
    1. First frame starts with 0x10 (indicates more frames coming)
    2. We send flow control: targetID#3000000000000000
    3. Consecutive frames start with 0x21, 0x22, etc.
    """
    # Calculate flow control target (response_id - 8)
    flow_target = f"{int(response_id, 16) - 8:03X}"
    
    # Start candump to capture response
    log_file = Path(f"/tmp/obd_response_{int(time.time())}.log")
    
    candump = await asyncio.create_subprocess_exec(
        "candump", "-L", "-ta", f"{interface},{request_id}:7FF,{response_id}:{response_id}",
        stdout=open(log_file, "w"),
        stderr=asyncio.subprocess.DEVNULL,
    )
    
    try:
        await asyncio.sleep(0.05)  # Let candump start
        
        # Send the OBD request
        can_send_frame(interface, request_id, request_data)
        await asyncio.sleep(0.05)
        
        # Send flow control for multi-frame responses
        can_send_frame(interface, flow_target, "3000000000000000")
        
        # Wait for response
        await asyncio.sleep(1.0)
        
    finally:
        candump.terminate()
        try:
            await asyncio.wait_for(candump.wait(), timeout=2.0)
        except asyncio.TimeoutError:
            candump.kill()
    
    # Read captured response
    responses = []
    if log_file.exists():
        with open(log_file, "r") as f:
            for line in f:
                if response_id.lower() in line.lower():
                    responses.append(line.strip())
        log_file.unlink()
    
    return responses


@app.post("/api/obd/vin")
async def read_vin(request: OBDRequest):
    """
    Read Vehicle Identification Number via OBD-II.
    
    Protocol:
    1. Send: 7DF#0209020000000000 (Service 09, PID 02 - VIN request)
    2. Send: 7E0#3000000000000000 (Flow control)
    3. Receive multi-frame response on 7E8
    """
    responses = await obd_send_with_flow_control(
        request.interface,
        "7DF",
        "0209020000000000",
        "7E8"
    )
    
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
    responses = await obd_send_with_flow_control(
        request.interface,
        "7DF",
        "0103000000000000",
        "7E8"
    )
    
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
    can_send_frame(request.interface, "7DF", "0104000000000000")
    await asyncio.sleep(0.1)
    
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
    can_send_frame(request.interface, "7DF", "0211010000000000")
    
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
            can_send_frame(request.interface, "7DF", f"0201{pid_hex}0000000000")
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
        vin_responses = await obd_send_with_flow_control(
            request.interface, "7DF", "0209020000000000", "7E8"
        )
        for line in vin_responses:
            f.write(line + "\n")
        results["vin"] = vin_responses
        
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
            can_send_frame(request.interface, "7DF", f"0201{pid:02X}0000000000")
            await asyncio.sleep(0.1)
        
        await asyncio.sleep(0.5)
        candump.terminate()
        
        f.write("\n########## DTCs DU VEHICULE ##########\n")
        
        # 3. Request DTCs
        dtc_responses = await obd_send_with_flow_control(
            request.interface, "7DF", "0103000000000000", "7E8"
        )
        for line in dtc_responses:
            f.write(line + "\n")
        results["dtcs"] = dtc_responses
    
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
    can_send_frame(interface, "7DF", data)
    
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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
