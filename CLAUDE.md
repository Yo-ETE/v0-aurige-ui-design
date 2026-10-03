# AURIGE — Contexte projet pour Claude Code

> Suite embarquée d'analyse et de reverse-engineering du **bus CAN automobile**,
> tournant sur **Raspberry Pi 5**. Projet propriétaire (dépôt privé, dépôt de
> brevet mentionné, licence restrictive). Auteur : Yo-ETE.

## Vue d'ensemble

AURIGE ("Mastery of CAN") couvre tout le cycle d'analyse CAN : capture de trames,
décodage DBC, détection automatique de signaux, fuzzing, diagnostic OBD-II, analyse
de dépendances inter-ECU, et corrélation OBD↔CAN. L'interface web est accessible
depuis tout navigateur (desktop et mobile).

## Stack technique

| Couche | Techno |
|--------|--------|
| Frontend | Next.js 16, React 19, Tailwind CSS v4, shadcn/ui, Zustand, Recharts |
| Backend | Python **FastAPI** + asyncio, s'appuie sur **can-utils** (candump, cansend, canplayer, cangen) via socketCAN |
| Temps réel | WebSocket (`/ws/candump`, `/ws/cansniffer`, `/ws/signal-finder`) |
| Données | Fichiers JSON (missions) + logs candump sur disque — **pas de base de données** |
| Déploiement | systemd (`aurige-web`, `aurige-api`) derrière nginx, sur Pi 5 ARM64 |

## Structure du dépôt

- `app/` — pages Next.js, une page = un module : `controle-can`, `capture-replay`,
  `isolation`, `comparaison`, `analyse-can`, `obd-ii`, `signal-finder`, `fuzzing`,
  `crash-recovery`, `generateur`, `dbc`, `missions/[id]`, `configuration`.
- `backend/main.py` — **noyau (~2 290 lignes) : helpers partagés, `state`, constantes, modèles
  Pydantic, `lifespan`, app + `include_router`.** Contrôleur système faisant autorité ; le frontend
  n'exécute jamais de commande shell. Les endpoints sont dans `backend/routers/<domaine>.py`
  (voir « Points d'attention » pour l'architecture router).
- `backend/dbc_parser.py` — parsing des fichiers DBC standard.
- `backend/error_logger.py` — logging applicatif et erreurs.
- `lib/` — client API TypeScript (`api.ts`, ~1 700 lignes), stores Zustand
  (`sniffer-store`, `mission-store`, `isolation-store`, `export-store`),
  config API (`api-config.ts`).
- `components/` — UI, dont `floating-terminal.tsx` (sniffer CAN flottant) et `sidebar.tsx`.
- `deploy/` — units systemd (`aurige-api.service`, `aurige-web.service`) + `nginx-aurige.conf`.
- `scripts/` — `install_pi.sh`, `update_pi.sh`, `uninstall_pi.sh`.

## Branches — état actuel

- **`obd-can-correlation-engine`** — branche la plus avancée : **101 commits d'avance sur
  `main`, 0 de retard** (dernier commit : 14 fév. 2026). Elle contient toutes les autres
  branches (`can-sniffer-dbc-integration`, `v0/yo-ete-5c91d9cb`…). Seule branche où existent
  le moteur de corrélation, `dbc_parser.py`, `error_logger.py`, `analyse-can`,
  `signal-finder` et `crash-recovery`.
- **`audit-remediation`** — branche de travail courante, créée depuis
  `obd-can-correlation-engine` pour appliquer le plan de `docs/AUDIT.md`. **Travailler ici.**
- **`main`** — ⚠️ en retard (6 fév. 2026, 84 routes, `main.py` de 4 938 lignes). Ne pas partir
  de `main`.

## Le moteur de corrélation OBD/CAN

Cœur nommé par la branche `obd-can-correlation-engine`, vit dans `backend/main.py`
(≈ lignes 6800–7420) :

- `OBD_PID_DECODERS` — formules de décodage d'une vingtaine de PID OBD (RPM, vitesse,
  température liquide, MAF, throttle, fuel level…).
- `_correlate_obd_with_can()` — pour chaque `(can_id, position de byte)`, aligne les
  valeurs CAN sur les timestamps OBD dans une fenêtre temporelle, teste des modèles
  1-byte / 2-byte BE / 2-byte LE, calcule **Pearson + Spearman** (Python pur, sans
  numpy), fait une régression linéaire (scale/offset), et sort un top-20 de candidats
  classés par confiance.
- Endpoints : `POST /api/analysis/correlate-obd` (offline),
  `POST /api/signal-finder/extract-obd-from-log`, `POST /api/signal-finder/read-pid`,
  et le WebSocket live `/ws/signal-finder`.

Voisins algorithmiques dans le même fichier : `/api/analysis/byte-heatmap` (entropie
par byte), `/api/analysis/auto-detect-signals` (détection de signaux, compteurs,
checksums), `/api/analysis/inter-id-dependencies` et `/api/analysis/validate-causality`
(dépendances inter-ID + validation causale par injection).

## Groupes d'endpoints backend

