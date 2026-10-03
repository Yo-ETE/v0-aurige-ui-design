# AURIGE — Découpage de backend/main.py en routers FastAPI (sans régression)

> Design 2026-10-03. Réduire `backend/main.py` (9357 lignes, ~190 routes `@app.*`) en
> déplaçant les corps d'endpoints vers `backend/routers/<domaine>.py`, SANS changer aucun
> comportement ni casser la suite de tests. Branche `audit-remediation`. Commentaires FR, code EN.

## 1. But + contrainte dominante

Maintenabilité : `main.py` est un monolithe. Objectif = fichier par domaine, zéro changement
fonctionnel, suite verte à chaque étape.

**Contrainte n°1 (dicte l'architecture) :** les tests patchent des symboles SUR `main`
(`monkeypatch.setattr(main, "run_command_async", ...)`, `main.state.inject_process`,
`main.INJECT_SCRIPT_PATH`, `main.decode_dtcs_from_frames`, `main.get_mission_logs_dir`,
`main.can_send_frame`, `main.obd_send_with_flow_control`, `main.update_output_store`,
`main._mission_dbc_path`, `main._dbc_lib_path`, `main._save_blocklist`, `main._norm_id`,
`main._injectable_or_block`, `main.subprocess.Popen`, `main.BLOCKLIST_PATH`, `main.FUZZ_SCRIPT_PATH`,
`main.INJECT_MAX_FRAMES`…). Ces patches ne fonctionnent QUE si le code appelle le symbole
**via `main.` au moment de l'appel**. Déplacer un helper vers un autre module et l'importer en
copie casse le patch (et le comportement en test). Donc : **les helpers/state/constants/models
RESTENT dans `main.py`**, et les routers y accèdent par `main.<symbole>` à l'exécution.

## 2. Architecture — Option 2 (référence `main.*` à l'appel)

- `main.py` garde : imports, `DATA_DIR`/`MISSIONS_DIR`/`DB_PATH`, `ProcessState` + `state`,
  tous les helpers (`run_command`, `run_command_async`, `can_send_frame`, `is_id_blocked`,
  `_norm_id`/`_id_int`/`_load_blocklist`/`_save_blocklist`, `get_can_interface_status`,
  `get_mission_logs_dir` & co, `obd_send_with_flow_control`, `parse_candump_line`,
  `decode_dtcs_from_frames`, `_start_inject_frames`, correlation/detection helpers, DBC helpers…),
  toutes les constantes/regex (`OBD_FILTER_IDS`, `OBD_PID_DECODERS`, `DTC_DESCRIPTIONS`,
  `_HEX_ID`… `INJECT_SCRIPT_PATH`, `BLOCKLIST_PATH`, `FUZZ_SCRIPT_PATH`, `GIT_REPO_PATH`…),
  les globals mutables (`apt_output_store`, `update_output_store`), **tous les modèles Pydantic**,
  `lifespan`, `fastapi_app = app`, et le wrapper CORS/SessionAuth final.
- `backend/routers/<domaine>.py` : `router = APIRouter()` (PAS de prefix — les chemins actuels
  sont absolus `/api/...`, on les garde **tels quels** sur les décorateurs `@router.*`).
  - En tête : `import main` (objet module) pour les appels à l'exécution (`main.can_send_frame(...)`,
    `main.state`, `main.OBD_FILTER_IDS`, `main.INJECT_SCRIPT_PATH`, …).
  - Pour les **modèles et symboles utilisés dans les SIGNATURES/décorateurs** (annotations de type,
    `response_model=`, valeurs par défaut `Query(...)`), importer explicitement depuis main :
    `from main import CANFrame, Mission, OBDRequest, …`. Ces symboles ne sont jamais patchés →
    l'import-copie est sûr, et il est résolu au moment où `main` importe le router (voir §3 ordre).
  - Helpers appelés dans les corps : TOUJOURS `main.helper(...)` (jamais `from main import helper`),
    pour préserver les patches de test.
  - `HTTPException`, `APIRouter`, types FastAPI : importer de fastapi directement.
- `main.py`, juste AVANT `fastapi_app = app` : `from routers.<domaine> import router as <d>_router`
  puis `app.include_router(<d>_router)` pour chaque domaine extrait. (Comme `auth_router`/`users_router`
  déjà présents lignes 115-116.)

## 3. Ordre d'import (évite le cycle)

`main` importe les routers **en bas du fichier**, après que tous les helpers/constants/modèles
soient définis. Chaque router fait `import main` (lie l'objet module, déjà dans `sys.modules`,
même partiel) et `from main import <modèles>` (ces noms existent déjà car main est passé leur
définition avant d'atteindre l'import du router). Aucun code au niveau module d'un router n'appelle
`main.*` à l'import (seulement dans les corps d'endpoints). Le cycle est ainsi inoffensif.
Contrainte absolue : tous les `include_router` AVANT la ligne `fastapi_app = app` / le rebind CORS
(actuellement ~9346). Les tests itèrent `main.fastapi_app.routes` → l'ensemble doit rester identique.

## 4. Filet de sécurité (obligatoire, avant tout déplacement)

