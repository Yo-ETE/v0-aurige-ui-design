"use client"

import { useState } from "react"
import { AppShell } from "@/components/app-shell"
import { RaspberryPiStatus } from "@/components/dashboard/raspberry-pi-status"
import { MissionCreate } from "@/components/dashboard/mission-create"
import { MissionList } from "@/components/dashboard/mission-list"

export default function AccueilPage() {
  return (
    <AppShell
      title="Accueil"
      description="Dashboard AURIGE - Tableau de bord et gestion des missions"
    >
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Section A - Raspberry Pi Status */}
        <div className="lg:col-span-2">
          <RaspberryPiStatus />
        </div>

        {/* Section B - Missions */}
        <MissionCreate />
        <MissionList />
      </div>
    </AppShell>
  )
}
