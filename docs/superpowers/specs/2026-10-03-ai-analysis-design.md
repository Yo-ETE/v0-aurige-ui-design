# AURIGE — Analyse CAN assistée IA (API Claude / provider-agnostic)

> Design 2026-10-03. Envoyer un résumé structuré des analyses CAN (heatmap, signaux, candidats,
> diff, IDs) + une question à un LLM (API Anthropic par défaut, provider-agnostic) et afficher la
> réponse dans l'UI. Clé API fournie par l'utilisateur, opt-in. Branche `audit-remediation`. FR UI, EN code.

## 1. But

Analyse rapide assistée : « ID 3B7 byte2 = compteur vitesse probable, 7E8 = réponse OBD… ».
L'utilisateur lance heatmap/auto-detect/corrélation → bouton « Analyser avec l'IA » → le backend
relaie le résumé + la question au LLM configuré → réponse affichée.

## 2. Contraintes / sécurité (dominantes)

- **Clé API = fournie par l'utilisateur, jamais par Claude Code.** Je ne demande/manipule aucune clé.
  Stockée côté backend `AURIGE_DATA_DIR/ai_config.json` (sauvegarde atomique, `chmod 0o600`). JAMAIS
  renvoyée par l'API (GET config = masquée, `has_key: bool`), JAMAIS loggée.
