# AURIGE — Audit complet (lecture seule)

- **Branche auditée :** `obd-can-correlation-engine` @ `9e8a76a` (14/02/2026). C'est la branche la plus avancée : elle a 101 commits d'avance sur `main` et 0 de retard, et elle contient toutes les autres branches.
- **Date :** 30/09/2026.
- **Méthode :** 4 audits par domaine (`can-backend`, `signal-analysis`, `frontend`, `pi-deploy`), puis une consolidation par l'agent `reviewer`. Tous les findings Bloquants ont été relus directement dans le code.
- **Sévérités :**
  - **Bloquant** : faille exploitable, garde-fou de sécurité véhicule absent, ou installation standard cassée.
  - **Important** : vrai bug ou vrai risque, avec un déclencheur réaliste.
  - **Mineur** : hygiène, code mort, incohérence.

**Verdict global : ne pas déployer en l'état, que ce soit sur un réseau partagé ou sur un véhicule réel.**
- L'API n'a aucune authentification.
- Le code contient trois chemins d'exécution de code en root, plus une lecture de fichiers arbitraires.
- Le filtre sur les IDs CAN critiques, décrit dans la documentation, n'existe pas dans le code.

---

## Bloquant

### AUD-01 — Backend — API sans authentification, CORS ouvert
- **Fichier :** `backend/main.py:89-95`.
- **Description :** aucun des ~107 endpoints ne vérifie une identité. Le CORS est en `allow_origins=["*"]` avec `allow_credentials=True`.
- **Impact :** toute personne qui atteint le Pi (hotspot, LAN, Tailscale) peut le redémarrer, changer le Wi-Fi, lancer une mise à jour, restaurer une sauvegarde ou injecter des trames CAN. Ce défaut rend exploitables tous les autres findings.
- **Correctif :** ajouter une dépendance `Depends(verify_token)` globale, avec un token partagé généré à l'installation. Restreindre le CORS à l'origine réelle. Voir aussi AUD-24.
- **Sources :** BE-01, PD-01.

### AUD-02 — Backend — Exécution de code root via `POST /api/system/update`
- **Fichier :** `backend/main.py:4936-4938`, `5001`, `5018`, `5037-5038`.
- **Description :** le champ `branch` du corps JSON n'est pas validé. Il est injecté dans `sudo bash -c "echo '{branch}' > /opt/aurige/branch.txt"`, et aussi dans `git checkout -B {branch}`, où une valeur commençant par `-` devient une option git.
- **Impact :** exécution de commandes en root, sans authentification.
- **Correctif :**
  - Valider avec `^[A-Za-z0-9._/]{1,100}$` et refuser un `-` en tête.
  - Écrire le fichier avec `Path.write_text`, sans shell.
  - Idéalement, n'accepter que les noms de branches renvoyés par `/api/system/branches`.
- **Sources :** BE-02.

### AUD-03 — Backend — Injection de code Python via `POST /api/fuzzing/start` (trouvé à la consolidation)
- **Fichier :** `backend/main.py:218` (`mission_id`, sans validation), `1643`, `1794-1805`.
- **Description :** `MISSION_ID = "{request.mission_id}"` est interpolé tel quel dans le script `/tmp/aurige_fuzz.py`, qui est ensuite exécuté par `python3` en root. `DATA_TEMPLATE` (`1641`) suit le même motif.
- **Impact :** exécution de code root avec une simple chaîne Python valide, par exemple `x"; import os; os.system("…"); y="`.
- **Correctif :** sérialiser chaque valeur injectée dans le template avec `json.dumps()`, comme c'est déjà fait pour `TARGET_IDS`. Encore mieux : passer les paramètres au script par un fichier JSON ou par argv, plutôt que de générer du code.
- **Sources :** nouveau (reviewer).

