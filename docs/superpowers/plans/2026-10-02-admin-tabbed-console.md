# Admin Tabbed Console Implementation Plan (Lot 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Consolidate AURIGE admin into one tabbed console at `/administration` (Comptes · Système · Réseau), extracting `/configuration`'s content into two panels without regressing the update-from-UI flow; `/configuration` redirects.

**Architecture:** Behavior-preserving extraction of the 2372-line `app/configuration/page.tsx` monolith (no shared state per the structural map) into `components/admin/network-panel.tsx` and `components/admin/system-panel.tsx`, mounted as `forceMount` Radix tabs on a rewritten `/administration` with per-tab permission gating. `/configuration` becomes a redirect.

**Tech Stack:** Next.js 16 / React 19 / TypeScript / shadcn-ui (Tabs). No frontend unit tests — verify by `npm run build` + `npx tsc --noEmit` + manual checklist.

**Spec:** `docs/superpowers/specs/2026-10-02-admin-tabbed-console-design.md`

## Global Constraints

- Extraction is VERBATIM: move state/handlers/effects/JSX exactly as-is; do not refactor logic. The update poller effect (deps `[updateOutput.running]`, the auto-restart/reload at old L411-480) moves as one unit into SystemPanel.
- `forceMount` all three `TabsContent` so pollers never stop on tab switch.
- Every handler, endpoint call, and poller from the old page must exist in EXACTLY ONE panel (none dropped, none duplicated). Panels mounted only in `/administration`, never also in `/configuration`.
- Per-tab gating (UX; backend authoritative): Comptes→isAdmin; Système/Réseau→`hasArea("area_configuration") || isAdmin`. `/administration` redirects to `/` only if no tab is visible.
- Each panel wraps its cards in `<div className="grid gap-6 lg:grid-cols-2">`; preserve `lg:col-span-2` on the apt/update/power/licence/guide cards.
- FLAT nothing (frontend); imports use `@/` alias as the existing page does.
- Comments/UI French.

## File Structure

- Create: `components/admin/network-panel.tsx`, `components/admin/system-panel.tsx`.
- Rewrite: `app/administration/page.tsx` (tabbed shell), `app/configuration/page.tsx` (redirect).
- Modify: `components/sidebar.tsx` (tab-deep-link hrefs).

Source line ranges below are from the structural map of the current `app/configuration/page.tsx` (2372 lines).

---

### Task 1: Extract NetworkPanel

**Files:** Create `components/admin/network-panel.tsx`. Temporarily keep `app/configuration/page.tsx` working (it still renders everything until Task 3) — so this task COPIES the Network parts into the new component and does NOT yet remove them from the page. (Task 3 deletes the old page.)

- [ ] **Step 1: Create the component**

`"use client"` component `export function NetworkPanel()` containing, copied verbatim from `app/configuration/page.tsx`:
- State (map §1 Network): `wifiStatus, ethernetStatus, networks, isScanning, selectedNetwork, wifiPassword, showPassword, savedNetworks, isConnecting, wifiError, wifiSuccess, tsStatus, tsLoading, tsAction, tsMessage, hsStatus, hsCreds, hsNewPassword, hsBusy, hsMessage`.
- Handlers/helpers (map §2 Network): `fetchHotspotStatus, fetchHotspotCredentials, handleHotspotAction, handleHotspotPassword, hsPasswordValid, fetchConnectionStatus, fetchSavedNetworks, handleScan, handleConnect, fetchTailscale, handleTsUp, handleTsDown, handleTsLogout, handleTsExitNode, formatBytes, getPeerOsIcon, getSignalIcon`.
- A single mount effect: `useEffect(() => { fetchConnectionStatus(); handleScan(); fetchTailscale(); fetchHotspotStatus(); fetchHotspotCredentials(); }, [])`.
- JSX (map §3 Network cards): Etat connexion (L668-888), Tailscale (L891-1126), Réseaux disponibles (L1129-1255), Hotspot (L1258-1387) — wrapped in `<div className="grid gap-6 lg:grid-cols-2">`.
- Imports: the Network api.ts functions/types (map §5 Network) + only the lucide icons those cards use + the UI primitives (Card*, Button, Input, Label, Alert*, Badge, ScrollArea).

- [ ] **Step 2: Build + typecheck**

Run: `npm run build` (succeeds) and `npx tsc --noEmit` — no NEW errors referencing `components/admin/network-panel.tsx`. The component isn't mounted yet; this task only proves it compiles standalone. (It's fine that it's currently unused — Task 3 mounts it.)

- [ ] **Step 3: Commit**

```bash
git add components/admin/network-panel.tsx
git commit -m "refactor(admin): extract NetworkPanel from configuration page"
```

