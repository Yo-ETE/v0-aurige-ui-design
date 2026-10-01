# AURIGE — Hotspot / SSID local de secours (Lot 1)

> Design validé le 2026-10-01. Premier des trois lots du chantier « administration
> comme Theia » (Lot 1 Hotspot → Lot 2 Console à onglets → Lot 3 Hardening update).
> Référence : projet Theia (`Yo-ETE/v0-theia-webapp-development`, branche
> `audit/lot7-tactical`). Branche de travail : `audit-remediation`.

## 1. Problème

AURIGE *détecte et affiche* un point d'accès WiFi nommé « Hotspot » (`backend/main.py`
~3924, `components/dashboard/raspberry-pi-status.tsx`), et un watchdog
(`aurige-net-watchdog`) tente de le ré-activer — mais **aucun code du dépôt ne crée
ce profil**. Le guide dans `app/configuration/page.tsx` promet un « Bouton Mode
Hotspot » qui n'existe pas. Résultat : sur un Pi neuf, sans connectivité, l'opérateur
n'a aucun moyen de joindre AURIGE localement.

Objectif : le Pi lève **son propre SSID** (mode AP) pour s'y connecter en local,
automatiquement au démarrage s'il n'a aucun réseau, et manuellement via l'UI.
Comportement et mécanisme calqués sur Theia.

## 2. Décisions (validées)

- **Déclenchement auto = boot seulement** (parité Theia) : une tâche one-shot ~45 s
  après le démarrage de l'API, qui lève l'AP uniquement si `uptime ≤ 300 s` (donc un
  vrai boot, pas un simple redémarrage de service) **et** aucun réseau utilisable.
  Pas de surveillance continue ni de redescente auto.
- **Contrôles manuels** Démarrer / Arrêter + statut + identifiants dans l'UI (comme
  Theia).
- **Mécanisme AP mirroré de Theia** : NetworkManager en primaire
  (`nmcli device wifi hotspot`), fallback hostapd + dnsmasq brut (192.168.4.1/24).
- **SSID par défaut `AURIGE`**, mot de passe aléatoire `secrets.token_urlsafe(9)`
  persisté dans `${AURIGE_DATA_DIR}/hotspot_password.txt` (0600), modifiable (8–63
  caractères ASCII). Domaine réglementaire `FR`.
- `aurige-net-watchdog` **conservé** pour la récupération d'uplink ; il ne pilote
  pas la montée de l'AP (c'est le one-shot boot qui le fait).
- **UI de ce lot** : carte Hotspot ajoutée à la section Réseau de
  `app/configuration/page.tsx` (le Lot 2 la déplacera dans la console à onglets).

## 3. Architecture

### Divergences assumées vs Theia

1. Le backend AURIGE tourne **en root** (`deploy/aurige-api.service` `User=root`),
   contrairement à Theia (user `pi` + sudo NOPASSWD). Les commandes `nmcli`,
   `hostapd`, `dnsmasq`, `iw`, `ip` s'exécutent donc directement ; le préfixe `sudo`
   reste inoffensif en root et est conservé pour cohérence avec le code existant.
2. Pas de `system_monitor` 5 s ni de table SQLite `logs` comme Theia. Le watchdog
   fait sa propre détection de connectivité et journalise via `error_logger.log_info`.
3. Routes sous `/api/network/hotspot/*` (famille réseau AURIGE), pas `/api/config/*`.

### Module backend `backend/hotspot.py` (nouveau)

Fonctions (sync, lancées en executor depuis les handlers async) :

- `get_ap_capable_interface() -> str` — énumère `/sys/class/net/*/wireless`, via
  `iw dev <if> info` → phy → `iw phy<N> info`, retient la première interface listant
  `* AP`. Fallback : première interface wireless, sinon `wlan0`.
- `get_or_create_hotspot_password() -> str` — lit
  `${AURIGE_DATA_DIR}/hotspot_password.txt` ; sinon génère `token_urlsafe(9)`,
  écrit en 0600 (`os.open(..., O_CREAT|O_WRONLY|O_TRUNC, 0o600)`), retourne.
- `set_hotspot_password(password: str)` — valide `valid_wpa_passphrase` (8–63 ASCII
  imprimables), écrit dans le même fichier (0600).
