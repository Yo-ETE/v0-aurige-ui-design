"use client"

import React from "react"

import { useState, useEffect } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"
import { useMissionStore } from "@/lib/mission-store"
import { getApiHost } from "@/lib/api-config"
import Image from "next/image"
import {
  Car,
  Settings,
  Video,
  Zap,
  GitBranch,
  GitCompare,
  Activity,
  Flame,
  Cpu,
  ChevronDown,
  Home,
  Menu,
  X,
  Cog,
  FileCode,
} from "lucide-react"
import { Button } from "@/components/ui/button"

type SystemStatus = {
  wifiConnected: boolean
  wifiIp?: string
  ethernetConnected: boolean
  ethernetIp?: string
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "/api"

async function fetchStatus(): Promise<SystemStatus> {
  const res = await fetch(`${API_BASE}/status`, { cache: "no-store" })
  if (!res.ok) throw new Error("status not ok")
  return res.json()
}

interface NavItem {
  name: string
  href: string
  icon: React.ComponentType<{ className?: string }>
  badge?: string
}

interface NavSection {
  title: string
  items: NavItem[]
  showMission?: boolean
}

const baseNavigation: NavSection[] = [
  {
    title: "Accueil",
    items: [{ name: "Dashboard", href: "/", icon: Home }],
  },
  {
    title: "Analyse",
    items: [],
    showMission: true,
  },
  {
    title: "Configuration",
    items: [{ name: "Contrôle CAN", href: "/controle-can", icon: Settings }],
  },
  {
    title: "Capture & Analyse",
    items: [
      { name: "Capture & Replay", href: "/capture-replay", icon: Video },
      { name: "Replay Rapide", href: "/replay-rapide", icon: Zap },
{ name: "Isolation", href: "/isolation", icon: GitBranch },
  { name: "Comparaison", href: "/comparaison", icon: GitCompare },
  { name: "DBC", href: "/dbc", icon: FileCode },
    ],
  },
  {
    title: "Diagnostic",
    items: [{ name: "OBD-II", href: "/obd-ii", icon: Activity }],
  },
  {
    title: "Tests Avancés",
    items: [
      { name: "Fuzzing", href: "/fuzzing", icon: Flame },
      { name: "Générateur", href: "/generateur", icon: Cpu },
    ],
  },
  {
    title: "Administration",
    items: [
      { name: "Configuration Pi", href: "/configuration", icon: Cog },
    ],
  },
]

export function Sidebar() {
  const pathname = usePathname()
  const currentMission = useMissionStore((state) => state.getCurrentMission())

  const [expandedSections, setExpandedSections] = useState<string[]>(
    baseNavigation.map((section) => section.title)
  )
  const [mobileOpen, setMobileOpen] = useState(false)
  const [isHydrated, setIsHydrated] = useState(false)

  // Handle hydration
  useEffect(() => {
    setIsHydrated(true)
  }, [])

  // Close mobile menu on route change
  useEffect(() => {
    setMobileOpen(false)
  }, [pathname])

  const [piIp, setPiIp] = useState<string>("—")
  const [piOk, setPiOk] = useState<boolean>(false)

  useEffect(() => {
    let alive = true

    const run = async () => {
      try {
        const s = await fetchStatus()
        if (!alive) return

        const ip =
          s.ethernetConnected && s.ethernetIp
            ? s.ethernetIp
            : s.wifiConnected && s.wifiIp
            ? s.wifiIp
            : "—"

        setPiIp(ip || "—")
        setPiOk(true)
      } catch {
        if (!alive) return
        setPiOk(false)
        setPiIp("Connexion API KO")
      }
    }

    run()
    const t = setInterval(run, 5000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  const toggleSection = (title: string) => {
    setExpandedSections((prev) =>
      prev.includes(title) ? prev.filter((t) => t !== title) : [...prev, title]
    )
  }

  // Build navigation with dynamic mission item
  const navigation = baseNavigation.map((section) => {
    if (section.showMission && currentMission) {
      return {
        ...section,
        items: [
          {
            name: currentMission.name,
            href: `/missions/${currentMission.id}`,
            icon: Car,
            badge: "Mission",
          },
        ],
      }
    }
    return section
  })

  return (
    <>
      {/* Mobile menu button */}
      <Button
        variant="ghost"
        size="icon"
        className="fixed left-4 top-4 z-50 lg:hidden"
        onClick={() => setMobileOpen(!mobileOpen)}
      >
        {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </Button>

      {/* Overlay for mobile */}
      {mobileOpen && (
        <div 
          className="fixed inset-0 z-40 bg-black/50 lg:hidden" 
          onClick={() => setMobileOpen(false)}
        />
      )}

      <aside className={cn(
        "fixed left-0 top-0 z-40 h-screen w-64 border-r border-sidebar-border bg-sidebar transition-transform duration-300",
        "lg:translate-x-0",
        mobileOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        <div className="flex h-full flex-col">
          {/* Logo */}
          <div className="flex h-16 items-center gap-3 border-b border-sidebar-border px-6">
          <Image
            src="/images/aurige.png"
            alt="AURIGE Logo"
            width={36}
            height={36}
            className="rounded-lg"
          />
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-sidebar-foreground">
              AURIGE
            </h1>
            <p className="text-xs text-muted-foreground">CAN Bus Analysis</p>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-4">
          {navigation.map((section, index) => {
            // Skip Analyse section if no current mission (only after hydration)
            if (section.showMission && isHydrated && !currentMission) return null
            
            return (
              <div key={section.title} className="mb-1">
                {index > 0 && (
                  <div className="mx-3 mb-2 mt-1 border-t border-sidebar-border/50" />
                )}
                <button
                  onClick={() => toggleSection(section.title)}
                  className="flex w-full items-center justify-between rounded-md px-3 py-2 text-[11px] font-semibold uppercase tracking-widest text-primary/80 hover:text-primary hover:bg-sidebar-accent/50 transition-colors"
                >
                  <span className="flex items-center gap-2">
                    <span className="h-px w-3 bg-primary/40" />
                    {section.title}
                  </span>
                  <ChevronDown
                    className={cn(
                      "h-3.5 w-3.5 transition-transform",
                      expandedSections.includes(section.title) && "rotate-180"
                    )}
                  />
                </button>

                {expandedSections.includes(section.title) && (
                  <div className="mt-1 space-y-1">
                    {section.items.map((item) => {
                      const isActive =
                        pathname === item.href ||
                        (item.href !== "/" && pathname.startsWith(item.href))

                      return (
<Link
                                          key={item.name}
                                          href={item.href}
                                          onClick={() => setMobileOpen(false)}
                                          className={cn(
                                            "group relative flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-all",
                                            isActive
                                              ? "bg-sidebar-accent text-sidebar-primary shadow-[inset_0_0_0_1px_rgba(99,102,241,0.3)]"
                                              : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                                          )}
                                        >
                          <item.icon
                            className={cn(
                              "h-4 w-4 flex-shrink-0",
                              isActive
                                ? "text-primary"
                                : "text-muted-foreground group-hover:text-sidebar-foreground"
                            )}
                          />
                          <span className="truncate">{item.name}</span>

                          {item.badge && (
                            <span className="ml-auto rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                              {item.badge}
                            </span>
                          )}

                          {isActive && (
                            <span className="absolute left-0 h-8 w-1 rounded-r-full bg-primary" />
                          )}
                        </Link>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </nav>

        {/* Status footer */}
        <div className="border-t border-sidebar-border p-4">
          <div className="flex items-center gap-3 rounded-md bg-sidebar-accent px-3 py-2">
            <div className="relative">
              <div
                className={cn(
                  "h-2 w-2 rounded-full",
                  piOk ? "bg-success" : "bg-destructive"
                )}
              />
              {piOk && (
                <div className="absolute inset-0 h-2 w-2 animate-ping rounded-full bg-success opacity-75" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-sidebar-foreground">Raspberry Pi</p>
              <p className="text-[10px] text-muted-foreground truncate">{isHydrated ? getApiHost() : "..."}</p>
            </div>
          </div>
</div>
        </div>
      </aside>
    </>
  )
}
