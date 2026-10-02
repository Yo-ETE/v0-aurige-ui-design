# AURIGE — OBD-II vers valise diagnostic

> Design 2026-10-02. Rapprocher la page OBD-II d'une vraie valise de diagnostic :
> DTC correctement décodés + descriptions, DTC en attente/permanents, dashboard PID
> live, moniteurs de disponibilité + freeze frame. Branche `audit-remediation`.
> Commentaires/UI en français, code en anglais.

## 1. État actuel (backend `backend/main.py`)

- `obd_send_with_flow_control(interface, request_id, request_data, response_id="7E8") -> dict` :
  envoie une requête OBD en ISO-TP (flow control) ET lit la réponse. **C'est le helper
  de référence pour toute lecture** (utilisé par VIN / DTC read / full-scan).
- `decode_dtcs_from_frames(responses) -> list[str]` : décode les DTC d'une réponse Service 03.
  **Bug** : `prefix = dtc_type_map.get(upper_nibble >> 2, "P0")` ne produit que P0..P3 → les
  codes C/B/U sont mal décodés (toujours un P-code). Le service de réponse `0x43` est en dur.
- Endpoints : `/api/obd/vin` (Mode 09), `/dtc/read` (Mode 03 stockés), `/dtc/clear` (Mode 04),
  `/reset`, `/scan-pids` (PIDs supportés), `/full-scan`, `/last-report`, `/pid`.
- ⚠️ `/api/obd/pid` (`read_obd_pid`) **envoie seulement** la requête (`can_send_frame` sur 7DF),
  ne lit PAS la réponse — il retourne `{"status":"sent"}`. Il n'existe donc PAS d'endpoint REST
  qui lit+décode une valeur PID.
- `OBD_PID_DECODERS` (~20 PID) : formules de décodage (RPM, vitesse, température, MAF, throttle,
  fuel…) ; chaque entrée décode une réponse Mode 01 en valeur + unité.
- Frontend `app/obd-ii/page.tsx` : VIN (+ décodeur VIN local), DTC read/clear, reset, full-scan,
  export JSON/CSV. Pas de dashboard live, pas de descriptions DTC, pas de pending/permanent.
- `guard_obd_http` valide service/pid ; les requêtes OBD sortent sur 7DF (broadcast) — **canal diag
  légitime, à NE PAS bloquer par AUD-06**.

## 2. Objectif (4 parties, approuvées)

### A. DTC : décodage correct + descriptions
- Corriger le décodeur : catégorie P/C/B/U = bits 7-6 de b1, premier chiffre = bits 5-4,
  reste = (bits 3-0 de b1) + b2. Le service de réponse devient un paramètre (0x43/0x47/0x4A).
- Ajouter un dictionnaire de **descriptions** (codes génériques OBD-II : une sélection utile de
  P0xxx + entrées C/B/U courantes ; fallback « Code générique/constructeur — voir doc » si inconnu).
- Retour structuré : `[{code, description, category}]` (category ∈ P/C/B/U).

### B. DTC en attente (Mode 07) + permanents (Mode 0A)
- Lire aussi Mode 07 (réponse 0x47) et Mode 0A (réponse 0x4A) via `obd_send_with_flow_control`.
- UI : trois sections distinctes (Stockés / En attente / Permanents).

### C. Dashboard PID live
- Nouveau backend : lecture **synchrone décodée** d'un PID : `POST /api/obd/pid-read`
  `{interface, pid}` → `{pid, value, unit, label, raw}` (envoie `02 01 <pid>` via
  `obd_send_with_flow_control` sur 7DF/7E8, décode avec `OBD_PID_DECODERS`). Erreur propre si pas
  de réponse (`{error}`), pas de 500.
- UI : mode « Live » avec sélection de plusieurs PID, Start/Stop ; le frontend **poll** chaque PID
  sélectionné à un intervalle réglable (défaut 500 ms) et affiche valeur courante + **sparkline**
  (Recharts) par PID. (Pas de WebSocket : le poll REST suffit et reste simple.)

