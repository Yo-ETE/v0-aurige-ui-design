# AUD-06 + Trames crash/réinit + Fuzzing ciblé — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Garde commun `is_id_blocked()` qui sécurise le fuzzing/sweep sans bloquer les actions explicites, + bibliothèque globale de trames crash/réinit rejouables (UI Crash Recovery), + fuzzing ciblé / rejeu historique / export.

**Architecture:** Backend FastAPI : `is_id_blocked` + blocklist JSON global ; enforcement UNIQUEMENT sur fuzzing/generator/validate-causality ; bibliothèque `known_frames.json` avec replay via `can_send_frame` (one-shot) ou le sous-système inject existant (boucle). Frontend : client API + section Crash Recovery (biblio + éditeur blocklist, confirmation sur rejeu crash) + fuzzing (ciblage, rejeu historique, export).

**Tech Stack:** FastAPI, pytest+TestClient ; Next.js 16 / React 19 / shadcn-ui.

**Spec:** `docs/superpowers/specs/2026-10-02-aud06-crash-frames-design.md`

## Global Constraints

- Commentaires/UI **français**, code **anglais**.
- `is_id_blocked` **exempte toujours** `OBD_FILTER_IDS` (`7DF`,`7E0`..`7EF`). Liste critique défaut = **vide**.
- Enforcement is_id_blocked : **seulement** fuzzing (skip IDs bloqués / 403 si tout bloqué), generator (403 id bloqué ; 403 random+liste non vide), validate-causality (403 source bloqué). **PAS** sur can/send, inject, replay, crash-recovery (reset), rejeu bibliothèque.
- Sauvegardes JSON atomiques (tmp + `os.replace`). Pas de `shell=True`.
- Backend : pytest vert à chaque task. Frontend : `npm run build` vert, pas de nouvelle erreur tsc (baseline ~80).
- `DATA_DIR = Path(getenv("AURIGE_DATA_DIR","/opt/aurige/data"))` (main.py:51).

---

### Task 1: AUD-06 — is_id_blocked + blocklist + enforcement (backend)

**Files:** Modify `backend/main.py`, `backend/permissions.py` ; Create `backend/tests/test_aud06.py`.

**Interfaces:**
- Produces : `def _norm_id(s:str)->str` (strip, upper, retire `0X`) ; `def is_id_blocked(can_id:str)->bool` ;
  `GET/PUT /api/aud06/blocklist` ; enforcement dans `start_fuzzing`, `start_generator`, `validate_causality_endpoint`.
  `FuzzingResponse` gagne `blocked_skipped:int`.

- [ ] **Step 1 — Test** `backend/tests/test_aud06.py` (login admin via la fixture d'auth comme `test_obd_live.py`/`test_inject.py` ; monkeypatch le chemin blocklist vers un tmp) :
```python
# is_id_blocked
def test_obd_never_blocked(...):  # met 7E8 dans la blocklist -> is_id_blocked("7E8") False
def test_blocked_id(...):          # blocklist {4C8} -> is_id_blocked("0x4c8") True (normalisation)
# blocklist endpoints
def test_put_rejects_obd_id(...):  # PUT {ids:["7DF"]} -> 400
def test_blocklist_roundtrip(...): # PUT {ids:["4C8","360"]} puis GET -> {ids:["4C8","360"]}
# enforcement (mock l'exec process de fuzzing/generator)
def test_fuzzing_skips_blocked(...):   # blocklist {4C8}; targetIds ["4C8","360"] -> 200, blocked_skipped==1, script ne contient pas 4C8
def test_fuzzing_all_blocked_403(...): # targetIds ["4C8"] -> 403
def test_generator_blocked_id_403(...):# can_id 4C8 -> 403
def test_causality_blocked_source_403(...): # source_id 4C8 -> 403
```
- [ ] **Step 2 — Run, expect FAIL.**
- [ ] **Step 3 — Implémenter** (voir spec §4) : `_norm_id`, `is_id_blocked` (exempte `OBD_FILTER_IDS`), helpers `_load_blocklist()/_save_blocklist(ids)` (`DATA_DIR/aud06_blocklist.json`, atomique, défaut `{"ids":[]}`), endpoints `GET/PUT /api/aud06/blocklist` (PUT valide hex + refuse OBD → 400). Enforcement :
  - `start_fuzzing` : construire la liste effective d'IDs (target_ids normalisés sinon la plage `idStart..idEnd` en `{:03X}`/hex) ; filtrer via `is_id_blocked` ; si vide → `HTTPException(403,"Tous les IDs cibles sont bloques (AUD-06)")` ; sinon passer la liste filtrée au script (utiliser `target_ids` filtré ; si c'était une plage, convertir en `target_ids`), et renvoyer `blocked_skipped`.
  - `start_generator` : `can_id` bloqué → 403 ; `can_id is None` et blocklist non vide → 403 (message spec).
  - `validate_causality_endpoint` : `source_id` bloqué → 403.
  - `permissions.py` : ajouter flag `safety_config` à `ACTION_FLAGS` ; règle `("PUT", r"^/api/aud06/", ["safety_config"])` ; donner `safety_config` à admin + operator (suivre le défaut des rôles).
