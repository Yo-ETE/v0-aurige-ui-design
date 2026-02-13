# AURIGE - Mastery of CAN

**Plateforme d'analyse et de reverse-engineering CAN bus pour l'automobile**

> Copyright (c) 2024-2026 Yo-ETE / AURIGE. Tous droits reserves.
> Ce logiciel fait l'objet d'un depot de brevet. Toute reproduction, distribution,
> modification ou utilisation non autorisee est strictement interdite sans accord
> ecrit prealable du titulaire des droits. Voir le fichier [LICENSE](./LICENSE) pour
> les conditions detaillees.

---

## Presentation

AURIGE est une suite logicielle embarquee sur Raspberry Pi 5 pour l'analyse complete
du bus CAN automobile. Elle couvre tout le cycle d'analyse : capture de trames,
decodage DBC, reverse-engineering de signaux, test de fuzzing, diagnostic OBD-II,
et validation de dependances inter-ECU. L'interface web est accessible depuis tout
navigateur (desktop et mobile).

---

## Architecture technique

| Composant | Technologie |
|-----------|-------------|
| Frontend | Next.js 16, React 19, Tailwind CSS v4, shadcn/ui |
| Backend | Python FastAPI, asyncio, socketCAN |
| Communication temps reel | WebSocket (candump, cansniffer) |
| Hardware | Raspberry Pi 5 + interface CAN (MCP2515 / Waveshare HAT) |
| Donnees | Fichiers JSON (missions) + logs CAN candump |

---

## Pages et fonctionnalites

### ACCUEIL

#### Dashboard (`/`)
Vue d'ensemble du systeme : etat du Raspberry Pi (CPU, RAM, temperature, stockage),
statut des interfaces CAN (can0, can1), mission active, nombre de logs et de trames
captures. Point d'entree principal de l'application.

---

### ANALYSE

#### Clio / Mission (`/missions/[id]`)
Page de detail d'une mission specifique. Affiche les metadonnees (vehicule, description,
date de creation), la configuration CAN (interface, bitrate), la liste des logs captures
avec hierarchie parent/enfant, et les statistiques associees (nombre de trames, duree,
IDs uniques). Permet de telecharger, supprimer ou renommer les logs.

---

### CONFIGURATION

#### Controle CAN (`/controle-can`)
Interface de gestion bas niveau des interfaces CAN :
- **Initialisation** : choix de l'interface (can0, can1, vcan0) et du bitrate (125k, 250k, 500k, 1M)
- **Envoi de trames** : injection manuelle de trames CAN avec choix de l'ID, du DLC et des donnees
- **Statut** : affichage en temps reel de l'etat de chaque interface (up/down, bitrate actif, compteurs d'erreurs)

---

### CAPTURE & ANALYSE

#### Capture & Replay (`/capture-replay`)
Outil de capture et de rejeu de trames CAN :
- **Capture** : demarre un enregistrement candump sur l'interface selectionnee avec nom de fichier personnalisable et description optionnelle. Affichage en temps reel du compteur de trames et de la duree.
- **Replay** : rejeu d'un log capture a vitesse originale ou acceleree. Utile pour reproduire un scenario sans le vehicule.
- **Gestion** : liste des captures avec taille, nombre de trames, possibilite de telecharger ou supprimer.

#### Replay Rapide (`/replay-rapide`)
Version simplifiee du replay avec injection immediate d'un log sur le bus CAN.
Selection rapide du log et de l'interface cible, avec suivi en temps reel
(trames envoyees, progression, vitesse).

#### Isolation (`/isolation`)
Outil de filtrage avance pour isoler des trames specifiques :
- **Filtrage par ID** : selection d'un ou plusieurs CAN IDs a observer
- **Filtrage temporel** : isolation d'une fenetre de temps dans un log
- **Comparaison avant/apres** : detection des changements entre deux etats (ex: avant et apres une action physique sur le vehicule)
- **Export** : sauvegarde du sous-ensemble filtre comme nouveau log enfant

