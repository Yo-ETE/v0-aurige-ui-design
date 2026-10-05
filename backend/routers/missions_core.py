"""AURIGE - Missions (coeur : CRUD + logs).
Extrait de main.py, routes inchangees. Les modeles Pydantic et helpers restent
dans main.py (le router est inclus en fin de main.py, donc tous les modeles
sont deja definis a l'import). Helpers appeles via main.<nom> a l'execution."""
import asyncio
import json
import shutil
import tempfile
import time
import zipfile
from datetime import datetime
from typing import Optional
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

import main
from main import (
    CoOccurrenceFrame,
    CoOccurrenceRequest,
    CoOccurrenceResponse,
    CreateFrameLogRequest,
    EcuFamily,
    LogEntry,
    Mission,
    MissionCreate,
    MissionUpdate,
    RenameLogRequest,
    SplitLogRequest,
    SplitLogResponse,
    UpdateLogTagsRequest,
)

router = APIRouter()


@router.get("/api/missions/{mission_id}/logs-analysis")
async def analyze_mission_logs(mission_id: str, log_id: Optional[str] = None):
    """
    Analyze mission logs to extract CAN ID + data patterns for intelligent fuzzing.
    Returns unique IDs with their observed data values, byte ranges, and frequencies.
    Optionally filter by a specific log_id.
    """
    main.load_mission(mission_id)
    logs_dir = main.get_mission_logs_dir(mission_id)
    
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


@router.get("/api/missions")
async def list_missions():
    """List all missions"""
    missions = main.list_all_missions()
    return {"missions": missions}


@router.post("/api/missions", response_model=Mission)
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
    
    main.save_mission(mission_id, mission)
    main.get_mission_logs_dir(mission_id)  # Create logs directory
    
    return Mission(**mission)


@router.get("/api/missions/{mission_id}", response_model=Mission)
async def get_mission(mission_id: str):
    """Get a single mission"""
    mission = main.load_mission(mission_id)
    main.update_mission_stats(mission_id)
    mission = main.load_mission(mission_id)  # Reload after stats update
    return Mission(**mission)


@router.patch("/api/missions/{mission_id}", response_model=Mission)
async def update_mission(mission_id: str, updates: MissionUpdate):
    """Update a mission"""
    mission = main.load_mission(mission_id)
    
    if updates.name is not None:
        mission["name"] = updates.name
    if updates.notes is not None:
        mission["notes"] = updates.notes
    if updates.vehicle is not None:
        mission["vehicle"] = updates.vehicle.model_dump()
    if updates.can_config is not None:
        mission["canConfig"] = updates.can_config.model_dump()
    
    mission["updatedAt"] = datetime.now().isoformat()
    main.save_mission(mission_id, mission)
    
    return Mission(**mission)


@router.delete("/api/missions/{mission_id}")
async def delete_mission(mission_id: str):
    """Delete a mission and all its data"""
    mission_dir = main.get_mission_dir(mission_id)
    if not mission_dir.exists():
        raise HTTPException(status_code=404, detail="Mission not found")
    
    shutil.rmtree(mission_dir)
    
    return {"status": "deleted", "id": mission_id}


@router.post("/api/missions/{mission_id}/duplicate", response_model=Mission)
async def duplicate_mission(mission_id: str):
    """Duplicate a mission (without logs)"""
    original = main.load_mission(mission_id)
    
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
    
    main.save_mission(new_id, new_mission)
    main.get_mission_logs_dir(new_id)
    
    return Mission(**new_mission)


@router.get("/api/missions/{mission_id}/logs", response_model=list[LogEntry])
async def list_mission_logs(mission_id: str):
    """List all logs for a mission, with parent/child relationships detected"""
    main.load_mission(mission_id)  # Verify exists
    
    logs_dir = main.get_mission_logs_dir(mission_id)
    logs = []
    log_names = set()
    
    # First pass: collect all log names
    for log_file in logs_dir.glob("*.log"):
        log_names.add(log_file.stem)
    
    for log_file in logs_dir.glob("*.log"):
        stat = log_file.stat()
        # Comptage hors event loop (O(taille) par log ; peut etre appele apres un stop de capture).
        frames_count = await asyncio.to_thread(main.count_log_frames, log_file)
        
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
            interface=meta.get("interface"),
            bitrate=meta.get("bitrate"),
        ))

    return sorted(logs, key=lambda x: x.created_at, reverse=True)


