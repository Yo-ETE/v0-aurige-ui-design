# AURIGE — Durcissement de la mise à jour (Lot 3, sous-ensemble sûr)

> Design 2026-10-02. Troisième lot « administration comme Theia ». **Sous-ensemble
> sûr** : ne touche PAS le happy-path de `/api/system/update` (le chemin de
> déploiement, non testable hors Pi). Branche `audit-remediation`.

## 1. Périmètre (validé)

Quatre corrections ciblées, sans modifier le mécanisme de MAJ (toujours
`rm -rf repo` + `git clone` + `install_pi.sh`) :

1. **Validation de la branche** dans `POST /api/system/update`. Aujourd'hui
   `body["branch"]` (ligne ~5032) part directement dans `git checkout -B <branch>
   origin/<branch>` (forme liste — pas d'injection shell classique) puis est écrite
   dans `branch.txt`. Risque restant : ref/argument-injection (une branche commençant
   par `-`, contenant `..`, des espaces, `;`, `$`, des métacaractères). Corriger :
   valider avec `valid_git_ref()` **avant** tout usage ; rejeter `400` sinon.
2. **Supprimer le doublon** `POST /api/system/restart-services` (défini deux fois :
   ligne 5224 = vivante, restart web+api ; ligne 6680 = morte, FastAPI ne la voit
   jamais). Retirer la définition morte (6680).
3. **Fix bug lifespan** : ligne 96 `proc.wait(timeout=2.0)` sur un
   `asyncio.subprocess.Process` lève `TypeError` (asyncio `wait()` n'accepte pas
   `timeout`) → tous les process CAN sont `kill()` sans grâce. Remplacer par
   `await asyncio.wait_for(proc.wait(), timeout=2.0)` (le pattern correct existe déjà
   ligne 1131).
4. **Branche par défaut** `v0/yo-ete-5c91d9cb` → `main` (fallback uniquement ;
   `branch.txt` reste prioritaire). Occurrences backend (`~5026, 4759, 4781, 5044`) +
   `scripts/update_pi.sh:20`.

Hors périmètre (reporté après un déploiement réussi) : réécriture in-place du flux de
MAJ, backup pré-update, rollback automatique.

## 2. Architecture

### Nouveau `backend/validators.py`

```python
def valid_git_ref(ref: str) -> bool:
    # ref git sûre : lettres/chiffres/._-/ et slashs internes ; pas de début '-',
    # pas de '..', pas d'espace ni de métacaractère shell ; longueur bornée.
```
Règle : `isinstance(ref, str)`, `1 <= len(ref) <= 200`, match
`^[A-Za-z0-9][A-Za-z0-9._/-]*$` (donc pas de `-` en tête → bloque l'arg-injection
git), et `".." not in ref` et `"//" not in ref`. Module testable isolément ; pourra
accueillir d'autres validateurs plus tard (AURIGE n'a pas de `security.py`).

### Modifs `backend/main.py`

- Import `from validators import valid_git_ref` (flat).
- Dans `POST /api/system/update`, au tout début du handler : si `body` contient
  `branch` et `not valid_git_ref(body["branch"])` → `HTTPException(400, "Branche
  invalide")`, **avant** d'écrire `branch.txt` ou de lancer la tâche. Le reste du flux
  inchangé.
- Supprimer la 2ᵉ définition de `/api/system/restart-services` (ligne ~6680) et son
  corps mort.
- Ligne 96 : `proc.wait(timeout=2.0)` → `await asyncio.wait_for(proc.wait(),
  timeout=2.0)` (vérifier que la fonction englobante est `async` ; le lifespan l'est).
- Remplacer les littéraux `"v0/yo-ete-5c91d9cb"` par `"main"` (fallbacks de
  branche uniquement).

### Modif `scripts/update_pi.sh`

- Ligne 20 : `TARGET_BRANCH="v0/yo-ete-5c91d9cb"` → `TARGET_BRANCH="main"`.

## 3. Sécurité

- `valid_git_ref` ferme l'argument/ref-injection sur la seule entrée utilisateur du
  flux de MAJ (le nom de branche). Les commandes restent en forme liste (pas de
  `shell=True`).
- Aucune nouvelle route, aucun nouveau chemin d'injection CAN. Le happy-path de MAJ
  est inchangé (donc le déploiement que l'utilisateur va lancer n'est pas déstabilisé).

## 4. Tests & vérification

`backend/tests/test_validators.py` (pytest) :
- `valid_git_ref` : accepte `main`, `audit-remediation`, `feature/x_1.2`,
  `v0/yo-ete-5c91d9cb` ; rejette `""`, `-x`, `a..b`, `a b`, `a;b`, `a$b`, `a//b`,
  `"x"*201`, non-str.

`backend/tests/test_update_guard.py` (TestClient + SessionAuthMiddleware, admin login) :
- `POST /api/system/update` avec `{"branch": "-rm"}` → 400, et **rien n'est écrit dans
  branch.txt / aucune tâche lancée** (mocker la tâche de fond / `update_output_store`).
- `POST /api/system/update` avec `{"branch": "main"}` → accepté (202/200 selon le
  contrat actuel ; mocker la tâche pour ne pas cloner).
- Un `GET`/assert qu'il n'existe **qu'une** route `/api/system/restart-services`
  (introspection `app.routes`).

Le fix `Process.wait` : vérifié par relecture + (si faisable) un test ciblé mockant un
process ; sinon noté comme vérifié par revue (le pattern correct est déjà employé
ligne 1131). Suite backend complète verte.

## 5. Inventaire

Nouveaux : `backend/validators.py`, `backend/tests/test_validators.py`,
`backend/tests/test_update_guard.py`.
Modifiés : `backend/main.py` (import + garde branche + suppression doublon + fix
Process.wait + défaut main), `scripts/update_pi.sh` (défaut main).
Inchangé : le happy-path de `/api/system/update`.