### AUD-04 — Backend — Injection de commande shell par un log importé, rejoué ensuite
- **Fichiers :**
  - `backend/main.py:6458` (`import_log`, regex non ancrée) ;
  - `1341-1383` (`start_replay`) ;
  - `2634-2649` (`create-frame`, où `can_id` et `data` ne sont pas validés).
- **Description :** la regex d'import ne valide que le début de chaque ligne et conserve la ligne entière. Au replay, `cansend {iface} {frame}` est écrit dans `/tmp/aurige_replay.sh`, puis exécuté par `bash`.
- **Impact :** une ligne comme `(1.0) can0 123#DEAD;$(cmd)` exécute `cmd` en root au moment du replay.
- **Correctif :**
  - Utiliser `re.fullmatch` partout où une regex sert de filtre. D'autres occurrences non ancrées sont à reprendre : `5234`, `5865`, `6911`, `7137`, `8019`, `8201`.
  - Revalider chaque trame avec la regex de `can_send_frame`.
  - Rejouer via argv (`create_subprocess_exec`) ou `canplayer`, jamais en générant un script bash.
- **Sources :** BE-04.

### AUD-05 — Backend — Lecture de fichiers arbitraires via `log_path`
- **Fichiers :** `backend/main.py:7659-7663` (`_resolve_log_path`), appelée en `7071`, `7180-7190`, `7714`, `7789`, `8008`, `8195`.
- **Description :** tout chemin absolu qui existe est accepté et lu, y compris via un paramètre de requête (`extract-obd-from-log`).
- **Impact :** lecture de fichiers lisibles par root (clés SSH, configuration). Le contenu revient en partie dans les réponses d'analyse.
- **Correctif :** supprimer `log_path` et ne garder que `mission_id` + `log_id`. À défaut, faire `resolve()` puis vérifier `is_relative_to(MISSIONS_DIR)`.
- **Sources :** BE-03.

### AUD-06 — Backend — Garde-fou sur les IDs CAN critiques absent
- **Fichiers concernés :**
  - `can_send_frame` (`backend/main.py:562-593`) ;
  - `/api/can/send` (`1177-1198`) ;
  - `fuzzing/start` (`1497-1600`) ;
  - `generator/start` (`1444-1472`) ;
  - `validate-causality` (`8173-8240`) ;
  - `crash-recovery` (`1862-1895`).
- **Description :**
  - Aucun filtre sur les IDs airbag, freinage ou direction n'existe, ni côté backend ni côté frontend.
  - Dans l'historique git, « airbag » n'apparaît que dans le README/LICENSE et dans le commentaire de `crash-recovery`, qui envoie justement des trames vers ces IDs.
  - `OBD_FILTER_IDS` (`6826-6828`) n'exclut `7DF`/`7E0–7EF` que de l'analyse, pas de l'injection.
- **Impact :** l'outil peut fuzzer ou injecter sur des calculateurs de sécurité d'un véhicule réel. La documentation (`CLAUDE.md`, README) affirme pourtant le contraire.
- **Correctif :**
  - Créer `CRITICAL_CAN_IDS`, à configurer par plateforme ou par DBC, et une fonction `is_id_blocked()`.
  - L'appeler dans `can_send_frame`, dans la génération du script de fuzzing (plages `id_start`/`id_end` et `target_ids`) et dans `generator/start`.
  - Bloquer aussi `7DF`/`7E0–7EF` hors des routes OBD.
  - Ajouter une dérogation explicite et journalisée pour `crash-recovery`.
- **Sources :** BE-05.

### AUD-07 — Déploiement — Installation via le README impossible
- **Fichiers :** `README.md:195`, `212` (`Yo-ETE/aurige.git`) ; `scripts/install_pi.sh:7`, `24` (`REPO_URL` par défaut `https://github.com/YOUR_REPO/aurige.git`).
- **Description :** le dépôt réel est `Yo-ETE/v0-aurige-ui-design`. Seuls `update_pi.sh:17` et `main.py:4931` ont la bonne URL.
- **Impact :** l'installation initiale échoue en suivant la documentation.
- **Correctif :** une seule constante `AURIGE_REPO_URL`, avec la bonne valeur par défaut, et un README corrigé.
- **Sources :** PD-10.

