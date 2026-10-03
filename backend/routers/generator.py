"""AURIGE - Domaine generator (start, stop, status). Extrait de main.py, routes inchangees."""
import asyncio
import re
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import main

router = APIRouter()


class GeneratorRequest(BaseModel):
    interface: str = "can0"
    can_id: Optional[str] = Field(default=None, alias="canId")  # None = random
    data_length: int = Field(alias="dataLength", default=8)
    delay_ms: int = Field(alias="delayMs", default=100)
    # Modes d'ID : random | fixed | increment. None = retro-compat (fixed si can_id fourni, sinon random)
    id_mode: Optional[str] = Field(default=None, alias="idMode")
    # Modes de donnees : random | fixed | increment
    data_mode: str = Field(default="random", alias="dataMode")
    data_value: Optional[str] = Field(default=None, alias="dataValue")  # hex, si data_mode == fixed
    count: Optional[int] = Field(default=None, alias="count")  # -n : stop apres N trames

    class Config:
        populate_by_name = True


@router.post("/api/generator/start")
async def start_generator(request: GeneratorRequest):
    """
    Start generating CAN traffic.
    
    Executes: cangen canX -g delay [-L len] -I <id|i|r> [-D <hex|i>] [-n count]
    """
    if main.state.cangen_process and main.state.cangen_process.returncode is None:
        raise HTTPException(status_code=409, detail="Generator already running")

    # Valide l'interface (cohérent avec can/send, fuzzing, etc.)
    if request.interface not in ["can0", "can1", "vcan0"]:
        raise HTTPException(status_code=400, detail="Invalid interface. Use can0, can1, or vcan0.")

    id_mode = request.id_mode or ("fixed" if request.can_id else "random")
    if id_mode not in ("random", "fixed", "increment"):
        raise HTTPException(status_code=400, detail="id_mode invalide (random|fixed|increment)")
    if request.data_mode not in ("random", "fixed", "increment"):
        raise HTTPException(status_code=400, detail="data_mode invalide (random|fixed|increment)")
    if request.count is not None and not (1 <= request.count <= 1_000_000):
        raise HTTPException(status_code=400, detail="count invalide (1..1000000)")

    data_hex = None
    if request.data_mode == "fixed":
        if not request.data_value or not re.fullmatch(r'(?:[0-9A-Fa-f]{2}){1,8}', request.data_value):
            raise HTTPException(status_code=400, detail="data_value invalide (1 a 8 octets hex)")
        data_hex = request.data_value.upper()

    # AUD-06 : garde sur la liste critique (jamais basee sur les donnees)
    if id_mode == "fixed":
        if not request.can_id:
            raise HTTPException(status_code=400, detail="can_id requis en mode ID fixe")
        # Validation hex stricte AVANT la garde : "i"/"r" seraient sinon interpretes par cangen
        # comme increment/random et contourneraient AUD-06
        cid = request.can_id.strip()
        if not re.fullmatch(r"(?:0[xX])?[0-9A-Fa-f]{1,8}", cid):
            raise HTTPException(status_code=400, detail="CAN ID invalide")
        fixed_id = main._norm_id(cid)
        id_val = main._id_int(fixed_id)
        if id_val is None or id_val > 0x1FFFFFFF:
            raise HTTPException(status_code=400, detail="CAN ID invalide")
        if main.is_id_blocked(fixed_id):
            raise HTTPException(status_code=403, detail=f"ID {fixed_id} bloque (AUD-06)")
    elif main._load_blocklist():
        # random et increment balayent tout l'espace d'IDs : cangen ne peut rien exclure
        raise HTTPException(
            status_code=403,
            detail="cangen ne peut pas exclure d'ID ; precisez un can_id ou videz la liste critique",
        )

    cmd = ["cangen", request.interface, "-g", str(request.delay_ms)]
    # Donnees fixes : cangen deduit la longueur des octets fournis, -L est omis
    if data_hex is None:
        cmd.extend(["-L", str(request.data_length)])

    if id_mode == "fixed":
        cmd.extend(["-I", fixed_id])
    elif id_mode == "increment":
        cmd.extend(["-I", "i"])
    else:
        cmd.extend(["-I", "r"])

    if data_hex is not None:
        cmd.extend(["-D", data_hex])
    elif request.data_mode == "increment":
        cmd.extend(["-D", "i"])

    if request.count is not None:
        cmd.extend(["-n", str(request.count)])

    main.state.cangen_process = await main.run_command_async(cmd)
    
    return {
        "status": "started",
        "interface": request.interface,
        "delayMs": request.delay_ms,
    }


@router.post("/api/generator/stop")
async def stop_generator():
    """Stop generator"""
    if not main.state.cangen_process or main.state.cangen_process.returncode is not None:
        raise HTTPException(status_code=404, detail="No generator running")
    
    main.state.cangen_process.terminate()
    try:
        await asyncio.wait_for(main.state.cangen_process.wait(), timeout=5.0)
    except asyncio.TimeoutError:
        main.state.cangen_process.kill()
    
    main.state.cangen_process = None
    
    return {"status": "stopped"}


@router.get("/api/generator/status")
async def get_generator_status():
    """Get generator status"""
    is_running = main.state.cangen_process and main.state.cangen_process.returncode is None
    return {"running": is_running}
