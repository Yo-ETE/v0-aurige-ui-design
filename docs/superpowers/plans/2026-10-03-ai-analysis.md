# Analyse CAN assistée IA — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Bouton « Analyser avec l'IA » qui relaie un résumé des analyses CAN + une question à un LLM (API Anthropic par défaut, provider-agnostic), clé fournie par l'utilisateur, réponse dans l'UI.

**Architecture:** Backend `ai_client.py` (config `DATA_DIR/ai_config.json` 0o600, `analyze` via httpx vers anthropic/openai-compat) + router `routers/ai.py` (GET/PUT config, POST analyze). Frontend : client API + panneau admin de config (clé write-only) + bouton sur Analyse CAN.

**Tech Stack:** FastAPI, httpx 0.28 (déjà là), pytest ; Next/React.

**Spec:** `docs/superpowers/specs/2026-10-03-ai-analysis-design.md`

## Global Constraints

- FR UI / EN code. **Clé API : l'utilisateur la saisit ; jamais en dur, jamais renvoyée par GET, jamais loggée ; fichier 0o600.**
- Pas d'injection CAN, pas d'accès bus. AUD-06 inchangé. `base_url` http/https uniquement ; timeout 60s ; tailles bornées.
- Router motif Option-2 : `routers/ai.py` fait `import main`, appelle `main.<x>` au besoin ; `import ai_client`. Include avant `fastapi_app = app`.
- Filets : `test_route_inventory` (régénérer EXPECTED quand on ajoute des routes : 151→154), `test_integration_boot` verts. Suite backend verte. Frontend `npm run build` vert + `tsc` **0**.

---

### Task 1: Backend — ai_client + router + permissions + tests

**Files:** Create `backend/ai_client.py`, `backend/routers/ai.py`, `backend/tests/test_ai.py` ; Modify `backend/main.py` (include), `backend/permissions.py`, `backend/requirements.txt` (httpx si absent), `backend/tests/test_route_inventory.py` (regen), `backend/tests/test_integration_boot.py`.

**Interfaces:** `GET /api/ai/config`, `PUT /api/ai/config`, `POST /api/ai/analyze` ; `ai_client.load_config/save_config/analyze`.

- [ ] `backend/ai_client.py` : `AI_CONFIG_PATH = Path(os.getenv("AURIGE_DATA_DIR","/opt/aurige/data"))/"ai_config.json"` (module-level, monkeypatchable). `load_config()` (défauts provider="anthropic", base_url="https://api.anthropic.com", model="claude-opus-5-5", api_key=""). `save_config(cfg)` atomique (tmp+fsync+os.replace) + `chmod 0o600`. `async def analyze(context, question) -> str` : clé vide → `ValueError("Cle IA non configuree")` ; valide base_url http/https (`ValueError` sinon) ; httpx.AsyncClient(timeout=60) ; anthropic → `POST {base_url}/v1/messages` headers `{x-api-key, anthropic-version:2023-06-01, content-type}` body `{model, max_tokens:1024, messages:[{role:"user", content: question+"\n\n"+context}]}` → `data["content"][0]["text"]` ; openai → `POST {base_url}/v1/chat/completions` header `Authorization: Bearer` → `data["choices"][0]["message"]["content"]`. Erreur HTTP → `RuntimeError(f"IA {status}: {court extrait}")` SANS la clé.
- [ ] `backend/routers/ai.py` : `router=APIRouter()`, `import ai_client`. `GET /api/ai/config` → `{provider, base_url, model, has_key: bool(cfg["api_key"])}`. `PUT /api/ai/config` body `AIConfigInput{provider:str, base_url:Optional[str], model:str, api_key:Optional[str]=None, clear_key:bool=False}` : provider ∈ {anthropic,openai} sinon 400 ; base_url (si fourni) http/https sinon 400 ; charger cfg existante, maj provider/model/base_url ; si `clear_key` → api_key="" ; elif `api_key` (non vide) → stocker ; else conserver l'existante ; save. Réponse = comme GET. `POST /api/ai/analyze` body `{context:str, question:str}` : len(context)≤100000 & len(question)≤4000 sinon 400 ; try `await ai_client.analyze(...)` → `{answer}` ; `ValueError`→400 ; `RuntimeError`/httpx error→502 message clair.
- [ ] `main.py` : `from routers.ai import router as ai_router` + `app.include_router(ai_router)` avant `fastapi_app = app`.
- [ ] `permissions.py` : `("PUT", r"^/api/ai/config", ["safety_config"])`.
- [ ] `test_integration_boot.py` : `GET /api/ai/config` + `POST /api/ai/analyze` → `READ_ONLY_ALLOWLIST` (pas de mutation bus/état Pi ; égress sortant) ; PUT config gardé par `safety_config` (non allowlisté).
- [ ] `test_route_inventory.py` : régénérer EXPECTED (151→154) via `cd backend && python -c "from tests.test_route_inventory import collect; import pprint; pprint.pprint(collect())"`.
- [ ] `backend/tests/test_ai.py` (login admin ; monkeypatch `ai_client.AI_CONFIG_PATH` → tmp ; mock `httpx.AsyncClient`) : GET sans clé→has_key false ; PUT api_key→persist 0o600 ; GET→has_key true & clé ABSENTE de la réponse ; PUT sans api_key conserve ; clear_key efface ; base_url "ftp://x"→400 ; provider "x"→400 ; analyze sans clé→400 ; analyze + mock anthropic→`{answer}` ; openai parse ; erreur HTTP→502 (clé absente du message) ; context trop long→400.
- [ ] `cd backend && python -m pytest -q` vert (incl inventory 154, integration_boot) + `npx tsc --noEmit` 0. Commit `feat(ai): client LLM provider-agnostic + endpoints config/analyze (cle utilisateur)`.