### D. Moniteurs de disponibilité + freeze frame
- Mode 01 PID 01 : `POST /api/obd/status` → `{mil_on, dtc_count, monitors:[{name, available, complete}]}`
  (décode l'octet A = MIL+nombre DTC, et les bits moniteurs B/C/D standards).
- Freeze frame (Mode 02) : `POST /api/obd/freeze-frame` `{interface, pid}` → même décodage qu'un
  PID Mode 01 mais service 02 (réponse 0x42), avec le DTC figé (frame 00).

Hors périmètre : Mode 05/06 (O2/moniteurs non-continus), multi-protocole non-CAN, UDS constructeur.

## 3. Backend (détails)

- **Factoriser le décodage DTC** : `decode_dtcs_from_frames(responses, response_service=0x43)` →
  retourne `list[{code, description, category}]`. `dtc_category_letter = "PCBU"[(b1>>6)&3]`,
  `first_digit = (b1>>4)&3`, `rest = f"{(b1&0x0F):X}{b2:02X}"` → `code = f"{letter}{first_digit}{rest}"`.
  Dictionnaire `DTC_DESCRIPTIONS: dict[str,str]` (module-level, FR) + fallback.
- `/dtc/read` renvoie désormais la liste structurée (compat : garder aussi `codes: list[str]` pour
  ne pas casser le front existant, le temps de migrer l'UI).
- Nouveaux endpoints : `/api/obd/dtc/pending`, `/api/obd/dtc/permanent`, `/api/obd/pid-read`,
  `/api/obd/status`, `/api/obd/freeze-frame`. Tous passent par `obd_send_with_flow_control`.
- Réutiliser `OBD_PID_DECODERS` pour `/pid-read` et `/freeze-frame`.
- `can_send_frame`, `obd_send_with_flow_control`, `guard_obd_http`, `OBD_PID_DECODERS` : inchangés
  d'interface.

## 4. Frontend (`app/obd-ii/page.tsx` + composants)

- **DTC** : afficher `code — description` + badge catégorie (P/C/B/U), trois listes (Stockés / En
  attente / Permanents), chacune avec son bouton de lecture. L'effacement (Mode 04) inchangé.
- **Dashboard Live** : un onglet/section « Live » : multi-select de PID (depuis `PID_OPTIONS`
  existant), intervalle de poll, Start/Stop ; par PID sélectionné une carte valeur+unité et une
  sparkline des N derniers points. Le poll appelle `/api/obd/pid-read` par PID.
- **Moniteurs** : carte « Statut émissions » (MIL on/off, nb DTC, liste moniteurs available/complete).
- **Freeze frame** : carte affichant le DTC figé + les PID figés décodés.
- `lib/api.ts` : fonctions + types pour les nouveaux endpoints (`readDTCsPending`, `readDTCsPermanent`,
  `readOBDPidValue`, `getOBDStatus`, `getFreezeFrame`) et le type DTC structuré `OBDDtc`.
- Responsive : nouvelles cartes/listes `flex flex-wrap` ; valeurs mono `break-all`.

## 5. Sécurité / périmètre

- OBD = requêtes diag sur 7DF (standard). `is_id_blocked()` (AUD-06) **ne doit pas** bloquer 7DF/7E0-7EF.
- Les lectures ne modifient rien ; `/dtc/clear` et `/reset` restent les seules actions à risque
  (déjà avec avertissement UI). Pas de nouvelle action destructive.
- Validation : `pid` hex 2 car, `service` hex 2 car (via `guard_obd_http`), `interface` ∈ can0/can1/vcan0.

## 6. Tests & vérification

- Backend (pytest) — unitaire sur le décodage (pas de bus réel) :
  - `decode_dtcs_from_frames` : un P-code, un C-code, un B-code, un U-code décodés correctement
    (vecteurs connus, ex `b1=0x01,b2=0x03 → P0103` ; `b1=0x43,b2=0x00 → C0300` ; vérifier catégorie).
  - descriptions : un code connu → sa description FR ; un code inconnu → fallback.
  - `/dtc/read` renvoie la liste structurée + `codes` (mocker `obd_send_with_flow_control`).
  - `/api/obd/status` : octet A → MIL + nb DTC corrects ; `/pid-read` : une réponse Mode 01 mockée
    décodée en valeur (mocker `obd_send_with_flow_control`, réutiliser une entrée `OBD_PID_DECODERS`).
- Frontend : `npm run build` + `npx tsc --noEmit` (pas de nouvelle erreur au-delà du baseline).
- Vérif réelle (utilisateur, avec la voiture) : live dashboard, DTC texte, pending/permanent,
  moniteurs. Non testable hors véhicule — les tests backend portent sur le décodage pur.

## 7. Inventaire fichiers

Backend : `backend/main.py` (décodeur DTC + dictionnaire + 5 nouveaux endpoints),
`backend/tests/test_obd_decode.py` (+ test_obd_endpoints avec mocks).
Frontend : `app/obd-ii/page.tsx`, `lib/api.ts`, éventuels `components/obd/*`
(live-dashboard, dtc-list).
