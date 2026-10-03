# Multi-bus + Gateway + Bus-ID + Résumé IA — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Capture CAN multi-bus simultanée, corrélation inter-bus (routage gateway), identification de bus, et bouton résumé-pour-IA.

**Architecture:** Capture par interface (`state.captures: dict`). 2 nouveaux endpoints d'analyse read-only (inter-bus-correlation offline, can/identify court candump). Frontend : capture-replay multi-bus + vue Gateway + util export/clipboard partagé.

**Tech Stack:** FastAPI, pytest ; Next.js/React.

**Spec:** `docs/superpowers/specs/2026-10-03-multibus-gateway-design.md`

## Global Constraints

- FR UI / EN code. Pas d'injection ajoutée (capture + identify = lecture seule candump ; inter-bus = offline).
- Routers : motif Option-2 inchangé (endpoints appellent `main.<helper>` ; voir [[aurige-router-split]] règles). Includes avant le rebind CORS.
- Filets : `test_route_inventory` (EXPECTED à régénérer quand on AJOUTE une route) + `test_integration_boot` (routes mutantes gardées) restent verts. Suite backend verte à chaque task. Frontend : `npm run build` vert + `npx tsc --noEmit` **0**.
- Logs candump `-L` `(epoch.us) canX ID#DATA` — base de temps Pi partagée (align inter-bus par ts absolu).
- Séquentiel (tasks backend touchent main.py/routers). BASE réenregistrée avant chaque task.

---

### Task 1: Capture multi-bus (backend + client + LogEntry interface/bitrate)

**Files:** `backend/main.py` (ProcessState), `backend/routers/capture.py`, `backend/routers/missions_core.py` (list logs), `lib/api.ts` ; `backend/tests/test_capture_multibus.py` ; maj `backend/tests/test_route_inventory.py` si besoin (paths inchangés → normalement non).

- [ ] `ProcessState` : remplacer `capture_process`/`capture_file`/`capture_start_time` par `captures: dict[str, dict]` (clé = interface ; valeur `{process, file, start_time, fh}`). Adapter `lifespan` pour terminer toutes les captures. (Grep les usages des 3 anciens champs — seuls capture.py les lit.)
- [ ] `capture.py` `start_capture` : valider `interface ∈ {can0,can1,vcan0}` (400) ; 409 seulement si `interface in main.state.captures` et vivante ; ouvrir le fichier, GARDER le fd dans le slot (le fermer au stop) ; écrire meta `{description, interface, bitrate, startTime}` (bitrate via `main.get_can_interface_status(interface).bitrate`) ; stocker le slot. Réponse inchangée + `interface`.
- [ ] `capture.py` `stop_capture` : accepter `interface` (query `?interface=` ou body) ; si absent et 1 seule capture → celle-là ; si absent et ≥2 → 400 « préciser l'interface » ; sinon stop ce slot (terminate→wait→kill, fermer le fd), réécrire meta (durationSeconds/endTime), `update_mission_stats`, retirer du dict. Réponse inchangée.
- [ ] `capture.py` `get_capture_status` : renvoyer `{captures: [{interface, running, filename, durationSeconds, framesCount}]}` (une entrée par capture vivante).
- [ ] `missions_core.py` liste des logs : lire aussi `interface`/`bitrate` de la meta → ajouter à `LogEntry`. `main.py` `LogEntry` + `lib/api.ts` `LogEntry` : `interface?: string; bitrate?: number`.
- [ ] `lib/api.ts` : `CaptureStatus` → `{ captures: CaptureSlotStatus[] }` avec `CaptureSlotStatus {interface, running, filename?, durationSeconds, framesCount?}` ; `getCaptureStatus()` retourne ça ; `stopCapture(interface?: CANInterface)` envoie l'interface.
- [ ] Tests (`test_capture_multibus.py`, mock `main.run_command_async`/subprocess) : start can0 + can1 → 2 slots, pas de 409 croisé ; 2e start can0 → 409 ; status = 2 entrées ; stop can0 laisse can1 ; stop sans interface + 2 actives → 400 ; meta contient interface+bitrate.
- [ ] `cd backend && python -m pytest -q` vert (dont route_inventory 149, integration_boot). Commit `feat(capture): multi-bus simultane (etat par interface) + interface/bitrate dans LogEntry`.