- `start_hotspot_blocking(ssid, password) -> dict` — `{status: success|warning|error,
  detail, interface}` :
  1. `iface = get_ap_capable_interface()` ; si `which hostapd` absent → erreur claire.
  2. `iw reg set FR` ; `nmcli device disconnect <iface>` ; `pkill hostapd` ; `pkill dnsmasq`.
  3. **Primaire** : `nmcli device wifi hotspot ifname <iface> ssid <ssid> password
     <pw> band bg channel 6` ; attendre 3 s ; vérifier via `nmcli -t -f NAME,TYPE
     connection show --active` + `iw dev <iface> info` contenant `type AP`.
  4. **Fallback** (si nmcli échoue) : `ip addr add 192.168.4.1/24`, dnsmasq
     (`/tmp/aurige_dnsmasq.conf`, `dhcp-range=192.168.4.2,192.168.4.254,...,24h`),
     puis hostapd (`/tmp/aurige_hostapd_<driver>.conf`, 0600, `wpa=2`,
     `wpa_key_mgmt=WPA-PSK`, `rsn_pairwise=CCMP`, `channel=6`, `hw_mode=g`) en
     essayant les drivers `nl80211`, `rtl871xdrv`, `wext`.
- `stop_hotspot() -> dict` — `nmcli connection down` sur une connexion wifi AP active,
  `pkill hostapd`, `pkill dnsmasq`, `ip addr flush`, `ip link set <iface> up`,
  `wpa_cli -i <iface> reconnect` ; retourne `{status}`.
- `hotspot_status() -> dict` — `{active, ssid, interface, clients}` : connexion nmcli
  wireless active + `iw dev <if> info` `type AP` ; sinon `systemctl is-active hostapd` ;
  clients via `iw dev <if> station dump`.

Validateurs `valid_ssid` (1–32 octets imprimables, pas de `-` en tête) et
`valid_wpa_passphrase` (8–63 ASCII) ajoutés dans `backend/hotspot.py` (AURIGE n'a pas
de `security.py`).

### Watchdog boot `backend/hotspot.py::auto_hotspot_once()`

```
AUTO = os.getenv("AURIGE_AUTO_HOTSPOT","1") not in ("0","false","no")
DELAY_S = float(os.getenv("AURIGE_AUTO_HOTSPOT_DELAY_S","45"))
BOOT_WINDOW_S = float(os.getenv("AURIGE_AUTO_HOTSPOT_BOOT_WINDOW_S","300"))
SSID = os.getenv("AURIGE_AUTO_HOTSPOT_SSID","AURIGE")
```

`async def auto_hotspot_once()` : si `not AUTO` → return ; `await asyncio.sleep(DELAY_S)` ;
lire uptime (`/proc/uptime`) — si `> BOOT_WINDOW_S` return ; si `has_working_network()`
return ; sinon `password = get_or_create_hotspot_password()` ;
`await loop.run_in_executor(None, start_hotspot_blocking, SSID, password)` ;
`log_info("Hotspot de secours démarré automatiquement (aucun réseau au boot)")`.

`has_working_network() -> bool` : ethernet avec IP (`ip -json addr show` sur `eth*`/`enp*`)
**ou** modem USB avec IP (`usb*`/`wwan*`/`ppp*`/`enx*`) **ou** `ping -c1 -W2 8.8.8.8` OK.
Une simple association WiFi sans route ne compte pas.

Planifié dans le `lifespan` de `backend/main.py`, après `db.init_db`, via
`asyncio.create_task(hotspot.auto_hotspot_once())` ; la tâche est annulée au shutdown.

### Endpoints (dans `backend/main.py`, groupe network)

