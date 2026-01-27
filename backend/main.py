"""
AURIGE - CAN Bus Analysis API
FastAPI backend for Raspberry Pi 5

ARCHITECTURAL SEPARATION:
- This backend is the ONLY component that executes system commands
- All CAN operations go through the CANController
- Frontend talks only to /api/* and /ws/* endpoints
- No shell commands are executed from the frontend

This file implements:
- REST API for missions, logs, and system status
- WebSocket for real-time CAN streaming
- Filesystem-based mission persistence
"""

import asyncio
import json
import logging
import os
import shutil
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Optional
from uuid import uuid4

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from can_controller import can_controller, CANFrame

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# ============================================================================
# Configuration
# ============================================================================

DATA_DIR = Path(os.getenv("AURIGE_DATA_DIR", "/opt/aurige/data"))
MISSIONS_DIR = DATA_DIR / "missions"
LOGS_DIR = DATA_DIR / "logs"

# Ensure directories exist
MISSIONS_DIR.mkdir(parents=True, exist_ok=True)
LOGS_DIR.mkdir(parents=True, exist_ok=True)


# ============================================================================
# Lifespan Management
# ============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan manager"""
    logger.info("AURIGE API starting up...")
    logger.info(f"Data directory: {DATA_DIR}")
    yield
    logger.info("AURIGE API shutting down...")
    await can_controller.cleanup()


# ============================================================================
# FastAPI Application
# ============================================================================

app = FastAPI(
    title="AURIGE API",
    description="CAN Bus Analysis API for Raspberry Pi - System Authority",
    version="2.0.0",
    lifespan=lifespan,
)

# CORS middleware for frontend access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================================
# Pydantic Models
# ============================================================================

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
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")
    logs_count: int = Field(alias="logsCount")
    frames_count: int = Field(alias="framesCount")

    class Config:
        populate_by_name = True


class LogEntry(BaseModel):
    id: str
    mission_id: str = Field(alias="missionId")
    filename: str
    size: int
    frames_count: int = Field(alias="framesCount")
    created_at: str = Field(alias="createdAt")
    duration_seconds: Optional[int] = Field(default=None, alias="durationSeconds")
    description: Optional[str] = None

    class Config:
        populate_by_name = True


class CANInterfaceInfo(BaseModel):
    name: str
    is_up: bool = Field(alias="isUp")
    bitrate: Optional[int] = None
    tx_packets: int = Field(alias="txPackets")
    rx_packets: int = Field(alias="rxPackets")
    tx_errors: int = Field(alias="txErrors")
    rx_errors: int = Field(alias="rxErrors")

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
    ethernet_connected: bool = Field(alias="ethernetConnected")
    can_interfaces: list[CANInterfaceInfo] = Field(alias="canInterfaces")
    api_version: str = Field(alias="apiVersion")

    class Config:
        populate_by_name = True


class CANSetupRequest(BaseModel):
    interface: str = "can0"
    bitrate: int = 500000


class CANSendRequest(BaseModel):
    interface: str = "can0"
    can_id: str = Field(alias="canId")
    data: str

    class Config:
        populate_by_name = True


class CaptureStartRequest(BaseModel):
    interface: str = "can0"
    mission_id: str = Field(alias="missionId")
    filename: str

    class Config:
        populate_by_name = True


class ReplayStartRequest(BaseModel):
    mission_id: str = Field(alias="missionId")
    filename: str
    interface: str = "can0"
    speed: float = 1.0
    loop: bool = False

    class Config:
        populate_by_name = True


class GeneratorStartRequest(BaseModel):
    interface: str = "can0"
    can_id: Optional[str] = Field(default=None, alias="canId")
    data_length: int = Field(default=8, alias="dataLength")
    gap_ms: int = Field(default=100, alias="gapMs")
    burst_count: Optional[int] = Field(default=None, alias="burstCount")

    class Config:
        populate_by_name = True


