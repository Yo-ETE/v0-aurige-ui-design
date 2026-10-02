# AURIGE — Console d'administration à onglets (Lot 2)

> Design 2026-10-02. Deuxième des trois lots « administration comme Theia »
> (Lot 1 Hotspot ✅ → **Lot 2 Console à onglets** → Lot 3 Hardening update).
> Branche `audit-remediation`.

## 1. Objectif

Theia a **une seule console** d'administration. AURIGE est éclaté : `/administration`
(comptes, admin-only) + `/configuration` (système + réseau, 2372 lignes, gated
`area_configuration`). On consolide en **une console à onglets** sous `/administration` :
**Comptes · Système · Réseau**, chaque onglet gaté par permission. `/configuration`
redirige.

Contrainte forte : extraction **sans régression** d'un monolithe à état, **sans tests
front**. Le flux de mise à jour (`POST /api/system/update` + polling + auto-restart),
dont l'utilisateur se sert pour déployer, ne doit rien perdre.

## 2. Décisions

- **3 onglets** (shadcn/Radix Tabs) : Comptes, Système, Réseau. Licence + Guide
  d'utilisation : repliables en bas de l'onglet **Système** (pas de 4ᵉ onglet).
- **Gating par onglet** (UX ; le backend reste l'autorité) :
  - Comptes : visible si `isAdmin` (`area_administration`).
  - Système : visible si `hasArea("area_configuration")` ou admin.
  - Réseau : visible si `hasArea("area_configuration")` ou admin.
  - La page `/administration` redirige vers `/` seulement si **aucun** onglet n'est
    visible (ni admin ni `area_configuration`). Onglet par défaut = premier visible.
  - Support `?tab=comptes|systeme|reseau` pour les liens profonds.
- **`forceMount` sur les trois `TabsContent`** : tous montés en permanence (cachés par
  Radix quand inactifs). Préserve les pollers apt (1 s) et update (1,5 s) et le
  flux auto-restart/reload même si on change d'onglet pendant une MAJ. Équivaut au
  comportement mono-page actuel (tout monté d'un coup).
- `/configuration` → **redirige** vers `/administration?tab=systeme` (préserve les
  marque-pages et le point d'entrée du déploiement).
- **Extraction verbatim** : state, handlers, effets, helpers déplacés tels quels (pas
  de refonte de logique), pour ne pas changer le timing du poller d'update.

## 3. Architecture

### Nouveaux composants

- `components/admin/network-panel.tsx` — cartes État connexion, Tailscale, Réseaux
  disponibles, Hotspot. State wifi/`ts*`/`hs*`. Helpers `getSignalIcon`, `formatBytes`,
  `getPeerOsIcon`. Effet de montage : `fetchConnectionStatus`, `handleScan`,
  `fetchTailscale`, `fetchHotspotStatus`, `fetchHotspotCredentials`.
- `components/admin/system-panel.tsx` — cartes Mises à jour système (apt), Mise à jour
  Aurige, Sauvegardes, Alimentation, + Licence & Guide repliables. State apt/update/
  branches/backups/power. **Effets** : poller apt (1000 ms), poller update (1500 ms,
  deps `[updateOutput.running]`, logique auto-restart/reload **déplacée mot pour mot**),
  effet de montage `fetchVersionInfo` + `fetchBranches` + `fetchBackups`.
- `app/administration/page.tsx` — **réécrit** : garde `useAuth`, calcule les onglets
  visibles par permission, redirige si aucun, rend `<AppShell title="Administration">`
  + `<Tabs>` avec les trois `TabsContent` en `forceMount`. Lit `?tab=` initial.

### Modifiés

- `app/configuration/page.tsx` — **remplacé par une redirection** vers
  `/administration?tab=systeme` (`redirect()` serveur ou `useEffect`+`router.replace`
  client). Tout son contenu part dans les deux panels.
- `components/sidebar.tsx` — section Administration : « Comptes » →
  `/administration?tab=comptes` (area_administration) ; « Configuration Pi » →
  `/administration?tab=systeme` (area_configuration). (Deux entrées, même page, onglets
  différents — l'operator garde l'accès Système/Réseau.)
- `components/admin/user-management.tsx` — inchangé (devient le contenu de l'onglet
  Comptes).

### Découpage état (d'après la carto, zéro état partagé)

Network : `wifiStatus, ethernetStatus, networks, isScanning, selectedNetwork,
wifiPassword, showPassword, savedNetworks, isConnecting, wifiError, wifiSuccess,
tsStatus, tsLoading, tsAction, tsMessage, hsStatus, hsCreds, hsNewPassword, hsBusy,
hsMessage`.
System : `aptOutput, isRebooting, isShuttingDown, systemMessage, versionInfo,
updateOutput, isCheckingVersion, gitBranches, selectedBranch, isFetchingBranches,
backups, isCreatingBackup, backupMessage, needsRestart, isRestarting, showLicence,
showGuide, guideSection`.

## 4. Risques (de la carto) et parades

1. **Poller update orphelin** → `forceMount` du panel Système (toujours monté).
2. **Timing du poller update** → déplacer l'effet `[updateOutput.running]` **verbatim**
   (errorCount/reloadScheduled restent dans la closure).
3. **Effet de montage à scinder** : les 8 appels initiaux vont **chacun dans
   exactement un** panel (5 Network, 3 System). Un reviewer vérifie qu'aucun n'est
   perdu ni dupliqué.
4. **`fetchBranches` dep `[selectedBranch]`** : aujourd'hui un changement de branche
   relance tous les fetch (dont un scan wifi). Après split, ne relance que les fetch
   System — amélioration bénigne assumée.
5. **Double montage** : ne monter les panels **que** dans `/administration`.
   `/configuration` ne rend plus que la redirection (pas les panels) → une seule
   source du poller.
6. **Layout** : chaque panel enveloppe ses cartes dans
   `<div className="grid gap-6 lg:grid-cols-2">` ; conserver les `lg:col-span-2`.
   `/administration` élargi (plus `max-w-3xl` ; pleine largeur comme `/configuration`
   sous AppShell).
7. **Scan wifi au montage** : `handleScan` tourne au montage du NetworkPanel ; avec
   `forceMount` il tourne au chargement de la page (comme avant). Accepté.
8. **Handler perdu** : vérifier par grep `onClick`/`handle*` que chaque carte extraite
   garde tous ses handlers.

## 5. Sécurité

- Gating par onglet = **UX seulement**. Le backend reste l'autorité : user CRUD exige
  rôle admin (middleware + handler), `system_*`/`network`/`hotspot` exigent leurs flags.
  Un operator voyant l'onglet Système ne peut toujours pas reboot sans `system_reboot`.
- Aucune nouvelle route, aucun nouveau chemin d'injection. Pur frontend + redirection.
- La page `/administration` reste protégée par `AuthGate` (authentifié) ; le gating
  par onglet s'ajoute au 403 backend.

## 6. Tests & vérification

Pas d'infra de test front (comme Lots précédents). Vérification = `npm run build` +
`npx tsc --noEmit` (pas de nouvelle erreur dans les fichiers touchés) + **checklist
manuelle** sur le Pi après déploiement :
- Admin : les 3 onglets visibles ; Comptes = gestion comptes ; Système = version/update/
  apt/backups/power + licence/guide ; Réseau = wifi/tailscale/hotspot/ethernet.
- Operator (area_configuration, pas admin) : onglets Système + Réseau visibles, Comptes
  masqué ; peut injecter/configurer selon ses flags ; actions system interdites → 403.
- Viewer : `/administration` redirige vers `/`.
- **Flux MAJ** : lancer une update depuis l'onglet Système, changer d'onglet pendant,
  revenir → l'output continue, l'auto-restart/reload se déclenche (poller non orphelin).
- `/configuration` redirige vers `/administration?tab=systeme`.
- Liens sidebar « Comptes » / « Configuration Pi » ouvrent le bon onglet.

Un reviewer dédié compare, carte par carte, que chaque handler / appel endpoint /
poller de l'ancienne page existe dans exactement un panel (section 4.3/4.8).

## 7. Inventaire

Nouveaux : `components/admin/network-panel.tsx`, `components/admin/system-panel.tsx`.
Réécrits : `app/administration/page.tsx` (shell à onglets), `app/configuration/page.tsx`
(redirection). Modifiés : `components/sidebar.tsx` (liens onglets).
Inchangés : `components/admin/user-management.tsx`, `components/admin/permission-editor.tsx`,
`lib/api.ts` (toutes les fonctions existent déjà).

Hors de ce lot : hardening update (Lot 3).