@router.get("/missions/{mission_id}/logs/{log_id}/download")
@router.get("/api/missions/{mission_id}/logs/{log_id}/download")  # alias
async def download_log(mission_id: str, log_id: str):
    main.load_mission(mission_id)

    logs_dir = main.get_mission_logs_dir(mission_id)
    log_file = logs_dir / f"{log_id}.log"

    if not log_file.exists():
        raise HTTPException(status_code=404, detail="Log not found")

    return FileResponse(
        path=str(log_file),
        filename=f"{log_id}.log",
        media_type="text/plain",
    )


@router.get("/api/missions/{mission_id}/logs/{log_id}/download-family")
async def download_log_family(mission_id: str, log_id: str):
    """Download a log and all its children (splits) as a ZIP file"""
    import zipfile
    import tempfile
    
    main.load_mission(mission_id)
    logs_dir = main.get_mission_logs_dir(mission_id)
    
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


@router.get("/api/missions/{mission_id}/logs/{log_id}/content")
async def get_log_content(mission_id: str, log_id: str, limit: int = 500, offset: int = 0):
    """Get parsed content of a log file (CAN frames)"""
    main.load_mission(mission_id)
    
    logs_dir = main.get_mission_logs_dir(mission_id)
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


@router.delete("/api/missions/{mission_id}/logs/{log_id}")
async def delete_log(mission_id: str, log_id: str):
    main.load_mission(mission_id)

    logs_dir = main.get_mission_logs_dir(mission_id)
    log_file = logs_dir / f"{log_id}.log"
    meta_file = logs_dir / f"{log_id}.meta.json"

    if not log_file.exists():
        raise HTTPException(status_code=404, detail="Log not found")

    log_file.unlink()
    if meta_file.exists():
        meta_file.unlink()
    
    main.update_mission_stats(mission_id)
    
    return {"status": "deleted", "id": log_id}


@router.post("/api/missions/{mission_id}/logs/create-frame")
async def create_frame_log(mission_id: str, request: CreateFrameLogRequest):
    """Create a .log file containing a single CAN frame. Used for success frame extraction."""
    main.load_mission(mission_id)
    logs_dir = main.get_mission_logs_dir(mission_id)
    
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
    
    main.update_mission_stats(mission_id)
    
    return {"status": "ok", "logId": log_id, "filename": f"{log_id}.log"}


@router.put("/api/missions/{mission_id}/logs/{log_id}/tags")
async def update_log_tags(mission_id: str, log_id: str, request: UpdateLogTagsRequest):
    """Update tags for a log (success, failed, original, etc.)"""
    main.load_mission(mission_id)
    logs_dir = main.get_mission_logs_dir(mission_id)
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


@router.post("/api/missions/{mission_id}/logs/{log_id}/rename")
async def rename_log(mission_id: str, log_id: str, request: RenameLogRequest):
    """Rename a log file"""
    main.load_mission(mission_id)
    
    logs_dir = main.get_mission_logs_dir(mission_id)
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


@router.post("/api/missions/{mission_id}/logs/{log_id}/split", response_model=SplitLogResponse)
async def split_log(mission_id: str, log_id: str):
    """
    Split a log file in half for binary isolation.
    
    Creates two new log files:
    - {log_id}_A.log - First half of frames
    - {log_id}_B.log - Second half of frames
    
    The original log is preserved.
    """
    main.load_mission(mission_id)
    
    logs_dir = main.get_mission_logs_dir(mission_id)
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
    
    main.update_mission_stats(mission_id)
    
    return SplitLogResponse(
        logAId=log_a_id,
        logAName=f"{log_a_id}.log",
        logAFrames=len(lines_a),
        logBId=log_b_id,
        logBName=f"{log_b_id}.log",
        logBFrames=len(lines_b),
    )


@router.post("/api/missions/{mission_id}/logs/{log_id}/co-occurrence", response_model=CoOccurrenceResponse)
async def analyze_co_occurrence(mission_id: str, log_id: str, request: CoOccurrenceRequest):
    """
    Analyze frames that co-occur with a causal frame within a time window.
    
    This helps identify:
    - ACK frames (appear just after the causal frame)
    - Status frames (appear during the action)
    - Related ECU traffic (similar ID ranges)
    """
    main.load_mission(mission_id)
    logs_dir = main.get_mission_logs_dir(mission_id)
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
