"use client"

import { useState, useMemo } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
import { useMissionStore, type Mission } from "@/lib/mission-store"
import {
  Search,
  ExternalLink,
  Trash2,
  Copy,
  Radio,
  FileText,
  Calendar,
  Tag,
  Car,
} from "lucide-react"

type SortOption = "recent" | "az"

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date)
}

function MissionRow({
  mission,
  onOpen,
  onDelete,
  onDuplicate,
}: {
  mission: Mission
  onOpen: () => void
  onDelete: () => void
  onDuplicate: () => void
}) {
  const vehicleInfo = `${mission.vehicle.brand} ${mission.vehicle.model} (${mission.vehicle.year})`
  
  return (
    <div className="flex items-center gap-4 rounded-lg border border-border bg-secondary/30 p-4 transition-colors hover:bg-secondary/50">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="font-medium text-foreground truncate">{mission.name}</h3>
          {mission.vehicle.vin && (
            <span className="rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              VIN
            </span>
          )}
          {mission.logsCount > 0 && (
            <span className="rounded bg-success/20 px-1.5 py-0.5 text-[10px] font-medium text-success">
              Logs: {mission.logsCount}
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Car className="h-3 w-3" />
            {vehicleInfo}
          </span>
          <span className="flex items-center gap-1">
            <Calendar className="h-3 w-3" />
            {formatDate(mission.lastActivity)}
          </span>
          <span className="flex items-center gap-1">
            <Radio className="h-3 w-3" />
            {mission.canInterface}
          </span>
          {mission.framesCount > 0 && (
            <span className="flex items-center gap-1">
              <FileText className="h-3 w-3" />
              {mission.framesCount} trames
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={onDuplicate}
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          title="Dupliquer"
        >
          <Copy className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onDelete}
          className="h-8 w-8 text-muted-foreground hover:text-destructive"
          title="Supprimer"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
        <Button onClick={onOpen} size="sm" className="gap-2">
          <ExternalLink className="h-4 w-4" />
          Ouvrir
        </Button>
      </div>
    </div>
  )
}

export function MissionList() {
  const router = useRouter()
  const missions = useMissionStore((state) => state.missions)
  const deleteMission = useMissionStore((state) => state.deleteMission)
  const duplicateMission = useMissionStore((state) => state.duplicateMission)
  const setCurrentMission = useMissionStore((state) => state.setCurrentMission)

  const [search, setSearch] = useState("")
  const [sort, setSort] = useState<SortOption>("recent")
  const [deleteTarget, setDeleteTarget] = useState<Mission | null>(null)

  const filteredMissions = useMemo(() => {
    let result = [...missions]

    // Filter by search
    if (search.trim()) {
      const searchLower = search.toLowerCase()
      result = result.filter(
        (m) =>
          m.name.toLowerCase().includes(searchLower) ||
          m.vehicle.brand.toLowerCase().includes(searchLower) ||
          m.vehicle.model.toLowerCase().includes(searchLower) ||
          m.vehicle.vin?.toLowerCase().includes(searchLower) ||
          m.notes?.toLowerCase().includes(searchLower)
      )
    }

    // Sort
    if (sort === "recent") {
      result.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime())
    } else {
      result.sort((a, b) => a.name.localeCompare(b.name))
    }

    return result
  }, [missions, search, sort])

  const handleOpen = (mission: Mission) => {
    setCurrentMission(mission.id)
    router.push(`/missions/${mission.id}`)
  }

  const handleDelete = () => {
    if (deleteTarget) {
      deleteMission(deleteTarget.id)
      setDeleteTarget(null)
    }
  }

  const handleDuplicate = (mission: Mission) => {
    const newMission = duplicateMission(mission.id)
    if (newMission) {
      setCurrentMission(newMission.id)
      router.push(`/missions/${newMission.id}`)
    }
  }

  return (
    <>
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg font-semibold text-foreground">
            Missions existantes
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Rechercher..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="bg-input border-border pl-9"
              />
            </div>
            <Select value={sort} onValueChange={(v) => setSort(v as SortOption)}>
              <SelectTrigger className="w-[140px] bg-input border-border">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="recent">Récentes</SelectItem>
                <SelectItem value="az">A-Z</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-3 max-h-[400px] overflow-y-auto pr-1">
            {filteredMissions.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <Tag className="h-10 w-10 text-muted-foreground/50 mb-3" />
                <p className="text-sm text-muted-foreground">
                  {search ? "Aucune mission trouvée" : "Aucune mission créée"}
                </p>
              </div>
            ) : (
              filteredMissions.map((mission) => (
                <MissionRow
                  key={mission.id}
                  mission={mission}
                  onOpen={() => handleOpen(mission)}
                  onDelete={() => setDeleteTarget(mission)}
                  onDuplicate={() => handleDuplicate(mission)}
                />
              ))
            )}
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent className="bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-foreground">
              Supprimer la mission
            </AlertDialogTitle>
            <AlertDialogDescription>
              Êtes-vous sûr de vouloir supprimer la mission "{deleteTarget?.name}" ?
              Cette action est irréversible.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-border">Annuler</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Supprimer
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
