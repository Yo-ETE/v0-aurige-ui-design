# Découpage main.py en routers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Déplacer les corps d'endpoints de `backend/main.py` vers `backend/routers/<domaine>.py` sans aucun changement de comportement, suite + inventaire de routes verts à chaque étape.

**Architecture:** Option 2 (spec §2) — helpers/state/constants/modèles RESTENT dans `main.py` ; les routers font `import main` et appellent `main.<helper>(...)` à l'exécution (préserve les patches de test), importent les modèles via `from main import <Model>`, gardent les chemins absolus `/api/...` inchangés, et sont câblés par `app.include_router(...)` avant le rebind CORS (~L9346).

**Tech Stack:** FastAPI APIRouter ; pytest.

**Spec:** `docs/superpowers/specs/2026-10-03-mainpy-router-split-design.md`

## Global Constraints

- Commentaires FR, code EN. ZÉRO changement fonctionnel. Chemins de route **inchangés**.
- Helpers/state/constants/globals/modèles Pydantic ne quittent PAS `main.py`. Appels = `main.<x>` à l'exécution ; jamais `from main import <helper>` pour un helper patché par les tests.
- Chaque task finit vert : `cd backend && python -m pytest -q` (dont `test_route_inventory`) ET `python -c "import main"`.
- `include_router(...)` toujours AVANT `fastapi_app = app` / rebind CORS.
- Préserver les alias de route (doubles décorateurs : `/status`+`/api/status`, download `/api`+non-`/api`).
- Un seul implémenteur à la fois (conflits sur main.py). BASE réenregistrée avant chaque task.

---

### Task 1: Filet — test d'inventaire de routes (golden)

**Files:** Create `backend/tests/test_route_inventory.py`.

- [ ] Écrire un test qui :
  1. `import main` ; collecte `routes = sorted({(m, r.path) for r in main.fastapi_app.routes for m in (getattr(r, "methods", None) or {"WS"})})` (inclure les WebSocketRoute → méthode sentinelle `"WS"` ; ignorer les routes internes FastAPI `/openapi.json`, `/docs`, `/redoc` si présentes — ou les inclure, tant que la golden les fige).
  2. Compare à une **constante golden** `EXPECTED` (liste figée) définie dans le test.
  3. `assert routes == EXPECTED` avec un message qui montre le diff (routes manquantes / en trop).
- [ ] Générer la golden : lancer un petit script one-shot qui imprime l'ensemble courant, coller le résultat tel quel dans `EXPECTED`. (Documenter dans le test comment régénérer.)
- [ ] Run `cd backend && python -m pytest tests/test_route_inventory.py -q` → PASS sur l'état actuel.
- [ ] Commit `test(routes): inventaire fige des routes (filet anti-regression refactor)`.

---

### Task 2: Nettoyage code mort + doublons (zéro comportement)

**Files:** Modify `backend/main.py`.

**Interfaces:** aucun symbole public retiré n'est référencé ailleurs (vérifié par la carto).

