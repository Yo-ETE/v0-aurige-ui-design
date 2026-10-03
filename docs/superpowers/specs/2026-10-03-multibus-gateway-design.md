# AURIGE — Capture multi-bus + corrélation inter-bus (gateway) + identification de bus + résumé IA

> Design 2026-10-03. Suivre la réalité des véhicules à gateway : capturer 2 bus en parallèle
> (tap direct + OBD), révéler ce que le gateway relaie/traduit, identifier un bus inconnu, et
> démarrer l'analyse assistée IA par un résumé copiable. Branche `audit-remediation`. FR UI, EN code.

## 1. But (mots de l'utilisateur)

Les véhicules ont un gateway central ; l'OBD n'expose qu'une vue filtrée. On se branche sur les
fils du bus cible (derrière le gateway). AURIGE doit : capturer plusieurs bus simultanément, montrer
le routage gateway, aider à identifier un bus inconnu, et offrir une analyse IA rapide.

## 2. État (map backend)

- Capture MONO : `state.capture_process`/`capture_file`/`capture_start_time` (uniques), 409 global
  (`routers/capture.py:32`). `interface` écrit dans `{stem}.meta.json` mais JAMAIS exposé dans `LogEntry`.
  Handle de fichier jamais fermé (capture.py:52). Log = candump `-L` `(epoch.us) canX ID#DATA` (horloge
  Pi partagée → 2 captures simultanées alignables par timestamp absolu).
- `LogEntry` (main.py:188 / api.ts:61) : pas de champ `interface`/`bitrate`.
- Parsers inline existants : inter-id-dependencies (analysis.py:707-722 → `[(ts,can_id,payload)]`),
  co-occurrence (missions_core.py:731-752), compare_logs (missions_compare.py:40-59). `_parse_log_for_correlation`
  (main.py:1814) jette l'interface.
- `scan-bitrate` (can.py:106) : séquentiel, laisse l'iface **DOWN** à la fin, pas de garde concurrence.
- `get_can_interface_status` : `txPackets/rxPackets/errors/can_state/berr_*`. Pas de charge (Hz) dérivée,
  pas de classif par plage d'ID.
- Exports client dupliqués (analyse-can, signal-finder, obd-ii, sent-frames) — pas d'util partagé.

## 3. Objectif (4 axes)

### A. Capture multi-bus simultanée
- État par interface : `state.captures: dict[str, CaptureSlot]` (process, file, start_time) remplace les
  3 singletons. `lifespan` termine toutes les captures.
- `POST /api/capture/start {interface, missionId, filename?, description?}` : 409 **seulement si CETTE
  interface** capture déjà. Valide `interface ∈ {can0,can1,vcan0}` (400). Ferme le handle de fichier
  proprement (ouvrir via `with` ou garder le fd et le fermer au stop). `interface` + `bitrate` (lu via
  `get_can_interface_status`) écrits dans la meta.
- `POST /api/capture/stop {interface?}` (body ou query) : arrête CETTE interface ; si `interface` absent et
  une seule capture tourne, arrête celle-là ; sinon 400 (ambigu). Met à jour stats mission.
- `GET /api/capture/status` : **réponse = `{captures: [{interface, running, filename, durationSeconds, framesCount}]}`**
  (liste ; vide si aucune). (Changement de forme — frontend adapté.)
- `LogEntry` gagne `interface?: string` + `bitrate?: number` (lus depuis la meta). Surfacés dans la liste des logs.
- Chemins de route **inchangés** (inventaire 149 préservé) ; seules les formes de corps/réponse changent.

### B. Corrélation inter-bus (carte de routage gateway)
- `POST /api/analysis/inter-bus-correlation {mission_id, log_a_id, log_b_id, window_ms=20}` : aligne 2 logs
  (même base epoch). Pour chaque frame de A (bus direct), cherche les frames de B (OBD) dans `[ts, ts+window]` ;
  agrège par paire `(id_A, id_B)` : `count`, délai moyen, `p_forward = co/count_A(id_A)`, indices de payload
  identiques (relay direct) vs différents (traduit). Sort un top-N de paires « A relayé vers B » classées par
  p_forward×count. But : voir ce que le gateway forwarde/traduit/bloque (un id_A sans paire B = bloqué par le
  gateway). Réutilise les parsers existants (garder l'ordre temporel, ne PAS jeter l'OBD ici — désactiver le
  filtre OBD pour cette analyse). + client `interBusCorrelation()` + types.

### C. Identification de bus inconnu
- `POST /api/can/identify {interface, durationSec=2}` : court `candump -ta` (lecture seule, aucun TX) pendant
  `durationSec` ; calcule `frameCount`, `loadHz` (frames/s), `uniqueIds`, un profil par plage d'ID
  (ex 0x000-0x0FF, 0x100-0x3FF, 0x400-0x7FF, étendus 29 bits) et une **estimation** de type de bus (heuristique
  simple : forte charge + IDs bas → powertrain ; charge moyenne + IDs variés → body/confort ; faible → diag/infotainment).
  Nécessite l'interface UP (sinon 400 avec conseil « init d'abord »). Lecture seule, pas d'injection. + client + types.
