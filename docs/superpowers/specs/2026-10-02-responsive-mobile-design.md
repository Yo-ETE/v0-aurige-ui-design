# AURIGE — Responsive mobile (tout le site)

> Design 2026-10-02. Rendre l'app utilisable sur mobile (~390px) sans scroll
> horizontal ni débordement. **Pas de redesign** : on conserve l'identité (thème
> sombre, accent bleu, « Mastery of CAN ») ; on corrige uniquement la mise en page.
> Branche `audit-remediation`.

## 1. Problème

Sur téléphone, les cartes débordent, le texte est coupé (« INTERNE », « Mode »), tout
le site a un scroll horizontal. Cause racine (audit) : des **patterns partagés**, pas
des bugs page par page. Les corriger à la racine règle la majorité des pages.

## 2. Corrections partagées (cascade — priorité)

1. **Base `grid-cols-1` sur toutes les grilles.** Les `grid ... (sm|md|lg):grid-cols-N`
   sans base n'ont pas de `grid-template-columns` sous le breakpoint → track implicite
   `auto` qui grossit au min-content → débordement. Ajouter la base
   (`grid-cols-1` donne `minmax(0,1fr)` qui borne le track) : `grid gap-N lg:grid-cols-2`
   → `grid grid-cols-1 gap-N lg:grid-cols-2`. Idem pour `sm:`/`md:` sans base. ~25 lignes
   (pages modules + `components/admin/{system,network}-panel.tsx`).
2. **`components/ui/card.tsx`** : ajouter `min-w-0` à `Card` (peut rétrécir dans
   une grille/flex). Réduire le padding mobile : `CardHeader`/`CardContent` `px-4 sm:px-6`.
3. **`components/app-shell.tsx`** : `<main>` et le wrapper contenu →
   `min-w-0 max-w-full overflow-x-hidden`. `app/globals.css` `@layer base` :
   `html, body { overflow-x: clip; }` (filet de sécurité, après 1–2).
4. **`app/layout.tsx`** : retirer `maximumScale: 1` et `userScalable: false` (bloquent
   le pinch-zoom = a11y + empêchent de dézoomer une page qui déborde).
5. **`app/globals.css`** : la règle `@media (max-width:640px) { .btn, button { min-height:
   44px } }` gonfle TOUS les boutons (toolbar sniffer `h-6`, onglets, sidebar). La
   **scoper** (ex `.touch-target`) ou la retirer ; tailles via le composant Button.
6. **Lignes flex d'en-tête** (`flex items-center justify-between`, ~57 occurrences) :
   bloc texte `min-w-0` + titre/desc `truncate`/`break-words` ; contrôles `shrink-0`.
   Prioriser les panels admin (network/system).
7. **Valeurs mono longues** (SSID, IP, MagicDNS, clés tailscale, commit/branche,
   backups) : `break-all` (ou `truncate` + `title`) + `min-w-0` sur la cellule. Panels
   admin d'abord (network-panel `:367,459,594,938` ; system-panel `:436`).
8. **`components/floating-terminal.tsx`** : largeur `min(${size.w}px, calc(100vw -
   16px))` ; `left` du mode étendu = 8px sur mobile (pas 288px) ; clamp position/size
   au `resize`. Réduire le `pb-96` d'AppShell côté mobile si possible.

## 3. Stragglers (page par page)

- `app/analyse-can/page.tsx` : heatmap header largeurs fixes 52px (`:957`) →
  `overflow-x-auto` ; `:1119`/`:1306` `overflow-x-hidden` → `overflow-x-auto` ;
  byte-detail 4-col 10px (`:173`) → `grid-cols-2 sm:grid-cols-4`.
- `app/isolation/page.tsx:2255` : `w-80 shrink-0` à côté de `flex-1` →
  `flex-col sm:flex-row` + `w-full sm:w-80`.
- Tables brutes sans wrapper `overflow-x-auto` : `app/signal-finder/page.tsx:296`,
  `app/controle-can/page.tsx:402` → envelopper `<div className="overflow-x-auto">`.
- `grid-cols-3/4` nus (analyse-can `:173,1752` ; controle-can `:246` ; crash-recovery
  `:215` ; fuzzing `:669` ; dbc `:911`) → `grid-cols-2 sm:grid-cols-N`.
- `grid-cols-2` nus avec valeurs longues (obd-ii `:576` ; signal-finder `:402` ;
  generateur `:338` ; dbc `:891,945` ; user-management `:93` ; permission-editor `:23`)
  → `grid-cols-1 sm:grid-cols-2` ou `min-w-0`+`break-all`.
- `app/capture-replay/page.tsx:313,391` labels `whitespace-nowrap` en flex → `flex-wrap`.

## 4. Menu (demandé par l'utilisateur)

`components/sidebar.tsx` : section Administration a 2 entrées (« Comptes » +
« Configuration Pi ») **redondantes** avec les 3 onglets de `/administration`.
**Collapser en une seule entrée « Administration »** → `/administration` (gate
`area_administration || area_configuration` ; ouvre l'onglet visible par défaut). Retirer
les 2 sous-entrées et leur highlight query-string.

## 5. Sécurité / périmètre

Pur frontend (CSS/Tailwind + layout). Aucune route, aucune logique métier, aucun
chemin d'injection. Aucun changement de palette/typo (pas de redesign).

## 6. Tests & vérification

Pas d'infra test front. Par tâche : `npm run build` + `npx tsc --noEmit` (pas de
nouvelle erreur). Vérif visuelle = l'utilisateur sur mobile (~390px) après déploiement :
- Aucun scroll horizontal sur aucune page.
- Cartes/valeurs ne débordent pas ; texte long wrap/truncate.
- Grilles passent en 1 colonne sur mobile, 2+ sur desktop.
- Terminal flottant tient dans l'écran.
- Menu : une entrée Administration.
Un reviewer vérifie que chaque changement Tailwind est mobile-first (base présente) et
**ne régresse pas le desktop** (les breakpoints `lg:` d'origine conservés).

## 7. Inventaire

Partagés : `components/ui/card.tsx`, `components/app-shell.tsx`, `app/globals.css`,
`app/layout.tsx`, `components/floating-terminal.tsx`, `components/sidebar.tsx`.
Grilles + flex rows + mono : panels admin + pages modules (sweep).
Stragglers : analyse-can, isolation, signal-finder, controle-can, capture-replay,
obd-ii, generateur, dbc, crash-recovery, fuzzing.