- [ ] Supprimer `class CandumpManager` + `candump_mgr = CandumpManager()` (≈ 693-798). Vérifier d'abord `grep -n candump_mgr backend/main.py` → une seule occurrence (la déf). Si un appelant existe, NE PAS supprimer, documenter.
- [ ] Supprimer `class SignalFinderState` + `signal_finder_state` (≈ 8278-8283) si `grep -n signal_finder_state` ne montre que la déf.
- [ ] Dédoublonner `count_log_frames` (451) vs `_count_log_frames` (1284) : comparer les deux corps ; si équivalents, garder `_count_log_frames`, rediriger les appelants de `count_log_frames` (ou l'inverse), supprimer l'autre. Si NON équivalents, laisser et noter.
- [ ] Retirer les `import subprocess` (≈7598) et `import time` (≈4910) en doublon dans les corps (déjà importés en tête) — seulement s'ils sont redondants.
- [ ] Run suite complète + `test_route_inventory` → vert (l'inventaire ne doit PAS changer).
- [ ] Commit `refactor(main): retire code mort (CandumpManager, signal_finder_state) + dedup`.

---

### Task 3: Router `tailscale` (preuve du motif)

**Files:** Create `backend/routers/tailscale.py`; Modify `backend/main.py`.

Routes (≈5121-5311) : GET `/api/tailscale/status` ; POST `/api/tailscale/up`, `/down`, `/logout`, `/set-exit-node`. Helpers utilisés : `main.run_command` (+ modèles éventuels de ce bloc, à importer via `from main import ...`).

- [ ] Créer `backend/routers/tailscale.py` : `from fastapi import APIRouter, HTTPException` ; `import main` ; `from main import <modèles du domaine si présents>` ; `router = APIRouter()`. Copier les fonctions d'endpoint avec `@router.post("/api/tailscale/up")` etc. (chemins inchangés), en remplaçant tout appel helper par `main.run_command(...)` et tout accès constant/state par `main.<x>`.
- [ ] Dans `main.py` : supprimer ces endpoints ; ajouter, dans le bloc d'inclusion près des `include_router` existants MAIS avant le rebind CORS : `from routers.tailscale import router as tailscale_router` + `app.include_router(tailscale_router)`.
- [ ] Run suite + inventaire → vert ; `python -c "import main"` OK.
- [ ] Commit `refactor(routers): extrait le domaine tailscale`.

---

### Task 4: Router `system`

**Files:** Create `backend/routers/system.py`; Modify `backend/main.py`.

Routes : apt (`/api/system/apt/update`, `/apt/upgrade`, GET `/apt/output`) ; power (`/reboot`, `/shutdown`) ; `/branches`, `/version`, `/data-info` ; backups (`/backups` GET, `/backup` POST, DELETE `/backups/{f}`, `/backups/{f}/restore`, GET `/backups/{f}/download`, `/backups/upload`) ; update (`/update`, GET `/update/output`) ; `/restart-services` ; GET `/api/system/check-update` (≈7595). Helpers/const : `main.run_command`, `main.DATA_DIR`, `main.GIT_REPO_PATH`, `valid_git_ref`/`valid_backup_filename` (importables), `main.subprocess` (patché → `main.subprocess.Popen`).

- [ ] **Globals mutables** `apt_output_store` (≈5038) et `update_output_store` (≈5338) RESTENT dans main. Les endpoints déplacés les LISENT via `main.apt_output_store` / `main.update_output_store`. Pour l'ÉCRITURE (actuellement `global ...; x = ...`), ajouter dans `main.py` de petits setters (`def _set_apt_output(d): global apt_output_store; apt_output_store = d` et idem update) et les appeler depuis le router ; OU, si plus simple/sûr, garder `/apt/*` et `/update` + `/update/output` DANS main et n'extraire que le reste du domaine system. Documenter le choix. (Les tests patchent `main.update_output_store` → la lecture doit passer par `main.`.)
- [ ] Extraire les endpoints (hors ceux gardés) vers `routers/system.py` (motif Task 3).
- [ ] Câbler `include_router`. Run suite (dont `test_update_guard`, apt, backups) + inventaire → vert.
- [ ] Commit `refactor(routers): extrait le domaine system`.

---

### Task 5: Router `network` (+ hotspot)

Routes (≈4509-5040, 4851-4890) : `/api/network/wifi/scan`, `/wifi/status`, `/ethernet/status`, `/wifi/saved`, `/wifi/connect` ; hotspot `/network/hotspot/status|credentials (GET/POST)|start|stop`. Helpers : `main.run_command`, `hotspot.*` (importable directement : `import hotspot`), modèles `WifiConnectRequest`/`HotspotPassword` via `from main import ...`.

- [ ] Créer `routers/network.py`, extraire, câbler, vérifier (dont `test_hotspot_api`). Commit `refactor(routers): extrait le domaine network/hotspot`.

---

### Task 6: Routers `can`, `capture`, `replay`, `generator`

Petits domaines proches (process dans `state`). Un fichier chacun OU un `routers/can_io.py` groupant les 4 (décider ; préférer 4 fichiers clairs). Routes :
- can : `/api/can/{interface}/status`, `/api/can/init`, `/scan-bitrate`, `/stop`, `/send` (≈1025-1282). Modèles `CANInitRequest`,`CANFrame`,`BitrateScan*`. `main.can_send_frame`, `main.can_interface_up/down`, `main.get_can_interface_status`, `main.run_command`.
- capture : `/api/capture/start|stop|status` (≈1284-1420). `main.state.capture_*`, `main.get_mission_logs_dir`, `main.update_mission_stats`, `main._count_log_frames`, `main.load_mission`.
- replay : `/api/replay/start|stop|force-cleanup|status` (≈1422-1560). `main.state.canplayer_process`, `main.run_command_async`.
- generator : `/api/generator/start|stop|status` (≈1894-1995). `main.state.cangen_process`, `main.is_id_blocked`, `main._load_blocklist`.

- [ ] Extraire les 4 (une sous-étape chacun, commits séparés possibles), câbler, vérifier suite (`test_generator`) + inventaire à chaque. Commit(s) `refactor(routers): extrait can|capture|replay|generator`.

---

### Task 7: Router `injection` (inject + aud06 + known-frames)

Routes (≈1566-1890) : inject `/api/inject/start|stop|status` ; aud06 `/api/aud06/blocklist` GET/PUT ; known-frames `/api/known-frames` (GET/POST), `/{fid}` (PATCH/DELETE), `/{fid}/replay`. Ils partagent regex + `_start_inject_frames` + helpers AUD-06 (`is_id_blocked`, `_norm_id`, `_load_blocklist`, `_save_blocklist`) qui RESTENT dans main. Modèles `InjectRequest`, `KnownFrameCreate/Patch/ReplayRequest`, `BlocklistRequest` via `from main import ...`. Tests patchent `main.INJECT_SCRIPT_PATH`, `main.BLOCKLIST_PATH`, `main.INJECT_MAX_FRAMES`, `main._save_blocklist`, `main._injectable_or_block`, `main._start_inject_frames`, `main.state.inject_process` → corps appellent via `main.`.

- [ ] Extraire vers `routers/injection.py`, câbler, vérifier (`test_inject`, `test_aud06`, `test_known_frames`) + inventaire. Commit `refactor(routers): extrait injection (inject/aud06/known-frames)`.

---

### Task 8: Router `fuzzing`

Routes (≈1997-2677, SAUF `/api/missions/{id}/logs-analysis` 2679 qui reste pour missions) : `/api/fuzzing/start|stop|force-cleanup|crash-recovery|analyze-crash|compare-logs`, GET `/status|history`. Contient le template f-string du script (déplacer tel quel). `main.state.fuzzing_process`, `main.FUZZ_SCRIPT_PATH`, `main.is_id_blocked`, `main.get_mission_logs_dir`, `main.subprocess.Popen` (patché). Modèles `FuzzingRequest`,`CrashRecoveryRequest`.

- [ ] Extraire vers `routers/fuzzing.py`, câbler, vérifier + inventaire. Commit `refactor(routers): extrait fuzzing`.

---

### Task 9: Router `obd`

Routes (≈3719-4398) : `/api/obd/vin|dtc/read|dtc/pending|dtc/permanent|pid-read|status|freeze-frame|dtc/clear|reset|scan-pids|full-scan|pid`, GET `/last-report`. Helpers : `main.obd_send_with_flow_control`, `main.parse_candump_line`, `main.decode_dtcs_from_frames`, `main.can_send_frame`, `main.OBD_PID_DECODERS`, `main.guard_obd_http`, `main._obd_body`, `main._read_pid_value`, `main._read_dtcs`, `main.dtc_description`. Modèle `OBDRequest`. (Garder le WS `/ws/signal-finder` HORS de ce router.)

- [ ] Extraire vers `routers/obd.py`, câbler, vérifier (`test_obd_*`) + inventaire. Commit `refactor(routers): extrait obd`.

---

### Task 10: Routers `missions` (sous-divisé)

Régions missions : CRUD+logs (2786-3590), logs-analysis (2679), mission-dbc (6294-6580), dbc-from-library mission-side (6754-6804), compare-logs (6844-7419), import-log (7426), comparisons CRUD (7510-7594), export (7624-7785). Volumineux → sous-étapes :
- 10a `routers/missions_core.py` : CRUD missions + duplicate + logs (list/download/content/delete/create-frame/tags/rename/split/co-occurrence) + logs-analysis.
- 10b `routers/missions_dbc.py` : mission DBC (import/message/signal/delete/export) + from-library + dbc/active.
- 10c `routers/missions_compare.py` : compare-logs + comparisons CRUD + export + import-log.
Helpers : `main.load_mission`/`save_mission`/`get_mission_logs_dir`/`update_mission_stats`/`sanitize_id`, DBC helpers (`main._merge_parsed_dbc`,`main._import_dbc_into_doc`,`main._mission_dbc_path` patché), `main.get_comparisons_file`/`load_comparisons`/`save_comparisons`. Modèles nombreux (importer via `from main import ...`).

- [ ] Extraire 10a,10b,10c (commits séparés), câbler chacun, vérifier (`test_dbc_mission`, missions, compare) + inventaire à chaque. Commit(s) `refactor(routers): extrait missions-core|dbc|compare`.

---

### Task 11: Router `dbc` (bibliothèque)

Routes (≈6583-6804, la partie `/api/dbc...` non mission) : `/api/dbc` GET/POST, `/api/dbc/{id}` GET/PATCH/DELETE, `/message|signal`, DELETE `/signal/{sid}|message/{can_id}`, `/export`, `/import`, `/from-mission/{mid}`. Helpers `main._dbc_lib_path` (patché), `main._lib_doc_or_404`, `dbc_store`, `valid_dbc_id`.

- [ ] Extraire vers `routers/dbc.py`, câbler, vérifier (`test_dbc_library`) + inventaire. Commit `refactor(routers): extrait dbc library`.

---

### Task 12: Router `analysis`

Routes : `/api/analysis/family-diff` (6052), `/correlate-obd` (8040), `/byte-heatmap`, `/auto-detect-signals`, `/inter-id-dependencies`, `/validate-causality` (8509-9335) ; signal-finder HTTP `/api/signal-finder/extract-obd-from-log`, `/read-pid` (8100-8276). Helpers : `main._resolve_log_path`, correlation/detection helpers (`main._correlate_obd_with_can`, etc.), `main.is_id_blocked`, `main.OBD_FILTER_IDS`, `main.OBD_PID_DECODERS`. Modèles nombreux.

- [ ] Extraire vers `routers/analysis.py`, câbler, vérifier + inventaire. Commit `refactor(routers): extrait analysis + signal-finder HTTP`.

---

### Task 13: WebSockets + sniffer (décision)

WS `/ws/candump` (3591), `/api/sniffer/start|stop` (3677), `/ws/cansniffer` (4408), `/ws/signal-finder` (8286). Ferment sur `state`/`sniffer_state`/`broadcast_to_websockets`. 
- [ ] Évaluer le gain vs risque. Option A : router `routers/ws.py` avec `@router.websocket(...)` référencant `main.state`, `main.sniffer_state`, `main.broadcast_to_websockets` ; `sniffer_state`/`broadcast_to_websockets` RESTENT dans main. Option B (par défaut si risque) : **laisser dans main.py** et documenter. Décider à l'implémentation ; privilégier A seulement si suite + inventaire restent triviuraux à garder verts.
- [ ] Si extrait : vérifier WS (les tests d'intégration boot + tout test WS) + inventaire. Commit `refactor(routers): extrait websockets` OU note « laissé dans main (risque) ».

---

## Self-Review

- Couverture : toutes les régions de la carto sont affectées à une task ou explicitement laissées dans main (websockets option B). ✅
- Filet : `test_route_inventory` (Task 1) tourne à chaque task → aucune route perdue/ajoutée. ✅
- Patches de test préservés : règle « appels via `main.` » répétée dans chaque task + Global Constraints. ✅
- Risque : ordre d'import (routers importés en bas de main, avant rebind CORS) explicite dans la spec §3 + chaque task ; globals mutables (system) traités en Task 4 avec repli. ⚠️ points chauds documentés, pas de placeholder.
- Dépendances inter-task : toutes modifient main.py → strictement séquentielles (Global Constraints). ✅
