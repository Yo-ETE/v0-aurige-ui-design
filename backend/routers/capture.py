"""AURIGE - Domaine capture (start, stop, status). Extrait de main.py, routes inchangees."""
import asyncio
import json
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import main

router = APIRouter()


class CaptureStartRequest(BaseModel):
    interface: str = "can0"
    mission_id: str = Field(alias="missionId")
    filename: Optional[str] = None
    description: Optional[str] = None

    class Config:
        populate_by_name = True


@router.post("/api/capture/start")
async def start_capture(request: CaptureStartRequest):
    """
    Start capturing CAN traffic to a log file.
    
    Executes: candump -L canX > mission/logs/filename.log
    """
    if main.state.capture_process and main.state.capture_process.returncode is None:
        raise HTTPException(status_code=409, detail="Capture already running")
    
    # Verify mission exists
    main.load_mission(request.mission_id)
    
    # Generate filename
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = request.filename or f"capture_{timestamp}.log"
    if not filename.endswith(".log"):
        filename += ".log"
    
    logs_dir = main.get_mission_logs_dir(request.mission_id)
    log_path = logs_dir / filename
    
    # Start candump with log format.
    # candump -L outputs in standard log format that canplayer can replay.
    # stdbuf -oL force un buffer ligne par ligne : sans lui, la sortie vers un
    # fichier est bufferisee par bloc et le compteur de trames "live" (wc -l)
    # resterait a 0 jusqu'a l'arret.
    main.state.capture_process = await asyncio.create_subprocess_exec(
        "stdbuf", "-oL", "candump", "-L", request.interface,
        stdout=open(log_path, "w"),
        stderr=asyncio.subprocess.PIPE,
    )
    main.state.capture_file = log_path
    main.state.capture_start_time = datetime.now()
    
    # Save metadata
    meta_path = log_path.with_suffix(".meta.json")
    with open(meta_path, "w") as f:
        json.dump({
            "description": request.description,
            "interface": request.interface,
            "startTime": main.state.capture_start_time.isoformat(),
        }, f)
    
    return {
        "status": "started",
        "missionId": request.mission_id,
        "filename": filename,
        "interface": request.interface,
    }


@router.post("/api/capture/stop")
async def stop_capture():
    """Stop the running capture"""
    if not main.state.capture_process or main.state.capture_process.returncode is not None:
        raise HTTPException(status_code=404, detail="No capture running")
    
    # Calculate duration
    duration = 0
    if main.state.capture_start_time:
        duration = int((datetime.now() - main.state.capture_start_time).total_seconds())
    
    # Stop process
    main.state.capture_process.terminate()
    try:
        await asyncio.wait_for(main.state.capture_process.wait(), timeout=5.0)
    except asyncio.TimeoutError:
        main.state.capture_process.kill()
    
    # Update metadata with duration
    if main.state.capture_file:
        meta_path = main.state.capture_file.with_suffix(".meta.json")
        if meta_path.exists():
            with open(meta_path, "r") as f:
                meta = json.load(f)
            meta["durationSeconds"] = duration
            meta["endTime"] = datetime.now().isoformat()
            with open(meta_path, "w") as f:
                json.dump(meta, f)
        
        # Update mission stats with new capture flag
        mission_id = main.state.capture_file.parent.parent.name
        main.update_mission_stats(mission_id, new_capture=True)

        filename = main.state.capture_file.name
        frames_count = main._count_log_frames(main.state.capture_file)
    else:
        filename = None
        frames_count = 0

    # Clear state
    main.state.capture_process = None
    main.state.capture_file = None
    main.state.capture_start_time = None

    return {
        "status": "stopped",
        "filename": filename,
        "durationSeconds": duration,
        "framesCount": frames_count,
    }


@router.get("/api/capture/status")
async def get_capture_status():
    """Get current capture status"""
    is_running = main.state.capture_process and main.state.capture_process.returncode is None
    duration = 0
    frames_count = 0
    if is_running and main.state.capture_start_time:
        duration = int((datetime.now() - main.state.capture_start_time).total_seconds())
    if is_running and main.state.capture_file:
        frames_count = main._count_log_frames(main.state.capture_file)

    return {
        "running": is_running,
        "filename": main.state.capture_file.name if main.state.capture_file else None,
        "durationSeconds": duration,
        "framesCount": frames_count,
    }
