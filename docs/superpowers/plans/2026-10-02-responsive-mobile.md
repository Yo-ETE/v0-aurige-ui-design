# Responsive Mobile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make AURIGE usable on a ~390px phone — no horizontal scroll, no card/content overflow, long tokens wrap — without redesigning (keep the dark/blue identity).

**Architecture:** Fix shared layout primitives first (cascade to most pages), then sweep grids to mobile-first bases, polish the admin panels, clamp the floating terminal, fix page stragglers, and collapse the redundant Administration menu entries.

**Tech Stack:** Next.js 16 / React 19 / Tailwind CSS v4 / shadcn-ui. No frontend unit tests — verify by `npm run build` + `npx tsc --noEmit` + the user's mobile check.

**Spec:** `docs/superpowers/specs/2026-10-02-responsive-mobile-design.md`

## Global Constraints

- NO redesign: do not change palette, typography, spacing scale, or component structure beyond responsive utility classes. Only add/adjust Tailwind responsive utilities (base + breakpoint) and minimal layout wrappers.
- Mobile-first: every grid/flex gets a sensible mobile base; PRESERVE the existing desktop breakpoints (`lg:`/`md:`/`sm:`) so desktop is unchanged.
- No backend, no routes, no business logic touched.
- Comments/UI French, code English.

## File Structure

Shared: `components/ui/card.tsx`, `components/app-shell.tsx`, `app/globals.css`, `app/layout.tsx`, `components/floating-terminal.tsx`, `components/sidebar.tsx`. Sweeps across `app/**/page.tsx` + `components/admin/*` + `components/dashboard/*`.

---

### Task 1: Shared primitives (cascade)

**Files:** `components/ui/card.tsx`, `components/app-shell.tsx`, `app/globals.css`, `app/layout.tsx`.

