# AURIGE — Authentification par comptes & RBAC

> Design validé le 2026-10-01. Remplace l'authentification par token partagé
> (AUD-01) par un système de comptes utilisateurs avec rôles et permissions
> fines, inspiré du projet Theia (`Yo-ETE/v0-theia-webapp-development`,
> branche `audit/lot7-tactical`). Branche de travail : `audit-remediation`.

## 1. Objectif et cadrage

Le token partagé AUD-01 n'est pas viable en usage réel : un seul secret à
copier-coller, pas d'identité, pas de séparation des droits. On passe à des
comptes nominatifs.

Décisions de cadrage (validées) :

- **Usage** : admin (propriétaire) + quelques comptes invités ponctuels, gestion
  légère. Pas une plateforme multi-équipes.
- **Inscription** : aucune inscription publique. Le premier démarrage crée le
  compte `admin`. L'admin crée et supprime les autres comptes depuis la page
  administration. Un invité reçoit un identifiant + mot de passe, ne peut pas
  s'auto-inscrire.
- **Permissions** : système fin complet — accès par zone de pages + capacité par
  capacité (voir §3).
- **Stockage** : SQLite (`aiosqlite`) pour l'authentification uniquement. Les
  missions et les logs restent en JSON sur disque, inchangés. Exception contenue
  à la règle « pas de base de données » du projet, justifiée par le besoin
  (hash, rôles, permissions, écritures concurrentes).

## 2. Architecture

### Divergences assumées vs Theia

1. **Session = token opaque serveur** (table `sessions`), pas de JWT. AURIGE est
   servi en same-origin derrière nginx : une session serveur est plus simple,
   permet une révocation instantanée, et évite la gestion d'un secret de
   signature. Theia utilise un JWT HS256 car son frontend appelle le backend en
   cross-origin ; ce n'est pas le cas ici.
2. **Frontend ↔ backend en same-origin via nginx** (`apiFetch` existant), pas le
   cross-origin `:8000` + CORS regex de Theia. Le durcissement CORS d'AUD-24 est
   préservé.
3. **Guard de page admin côté client ajouté** — Theia ne protège la page admin
   que par le masquage du lien de navigation (faille relevée à l'audit de sa
   branche). Ici, double verrou : 403 backend **et** redirection client si le
   compte n'est pas admin.

### Modules backend

| Fichier | Rôle |
|---|---|
| `backend/db.py` (nouveau) | Couche SQLite `aiosqlite` : connexion WAL, `init_tables()`, seed admin, helpers requêtes, nettoyage sessions expirées. |
| `backend/auth.py` (réécrit) | Hash mot de passe (PBKDF2 stdlib), création/vérification de session, `SessionAuthMiddleware` (ASGI, HTTP + WebSocket), router `/api/auth` (login/logout/me). |
| `backend/permissions.py` (nouveau) | Clés de permission, presets, table `PERMISSION_ROUTES`, `required_permissions()`, `permissions_for()` (cache), `allows()`, `ensure()`, `invalidate()`. |
| `backend/routers/users.py` (nouveau) | CRUD comptes (admin only) sous `/api/auth/users`. |
| `backend/main.py` (modifié) | Init DB au startup ; swap `TokenAuthMiddleware` → `SessionAuthMiddleware` (sous CORS) ; enregistrement des routers. |

### Modules frontend

| Fichier | Rôle |
|---|---|
| `lib/auth-context.tsx` (nouveau) | `AuthProvider` + `useAuth()` : `user`, `permissions`, `isAdmin`, `hasPermission()`, `hasArea()`, `login()`, `logout()`, `refresh()`, `hubUnreachable`. |
| `components/auth-gate.tsx` (réécrit) | Formulaire identifiant + mot de passe (remplace le champ token AUD-01) ; écran « backend injoignable + retry » ; spinner de chargement. |
| `components/sidebar.tsx` (modifié) | Navigation filtrée par `hasArea()` ; lien Administration si `area_administration` ; bouton logout. |
| `app/administration/page.tsx` (nouveau) | Console comptes. Guard client : non-admin → redirection `/`. Monte `<UserManagement/>`. |
| `components/admin/user-management.tsx` (nouveau) | Liste, création, édition, suppression de comptes. |
| `components/admin/permission-editor.tsx` (nouveau) | 3 presets + cases groupées Zones / Actions. |
| `lib/api.ts` (modifié) | Helpers auth AUD-01 réécrits : `login(username, password)`, `logout()`, `getMe()`, CRUD users. |

