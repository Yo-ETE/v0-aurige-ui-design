# AURIGE — AUD-06 garde IDs critiques + bibliothèque de trames crash/réinit + fuzzing ciblé

> Design 2026-10-02. (1) Implémenter le garde commun `is_id_blocked()` (AUD-06) qui
> bloque le fuzzing/sweep aveugle sur des IDs critiques mais laisse passer les actions
> explicites. (2) Bibliothèque globale de « trames remarquables » (crash + réinit)
> rejouables. (3) Fuzzing ciblé + rejeu d'historique + export. Branche `audit-remediation`.
> Commentaires/UI français, code anglais.

## 1. But (mots de l'utilisateur)

Trouver les trames « crash » (ex. déclenchement airbag, coupure moteur) ET leur trame de
réinitialisation, et pouvoir les rejouer. Exemple Peugeot : `4C8#0003000000000000` = trame
crash, `4C8#0000000000000000` = trame réinit. Sécuriser le fuzzing (ne pas balayer aveuglément
les IDs critiques) sans empêcher le rejeu volontaire d'une trame nommée.

## 2. Décisions (validées)

- Bibliothèque crash/réinit : **globale**, `DATA_DIR/known_frames.json` (réutilisable entre missions).
- Politique AUD-06 : `is_id_blocked()` **bloque le fuzz/sweep aveugle** sur IDs critiques ;
  le **rejeu d'une trame nommée** de la bibliothèque + `can/send` manuel = **autorisés avec
  confirmation explicite** côté frontend.
- UI de la bibliothèque : **section dans la page Crash Recovery** (`app/crash-recovery/page.tsx`).

## 3. État (map backend, main.py)

- Sink commun d'envoi : `can_send_frame(interface, can_id, data)` (617), valide ID `^[0-9A-F]{1,8}$`.
- Chemins d'injection : `/api/can/send`(1233), `/api/generator/start`(1661, cangen, `can_id` optionnel→random),
  `/api/fuzzing/start`(1714, écrit `/tmp/aurige_fuzz.py`, boucles cansend ; accepte `target_ids` OU range),
  `/api/replay/start`(1398), `/api/inject/start`(1565, chokepoint `_injectable_or_block`(1547) `return None`),
  `/api/analysis/validate-causality`(8843, injecte `source_id`), `/api/fuzzing/crash-recovery`(2075,
  envoie `{id}#0000000000000000` = **reset**, défaut IDs `["4C8","5E8","3B7","360","1A0","0F6"]`).
- `OBD_FILTER_IDS`(7487) = `{7DF,7E0..7EF}` — **à ne JAMAIS bloquer**.
- `DATA_DIR = Path(getenv("AURIGE_DATA_DIR","/opt/aurige/data"))` (51). Pas de config globale existante.
- `FuzzingRequest`(225) a déjà `target_ids`/`targetIds`. Frontend n'envoie `targetIds` qu'en mode logs/range.
- `SentFramesHistory` (`components/sent-frames-history.tsx`) : `SentFrame {id,timestamp,canId,data,interface,status,description?}`,
  hook `useSentFramesHistory` (state local, non persistant). `export-store` `addFrames([{canId,data,timestamp?,source}])` + `/replay-rapide`.
- Permissions (`permissions.py`) : `_ROUTE_RULES` `(method, regex, [flags])`. `^/api/inject/`→`can_inject`,
  `^/api/generator/`→`can_inject`, `^/api/fuzzing/(start|run|stop|force-cleanup)`→`fuzzing_run`,
  `^/api/fuzzing/crash-recovery`→`crash_recovery_run`, `^/api/analysis/validate-causality`→`causality_validate`.

## 4. AUD-06 — `is_id_blocked`

