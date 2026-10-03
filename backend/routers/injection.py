"""AURIGE - Domaine injection (inject de fond, blocklist AUD-06, trames connues).
Extrait de main.py, routes inchangees. Les helpers/garde AUD-06 restent dans main.py
(appeles via main.<nom> a l'execution)."""
import asyncio
import re
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import known_frames
import main

router = APIRouter()


class InjectRequest(BaseModel):
    interface: str = "can0"
    mode: str = "frame"  # "frame" | "log"
    canId: Optional[str] = None
    data: Optional[str] = None
    missionId: Optional[str] = None
    logId: Optional[str] = None
    intervalMs: int = 100


@router.post("/api/inject/start")
async def inject_start(req: InjectRequest):
    """Demarre une injection de fond en boucle (une seule a la fois)."""
    if main.state.inject_process and main.state.inject_process.returncode is None:
        raise HTTPException(status_code=409, detail="Injection de fond deja en cours")
    iface = (req.interface or "").strip()
    if not main._IFACE_RE.fullmatch(iface):
        raise HTTPException(status_code=400, detail="Interface invalide")
    interval = max(10, min(5000, int(req.intervalMs)))
    frames: list[str] = []
    if req.mode == "frame":
        cid = (req.canId or "").strip()
        data = (req.data or "").strip()
        if not main._HEX_ID.fullmatch(cid) or not main._HEX_DATA.fullmatch(data):
            raise HTTPException(status_code=400, detail="Trame invalide (ID 1..8 hex, data hex paire <= 16)")
        frames = [f"{cid.upper()}#{data.upper()}"]
        desc = f"Trame {frames[0]} ({interval} ms)"
    elif req.mode == "log":
        if not req.missionId or not req.logId:
            raise HTTPException(status_code=400, detail="missionId et logId requis")
        if not main._SAFE_ID_RE.fullmatch(req.missionId) or not main._SAFE_ID_RE.fullmatch(req.logId):
            raise HTTPException(status_code=400, detail="Identifiant invalide")
        log_file = main.get_mission_logs_dir(req.missionId) / f"{req.logId}.log"
        if not log_file.exists():
            raise HTTPException(status_code=404, detail="Log introuvable")
        try:
            with open(log_file, "r") as f:
                for line in f:
                    parts = line.strip().split()
                    # Format : (1234.567890) can0 123#DEADBEEF
                    # Seules les trames strictement hex sont gardees (jamais de jeton brut vers le shell)
                    if len(parts) >= 3 and main._LOG_FRAME_RE.fullmatch(parts[2]):
                        frames.append(parts[2].upper())
                        if len(frames) > main.INJECT_MAX_FRAMES:
                            break
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Lecture du log impossible: {e}")
        if not frames:
            raise HTTPException(status_code=400, detail="Log vide ou illisible")
        truncated = len(frames) > main.INJECT_MAX_FRAMES
        frames = frames[:main.INJECT_MAX_FRAMES]
        suffix = " - tronque" if truncated else ""
        desc = f"Keep-alive log {req.logId} ({len(frames)} trames{suffix}, {interval} ms)"
    else:
        raise HTTPException(status_code=400, detail="mode invalide")

    blocked = main._injectable_or_block(frames)
    if blocked:
        raise HTTPException(status_code=403, detail=blocked)

    return await main._start_inject_frames(iface, frames, req.intervalMs, desc)


@router.post("/api/inject/stop")
async def inject_stop():
    """Arrete l'injection de fond (idempotent)."""
    p = main.state.inject_process
    if p and p.returncode is None:
        p.terminate()
        try:
            await asyncio.wait_for(p.wait(), timeout=5.0)
        except asyncio.TimeoutError:
            p.kill()
            await p.wait()  # recolte le process (pas de zombie)
    main.state.inject_process = None
    main.state.inject_desc = ""
    return {"status": "stopped"}


@router.get("/api/inject/status")
async def inject_status():
    running = bool(main.state.inject_process and main.state.inject_process.returncode is None)
    return {"running": running, "description": main.state.inject_desc if running else ""}


class KnownFrameCreate(BaseModel):
    can_id: str
    crash_data: str
    reset_data: Optional[str] = ""
    label: str
    severity: Optional[str] = None
    notes: Optional[str] = ""


class KnownFramePatch(BaseModel):
    can_id: Optional[str] = None
    crash_data: Optional[str] = None
    reset_data: Optional[str] = None
    label: Optional[str] = None
    severity: Optional[str] = None
    notes: Optional[str] = None


