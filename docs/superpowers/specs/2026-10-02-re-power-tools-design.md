# AURIGE — Outils de reverse : diff bit, commande candidate, rejeu en boucle, keep-alive ECU

> Design 2026-10-02. Rendre Comparaison (et le flux RE) capable d'identifier ET
> d'actionner une commande : quels **bits** changent, quelle **trame candidate**, la
> **rejouer en boucle**, et un **rejeu de fond (keep-alive)** pour garder l'ECU éveillé
> pendant l'injection. Branche `audit-remediation`. Commentaires/UI français, code anglais.

## 1. But (mots de l'utilisateur)

Identifier des trames intéressantes (essuie-glace, ventilation, arrêt moteur) : leur ID, les
bits changeants, et pouvoir les rejouer ; trouver la « trame de réveil de l'ECU » pour lancer
d'autres trames par-dessus.

## 2. État actuel

- `POST /api/missions/{id}/compare-logs` (`compare_logs`, main.py ~6396) calcule par ID :
  `bytes_changed`, `byte_change_detail` (`{index,val_a,val_b,hex_diff,decimal_diff}`, append ~6745),
  `classification` (differential/only_a/only_b/identical), `confidence`, `stability_score`,
  `dominant_ratio_a/b`, **`command_score`** + `rare_payloads`/`exclusive_rare_a/b`. L'UI Comparaison
  trie par commande/stabilité/confiance, filtre rare-exclusif, « Envoyer vers Replay » (one-shot).
- Replay : `state.canplayer_process` (process unique) pour le replay de log (`/api/replay/start`,
  construit un script `cansend` + boucle optionnelle ajoutée récemment). Replay Rapide = `cansend`
  par requête + burst/boucle côté client.
- ⚠️ `is_id_blocked()` (AUD-06) **n'existe pas** : aucune route d'injection ne bloque d'ID.

## 3. Objectif (4 axes, approuvés)

### A. Diff niveau bit (Comparaison)
- `byte_change_detail` gagne `changed_bits: list[int]` = positions de bits où `val_a ^ val_b` diffère
  (`[b for b in range(8) if (val_a ^ val_b) >> b & 1]`). Erreur hex → `changed_bits: []`.