- **Opt-in + égress de données :** `analyze` envoie des données CAN du véhicule à un service externe.
  Faible sensibilité (véhicule de l'utilisateur) mais ça quitte le Pi → l'UI l'indique clairement.
- **Nécessite internet** (ou Tailscale) sur le Pi → ne marche PAS en mode hotspot offline. `analyze`
  renvoie une erreur réseau claire si injoignable.
- **Pas d'injection CAN, pas de bus** : feature purement données→LLM. AUD-06 inchangé.
- Valider `base_url` (schéma http/https uniquement) ; timeout sur l'appel (ex 60s) ; `max_tokens` borné.
- Aucune clé en dur, aucun provider par défaut qui fuite.

## 3. Backend

- `backend/ai_client.py` :
  - `AI_CONFIG_PATH = AURIGE_DATA_DIR/"ai_config.json"`. `load_config() -> dict`
    (`{provider:"anthropic"|"openai", base_url:str, model:str, api_key:str}`, défauts : provider anthropic,
    base_url "https://api.anthropic.com", model "claude-opus-5-5", api_key ""). `save_config(cfg)` atomique + `chmod 0o600`.
  - `async def analyze(context: str, question: str) -> str` : charge la config ; si `api_key` vide → lève
    une erreur « clé IA non configurée » ; construit la requête selon `provider` :
    - anthropic : `POST {base_url}/v1/messages`, headers `x-api-key: <key>`, `anthropic-version: 2023-06-01`,
      body `{model, max_tokens: 1024, messages:[{role:"user", content: <question>\n\n<context>}]}` ; réponse
      = `data["content"][0]["text"]`.
    - openai : `POST {base_url}/v1/chat/completions`, header `Authorization: Bearer <key>`,
      body `{model, max_tokens:1024, messages:[{role:"user", content: ...}]}` ; réponse = `choices[0].message.content`.
    - httpx async, timeout 60s. Erreurs réseau/HTTP → message clair (statut + court extrait), SANS fuiter la clé.
  - Validation `base_url` (http/https) avant l'appel.
- `backend/routers/ai.py` (router, motif `import main` / `main.<x>`) :
  - `GET /api/ai/config` → `{provider, base_url, model, has_key: bool}` (JAMAIS la clé). Auth seule.
  - `PUT /api/ai/config {provider, base_url?, model, api_key?}` → valide (provider ∈ {anthropic,openai},
    base_url http/https) ; si `api_key` fourni et non vide → stocké ; si absent/`""` → **conserve** la clé
    existante (ne pas l'effacer involontairement) ; un champ explicite `clear_key: true` efface. Garde `safety_config`.
  - `POST /api/ai/analyze {context, question}` → 400 si pas de clé ; appelle `ai_client.analyze` ; renvoie
    `{answer}` ou 502/erreur claire si le provider échoue. Auth seule (toute personne connectée ; dépense le
    budget API configuré). `context`/`question` bornés en taille (ex 100k / 4k chars) → 400 sinon.
  - `permissions.py` : `("PUT", r"^/api/ai/config", ["safety_config"])`. `analyze` + `GET config` = auth seule.
- Dépendances : `httpx` déjà présent (0.28.1). Ajouter à `requirements.txt` s'il n'y est pas.

## 4. Frontend

- `lib/api.ts` : types `AIConfig {provider, base_url, model, has_key}`, `AIConfigInput {provider, base_url?, model, api_key?, clear_key?}` ;
  `getAIConfig()`, `setAIConfig(input)`, `aiAnalyze(context, question): Promise<{answer:string}>`.
- **Panneau config (admin)** `components/admin/ai-panel.tsx` (monté sur la page admin, à côté de network/system/users) :
  provider Select (Anthropic/OpenAI-compat), base_url Input, model Input, api_key Input (type password,
  write-only ; affiche « Clé configurée ✓ » si `has_key`, bouton « Effacer la clé » → `clear_key`). Note opt-in +
  « données envoyées à <base_url> ». `setAIConfig` à l'enregistrement.
- **Analyse CAN** (`app/analyse-can/page.tsx`) : à côté de « Copier résumé pour IA » (gardé comme fallback offline),
  ajouter **« Analyser avec l'IA »** : réutilise le même constructeur de résumé Markdown, + un champ question
  optionnel (défaut « Aide-moi à identifier le rôle des IDs et des signaux »), appelle `aiAnalyze(summary, question)`,
  affiche la réponse (zone de texte/markdown) + états loading/erreur. Si 400 « clé non configurée » → message
  « Configurez la clé IA dans Administration ». Indique « données envoyées à l'IA ».
- Responsive. Réutilise `lib/export-utils.ts` (copie) + shadcn.

## 5. Tests

- Backend (pytest + TestClient, mock httpx) :
  - config : GET sans clé → `has_key:false` ; PUT avec `api_key` → persistée (0o600) ; GET → `has_key:true`, la clé
    N'EST PAS dans la réponse ; PUT sans `api_key` conserve la clé ; `clear_key:true` l'efface ; base_url non http → 400 ;
    provider invalide → 400.
  - analyze : pas de clé → 400 ; avec clé + httpx mocké (réponse anthropic) → `{answer:"..."}` ; provider openai mocké →
    parse `choices[0].message.content` ; erreur HTTP provider → 502 clair, clé absente des logs/réponse ; context trop long → 400.
  - `test_route_inventory` : +3 routes (GET/PUT `/api/ai/config`, POST `/api/ai/analyze`) → régénérer EXPECTED (151→154).
  - `test_integration_boot` : PUT config gardé `safety_config` ; POST analyze + GET config read-only → allowlist
    (ne touchent ni le bus ni l'état Pi ; analyze = égress sortant).
- Frontend : `npm run build` vert + `npx tsc --noEmit` **0**.
- Vérif réelle (utilisateur) : renseigne SA clé dans Administration, lance une analyse, obtient une réponse.

## 6. Inventaire

Backend : `backend/ai_client.py` (nouveau), `backend/routers/ai.py` (nouveau) + include dans `main.py` (avant rebind CORS),
`backend/permissions.py`, `backend/requirements.txt` (httpx si absent), `backend/tests/test_ai.py` + maj
`test_route_inventory`/`test_integration_boot`.
Frontend : `lib/api.ts`, `components/admin/ai-panel.tsx` (nouveau) + montage page admin, `app/analyse-can/page.tsx`.