---

## Important

### Backend

| ID | Fichier:ligne | Description | Impact | Correctif | Sources |
|---|---|---|---|---|---|
| AUD-08 | `main.py:2634-2649`, `2726-2730` | `create-frame` (`name` non assaini) et `rename` (`new_name` seulement passé par `.replace(" ","_")`) permettent de sortir de `logs/`. | Écriture ou déplacement de fichiers hors de la mission, en root. | Appliquer `sanitize_id()` aux deux noms. | BE-06 |
| AUD-09 | `main.py:1377`, `1794`, `1616`, `1920`, `2046`, `2119`, `3607`, `3666`, `3692`, `5075` | Scripts et fichiers écrits à des chemins `/tmp` fixes avec `open("w")`, puis exécutés en root. | Élévation de privilèges locale par un lien symbolique posé à l'avance. | `tempfile.mkstemp`, ou un dossier `/opt/aurige/run` en 0700. | BE-08 |
| AUD-10 | `main.py:1444-1472` | `generator/start` : ni liste blanche d'interfaces, ni bornes `data_length`/`delay_ms`, et `can_id` n'est pas validé. | Injection d'argument dans `cangen`, et saturation du bus. | Mêmes validations que `fuzzing/start`, plus AUD-06. | BE-09 |
| AUD-11 | `main.py:3054-3137` | `state.candump_process` est global et sans `asyncio.Lock`. Un client qui demande une autre interface relance `candump` pour tout le monde. | Flux coupés pour les autres clients WebSocket. | Un processus par interface avec compteur de clients, plus un verrou. | BE-11 |
| AUD-12 | `main.py:5484`, `~5564`, `6652`, `7074`, `7192`, `7665` | Chemins construits par `MISSIONS_DIR / mission_id` sans `sanitize_id`. | Remontée d'un niveau avec `..`. Grave si `mission_id` passe un jour dans un corps JSON. | Toujours passer par `get_mission_dir()`. | BE-15 |
| AUD-13 | `main.py:5130-5143` / `6586-6611` | `POST /api/system/restart-services` est défini deux fois. Starlette sert la première définition, la seconde est du code mort. | Une correction faite dans la mauvaise copie n'a aucun effet. | Supprimer `6586-6611` et aligner le type de retour dans `lib/api.ts:905`. | BE-07, PD-09, FE-07 |
| AUD-14 | `main.py:8162-8170` | `CausalityRequest` : `window_ms`/`pause_ms` sans bornes. | Déni de service par une requête qui occupe le serveur longtemps. | Bornes Pydantic (`ge`/`le`). | BE-14 |

### Analyse

