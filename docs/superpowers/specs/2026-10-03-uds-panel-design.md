# AURIGE — Panneau UDS (diagnostic avancé / test d'actionneurs)

> Design 2026-10-03. Client UDS générique (ISO 14229 sur ISO-TP) depuis le Pi : session
> diagnostique, security access, IOControl, RoutineControl, lecture DID — pour reproduire un
> « test des actionneurs » de valise (ex essuie-glaces) sur n'importe quelle marque, à condition
> que l'utilisateur fournisse les IDs/DID/clé. Branche `audit-remediation`. FR UI, EN code.

## 1. But + réalité

« Test des actionneurs » d'une valise = UDS (pas standardisé comme OBD PIDs). Pour le faire depuis
le Pi il faut : entrer une session diag (`0x10`), souvent **SecurityAccess `0x27`** (seed/key,
algo propriétaire → clé fournie par l'utilisateur), puis **IOControl `0x2F`** ou **RoutineControl
`0x31`** avec DID/RID spécifiques, sur les **IDs CAN de l'ECU cible** (pas `7DF` ; souvent derrière
le gateway → bus direct, cf multi-bus). AURIGE fournit un **client UDS générique** où l'utilisateur
renseigne ces paramètres (depuis sa RE ou une session valise capturée).

## 2. État réutilisable

- `main.obd_send_with_flow_control(interface, request_id, request_data, response_id="7E8") -> {success, responses, error}`
  (main.py:1064) gère déjà l'**ISO-TP en RÉCEPTION** (first frame 0x10 + flow control `resp_id-8` + consécutifs 0x21…,
  réassemblage). Le CALLER construit la trame single-frame ISO-TP : `{len:02X}{data_hex}` (len = nb d'octets data,
  padding à 8). Ex OBD pid-read : `02 01 0C …`.
- `can_send_frame`, `parse_candump_line`, regex hex, AUD-06 (`is_id_blocked`), `useCriticalIds` (front) existent.
- Routers Option-2 (`import main`, `main.<x>`). Permission `can_inject` pour l'injection bus.

## 3. Backend

- `backend/uds_client.py` :
  - `NRC` : dict des codes de réponse négative courants → libellé FR (0x10 rejet général, 0x11 service non supporté,
    0x12 sous-fonction non supportée, 0x13 longueur invalide, 0x22 conditions incorrectes, 0x24 séquence requête,
    0x31 hors plage, 0x33 accès sécurité refusé, 0x35 clé invalide, 0x36 trop de tentatives, 0x37 délai requis,
    0x78 réponse en attente, 0x7E/0x7F session, …).
  - `build_single_frame(service_hex: str, data_hex: str) -> str` : concatène `service+data` (hex, octets),
    préfixe PCI longueur `{n:02X}` (n = nb d'octets de service+data, doit être ≤7 sinon `ValueError` « requête
    multi-frame non supportée »), pad à 16 hex (8 octets) avec `00`.
  - `decode_response(responses) -> dict` : réassemble/normalise la réponse de `obd_send_with_flow_control`
    (liste de trames/hex) → `{raw, service_echo, positive: bool, nrc?: {code, label}, data_hex}`.
    Positive = 1er octet == requested_service + 0x40 ; négative = `7F <service> <nrc>`.
