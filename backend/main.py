"""
AURIGE - CAN Bus Analysis API
FastAPI backend for Raspberry Pi 5

Compatibility layer:
- Exposes both /... and /api/... routes to match frontend expectations.
"""

import os
import json
import shutil
import asyncio
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Optional, List
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field


# =============================================================================
# Configuration
# =============================================================================

DATA_DIR = Path(os.getenv("AURIGE_DATA_DIR", "/opt/aurige/data"))
MISSIONS_DIR = DATA_DIR / "missions"
LOGS_DIR = DATA_DIR / "logs"

MISSIONS_DIR.mkdir(parents=True, exist_ok=True)
LOGS_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(
    title="AURIGE API",
    description="CAN Bus Analysis API for Raspberry Pi",
    version="1.0.2",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# =============================================================================
# Models
# =============================================================================

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


class CanInitRequest(BaseModel):
    interface: str = Field(default="can0")
    bitrate: int = Field(default=500000)
    mission_id: Optional[str] = Field(default=None, alias="mission_id")

    class Config:
        populate_by_name = True


# =============================================================================
# Helper Functions - Filesystem
# =============================================================================

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


def run_cmd(cmd: List[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, check=False)


def iface_is_up(name: str) -> bool:
    r = run_cmd(["ip", "link", "show", name])
    out = (r.stdout or "") + (r.stderr or "")
    return "state UP" in out or "UP" in out


# =============================================================================
# Candump Manager (multi-clients safe)
# =============================================================================

class CandumpManager:
    def __init__(self):
        self.process: Optional[asyncio.subprocess.Process] = None
        self.interface: Optional[str] = None
        self.task: Optional[asyncio.Task] = None
        self.lock = asyncio.Lock()
        self.clients: List[WebSocket] = []

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
    # CPU
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

    # Uptime
    try:
        with open("/proc/uptime", "r") as f:
            uptime_seconds = int(float(f.read().split()[0]))
    except Exception:
        uptime_seconds = 0

    wifi_connected = iface_is_up("wlan0")
    ethernet_connected = iface_is_up("eth0")
    can0_up = iface_is_up("can0")
    can1_up = iface_is_up("can1")

    def service_active(name: str) -> bool:
        r = run_cmd(["systemctl", "is-active", name])
        return (r.stdout or "").strip() == "active"

    api_running = service_active("aurige-api")
    web_running = service_active("aurige-web")

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
        ecuResponding=False,
        apiRunning=api_running,
        webRunning=web_running,
    )


# =============================================================================
# Missions
# =============================================================================

@app.get("/missions", response_model=list[Mission])
@app.get("/api/missions", response_model=list[Mission])  # alias
async def list_missions():
    missions = list_all_missions()
    return [Mission(**m) for m in missions]


@app.post("/missions", response_model=Mission)
@app.post("/api/missions", response_model=Mission)  # alias
async def create_mission(mission_data: MissionCreate):
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
    get_mission_logs_dir(mission_id)

    return Mission(**mission)


@app.get("/missions/{mission_id}", response_model=Mission)
@app.get("/api/missions/{mission_id}", response_model=Mission)  # alias
async def get_mission(mission_id: str):
    mission = load_mission(mission_id)
    mission["logsCount"] = count_mission_logs(mission_id)
    mission["framesCount"] = count_mission_frames(mission_id)
    return Mission(**mission)


@app.patch("/missions/{mission_id}", response_model=Mission)
@app.patch("/api/missions/{mission_id}", response_model=Mission)  # alias
async def update_mission(mission_id: str, updates: MissionUpdate):
    mission = load_mission(mission_id)

    update_data = updates.model_dump(exclude_unset=True, by_alias=True)
    if "vehicle" in update_data and update_data["vehicle"]:
        update_data["vehicle"] = updates.vehicle.model_dump()

    mission.update(update_data)
    now = datetime.now().isoformat()
    mission["updatedAt"] = now
    mission["lastActivity"] = now

    save_mission(mission_id, mission)
    return Mission(**mission)


@app.delete("/missions/{mission_id}")
@app.delete("/api/missions/{mission_id}")  # alias
async def delete_mission(mission_id: str):
    file_path = get_mission_file(mission_id)
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Mission not found")

    file_path.unlink()

    logs_dir = LOGS_DIR / mission_id
    if logs_dir.exists():
        shutil.rmtree(logs_dir)

    return {"status": "deleted", "id": mission_id}


@app.post("/missions/{mission_id}/duplicate", response_model=Mission)
@app.post("/api/missions/{mission_id}/duplicate", response_model=Mission)  # alias
async def duplicate_mission(mission_id: str):
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


# =============================================================================
# Logs
# =============================================================================

@app.get("/missions/{mission_id}/logs", response_model=list[LogEntry])
@app.get("/api/missions/{mission_id}/logs", response_model=list[LogEntry])  # alias
async def list_mission_logs(mission_id: str):
    load_mission(mission_id)

    logs_dir = get_mission_logs_dir(mission_id)
    logs: List[LogEntry] = []

    for log_file in logs_dir.glob("*.log"):
        stat = log_file.stat()

        try:
            with open(log_file, "r") as f:
                frames_count = sum(1 for _ in f)
        except Exception:
            frames_count = 0

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


@app.delete("/missions/{mission_id}/logs/{log_id}")
@app.delete("/api/missions/{mission_id}/logs/{log_id}")  # alias
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

    mission = load_mission(mission_id)
    mission["logsCount"] = count_mission_logs(mission_id)
    mission["framesCount"] = count_mission_frames(mission_id)
    mission["updatedAt"] = datetime.now().isoformat()
    save_mission(mission_id, mission)

    return {"status": "deleted", "id": log_id}


# =============================================================================
# CAN endpoints expected by frontend
# =============================================================================

@app.get("/can/{interface}/status")
@app.get("/api/can/{interface}/status")
async def can_status(interface: str):
    # Keep it simple: existence + link state
    r = run_cmd(["ip", "link", "show", interface])
    if r.returncode != 0:
        raise HTTPException(status_code=404, detail=f"Interface {interface} not found")
    return {
        "interface": interface,
        "up": iface_is_up(interface),
        "raw": (r.stdout or "").strip(),
    }


@app.post("/can/init")
@app.post("/api/can/init")
async def can_init(req: CanInitRequest):
    """
    Frontend calls POST /api/can/init with {interface, bitrate, mission_id}
    We'll try to bring interface down/up with bitrate if it's a CAN iface.
    """
    interface = req.interface
    bitrate = int(req.bitrate)

    # Basic check
    r = run_cmd(["ip", "link", "show", interface])
    if r.returncode != 0:
        raise HTTPException(status_code=404, detail=f"Interface {interface} not found")

    # Try set bitrate only if it's canX-like. If it fails, return info but not crash UI.
    actions = []
    try:
        run_cmd(["sudo", "ip", "link", "set", interface, "down"])
        actions.append("down")
        run_cmd(["sudo", "ip", "link", "set", interface, "type", "can", "bitrate", str(bitrate)])
        actions.append(f"type can bitrate {bitrate}")
        run_cmd(["sudo", "ip", "link", "set", interface, "up"])
        actions.append("up")
    except Exception as e:
        return {
            "status": "partial",
            "interface": interface,
            "bitrate": bitrate,
            "up": iface_is_up(interface),
            "actions": actions,
            "error": str(e),
        }

    return {
        "status": "ok",
        "interface": interface,
        "bitrate": bitrate,
        "up": iface_is_up(interface),
        "actions": actions,
        "mission_id": req.mission_id,
    }


# =============================================================================
# Capture / Replay status endpoints expected by frontend (stubs)
# =============================================================================

@app.get("/capture/status")
@app.get("/api/capture/status")
async def capture_status():
    # UI keeps polling these; provide stable responses
    return {"status": "idle", "running": False}


@app.get("/replay/status")
@app.get("/api/replay/status")
async def replay_status():
    return {"status": "idle", "running": False}


# =============================================================================
# Sniffer endpoints
# =============================================================================

@app.post("/sniffer/start")
@app.post("/api/sniffer/start")
async def sniffer_start(interface: str = "can0"):
    await candump_mgr.ensure_running(interface)
    return {"status": "started", "interface": interface}


@app.post("/sniffer/stop")
@app.post("/api/sniffer/stop")
async def sniffer_stop():
    if candump_mgr.clients:
        return {"status": "in_use", "clients": len(candump_mgr.clients)}
    async with candump_mgr.lock:
        await candump_mgr._stop_process()
    return {"status": "stopped"}


# =============================================================================
# WebSocket
# =============================================================================

@app.websocket("/ws/candump")
@app.websocket("/api/ws/candump")  # alias
async def ws_candump(websocket: WebSocket, interface: str = Query(default="can0")):
    await websocket.accept()
    await candump_mgr.add_client(websocket)

    try:
        await candump_mgr.ensure_running(interface)
        while True:
            await asyncio.sleep(1)
    except WebSocketDisconnect:
        pass
    finally:
        await candump_mgr.remove_client(websocket)


# =============================================================================
# Health
# =============================================================================

@app.get("/health")
@app.get("/api/health")  # alias
async def health_check():
    return {
        "status": "healthy",
        "timestamp": datetime.now().isoformat(),
        "version": "1.0.2",
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