---

### Task 2: Corrélation inter-bus (routage gateway) — backend

**Files:** `backend/routers/analysis.py`, `lib/api.ts` ; `backend/tests/test_interbus.py` ; maj `test_route_inventory` (+1) + `test_integration_boot`.

**Interfaces:** `POST /api/analysis/inter-bus-correlation`.

- [ ] Endpoint : body `{mission_id, log_a_id, log_b_id, window_ms: float = 20}`. Résoudre les 2 logs (`main._resolve_log_path` / même logique que compare_logs, même mission, ids sanitizés). Parser chaque log en `[(ts, can_id, payload)]` triés (réutiliser le parse inline de inter-id-dependencies ; **ne PAS** filtrer OBD ici). Algorithme : pour chaque frame A à `tA`, chercher frames B dans `[tA, tA+window]` ; agréger par paire `(idA, idB)` : `co`, somme des délais (→ `avg_delay_ms`), payloads identiques vs différents (→ `relay` si majoritairement identiques, sinon `translated`). `p_forward = co / count_A(idA)`. Classer par `p_forward*co` desc, top 50. Lister aussi les `idA` sans aucune paire B (`blocked_ids`). Réponse `{pairs:[{id_a,id_b,co,avg_delay_ms,p_forward,kind:"relay"|"translated"}], blocked_ids:[...], total_a, total_b, elapsed_ms}`.
- [ ] Pas de permission mutante (lecture). `lib/api.ts` : types `InterBusPair`/`InterBusResult` + `interBusCorrelation(missionId, logAId, logBId, windowMs?)`.
- [ ] Régénérer `test_route_inventory` EXPECTED (149→150). `test_integration_boot` : route non mutante (POST analysis lecture — vérifier qu'elle n'exige pas de garde ou allowlistée comme les autres `/analysis` lectures ; suivre le motif de `inter-id-dependencies`).
- [ ] Tests (`test_interbus.py`) : 2 logs synthétiques (A id 0x200 @ t ; B id 0x7E8 @ t+0.005) → paire (0x200→0x7E8) p_forward=1, kind relay si payload identique ; un id A sans écho → dans `blocked_ids`.
- [ ] Suite verte. Commit `feat(analysis): correlation inter-bus (routage gateway) offline`.

---

### Task 3: Identification de bus — backend

**Files:** `backend/routers/can.py`, `backend/permissions.py`, `lib/api.ts` ; `backend/tests/test_identify.py` ; maj `test_route_inventory` (+1) + `test_integration_boot`.

**Interfaces:** `POST /api/can/identify`.

