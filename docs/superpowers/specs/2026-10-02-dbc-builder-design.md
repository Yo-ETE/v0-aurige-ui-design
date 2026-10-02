# AURIGE — Éditeur/Builder DBC complet + bibliothèque autonome

> Design 2026-10-02. Rendre AURIGE capable de **vraiment construire une base DBC** :
> éditer les messages (pas seulement les signaux), gérer des **DBC autonomes**
> réutilisables hors mission, et produire un **.dbc standard valide**.
> Branche `audit-remediation`. Auteur : Yo-ETE. Commentaires/UI en français, code en anglais.

## 1. Contexte / état actuel

- DBC **par mission** : `${AURIGE_DATA_DIR}/missions/<id>/dbc.json`
  (shape `{mission_id, messages:[{can_id, name, dlc, signals:[DBCSignal], comment}], created_at, updated_at}`).
- Endpoints existants : `GET /api/missions/{id}/dbc`, `POST .../dbc/signal` (add/update,
  **auto-crée le message** avec `name=MSG_<can_id>`, **`dlc=8` en dur**, comment ""),
  `DELETE .../dbc/signal/{sid}`, `DELETE .../dbc/message/{can_id}`, `DELETE .../dbc` (clear),
  `POST .../dbc/import` (parse un .dbc), `GET .../dbc/export` (génère un .dbc),
  `GET .../dbc/active` (IDs connus pour l'overlay sniffer).
- UI `app/dbc/page.tsx` : éditeur **par mission** (vue messages→signaux, add/edit/delete signal,
  import, export, send signal). **Pas d'édition de message** (nom/DLC/comment), pas de création
  de message vide, pas de DBC hors mission.
- Export `.dbc` actuel : `VERSION`, `NS_ :` (minimal), `BS_:`, `BU_:`, puis
  `BO_ <id_dec> <name>: <dlc> Vector__XXX` + `SG_ <name> : <start>|<len>@<1=Intel|0=Motorola><+/-> (scale,offset) [min|max] "<unit>" Vector__XXX` + `CM_`.

## 2. Objectif (3 parties, approuvées)

### A. Édition des messages
- Pouvoir **créer un message vide** et **éditer ses métadonnées** (name, DLC, comment)
  indépendamment des signaux. Supprimer un message existe déjà.

### B. Bibliothèque DBC autonome
- DBC **non liée à une mission** : stockées, nommées, réutilisables entre missions,
  import/export, et ponts **mission → bibliothèque** et **bibliothèque → mission**.

### C. Export `.dbc` durci
- Produire un `.dbc` ouvrable dans SavvyCAN / candb++ : flag ID étendu, noms assainis
  en identifiants DBC valides, bloc `NS_` complet.

Hors périmètre (non demandé) : nœuds/ECU (BU_) détaillés avec TX/RX par signal, tables de
valeurs `VAL_`/enums, multiplexage. (`BU_:` reste vide, `Vector__XXX` comme récepteur.)

## 3. Modèle de données

Shape commune **DbcDocument** (réutilisée mission + bibliothèque) :
```
{
  "messages": [ { "can_id": "0C6", "name": "BrakeStatus", "dlc": 8, "comment": "",
                  "signals": [ DBCSignal... ] } ],
  "created_at": iso, "updated_at": iso
}
```
- Mission : le fichier reste `missions/<id>/dbc.json` (+ `mission_id`).
- Bibliothèque : `${AURIGE_DATA_DIR}/dbc/<dbc_id>.json`, shape = DbcDocument + `{ "id": dbc_id, "name": "<libellé>" }`.
  - `dbc_id` : slug sûr généré serveur (`[a-z0-9-]`, pas de traversée de chemin), jamais fourni brut par le client pour le chemin.
- `DBCSignal` inchangé : `{id, can_id, name, start_bit, length, byte_order, is_signed, scale, offset, min_val, max_val, unit, comment}`.

## 4. Backend

### 4.1 Factorisation
- Extraire la logique DBC (load/save document, add/update signal, add/update message,
  delete signal/message, clear, import parse, **export .dbc**) dans des helpers **indépendants
  du support** (prennent un chemin de fichier `dbc.json`), dans `backend/main.py` ou un module
  `backend/dbc_store.py`. Les endpoints mission et bibliothèque appellent ces helpers.
- `dbc_parser.py` (parse import) réutilisé tel quel.

### 4.2 Édition message (A) — mission ET bibliothèque
- `POST /api/missions/{id}/dbc/message` body `{can_id, name?, dlc?, comment?}` :
  crée le message s'il n'existe pas, sinon met à jour **uniquement** name/dlc/comment
  (ne touche pas aux signaux). Validation : `can_id` hex 1..8, `dlc` 0..64 (CAN FD toléré ;
  défaut 8), `name` assaini (cf. §4.4). Retour `{status, can_id}`.
- (Le même endpoint existe côté bibliothèque, cf. 4.3.)

### 4.3 Bibliothèque autonome (B)
Préfixe `/api/dbc` (dossier `${AURIGE_DATA_DIR}/dbc/`, créé si absent, perms 0700 cohérentes) :
- `GET /api/dbc` → `{ libraries: [{id, name, message_count, signal_count, updated_at}] }`.
- `POST /api/dbc` body `{name}` → crée une DBC vide, `dbc_id` slug serveur. Retour `{id, name}`.
- `GET /api/dbc/{dbc_id}` → DbcDocument (+ id, name).
- `PATCH /api/dbc/{dbc_id}` body `{name}` → renomme. 
- `DELETE /api/dbc/{dbc_id}` → supprime le fichier.
- Messages/signaux (mêmes helpers que mission) :
  `POST /api/dbc/{dbc_id}/signal`, `DELETE .../signal/{sid}`,
  `POST /api/dbc/{dbc_id}/message`, `DELETE .../message/{can_id}`, `DELETE /api/dbc/{dbc_id}` (clear → garde le doc mais vide `messages`? **non** : clear vide les messages ; la suppression du doc = `DELETE /api/dbc/{dbc_id}` au niveau au-dessus. Pour éviter l'ambiguïté : **pas** de clear séparé côté biblio ; on réutilise delete message / delete signal).
- Import/export :
  `POST /api/dbc/{dbc_id}/import` (multipart .dbc, même parse que mission),
  `GET /api/dbc/{dbc_id}/export` (même exporteur durci).
- Ponts :
  `POST /api/dbc/{dbc_id}/from-mission/{mission_id}` → **copie** le dbc.json de la mission
  dans la DBC biblio (remplace ou fusionne — **remplace** le contenu de la biblio, confirmation côté UI).
  `POST /api/missions/{mission_id}/dbc/from-library/{dbc_id}` → copie la DBC biblio dans la
  mission (remplace le dbc.json mission, confirmation côté UI).
- **Sécurité chemins** : `dbc_id` validé par un validateur dédié (`valid_dbc_id`, `[a-z0-9-]{1,64}`,
  pas de `/`/`\`/`..`), chemin résolu sous `${AURIGE_DATA_DIR}/dbc/` et vérifié `is_within`.
  Même garde que `valid_backup_filename` dans `backend/validators.py`.

### 4.4 Export durci (C) — exporteur partagé
Fonction `dbc_to_text(doc) -> str` utilisée par les 2 exports :
- `NS_ :` complété avec la liste standard des symboles (CM_, BA_, VAL_, etc.) pour compat candb++.
- **ID étendu** : si `int(can_id,16) > 0x7FF` → `bo_id = int(can_id,16) | 0x80000000` dans la ligne `BO_`.
- **Assainissement des noms** (messages + signaux) : `_dbc_ident(name)` = garder `[A-Za-z0-9_]`,
  préfixer `_` si commence par un chiffre, fallback `MSG_<id>` / `SIG_<id>_<bit>` si vide.
  Appliqué **à l'écriture du document** (add/update message/signal valident et normalisent le nom),
  pas seulement à l'export, pour cohérence UI/stockage.
- `SG_` inchangé sur le fond (format déjà correct : `@1`=Intel/little, `@0`=Motorola/big).
- `CM_ BO_` / `CM_ SG_` conservés.

## 5. Frontend (`app/dbc/page.tsx` + composants)

### 5.1 Sélecteur de source
- En haut de la page DBC, un **sélecteur de source** : « DBC de la mission » (si mission active)
  ou une DBC de la **bibliothèque**. Un menu/onglet « Bibliothèque DBC » liste les DBC
  (créer, renommer, supprimer, ouvrir), + import/export par DBC.
- L'éditeur (table messages→signaux, dialogues add/edit) opère sur la **source courante** via
  un petit adaptateur API (mission vs biblio) : mêmes composants, routes différentes.

### 5.2 Édition message (A)
- Bouton « Nouveau message » (dialogue : CAN ID hex, Nom, DLC, Commentaire).
- Par message : action « Éditer » (nom/DLC/commentaire). Suppression message existe déjà.

### 5.3 Ponts mission ↔ bibliothèque (B)
- Depuis la DBC mission : « Copier vers la bibliothèque » (crée/écrase une DBC biblio).
- Depuis une DBC biblio : « Appliquer à la mission active » (écrase la DBC mission).
- Les deux avec **confirmation** (écrasement).

### 5.4 Export/Import
- Boutons export (.dbc) et import (.dbc) disponibles pour mission **et** biblio.
- Mobile : en-têtes/boutons qui **wrap** (cohérent avec la passe responsive).

## 6. Sécurité / périmètre

- DBC = **données** (pas d'injection de trames). Le « send signal » existant reste inchangé et
  relève d'AUD-06 comme toute injection (hors périmètre de ce chantier).
- Validation stricte des `dbc_id` et des `can_id` (hex). Pas d'écriture hors `${AURIGE_DATA_DIR}`.
- Les ponts écrasent un contenu : confirmation UI obligatoire.

## 7. Tests & vérification

- Backend (pytest + TestClient) :
  - helpers DBC (add/update message met à jour name/dlc/comment sans toucher aux signaux ;
    add signal auto-crée le message ; delete).
  - bibliothèque : create/list/get/rename/delete ; refus `dbc_id` invalide (traversée) → 400/404 ;
    import .dbc puis export .dbc round-trip (le ré-import de l'export reparse les mêmes messages/signaux).
  - export durci : ID étendu `>0x7FF` → bit 31 posé ; nom commençant par chiffre → préfixé `_` ;
    `NS_` présent.
- Frontend : `npm run build` + `npx tsc --noEmit` (pas de nouvelle erreur au-delà du baseline).
- Vérif manuelle (utilisateur) : construire une DBC biblio, éditer un message, exporter, ré-importer,
  appliquer à la mission Clio.

## 8. Inventaire fichiers

Backend : `backend/main.py` (ou nouveau `backend/dbc_store.py` pour les helpers partagés),
`backend/validators.py` (`valid_dbc_id`), `backend/dbc_parser.py` (réutilisé),
`backend/tests/test_dbc_store.py` (+ test_dbc_library).
Frontend : `app/dbc/page.tsx`, `lib/api.ts` (routes biblio + message), un adaptateur source,
éventuels composants `components/dbc/*` (dialog message, sélecteur bibliothèque).
