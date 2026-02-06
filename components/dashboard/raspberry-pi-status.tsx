"use client"

import React from "react"
import { useState, useEffect, useCallback } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { getSystemStatus, type SystemStatus } from "@/lib/api"
import {
  RefreshCw,
  Wifi,
  Network,
  Cpu,
  HardDrive,
  Clock,
  Radio,
  Server,
  Activity,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Thermometer,
  MemoryStick,
} from "lucide-react"

interface StatusTile {
  id: string
  icon: React.ComponentType<{ className?: string }>
  title: string
  value: string
  subvalue?: string
  status: "ok" | "warning" | "error"
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  
  if (days > 0) {
    return `${days}j ${hours}h ${minutes}m`
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }
  return `${minutes}m`
}

function mapStatusToTiles(status: SystemStatus): StatusTile[] {
  const memoryPercent = Math.round((status.memoryUsed / status.memoryTotal) * 100)
  const storagePercent = Math.round((status.storageUsed / status.storageTotal) * 100)
  
  return [
    {
      id: "wifi",
      icon: Wifi,
      title: "Wi-Fi",
      value: status.wifiConnected 
        ? (status.wifiIsHotspot 
            ? `Hotspot: ${status.wifiHotspotSsid || "Aurige"}` 
            : `${status.wifiSsid || "Connecté"}${status.wifiSignal != null ? ` (${status.wifiSignal} dBm)` : ""}`)
        : "Déconnecté",
      subvalue: status.wifiConnected 
        ? (status.wifiIsHotspot 
            ? `Internet: ${status.wifiInternetSource || "?"}${status.wifiInternetVia ? ` (${status.wifiInternetVia})` : ""}`
            : `TX ${status.wifiTxRate || "-"} / RX ${status.wifiRxRate || "-"}`)
        : "Aucune connexion",
      status: status.wifiConnected 
        ? (status.wifiSignal != null && status.wifiSignal < -75 ? "warning" : "ok") 
        : "warning",
    },
    {
      id: "ethernet",
      icon: Network,
      title: "Ethernet",
      value: status.ethernetConnected ? "Connecté" : "Déconnecté",
      subvalue: status.ethernetConnected ? "eth0 actif" : "Câble non branché",
      status: status.ethernetConnected ? "ok" : "warning",
    },
    {
      id: "cpu",
      icon: Cpu,
      title: "CPU",
      value: `${status.cpuUsage.toFixed(0)}%`,
      subvalue: status.cpuUsage > 80 ? "Charge élevée" : "Normal",
      status: status.cpuUsage > 90 ? "error" : status.cpuUsage > 70 ? "warning" : "ok",
    },
    {
      id: "temp",
      icon: Thermometer,
      title: "Température",
      value: `${status.temperature.toFixed(0)}°C`,
      subvalue: status.temperature > 70 ? "Attention surchauffe" : "Normal",
      status: status.temperature > 80 ? "error" : status.temperature > 65 ? "warning" : "ok",
    },
    {
      id: "memory",
      icon: MemoryStick,
      title: "Mémoire",
      value: `${(status.memoryUsed / 1024).toFixed(1)} / ${(status.memoryTotal / 1024).toFixed(1)} GB`,
      subvalue: `${memoryPercent}% utilisé`,
      status: memoryPercent > 90 ? "error" : memoryPercent > 75 ? "warning" : "ok",
    },
    {
      id: "storage",
      icon: HardDrive,
      title: "Stockage",
      value: `${status.storageUsed.toFixed(1)} / ${status.storageTotal.toFixed(0)} GB`,
      subvalue: `${storagePercent}% utilisé`,
      status: storagePercent > 90 ? "error" : storagePercent > 75 ? "warning" : "ok",
    },
    {
      id: "uptime",
      icon: Clock,
      title: "Uptime",
      value: formatUptime(status.uptimeSeconds),
      subvalue: `${Math.floor(status.uptimeSeconds / 86400)} jours`,
      status: "ok",
    },
    {
      id: "can0",
      icon: Radio,
      title: "can0",
      value: status.can0Up ? "UP" : "DOWN",
      subvalue: status.can0Up ? "Interface active" : "Non configuré",
      status: status.can0Up ? "ok" : "warning",
    },
    {
      id: "can1",
      icon: Radio,
      title: "can1",
      value: status.can1Up ? "UP" : "DOWN",
      subvalue: status.can1Up ? "Interface active" : "Non configuré",
      status: status.can1Up ? "ok" : "warning",
    },
    {
      id: "vcan0",
      icon: Radio,
      title: "vcan0",
      value: status.vcan0Up ? "UP" : "DOWN",
      subvalue: status.vcan0Up ? "Interface test active" : "Non configuré",
      status: status.vcan0Up ? "ok" : "warning",
    },
    {
      id: "api",
      icon: Server,
      title: "API Backend",
      value: status.apiRunning ? "Online" : "Offline",
      subvalue: status.apiRunning ? "Port 8000" : "Service arrêté",
      status: status.apiRunning ? "ok" : "error",
    },
    {
      id: "web",
      icon: Server,
      title: "Web Frontend",
      value: status.webRunning ? "Online" : "Offline",
      subvalue: status.webRunning ? "Port 3000" : "Service arrêté",
      status: status.webRunning ? "ok" : "error",
    },
  ]
}

