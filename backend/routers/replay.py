"""AURIGE - Domaine replay (start, stop, status, force-cleanup). Extrait de main.py, routes inchangees."""
import asyncio
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import main

router = APIRouter()


class ReplayRequest(BaseModel):
    interface: str = "can0"
    mission_id: str = Field(alias="missionId")
    log_id: str = Field(alias="logId")
    speed: float = 1.0  # Playback speed multiplier
    loop: int = 1  # Nombre de passages : 1 = une fois, 0 = infini, N = N fois

    class Config:
        populate_by_name = True


@router.post("/api/replay/start")
async def start_replay(request: ReplayRequest):
    """
    Start replaying a log file.
    
    Executes: canplayer -I logfile canX=canX
    """
    if main.state.canplayer_process and main.state.canplayer_process.returncode is None:
        raise HTTPException(status_code=409, detail="Replay already running")

    # Valide l'interface (cohérent avec can/send, fuzzing, etc.)
    if request.interface not in ["can0", "can1", "vcan0"]:
        raise HTTPException(status_code=400, detail="Invalid interface. Use can0, can1, or vcan0.")

    # Get log file
    logs_dir = main.get_mission_logs_dir(request.mission_id)
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
    
    # Boucle : 1 = une fois, 0 = infini, N (clamp 1..1000) = N passages.
    loop = request.loop
    if loop < 0:
        loop = 1
    if loop > 1000:
        loop = 1000

    body_lines = []
    prev_ts = frames[0][0]
    for i, (ts, frame) in enumerate(frames):
        if i > 0:
            delay = (ts - prev_ts) / speed
            if 0 < delay < 10:
                body_lines.append(f"sleep {delay:.6f}")
        body_lines.append(f"cansend {iface} {frame}")
        prev_ts = ts

    lines = ["#!/bin/bash", f"# Replay {len(frames)} frames on {iface} (speed={speed}, loop={loop})"]
    if loop == 1:
        lines += body_lines
    else:
        lines.append("while true; do" if loop == 0 else f"for _i in $(seq {loop}); do")
        lines += ["  " + l for l in body_lines]
        lines.append("  sleep 0.1")  # petite pause entre passages
        lines.append("done")

    script_path = Path("/tmp/aurige_replay.sh")
    with open(script_path, "w") as f:
        f.write("\n".join(lines) + "\n")
    script_path.chmod(0o755)

    print(f"[REPLAY] {len(frames)} frames on {iface} (speed={speed}, loop={loop})")
    main.state.canplayer_process = await main.run_command_async(["bash", str(script_path)])
    
    return {
        "status": "started",
        "missionId": request.mission_id,
        "logId": request.log_id,
        "interface": request.interface,
        "speed": request.speed,
        "loop": loop,
    }


@router.post("/api/replay/stop")
async def stop_replay():
    """Stop replay"""
    if not main.state.canplayer_process or main.state.canplayer_process.returncode is not None:
        raise HTTPException(status_code=404, detail="No replay running")
    
    main.state.canplayer_process.terminate()
    try:
        await asyncio.wait_for(main.state.canplayer_process.wait(), timeout=5.0)
    except asyncio.TimeoutError:
        main.state.canplayer_process.kill()
    
    main.state.canplayer_process = None
    
    return {"status": "stopped"}


@router.get("/api/replay/status")
async def get_replay_status():
    """Get replay status"""
    is_running = main.state.canplayer_process and main.state.canplayer_process.returncode is None
    return {"running": is_running}


@router.post("/api/replay/force-cleanup")
async def force_cleanup_replay():
    """Force cleanup of replay state (for stuck processes)"""
    # Kill any bash/cansend processes
    try:
        main.run_command(["pkill", "-f", "aurige_replay.sh"], check=False)
        main.run_command(["pkill", "-f", "cansend"], check=False)
        await asyncio.sleep(0.5)
    except:
        pass
    
    # Reset state
    if main.state.canplayer_process:
        try:
            main.state.canplayer_process.kill()
        except:
            pass
    main.state.canplayer_process = None

    return {"status": "cleaned", "message": "Forced cleanup of replay processes"}