`backend/tests/test_route_inventory.py` : construit l'ensemble `{(method, path)}` de
`main.fastapi_app.routes` (routes HTTP + websockets) et le compare à une **liste de référence figée**
(golden, stockée dans le test). Le test échoue si une route disparaît, change de chemin/méthode, ou
si une route en double apparaît. Il tolère l'ordre. Ce test tourne à CHAQUE étape : aucune extraction
ne doit modifier l'ensemble des routes. (Capturer la golden depuis l'état actuel au début.)

## 5. Nettoyage sûr préalable (zéro comportement)

Avant d'extraire, retirer le code mort (confirmé sans appelant par la cartographie) :
- `CandumpManager` + `candump_mgr` (≈ 693-798) — aucun appelant.
- `SignalFinderState` + `signal_finder_state` (≈ 8278-8283) — jamais lu.
- Dédoublonner `count_log_frames` (451) vs `_count_log_frames` (1284) : garder une seule
  implémentation, rediriger les appelants (vérifier qu'elles sont équivalentes ; sinon garder les 2
  et documenter). Retirer les `import subprocess`/`import time` en doublon dans les corps (déjà en tête).
Chaque retrait vérifié par la suite + le test d'inventaire.

## 6. Ordre d'extraction (du plus isolé au plus couplé)

Vague par vague, un router par domaine, suite + inventaire verts à chaque fois :
1. **tailscale** (5121-5311, uniquement `run_command`) — preuve du motif.
2. **system** (apt/power/reboot/update/backups/version/branches/data-info/check-update/restart-services)
   — attention aux globals `apt_output_store`/`update_output_store` : ils RESTENT dans main ;
   les endpoints du router les lisent/écrivent via `main.apt_output_store` (lecture) et pour l'écriture
   exposer des petits setters dans main OU garder ces 2 endpoints dans main si le `global` pose
   problème (décider à l'implémentation, documenter).
3. **network + hotspot** (4509-5040, 4851-4890) — délèguent à `hotspot.*`, `run_command`.
4. **generator** (1894-1995), **replay** (1422-1560), **capture** (1284-1420) — petits, `state.*`.
5. **inject + aud06 + known-frames** (1566-1890) ensemble (ils partagent regex + `_start_inject_frames`
   + helpers AUD-06 qui restent dans main) — un seul router `injection` ou trois petits.
6. **can** (1025-1282).
7. **fuzzing** (1997-2677, sauf la route `logs-analysis` 2679 qui va avec missions).
8. **obd** (3719-4398) + le websocket `/ws/signal-finder` reste près de l'analyse.
9. **missions** (CRUD+logs+tags+split+co-occurrence+import+export+comparisons, régions 2786-3590 +
   6294-6580 mission-dbc + 6754-6804 + 6844-7419 compare + 7426 import + 7510-7594 comparisons +
   7624-7785 export + 2679 logs-analysis). Gros — peut se subdiviser (missions-core, missions-logs,
   missions-dbc, missions-compare).
10. **dbc library** (6583-6804).
11. **analysis + signal-finder** (6052 family-diff, 7787-8276 correlate/extract/read-pid,
    8509-9335 heatmap/auto-detect/dependencies/causality).
12. **websockets** (`/ws/candump` 3591, `/ws/cansniffer` 4408, `/ws/signal-finder` 8286) + sniffer
    start/stop — délicat (ferment sur `state`/`sniffer_state`) ; `sniffer_state` peut rester dans main
    et le router y accéder via `main.sniffer_state`. Peut être fait en dernier ou laissé dans main.

Les domaines trop entrelacés ou risqués (websockets, gros handlers) peuvent rester dans `main.py`
si l'extraction n'apporte pas un gain net sûr — c'est acceptable (objectif = réduire + clarifier,
pas atteindre zéro route dans main à tout prix).

## 7. Règles par extraction (chaque task)

- Déplacer les corps d'endpoints d'un domaine vers `routers/<d>.py`, décorateurs `@router.*` avec les
  **chemins absolus inchangés**. `import main` + `from main import <modèles/aliases de ce domaine>`.
- Dans main : retirer les endpoints déplacés, ajouter `from routers.<d> import router as <d>_router`
  + `app.include_router(<d>_router)` avant le rebind CORS.
- NE PAS déplacer les helpers/constants/models/state. Les appels deviennent `main.<helper>(...)`.
- Les alias de route (double décorateur, ex `/status` + `/api/status`, download `/api` + non-`/api`)
  doivent être préservés (deux `@router.*` sur la même fonction).
- Vérifier : `cd backend && python -m pytest -q` TOUT vert (y compris `test_route_inventory`), et
  `python -c "import main"` sans erreur. Aucune nouvelle route, aucune disparue.

## 8. Tests & vérif

- `test_route_inventory` vert à chaque étape (ensemble de routes figé).
- Suite complète verte à chaque étape (les patches `main.*` doivent continuer de mordre → preuve que
  les corps appellent bien `main.helper`).
- `import main` OK ; `uvicorn` cible toujours `main:app` (le wrapper CORS inchangé).
- Frontend : non touché.
- Pas de vérif voiture nécessaire (refactor interne, comportement identique).

## 9. Inventaire fichiers

Créé : `backend/routers/<domaine>.py` (plusieurs), `backend/tests/test_route_inventory.py`.
Modifié : `backend/main.py` (retrait endpoints + include_router + nettoyage code mort), au besoin
`backend/routers/__init__.py` (rester vide/paquet).
