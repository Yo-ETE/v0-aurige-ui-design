"use client"

import React from "react"
import { useState, useEffect } from "react"
import { useRouter, useParams } from "next/navigation"
import { AppShell } from "@/components/app-shell"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { MissionWizard } from "@/components/dashboard/mission-wizard"
import { useMissionStore, type Mission } from "@/lib/mission-store"
import {
  Car,
  Edit2,
  Download,
  Trash2,
  FileText,
  Calendar,
  Radio,
  Layers,
  Video,
  Zap,
  GitBranch,
  Activity,
  Flame,
  Cpu,
  Settings,
  ArrowRight,
  Info,
} from "lucide-react"
import Link from "next/link"

interface ModuleLink {
  name: string
  href: string
  icon: React.ComponentType<{ className?: string }>
  description: string
}

const moduleLinks: ModuleLink[] = [
  {
    name: "Contrôle CAN",
    href: "/controle-can",
    icon: Settings,
    description: "Configuration de l'interface CAN",
  },
  {
    name: "Capture & Replay",
    href: "/capture-replay",
    icon: Video,
    description: "Enregistrer et rejouer des sessions",
  },
  {
    name: "Replay Rapide",
    href: "/replay-rapide",
    icon: Zap,
    description: "Rejouer rapidement des trames",
  },
  {
    name: "Isolation",
    href: "/isolation",
    icon: GitBranch,
    description: "Isoler les trames par fonction",
  },
  {
    name: "Trames",
    href: "/trames",
    icon: FileText,
    description: "Catalogue des trames découvertes",
  },
  {
    name: "OBD-II",
    href: "/obd-ii",
    icon: Activity,
    description: "Diagnostics OBD-II standard",
  },
  {
    name: "Fuzzing",
    href: "/fuzzing",
    icon: Flame,
    description: "Tests de fuzzing CAN",
  },
  {
    name: "Générateur",
    href: "/generateur",
    icon: Cpu,
    description: "Génération de trames aléatoires",
  },
]

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)
}

