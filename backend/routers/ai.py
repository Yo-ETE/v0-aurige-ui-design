"""AURIGE - Analyse assistee par IA (config fournisseur + analyse). Cle jamais renvoyee."""
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import main  # noqa: F401  (pattern des routers)
import ai_client

router = APIRouter()

_PROVIDERS = {"anthropic", "openai"}


class AIConfigInput(BaseModel):
    provider: str
    base_url: Optional[str] = None
    model: str
    api_key: Optional[str] = None
    clear_key: bool = False


class AIAnalyzeInput(BaseModel):
    context: str
    question: str


def _public(cfg: dict) -> dict:
    return {
        "provider": cfg["provider"],
        "base_url": cfg["base_url"],
        "model": cfg["model"],
        "has_key": bool(cfg["api_key"]),
    }


@router.get("/api/ai/config")
async def get_ai_config():
    return _public(ai_client.load_config())


@router.put("/api/ai/config")
async def put_ai_config(body: AIConfigInput):
    if body.provider not in _PROVIDERS:
        raise HTTPException(status_code=400, detail="Fournisseur IA invalide")
    if body.base_url and not body.base_url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="URL invalide (http/https requis)")
    cfg = ai_client.load_config()
    # Anti-exfiltration : changer de destination (provider/base_url) sans nouvelle cle
    # efface la cle stockee, sinon elle serait envoyee a l'hote choisi.
    endpoint_changed = body.provider != cfg["provider"] or (
        bool(body.base_url) and body.base_url != cfg["base_url"])
    cfg["provider"] = body.provider
    cfg["model"] = body.model
    if body.base_url:
        cfg["base_url"] = body.base_url
    if body.clear_key:
        cfg["api_key"] = ""
    elif body.api_key:
        cfg["api_key"] = body.api_key
    elif endpoint_changed:
        cfg["api_key"] = ""
    ai_client.save_config(cfg)
    return _public(cfg)


@router.post("/api/ai/analyze")
async def ai_analyze(body: AIAnalyzeInput):
    if len(body.context) > 100000 or len(body.question) > 4000:
        raise HTTPException(status_code=400, detail="Contexte ou question trop long")
    try:
        answer = await ai_client.analyze(body.context, body.question)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"answer": answer}