| ID | Fichier:ligne | Description | Impact | Correctif | Sources |
|---|---|---|---|---|---|
| AUD-15 | `main.py:7059-7099`, `7449-7470`, `7782` | Calcul CPU lourd exécuté directement dans des routes et WebSockets `async`. Il n'y a aucun `to_thread` dans tout le fichier. | L'event loop se fige pendant une corrélation. Candump, sniffer et terminal gèlent pour tous les clients. | `asyncio.to_thread(...)`, plus des plafonds (`sample_limit`) sur auto-detect et correlate. | SA-02 |
| AUD-16 | `main.py:6972-7005`, `6961` | La recherche de la trame CAN la plus proche est refaite pour chacun des ~22 modèles. `can_timestamps` est calculé puis jamais utilisé. | Coût multiplié par ~22 : plusieurs minutes sur un gros log, sur Pi 5. | Aligner une seule fois, avec `bisect` sur les timestamps. | SA-01 |
| AUD-17 | `main.py:7007`, `7020` | Seuil fixe \|r\| ≥ 0.3, quel que soit le nombre d'échantillons n (minimum 3, et 5 en live). | Faux positifs sur du bruit pur (Monte-Carlo) : 100 % à n=3, 78 % à n=5, 47 % à n=10. Le top-20 est pollué. | Exiger n ≥ 20, ou un test t = r·√((n−2)/(1−r²)) ≥ valeur critique. | SA-03 |
| AUD-18 | `main.py:7026`, `7055` | La confiance vaut `0.6·|p| + 0.4·|s|` et ne dépend pas de n. | Des artefacts à n=3 sont classés devant de vrais signaux à n=200. | Pondérer la confiance par n. | SA-04 |
| AUD-19 | `main.py:7808-7810` | `byte_series[bi]` est filtré colonne par colonne, ce qui désaligne les octets quand le DLC varie. | Checksums (`7574-7656`) et regroupement Jaccard (`7848-7869`) faux. | Sentinelle `None`, ou filtrer sur le DLC nominal. | SA-05 |
| AUD-20 | `main.py:7938-7941`, `5727`, `~6729-6737` | `is_signed` est déduit de l'étendue des valeurs, pas du complément à 2. Les valeurs restent non signées. | Le DBC exporté est incohérent : signal déclaré signé avec une plage 0-255. | Retirer ce flag automatique, ou faire une vraie conversion avec test de plausibilité. | SA-06 |
| AUD-21 | `backend/dbc_parser.py:134-138`, `170-172` | La regex `SG_` ne reconnaît pas le multiplexage (`M`/`mN`), et `else: break` coupe le parsing du message. | Les signaux multiplexés, et les signaux normaux qui les suivent, sont perdus sans aucun message. | Groupe optionnel pour le mux, et une fin de bloc explicite. | SA-07 |

### Frontend

| ID | Fichier:ligne | Description | Impact | Correctif | Sources |
|---|---|---|---|---|---|
| AUD-22 | `lib/api.ts:1500-1503` → `app/signal-finder/page.tsx:623` | `getSignalFinderWsUrl` utilise `getApiBaseUrl()` au lieu de `getWsBaseUrl()`, donc produit l'URL relative `/ws/signal-finder`. | Le mode Live casse sur les WebView et navigateurs anciens. `NEXT_PUBLIC_WS_URL` est ignoré. | `${getWsBaseUrl()}/ws/signal-finder?interface=${iface}` | FE-03 (Bloquant → Important) |
| AUD-23 | `package.json:8` | Le script `"lint": "eslint ."` existe, mais eslint n'est pas installé et il n'y a aucune configuration. | `npm run lint` échoue. Aucun contrôle statique, alors que `ignoreBuildErrors` est à `true`. | Ajouter eslint et `eslint-config-next` (flat config), plus un script `typecheck` (`tsc --noEmit`). | FE-11 |

### Déploiement