- **Normalisation** : `_norm_id(s)` = strip, upper, retire `0X`. Compare sur cette forme.
- **Liste critique** : persistée `DATA_DIR/aud06_blocklist.json` = `{"ids": ["4C8", ...]}`.
  Chargée à la demande (pas de cache agressif ; relire le fichier). Défaut au premier accès :
  liste **vide** (les IDs critiques dépendent de la voiture ; l'utilisateur les saisit).
- `def is_id_blocked(can_id: str) -> bool` : `norm = _norm_id(can_id)` ; si `norm in OBD_FILTER_IDS` → **False**
  (jamais bloqué) ; sinon `norm in <blocklist>`.
- **Endpoints config** : `GET /api/aud06/blocklist` → `{ids:[...]}` ; `PUT /api/aud06/blocklist` body `{ids:[...]}`
  (valide chaque id `^[0-9A-Fa-f]{1,8}$`, normalise upper, **refuse** d'ajouter un OBD id → 400).
  Permission : nouveau flag `safety_config` (admin + operator) — mutation sur `^/api/aud06/`.
- **Application (BLOQUE, sweep aveugle) :**
  - `start_fuzzing` : avant d'écrire le script, calculer la liste effective d'IDs (target_ids, sinon la plage
    start..end) ; **retirer** tout ID bloqué ; si la plage/los cibles ne contiennent QUE des IDs bloqués → 403.
    Passer au script la liste filtrée (le script ne balaie jamais un ID bloqué). Journaliser le nb d'IDs retirés
    dans la réponse (`blocked_skipped: int`).
  - `start_generator` : si `can_id` fourni et bloqué → 403 ; si `can_id` None (random plein espace) **et** blocklist
    non vide → 403 avec message « cangen ne peut pas exclure d'ID ; précisez un can_id ou videz la liste critique ».
  - `validate_causality_endpoint` : si `source_id` bloqué → 403.
- **N'APPLIQUE PAS (actions explicites, autorisées) :** `can_send_frame`/`/api/can/send` (manuel), `/api/inject/*`
  (trame nommée / keep-alive), le rejeu de la bibliothèque, `/api/fuzzing/crash-recovery` (envoi de **reset**),
  `/api/replay/start` (log de l'utilisateur). Le frontend met une **confirmation** sur les actions manuelles/nommées
  touchant un ID présent dans la liste critique (voir §6).

## 5. Bibliothèque de trames remarquables (crash/réinit)

- Stockage : `backend/known_frames.py` (helpers) + `DATA_DIR/known_frames.json` =
  `{"frames": [ {id, can_id, crash_data, reset_data, label, severity, notes, created_at} ]}`.
  `id` = uuid4 hex. `can_id` `^[0-9A-Fa-f]{1,8}$`, `crash_data`/`reset_data` `^([0-9A-Fa-f]{2}){0,8}$`
  (reset_data optionnel). `severity` ∈ {info, warning, danger}. Sauvegarde atomique (tmp + os.replace).
- Endpoints :
  - `GET /api/known-frames` → `{frames:[...]}`.
  - `POST /api/known-frames` body `{can_id, crash_data, reset_data?, label, severity?, notes?}` → crée (valide hex).
  - `PATCH /api/known-frames/{fid}` (mêmes champs, partiels) ; `DELETE /api/known-frames/{fid}`.
  - `POST /api/known-frames/{fid}/replay` body `{interface, kind:"crash"|"reset", loop?:bool, intervalMs?}` :
    envoie la data correspondante sur `can_id`. `loop=false` → `can_send_frame` (one-shot).
    `loop=true` → démarre le sous-système **inject** (mode frame) avec `can_id`+data (réutilise `inject_start` /
    `state.inject_process`). **Action explicite → PAS de is_id_blocked** (c'est le but), mais le frontend confirme.
    Si `kind="reset"` et pas de `reset_data` → 400.
  - Permissions : mutations `^/api/known-frames` (POST/PATCH/DELETE/replay) → `can_inject`.
- Peuplement : manuel (formulaire) ; « Marquer comme trame crash » depuis l'historique fuzzing
  (préremplit can_id+crash_data, reset_data défaut `"00"*dlc`).

## 6. Frontend

- `lib/api.ts` : types `KnownFrame`, `AUD06Blocklist` ; fonctions `getBlocklist`, `setBlocklist(ids)`,
  `listKnownFrames`, `createKnownFrame(payload)`, `updateKnownFrame(fid,payload)`, `deleteKnownFrame(fid)`,
  `replayKnownFrame(fid, {interface,kind,loop,intervalMs})`.
- **Crash Recovery (`app/crash-recovery/page.tsx`)** — 2 cartes ajoutées :
  - « Trames remarquables (crash / réinit) » : tableau (label, can_id, crash_data, reset_data, gravité) +
    formulaire d'ajout ; par ligne : **Rejouer crash** (one-shot) · **Rejouer crash en boucle** · **Rejouer réinit** ·
    Supprimer. `<InjectStatusBar/>` pour arrêter une boucle. Les boutons de rejeu crash ouvrent une **confirmation**
    (AlertDialog) « Injection volontaire sur ID potentiellement critique — confirmer » ; bouton réinit sans confirm.
  - « IDs critiques (AUD-06) » : éditeur de la blocklist (liste d'IDs + ajout/suppression, `getBlocklist`/`setBlocklist`),
    note « le fuzzing et la génération ne balaient jamais ces IDs ; OBD (7DF/7E0-7EF) jamais bloqué ».
- **Fuzzing (`app/fuzzing/page.tsx`)** :
  - Modes random/static : si `selectedLogIds.size>0`, envoyer `targetIds` (actuellement seulement logs/range) +
    un libellé « cibles : N IDs » ; sinon la plage. (Fuzzing ciblé.)
  - `SentFramesHistory` : nouveau `onReplayFrame(frame)` → « Rejouer » une trame envoyée via `export-store.addFrames`
    + `router.push("/replay-rapide")` (réutilise le mécanisme). Ajouter aussi « Marquer comme trame crash » →
    pré-remplit le formulaire de la bibliothèque (via navigation vers crash-recovery avec les valeurs en query, ou
    un petit store ; choisir le plus simple et le noter).
  - **Export historique CSV/JSON** des trames envoyées (id, data, interface, status, timestamp).
- Responsive : nouvelles barres `flex flex-wrap items-center gap-2` ; tableaux `overflow-x-auto`.

## 7. Sécurité / périmètre

- `is_id_blocked` **exempte toujours** `OBD_FILTER_IDS`. La liste critique défaut est vide (IDs dépendent du véhicule).
- Le rejeu d'une trame crash nommée est **volontaire** → autorisé, mais confirmé côté UI. La réinit n'est jamais bloquée.
- Pas de `shell=True` ; le rejeu boucle réutilise le sous-système inject existant (déjà durci, `shlex.quote`).
- `can/send` manuel reste autorisé (confirmation UI si l'ID est dans la liste critique).

## 8. Tests

- Backend (pytest + TestClient) :
  - `is_id_blocked` : OBD jamais bloqué même si présent ; id de la liste bloqué ; normalisation `0x4c8`/`4C8`.
  - blocklist : PUT refuse un OBD id (400) ; GET/PUT round-trip ; persistance.
  - fuzzing : avec blocklist={4C8}, un `target_ids=["4C8","360"]` ne garde que 360 (`blocked_skipped=1`) ;
    `target_ids=["4C8"]` seul → 403. (Mock l'exécution du process.)
  - generator : `can_id=4C8` bloqué → 403 ; `can_id=None` + blocklist non vide → 403.
  - causality : `source_id=4C8` bloqué → 403.
  - known-frames : CRUD ; replay one-shot (mock `can_send_frame`) ; replay loop (mock inject) ; reset sans reset_data → 400 ;
    validation hex ; replay **n'appelle pas** is_id_blocked (autorisé même si 4C8 bloqué).
- Frontend : `npm run build` + `npx tsc --noEmit` (pas de nouvelle erreur au-delà du baseline).
- Vérif réelle (utilisateur, voiture) : enregistrer `4C8#0003...`/`4C8#0000...`, rejouer crash puis réinit.

## 9. Inventaire

Backend : `backend/main.py` (is_id_blocked + blocklist endpoints + enforcement fuzzing/generator/causality + known-frames endpoints),
`backend/known_frames.py` (helpers store), `backend/permissions.py` (`^/api/aud06/`→`safety_config`, `^/api/known-frames`→`can_inject`),
`backend/tests/test_aud06.py`, `backend/tests/test_known_frames.py`.
Frontend : `lib/api.ts`, `app/crash-recovery/page.tsx`, `app/fuzzing/page.tsx`, `components/sent-frames-history.tsx`.