# ============================================================================
# Helper Functions - Mission Storage
# ============================================================================

def get_mission_dir(mission_id: str) -> Path:
    """Get the directory for a mission"""
    return MISSIONS_DIR / mission_id


def get_mission_file(mission_id: str) -> Path:
    """Get the mission.json file path"""
    return get_mission_dir(mission_id) / "mission.json"


def get_mission_logs_dir(mission_id: str) -> Path:
    """Get the logs directory for a mission"""
    logs_dir = get_mission_dir(mission_id) / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    return logs_dir


def load_mission(mission_id: str) -> dict:
    """Load a mission from disk"""
    file_path = get_mission_file(mission_id)
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Mission not found")
    with open(file_path, "r") as f:
        return json.load(f)


def save_mission(mission_id: str, data: dict):
    """Save a mission to disk"""
    mission_dir = get_mission_dir(mission_id)
    mission_dir.mkdir(parents=True, exist_ok=True)
    file_path = get_mission_file(mission_id)
    with open(file_path, "w") as f:
        json.dump(data, f, indent=2, default=str)


def list_all_missions() -> list[dict]:
    """List all missions from disk"""
    missions = []
    for mission_dir in MISSIONS_DIR.iterdir():
        if mission_dir.is_dir():
            mission_file = mission_dir / "mission.json"
            if mission_file.exists():
                try:
                    with open(mission_file, "r") as f:
                        missions.append(json.load(f))
                except Exception as e:
                    logger.error(f"Failed to load mission {mission_dir.name}: {e}")
    return sorted(missions, key=lambda x: x.get("updatedAt", ""), reverse=True)


def count_mission_logs(mission_id: str) -> int:
    """Count log files in a mission"""
    logs_dir = get_mission_dir(mission_id) / "logs"
    if not logs_dir.exists():
        return 0
    return len(list(logs_dir.glob("*.log")))


def count_mission_frames(mission_id: str) -> int:
    """Count total frames across all logs in a mission"""
    logs_dir = get_mission_dir(mission_id) / "logs"
    if not logs_dir.exists():
        return 0
    
    total = 0
    for log_file in logs_dir.glob("*.log"):
        try:
            with open(log_file, "r") as f:
                total += sum(1 for _ in f)
        except Exception:
            continue
    return total


# ============================================================================
# System Status Endpoints
# ============================================================================

@app.get("/api/status", response_model=SystemStatus)
async def get_system_status():
    """
    Get comprehensive Raspberry Pi system status.
    
    Returns hostname, uptime, CPU, memory, storage, network, and CAN interface states.
    """
    import subprocess
    
    # Hostname
    try:
        hostname = os.uname().nodename
    except Exception:
        hostname = "aurige-pi"
    
    # CPU usage
    try:
        with open("/proc/stat", "r") as f:
            cpu_line = f.readline()
            cpu_values = [int(x) for x in cpu_line.split()[1:]]
            idle = cpu_values[3]
            total = sum(cpu_values)
            cpu_usage = 100.0 * (1 - idle / total)
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
            memory_total = meminfo.get("MemTotal", 0) / 1024  # MB
            memory_free = meminfo.get("MemAvailable", meminfo.get("MemFree", 0)) / 1024
            memory_used = memory_total - memory_free
    except Exception:
        memory_total = 8192.0
        memory_used = 4096.0
    
    # Storage
    try:
        statvfs = os.statvfs("/")
        storage_total = (statvfs.f_frsize * statvfs.f_blocks) / (1024 ** 3)  # GB
        storage_free = (statvfs.f_frsize * statvfs.f_bavail) / (1024 ** 3)
        storage_used = storage_total - storage_free
    except Exception:
        storage_total = 64.0
        storage_used = 32.0
    
    # Uptime
    try:
        with open("/proc/uptime", "r") as f:
            uptime_seconds = int(float(f.read().split()[0]))
    except Exception:
        uptime_seconds = 0
    
    # Network
    try:
        result = subprocess.run(["ip", "addr"], capture_output=True, text=True, timeout=5)
        output = result.stdout
        wifi_connected = "wlan0" in output and "inet " in output.split("wlan0")[1].split("wlan")[0] if "wlan0" in output else False
        ethernet_connected = "eth0" in output and "inet " in output.split("eth0")[1].split("eth")[0] if "eth0" in output else False
    except Exception:
        wifi_connected = False
        ethernet_connected = True
    
    # CAN interfaces status
    can_interfaces = []
    for iface in ["can0", "can1"]:
        try:
            status = await can_controller.get_interface_status(iface)
            can_interfaces.append(CANInterfaceInfo(
                name=status.name,
                isUp=status.is_up,
                bitrate=status.bitrate,
                txPackets=status.tx_packets,
                rxPackets=status.rx_packets,
                txErrors=status.tx_errors,
                rxErrors=status.rx_errors,
            ))
        except Exception:
            can_interfaces.append(CANInterfaceInfo(
                name=iface,
                isUp=False,
                bitrate=None,
                txPackets=0,
                rxPackets=0,
                txErrors=0,
                rxErrors=0,
            ))
    
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
        ethernetConnected=ethernet_connected,
        canInterfaces=can_interfaces,
        apiVersion="2.0.0",
    )