class KnownFrameReplayRequest(BaseModel):
    interface: str = "can0"
    kind: str = "crash"  # "crash" | "reset"
    loop: bool = False
    intervalMs: int = 100


@router.get("/api/known-frames")
async def list_known_frames():
    return {"frames": known_frames.load_frames()}


@router.post("/api/known-frames")
async def create_known_frame(body: KnownFrameCreate):
    try:
        frame = known_frames.add_frame(body.model_dump())
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return frame


@router.patch("/api/known-frames/{fid}")
async def patch_known_frame(fid: str, body: KnownFramePatch):
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    try:
        updated = known_frames.update_frame(fid, patch)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if updated is None:
        raise HTTPException(status_code=404, detail="Trame introuvable")
    return updated


@router.delete("/api/known-frames/{fid}")
async def delete_known_frame(fid: str):
    if not known_frames.delete_frame(fid):
        raise HTTPException(status_code=404, detail="Trame introuvable")
    return {"status": "deleted"}


@router.post("/api/known-frames/{fid}/replay")
async def replay_known_frame(fid: str, req: KnownFrameReplayRequest):
    """Rejoue une trame connue (crash ou reinit). Action explicite et deliberee de
    l'utilisateur sur une trame qu'il a lui-meme cataloguee : ne passe JAMAIS par
    is_id_blocked (AUD-06), par design (cf. spec known-frames ~5). AUD-06 reste le
    garde-fou du fuzzing/balayage aveugle, pas de ce rejeu cible."""
    frame = known_frames.get_frame(fid)
    if frame is None:
        raise HTTPException(status_code=404, detail="Trame introuvable")
    if req.kind not in ("crash", "reset"):
        raise HTTPException(status_code=400, detail="kind invalide (crash|reset)")

    can_id = frame["can_id"]
    data = frame.get("crash_data", "") if req.kind == "crash" else frame.get("reset_data", "")
    if req.kind == "reset" and not data:
        raise HTTPException(status_code=400, detail="Cette trame n'a pas de reset_data")

    # Defense en profondeur : revalide la trame STOCKEE (fichier edite a la main/corrompu)
    # avant tout envoi, pour les modes one-shot et boucle.
    if not isinstance(can_id, str) or not main._HEX_ID.fullmatch(can_id) \
            or not isinstance(data, str) or not main._HEX_DATA.fullmatch(data):
        raise HTTPException(status_code=400, detail="Trame stockee invalide")

    iface = (req.interface or "").strip()
    if not main._IFACE_RE.fullmatch(iface):
        raise HTTPException(status_code=400, detail="Interface invalide")

    if not req.loop:
        success, error = main.can_send_frame(iface, can_id, data)
        if not success:
            raise HTTPException(status_code=500, detail=f"Echec envoi trame: {error}")
        return {"status": "sent", "interface": iface, "canId": can_id.upper(), "data": data.upper()}

    # Boucle : reutilise le mecanisme d'injection de fond (meme script shell que
    # /api/inject/start), sans passer par is_id_blocked.
    full_frame = f"{can_id.upper()}#{data.upper()}"
    desc = f"Trame connue \"{frame.get('label', '')}\" [{req.kind}] {full_frame} ({req.intervalMs} ms)"
    return await main._start_inject_frames(iface, [full_frame], req.intervalMs, desc)


class BlocklistRequest(BaseModel):
    ids: list


@router.get("/api/aud06/blocklist")
async def get_aud06_blocklist():
    return {"ids": main._load_blocklist()}


@router.put("/api/aud06/blocklist")
async def put_aud06_blocklist(request: BlocklistRequest):
    if len(request.ids) > 512:
        raise HTTPException(status_code=400, detail="Trop d'IDs (max 512)")
    ids = []
    for raw in request.ids:
        if not isinstance(raw, str) or not re.match(r'^[0-9A-Fa-f]{1,8}$', raw.strip()):
            raise HTTPException(status_code=400, detail=f"ID invalide: {raw}")
        n = main._norm_id(raw)
        v = int(n, 16)
        if n in main.OBD_FILTER_IDS or any(v == int(o, 16) for o in main.OBD_FILTER_IDS):
            raise HTTPException(status_code=400, detail=f"ID OBD non bloquable: {n}")
        if n not in ids:
            ids.append(n)
    main._save_blocklist(ids)
    return {"ids": ids}