---

### Task 2: Extract SystemPanel

**Files:** Create `components/admin/system-panel.tsx`. Same approach — copy, don't yet delete from the page.

- [ ] **Step 1: Create the component**

`"use client"` component `export function SystemPanel()` containing, copied verbatim:
- State (map §1 System): `aptOutput, isRebooting, isShuttingDown, systemMessage, versionInfo, updateOutput, isCheckingVersion, gitBranches, selectedBranch, isFetchingBranches, backups, isCreatingBackup, backupMessage, needsRestart, isRestarting, showLicence, showGuide, guideSection`.
- Handlers (map §2 System): `handleAptUpdate, handleAptUpgrade, handleReboot, handleShutdown, fetchBranches, fetchVersionInfo, fetchBackups, handleStartUpdate, handleCreateBackup, handleDeleteBackup, handleRestoreBackup, handleRestartServices`.
- Effects, VERBATIM:
  - apt poller (old L301-321): `getAptOutput` every 1000 ms, deps `[]`.
  - update poller (old L411-480): every 1500 ms, deps `[updateOutput.running]`, including the success-marker → `setNeedsRestart` → 1 s → `restartServices()` → append line → 2 s → `window.location.reload()`, and the ≥3-network-error → reload-after-5 s logic. Move the whole closure unchanged.
  - mount effect: `useEffect(() => { fetchVersionInfo(); fetchBranches(); fetchBackups(); }, [fetchBranches])` — preserve the `fetchBranches`/`selectedBranch` dependency behavior (map risk 4) by keeping `fetchBranches` in deps exactly as the branch selector needs; if the original had `fetchBranches` memoized via useCallback with `[selectedBranch]`, keep that.
- JSX (map §3 System cards): Mises à jour système/apt (L1390-1438), Mise à jour Aurige (L1441-1596), Sauvegardes (L1599-1691), Alimentation (L1694-1742), then Licence (L1745-1816) and Guide (L1819-2355) as the trailing collapsibles — wrapped in `<div className="grid gap-6 lg:grid-cols-2">` with `lg:col-span-2` preserved on apt/update/power/licence/guide.
- Imports: System api.ts fns/types (map §5 System) + the lucide icons those cards use + UI primitives (Card*, Button, Input, Label, Alert*, ScrollArea, Badge).

- [ ] **Step 2: Build + typecheck** — `npm run build` ok; `npx tsc --noEmit` no new errors in `system-panel.tsx`.

- [ ] **Step 3: Commit**

```bash
git add components/admin/system-panel.tsx
git commit -m "refactor(admin): extract SystemPanel (apt+update pollers verbatim) from configuration page"
```

---

### Task 3: Tabbed /administration shell + /configuration redirect + sidebar

**Files:** Rewrite `app/administration/page.tsx`; rewrite `app/configuration/page.tsx`; modify `components/sidebar.tsx`. After this task the old monolith content is GONE (replaced by panels + redirect).

**Interfaces:** Consumes `useAuth` (`isAdmin`, `hasArea`), `UserManagement`, `NetworkPanel`, `SystemPanel`. shadcn Tabs at `@/components/ui/tabs` (verify it exists; if absent, `npx shadcn@latest add tabs` or build a minimal Radix tabs wrapper — check `components/ui/` first).

- [ ] **Step 1: Verify the Tabs primitive exists** — `ls components/ui/tabs.tsx`. If missing, add it (shadcn Tabs over @radix-ui/react-tabs; the repo already uses Radix). Report if you had to add it.

- [ ] **Step 2: Rewrite `app/administration/page.tsx`**