@app.get("/api/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "timestamp": datetime.now().isoformat(),
        "version": "2.0.0",
    }


# ============================================================================
# CAN Interface Endpoints
# ============================================================================

@app.post("/api/can/setup")
async def setup_can_interface(request: CANSetupRequest):
    """
    Initialize a CAN interface with the specified bitrate.
    
    This endpoint configures the CAN interface using ip link commands.
    Only the backend is authorized to execute these system commands.
    """
    try:
        success = await can_controller.setup_interface(request.interface, request.bitrate)
        if not success:
            raise HTTPException(status_code=500, detail="Failed to setup interface")
        
        status = await can_controller.get_interface_status(request.interface)
        return {
            "status": "success",
            "interface": request.interface,
            "bitrate": request.bitrate,
            "isUp": status.is_up,
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"CAN setup error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/can/down")
async def bring_can_down(interface: str = "can0"):
    """Bring a CAN interface down"""
    try:
        success = await can_controller.bring_interface_down(interface)
        return {"status": "success" if success else "failed", "interface": interface}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/can/send")
async def send_can_frame(request: CANSendRequest):
    """
    Send a single CAN frame.
    
    Uses cansend to transmit the frame on the specified interface.
    """
    try:
        success = await can_controller.send_frame(
            request.interface,
            request.can_id,
            request.data
        )
        if not success:
            raise HTTPException(status_code=500, detail="Failed to send frame")
        return {
            "status": "success",
            "interface": request.interface,
            "canId": request.can_id,
            "data": request.data,
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"CAN send error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# Capture Endpoints
# ============================================================================

# Track active captures
active_captures: dict[str, str] = {}  # capture_id -> mission_id


@app.post("/api/can/capture/start")
async def start_capture(request: CaptureStartRequest):
    """
    Start capturing CAN frames to a log file.
    
    Uses candump to capture all frames on the interface.
    Logs are stored in the mission's logs directory.
    """
    try:
        capture_id = await can_controller.start_capture(
            request.interface,
            request.mission_id,
            request.filename
        )
        active_captures[capture_id] = request.mission_id
        
        return {
            "status": "capturing",
            "captureId": capture_id,
            "interface": request.interface,
            "filename": request.filename,
        }
    except Exception as e:
        logger.error(f"Capture start error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/can/capture/stop")
async def stop_capture(capture_id: str):
    """Stop an active capture session"""
    try:
        success = await can_controller.stop_capture(capture_id)
        
        # Update mission stats
        if capture_id in active_captures:
            mission_id = active_captures[capture_id]
            try:
                mission = load_mission(mission_id)
                mission["logsCount"] = count_mission_logs(mission_id)
                mission["framesCount"] = count_mission_frames(mission_id)
                mission["updatedAt"] = datetime.now().isoformat()
                save_mission(mission_id, mission)
            except Exception:
                pass
            del active_captures[capture_id]
        
        return {"status": "stopped" if success else "not_found", "captureId": capture_id}
    except Exception as e:
        logger.error(f"Capture stop error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# Replay Endpoints
# ============================================================================

active_replays: dict[str, str] = {}


@app.post("/api/can/replay/start")
async def start_replay(request: ReplayStartRequest):
    """
    Start replaying a captured log file.
    
    Uses canplayer to replay the log at the specified speed.
    """
    try:
        replay_id = await can_controller.start_replay(
            request.mission_id,
            request.filename,
            request.interface,
            request.speed,
            request.loop
        )
        active_replays[replay_id] = request.mission_id
        
        return {
            "status": "replaying",
            "replayId": replay_id,
            "interface": request.interface,
            "filename": request.filename,
            "speed": request.speed,
            "loop": request.loop,
        }
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Log file not found")
    except Exception as e:
        logger.error(f"Replay start error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/can/replay/stop")
async def stop_replay(replay_id: str):
    """Stop an active replay session"""
    try:
        success = await can_controller.stop_replay(replay_id)
        if replay_id in active_replays:
            del active_replays[replay_id]
        return {"status": "stopped" if success else "not_found", "replayId": replay_id}
    except Exception as e:
        logger.error(f"Replay stop error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# Generator Endpoints
# ============================================================================

active_generators: dict[str, dict] = {}


@app.post("/api/can/generator/start")
async def start_generator(request: GeneratorStartRequest):
    """
    Start generating CAN traffic.
    
    Uses cangen to generate frames for testing.
    """
    try:
        generator_id = await can_controller.start_generator(
            request.interface,
            request.can_id,
            request.data_length,
            request.gap_ms,
            request.burst_count
        )
        active_generators[generator_id] = {
            "interface": request.interface,
            "canId": request.can_id,
            "gapMs": request.gap_ms,
        }
        
        return {
            "status": "generating",
            "generatorId": generator_id,
            "interface": request.interface,
        }
    except Exception as e:
        logger.error(f"Generator start error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/can/generator/stop")
async def stop_generator(generator_id: str):
    """Stop an active traffic generator"""
    try:
        success = await can_controller.stop_generator(generator_id)
        if generator_id in active_generators:
            del active_generators[generator_id]
        return {"status": "stopped" if success else "not_found", "generatorId": generator_id}
    except Exception as e:
        logger.error(f"Generator stop error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# WebSocket - Real-time CAN Streaming
# ============================================================================

@app.websocket("/ws/candump")
async def websocket_candump(
    websocket: WebSocket,
    interface: str = Query(default="can0")
):
    """
    WebSocket endpoint for real-time CAN frame streaming.
    
    Streams live candump output to connected clients.
    
    Query params:
        interface: CAN interface to monitor (default: can0)
    
    Messages sent:
        {"type": "frame", "data": {...frame data...}}
        {"type": "error", "message": "..."}
        {"type": "status", "status": "connected/disconnected"}
    """
    await websocket.accept()
    logger.info(f"WebSocket client connected for {interface}")
    
    try:
        # Validate interface
        try:
            can_controller._validate_interface(interface)
        except ValueError as e:
            await websocket.send_json({"type": "error", "message": str(e)})
            await websocket.close()
            return
        
        # Send connected status
        await websocket.send_json({"type": "status", "status": "connected", "interface": interface})
        
        # Stream candump output
        async for frame in can_controller.stream_candump(interface):
            await websocket.send_json({
                "type": "frame",
                "data": {
                    "timestamp": frame.timestamp,
                    "interface": frame.interface,
                    "canId": frame.can_id,
                    "data": frame.data,
                    "delta": frame.delta,
                }
            })
            
    except WebSocketDisconnect:
        logger.info(f"WebSocket client disconnected from {interface}")
    except asyncio.CancelledError:
        logger.info(f"WebSocket stream cancelled for {interface}")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except:
            pass
    finally:
        try:
            await websocket.close()
        except:
            pass


# ============================================================================
# Mission Endpoints
# ============================================================================

@app.get("/api/missions", response_model=list[Mission])
async def list_missions():
    """List all missions"""
    missions = list_all_missions()
    return [Mission(**m) for m in missions]


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
    
    logger.info(f"Created mission {mission_id}: {mission_data.name}")
    return Mission(**mission)


@app.get("/api/missions/{mission_id}", response_model=Mission)
async def get_mission(mission_id: str):
    """Get a single mission with updated counts"""
    mission = load_mission(mission_id)
    
    # Update counts from filesystem
    mission["logsCount"] = count_mission_logs(mission_id)
    mission["framesCount"] = count_mission_frames(mission_id)
    
    return Mission(**mission)


@app.patch("/api/missions/{mission_id}", response_model=Mission)
async def update_mission(mission_id: str, updates: MissionUpdate):
    """Update a mission"""
    mission = load_mission(mission_id)
    
    update_data = updates.model_dump(exclude_unset=True, by_alias=True)
    if "vehicle" in update_data and update_data["vehicle"]:
        update_data["vehicle"] = updates.vehicle.model_dump()
    if "canConfig" in update_data and update_data["canConfig"]:
        update_data["canConfig"] = updates.can_config.model_dump()
    
    mission.update(update_data)
    mission["updatedAt"] = datetime.now().isoformat()
    
    save_mission(mission_id, mission)
    logger.info(f"Updated mission {mission_id}")
    
    return Mission(**mission)


@app.delete("/api/missions/{mission_id}")
async def delete_mission(mission_id: str):
    """Delete a mission and all its data"""
    mission_dir = get_mission_dir(mission_id)
    if not mission_dir.exists():
        raise HTTPException(status_code=404, detail="Mission not found")
    
    # Delete entire mission directory (including logs)
    shutil.rmtree(mission_dir)
    logger.info(f"Deleted mission {mission_id}")
    
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
    logger.info(f"Duplicated mission {mission_id} -> {new_id}")
    
    return Mission(**new_mission)


# ============================================================================
# Log Endpoints
# ============================================================================

@app.get("/api/missions/{mission_id}/logs", response_model=list[LogEntry])
async def list_mission_logs(mission_id: str):
    """List all logs for a mission"""
    # Verify mission exists
    load_mission(mission_id)
    
    logs_dir = get_mission_logs_dir(mission_id)
    logs = []
    
    for log_file in logs_dir.glob("*.log"):
        stat = log_file.stat()
        
        # Count frames in log
        try:
            with open(log_file, "r") as f:
                frames_count = sum(1 for _ in f)
        except Exception:
            frames_count = 0
        
        # Try to read metadata
        meta_file = log_file.with_suffix(".meta.json")
        meta = {}
        if meta_file.exists():
            try:
                with open(meta_file, "r") as f:
                    meta = json.load(f)
            except Exception:
                pass
        
        logs.append(LogEntry(
            id=log_file.stem,
            missionId=mission_id,
            filename=log_file.name,
            size=stat.st_size,
            framesCount=frames_count,
            createdAt=datetime.fromtimestamp(stat.st_ctime).isoformat(),
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
    
    # Update mission counts
    mission = load_mission(mission_id)
    mission["logsCount"] = count_mission_logs(mission_id)
    mission["framesCount"] = count_mission_frames(mission_id)
    mission["updatedAt"] = datetime.now().isoformat()
    save_mission(mission_id, mission)
    
    logger.info(f"Deleted log {log_id} from mission {mission_id}")
    return {"status": "deleted", "id": log_id}


# ============================================================================
# Main Entry Point
# ============================================================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
