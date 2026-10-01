---
name: decode-can-log
description: "Analyse un fichier de log candump d'AURIGE (missions) — statistiques par CAN ID, bytes variables et entropie. À utiliser quand on inspecte une capture CAN, cherche quels IDs/bytes bougent, compare l'activité d'un log, ou prépare une détection de signal. Déclencheurs : 'analyse ce log CAN', 'quels bytes changent', 'inspecte cette capture candump'."
---

# Analyse de log CAN (candump)

Skill pour inspecter rapidement une capture CAN d'AURIGE sans lancer le backend.

## Format des logs AURIGE

Les captures vivent sous `AURIGE_DATA_DIR/logs/<mission-id>/*.log`. Deux formats
candump possibles, tous deux gérés par le script :

- `candump -l`  → `(1739530247.123456) can0 123#DEADBEEF`
- `candump -ta` → `(1739530247.123456) can0 123 [8] DE AD BE EF 00 11 22 33`

Le timestamp est en secondes epoch (float). Les IDs de diagnostic OBD (`7DF`,
`7E0`–`7EF`) sont du trafic de requête/réponse, pas des signaux broadcast — les
écarter mentalement lors d'une recherche de signal.

## Procédure

1. Localiser le log (demander le chemin, ou lister `logs/<mission-id>/`).
2. Lancer l'analyseur embarqué :

   ```bash
   python3 .claude/skills/decode-can-log/scripts/analyze_log.py <fichier.log>
   # options : --id 244   (un seul ID)   --top 40   (nb d'IDs affichés)
   ```

3. Lire la sortie :
   - **cycle_ms** : période moyenne d'émission de l'ID (utile pour repérer les
     messages périodiques vs. événementiels).
   - **bytes_variables** : positions de byte qui changent au moins une fois → ce sont
     les porteurs de signaux candidats.
   - **entropie/byte** : 0 = constante, proche de 8 = très variable (souvent
     compteur, checksum ou bruit). Une entropie modérée sur un byte qui suit une
     action physique est le meilleur candidat de signal.

4. Croiser avec l'action métier : si l'utilisateur cherche un signal (volant, frein…),
   se concentrer sur les IDs dont un byte passe de stable à variable pendant l'action,
   puis suggérer de confirmer via le module Signal Finder (`/api/analysis/correlate-obd`)
   ou l'auto-detect (`/api/analysis/auto-detect-signals`).

## Notes
- Script en Python pur, sans dépendance (cohérent avec la contrainte projet).
- Ne modifie jamais le log source ; analyse en lecture seule.