- [ ] **Step 4 — Run** `cd backend && python -m pytest -q` PASS.
- [ ] **Step 5 — Commit** `feat(aud06): is_id_blocked + blocklist critique + garde fuzzing/generator/causality`.

---

### Task 2: Bibliothèque trames crash/réinit (backend)

**Files:** Create `backend/known_frames.py`, `backend/tests/test_known_frames.py` ; Modify `backend/main.py`, `backend/permissions.py`.

**Interfaces:**
- Consumes : `can_send_frame` (617), `inject_start`/`state.inject_process` (1565) pour la boucle.
- Produces : endpoints `GET/POST /api/known-frames`, `PATCH/DELETE /api/known-frames/{fid}`,
  `POST /api/known-frames/{fid}/replay`.

- [ ] **Step 1 — `backend/known_frames.py`** : helpers purs (chemin configurable via var module `KNOWN_FRAMES_PATH = DATA_DIR/"known_frames.json"`), `load_frames()->list[dict]`, `save_frames(list)` (atomique), `add_frame(dict)->dict` (uuid4 `id`, `created_at`), `update_frame(fid,patch)`, `delete_frame(fid)`. Validation hex : `can_id ^[0-9A-Fa-f]{1,8}$`, `crash_data`/`reset_data` `^([0-9A-Fa-f]{2}){0,8}$`.
- [ ] **Step 2 — Test** `backend/tests/test_known_frames.py` (monkeypatch `known_frames.KNOWN_FRAMES_PATH` + le chemin utilisé par main vers tmp ; login admin) :
```python
def test_crud(...):                 # POST crée, GET liste, PATCH modifie label, DELETE retire
def test_bad_hex_400(...):          # can_id "ZZ" -> 400
def test_replay_oneshot(...):       # mock main.can_send_frame -> replay kind=crash loop=false appelle can_send_frame(can_id, crash_data)
def test_replay_reset_missing_400(...): # entrée sans reset_data, replay kind=reset -> 400
def test_replay_not_blocked(...):   # blocklist {4C8}; entrée can_id 4C8; replay -> 200 (is_id_blocked PAS appele)
```
- [ ] **Step 3 — Run, expect FAIL.**
- [ ] **Step 4 — Implémenter** endpoints dans `main.py` (importer `known_frames`), `POST /{fid}/replay` : `kind=crash|reset` (reset sans reset_data→400) ; `loop=false`→`can_send_frame(interface, can_id, data)` ; `loop=true`→réutiliser la logique de `inject_start` en mode frame (appeler le même mécanisme ou factoriser ; NE PAS appeler `is_id_blocked`). Valider `interface` comme ailleurs. `permissions.py` : `("POST", r"^/api/known-frames", ["can_inject"])` + `("PATCH", ...)` + `("DELETE", ...)`.
- [ ] **Step 5 — Run** pytest PASS.
- [ ] **Step 6 — Commit** `feat(known-frames): bibliotheque trames crash/reinit + rejeu one-shot/boucle`.

---

### Task 3: Client API (frontend)

**Files:** Modify `lib/api.ts`.

**Interfaces:**
- Produces : types `KnownFrame {id,can_id,crash_data,reset_data?,label,severity,notes?,created_at}`,
  `AUD06Blocklist {ids:string[]}` ; fonctions `getBlocklist()`, `setBlocklist(ids)`, `listKnownFrames()`,
  `createKnownFrame(p)`, `updateKnownFrame(fid,p)`, `deleteKnownFrame(fid)`, `replayKnownFrame(fid,{interface,kind,loop,intervalMs})`.

- [ ] **Step 1** — Ajouter types + fonctions en suivant le style `fetchApi` existant (vérifier le préfixe `/api`). Endpoints : `/aud06/blocklist` (GET, PUT), `/known-frames` (GET, POST), `/known-frames/{fid}` (PATCH, DELETE), `/known-frames/{fid}/replay` (POST).
- [ ] **Step 2** — `npm run build` + `npx tsc --noEmit` (count avant/après). Commit `feat(api): client AUD-06 blocklist + bibliotheque trames`.

