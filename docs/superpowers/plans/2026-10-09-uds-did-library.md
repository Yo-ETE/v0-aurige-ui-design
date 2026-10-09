# Bibliothèque DID UDS — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Mémoriser des DID UDS (0x22) par marque/ECU, réutilisables dans le panneau UDS. Seed = DID standard ISO F1xx (publics).

**Architecture:** JSON `${DATA_DIR}/uds_dids.json` + helpers `main._load_dids`/`_save_dids` (pattern aud06). CRUD dans `routers/uds.py`. Picker + édition dans `app/uds/page.tsx`.

**Spec:** `docs/superpowers/specs/2026-10-09-uds-did-library-design.md`

## Global Constraints

- FR UI / EN code. Métadonnées seules (aucune injection) → permission **`dbc_manage`** sur mutations. **first-match** des règles permissions → `uds/dids` AVANT `^/api/uds/`. Pas de base OEM propriétaire. 4 routes ajoutées → inventory 156→160 + integration_boot. Router Option-2 (`import main`, `main.<x>`). Suite backend verte, `tsc` 0.

---

### Task 1: Backend — stockage + CRUD DID

**Files:** Modify `backend/main.py` (helpers + seed), `backend/routers/uds.py` (4 routes), `backend/permissions.py` (règles), `backend/tests/test_route_inventory.py` (regen 160), `backend/tests/test_integration_boot.py` (si besoin) ; Create `backend/tests/test_uds_dids.py`.

- [ ] `main.py` : `DIDS_PATH = DATA_DIR / "uds_dids.json"`. `_DEFAULT_DIDS` = liste des 8 DID standard (F190 VIN, F18C, F187, F189, F191, F195, F197, F18A ; `ecu_request_id:"7E0"`, `ecu_response_id:"7E8"`, `brand:""`), chacun avec un `id` stable (ex `"std-f190"`). `_load_dids()` : si fichier absent → écrit `_DEFAULT_DIDS` puis les retourne ; sinon lit `{"dids":[...]}` (retourne `[]` si corrompu, loggue). `_save_dids(dids)` : `json.dump({"dids":dids}, ...)`.
- [ ] `routers/uds.py` : modèles `UDSDidCreate {did:str, name:str, brand:str="", ecu_request_id:str="7E0", ecu_response_id:str="7E8", note:str=""}`, `UDSDidPatch` (tous optionnels). Regex `^[0-9A-Fa-f]{2,8}$` ET longueur paire pour `did` ; `^[0-9A-Fa-f]{1,8}$` pour ecu ids.
  - `GET /api/uds/dids` → `{"dids": main._load_dids()}`.
  - `POST /api/uds/dids` : valide (400) ; `obj={id:uuid4 hex, did:did.upper(), name, brand, ecu_request_id.upper(), ecu_response_id.upper(), note}` ; `dids=_load_dids(); dids.append(obj); _save_dids(dids)` → `{status:"ok", did:obj}`.
  - `PATCH /api/uds/dids/{did_id}` : charge, trouve par id (404), applique champs fournis (re-valide hex), save → `{status:"ok", did}`.
  - `DELETE /api/uds/dids/{did_id}` : charge, filtre (404 si rien retiré), save → `{status:"ok"}`.
  - `import uuid` en tête.
- [ ] `permissions.py` : AJOUTER **avant** la règle `("POST", r"^/api/uds/", ["can_inject"])` :
  `("POST", r"^/api/uds/dids", ["dbc_manage"])`, `("PATCH", r"^/api/uds/dids/", ["dbc_manage"])`, `("DELETE", r"^/api/uds/dids/", ["dbc_manage"])`.
- [ ] `test_integration_boot.py` : POST/PATCH/DELETE `/api/uds/dids` gardés `dbc_manage` (satisfait) ; GET non mutant (rien à faire).
- [ ] `test_route_inventory.py` : régénérer EXPECTED (156→160 : GET/POST `/api/uds/dids`, PATCH/DELETE `/api/uds/dids/{did_id}`).
- [ ] `test_uds_dids.py` (login admin, tmp DATA_DIR) : 1er GET contient le seed (F190 présent) ; POST `{did:"2201",name:"x"}` → 400 ? non, 2201 valide (2 octets) OK → crée, GET le contient (did majuscule) ; `did:"ZZ"` → 400 ; `did:"F1"` (1 octet) OK ; `did:"F190A"` (impair) → 400 ; PATCH name → modifié ; DELETE → retiré, re-DELETE 404.
- [ ] `cd backend && python -m pytest -q` vert (inventory 160, boot) + `npx tsc --noEmit` 0. Commit `feat(uds): bibliotheque de DID (stockage JSON + CRUD + seed ISO F1xx)`.

---

### Task 2: Frontend — picker + édition DID

**Files:** Modify `lib/api.ts`, `app/uds/page.tsx`.

- [ ] `lib/api.ts` : `export interface UDSDid { id:string; did:string; name:string; brand:string; ecu_request_id:string; ecu_response_id:string; note:string }` ; `udsDidsList():Promise<{dids:UDSDid[]}>` (GET `/uds/dids`) ; `udsDidCreate(p:Omit<UDSDid,"id">):Promise<{status:string;did:UDSDid}>` (POST) ; `udsDidUpdate(id:string, p:Partial<Omit<UDSDid,"id">>)` (PATCH `/uds/dids/{id}`) ; `udsDidDelete(id:string)` (DELETE `/uds/dids/{id}`). Match `fetchApi`.
- [ ] `app/uds/page.tsx` : carte **« Bibliothèque DID »** : charge `udsDidsList` au mount. Liste filtrable (Input texte + filtre `brand`). Chaque ligne : `DID` (mono) · name · brand · `req→resp` + boutons **« Utiliser »** (set `service="22"`, `data=did`, `requestId=ecu_request_id`, `responseId=ecu_response_id`), **Éditer**, **Supprimer** (confirm). Bouton **« + Ajouter »** → formulaire (did, name, brand, ecu req `7E0`, ecu resp `7E8`, note) → `udsDidCreate` → refresh liste. Erreurs en Alert. Note ISO F1xx + ajout brand-specific. Responsive, hydration-safe.
- [ ] `npm run build` vert + `tsc` 0. Commit `feat(uds): bibliotheque DID cote UI (picker + ajout/edition)`.

---

## Self-Review

- Seed standard public uniquement (pas d'OEM propriétaire). ✅
- Permission : `dbc_manage` (métadonnées), placé AVANT `^/api/uds/` (first-match). ✅
- 4 routes → inventory 156→160 + boot. ✅
- T1→T2 (type + endpoints). ✅
