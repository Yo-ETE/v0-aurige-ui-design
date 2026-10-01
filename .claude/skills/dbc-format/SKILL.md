---
name: dbc-format
description: "Référence du format DBC (CAN Database) pour AURIGE — syntaxe des lignes BO_/SG_, endianness, facteur/offset, et cohérence entre le parseur (dbc_parser.py), l'export DBC et l'overlay du sniffer. À utiliser pour éditer l'import/export DBC, débugger un décodage de signal, ou générer une définition DBC à partir de signaux détectés. Déclencheurs : 'format DBC', 'exporte en DBC', 'ce signal se décode mal', 'ajoute un message DBC'."
---

# Format DBC dans AURIGE

AURIGE importe des `.dbc` standard (`backend/dbc_parser.py`), les édite, les exporte,
et les superpose en temps réel sur le CAN Sniffer. Cette référence sert à garder les
trois usages cohérents.

## Syntaxe minimale d'un `.dbc`

```
BO_ <can_id_decimal> <MessageName>: <DLC> Vector__XXX
 SG_ <SignalName> : <start_bit>|<length>@<byte_order><sign> (<factor>,<offset>) [<min>|<max>] "<unit>" Vector__XXX
```

- `BO_` = message. **L'ID est en décimal** dans le fichier DBC (attention : AURIGE
  manipule les IDs en hex ailleurs — convertir à l'entrée/sortie, cf. `int(can_id, 16)`).
- `SG_` = signal, une ligne par signal, indentée d'un espace.
- `<byte_order>` : `1` = little-endian (Intel), `0` = big-endian (Motorola).
- `<sign>` : `+` = non signé, `-` = signé.
- `<factor>`/`<offset>` : `valeur_physique = raw * factor + offset`.
- `[min|max]` et `"unit"` sont informatifs (affichage/validation).

Exemple (généré par AURIGE) :
```
BO_ 292 ENGINE_DATA: 8 Vector__XXX
 SG_ RPM : 24|16@1+ (0.25,0) [0|16383.75] "tr/min" Vector__XXX
```

## Points de cohérence à vérifier

- **Décodage** : `raw * factor + offset`. Un signal qui s'affiche faux = quasi
  toujours une erreur de `start_bit`, de `length`, ou d'endianness (`@0` vs `@1`).
- **start_bit** : convention de numérotation des bits — vérifier qu'import, export et
  overlay sniffer utilisent la même. Les lignes génératrices sont dans `main.py`
  (recherche `BO_ ` / `SG_ `) et le parsing dans `dbc_parser.py`.
- **Auto-detect → DBC** : les signaux détectés (`/api/analysis/auto-detect-signals`)
  peuvent être sauvegardés en DBC. Vérifier que position (byte/bit), taille et ordre
  sont bien traduits en `start_bit|length@order`.
- L'overlay temps réel décode les trames live du sniffer via la définition DBC de la
  mission (`/api/missions/{id}/dbc/active`) — tester le rendu après tout changement de format.

## Procédure de test
1. Importer un DBC simple, l'exporter, comparer : l'aller-retour doit être stable.
2. Appliquer l'overlay sur un log rejoué (`replay`) et vérifier une valeur connue
   (ex. régime au ralenti ≈ 800 tr/min).