| ID | Fichier:ligne | Description | Impact | Correctif | Sources |
|---|---|---|---|---|---|
| AUD-24 | `deploy/aurige-api.service:10` | `uvicorn --host 0.0.0.0 --port 8000` : l'API est joignable directement, sans passer par nginx. | Tout contrôle ajouté dans nginx est contourné. | `--host 127.0.0.1`. | PD-02 |
| AUD-25 | `scripts/update.sh:25`, `34`, `36`, `40` | `git reset --hard` sans sauvegarde. `cd "$REPO_DIR/frontend"` pointe vers un dossier qui n'existe pas. Avec `set -e`, le script s'arrête après avoir écrasé le backend, sans relancer les services. `npm run build \|\| true`. | Pi laissé à moitié mis à jour, avec les services arrêtés ou incohérents. | Supprimer ce script (doublon de `update_pi.sh`), ou le réécrire. | PD-04 |
| AUD-26 | `scripts/install_pi.sh:363`, `scripts/uninstall_pi.sh:59` | `rm -rf "$AURIGE_DIR/…"` sans `set -u` ni garde `${VAR:?}`. La désinstallation efface les données et les sauvegardes sur une seule confirmation. | Suppression hors périmètre si la variable est vide. Perte irréversible des captures. | `set -euo pipefail`, gardes `${VAR:?}`, sauvegarde finale forcée. | PD-05, PD-07 |
| AUD-27 | `deploy/aurige-api.service:7`, `deploy/aurige-web.service:7`, `scripts/install_pi.sh:574` | Les deux services tournent en `User=root` sans aucun durcissement systemd. `chmod -R 777` sur `data/`. | Toute compromission de l'application donne root. Les données sont modifiables par n'importe quel utilisateur local. | Web : utilisateur dédié. API : `NoNewPrivileges`, `PrivateTmp`, `ProtectHome`, capacités `CAP_NET_ADMIN`/`CAP_NET_RAW`. Données : `chmod 750`. | PD-06, PD-08 |
| AUD-28 | `scripts/update_pi.sh:20`, `backend/main.py:4932`, `4665`, `4687`, `scripts/install_pi.sh:380` | La branche par défaut est `v0/yo-ete-5c91d9cb`. Elle existe toujours sur GitHub, donc le repli vers `main` ne se déclenche jamais. | Les Pi déployés tournent sur une branche en retard de 69 commits sur `obd-can-correlation-engine`, sans le moteur de corrélation. | Une seule constante `AURIGE_DEFAULT_BRANCH`, pointée sur la branche de référence choisie. | PD-03 |
| AUD-29 | `pnpm-lock.yaml`, `scripts/install_pi.sh:471`, `scripts/update.sh:39` | Il y a un lockfile pnpm, mais l'installation utilise `npm --legacy-peer-deps`, sans `package-lock.json`. | Arbre de dépendances non reproductible entre le poste de dev et le Pi. | Choisir un seul gestionnaire et utiliser `--frozen-lockfile` ou `npm ci`. | PD-12, FE-12 |

### Transverse

| ID | Fichier:ligne | Description | Impact | Correctif | Sources |
|---|---|---|---|---|---|
| AUD-30 | Tout le dépôt | Aucun test (Python ou TS), aucune CI, aucun lint Python. | Aucun filet de sécurité avant de corriger les Bloquants ou de découper `main.py`. | pytest + `TestClient` (et WebSocket), plus une CI GitHub Actions avec ruff, eslint, `tsc`, pytest et un `vcan0` ou des subprocess mockés. | Reviewer |
| AUD-31 | `CLAUDE.md:40-46`, `CLAUDE.md:105-107` | La section « Branches » est inversée : `obd-can-correlation-engine` est en avance, pas en retard. `CLAUDE.md` affirme aussi que le filtrage des IDs critiques existe (cf. AUD-06). | Tout travail lancé « depuis `main` » repart d'un code en retard de 101 commits, et la documentation laisse croire à une sécurité inexistante. | Corriger les deux sections. | Étape 0, BE-05 |

---

## Mineur

