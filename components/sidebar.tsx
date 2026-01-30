"use client"

import React from "react"

import { useState, useEffect } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"
import { useMissionStore } from "@/lib/mission-store"
import { getApiHost } from "@/lib/api-config"
import {
  Car,
  Settings,
  Video,
  Zap,
  GitBranch,
  Activity,
  Flame,
  Cpu,
  ChevronDown,
  Radio,
  Home,
  Menu,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"

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
    items: [
      { name: "Dashboard", href: "/", icon: Home },
    ],
  },
  {
    title: "Analyse",
    items: [],
    showMission: true,
  },
  {
    title: "Configuration",
    items: [
      { name: "Contrôle CAN", href: "/controle-can", icon: Settings },
    ],
  },
  {
    title: "Capture & Analyse",
    items: [
      { name: "Capture & Replay", href: "/capture-replay", icon: Video },
      { name: "Replay Rapide", href: "/replay-rapide", icon: Zap },
      { name: "Isolation", href: "/isolation", icon: GitBranch },
    ],
  },
  {
    title: "Diagnostic",
    items: [
      { name: "OBD-II", href: "/obd-ii", icon: Activity },
    ],
  },
  {
    title: "Tests Avancés",
    items: [
      { name: "Fuzzing", href: "/fuzzing", icon: Flame },
      { name: "Générateur", href: "/generateur", icon: Cpu },
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

  const toggleSection = (title: string) => {
    setExpandedSections((prev) =>
      prev.includes(title)
        ? prev.filter((t) => t !== title)
        : [...prev, title]
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
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary">
            <Radio className="h-5 w-5 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-sidebar-foreground">
              AURIGE
            </h1>
            <p className="text-xs text-muted-foreground">CAN Bus Analysis</p>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
          {navigation.map((section) => {
            // Skip Analyse section if no current mission (only after hydration)
            if (section.showMission && isHydrated && !currentMission) return null
            
            return (
              <div key={section.title} className="mb-4">
                <button
                  onClick={() => toggleSection(section.title)}
                  className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-sidebar-foreground"
                >
                  {section.title}
                  <ChevronDown
                    className={cn(
                      "h-4 w-4 transition-transform",
                      expandedSections.includes(section.title) && "rotate-180"
                    )}
                  />
                </button>
                {expandedSections.includes(section.title) && (
                  <div className="mt-1 space-y-1">
                    {section.items.map((item) => {
                      const isActive = pathname === item.href || 
                        (item.href !== "/" && pathname.startsWith(item.href))
                      return (
                        <Link
                          key={item.name}
                          href={item.href}
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
                              isActive ? "text-primary" : "text-muted-foreground group-hover:text-sidebar-foreground"
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
              <div className="h-2 w-2 rounded-full bg-success" />
              <div className="absolute inset-0 h-2 w-2 animate-ping rounded-full bg-success opacity-75" />
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