export default function MissionPage() {
  const params = useParams()
  const id = params.id as string
  const router = useRouter()

  const missions = useMissionStore((state) => state.missions)
  const updateMission = useMissionStore((state) => state.updateMission)
  const deleteMission = useMissionStore((state) => state.deleteMission)
  const setCurrentMission = useMissionStore((state) => state.setCurrentMission)

  const [mission, setMission] = useState<Mission | null>(null)
  const [showRenameDialog, setShowRenameDialog] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [showEditVehicle, setShowEditVehicle] = useState(false)
  const [newName, setNewName] = useState("")

  // Set active mission ID immediately when entering this page
  useEffect(() => {
    if (id) {
      // Store in localStorage for persistence across page reloads
      localStorage.setItem("activeMissionId", id)
      // Also update zustand store
      setCurrentMission(id)
    }
  }, [id, setCurrentMission])

  // Find mission data from store
  useEffect(() => {
    const found = missions.find((m) => m.id === id)
    if (found) {
      setMission(found)
      setNewName(found.name)
    }
  }, [id, missions])

  if (!mission) {
    return (
      <AppShell title="Mission non trouvée">
        <div className="flex flex-col items-center justify-center py-16">
          <Car className="h-16 w-16 text-muted-foreground/30 mb-4" />
          <p className="text-muted-foreground">Mission introuvable</p>
          <Button
            variant="outline"
            className="mt-4 bg-transparent"
            onClick={() => router.push("/")}
          >
            Retour à l'accueil
          </Button>
        </div>
      </AppShell>
    )
  }

  const handleRename = () => {
    if (newName.trim() && newName !== mission.name) {
      updateMission(mission.id, { name: newName.trim() })
    }
    setShowRenameDialog(false)
  }

  const handleExport = () => {
    alert("Export de la mission à venir")
  }

  const handleDelete = () => {
    deleteMission(mission.id)
    setCurrentMission(null)
    router.push("/")
  }

  const vehicleLabel = `${mission.vehicle.brand} ${mission.vehicle.model} (${mission.vehicle.year})`

  return (
    <AppShell
      title={mission.name}
      description={mission.vehicle.vin ? `VIN: ${mission.vehicle.vin}` : vehicleLabel}
    >
      <div className="space-y-6">
        {/* Mission Header Card */}
        <Card className="bg-card border-border">
          <CardContent className="p-6">
            <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
              <div className="flex items-start gap-4">
                <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-xl bg-primary/20">
                  <Car className="h-7 w-7 text-primary" />
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-foreground">
                    {mission.name}
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {vehicleLabel}
                  </p>
                  {mission.vehicle.vin && (
                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                      VIN: {mission.vehicle.vin}
                    </p>
                  )}
                  {mission.notes && (
                    <p className="mt-2 text-sm text-muted-foreground max-w-xl flex items-start gap-2">
                      <Info className="h-4 w-4 flex-shrink-0 mt-0.5" />
                      {mission.notes}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowEditVehicle(true)}
                  className="gap-2"
                >
                  <Car className="h-4 w-4" />
                  Modifier véhicule
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowRenameDialog(true)}
                  className="gap-2"
                >
                  <Edit2 className="h-4 w-4" />
                  Renommer
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleExport}
                  className="gap-2 bg-transparent"
                >
                  <Download className="h-4 w-4" />
                  Exporter
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowDeleteDialog(true)}
                  className="gap-2 text-destructive hover:text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="h-4 w-4" />
                  Supprimer
                </Button>
              </div>
            </div>

            {/* Vehicle details row */}
            {(mission.vehicle.fuel || mission.vehicle.engine || mission.vehicle.trim) && (
              <div className="mt-4 flex flex-wrap gap-3 text-xs text-muted-foreground">
                {mission.vehicle.fuel && (
                  <span className="rounded bg-secondary px-2 py-1">
                    {mission.vehicle.fuel}
                  </span>
                )}
                {mission.vehicle.engine && (
                  <span className="rounded bg-secondary px-2 py-1">
                    {mission.vehicle.engine}
                  </span>
                )}
                {mission.vehicle.trim && (
                  <span className="rounded bg-secondary px-2 py-1">
                    {mission.vehicle.trim}
                  </span>
                )}
              </div>
            )}

            {/* Stats */}
            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="flex items-center gap-3 rounded-lg border border-border bg-secondary/30 p-3">
                <FileText className="h-5 w-5 text-primary" />
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {mission.logsCount}
                  </p>
                  <p className="text-xs text-muted-foreground">Logs enregistrés</p>
                </div>
              </div>
              <div className="flex items-center gap-3 rounded-lg border border-border bg-secondary/30 p-3">
                <Layers className="h-5 w-5 text-primary" />
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {mission.framesCount}
                  </p>
                  <p className="text-xs text-muted-foreground">Trames découvertes</p>
                </div>
              </div>
              <div className="flex items-center gap-3 rounded-lg border border-border bg-secondary/30 p-3">
                <Radio className="h-5 w-5 text-primary" />
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {mission.canInterface || "can0"} @ {mission.bitrate ? `${(mission.bitrate / 1000).toFixed(0)}k` : "500k"}
                  </p>
                  <p className="text-xs text-muted-foreground">Interface / Bitrate</p>
                </div>
              </div>
              <div className="flex items-center gap-3 rounded-lg border border-border bg-secondary/30 p-3">
                <Calendar className="h-5 w-5 text-primary" />
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {mission.lastCaptureDate
                      ? formatDate(mission.lastCaptureDate)
                      : "Aucune"}
                  </p>
                  <p className="text-xs text-muted-foreground">Dernière capture</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Module Links */}
        <div>
          <h3 className="text-lg font-semibold text-foreground mb-4">
            Modules d'analyse
          </h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {moduleLinks.map((module) => (
              <Link key={module.href} href={module.href}>
                <Card className="bg-card border-border transition-all hover:border-primary/50 hover:bg-card/80 cursor-pointer h-full">
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10">
                        <module.icon className="h-5 w-5 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <h4 className="font-medium text-foreground">
                            {module.name}
                          </h4>
                          <ArrowRight className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {module.description}
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* Edit Vehicle Wizard */}
      <MissionWizard
        open={showEditVehicle}
        onOpenChange={setShowEditVehicle}
        editMission={mission}
        editVehicleOnly
      />

      {/* Rename Dialog */}
      <Dialog open={showRenameDialog} onOpenChange={setShowRenameDialog}>
        <DialogContent className="bg-card border-border">
          <DialogHeader>
            <DialogTitle className="text-foreground">
              Renommer la mission
            </DialogTitle>
            <DialogDescription>
              Entrez le nouveau nom pour cette mission.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Nom de la mission"
              className="bg-input border-border"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowRenameDialog(false)}
            >
              Annuler
            </Button>
            <Button onClick={handleRename} disabled={!newName.trim()}>
              Renommer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent className="bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-foreground">
              Supprimer la mission
            </AlertDialogTitle>
            <AlertDialogDescription>
              Êtes-vous sûr de vouloir supprimer la mission "{mission.name}" ?
              Tous les logs et données associés seront perdus. Cette action est
              irréversible.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-border">
              Annuler
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Supprimer définitivement
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppShell>
  )
}