| Méthode | Path | Permission | Rôle |
|---|---|---|---|
| GET | `/api/network/hotspot/status` | (auth) | `{active, ssid, interface, clients}` |
| GET | `/api/network/hotspot/credentials` | `system_network` | `{ssid, password}` (afficher d'avance) |
| POST | `/api/network/hotspot/credentials` | `system_network` | `{password}` → 400 si invalide |
| POST | `/api/network/hotspot/start` | `system_network` | lève l'AP (SSID courant + mot de passe stocké) |
| POST | `/api/network/hotspot/stop` | `system_network` | arrête l'AP |

Handlers async : `await asyncio.get_event_loop().run_in_executor(None, <blocking fn>)`.
Ajouter les règles dans `backend/permissions.py::_ROUTE_RULES` : les trois POST et le
GET credentials → `["system_network"]`. `GET status` reste auth-seul (lecture inoffensive).

### Install / déploiement

`scripts/install_pi.sh` : `apt-get install -y hostapd dnsmasq` ; puis
`systemctl stop/disable/unmask hostapd` et `systemctl stop/disable dnsmasq` (le backend
les lance à la demande). `iw`, `wpa_cli`, `nmcli` supposés présents (Raspberry Pi OS
Bookworm + wireless-tools). Documenter les variables `AURIGE_AUTO_HOTSPOT*`.

### Frontend (ce lot)

- `lib/api.ts` : `getHotspotStatus()`, `getHotspotCredentials()`, `setHotspotPassword(pw)`,
  `startHotspot()`, `stopHotspot()` (wrappers `apiFetch` sur `/api/network/hotspot/*`).
- `app/configuration/page.tsx` : carte **Hotspot (SSID local)** dans la section Réseau —
  statut (actif/SSID/interface/clients), SSID + mot de passe avec bouton copier, champ
  changer mot de passe (8–63), boutons Démarrer / Arrêter, avertissement « sur une seule
  carte WiFi, démarrer le hotspot coupe la connexion client ». Rendu dépendant du temps
  (clients, statut) protégé `suppressHydrationWarning` / monté client.
- Remplacer le texte de guide trompeur (≈ l.2108, 2136) par la description réelle.

## 4. Sécurité

- `credentials` (GET/POST) et start/stop derrière `system_network` ; non-admin sans le
  flag → 403. `GET status` lisible par tout authentifié (ne révèle pas le mot de passe).
- Mot de passe hotspot 0600, hors backups si possible — il reste dans `AURIGE_DATA_DIR`
  (comme Theia) ; acceptable (secret local, régénérable).
- SSID et passphrase validés avant toute commande shell (`valid_ssid`,
  `valid_wpa_passphrase`) — pas d'injection via `nmcli`/`hostapd`.
- Pas de nouveau chemin d'injection CAN ; ce lot ne touche pas aux routes d'injection.

## 5. Tests & vérification

Backend (pytest, `backend/tests/test_hotspot.py`) — mocker `subprocess`/executor :
- `valid_ssid` / `valid_wpa_passphrase` : acceptent/rejettent les bons cas (vide, >32,
  `-` en tête, passphrase <8/>63).
- `get_or_create_hotspot_password` : crée le fichier 0600 au premier appel, relit ensuite.
- `set_hotspot_password` : rejette <8/>63, écrit sinon.
- `has_working_network` : True si eth/modem/ping OK (mock), False sinon.
- `auto_hotspot_once` : ne démarre pas si `AUTO=0`, si `uptime>300`, ou si réseau OK ;
  démarre sinon (mock `start_hotspot_blocking`, asserter appelé/non appelé).
- Endpoints (TestClient + SessionAuthMiddleware) : viewer sans `system_network` sur
  start/stop/credentials → 403 ; admin → exécute (mock executor) ; `GET status` → 200 ;
  `POST credentials` mot de passe invalide → 400.

Vérification manuelle sur le Pi : couper l'uplink, rebooter, vérifier que le SSID
`AURIGE` apparaît ~45 s après le boot et qu'on s'y connecte (mot de passe lu via
`GET /api/network/hotspot/credentials` avant la coupure) ; Démarrer/Arrêter manuels ;
`iw dev <if> info` montre `type AP`.

## 6. Inventaire des fichiers

Nouveaux : `backend/hotspot.py`, `backend/tests/test_hotspot.py`,
`lib/api.ts` (fonctions — modif), carte UI dans `app/configuration/page.tsx` (modif).
Modifiés : `backend/main.py` (routes + lifespan task), `backend/permissions.py`
(`_ROUTE_RULES`), `scripts/install_pi.sh` (apt hostapd/dnsmasq),
`app/configuration/page.tsx` (carte + texte guide).

Hors de ce lot : console à onglets (Lot 2), hardening update (Lot 3).