// Initial loading tiles - shown before first API call
function getLoadingTiles(): StatusTile[] {
  return [
    { id: "wifi", icon: Wifi, title: "Wi-Fi", value: "...", subvalue: "Connexion...", status: "warning" },
    { id: "ethernet", icon: Network, title: "Ethernet", value: "...", subvalue: "Connexion...", status: "warning" },
    { id: "cpu", icon: Cpu, title: "CPU", value: "...", subvalue: "Connexion...", status: "warning" },
    { id: "temp", icon: Thermometer, title: "Temp.", value: "...", subvalue: "Connexion...", status: "warning" },
    { id: "memory", icon: MemoryStick, title: "Mémoire", value: "...", subvalue: "Connexion...", status: "warning" },
    { id: "storage", icon: HardDrive, title: "Stockage", value: "...", subvalue: "Connexion...", status: "warning" },
    { id: "uptime", icon: Clock, title: "Uptime", value: "...", subvalue: "Connexion...", status: "warning" },
    { id: "can0", icon: Radio, title: "can0", value: "...", subvalue: "Connexion...", status: "warning" },
    { id: "can1", icon: Radio, title: "can1", value: "...", subvalue: "Connexion...", status: "warning" },
    { id: "vcan0", icon: Radio, title: "vcan0", value: "...", subvalue: "Connexion...", status: "warning" },
    { id: "api", icon: Server, title: "API Backend", value: "...", subvalue: "Connexion en cours...", status: "warning" },
    { id: "web", icon: Server, title: "Web Frontend", value: "OK", subvalue: "Port 3000", status: "ok" },
  ]
}

// Offline tiles - shown when API is unreachable after retry
function getOfflineTiles(): StatusTile[] {
  return [
    { id: "wifi", icon: Wifi, title: "Wi-Fi", value: "?", subvalue: "API hors ligne", status: "error" },
    { id: "ethernet", icon: Network, title: "Ethernet", value: "?", subvalue: "API hors ligne", status: "error" },
    { id: "cpu", icon: Cpu, title: "CPU", value: "?", subvalue: "API hors ligne", status: "error" },
    { id: "temp", icon: Thermometer, title: "Temp.", value: "?", subvalue: "API hors ligne", status: "error" },
    { id: "memory", icon: MemoryStick, title: "Mémoire", value: "?", subvalue: "API hors ligne", status: "error" },
    { id: "storage", icon: HardDrive, title: "Stockage", value: "?", subvalue: "API hors ligne", status: "error" },
    { id: "uptime", icon: Clock, title: "Uptime", value: "?", subvalue: "API hors ligne", status: "error" },
    { id: "can0", icon: Radio, title: "can0", value: "?", subvalue: "API hors ligne", status: "error" },
    { id: "can1", icon: Radio, title: "can1", value: "?", subvalue: "API hors ligne", status: "error" },
    { id: "vcan0", icon: Radio, title: "vcan0", value: "?", subvalue: "API hors ligne", status: "error" },
    { id: "api", icon: Server, title: "API Backend", value: "Hors ligne", subvalue: "Connexion impossible", status: "error" },
    { id: "web", icon: Server, title: "Web Frontend", value: "OK", subvalue: "Port 3000", status: "ok" },
  ]
}