- `backend/routers/uds.py` :
  - `POST /api/uds/request` body `{interface, request_id, response_id="7E8", service, data=""}` :
    - Valide `interface ∈ {can0,can1,vcan0}` (400) ; `request_id`/`response_id` hex 1..8 (400) ; `service` 1 octet hex (400) ;
      `data` hex pairs, taille telle que service+data ≤7 octets (400 sinon : « multi-frame non supporté »).
    - Construit la trame via `build_single_frame`, appelle `main.obd_send_with_flow_control(interface, request_id,
      frame, response_id)`, puis `decode_response`. Renvoie `{status, request: {...}, response: {raw, positive, nrc?, data_hex, service_echo}}`.
      Erreur de transport → `{status:"error", error}` (pas d'exception non gérée).
    - Permission `can_inject` (injection bus). **PAS** de `is_id_blocked` ici (action explicite ; confirmation côté UI).
  - (Presets côté client, pas d'endpoint.)
- `permissions.py` : `("POST", r"^/api/uds/", ["can_inject"])`.
- Dépendances : aucune nouvelle (réutilise l'ISO-TP existant).

## 4. Frontend

- `lib/api.ts` : types `UDSResponse {raw, positive, nrc?:{code,label}, data_hex, service_echo}`,
  `UDSResult {status, request, response?, error?}` ; `udsRequest({interface, requestId, responseId, service, data})`.
- **Page `app/uds/page.tsx`** (+ entrée sidebar « UDS » section Capture & Analyse) :
  - Champs : interface (Select), `requestId` (hex, ex `7E0`), `responseId` (hex, ex `7E8`), service (hex), data (hex).
  - **Presets** (boutons qui préremplissent service+data) : « Session étendue » (`10 03`), « Session par défaut » (`10 01`),
    « TesterPresent » (`3E 00`), « SecurityAccess — demander seed » (`27 01`), « SecurityAccess — envoyer clé » (`27 02` + champ clé),
    « IOControl » (`2F` + DID + control), « RoutineControl start » (`31 01` + RID), « ReadDataByIdentifier » (`22` + DID), « Raw ».
    Les presets guident ; l'utilisateur ajuste DID/RID/clé.
  - Bouton « Envoyer » → `udsRequest` → affiche la réponse : positive (service echo + data décodée hex) en vert, négative
    (`7F` + NRC + libellé FR) en rouge. Historique des échanges (req → resp) dans la session de page.
  - **Sécurité (CRITIQUE)** : avant d'envoyer un **service d'écriture/action** (`0x2F`,`0x31`,`0x2E`,`0x11`,`0x14`,`0x27 sendKey`,
    `0x10` session non-défaut) OU si `requestId` est dans la liste critique (AUD-06, via `useCriticalIds`), **AlertDialog de
    confirmation** « Action UDS sur ECU — peut déclencher un actionneur réel. Confirmer ? ». Services de lecture (`0x22`,`0x19`,`0x3E`,
    `0x27 requestSeed`) sans confirm. Bandeau d'avertissement permanent « UDS agit directement sur un ECU réel ».
  - Note : « nécessite la session/clé/DID corrects de ton véhicule ; pour l'ECU cible, branche-toi sur son bus (derrière le gateway) ».
- Responsive, shadcn réutilisé.

## 5. Sécurité / périmètre

- UDS **injecte** sur le bus → `can_inject` + confirmation UI sur les services d'action/écriture (peut bouger des
  actionneurs réels, voire sécurité). Pas de `is_id_blocked` (explicite) mais confirmation.
- Validation stricte hex ; single-frame ≤7 octets (multi-frame request = itération future, documenté).
- Pas de clé/secret stocké (la clé 0x27 est saisie à la volée, envoyée telle quelle, non persistée).

## 6. Tests

- Backend (`backend/tests/test_uds.py`, mock `main.obd_send_with_flow_control`) : `build_single_frame("2F","0203FF")` →
  `04 2F 02 03 FF 00 …` (len=4) ; service+data >7 → 400 ; réponse positive (`6F …` pour service 2F+0x40) décodée positive ;
  réponse négative `7F 2F 33` → nrc {0x33, « accès sécurité refusé »} ; transport error → `{status:"error"}` ; interface invalide
  → 400 ; request_id non hex → 400. `test_route_inventory` +1 (154→155). `test_integration_boot` : `/api/uds/request` gardé `can_inject`.
- Frontend : `npm run build` vert + `npx tsc --noEmit` **0**.
- Vérif réelle (utilisateur, voiture) : session étendue + (security access) + IOControl essuie-glaces sur l'ECU body via le bus direct.

## 7. Inventaire

Backend : `backend/uds_client.py` (nouveau), `backend/routers/uds.py` (nouveau) + include main.py, `backend/permissions.py`,
`backend/tests/test_uds.py` + maj `test_route_inventory`/`test_integration_boot`.
Frontend : `lib/api.ts`, `app/uds/page.tsx` (nouveau) + `components/sidebar.tsx`.
Différé : décodeur UDS d'un log capturé (réassemblage ISO-TP + vue échange), requête multi-frame.
