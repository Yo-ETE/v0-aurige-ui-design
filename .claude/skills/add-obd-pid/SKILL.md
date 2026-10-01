---
name: add-obd-pid
description: "Ajoute un nouveau PID OBD-II à AURIGE — table de décodage backend et descriptions frontend du Signal Finder. À utiliser quand on veut supporter un paramètre moteur OBD supplémentaire (Mode 01), écrire ou vérifier une formule de décodage PID, ou étendre la liste des PID lisibles. Déclencheurs : 'ajoute le PID X', 'supporte tel paramètre OBD', 'décode ce PID'."
---

# Ajouter un PID OBD-II

AURIGE décode les PID OBD-II Mode 01 dans un seul endroit backend, puis les décrit
côté frontend. Suivre les deux étapes pour rester cohérent.

## 1. Backend — `backend/main.py`

Ajouter une entrée à `OBD_PID_DECODERS` (≈ ligne 6805). Format :

```python
"PID_HEX": ("Nom court", "unite", lambda a, b: <formule>),
```

- `a` = premier octet de données, `b` = deuxième octet (après l'en-tête de réponse).
- Formules standard OBD-II (SAE J1979), déjà utilisées dans le projet :
  - température : `lambda a, b: a - 40`  (unité `C`)
  - pourcentage : `lambda a, b: (a * 100) / 255`  (unité `%`)
  - régime : `lambda a, b: ((a * 256) + b) / 4`  (unité `tr/min`)
  - valeur 16 bits : `lambda a, b: (a * 256) + b`
- Respecter la convention : nom en anglais, unité courte, commentaire si formule non triviale.

Vérifier que le PID est bien un PID de **réponse** (`byte[1] == 0x41` pour Mode 01)
dans la boucle de lecture — la logique existante gère déjà ce cas, ne pas la dupliquer.

## 2. Frontend — `app/signal-finder/page.tsx`

Ajouter la description du PID dans la table `PID Descriptions` en tête de fichier
(vers le haut du composant) pour qu'il apparaisse dans le sélecteur, libellé en français.

## 3. Vérification
- Confiance dans la formule : comparer à une source J1979. Une erreur de facteur
  fausse silencieusement toute la corrélation OBD↔CAN en aval.
- Tester sans véhicule via `/api/signal-finder/extract-obd-from-log` sur un log
  contenant des réponses `7E8` pour ce PID, ou en mode live sur `vcan0`.

## Rappel
Ne pas toucher `OBD_FILTER_IDS` (`7DF`, `7E0`–`7EF`) : c'est le filtre qui exclut le
trafic de diagnostic du flux broadcast. L'ajout d'un PID n'y change rien.