#### Comparaison (`/comparaison`)
Comparaison cote-a-cote de deux logs CAN :
- **Diff par ID** : identifie les IDs presents dans un seul log, les IDs communs, et les differences de payload
- **Diff par byte** : pour chaque ID commun, montre quels bytes different entre les deux logs
- **Hierarchie parent/enfant** : selection facilitee des logs avec groupement par famille
- **Export** : generation d'un rapport de comparaison

#### Analyse CAN (`/analyse-can`)
Page centrale d'analyse avancee avec trois onglets :

**Onglet Heatmap** : visualisation matricielle de l'activite de chaque byte pour chaque CAN ID.
Coloration par entropie (rouge = haute variabilite, bleu = stable). Permet d'identifier
rapidement les bytes porteurs de signaux vs. les constantes.

**Onglet Auto-detect** : detection automatique de signaux dans les trames CAN par analyse
statistique (entropie, correlation temporelle, detection de compteurs et checksums).
Pour chaque signal detecte : position (byte, bit), taille, ordre (big/little endian),
plage de valeurs, confiance. Possibilite de sauvegarder les signaux detectes dans le DBC.

**Onglet Dependances** : analyse des dependances inter-ID. Detecte quels IDs reagissent
(changement de payload) dans une fenetre temporelle courte apres un evenement sur un ID
source. Affiche un mini-graphe des noeuds (colores par role : source/cible/les deux) et
un tableau d'aretes triees par score avec P(reaction), lift vs. hasard, et co-occurrences.
Inclut la **validation causale par injection** : bouton "Valider causalite" qui injecte
experimentalement la trame source sur le bus CAN et observe si la cible reagit, avec
rapport detaille (taux de succes, lag median, classification haute/moderee/faible).

---

### DIAGNOSTIC

#### OBD-II (`/obd-ii`)
Interface de diagnostic OBD-II complete :
- **Lecture VIN** : recuperation du numero d'identification vehicule
- **Codes defaut (DTC)** : lecture et effacement des codes defaut moteur
- **PIDs en temps reel** : lecture de parametres moteur (regime, temperature, vitesse, etc.)
- **Reset ECU** : reinitialisation de calculateurs
- **Scan automatique** : detection des ECU presentes sur le vehicule

#### Signal Finder (`/signal-finder`)
Outil de recherche de signaux par correlation avec une action physique :
- L'utilisateur effectue une action sur le vehicule (tourner le volant, appuyer sur les freins, etc.)
- L'outil analyse les variations de payload pendant et apres l'action
- Classement des candidats par score de correlation
- Affichage des bytes impliques avec graphe temporel

---

### TESTS AVANCES

#### Fuzzing (`/fuzzing`)
Outil de test par injection de trames aleatoires ou semi-aleatoires :
- **Mode random** : injection de payloads aleatoires sur un ID cible
- **Mode incremental** : variation systematique d'un byte a la fois
- **Mode dictionnaire** : test de payloads connus/courants
- **Securite** : filtrage des IDs critiques (airbag, freinage, direction)
- **Logging** : enregistrement de toutes les trames injectees et des reactions observees

#### Crash Recovery (`/crash-recovery`)
Outil de recuperation apres un crash ou un gel du bus CAN :
- Detection automatique des erreurs bus (error frames, bus-off)
- Reinitialisation de l'interface CAN
- Comparaison du log pre-crash avec l'etat post-recovery
- Identification des ECU qui ne repondent plus

#### Generateur (`/generateur`)
Generateur de trafic CAN configurable :
- Generation de trames periodiques avec ID, DLC et payload configurables
- Simulation de signaux (compteur, rampe, sinus, aleatoire)
- Multi-trames : envoi simultane de plusieurs messages a frequences differentes
- Utile pour tester des ECU en isolation ou simuler un environnement vehicule

---

### DBC