`can/*` (init, send, stop, scan-bitrate) · `capture/*` · `replay/*` · `generator/*` ·
`fuzzing/*` (+ crash-recovery, analyze-crash, compare-logs) · `missions/*` (CRUD, logs,
split, tags, co-occurrence, DBC, comparaisons, export) · `obd/*` (vin, dtc, reset,
scan-pids, full-scan, pid) · `analysis/*` (byte-heatmap, auto-detect-signals,
inter-id-dependencies, validate-causality, correlate-obd) · `network/*` (wifi,
ethernet) · `system/*` (apt, update, backups, reboot, restart-services) · `tailscale/*`.

## Conventions

- **Commentaires et libellés UI en français, code en anglais.**
- Communication temps réel uniquement via WebSocket ; toute exécution `candump`/`cansend`/
  `canplayer`/`cangen` passe par `subprocess`/`asyncio` **côté backend seulement**.
- Données sous `AURIGE_DATA_DIR` (défaut `/opt/aurige/data`), arborescence
  `missions/<id>.json` + `logs/<mission-id>/*.log` + `*.meta.json`.
- Frontend : `npm install --legacy-peer-deps` (React 19 + peer deps).
- Backend : `python3 -m venv venv && ./venv/bin/pip install -r backend/requirements.txt`.
- Lancement dev : `npm run dev` (front, port 3000) + `uvicorn main:app --port 8000` (back).

## Points d'attention / dette technique connue

- `next.config.mjs` a `typescript.ignoreBuildErrors: true` et `images.unoptimized: true` :
  **les erreurs TypeScript ne bloquent pas le build.** Vérifier les types à la main.
- **Historique récurrent d'erreurs d'hydratation Next.js** (rendu de l'heure, terminal
  flottant, auto-scroll). Attention à tout rendu dépendant du temps / de `Date` / de
  `window` : gérer le `mount` client, `suppressHydrationWarning` si besoin.
- ~~`backend/main.py` monolithe~~ : **DÉCOUPÉ** (3 oct. 2026). `main.py` passé de 9357 à ~2290
  lignes = helpers partagés + `state` + constantes + **tous les modèles Pydantic** + `lifespan` +
  l'app + les `include_router`. Les endpoints vivent dans `backend/routers/<domaine>.py`
  (tailscale, system, network, can, capture, replay, generator, injection [inject+aud06+known-frames],
  fuzzing, obd, missions_core, missions_dbc, missions_compare, dbc, analysis, ws) + `auth`/`users`
  préexistants. **Architecture (à respecter si tu ajoutes/déplaces une route) :** un router fait
  `import main` et appelle TOUT helper/état/constante patchable comme `main.<x>` à l'exécution
  (JAMAIS `from main import <helper>` — les tests patchent `main.<x>`) ; `from main import` réservé
  aux modèles Pydantic (non patchés) ; `app.include_router(...)` TOUJOURS avant `fastapi_app = app`
  (rebind CORS). Filet : `backend/tests/test_route_inventory.py` fige l'ensemble des routes (149) et
  détecte doubles ; `test_integration_boot` vérifie que chaque route mutante reste gardée. Les deux
  aplatissent `_IncludedRouter` (FastAPI 0.141 n'aplatit pas les routers inclus dans `app.routes`).
  Seules 3 routes restent `@app` dans main : GET `/status`, `/api/status`, `/api/health`.
- ~~Doublon `/api/system/restart-services`~~ : **résolu** (une seule définition).
- ~~Incohérences de packaging~~ : **résolues** (URLs repo → `v0-aurige-ui-design` dans README +
  `install_pi.sh` ; `.env.example` créé ; `scripts/update_pi.sh` cible `main`).

## Sécurité (contexte métier)

Outil offensif sur bus CAN réel. Voir `docs/AUDIT.md` pour l'état de sécurité détaillé.

- **Authentification par comptes** (remplace le token partagé AUD-01) : utilisateurs, rôles et
  permissions stockés dans SQLite `aurige.db` ; session par cookie `aurige_session`. Le backend
  crée le compte admin au premier démarrage (mot de passe dans
  `AURIGE_DATA_DIR/initial_admin_password.txt`, à supprimer après changement).
  `/opt/aurige/api_token` est **obsolète**.
- La permission `can_inject` contrôle l'injection **par utilisateur** ; elle est distincte du
  filtre d'IDs AUD-06 (`is_id_blocked()`), qui s'applique à tous, quel que soit l'utilisateur.

- ⚠️ **Le filtrage des IDs critiques (airbag, freinage, direction) n'existe pas encore dans
  le code** (AUD-06) : aucune route d'injection (`can/send`, `fuzzing`, `generator`,
  `validate-causality`, `crash-recovery`) ne bloque d'ID. À implémenter via un garde commun
  (`is_id_blocked()`) appelé sur tous les chemins d'injection.
- `OBD_FILTER_IDS` (`7DF`, `7E0`–`7EF`) exclut ces IDs **de l'analyse de trafic uniquement**,
  pas de l'injection.
- **Toute modification touchant l'injection de trames doit ajouter ou préserver ces
  garde-fous, jamais les contourner.**
- **WiFi Access Point (hotspot)** créé par `backend/hotspot.py` : nmcli (primaire), hostapd/dnsmasq
  (fallback) ; SSID par défaut `AURIGE`, auto-démarrage ~45s après boot si pas d'internet (boot-only) ;
  mot de passe stocké dans `${AURIGE_DATA_DIR}/hotspot_password.txt`.
