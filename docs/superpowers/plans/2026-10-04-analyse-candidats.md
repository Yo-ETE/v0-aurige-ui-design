# Analyse CAN — Vue « Candidats » — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Faire ressortir vite le signal d'une action (ex essuie-glace ID 303) en classant les octets par cardinalité (état faible-cardinalité = candidat ; compteur/checksum/aléatoire = bruit replié).

**Architecture:** Backend ajoute une classification par octet à `byte-heatmap` (réutilise `unique_count`, `_detect_counter_bytes`, `_detect_checksum_bytes` ; nouveau helper `_classify_action_byte`). Frontend ajoute un onglet « Candidats » (défaut) construit depuis `heatmapResult`.

**Spec:** `docs/superpowers/specs/2026-10-04-analyse-candidats-design.md`

## Global Constraints

- FR UI / EN code. **Aucune route ajoutée** → `test_route_inventory` inchangé. Lecture seule (pas d'injection, AUD-06 non concerné).
- Router Option-2 (`import main`, `main.<x>`). Champs heatmap existants inchangés (non-régression heatmap/autodetect/dependencies). Suite backend verte, `tsc` 0, build vert.

---

### Task 1: Backend — classification cardinalité

**Files:** Modify `backend/main.py` (helper `_classify_action_byte`), `backend/routers/analysis.py` (byte-heatmap enrichi) ; Test `backend/tests/test_analyse_candidats.py`.

- [ ] `backend/main.py` : `def _classify_action_byte(byte_vals: list[int], frame_count: int, is_counter: bool = False, is_checksum: bool = False) -> tuple[str, list[str], float]` :
  - `uniq = sorted(set(byte_vals))` ; `n = len(uniq)` ; `distinct = [f"{v:02X}" for v in uniq[:16]]`.
  - `n <= 1` → `("constant", distinct, 0.0)`.
  - `is_counter` → `("compteur", distinct, 0.0)` ; `is_checksum` → `("checksum", distinct, 0.0)`.
  - `small = frame_count < 8` ; `ratio = n / frame_count if frame_count else 1.0` ; `ent = _shannon_entropy(byte_vals)`.
  - état si `2 <= n <= 16 and (small or ratio < 0.5)` → `("etat", distinct, round((17 - n) / 16.0, 4))`.
  - sinon aléatoire si `not small and ratio >= 0.5 and ent >= 3.0` → `("aleatoire", distinct, 0.0)`.
  - sinon → `("continu", distinct, round(max(0.1, 0.4 - ratio * 0.3), 4))`.
- [ ] `backend/routers/analysis.py` byte-heatmap (boucle par ID, ~l.450-469) : avant la boucle octets, collecter `byte_series = {bi: [f["bytes"][bi] for f in frames if bi < len(f["bytes"])] for bi in range(dlc)}` ; `counters = main._detect_counter_bytes(byte_series, dlc, 0.75)` ; `checksums = main._detect_checksum_bytes(byte_series, dlc, 0.70)`. Dans le dict de chaque octet non vide, ajouter `klass`, `distinct_values`, `score` via `k, dv, sc = main._classify_action_byte(byte_vals, frame_count, bi in counters, bi in checksums)`. Pour l'octet vide : `"klass":"constant","distinct_values":[],"score":0`. Champs existants inchangés.
- [ ] `backend/tests/test_analyse_candidats.py` : `_classify_action_byte` — `[0x55]*20` → `("constant",["55"],0.0)` ; `[0x55,0x95,0x56]*7` (n=3, ratio bas) → klass `"etat"`, score `round(14/16,4)` ; 18 valeurs distinctes sur 20 (ratio 0.9, ent haute) → `"aleatoire"` score 0 ; cap : 20 valeurs distinctes → `len(distinct_values)==16` ; `is_counter=True` → `"compteur"`. Endpoint (login admin, POST byte-heatmap sur une mission factice OU via un mock des frames) : chaque byte a `klass`/`distinct_values`/`score`. Si le montage d'une mission réelle est lourd, tester surtout le helper + un appel endpoint minimal.
- [ ] `cd backend && python -m pytest -q` vert (inventory inchangé) + `npx tsc --noEmit` 0. Commit `feat(analyse): classification cardinalite des octets (etat/compteur/checksum/aleatoire)`.

---

### Task 2: Frontend — onglet « Candidats »

**Files:** Modify `lib/api.ts` (type `HeatmapByteInfo`), `app/analyse-can/page.tsx`.

- [ ] `lib/api.ts` : `HeatmapByteInfo` += `klass: "constant"|"compteur"|"checksum"|"aleatoire"|"etat"|"continu"`, `distinct_values: string[]`, `score: number`.
- [ ] `app/analyse-can/page.tsx` : type d'onglet `tab` += `"candidats"` ; **défaut `"candidats"`**. Vue Candidats : depuis `heatmapResult.ids`, aplatir en `{canId, index, klass, distinct_values, score, change_rate, entropy}` tous octets, filtrer `score > 0` (klass etat/continu), trier `score` desc. Rendu : liste, chaque ligne `[Badge canId mono] B{index} · [badge classe: État/Continu] · {distinct_values.length} valeurs · chips hex {distinct_values.map}` + `change {%} · entropie {}`. Les `etat` (score élevé) ressortent en tête. Section repliée (`<details>` ou Collapsible shadcn) « Bruit masqué ({count}) » listant constant/compteur/checksum/aleatoire. Si pas de `heatmapResult`, message « Lance l'analyse heatmap d'abord » + bouton qui déclenche le calcul heatmap existant. Clic sur une ligne → bascule onglet heatmap + met en surbrillance l'ID (ou copie l'ID si trop complexe). Onglets heatmap/autodetect/dependencies **conservés**.
- [ ] `npm run build` vert + `tsc` 0. Commit `feat(analyse): onglet Candidats (tri cardinalite, etats en tete, bruit replie)`.

---

## Self-Review

- Spec couverte : classification+score=T1 ; vue Candidats défaut + repli bruit=T2. ✅
- Non-régression : champs heatmap existants intacts, onglets existants gardés. ✅
- 0 route ajoutée → inventory inchangé. ✅
- Lecture seule, AUD-06 non concerné. ✅
- 303 : B0 (3 val)→etat score 0.875, B3 (2 val)→etat 0.9375 en tête ; B1/B2→aleatoire repliés. ✅
- Dépendances : T1→T2 (type+champs). ✅