#### DBC (`/dbc`)
Gestionnaire de fichiers DBC (CAN Database) :
- **Import/Export** : chargement de fichiers .dbc standard, export des signaux detectes
- **Edition** : ajout, modification et suppression de messages et signaux
- **Visualisation** : tableau des messages avec leurs signaux, facteurs, offsets, unites
- **Application** : overlay DBC en temps reel sur le CAN Sniffer pour decoder les trames live

---

### CAN Sniffer (fenetre flottante)

Fenetre flottante accessible depuis toutes les pages :
- **Vue cansniffer** : affichage en temps reel de toutes les trames CAN regroupees par ID, avec coloration des bytes qui changent (rouge = vient de changer, vert = stable)
- **Overlay DBC** : superposition du decodage DBC sur les trames live (badge DBC/???, nom du message, decodage des signaux au clic)
- **Highlight changes** : mode detection de changements avec trois modes (payload, signal, both) et filtrage des IDs bruyants
- **Filtrage** : par ID (multi-ID separes par virgule), par statut DBC (connu/inconnu), IDs changes uniquement
- **Interface** : selection de l'interface CAN (can0, can1, vcan0)
- **Responsive** : adapte pour desktop (redimensionnable, deplacable) et mobile (pleine largeur)

---

## Installation rapide

### Pre-requis materiels

- Raspberry Pi 5 (ARM64)
- Interface CAN (MCP2515, Waveshare CAN HAT, ou similaire)
- Carte SD 16 Go minimum (32 Go recommande)
- Alimentation 5V 5A USB-C

### Installation en une commande

```bash
curl -fsSL https://raw.githubusercontent.com/Yo-ETE/aurige/main/scripts/install_pi.sh | sudo bash
```

### Installation manuelle

```bash
# 1. Dependances systeme
sudo apt-get update
sudo apt-get install -y curl git nginx python3 python3-venv python3-pip can-utils build-essential avahi-daemon avahi-utils

# 2. Node.js LTS
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo bash -
sudo apt-get install -y nodejs

# 3. Clone du depot
sudo mkdir -p /opt/aurige
cd /opt/aurige
sudo git clone https://github.com/Yo-ETE/aurige.git .

# 4. Configuration
sudo cp .env.example .env.local

# 5. Frontend
sudo npm install --legacy-peer-deps
sudo npm run build

# 6. Backend
cd backend
sudo python3 -m venv venv
sudo ./venv/bin/pip install -r requirements.txt

# 7. Services systemd
sudo cp deploy/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable aurige-web aurige-api
sudo systemctl start aurige-web aurige-api

# 8. Nginx
sudo cp deploy/nginx-aurige.conf /etc/nginx/sites-available/aurige
sudo ln -sf /etc/nginx/sites-available/aurige /etc/nginx/sites-enabled/aurige
sudo rm -f /etc/nginx/sites-enabled/default
sudo systemctl restart nginx
```

### Acces

| Service | URL |
|---------|-----|
| Interface web | `http://aurige.local` ou `http://<ip-du-pi>/` |
| API | `http://<ip-du-pi>/api` |
| Documentation API | `http://<ip-du-pi>/api/docs` |

---

## Configuration de l'interface CAN

```bash
# Charger les modules
sudo modprobe can can_raw mcp251x

# Activer can0 a 500 kbps
sudo ip link set can0 type can bitrate 500000
sudo ip link set up can0

# Verifier
ip link show can0
```

Pour un demarrage automatique, ajouter dans `/etc/network/interfaces.d/can0` :

```
auto can0
iface can0 inet manual
    pre-up /sbin/ip link set can0 type can bitrate 500000
    up /sbin/ip link set up can0
    down /sbin/ip link set down can0
```

---

## Structure des donnees

```
/opt/aurige/data/
  missions/
    <mission-id>.json          # Metadonnees de la mission
  logs/
    <mission-id>/
      capture_YYYYMMDD_HHMMSS.log        # Log candump
      capture_YYYYMMDD_HHMMSS.meta.json  # Metadonnees du log
      isolation_YYYYMMDD_HHMMSS.log      # Log filtre (enfant)
```