function StatusIcon({ status }: { status: "ok" | "warning" | "error" }) {
  if (status === "ok") {
    return <CheckCircle2 className="h-4 w-4 text-success" />
  }
  if (status === "warning") {
    return <AlertTriangle className="h-4 w-4 text-warning" />
  }
  return <XCircle className="h-4 w-4 text-destructive" />
}

function StatusTileComponent({ tile }: { tile: StatusTile }) {
  const Icon = tile.icon
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border p-3 transition-colors",
        tile.status === "ok" && "border-success/30 bg-success/5",
        tile.status === "warning" && "border-warning/30 bg-warning/5",
        tile.status === "error" && "border-destructive/30 bg-destructive/5"
      )}
    >
      <div className="relative flex-shrink-0">
        <div
          className={cn(
            "flex h-9 w-9 items-center justify-center rounded-md",
            tile.status === "ok" && "bg-success/20 text-success",
            tile.status === "warning" && "bg-warning/20 text-warning",
            tile.status === "error" && "bg-destructive/20 text-destructive"
          )}
        >
          <Icon className="h-4 w-4" />
        </div>
        {tile.id === "wifi" && tile.subvalue && (tile.status === "ok" || tile.status === "warning") && tile.value !== "Déconnecté" && (
          <span className={cn(
            "absolute -bottom-1.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full px-1.5 py-px text-[9px] font-bold leading-tight",
            tile.status === "ok" ? "bg-success/90 text-success-foreground" : "bg-warning/90 text-warning-foreground"
          )}>
            {tile.subvalue.replace("TX ", "").split(" / ")[0]}
          </span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            {tile.title}
          </span>
          <StatusIcon status={tile.status} />
        </div>
        <p className="text-sm font-semibold text-foreground">{tile.value}</p>
        {tile.subvalue && (
          <p className="text-xs text-muted-foreground truncate">{tile.subvalue}</p>
        )}
      </div>
    </div>
  )
}

export function RaspberryPiStatus() {
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [tiles, setTiles] = useState<StatusTile[]>(getLoadingTiles())
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [isApiAvailable, setIsApiAvailable] = useState(false)

  const fetchStatus = useCallback(async () => {
    setIsRefreshing(true)
    try {
      const status = await getSystemStatus()
      setTiles(mapStatusToTiles(status))
      setIsApiAvailable(true)
    } catch {
      // API not available, show offline state
      setTiles(getOfflineTiles())
      setIsApiAvailable(false)
    }
    setLastUpdate(new Date())
    setIsRefreshing(false)
  }, [])

  useEffect(() => {
    fetchStatus()
    // Auto-refresh every 30 seconds
    const interval = setInterval(fetchStatus, 30000)
    return () => clearInterval(interval)
  }, [fetchStatus])

  return (
    <Card className="bg-card border-border">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
        <div>
          <CardTitle className="text-lg font-semibold text-foreground">
            État du Raspberry Pi
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Dernière mise à jour: {lastUpdate ? lastUpdate.toLocaleTimeString("fr-FR") : "..."}
            {!isApiAvailable && lastUpdate && " (données simulées)"}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={fetchStatus}
          disabled={isRefreshing}
          className="gap-2 bg-transparent"
        >
          <RefreshCw
            className={cn("h-4 w-4", isRefreshing && "animate-spin")}
          />
          Actualiser
        </Button>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {tiles.map((tile) => (
            <StatusTileComponent key={tile.id} tile={tile} />
          ))}
        </div>
        {!isApiAvailable && (
          <p className="mt-4 text-xs text-destructive italic border-t border-border pt-4">
            Connexion au Raspberry Pi impossible. Vérifiez que l'API backend est en cours d'exécution sur le port 8000 et que l'adresse IP est correctement configurée.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
