"""
AURIGE - CAN Bus Analysis API
FastAPI backend for Raspberry Pi 5
"""

import os
import json
import shutil
from datetime import datetime
from pathlib import Path
from typing import Optional
from uuid import uuid4

from fastapi import FastAPI, HTTPException, UploadFile, File, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

# Configuration
DATA_DIR = Path(os.getenv("AURIGE_DATA_DIR", "/opt/aurige/data"))
MISSIONS_DIR = DATA_DIR / "missions"
LOGS_DIR = DATA_DIR / "logs"

# Ensure directories exist
MISSIONS_DIR.mkdir(parents=True, exist_ok=True)
LOGS_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(
    title="AURIGE API",
    description="CAN Bus Analysis API for Raspberry Pi",
    version="1.0.0",
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================================
# Models
# ============================================================================

class Vehicle(BaseModel):
    brand: str
    model: str
    year: int
    vin: Optional[str] = None
    fuel: Optional[str] = None
    engine: Optional[str] = None
    trim: Optional[str] = None


class MissionCreate(BaseModel):
    name: str
    notes: Optional[str] = None
    vehicle: Vehicle
    can_interface: str = Field(default="can0", alias="canInterface")
    bitrate: int = 500000

    class Config:
        populate_by_name = True


class MissionUpdate(BaseModel):
    name: Optional[str] = None
    notes: Optional[str] = None
    vehicle: Optional[Vehicle] = None
    can_interface: Optional[str] = Field(default=None, alias="canInterface")
    bitrate: Optional[int] = None

    class Config:
        populate_by_name = True


class Mission(BaseModel):
    id: str
    name: str
    notes: Optional[str] = None
    vehicle: Vehicle
    can_interface: str = Field(alias="canInterface")
    bitrate: int
    created_at: datetime = Field(alias="createdAt")
    updated_at: datetime = Field(alias="updatedAt")
    last_activity: datetime = Field(alias="lastActivity")
    logs_count: int = Field(alias="logsCount")
    frames_count: int = Field(alias="framesCount")
    last_capture_date: Optional[datetime] = Field(default=None, alias="lastCaptureDate")

    class Config:
        populate_by_name = True


class LogEntry(BaseModel):
    id: str
    mission_id: str = Field(alias="missionId")
    filename: str
    size: int
    frames_count: int = Field(alias="framesCount")
    created_at: datetime = Field(alias="createdAt")
    duration_seconds: Optional[int] = Field(default=None, alias="durationSeconds")
    description: Optional[str] = None

    class Config:
        populate_by_name = True


class SystemStatus(BaseModel):
    wifi_connected: bool = Field(alias="wifiConnected")
    ethernet_connected: bool = Field(alias="ethernetConnected")
    cpu_usage: float = Field(alias="cpuUsage")
    temperature: float
    memory_used: float = Field(alias="memoryUsed")
    memory_total: float = Field(alias="memoryTotal")
    storage_used: float = Field(alias="storageUsed")
    storage_total: float = Field(alias="storageTotal")
    uptime_seconds: int = Field(alias="uptimeSeconds")
    can0_up: bool = Field(alias="can0Up")
    can1_up: bool = Field(alias="can1Up")
    vehicle_connected: bool = Field(alias="vehicleConnected")
    ecu_responding: bool = Field(alias="ecuResponding")
    api_running: bool = Field(alias="apiRunning")
    web_running: bool = Field(alias="webRunning")

    class Config:
        populate_by_name = True


# ============================================================================
# Helper Functions
# ============================================================================

def get_mission_file(mission_id: str) -> Path:
    return MISSIONS_DIR / f"{mission_id}.json"


def get_mission_logs_dir(mission_id: str) -> Path:
    path = LOGS_DIR / mission_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def load_mission(mission_id: str) -> dict:
    file_path = get_mission_file(mission_id)
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Mission not found")
    with open(file_path, "r") as f:
        return json.load(f)


def save_mission(mission_id: str, data: dict):
    file_path = get_mission_file(mission_id)
    with open(file_path, "w") as f:
        json.dump(data, f, indent=2, default=str)


def list_all_missions() -> list[dict]:
    missions = []
    for file_path in MISSIONS_DIR.glob("*.json"):
        try:
            with open(file_path, "r") as f:
                missions.append(json.load(f))
        except Exception:
            continue
    return sorted(missions, key=lambda x: x.get("updatedAt", ""), reverse=True)


def count_mission_logs(mission_id: str) -> int:
    logs_dir = LOGS_DIR / mission_id
    if not logs_dir.exists():
        return 0
    return len(list(logs_dir.glob("*.log")))


def count_mission_frames(mission_id: str) -> int:
    """Count total frames across all logs in a mission"""
    logs_dir = LOGS_DIR / mission_id
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
    """Get Raspberry Pi system status"""
    import subprocess
    
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
        result = subprocess.run(["ip", "link", "show"], capture_output=True, text=True)
        output = result.stdout
        wifi_connected = "wlan0" in output and "UP" in output
        ethernet_connected = "eth0" in output and "UP" in output
    except Exception:
        wifi_connected = False
        ethernet_connected = True
    
    # CAN interfaces
    try:
        result = subprocess.run(["ip", "link", "show"], capture_output=True, text=True)
        output = result.stdout
        can0_up = "can0" in output and "UP" in output
        can1_up = "can1" in output and "UP" in output
    except Exception:
        can0_up = False
        can1_up = False
    
    # Services
    try:
        api_result = subprocess.run(
            ["systemctl", "is-active", "aurige-api"],
            capture_output=True, text=True
        )
        api_running = api_result.stdout.strip() == "active"
    except Exception:
        api_running = True  # If we're responding, API is running
    
    try:
        web_result = subprocess.run(
            ["systemctl", "is-active", "aurige-web"],
            capture_output=True, text=True
        )
        web_running = web_result.stdout.strip() == "active"
    except Exception:
        web_running = True
    
    return SystemStatus(
        wifiConnected=wifi_connected,
        ethernetConnected=ethernet_connected,
        cpuUsage=round(cpu_usage, 1),
        temperature=round(temperature, 1),
        memoryUsed=round(memory_used, 0),
        memoryTotal=round(memory_total, 0),
        storageUsed=round(storage_used, 1),
        storageTotal=round(storage_total, 1),
        uptimeSeconds=uptime_seconds,
        can0Up=can0_up,
        can1Up=can1_up,
        vehicleConnected=can0_up or can1_up,
        ecuResponding=False,  # Would need actual CAN communication
        apiRunning=api_running,
        webRunning=web_running,
    )


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
    """Create a new mission"""
    mission_id = str(uuid4())
    now = datetime.now().isoformat()
    
    mission = {
        "id": mission_id,
        "name": mission_data.name,
        "notes": mission_data.notes,
        "vehicle": mission_data.vehicle.model_dump(),
        "canInterface": mission_data.can_interface,
        "bitrate": mission_data.bitrate,
        "createdAt": now,
        "updatedAt": now,
        "lastActivity": now,
        "logsCount": 0,
        "framesCount": 0,
        "lastCaptureDate": None,
    }
    
    save_mission(mission_id, mission)
    get_mission_logs_dir(mission_id)  # Create logs directory
    
    return Mission(**mission)


@app.get("/api/missions/{mission_id}", response_model=Mission)
async def get_mission(mission_id: str):
    """Get a single mission"""
    mission = load_mission(mission_id)
    
    # Update counts
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
    
    mission.update(update_data)
    mission["updatedAt"] = datetime.now().isoformat()
    mission["lastActivity"] = datetime.now().isoformat()
    
    save_mission(mission_id, mission)
    
    return Mission(**mission)


@app.delete("/api/missions/{mission_id}")
async def delete_mission(mission_id: str):
    """Delete a mission and all its logs"""
    file_path = get_mission_file(mission_id)
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Mission not found")
    
    # Delete mission file
    file_path.unlink()
    
    # Delete logs directory
    logs_dir = LOGS_DIR / mission_id
    if logs_dir.exists():
        shutil.rmtree(logs_dir)
    
    return {"status": "deleted", "id": mission_id}


@app.post("/api/missions/{mission_id}/duplicate", response_model=Mission)
async def duplicate_mission(mission_id: str):
    """Duplicate a mission"""
    original = load_mission(mission_id)
    
    new_id = str(uuid4())
    now = datetime.now().isoformat()
    
    new_mission = {
        **original,
        "id": new_id,
        "name": f"{original['name']} (copie)",
        "createdAt": now,
        "updatedAt": now,
        "lastActivity": now,
        "logsCount": 0,
        "framesCount": 0,
        "lastCaptureDate": None,
    }
    
    save_mission(new_id, new_mission)
    get_mission_logs_dir(new_id)
    
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
        
        # Count frames
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
    
    # Update mission
    mission = load_mission(mission_id)
    mission["logsCount"] = count_mission_logs(mission_id)
    mission["framesCount"] = count_mission_frames(mission_id)
    mission["updatedAt"] = datetime.now().isoformat()
    save_mission(mission_id, mission)
    
    return {"status": "deleted", "id": log_id}


# ============================================================================
# Health Check
# ============================================================================

@app.get("/api/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "timestamp": datetime.now().isoformat(),
        "version": "1.0.0",
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