---

## Variables d'environnement

| Variable | Defaut | Description |
|----------|--------|-------------|
| `NEXT_PUBLIC_API_URL` | `/api` | URL de base de l'API (frontend) |
| `AURIGE_DATA_DIR` | `/opt/aurige/data` | Repertoire de stockage des donnees |
| `PORT` (web) | `3000` | Port du frontend Next.js |
| `PORT` (api) | `8000` | Port du backend FastAPI |

---

## API Reference

### Systeme

| Endpoint | Methode | Description |
|----------|---------|-------------|
| `/api/health` | GET | Verification de sante |
| `/api/status` | GET | Statut systeme (CPU, RAM, CAN, reseau) |

### Controle CAN

| Endpoint | Methode | Description |
|----------|---------|-------------|
| `/api/can/init` | POST | Initialiser l'interface CAN |
| `/api/can/stop` | POST | Arreter l'interface CAN |
| `/api/can/send` | POST | Envoyer une trame CAN |
| `/api/can/{interface}/status` | GET | Statut d'une interface |

### Capture & Replay

| Endpoint | Methode | Description |
|----------|---------|-------------|
| `/api/capture/start` | POST | Demarrer une capture |
| `/api/capture/stop` | POST | Arreter la capture |
| `/api/replay/start` | POST | Demarrer un replay |
| `/api/replay/stop` | POST | Arreter le replay |

### Analyse

| Endpoint | Methode | Description |
|----------|---------|-------------|
| `/api/analysis/byte-heatmap` | POST | Heatmap d'entropie par byte |
| `/api/analysis/auto-detect` | POST | Detection automatique de signaux |
| `/api/analysis/inter-id-dependencies` | POST | Detection de dependances inter-ID |
| `/api/analysis/validate-causality` | POST | Validation causale par injection |

### OBD-II

| Endpoint | Methode | Description |
|----------|---------|-------------|
| `/api/obd/vin` | POST | Lecture du VIN |
| `/api/obd/dtc/read` | POST | Lecture des codes defaut |
| `/api/obd/dtc/clear` | POST | Effacement des codes defaut |
| `/api/obd/pid` | POST | Lecture d'un PID OBD |

### Missions

| Endpoint | Methode | Description |
|----------|---------|-------------|
| `/api/missions` | GET | Lister les missions |
| `/api/missions` | POST | Creer une mission |
| `/api/missions/{id}` | GET/PATCH/DELETE | Gerer une mission |
| `/api/missions/{id}/logs` | GET | Lister les logs |
| `/api/missions/{id}/logs/{log_id}` | DELETE | Supprimer un log |

### WebSocket

| Endpoint | Description |
|----------|-------------|
| `/ws/candump?interface=can0` | Flux temps reel de trames CAN |
| `/ws/cansniffer?interface=can0` | Vue agregee cansniffer |

---

## Gestion des services

```bash
# Demarrer
sudo systemctl start aurige-web aurige-api

# Arreter
sudo systemctl stop aurige-web aurige-api

# Redemarrer
sudo systemctl restart aurige-web aurige-api nginx

# Logs en temps reel
sudo journalctl -u aurige-api -f
sudo journalctl -u aurige-web -f
```

---

## Propriete intellectuelle

Copyright (c) 2024-2026 Yo-ETE / AURIGE.

Ce logiciel, son architecture, ses algorithmes de detection de signaux CAN,
d'analyse de dependances inter-ID, et de validation causale par injection
font l'objet d'un depot de brevet.

**TOUTE REPRODUCTION, DISTRIBUTION, MODIFICATION OU UTILISATION COMMERCIALE
EST STRICTEMENT INTERDITE** sans accord ecrit prealable du titulaire des droits.

Pour toute demande de licence : contact@aurige.io
