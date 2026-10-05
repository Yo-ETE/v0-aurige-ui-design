# Scan UDS — Découverte d'adresses ECU

## Problème

L'UDS fonctionne (validé : `7E0 10 03 → 50 03003201F4` sur prise OBD). Mais pour
actionner un ECU précis (ex essuie-glace = ECU body), il faut connaître son **adresse
UDS** (request/response IDs), propres au constructeur. `7E0/7E8` = powertrain OBD. Sur un
tap body, l'adresse est inconnue.

## But

Balayer une plage de request IDs, envoyer **TesterPresent `3E 00`** (inoffensif, aucune
actuation), et **détecter quels ECU répondent** + leur response ID réel. L'utilisateur
récupère l'adresse à utiliser dans le panneau UDS.

## Détection (clé)

Sur un bus réel, candump capture beaucoup de trafic périodique. On distingue une réponse
UDS par **motif** (hex, majuscules, sans séparateur) :
- **positive** TesterPresent : data commence par `027E00` (PCI 02, `7E`=0x3E+0x40, sub 00).
- **negative** : data commence par `037F3E` (PCI 03, `7F`, service `3E`, puis NRC).
Ces motifs n'apparaissent pas dans le trafic body périodique → faux positifs ~nuls. Les
deux motifs = un ECU **existe** à cette adresse (négative = présent mais refuse).

Le **response ID réel** = l'ID de la trame qui porte le motif (on ne suppose PAS req+8 ;
les ECU body peuvent différer).

## Backend

`POST /api/uds/scan` (router `uds.py`), permission **`can_inject`**.
Modèle `UDSScanRequest {interface, start_id, end_id, service="3E", data="00", gap_ms=40, listen_ms=90}`.

- Valide : interface ∈ {can0,can1,vcan0} ; `start_id`/`end_id` hex 1..8 ; plage `end >= start`
  et **taille ≤ 512** IDs (400 sinon) ; `gap_ms`/`listen_ms` bornés (ex 10..500).
- **`is_id_blocked`** appliqué par request ID (balayage = injection, cohérent fuzzing/generator) :
  IDs bloqués **sautés**, comptés dans `blocked_skipped`.
- Un **seul candump** tourne pour tout le scan (`-L -ta`), écrit un log ; lecture **incrémentale**
  (marque le nb de lignes avant envoi). Pour chaque request_id non bloqué :
  `can_send_frame(interface, req_id, build_single_frame(service, data))` ; `sleep listen_ms` ;
  lire les nouvelles lignes ; `parse_candump_line` ; si une data matche `^027E00` ou `^037F3E`,
  enregistrer `{request_id, response_id=<ID de la trame>, kind: "positive"|"negative", data}`
  (1re correspondance par request_id). `sleep gap_ms` entre IDs.
- Dédoublonne par `(request_id,response_id)`. Nettoie le candump en fin (terminate + wait).
- Retour `{status:"ok", interface, scanned, responders:[...], blocked_skipped, elapsed_ms}`.
- Réutilise les helpers `main.can_send_frame`, `main.parse_candump_line`, `main.is_id_blocked`,
  `main.uds_client.build_single_frame` (via `routers/uds.py` qui a déjà `import main, uds_client`).
- Route ajoutée → inventaire **155→156** ; `test_integration_boot` (mutante gardée `can_inject`).

## Frontend

`lib/api.ts` : `udsScan(p) -> {status, responders:{request_id,response_id,kind,data}[], scanned, blocked_skipped, elapsed_ms}`.

`app/uds/page.tsx` : carte **« Scan UDS (découverte d'adresses) »** :
- Champs : interface (réutilise), Start ID (`700`), End ID (`7FF`). Bouton **« Scanner »**.
- **Confirmation** (AlertDialog) avant scan : « Balaye {start}–{end} en TesterPresent sur un bus réel. Continuer ? ».
- Pendant : loading + « Scan en cours… ». Résultat : tableau `request → response · badge positive/negative · data`.
  Compteurs « {scanned} IDs testés, {blocked_skipped} bloqués ». Vide → « Aucun ECU détecté sur cette plage ».
- Par ligne : bouton **« Utiliser »** → remplit `requestId`/`responseId` du formulaire UDS principal.
- Note : « TesterPresent (3E 00) n'actionne rien ; sert à repérer les ECU présents. »

## Tests

Backend : `/api/uds/scan` avec `main.can_send_frame` + capture mockés (candump) : une réponse
`027E00` sur un ID → `responders` contient ce response_id kind positive ; `037F3E` → negative ;
plage > 512 → 400 ; `is_id_blocked` → ID sauté (blocked_skipped++, pas d'envoi) ; inventaire 156.
Frontend : `tsc` 0, build vert.

## Sécurité / hors scope

TesterPresent n'actionne pas, mais le balayage = TX multi-ID → `is_id_blocked` + `can_inject`
comme les autres chemins de balayage. Pas de SecurityAccess/actuation dans le scan. Mapping fin
par timestamp = hors scope (fenêtre listen_ms par ID suffit).
