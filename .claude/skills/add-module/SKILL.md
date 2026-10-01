---
name: add-module
description: "Ajoute un module fonctionnel de bout en bout à AURIGE — route(s) FastAPI backend, fonction cliente typée dans lib/api.ts, page Next.js sous app/, et entrée de menu. À utiliser pour créer une nouvelle page/outil d'analyse CAN, un nouvel endpoint exposé à l'UI, ou câbler un flux WebSocket. Déclencheurs : 'ajoute un module', 'nouvelle page pour…', 'expose tel traitement dans l'interface'."
---

# Ajouter un module de bout en bout

Un « module » AURIGE = une page `app/<module>/page.tsx` adossée à une ou plusieurs
routes backend, le tout relié par le client `lib/api.ts`. Respecter les 4 couches
dans l'ordre pour éviter les incohérences.

## 1. Backend — `backend/main.py`
- Nommer la route `/api/<domaine>/<action>` selon les groupes existants (`can`,
  `capture`, `replay`, `missions`, `obd`, `analysis`, `system`, `network`).
- Entrées validées par un modèle Pydantic ; erreurs via `HTTPException`.
- Si la route lance un process (`candump`/`cansend`/`canplayer`/`cangen`), prévoir
  son arrêt et son nettoyage, et gérer `CancelledError`.
- Vérifier l'absence de doublon de chemin avant d'ajouter.
- **Ne jamais contourner les garde-fous** : filtrage des IDs critiques (fuzzing),
  exclusion `7DF`/`7E0`–`7EF` (OBD).

## 2. Client API — `lib/api.ts`
- Ajouter une fonction typée qui appelle la route via l'helper d'URL de base
  (`getApiBaseUrl` / `getWsBaseUrl`), jamais un `fetch` en dur vers un host.
- Déclarer/réutiliser les types partagés (`CANMessage`, `DBCSignal`, `OBDSample`,
  `CorrelationCandidate`, `LogEntry`…). C'est le point d'entrée unique de tout appel.

## 3. Page — `app/<module>/page.tsx`
- `"use client"` en tête. Enveloppe `AppShell`. Composants shadcn de `components/ui/`.
- Passer par les fonctions de `lib/api.ts` ; état partagé via un store Zustand si la
  donnée doit survivre à la navigation (voir `sniffer-store`).
- **Hydratation** : aucun rendu dépendant de `Date`/`window`/`random`/`localStorage`
  au premier rendu SSR — différer après montage (`useEffect` + flag `mounted`).
  C'est le bug récurrent du projet.
- Responsive desktop + mobile. Libellés UI en français.

## 4. Navigation — `components/sidebar.tsx`
- Ajouter l'entrée de menu dans la bonne section (ACCUEIL / ANALYSE / CONFIGURATION /
  CAPTURE & ANALYSE / DIAGNOSTIC / TESTS AVANCÉS / DBC), avec une icône lucide-react.

## 5. Documentation
- Mettre à jour le tableau des pages et la section API Reference du `README.md`.

## Vérification
Rappel : `next.config.mjs` ignore les erreurs TypeScript au build → relire les types
soi-même. Tester le flux complet sur `vcan0` avant de committer.
