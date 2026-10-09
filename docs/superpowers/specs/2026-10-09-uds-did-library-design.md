# Bibliothèque de DID UDS par marque

## But

Mémoriser des **DID** (UDS ReadDataByIdentifier `0x22`) par marque/ECU, pour les réutiliser
vite dans le panneau UDS (ex odometer d'une marque). L'utilisateur remplit les DID
spécifiques (trouvés par RE / Scan UDS / sniff valise). Seed = **DID standard ISO 14229
`F1xx`** (publics : VIN F190, n° série ECU F18C…). **Aucune base OEM propriétaire** n'est
embarquée (IP).

## Stockage

`${AURIGE_DATA_DIR}/uds_dids.json` = `{"dids": [DID,...]}`. Helpers `main._load_dids()` /
`main._save_dids(list)` (même pattern que `aud06_blocklist.json`). **Seed si fichier absent** :
liste de DID standard F1xx (voir §Seed). Un `id` UUID par entrée.

Modèle DID : `{ id:str, did:str(hex 1-4 octets), name:str, brand:str="", ecu_request_id:str="7E0", ecu_response_id:str="7E8", note:str="" }`.

## Backend (router `uds.py`, `import main`)

- `GET /api/uds/dids` → `{dids:[...]}`. **Lecture seule** (pas de permission mutante ; non listé = OK pour integration_boot car GET non mutant).
- `POST /api/uds/dids` body `{did, name, brand?, ecu_request_id?, ecu_response_id?, note?}` → valide `did` hex `^[0-9A-Fa-f]{2,8}$` (1-4 octets, longueur paire), `ecu_request_id`/`ecu_response_id` hex 1-8 ; crée `id=uuid4`, ajoute, sauve → `{status:"ok", did:<obj>}`. Permission **`dbc_manage`**.
- `PATCH /api/uds/dids/{did_id}` body partiel (mêmes champs) → met à jour, 404 si absent → `{status:"ok", did}`. **`dbc_manage`**.
- `DELETE /api/uds/dids/{did_id}` → supprime, 404 si absent → `{status:"ok"}`. **`dbc_manage`**.
- Validation hex stricte (400). Inventaire **+4** (156→160). `test_integration_boot` : POST/PATCH/DELETE gardés `dbc_manage` ; GET non mutant.
- `permissions.py` : `("POST", r"^/api/uds/dids", ["dbc_manage"])`, idem PATCH/DELETE sur `^/api/uds/dids/`. ⚠️ Ces règles doivent passer AVANT la règle générique `("POST", r"^/api/uds/", ["can_inject"])` dans `_ROUTE_RULES` (sinon POST /api/uds/dids tomberait sur can_inject) — vérifier l'ordre d'évaluation (première correspondance). Si l'évaluation prend la 1re règle qui matche, placer les règles `uds/dids` avant `^/api/uds/`.

## Seed (DID standard ISO 14229, publics — noms génériques)

`F190` VIN · `F18C` Numéro de série ECU · `F187` Référence pièce constructeur ·
`F189` Version logiciel · `F191` Numéro matériel · `F195` Version SW fournisseur ·
`F197` Nom du système · `F18A` Identifiant fournisseur système. (`ecu_request_id` 7E0, `ecu_response_id` 7E8, `brand` "" = standard.)

## Frontend

`lib/api.ts` : type `UDSDid`, `udsDidsList()`, `udsDidCreate(p)`, `udsDidUpdate(id,p)`, `udsDidDelete(id)`.

`app/uds/page.tsx` : carte **« Bibliothèque DID »** :
- Liste (filtre texte + filtre par `brand`). Chaque ligne : `DID · name · brand · ecu req/resp`.
- Clic « Utiliser » → préremplit le formulaire UDS : `service="22"`, `data=<did>`, `requestId=ecu_request_id`, `responseId=ecu_response_id`. (L'utilisateur peut ensuite envoyer, ou lancer le Mode live.)
- « + Ajouter » → formulaire (did, name, brand, ecu req/resp, note) → `udsDidCreate`. « Enregistrer la requête courante comme DID » = pré-rempli depuis le formulaire UDS si service=22.
- Éditer / Supprimer par ligne (confirm sur suppression).
- Note : « DID standard ISO F1xx fournis ; ajoute les DID spécifiques de ta marque (odometer…) trouvés par RE/Scan UDS. »

## Tests

Backend : POST crée (did normalisé majuscule), GET liste (inclut seed), PATCH modifie, DELETE retire (404 ensuite) ; did non hex / longueur impaire → 400 ; seed présent au 1er GET ; inventaire 160. Frontend : `tsc` 0, build vert.

## Sécurité / hors scope

Métadonnées seules (aucune injection) → `dbc_manage`. Pas de base OEM propriétaire embarquée. Décodage auto de la valeur par DID (formule) = hors scope (le Mode live affiche déjà hex→déc).