- UI : afficher les bits changeants par octet (ex `#2: 00→04  bit2`), + badge « bit unique » quand
  exactement 1 bit change sur toute la trame (indice fort d'un flag de commande).

### B. Rejouer une commande en boucle
- Depuis une ligne Comparaison : bouton « Rejouer en boucle » qui envoie la trame candidate
  (`can_id` + `payload_b`) **en boucle** sur le bus, via le sous-système d'injection de fond (§D-tech).
- Stop visible et global (bandeau d'injection).

### C. Keep-alive / réveil ECU
- Rejeu **de fond** en boucle d'un log « idle » (baseline) pendant qu'on injecte d'autres trames
  par-dessus, pour garder le bus/ECU éveillé. Démarré depuis Capture & Replay (choisir un log).
- Tourne dans un **process séparé** (`state.inject_process`), indépendant du replay principal
  (`state.canplayer_process`) et des `cansend` de Replay Rapide → les trois peuvent coexister.

### D. Bandeau « commande candidate »
- En tête du résultat Comparaison : le top-1 par `command_score` mis en avant (ID, octets/bits
  changeants, `payload_b`), avec « Rejouer en boucle » direct.

## 4. Technique — sous-système « injection de fond » (sert B et C)

Un seul mécanisme, un seul process, un seul point de garde (prêt pour AUD-06) :

- État : `state.inject_process` (Optional process), `state.inject_desc` (str, libellé pour le statut).
- `POST /api/inject/start` body :
  - `{interface, mode:"frame", canId, data, intervalMs?}` → boucle `while true; do cansend iface canId#data; sleep interval; done` (intervalMs défaut 100, borné 10..5000).
  - `{interface, mode:"log", missionId, logId, intervalMs?}` → rejoue en boucle les trames du log
    (parse comme `/api/replay/start`, script `cansend` enveloppé dans `while true`, petite pause entre passages).
  - 409 si une injection de fond tourne déjà. Valide `canId` hex 1..8, `data` hex pairs ≤16, `intervalMs` borné.
- `POST /api/inject/stop` → terminate/kill le process, `state.inject_process=None`.
- `GET /api/inject/status` → `{running: bool, description: str}`.
- **Point de garde AUD-06 (chokepoint unique)** : `def _injectable_or_block(frames: list[str]) -> Optional[str]`
  — reçoit la liste des `ID#DATA` à injecter, retourne un message d'erreur si un ID est bloqué, sinon
  None. Pour CE chantier il retourne **toujours None** (pas de blocage), MAIS toutes les routes
  d'injection de fond passent par lui, de sorte qu'AUD-06 (`is_id_blocked`) s'ajoute à un seul endroit.
  Les `/api/inject/*` sont mutantes → permission `can_inject` dans `permissions.py` (motif `^/api/inject`).

## 5. Frontend

- `lib/api.ts` : `startInjectFrame(iface, canId, data, intervalMs?)`, `startInjectLog(iface, missionId, logId, intervalMs?)`, `stopInject()`, `getInjectStatus()` + type `InjectStatus {running, description}`.
- `components/inject-status.tsx` : petit bandeau qui poll `getInjectStatus` (~1 s) et montre
  « Injection de fond : <desc> [Stop] » quand actif ; rendu sur Comparaison et Capture & Replay.
- Comparaison (`app/comparaison/page.tsx`) :
  - détail : bits changeants par octet + badge « bit unique ».
  - bandeau « Commande candidate » (top-1 `command_score`) avec « Rejouer en boucle » (`startInjectFrame(iface, can_id, payload_b)`).
  - par ligne : bouton « Rejouer en boucle » à côté de « Envoyer vers Replay ».
- Capture & Replay (`app/capture-replay/page.tsx`) : par log, action « Rejeu de fond (keep-alive) »
  (`startInjectLog`) ; le bandeau d'injection pour Stop/statut.
- Responsive : nouvelles lignes `flex flex-wrap`.

## 6. Sécurité / périmètre

- ⚠️ **Injection continue sur le bus** (boucle commande + keep-alive) : dangereux sur véhicule réel.
  `is_id_blocked()` (AUD-06) **doit** couvrir `_injectable_or_block` avant tout usage voiture — c'est
  le chantier suivant ; ici on prépare le chokepoint unique mais on ne bloque pas encore.
- `can_inject` garde toutes les routes `/api/inject/*`. Validation stricte des trames (hex).
- Pas de `shell=True` ; scripts via `bash` + fichier, comme `/api/replay/start`.

## 7. Tests & vérification

- Backend (pytest + TestClient) :
  - `changed_bits` : `val_a^val_b` → bons indices (ex 00↔04 → `[2]` ; 00↔05 → `[0,2]`) ; append présent dans la réponse compare-logs (ou test unitaire sur la fonction si extraite).
  - inject : `start` mode frame refuse une data invalide (400) ; `start` puis `start` → 409 ; `status` reflète running ; `stop` repasse à not running. Mocker `run_command_async` pour ne pas lancer de vrai process ; vérifier le script/commande construits (data ≤16 hex, boucle présente). `_injectable_or_block([...])` retourne None pour l'instant (test de non-régression du chokepoint).
- Frontend : `npm run build` + `npx tsc --noEmit` (pas de nouvelle erreur au-delà du baseline).
- Vérif réelle (utilisateur, avec le bus) : rejeu en boucle d'une commande, keep-alive d'un log idle.

## 8. Inventaire

Backend : `backend/main.py` (changed_bits dans compare_logs ; sous-système inject + chokepoint),
`backend/permissions.py` (`^/api/inject` → can_inject), `backend/tests/test_inject.py` (+ test changed_bits).
Frontend : `lib/api.ts`, `components/inject-status.tsx`, `app/comparaison/page.tsx`, `app/capture-replay/page.tsx`.
