"use client"
import { Suspense, useEffect, useMemo, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { AppShell } from "@/components/app-shell"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAuth } from "@/lib/auth-context"
import { UserManagement } from "@/components/admin/user-management"
import { SystemPanel } from "@/components/admin/system-panel"
import { NetworkPanel } from "@/components/admin/network-panel"

function AdministrationConsole() {
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
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs

  // Deep-link / URL change: honor ?tab= when it points to a visible tab.
  useEffect(() => {
    if (requested && tabsRef.current.some((t) => t.id === requested)) setActive(requested)
  }, [requested])

  // Init / fallback: only when active is empty or no longer a visible tab.
  useEffect(() => {
    if (!tabs.length) return
    if (active && tabs.some((t) => t.id === active)) return
    setActive(tabs.find((t) => t.id === requested)?.id ?? tabs[0].id)
  }, [tabs, active, requested])

  const handleTabChange = (id: string) => {
    setActive(id)
    router.replace(`/administration?tab=${id}`, { scroll: false })
  }

  useEffect(() => {
    if (!isLoading && (!user || tabs.length === 0)) router.replace("/")
  }, [isLoading, user, tabs.length, router])

  if (isLoading || !user || tabs.length === 0 || !active) return null

  return (
    <AppShell title="Administration">
      <Tabs value={active} onValueChange={handleTabChange} className="w-full">
        <TabsList>
          {tabs.map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {tabs.some((t) => t.id === "comptes") && (
          <TabsContent value="comptes" forceMount className="data-[state=inactive]:hidden">
            <div className="mx-auto max-w-3xl pt-4">
              <UserManagement />
            </div>
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

export default function AdministrationPage() {
  return (
    <Suspense fallback={null}>
      <AdministrationConsole />
    </Suspense>
  )
}