Tous les appels passent par `apiFetch` (same-origin, `credentials: "include"`).
Sur un 401, `apiFetch` → auth-context `user = null` → la gate affiche le login.

## 3. Modèle de permissions

Deux tiers, à la manière de Theia : des flags de **zone** (accès + lecture d'un
groupe de pages) et des flags d'**action** (capacité dangereuse ou avec effet).

### Flags de zone (7)

| Flag | Pages couvertes |
|---|---|
| `area_dashboard` | `/` |
| `area_missions` | missions |
| `area_control` | controle-can, generateur, fuzzing, crash-recovery |
| `area_analysis` | analyse-can, comparaison, isolation, signal-finder, obd-ii, dbc |
| `area_capture` | capture-replay |
| `area_configuration` | configuration |
| `area_administration` | administration (gestion des comptes) |

### Flags d'action (15)

| Flag | Gate backend (méthode + path, indicatif) |
|---|---|
| `can_inject` | `POST /api/can/send`, `POST /api/generator/*send*` |
| `fuzzing_run` | `POST /api/fuzzing/*` (start) |
| `crash_recovery_run` | `POST /api/fuzzing/crash-recovery*` (injection) |
| `causality_validate` | `POST /api/analysis/validate-causality` |
| `capture_run` | `POST /api/capture/*` (start/stop) |
| `replay_run` | `POST /api/replay/*` (canplayer) |
| `missions_create` | `POST /api/missions` |
| `missions_edit` | `PATCH /api/missions/{id}` (intention edit) |
| `missions_delete` | `DELETE /api/missions/{id}` |
| `dbc_manage` | import / édition DBC |
| `obd_write` | OBD reset / clear DTC (écrit sur l'ECU) |
| `system_update` | `POST /api/system/{apt,update}` |
| `system_reboot` | `POST /api/system/{reboot,restart-services}` |
| `system_network` | `/api/network/*`, `/api/tailscale/*` |
| `system_backup` | `/api/system/backups*` |

Total : 22 flags.

### Presets

`admin` est un rôle (bypass par rôle, `permissions = NULL`). `operator` et
`viewer` sont des presets de permissions appliqués à un compte de rôle `viewer`.

| Flag | admin | operator | viewer |
|---|:-:|:-:|:-:|
| area_dashboard | ✓ | ✓ | ✓ |
| area_missions | ✓ | ✓ | ✓ |
| area_control | ✓ | ✓ | ✗ |
| area_analysis | ✓ | ✓ | ✓ |
| area_capture | ✓ | ✓ | ✓ |
| area_configuration | ✓ | ✓ | ✗ |
| area_administration | ✓ | ✗ | ✗ |
| can_inject | ✓ | ✓ | ✗ |
| fuzzing_run | ✓ | ✓ | ✗ |
| crash_recovery_run | ✓ | ✓ | ✗ |
| causality_validate | ✓ | ✓ | ✗ |
| capture_run | ✓ | ✓ | ✗ |
| replay_run | ✓ | ✓ | ✗ |
| missions_create | ✓ | ✓ | ✗ |
| missions_edit | ✓ | ✓ | ✗ |
| missions_delete | ✓ | ✓ | ✗ |
| dbc_manage | ✓ | ✓ | ✗ |
| obd_write | ✓ | ✓ | ✗ |
| system_update | ✓ | ✗ | ✗ |
| system_reboot | ✓ | ✗ | ✗ |
| system_network | ✓ | ✗ | ✗ |
| system_backup | ✓ | ✗ | ✗ |

`viewer` = lecture seule (dashboard, missions, analyse, capture) sans aucune
action. `operator` = tout sauf la gestion système destructive et la gestion des
comptes. `DEFAULT_PERMISSIONS` = preset `viewer`.

**Articulation avec AUD-06** : les permissions répondent à « **qui** peut
injecter » ; le futur garde `is_id_blocked()` (filtrage des IDs critiques
airbag/freinage/direction) répond à « **quoi** peut être injecté ». Deux couches
distinctes et complémentaires ; aucune ne remplace l'autre.

## 4. Schéma SQLite

Fichier `/opt/aurige/data/aurige.db`. WAL mode, `foreign_keys = ON`. SQL brut via
`aiosqlite`, pas d'ORM.

```sql
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,              -- "{salt_hex}${pbkdf2_sha256_hex}"
  role          TEXT NOT NULL DEFAULT 'viewer',  -- 'admin' | 'viewer'
  permissions   TEXT DEFAULT NULL,          -- JSON des 22 flags ; NULL = défaut du preset ; admin ignore
  is_active     INTEGER NOT NULL DEFAULT 1, -- désactiver un compte sans le supprimer
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  last_login    TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,             -- opaque, secrets.token_urlsafe(32)
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  expires_at  TEXT NOT NULL,                -- création + 30 jours
  last_seen   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
```

- `role` vaut `admin` ou `viewer`. `operator` n'est pas un rôle DB : c'est un
  compte `viewer` portant le preset de permissions `operator`.
- Hash : PBKDF2-HMAC-SHA256, 100 000 itérations, sel aléatoire 16 octets,
  stockage `"{salt}${digest}"`. Vérification par `hmac.compare_digest`. Stdlib
  uniquement, aucune dépendance crypto (bcrypt/passlib non requis).
- Session : la vérification lit le cookie, fait un lookup dans `sessions`,
  contrôle `expires_at`, charge `user_id` → rôle et permissions **live depuis la
  DB** (révocation immédiate). Les permissions sont mises en cache mémoire (TTL
  20 s) et invalidées explicitement à l'édition d'un compte.
- Seed admin : si `users` est vide au démarrage, création de `admin` avec un mot
  de passe `secrets.token_urlsafe(12)` écrit dans
  `/opt/aurige/data/initial_admin_password.txt` (mode 0600).
- Policy : mot de passe ≥ 10 caractères, username ≥ 2 caractères.
- Nettoyage des sessions expirées au démarrage et de façon paresseuse à l'accès.

## 5. Endpoints & enforcement

### Authentification

| Méthode | Path | Body | Réponse |
|---|---|---|---|
| POST | `/api/auth/login` | `{username, password}` | pose le cookie `aurige_session` ; `{user:{id,username,role,permissions}}` · 401 creds invalides · 429 rate-limit |
| POST | `/api/auth/logout` | — | supprime la ligne `sessions` + le cookie ; `{ok:true}` |
| GET | `/api/auth/me` | — (cookie) | `{id,username,role,permissions}` effectives · 401 si pas de session |

Cookie `aurige_session` : `httponly`, `samesite="strict"`, `secure` dynamique
(vrai uniquement si la requête est HTTPS, détecté via `x-forwarded-proto`),
`max_age = 30 jours`, `path="/"`.

### CRUD comptes (admin only)

| Méthode | Path | Body | Notes |
|---|---|---|---|
| GET | `/api/auth/users` | — | liste, permissions parsées |
| POST | `/api/auth/users` | `{username, password, role='viewer', permissions?}` | 400 si username pris ou mot de passe < 10 |
| PATCH | `/api/auth/users/{id}` | `{password?, role?, permissions?, is_active?}` | invalide le cache de permissions et les sessions du compte si rôle/perms changent |
| DELETE | `/api/auth/users/{id}` | — | refus si self ; refus si dernier admin |

### Trois couches d'enforcement

1. **AuthN middleware** : session valide sinon 401 (et purge du cookie). Paths
   publics (bypass) : `POST /api/auth/login`, `POST /api/auth/logout`,
   `GET /api/health`. WebSocket : refus du handshake (close 1008) sans session.
2. **AuthZ coarse middleware** : table `PERMISSION_ROUTES` (méthode + path →
   flag(s) requis). Non-admin sans le flag → 403. Admin bypass par rôle. Les
   routes de gestion de comptes exigent le rôle admin.
3. **`permissions.ensure()` en handler** pour les routes à double intention
   (ex. `PATCH /api/missions/{id}` = `missions_edit` ou `can_inject` selon le
   payload), qui lit `request.state.user` et le corps de la requête.

Fail-closed : des permissions illisibles retombent sur le preset `viewer`
(lecture seule). Rate-limit login : en mémoire par IP, 5 essais / 300 s.

## 6. Frontend — comportement

- `useAuth()` distingue « déconnecté » (le backend répond 401 → `user = null` →
  login) de « backend injoignable » (le fetch échoue → `hubUnreachable = true`,
  on garde `user`), afin qu'un rechargement pendant une coupure ne renvoie pas au
  login.
- Aucun token stocké côté client : la session vit uniquement dans le cookie
  httpOnly ; toutes les requêtes s'appuient sur `credentials: "include"`.
- Navigation filtrée par `hasArea()`. Le lien Administration n'apparaît que si
  `area_administration`.
- Page administration : guard client (`!isAdmin` → redirection `/`) **en plus**
  du 403 backend.
- Defense-in-depth UX : les boutons d'action (inject, delete, reboot…) sont
  masqués ou désactivés via `hasPermission(flag)`. Le gate réel reste le 403
  backend.

## 7. Migration & déploiement

Remplacement complet du token AUD-01, pas de coexistence :

- `backend/auth.py` réécrit (`SessionAuthMiddleware` remplace
  `TokenAuthMiddleware`, suppression de `load_or_create_token` / `token_matches`).
- `/opt/aurige/api_token` devient obsolète (plus lu) ; laissé en place ou
  supprimé manuellement.
- `backend/requirements.txt` : ajout de `aiosqlite` → `pip install` requis au
  déploiement.
- `deploy/aurige-api.service` inchangé (toujours `--host 127.0.0.1`, AUD-24
  préservé) → pas de `daemon-reload`.

Premier démarrage : init DB → `users` vide → seed `admin` + mot de passe
aléatoire dans `/opt/aurige/data/initial_admin_password.txt` (0600). L'admin lit
le fichier, se connecte, change son mot de passe, crée les comptes invités, puis
**supprime** `initial_admin_password.txt` (présent dans `data`, donc dans les
backups). `aurige.db` est dans `data` → survit aux redéploiements et est inclus
dans les backups.

Séquence de déploiement Pi (branche `audit-remediation`) :

```bash
cd /opt/aurige/repo && sudo git pull
sudo cp -r backend/* /opt/aurige/backend/
cd /opt/aurige/backend && sudo ./venv/bin/pip install -r requirements.txt
sudo cp -r /opt/aurige/repo/{app,components,lib} /opt/aurige/frontend/
cd /opt/aurige/frontend && sudo npm run build
sudo systemctl restart aurige-api aurige-web
sudo cat /opt/aurige/data/initial_admin_password.txt
```

Dev local : DB à `$AURIGE_DATA_DIR/aurige.db` (défaut `/opt/aurige/data`),
override `AURIGE_DB_PATH` optionnel.

## 8. Tests & vérification

Backend (pytest, étend `backend/tests/`) :

- Hash : roundtrip PBKDF2, mauvais mot de passe rejeté, comparaison en temps
  constant.
- Session : create → lookup → expiry (session expirée rejetée), logout supprime
  la ligne.
- AuthN middleware : pas de session → 401 ; session valide → pass ; paths
  publics bypass ; WebSocket non authentifié → close 1008.
- Login : bons creds → cookie posé ; mauvais → 401 ; 6ᵉ essai → 429.
- AuthZ : `viewer` sur `can_inject` → 403 ; `operator` → autorisé ; admin
  bypass ; CRUD comptes par non-admin → 403.
- `permissions.ensure()` sur une route à double intention.
- CRUD : create (username pris → 400, mot de passe < 10 → 400) ; patch rôle/perms
  invalide cache + sessions ; delete self → refus ; delete dernier admin → refus.
- Seed admin si `users` vide ; idempotent sinon.
- Presets : `operator` et `viewer` résolvent les bons flags.

Frontend : pas d'infrastructure de test front (comme AUD-01). Vérification
manuelle navigateur sur le Pi : login admin, création d'un invité `viewer`, le
`viewer` ne voit pas controle-can et les boutons d'injection sont masqués (403 si
forcé), `operator` injecte, logout → redirection login.

Cible : ~30 tests pytest verts + checklist navigateur Pi validée avant clôture.

## 9. Inventaire des fichiers

Nouveaux : `backend/db.py`, `backend/permissions.py`, `backend/routers/users.py`,
`lib/auth-context.tsx`, `app/administration/page.tsx`,
`components/admin/user-management.tsx`, `components/admin/permission-editor.tsx`,
tests associés dans `backend/tests/`.

Modifiés : `backend/auth.py` (réécrit), `backend/main.py`,
`backend/requirements.txt`, `components/auth-gate.tsx`, `components/sidebar.tsx`,
`lib/api.ts`.

Inchangés et préservés : `deploy/aurige-api.service` (binding 127.0.0.1, AUD-24),
stockage JSON des missions et logs, `apiFetch` / nginx same-origin.