---

### Task 2: Frontend — client API + panneau config admin

**Files:** Modify `lib/api.ts` ; Create `components/admin/ai-panel.tsx` + monter sur la page admin (trouver où `network-panel`/`system-panel`/`user-management` sont rendus et ajouter l'onglet/section « IA »).

**Interfaces:** consomme Task 1.

- [ ] `lib/api.ts` : types `AIConfig {provider:string; base_url:string; model:string; has_key:boolean}`, `AIConfigInput {provider:string; base_url?:string; model:string; api_key?:string; clear_key?:boolean}` ; `getAIConfig(): Promise<AIConfig>`, `setAIConfig(input: AIConfigInput): Promise<AIConfig>`, `aiAnalyze(context:string, question:string): Promise<{answer:string}>` (POST `/ai/analyze`).
- [ ] `components/admin/ai-panel.tsx` : charge `getAIConfig` ; provider Select (Anthropic / OpenAI-compat) ; base_url Input ; model Input ; api_key Input `type="password"` (write-only ; si `has_key` affiche « Clé configurée ✓ » + bouton « Effacer la clé » → `setAIConfig({..., clear_key:true})`) ; bouton Enregistrer → `setAIConfig` (n'envoie `api_key` que s'il a été saisi). Note : « Les données envoyées pour analyse quittent le Pi vers {base_url}. Nécessite internet. » Gérer erreurs 400. Monter le panneau sur la page admin près des autres.
- [ ] `npm run build` vert + `tsc` 0. Commit `feat(ai): client API + panneau de configuration IA (admin)`.

---

### Task 3: Frontend — bouton « Analyser avec l'IA » (Analyse CAN)

**Files:** Modify `app/analyse-can/page.tsx`.

**Interfaces:** `aiAnalyze` (Task 2), le constructeur de résumé Markdown déjà présent (bouton « Copier résumé pour IA »).

- [ ] Réutiliser le constructeur de résumé Markdown existant. Ajouter un champ question optionnel (défaut « Aide-moi à identifier le rôle des IDs et des signaux »), un bouton **« Analyser avec l'IA »** → `aiAnalyze(summary, question)`, afficher la réponse (zone markdown/texte, mono si besoin) + loading/erreur. Si l'erreur est « clé non configurée » (400) → message « Configurez la clé IA dans Administration ». Garder « Copier résumé pour IA » (fallback offline). Indiquer « données envoyées à l'IA ».
- [ ] Responsive. `npm run build` vert + `tsc` 0. Commit `feat(analyse-can): bouton Analyser avec l'IA (reponse LLM in-app)`.

---

## Self-Review

- Couverture spec : backend=T1 ; config UI=T2 ; analyse button=T3. Sécurité clé (jamais renvoyée/loggée, 0o600, user-set) = T1 + T2 write-only. ✅
- Filets : 3 routes ajoutées (T1) → inventory 151→154 + integration_boot (PUT guard / GET+analyze allowlist). ✅
- Pas de bus/injection ; égress externe signalé UI. ✅
- Dépendances : T1→T2→T3 séquentiel (T2 client avant T3 bouton). ✅
