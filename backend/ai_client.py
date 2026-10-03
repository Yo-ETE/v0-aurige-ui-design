"""AURIGE - Client LLM agnostique (Anthropic / OpenAI) avec cle fournie par l'utilisateur.

SECURITE : la cle API n'est JAMAIS journalisee, ni renvoyee, ni incluse dans une
exception ou un message d'erreur.
"""
import json
import os
from pathlib import Path

import httpx

AI_CONFIG_PATH = Path(os.getenv("AURIGE_DATA_DIR", "/opt/aurige/data")) / "ai_config.json"

DEFAULT_CONFIG = {
    "provider": "anthropic",
    "base_url": "https://api.anthropic.com",
    "model": "claude-opus-5-5",
    "api_key": "",
}


def load_config() -> dict:
    """Lit la config ; valeurs par defaut pour les cles manquantes ou en cas d'erreur."""
    cfg = dict(DEFAULT_CONFIG)
    try:
        with open(AI_CONFIG_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            for k in DEFAULT_CONFIG:
                if k in data and isinstance(data[k], str):
                    cfg[k] = data[k]
    except (OSError, ValueError):
        return dict(DEFAULT_CONFIG)
    return cfg


def save_config(cfg: dict) -> None:
    """Sauvegarde atomique (tmp + flush + fsync + replace), fichier en 0600."""
    path = Path(AI_CONFIG_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    try:
        os.chmod(tmp, 0o600)  # avant replace : le fichier final n'a jamais les droits par defaut
    except OSError:
        pass
    os.replace(tmp, path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


async def analyze(context: str, question: str) -> str:
    cfg = load_config()
    key = cfg["api_key"]
    if not key:
        raise ValueError("Cle IA non configuree")
    base = cfg["base_url"]
    if not (base.startswith("http://") or base.startswith("https://")):
        raise ValueError("URL du fournisseur IA invalide")
    base = base.rstrip("/")
    model = cfg["model"]
    content = question + "\n\n" + context
    body = {"model": model, "max_tokens": 1024, "messages": [{"role": "user", "content": content}]}
    try:
        async with httpx.AsyncClient(timeout=60) as c:
            if cfg["provider"] == "openai":
                r = await c.post(
                    base + "/v1/chat/completions",
                    headers={"Authorization": f"Bearer {key}", "content-type": "application/json"},
                    json=body,
                )
                r.raise_for_status()
                return r.json()["choices"][0]["message"]["content"]
            r = await c.post(
                base + "/v1/messages",
                headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                         "content-type": "application/json"},
                json=body,
            )
            r.raise_for_status()
            return r.json()["content"][0]["text"]
    except httpx.HTTPStatusError as e:
        # raise ... from None : ne pas chainer l'exception d'origine (requete/en-tetes)
        excerpt = e.response.text[:200].replace(key, "***")
        raise RuntimeError(f"IA erreur {e.response.status_code}: {excerpt}") from None
    except httpx.HTTPError as e:
        raise RuntimeError(f"IA injoignable: {type(e).__name__}") from None
    except (KeyError, IndexError, TypeError, ValueError):
        raise RuntimeError("IA reponse inattendue") from None