---

### Task 4: Crash Recovery UI — biblio + éditeur blocklist

**Files:** Modify `app/crash-recovery/page.tsx`.

**Interfaces:** Consumes Task 3 + `<InjectStatusBar/>` (`@/components/inject-status`).

- [ ] **Step 1** — Carte « Trames remarquables (crash / réinit) » : charger `listKnownFrames()` ; tableau (label, can_id, crash_data, reset_data, gravité) ; formulaire d'ajout (`createKnownFrame`) ; par ligne boutons **Rejouer crash** (`replayKnownFrame(fid,{interface,kind:"crash",loop:false})`), **Rejouer crash en boucle** (`loop:true`), **Rejouer réinit** (`kind:"reset"`, désactivé si pas de reset_data), **Supprimer** (`deleteKnownFrame`). Les 2 boutons crash ouvrent un `AlertDialog` de confirmation « Injection volontaire sur ID potentiellement critique » avant l'appel ; réinit sans confirm. Rendre `<InjectStatusBar className="mb-4"/>` en tête pour stopper une boucle. Interface = `selectedInterface` déjà présent sur la page.
- [ ] **Step 2** — Carte « IDs critiques (AUD-06) » : `getBlocklist()`/`setBlocklist()` ; liste d'IDs avec ajout (Input hex) + suppression ; note « fuzzing/génération ne balaient jamais ces IDs ; OBD jamais bloqué ». Gérer l'erreur 400 (OBD refusé) via un message.
- [ ] **Step 3** — Si l'URL porte `?crashFrame=<can_id>&crashData=<data>` (venant du fuzzing), préremplir le formulaire d'ajout (lire `useSearchParams`, wrap `<Suspense>` si le build l'exige — même pattern que analyse-can). Responsive `flex flex-wrap`, tableaux `overflow-x-auto`.
- [ ] **Step 4** — `npm run build` + `npx tsc` (pas de nouvelle erreur). Commit `feat(crash-recovery): bibliotheque trames crash/reinit + editeur IDs critiques`.

---

### Task 5: Fuzzing UI — ciblage + rejeu historique + export

**Files:** Modify `app/fuzzing/page.tsx`, `components/sent-frames-history.tsx`.

**Interfaces:** Consumes `export-store.addFrames` + `useRouter` ; navigation vers `/crash-recovery?crashFrame=...&crashData=...`.

- [ ] **Step 1** — `handleStart` : en modes `random`/`static`, si `selectedLogIds.size>0`, inclure `targetIds: Array.from(selectedLogIds)` (actuellement seulement logs/range) et un libellé historique « cibles : N IDs » sinon la plage.
- [ ] **Step 2** — `components/sent-frames-history.tsx` : props optionnelles `onReplayFrame?(f)` et `onMarkCrash?(f)` ; par ligne, si fournis, boutons « Rejouer » et « Marquer comme crash ». Dans `app/fuzzing/page.tsx` : `onReplayFrame` → `addFrames([{canId:f.canId,data:f.data,timestamp:"0",source:"fuzz"}])` + `router.push("/replay-rapide")` ; `onMarkCrash` → `router.push("/crash-recovery?crashFrame="+encodeURIComponent(f.canId)+"&crashData="+encodeURIComponent(f.data))`.
- [ ] **Step 3** — Export CSV/JSON de l'historique (id,canId,data,interface,status,timestamp) via Blob download (mirror analyse-can `_csvCell`). Bouton dans l'en-tête de `SentFramesHistory` (via une prop `onExport?` ou directement dans le composant si `frames.length>0`).
- [ ] **Step 4** — `npm run build` + `npx tsc` (pas de nouvelle erreur). Responsive `flex flex-wrap`. Commit `feat(fuzzing): ciblage IDs selectionnes, rejeu/marquage historique, export CSV`.

---

## Self-Review

- Spec coverage : AUD-06=T1 ; biblio=T2(backend)+T4(UI) ; fuzzing ciblé/rejeu/export=T5 ; client=T3. Confirmation UI crash=T4. ✅
- is_id_blocked jamais sur OBD (T1) ; jamais sur rejeu biblio (T2 test `test_replay_not_blocked`). ✅
- Types : `KnownFrame`/blocklist produits T3, consommés T4/T5. `targetIds` déjà supporté backend (map). ✅
- Placeholders : `inject_start` factorisation pour la boucle — l'implémenteur T2 réutilise ou factorise, noté. Suspense crash-recovery si besoin (T4), noté. ⚠️ seuls points ouverts, volontaires.
