"""AURIGE - DBC de mission.
Extrait de main.py, routes inchangees. Modeles Pydantic et helpers restent dans
main.py (router inclus en fin de main.py). Helpers appeles via main.<nom> a l'execution."""
import json
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import Response

import dbc_store
import main
from main import DBCMessageMeta, DBCSignal, MissionDBC

router = APIRouter()


@router.get("/api/missions/{mission_id}/dbc")
async def get_mission_dbc(mission_id: str) -> MissionDBC:
    """Get DBC data for a mission"""
    dbc_file = Path(main.MISSIONS_DIR) / mission_id / "dbc.json"
    
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


@router.post("/api/missions/{mission_id}/dbc/import")
async def import_dbc_file_endpoint(mission_id: str, file: UploadFile = File(...)):
  """Import an official .dbc file (Vector format) into mission DBC."""
  try:
    if not file.filename.endswith('.dbc'):
      raise HTTPException(status_code=400, detail="File must be a .dbc file")

    content = await file.read()

    main.log_info(f"Importing DBC file: {file.filename} for mission {mission_id}")

    dbc_file = Path(main.MISSIONS_DIR) / mission_id / "dbc.json"
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

    stats: dict = {}
    imported_count = main._import_dbc_into_doc(existing_dbc, content, stats)

    dbc_file.parent.mkdir(parents=True, exist_ok=True)
    with open(dbc_file, 'w') as f:
      json.dump(existing_dbc, f, indent=2)

    main.log_info(f"Imported {imported_count} signals from {file.filename}")
    return {
      "status": "success",
      "imported_signals": imported_count,
      "total_messages": stats["total_messages"],
      "filename": file.filename
    }
  except HTTPException:
    raise
  except Exception as e:
    main.log_error(f"DBC import failed: {str(e)}", e)
    raise HTTPException(status_code=500, detail=f"Failed to import DBC: {str(e)}")


@router.post("/api/missions/{mission_id}/dbc/message")
async def add_dbc_message(mission_id: str, meta: DBCMessageMeta):
    """Cree ou met a jour les metadonnees d'un message (sans toucher aux signaux)"""
    if not main._valid_can_id(meta.can_id):
        raise HTTPException(status_code=400, detail="CAN ID invalide (hex 1-8)")
    if meta.dlc is not None and not (0 <= meta.dlc <= 64):
        raise HTTPException(status_code=400, detail="DLC invalide (0-64)")
    mission_dir = Path(main.MISSIONS_DIR) / mission_id
    if not mission_dir.exists():
        raise HTTPException(status_code=404, detail="Mission non trouvee")
    dbc_file = mission_dir / "dbc.json"
    doc = dbc_store.load_doc(dbc_file) if dbc_file.exists() else dbc_store.new_doc()
    doc.setdefault("mission_id", mission_id)
    dbc_store.upsert_message(doc, meta.can_id.strip(), name=meta.name, dlc=meta.dlc, comment=meta.comment)
    dbc_store.save_doc(dbc_file, doc)
    return {"status": "ok", "can_id": meta.can_id.strip()}


@router.post("/api/missions/{mission_id}/dbc/signal")
async def add_dbc_signal(mission_id: str, signal: DBCSignal):
    """Add or update a signal in the mission DBC"""
    if not main._valid_can_id(signal.can_id):
        raise HTTPException(status_code=400, detail="CAN ID invalide (hex 1-8)")
    mission_dir = Path(main.MISSIONS_DIR) / mission_id
    if not mission_dir.exists():
        raise HTTPException(status_code=404, detail="Mission non trouvee")
    dbc_file = mission_dir / "dbc.json"
    doc = dbc_store.load_doc(dbc_file) if dbc_file.exists() else dbc_store.new_doc()
    doc.setdefault("mission_id", mission_id)
    sid = dbc_store.upsert_signal(doc, signal.model_dump())
    dbc_store.save_doc(dbc_file, doc)
    return {"status": "ok", "signal_id": sid}


@router.delete("/api/missions/{mission_id}/dbc/signal/{signal_id}")
async def delete_dbc_signal(mission_id: str, signal_id: str):
    """Delete a signal from the mission DBC"""
    dbc_file = Path(main.MISSIONS_DIR) / mission_id / "dbc.json"
    
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

@router.delete("/api/missions/{mission_id}/dbc/message/{can_id}")
async def delete_dbc_message(mission_id: str, can_id: str):
  """Delete an entire message (all its signals) from the mission DBC"""
  dbc_file = Path(main.MISSIONS_DIR) / mission_id / "dbc.json"
  
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


@router.delete("/api/missions/{mission_id}/dbc")
async def clear_mission_dbc(mission_id: str):
  """Delete all signals and messages from the mission DBC"""
  dbc_file = Path(main.MISSIONS_DIR) / mission_id / "dbc.json"
  
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


@router.get("/api/missions/{mission_id}/dbc/export")
async def export_dbc(mission_id: str):
    """Export mission DBC to .dbc file format"""
    dbc_file = Path(main.MISSIONS_DIR) / mission_id / "dbc.json"
    
    if not dbc_file.exists():
        raise HTTPException(status_code=404, detail="DBC non trouve")
    
    doc = dbc_store.load_doc(dbc_file)
    dbc_content = dbc_store.dbc_to_text(doc)

    return Response(
        content=dbc_content,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="mission_{mission_id}.dbc"'
        }
    )


@router.post("/api/missions/{mission_id}/dbc/from-library/{dbc_id}")
async def mission_from_library(mission_id: str, dbc_id: str):
    """Copie une bibliotheque DBC dans le DBC d'une mission (remplace les messages)."""
    mdbc = main._mission_dbc_path(mission_id)
    if not mdbc.parent.exists():
        raise HTTPException(status_code=404, detail="Mission non trouvee")
    _, src = main._lib_doc_or_404(dbc_id)
    doc = dbc_store.load_doc(mdbc) if mdbc.exists() else dbc_store.new_doc()
    doc["mission_id"] = mission_id
    doc["messages"] = src.get("messages", [])
    dbc_store.save_doc(mdbc, doc)
    return {"status": "ok", "message_count": len(doc["messages"])}


@router.get("/api/missions/{mission_id}/dbc/active")
async def get_active_dbc_ids(mission_id: str):
    """
    Get lightweight list of known CAN IDs from DBC for sniffer overlay.
    Returns message IDs and names for quick lookup, without full signal details.
    """
    dbc_file = Path(main.MISSIONS_DIR) / mission_id / "dbc.json"
    
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
