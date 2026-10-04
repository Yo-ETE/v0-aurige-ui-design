# Analyse CAN — Vue « Candidats » (cardinalité d'abord)

## Problème

Sur Analyse CAN, la heatmap et l'auto-détection sélectionnent les octets « actifs »
par **entropie** (`analysis.py:552`, `entropy >= min_entropy`). Haute entropie =
traitée comme plus intéressante. Or pour une **action humaine** (essuie-glace,
ventilation…), le signal est un octet à **faible cardinalité** (peu de valeurs
distinctes = positions/vitesses), et les octets à haute entropie sont souvent des
**compteurs / CRC / aléatoire-chiffré = bruit**.

Exemple réel (ID `303` = essuie-glace, log `capture_20260206_173815`, 20 trames) :
- `B0` : {0x55,0x95,0x56} = **3 valeurs** → état essuie-glace. change 0.105, entropie 1.22.
- `B3` : {0x14,0x34} = **2 valeurs** → 2e état. entropie 0.47.
- `B1`/`B2` : ~18 valeurs/20 trames, entropie 3.92, change 0.79 = **bruit** (non monotone,
  donc raté par `_detect_counter_bytes`) → surfacé à tort comme signal.

L'utilisateur veut **rapidement voir quoi chercher**. Le bon discriminateur = la
**cardinalité** (nb de valeurs distinctes), pas le change_rate/entropie.

## Décisions (validées)

- Cardinalité d'abord. Corrélation à l'instant de l'action = **plus tard** (hors scope).
- On **garde** les onglets existants (heatmap brute, auto-détection, dépendances) — pas de
  régression analyse fine. On **ajoute** une vue « Candidats », **par défaut**.

## Classification par octet

Pour chaque octet d'un ID (sur `frame_count` trames), classe :
- `constant` — `unique_count <= 1`. Non-candidat (jamais actionné dans ce log).
- `compteur` — détecté par `_detect_counter_bytes` (monotone). Bruit.
- `checksum` — détecté par `_detect_checksum_bytes`. Bruit.
- `aleatoire` — non compteur/checksum, `unique_count/frame_count >= 0.5` ET `entropie >= 3.0`.
  Bruit (compteur non-monotone / chiffré / CRC manqué).
- `etat` — `2 <= unique_count <= 16` ET `ratio < 0.5`. **CANDIDAT** (le signal d'action).
- `continu` — le reste (cardinalité moyenne, capteur lisse). Candidat faible.

**Score** (tri décroissant, plus haut = plus probablement l'action) :
- `etat` : `score = (17 - unique_count) / 16` → 2 valeurs = 0.9375, 16 valeurs = 0.0625.
- `continu` : `score = max(0.1, 0.4 - ratio*0.3)`.
- `constant`/`compteur`/`checksum`/`aleatoire` : `score = 0.0` (bruit, replié).

Garde-fou petit échantillon : si `frame_count < 8`, le `ratio` est peu fiable ; classer
alors par cardinalité absolue (`etat` si `2 <= unique_count <= 16`, sinon `continu`).

## Backend (réutilise, pas de nouvelle route)

`backend/main.py` : nouveau helper
`_classify_action_byte(byte_vals, frame_count, is_counter=False, is_checksum=False) -> (klass, distinct_values, score)`
où `distinct_values` = liste hex triée des valeurs distinctes, **cap 16** (`["55","95","56"]`).

`backend/routers/analysis.py`, endpoint `POST /api/analysis/byte-heatmap` : par ID, construire
`byte_series = {bi: byte_vals}` ; pré-scan `main._detect_counter_bytes(byte_series, dlc, 0.75)`
+ `main._detect_checksum_bytes(byte_series, dlc, 0.70)` ; puis pour chaque octet ajouter au dict
existant : `"klass"`, `"distinct_values"`, `"score"` (via `main._classify_action_byte`). Les champs
existants (`change_rate`, `entropy`, `min`, `max`, `unique_count`, `is_constant`) **inchangés**.
**Inventaire de routes inchangé** (0 route ajoutée).

## Frontend

`lib/api.ts` : étendre `HeatmapByteInfo` avec `klass: "constant"|"compteur"|"checksum"|"aleatoire"|"etat"|"continu"`,
`distinct_values: string[]`, `score: number`.

`app/analyse-can/page.tsx` : nouvel onglet **« Candidats »** (par défaut, `tab` initial). Construit depuis
`heatmapResult` une liste plate de tous les octets `klass in {etat, continu}` avec `score > 0`, triée par
`score` desc. Chaque ligne : `[CAN ID] · B{index} · badge classe · {N} valeurs · chips hex {55 95 56}` +
change/entropie en petit. Section repliée « Bruit masqué » (constant/compteur/checksum/aléatoire) avec
compte. Clic sur un ID → le pré-sélectionner/scroller dans l'onglet heatmap (bonus, sinon copier l'ID).
Les onglets existants (heatmap/autodetect/dependencies) restent.

## Tests

Backend : `_classify_action_byte` — constant (1 val), état (3 val faible ratio → klass etat, score>0.8),
aléatoire (18/20 val, entropie haute → aleatoire, score 0), cap distinct_values à 16 ; endpoint byte-heatmap
renvoie klass/distinct_values/score. Frontend : `tsc` 0, build vert, tri + repli bruit.

## Hors scope

Corrélation temporelle à l'instant de l'action ; refonte des onglets existants ; multi-log.