| ID | Zone | Fichier:ligne | Description (correctif) |
|---|---|---|---|
| AUD-32 | Backend | `main.py:3117-3118` et ailleurs ; `460-477` | Des `except: pass` avalent les erreurs, et `run_command` renvoie stderr/stdout bruts au client. (Journaliser via `error_logger` et renvoyer un message générique.) |
| AUD-33 | Backend | `backend/requirements.txt` | Dépendances en `>=` uniquement, sans verrou ni hash. (`uv pip compile --generate-hashes`.) |
| AUD-34 | Backend | `main.py:3054`, `3744`, `7304` | Le paramètre `interface` des WebSockets n'est pas comparé à la liste blanche. Pas d'injection shell, car les arguments passent en argv. |
| AUD-35 | Analyse | `main.py:6961`, `8086-8089`, `7155`, `7264` | Code mort (`can_timestamps`, `tj += 1` après un `break`). Les réponses OBD négatives `0x7F` sont ignorées sans signalement. Les clés `int` de `excluded_bytes` deviennent des chaînes en JSON, sans que ce soit documenté. |
| AUD-36 | Analyse | `main.py:6806-6824` | Formules PID conformes à J1979. Il manque `5C` (température d'huile) et `5E` (débit carburant). |
| AUD-37 | Frontend | `lib/mission-store.ts:70-225`, `lib/isolation-store.ts:113-224` | `persist()` sans `skipHydration` : risque d'hydratation latent, pas déclenché aujourd'hui. |
| AUD-38 | Frontend | `lib/isolation-store.ts:216-222` | Stockage en `localStorage` sans plafond ; un `setItem` peut échouer sans erreur visible. (Passer en `sessionStorage` ou plafonner.) |
| AUD-39 | Frontend | `lib/api.ts:335-339` | `forceCleanupGenerator` appelle une route backend qui n'existe pas. Code mort. |
| AUD-40 | Frontend | `components/sidebar.tsx:41-47`, `app/dbc/page.tsx:145-153` | `fetch` directs hors de `lib/api.ts`. Pour la sidebar, l'alias backend `/status` (`main.py:725`) évite le bug. Un message de l'import DBC est en anglais. |
| AUD-41 | Frontend | `lib/sniffer-store.ts:341-361` | Un rendu par trame reçue, sans regroupement via `requestAnimationFrame` : saccades probables au-delà de ~500 msg/s. |
| AUD-42 | Frontend | `app/configuration/page.tsx:264-286`, `app/dbc/page.tsx:121`, `app/fuzzing/page.tsx:~392` | `window.confirm()` au lieu d'`AlertDialog`. Aucune confirmation avant de lancer le fuzzing. |
| AUD-43 | Frontend | `package.json` | `immer` et `use-sync-external-store` en `"latest"` alors qu'ils ne sont pas importés. Next `16.0.10` : lancer `pnpm audit` pour les failles React Server Components de fin 2025. |
| AUD-44 | Déploiement | `README.md:215` | Le README demande de copier `.env.example`, qui est absent. `install_pi.sh:464` génère déjà `.env.local`. |
| AUD-45 | Déploiement | `deploy/nginx-aurige.conf:14-89` | Ni en-têtes de sécurité, ni `limit_req`, ni TLS. |
| AUD-46 | Déploiement | `main.py:4363-4393` | `apt upgrade -y` sans liste des paquets ni retour arrière. (`apt-mark hold` sur le noyau et les modules CAN.) |
| AUD-47 | Transverse | `package.json` | Pas de champ `"license"` alors que `LICENSE` est propriétaire et que le README mentionne un brevet. Le nom du paquet est `my-v0-project`. (`"license": "UNLICENSED"`, et renommer.) |

**Points vérifiés sans anomalie :**
- Aucun secret dans l'historique git des 9 branches, et aucun `.env` jamais commité.
- Aucun `shell=True` ; `can_send_frame` utilise des regex ancrées.
- `lifespan` arrête bien les processus à l'extinction.
- Les noms de sauvegardes sont validés.
- Aucun `dangerouslySetInnerHTML`.
- Les correspondances d'IDs dans le sniffer sont bornées.
- `lib/api.ts` et le backend concordent, sauf AUD-39.
- Pas de NaN/Inf possible dans les calculs statistiques, et les résultats sont déterministes.

---

## Top 5 des actions prioritaires

1. **AUD-01 et AUD-24 — ajouter une authentification et faire écouter uvicorn sur 127.0.0.1.** C'est le verrou principal : il fait passer toutes les failles de « n'importe qui sur le réseau » à « utilisateur authentifié ».
2. **AUD-02, AUD-03, AUD-04 et AUD-05 — supprimer les 3 exécutions de code root et la lecture de fichiers arbitraires.** Les correctifs sont locaux (validation stricte, argv, `json.dumps`, `is_relative_to`), comptent environ 1 à 2 jours et ne demandent pas de refonte.
3. **AUD-06 — implémenter le filtre sur les IDs critiques** (`CRITICAL_CAN_IDS` + `is_id_blocked()`) sur tous les chemins d'injection. C'est la garantie de sécurité véhicule que le projet annonce ; elle est à faire avant tout usage sur un véhicule réel.
4. **AUD-30 — mettre en place pytest et une CI minimale**, avec des tests de caractérisation sur les chemins corrigés en 2 et 3. C'est le prérequis au découpage de `main.py`.
5. **AUD-28, AUD-07, AUD-25 et AUD-31 — réaligner le déploiement et la documentation.** Choisir une branche de référence, une seule URL de dépôt, supprimer `update.sh` et corriger `CLAUDE.md`. Sans cela, les correctifs n'arrivent jamais sur les Pi.

---

## Estimation : découpage de `backend/main.py` en routers FastAPI

**Routes par domaine (grep) :**

| Domaine | Routes |
|---|---|
| missions (dont 8 `dbc`) | 33 |
| system | 17 |
| obd | 8 |
| fuzzing | 8 |
| analysis | 6 |
| tailscale | 5 |
| network | 5 |
| can | 5 |
| replay | 4 |
| capture | 3 |
| generator | 3 |
| WebSocket | 3 |
| status, sniffer, signal-finder, health | 2 + 2 + 2 + 1 |
| **Total** | **~107** |

**Couplage constaté :**
- **`state = ProcessState()` (ligne 60)** : l'état global est partagé par can, replay, generator, fuzzing et les WebSockets, sans verrou. C'est le point dur.
- **`SnifferState` (3735) et `SignalFinderState` (7295)** : faciles à isoler.
- **Helpers sans état** : `sanitize_id`, `get_mission_dir` (357-380), `run_command` (460), `can_send_frame` (562). Faible risque.
- **obd, analysis et signal-finder** sont fortement couplés par `OBD_*` et `_correlate_obd_with_can`, et doivent rester dans un même module.
- **`lifespan` (63-76)** doit agréger le nettoyage de tous les domaines.
- **Le doublon `restart-services`** montre que l'ordre d'enregistrement des routes a déjà causé un bug réel.

**Plan par phases :**

| Phase | Contenu | Effort |
|---|---|---|
| 0 — Prérequis | Tests de caractérisation : `can_send_frame`, `/api/can/send`, replay, `_resolve_log_path`/correlate, `sanitize_id`, `fuzzing/start`, DBC multiplexé, WebSocket `TestClient`. Snapshot du schéma OpenAPI. Suppression du doublon AUD-13. | 2-3 j |
| 1 — Helpers | `core/paths.py`, `core/can_utils.py`, `core/obd_constants.py`, schémas Pydantic partagés. Aucun changement de comportement. | 2 j |
| 2 — État partagé | `core/state.py` (instances uniques importées partout), ajout de l'`asyncio.Lock` (AUD-11). Phase la plus risquée. | 3-4 j |
| 3 — Routers, du moins couplé au plus couplé | network + tailscale → system (update/apt isolés) → capture + replay + generator → can + `/ws/candump` → fuzzing → obd + analysis + signal-finder (+ `to_thread`, AUD-15) → missions + dbc. | 6-8 j |
| 4 — Intégration | `include_router`, comparaison du schéma OpenAPI avant/après (routes et ordre), essai sur un Pi réel avec `vcan0`. | 1-2 j |
| **Total** | | **14-19 jours-personne** (≈ 3 semaines à temps plein) |

**Risques :**
- L'ordre de résolution des routes peut changer.
- Des états dupliqués par router, en réinstanciant `state` dans chaque module.
- Les WebSockets sont difficiles à tester.
- La CI a besoin de `vcan0`, ou de subprocess `candump`/`cansend`/`cangen` mockés.

**Recommandation :** corriger les Bloquants (Top 5, points 1 à 3) **avant** le découpage, directement dans `main.py`, avec les tests de la phase 0. Découper ensuite du code déjà assaini.
