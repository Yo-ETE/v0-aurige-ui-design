"""AURIGE - Bibliotheque DBC autonome (/api/dbc).
Extrait de main.py, routes inchangees. Modeles Pydantic (DBCLibCreate inclus) et helpers
restent dans main.py (router inclus en fin de main.py). Helpers appeles via main.<nom>."""
import time

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import Response

import dbc_store
import main
from main import DBCLibCreate, DBCMessageMeta, DBCSignal
from validators import valid_dbc_id

router = APIRouter()


@router.get("/api/dbc")
async def list_dbc_libraries():
    out = []
    for p in main._dbc_lib_dir().glob("*.json"):
        try:
            doc = dbc_store.load_doc(p)
        except Exception:
            continue
        msgs = doc.get("messages", [])
        out.append({
            "id": doc.get("id", p.stem),
            "name": doc.get("name", p.stem),
            "message_count": len(msgs),
            "signal_count": sum(len(m.get("signals", [])) for m in msgs),
            "updated_at": doc.get("updated_at", ""),
        })
    out.sort(key=lambda x: x["updated_at"], reverse=True)
    return {"libraries": out}


@router.post("/api/dbc")
async def create_dbc_library(body: DBCLibCreate):
    name = (body.name or "").strip() or "DBC"
    base = main._slug(name)
    dbc_id = base
    i = 1
    while (main._dbc_lib_dir() / f"{dbc_id}.json").exists():
        i += 1
        dbc_id = f"{base}-{i}"
    if not valid_dbc_id(dbc_id):
        dbc_id = f"dbc-{int(time.time())}"
    doc = dbc_store.new_doc()
    doc["id"] = dbc_id
    doc["name"] = name
    dbc_store.save_doc(main._dbc_lib_path(dbc_id), doc)
    return {"id": dbc_id, "name": name}


@router.get("/api/dbc/{dbc_id}")
async def get_dbc_library(dbc_id: str):
    _, doc = main._lib_doc_or_404(dbc_id)
    return doc


@router.patch("/api/dbc/{dbc_id}")
async def rename_dbc_library(dbc_id: str, body: DBCLibCreate):
    p, doc = main._lib_doc_or_404(dbc_id)
    doc["name"] = (body.name or "").strip() or doc.get("name", dbc_id)
    dbc_store.save_doc(p, doc)
    return {"id": dbc_id, "name": doc["name"]}


@router.delete("/api/dbc/{dbc_id}")
async def delete_dbc_library(dbc_id: str):
    p = main._dbc_lib_path(dbc_id)
    if p.exists():
        p.unlink()
    return {"status": "ok"}


@router.post("/api/dbc/{dbc_id}/message")
async def lib_add_message(dbc_id: str, meta: DBCMessageMeta):
    if not main._valid_can_id(meta.can_id):
        raise HTTPException(status_code=400, detail="CAN ID invalide (hex 1-8)")
    if meta.dlc is not None and not (0 <= meta.dlc <= 64):
        raise HTTPException(status_code=400, detail="DLC invalide (0-64)")
    p, doc = main._lib_doc_or_404(dbc_id)
    dbc_store.upsert_message(doc, meta.can_id.strip(), name=meta.name, dlc=meta.dlc, comment=meta.comment)
    dbc_store.save_doc(p, doc)
    return {"status": "ok", "can_id": meta.can_id.strip()}


@router.post("/api/dbc/{dbc_id}/signal")
async def lib_add_signal(dbc_id: str, signal: DBCSignal):
    if not main._valid_can_id(signal.can_id):
        raise HTTPException(status_code=400, detail="CAN ID invalide (hex 1-8)")
    p, doc = main._lib_doc_or_404(dbc_id)
    sid = dbc_store.upsert_signal(doc, signal.model_dump())
    dbc_store.save_doc(p, doc)
    return {"status": "ok", "signal_id": sid}


@router.delete("/api/dbc/{dbc_id}/signal/{signal_id}")
async def lib_delete_signal(dbc_id: str, signal_id: str):
    p, doc = main._lib_doc_or_404(dbc_id)
    n = dbc_store.delete_signal(doc, signal_id)
    dbc_store.save_doc(p, doc)
    return {"status": "ok", "removed": n}


@router.delete("/api/dbc/{dbc_id}/message/{can_id}")
async def lib_delete_message(dbc_id: str, can_id: str):
    p, doc = main._lib_doc_or_404(dbc_id)
    n = dbc_store.delete_message(doc, can_id)
    dbc_store.save_doc(p, doc)
    return {"status": "ok", "removed": n}


@router.get("/api/dbc/{dbc_id}/export")
async def lib_export(dbc_id: str):
    _, doc = main._lib_doc_or_404(dbc_id)
    return Response(content=dbc_store.dbc_to_text(doc), media_type="application/octet-stream",
                    headers={"Content-Disposition": f'attachment; filename="{dbc_id}.dbc"'})


@router.post("/api/dbc/{dbc_id}/import")
async def lib_import(dbc_id: str, file: UploadFile = File(...)):
    p, doc = main._lib_doc_or_404(dbc_id)
    content = await file.read()
    try:
        n = main._import_dbc_into_doc(doc, content)
    except Exception as e:
        main.log_error(f"DBC library import failed: {str(e)}", e)
        raise HTTPException(status_code=500, detail=f"Failed to import DBC: {str(e)}")
    dbc_store.save_doc(p, doc)
    return {"status": "success", "imported_signals": n}


@router.post("/api/dbc/{dbc_id}/from-mission/{mission_id}")
async def lib_from_mission(dbc_id: str, mission_id: str):
    """Copie le DBC d'une mission dans la bibliotheque (remplace les messages)."""
    p, doc = main._lib_doc_or_404(dbc_id)
    mdbc = main._mission_dbc_path(mission_id)
    if not mdbc.exists():
        raise HTTPException(status_code=404, detail="DBC mission introuvable")
    src = dbc_store.load_doc(mdbc)
    doc["messages"] = src.get("messages", [])
    dbc_store.save_doc(p, doc)
    return {"status": "ok", "message_count": len(doc["messages"])}