- [ ] Endpoint : body `{interface, durationSec: float = 2}` (clamp 0.5..10). Valider `interface ∈ {can0,can1,vcan0}` (400). Exiger l'iface UP via `main.get_can_interface_status` (sinon 400 « initialisez l'interface d'abord »). Lancer `candump -ta {interface}` ~durationSec (lecture seule, AUCUN TX), compter `frameCount`, `uniqueIds`, calculer `loadHz = frameCount/durationSec`, profil par plage d'ID (`0x000-0x0FF`, `0x100-0x3FF`, `0x400-0x7FF`, `extended` 8 digits) = nb de frames par plage, et une `estimate` heuristique (loadHz haut + IDs bas dominants → "powertrain" ; charge moyenne + IDs variés → "body/confort" ; faible → "diag/infotainment" ; vide → "aucun trafic — vérifier câblage/120Ω/bitrate"). Réutiliser le pattern candump de `scan_bitrate` mais SANS toucher au bitrate/au lien.
- [ ] `permissions.py` : `("POST", r"^/api/can/identify", ["capture_run"])` (lecture bus). `lib/api.ts` : types `BusIdentifyResult` + `identifyBus(interface, durationSec?)`.
- [ ] Régénérer `test_route_inventory` EXPECTED (→151). `test_integration_boot` : `identify` mutante-gardée par `capture_run` (ajouter si besoin à l'allowlist/rules — elle POST mais lit seulement ; la garder sous `capture_run` est cohérent).
- [ ] Tests (`test_identify.py`, mock candump) : court échantillon → frameCount/loadHz/uniqueIds/profil/estimate cohérents ; iface down → 400 ; durationSec clampé.
- [ ] Suite verte. Commit `feat(can): identification de bus (charge/IDs/profil, lecture seule)`.

---

### Task 4: Frontend capture-replay multi-bus

**Files:** `app/capture-replay/page.tsx`.

**Interfaces:** consomme `getCaptureStatus()` (liste), `stopCapture(interface)`, `startCapture(iface,...)`, `LogEntry.interface/bitrate`.

- [ ] Passer d'un `captureStatus` unique à la **liste** `captures[]`. Permettre de lancer une capture sur une interface même si une autre tourne déjà (2 lignes « can0 » / « can1 » avec start/stop/compteur/durée chacune), piloté par la liste du status. `fetchStatuses` lit la liste.
- [ ] Le Stop par ligne appelle `stopCapture(iface)`. Le replay/keep-alive restent comme avant mais ne sont bloqués QUE par une capture sur LEUR interface (ou garder simple : inchangé). Afficher `interface` + `bitrate` par log dans la liste.
- [ ] `npm run build` vert + `tsc` 0. Commit `feat(capture-replay): UI capture multi-bus (par interface)`.

---

### Task 5: Frontend vue Gateway + bus-ID + résumé IA + util export

**Files:** `lib/export-utils.ts` (nouveau), `app/gateway/page.tsx` (nouveau) + entrée sidebar, `app/analyse-can/page.tsx` (bouton IA), `components/sidebar.tsx`.

- [ ] `lib/export-utils.ts` : `downloadFile(name, text, mime)`, `csvCell(v)`, `copyToClipboard(text): Promise<boolean>` (navigator.clipboard + fallback). (Ne PAS refactorer les copies existantes maintenant — juste fournir l'util + l'utiliser dans le neuf.)
- [ ] `app/gateway/page.tsx` : (a) **Corrélation inter-bus** — sélection log A (bus direct) + log B (OBD) de la mission (réutiliser `LogSelector`), bouton « Corréler » → `interBusCorrelation` → table des paires (id_a → id_b, délai, p_forward %, relay/traduit) + liste des IDs A « non relayés (bloqués gateway) ». (b) **Identifier un bus** — Select interface + durée + « Identifier » → `identifyBus` → charge Hz, nb IDs, profil par plage, estimation. Responsive (`flex flex-wrap`, `overflow-x-auto`). Ajouter l'entrée « Gateway » dans `components/sidebar.tsx` (section Analyse).
- [ ] `app/analyse-can/page.tsx` : bouton **« Copier résumé pour IA »** qui assemble un Markdown (mission, log, heatmap top-IDs + octets actifs, signaux auto-détectés, dépendances si présentes) + consigne IA, via `copyToClipboard`. Afficher un toast/confirmation « Résumé copié ».
- [ ] `npm run build` vert + `tsc` 0. Commit `feat(gateway): vue correlation inter-bus + identification de bus + resume IA`.

---

## Self-Review

- Couverture : A=T1(+T4 UI) ; B=T2(+T5 UI) ; C=T3(+T5 UI) ; D=T5. ✅
- Lecture seule : capture/identify = candump sans TX ; inter-bus = offline. Aucune injection. AUD-06 inchangé. ✅
- Filets : routes ajoutées (T2,T3) → régénérer EXPECTED + integration_boot ; capture (T1) garde ses chemins. ✅
- Formes d'API changées (CaptureStatus liste, stopCapture(interface)) — frontend T4 adapté ; aucun autre consommateur (grep). ⚠️ à confirmer en T1/T4.
- Dépendances : T1→T4 (forme status) ; T2/T3→T5. Backend T1-T3 séquentiel. ✅