- [ ] **Step 1: card.tsx** — add `min-w-0` to the root `Card` className (so it can shrink inside grids/flex). Change `CardHeader`/`CardContent`/`CardFooter` horizontal padding `px-6` → `px-4 sm:px-6`. Keep everything else.
- [ ] **Step 2: app-shell.tsx** — on the `<main>` (line ~17) and the content wrapper (line ~26) add `min-w-0 max-w-full overflow-x-hidden`. Keep `lg:ml-64` and existing padding. Reduce the terminal gutter on mobile: `pb-96` → `pb-40 lg:pb-96` (so mobile doesn't waste a huge bottom gap).
- [ ] **Step 3: globals.css** — in `@layer base`, add `html, body { overflow-x: clip; }`. Scope the touch-target rule: change `@media (max-width:640px){ .btn, button { min-height:44px } }` to target only an opt-in class (e.g. `.touch-44`) OR remove it entirely (Button sizes come from the component). Do NOT leave a bare `button{min-height:44px}` under 640px.
- [ ] **Step 4: layout.tsx** — in the `viewport` export, remove `maximumScale: 1` and `userScalable: false` (restore pinch-zoom). Keep `width: "device-width", initialScale: 1`.
- [ ] **Step 5: Verify + commit** — `npm run build` ok; `npx tsc --noEmit` no new errors. Commit `fix(ui): responsive shell/card primitives + restore pinch-zoom`.

---

### Task 2: Grid mobile-first base sweep

**Files:** the pages/components listed below.

- [ ] **Step 1: Add a `grid-cols-1` (or `grid-cols-2` where a 2-up of short values is fine) base to every grid that has a `(sm|md|lg):grid-cols-N` without a base, and to bare `grid-cols-N` (N≥2).** Transform `grid gap-N lg:grid-cols-X` → `grid grid-cols-1 gap-N lg:grid-cols-X`. Exact lines from the audit:
  - `grid-cols-1` base: `app/page.tsx:14`, `app/controle-can/page.tsx:293`, `app/capture-replay/page.tsx:278`, `app/generateur/page.tsx:143`, `app/obd-ii/page.tsx:448`, `app/isolation/page.tsx:955`, `app/fuzzing/page.tsx:399`, `components/admin/system-panel.tsx:363`, `components/admin/network-panel.tsx:323`.
  - sub-grids `sm:grid-cols-2` w/o base: `app/controle-can/page.tsx:179`, `app/fuzzing/page.tsx:416,469,510,549`, `app/comparaison/page.tsx:737,830,1014`, `app/missions/[id]/page.tsx:351,399`, `components/dashboard/mission-wizard.tsx:244,271,323`, `components/dashboard/raspberry-pi-status.tsx:311`, `app/obd-ii/page.tsx:862`.
  - bare `grid-cols-2` → `grid-cols-1 sm:grid-cols-2` (long values) or add `min-w-0`+`break-all` on cells if 2-up of short values is intended: `app/obd-ii/page.tsx:576`, `app/signal-finder/page.tsx:402`, `app/generateur/page.tsx:338`, `app/dbc/page.tsx:891,945`, `components/admin/user-management.tsx:93`, `components/admin/permission-editor.tsx:23`.
  - bare `grid-cols-3/4` → `grid-cols-2 sm:grid-cols-N`: `app/analyse-can/page.tsx:173,1752`, `app/controle-can/page.tsx:246`, `app/crash-recovery/page.tsx:215`, `app/fuzzing/page.tsx:669`, `app/dbc/page.tsx:911`.
  Do NOT touch grids that already have a base (e.g. `replay-rapide:174`, `analyse-can:1424/1610/1691`).
- [ ] **Step 2: Verify + commit** — `npm run build` ok; `npx tsc --noEmit` no new errors (CSS classes don't affect tsc, but confirm nothing broke). Read the diff: every changed grid now has a base and keeps its original breakpoint. Commit `fix(ui): mobile-first grid bases across pages and panels`.

---

### Task 3: Admin panels responsive polish (user's visible pain)

**Files:** `components/admin/network-panel.tsx`, `components/admin/system-panel.tsx`, `components/admin/user-management.tsx`, `components/admin/permission-editor.tsx`.

- [ ] **Step 1: Flex header rows** — for each `flex items-center justify-between` card header / row, add `min-w-0` to the left text block and `truncate`/`break-words` to the title/description, and `shrink-0` to the right-side controls. Lines: network-panel `:327,393,550,788,917`; system-panel `:418,455,722,796` (adapt to the real structure).
- [ ] **Step 2: Mono value cells** — the status/stat blocks holding SSID/IP/MagicDNS/interface/commit/branch/backup names: add `min-w-0` on the cell and `break-all` (or `truncate` + a `title={value}`) on the mono value span. Lines: network-panel `:367,459,594,604,938`; system-panel `:436`. The "Statut/Clients/SSID/Interface" grid (network-panel `:938`): make long-value cells `min-w-0 break-all`; keep the grid 2-up but let values wrap.
- [ ] **Step 3: Verify + commit** — `npm run build` ok; manual-read the diff confirms no value can overflow its cell. Commit `fix(ui): admin panels wrap long tokens, flex rows shrink correctly`.

---

### Task 4: Floating terminal mobile clamp

**Files:** `components/floating-terminal.tsx`.

- [ ] **Step 1** — In the fixed-position style (lines ~377-378), set width to `min(${size.w}px, calc(100vw - 16px))` so it never exceeds the viewport (works at SSR/first paint, not just after the mount effect). For expanded mode, make `left` responsive: `8px` on small screens instead of the hard-coded `288px` (use a `calc`/CSS or an `isMobile` check; prefer a CSS `left: max(8px, ...)` that collapses on narrow viewports). Clamp the dragged `position` so the window can't leave the viewport (clamp left/top to `[0, innerWidth-width]`/`[0, innerHeight-height]`), and re-clamp on `window` `resize`.
- [ ] **Step 2: Verify + commit** — `npm run build` ok; `npx tsc --noEmit` no new errors. Commit `fix(ui): clamp floating terminal to viewport on mobile`.

---

### Task 5: Page stragglers

**Files:** `app/analyse-can/page.tsx`, `app/isolation/page.tsx`, `app/signal-finder/page.tsx`, `app/controle-can/page.tsx`, `app/capture-replay/page.tsx`.

- [ ] **Step 1**:
  - analyse-can: `:1119` and `:1306` `overflow-x-hidden` → `overflow-x-auto`; the heatmap header with fixed 52px columns (`:957`) — wrap the heatmap block in `overflow-x-auto` so it scrolls instead of overflowing the page.
  - isolation `:2255`: the `flex gap-4` row with `w-80 shrink-0` + `flex-1` → `flex flex-col sm:flex-row gap-4`, and the side panel `w-80` → `w-full sm:w-80`.
  - signal-finder `:296` and controle-can `:402`: raw `<table>` with no wrapper → wrap each in `<div className="overflow-x-auto">`.
  - capture-replay `:313,391`: flex rows with `whitespace-nowrap` labels → add `flex-wrap` so they wrap on mobile.
- [ ] **Step 2: Verify + commit** — `npm run build` ok. Commit `fix(ui): responsive stragglers (tables, heatmap, isolation panel)`.

---

### Task 6: Collapse Administration menu to one entry

**Files:** `components/sidebar.tsx`.

- [ ] **Step 1** — In the Administration section, replace the two entries ("Comptes" → `?tab=comptes`, "Configuration Pi" → `?tab=systeme`) with a SINGLE entry "Administration" → `/administration`, gated by `hasArea("area_administration") || hasArea("area_configuration")` (so operators keep access; the tabbed page shows whichever tabs they're allowed). Its icon: keep `Users` or a settings/shield icon. Update the active-highlight so this single entry highlights when `pathname === "/administration"` (drop the per-tab query-string highlight logic added earlier, now unneeded).
- [ ] **Step 2: Verify + commit** — `npm run build` ok; `npx tsc --noEmit` no new errors. Read the diff: one Administration entry, correct gating, highlights on /administration. Commit `fix(admin): collapse Administration menu to a single entry`.

---

## Self-Review

**Spec coverage:** §2.1-2.5 shared → Task 1 (card/shell/globals/layout) + Task 2 (grids); §2.6-2.7 flex rows + mono → Task 3; §2.8 terminal → Task 4; §3 stragglers → Task 5; §4 menu → Task 6. All covered.

**Placeholder scan:** every change names exact files + lines + the Tailwind transform. The floating-terminal `left`/clamp (Task 4) describes the concrete approach (min() width, responsive left, clamp on resize) — the implementer reads the current style object and applies it.

**Consistency:** grid base additions keep original breakpoints (desktop unchanged); the menu collapse (Task 6) supersedes the per-tab sidebar highlight from the Lot-2 work (noted so the implementer removes the now-dead query-string highlight). No file is edited by two tasks in conflicting ways (Task 2 touches grid classes; Task 3 touches flex/mono in the same admin panels — sequence Task 2 then Task 3, and Task 3 only edits flex rows / value spans, not the grid wrappers Task 2 changed).

**Risk:** no visual tests; the user verifies on mobile. Changes are additive responsive utilities (low desktop-regression risk). The reviewer must confirm each change is mobile-first AND preserves the desktop breakpoint, and that `overflow-x: clip` / `overflow-x-hidden` is a safety net layered AFTER the real fixes (not masking clipped content).