```tsx
"use client"
import { useEffect, useMemo, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { AppShell } from "@/components/app-shell"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAuth } from "@/lib/auth-context"
import { UserManagement } from "@/components/admin/user-management"
import { SystemPanel } from "@/components/admin/system-panel"
import { NetworkPanel } from "@/components/admin/network-panel"

export default function AdministrationPage() {
  const { isAdmin, hasArea, isLoading, user } = useAuth()
  const router = useRouter()
  const params = useSearchParams()

  const tabs = useMemo(() => {
    const t: { id: string; label: string }[] = []
    if (isAdmin) t.push({ id: "comptes", label: "Comptes" })
    if (isAdmin || hasArea("area_configuration")) {
      t.push({ id: "systeme", label: "Système" })
      t.push({ id: "reseau", label: "Réseau" })
    }
    return t
  }, [isAdmin, hasArea])

  const requested = params.get("tab")
  const [active, setActive] = useState<string>("")
  useEffect(() => {
    if (!tabs.length) return
    const want = tabs.find((t) => t.id === requested)?.id ?? tabs[0].id
    setActive(want)
  }, [tabs, requested])

  useEffect(() => {
    if (!isLoading && (!user || tabs.length === 0)) router.replace("/")
  }, [isLoading, user, tabs.length, router])

  if (isLoading || !user || tabs.length === 0 || !active) return null

  return (
    <AppShell title="Administration">
      <Tabs value={active} onValueChange={setActive} className="w-full">
        <TabsList>
          {tabs.map((t) => <TabsTrigger key={t.id} value={t.id}>{t.label}</TabsTrigger>)}
        </TabsList>
        {tabs.some((t) => t.id === "comptes") && (
          <TabsContent value="comptes" forceMount className="data-[state=inactive]:hidden">
            <div className="mx-auto max-w-3xl pt-4"><UserManagement /></div>
          </TabsContent>
        )}
        {tabs.some((t) => t.id === "systeme") && (
          <TabsContent value="systeme" forceMount className="data-[state=inactive]:hidden pt-4">
            <SystemPanel />
          </TabsContent>
        )}
        {tabs.some((t) => t.id === "reseau") && (
          <TabsContent value="reseau" forceMount className="data-[state=inactive]:hidden pt-4">
            <NetworkPanel />
          </TabsContent>
        )}
      </Tabs>
    </AppShell>
  )
}
```
Note: `forceMount` + `data-[state=inactive]:hidden` keeps all panels mounted (pollers alive) while hiding inactive ones. If the installed Tabs wrapper doesn't forward `forceMount`/data-state class, adjust so inactive content is `hidden` via CSS but still mounted — do NOT let Radix unmount it.

- [ ] **Step 3: Rewrite `app/configuration/page.tsx` as a redirect**

```tsx
import { redirect } from "next/navigation"
export default function ConfigurationPage() {
  redirect("/administration?tab=systeme")
}
```
(Server redirect — simplest. If the project needs it client-side, use `"use client"` + `useEffect(() => router.replace(...))`.)

- [ ] **Step 4: Update `components/sidebar.tsx`**

In the Administration section: point "Comptes" at `/administration?tab=comptes` (area `area_administration`), and "Configuration Pi" at `/administration?tab=systeme` (area `area_configuration`). Keep both entries so an operator still reaches Système/Réseau. (If the current sidebar already has these two items, just change their `href`.)

- [ ] **Step 5: Build + typecheck + manual checklist**

Run: `npm run build` (succeeds; `/administration` and `/configuration` both compile; `/configuration` now a redirect). `npx tsc --noEmit` — no new errors. Then the manual checklist (spec §6) is done on the Pi after deploy — document it in the task report as the deferred manual gate.
Critically self-check by grep: every `onClick`/`handle*`/endpoint call that existed in the old configuration page now appears in exactly one of the two panels (`grep -n "startUpdate\|getUpdateOutput\|getAptOutput\|restartServices\|connectToWifi\|startHotspot\|tailscaleUp" components/admin/system-panel.tsx components/admin/network-panel.tsx`), and none remain referenced by a now-deleted page.

- [ ] **Step 6: Commit**

```bash
git add app/administration/page.tsx app/configuration/page.tsx components/sidebar.tsx components/ui/tabs.tsx
git commit -m "feat(admin): tabbed administration console (Comptes/Système/Réseau), redirect /configuration"
```

---

## Self-Review

**Spec coverage:** §3 NetworkPanel → Task 1; SystemPanel → Task 2; tabbed shell + gating + forceMount + redirect + sidebar → Task 3. §4 risks: forceMount (Task 3 Step 2), verbatim update poller (Task 2), split 8 mount calls 5+3 (Tasks 1-2), single mount site (Task 3 deletes old page content). §5 security = UX gating only, backend authoritative (no backend change). All covered.

**Placeholder scan:** extraction tasks reference exact state/handler/card inventories + source line ranges (verbatim move is the content, legitimate for a refactor); the shell + redirect are concrete code. The one open branch — whether `components/ui/tabs.tsx` exists — is a Task 3 Step 1 check with a concrete fallback, not a placeholder.

**Consistency:** NetworkPanel owns exactly the Network state/handlers/5 mount calls; SystemPanel the System state/handlers/2 pollers/3 mount calls; no variable appears in both (per the map's "no shared state"). The tab ids (comptes/systeme/reseau) match the sidebar hrefs and the `?tab=` redirect target.

**Risk:** no frontend tests — the real gate is the manual checklist on the Pi (spec §6), especially the mid-update tab-switch test for the forceMount'd update poller. The final review must diff old-page vs panels for any dropped handler/endpoint/poller.