- Note : `scan-bitrate` laissant l'iface DOWN est un défaut connu — hors périmètre ici (documenter), ne pas aggraver.

### D. Résumé IA (démarrage rapide, sans LLM embarqué)
- Util partagé `lib/export-utils.ts` : `downloadFile`, `csvCell`, `copyToClipboard`. Remplacer à terme les
  copies dupliquées (au moins NE PAS en rajouter).
- Bouton **« Copier résumé pour IA »** sur Analyse CAN (et éventuellement Comparaison/Signal Finder) : assemble
  un texte Markdown structuré depuis les résultats courants (mission, log, heatmap top-IDs + octets actifs,
  signaux auto-détectés, dépendances, candidats de corrélation, diff) + une consigne (« Voici des données CAN
  d'un véhicule, aide-moi à identifier les signaux / le rôle des IDs »). Copie au presse-papier → l'utilisateur
  colle dans Claude. Pas d'appel réseau, pas de clé. (Panneau Claude intégré = itération future, hors périmètre.)

## 4. Frontend

- Capture & Replay (`app/capture-replay/page.tsx`) : passer d'un statut unique à une **liste par interface**
  (`captures[]`) ; permettre de démarrer une capture sur can0 ET can1 (2 lignes start/stop/compteur) ; afficher
  l'interface + bitrate par log. `startCapture(iface,...)` inchangé ; `stopCapture(iface)` prend l'interface ;
  `getCaptureStatus()` renvoie la liste.
- Nouvelle vue **Gateway** (onglet dans Analyse CAN OU page dédiée `app/gateway/page.tsx`) : sélectionner log A
  (bus direct) + log B (OBD) → « Corréler » → table des paires relayées (id_A → id_B, délai, p_forward, relay/traduit)
  + liste des IDs de A « non relayés » (bloqués). + section « Identifier un bus » (interface + Identifier → charge/IDs/profil/estimation).
- Bouton « Copier résumé pour IA » (Analyse CAN) via `lib/export-utils.ts`.
- Responsive : `flex flex-wrap`, tables `overflow-x-auto`.

## 5. Sécurité / périmètre

- `identify` + capture = **lecture seule** (candump), aucun TX. `inter-bus-correlation` = offline (lit des logs).
- Capture multi-bus : garde `capture_run`. `identify` : nouvelle route `^/api/can/identify` → `capture_run`
  (lecture bus) ou pas de garde (lecture seule) — choisir `capture_run` (cohérent capture). Mettre à jour
  `test_integration_boot` si mutante.
- Aucune injection ajoutée. AUD-06 inchangé.

## 6. Tests

- Backend (pytest + TestClient, mock `run_command_async`/candump) :
  - capture multi-bus : start can0 + start can1 → 2 captures actives (pas de 409 croisé) ; 2e start can0 → 409 ;
    status liste 2 entrées ; stop can0 n'arrête pas can1 ; stop sans interface + 2 actives → 400.
  - inter-bus-correlation : 2 logs synthétiques (A: id 0x200 à t, B: id 0x7E8 à t+5ms) → paire (200→7E8)
    détectée, p_forward=1 ; un id de A sans écho B listé « non relayé ».
  - identify : mock un court candump → frameCount/loadHz/uniqueIds/profil/estimation cohérents ; iface down → 400.
  - LogEntry expose interface/bitrate depuis la meta.
  - `test_route_inventory` : +2 routes (`POST /api/analysis/inter-bus-correlation`, `POST /api/can/identify`) →
    régénérer EXPECTED (passera de 149 à 151). `test_integration_boot` : les nouvelles routes mutantes gardées.
- Frontend : `npm run build` vert + `npx tsc --noEmit` → **0** (pas de nouvelle erreur).
- Vérif réelle (utilisateur, voiture, semaine prochaine) : 2 HAT CAN, capture can0+can1 pendant une action,
  corrélation gateway.

## 7. Inventaire

Backend : `backend/main.py` (ProcessState.captures), `backend/routers/capture.py` (multi-bus),
`backend/routers/analysis.py` (inter-bus-correlation), `backend/routers/can.py` (identify),
`backend/routers/missions_core.py` (LogEntry interface/bitrate dans la liste), `backend/permissions.py`
(`^/api/can/identify`), `backend/tests/{test_capture_multibus,test_interbus,test_identify}.py` + maj
`test_route_inventory`/`test_integration_boot`.
Frontend : `lib/api.ts` (types + clients + CaptureStatus liste), `lib/export-utils.ts` (nouveau),
`app/capture-replay/page.tsx`, `app/gateway/page.tsx` (ou onglet Analyse CAN), `app/analyse-can/page.tsx` (bouton IA).
