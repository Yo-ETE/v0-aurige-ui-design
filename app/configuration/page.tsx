"use client"

import { useState, useEffect, useCallback } from "react"
import { AppShell } from "@/components/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Wifi,
  WifiOff,
  RefreshCw,
  Signal,
  Globe,
  Network,
  Download,
  Power,
  PowerOff,
  Lock,
  Unlock,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  Terminal,
  ArrowUpCircle,
  GitBranch,
  ChevronDown,
  ChevronRight,
  HardDrive,
  Trash2,
  Archive,
  RotateCcw,
  Usb,
  Cable,
  Eye,
  EyeOff,
  Star,
  Shield,
  ShieldCheck,
  ShieldOff,
  ExternalLink,
  Monitor,
  Smartphone,
  Laptop,
  Server,
  Copy,
  LogOut,
  FileText,
  BookOpen,
  Scale,
  Video,
  Zap,
  Flame,
  Cpu,
  Settings,
  Activity,
  Search,
  BarChart3,
  FileCode,
  GitCompare,
  ShieldAlert,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import {
  scanWifiNetworks,
  getWifiStatus,
  getEthernetStatus,
  connectToWifi,
  getSavedNetworks,
  runAptUpdate,
  runAptUpgrade,
  getAptOutput,
  systemReboot,
  systemShutdown,
  getVersionInfo,
  listBackups,
  createBackup,
  deleteBackup,
  restoreBackup,
  startUpdate,
  getUpdateOutput,
  getGitBranches,
  restartServices,
  getTailscaleStatus,
  tailscaleUp,
  tailscaleDown,
  tailscaleLogout,
  tailscaleSetExitNode,
  type WifiNetwork,
  type WifiStatus,
  type TailscaleStatus,
  type TailscalePeer,
  type EthernetStatus,
  type AptOutput,
  type VersionInfo,
  type BackupInfo,
  type UpdateOutput,
  type GitBranches,
} from "@/lib/api"

export default function ConfigurationPage() {
  // Wi-Fi state
  const [wifiStatus, setWifiStatus] = useState<WifiStatus | null>(null)
  const [ethernetStatus, setEthernetStatus] = useState<EthernetStatus | null>(null)
  const [networks, setNetworks] = useState<WifiNetwork[]>([])
  const [isScanning, setIsScanning] = useState(false)
  const [selectedNetwork, setSelectedNetwork] = useState<string | null>(null)
  const [wifiPassword, setWifiPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [savedNetworks, setSavedNetworks] = useState<string[]>([])
  const [isConnecting, setIsConnecting] = useState(false)
  const [wifiError, setWifiError] = useState<string | null>(null)
  const [wifiSuccess, setWifiSuccess] = useState<string | null>(null)

  // System state
  const [aptOutput, setAptOutput] = useState<AptOutput>({ running: false, command: "", lines: [] })
  const [isRebooting, setIsRebooting] = useState(false)
  const [isShuttingDown, setIsShuttingDown] = useState(false)
  const [systemMessage, setSystemMessage] = useState<string | null>(null)

  // Update state
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null)
  const [updateOutput, setUpdateOutput] = useState<UpdateOutput>({ running: false, lines: [] })
  const [isCheckingVersion, setIsCheckingVersion] = useState(false)
  
  // Git branches state
  const [gitBranches, setGitBranches] = useState<GitBranches | null>(null)
  const [selectedBranch, setSelectedBranch] = useState<string>("")
  const [isFetchingBranches, setIsFetchingBranches] = useState(false)

  // Backup state
  const [backups, setBackups] = useState<BackupInfo[]>([])
  const [isCreatingBackup, setIsCreatingBackup] = useState(false)
  const [backupMessage, setBackupMessage] = useState<string | null>(null)
  const [needsRestart, setNeedsRestart] = useState(false)
  const [isRestarting, setIsRestarting] = useState(false)
  
  // Licence / Guide state
  const [showLicence, setShowLicence] = useState(false)
  const [showGuide, setShowGuide] = useState(false)
  const [guideSection, setGuideSection] = useState<string | null>(null)

  // Tailscale VPN
  const [tsStatus, setTsStatus] = useState<TailscaleStatus | null>(null)
  const [tsLoading, setTsLoading] = useState(false)
  const [tsAction, setTsAction] = useState<string | null>(null)
  const [tsMessage, setTsMessage] = useState<{ type: "success" | "error" | "auth"; text: string; url?: string } | null>(null)

  // Fetch connection status (wifi + ethernet)
  const fetchConnectionStatus = useCallback(async () => {
    try {
      const [wifi, ethernet] = await Promise.all([
        getWifiStatus(),
        getEthernetStatus(),
      ])
      setWifiStatus(wifi)
      setEthernetStatus(ethernet)
    } catch {
      setWifiStatus(null)
      setEthernetStatus(null)
    }
  }, [])

  // Fetch saved networks
  const fetchSavedNetworks = useCallback(async () => {
    try {
      const result = await getSavedNetworks()
      setSavedNetworks(result.saved || [])
    } catch {
      setSavedNetworks([])
    }
  }, [])

  // Scan for networks
  const handleScan = async () => {
    setIsScanning(true)
    setWifiError(null)
    try {
      const [scanResult] = await Promise.all([
        scanWifiNetworks(),
        fetchSavedNetworks(),
      ])
      if (scanResult.status === "success") {
        setNetworks(scanResult.networks)
      } else {
        setWifiError(scanResult.message || "Erreur lors du scan")
      }
    } catch (err) {
      setWifiError("Erreur lors du scan Wi-Fi")
    } finally {
      setIsScanning(false)
    }
  }

  // Connect to network
  const handleConnect = async () => {
    if (!selectedNetwork) return
    setIsConnecting(true)
    setWifiError(null)
    setWifiSuccess(null)
    try {
      const result = await connectToWifi(selectedNetwork, wifiPassword)
      if (result.status === "success") {
        setWifiSuccess(result.message)
        setWifiPassword("")
        setSelectedNetwork(null)
        await fetchConnectionStatus()
      } else {
        setWifiError(result.message)
      }
    } catch {
      setWifiError("Erreur de connexion")
    } finally {
      setIsConnecting(false)
    }
  }

  // Apt commands
  const handleAptUpdate = async () => {
    setSystemMessage(null)
    try {
      await runAptUpdate()
    } catch {
      setSystemMessage("Erreur lors du lancement de apt update")
    }
  }

  const handleAptUpgrade = async () => {
    setSystemMessage(null)
    try {
      await runAptUpgrade()
    } catch {
      setSystemMessage("Erreur lors du lancement de apt upgrade")
    }
  }

  // Poll apt output
  useEffect(() => {
    const pollApt = async () => {
      try {
        const output = await getAptOutput()
        setAptOutput(output)
      } catch (error: unknown) {
        // Silently ignore network errors (ERR_NETWORK_CHANGED, timeouts, etc.)
        // Only log unexpected errors for debugging
        if (error && typeof error === "object" && "message" in error) {
          const msg = String(error.message)
          if (!msg.includes("network") && !msg.includes("fetch") && !msg.includes("timeout")) {
            console.error("[v0] Unexpected apt polling error:", error)
          }
        }
      }
    }
    
    pollApt()
    const interval = setInterval(pollApt, 1000)
    return () => clearInterval(interval)
  }, [])

  // System power
  const handleReboot = async () => {
    if (!confirm("Voulez-vous vraiment redemarrer le Raspberry Pi ?")) return
    setIsRebooting(true)
    try {
      await systemReboot()
      setSystemMessage("Redemarrage en cours... La connexion sera perdue.")
    } catch {
      setSystemMessage("Erreur lors du redemarrage")
      setIsRebooting(false)
    }
  }

  const handleShutdown = async () => {
    if (!confirm("Voulez-vous vraiment eteindre le Raspberry Pi ?")) return
    setIsShuttingDown(true)
    try {
      await systemShutdown()
      setSystemMessage("Arret en cours... La connexion sera perdue.")
    } catch {
      setSystemMessage("Erreur lors de l'arret")
      setIsShuttingDown(false)
    }
  }

  // Fetch git branches
  const fetchBranches = useCallback(async () => {
    setIsFetchingBranches(true)
    try {
      const data = await getGitBranches()
      setGitBranches(data)
      // Set selected branch to current if not already set
      if (!selectedBranch && data.current) {
        setSelectedBranch(data.current)
      }
    } catch (error: unknown) {
      // Silently handle network errors
      if (error && typeof error === "object" && "message" in error) {
        const msg = String(error.message)
        if (!msg.includes("network") && !msg.includes("fetch") && !msg.includes("timeout")) {
          console.error("[v0] Unexpected branches fetch error:", error)
        }
      }
      setGitBranches(null)
    } finally {
      setIsFetchingBranches(false)
    }
  }, [selectedBranch])
  
  // Fetch version info
  const fetchVersionInfo = useCallback(async () => {
    setIsCheckingVersion(true)
    try {
      const info = await getVersionInfo()
      setVersionInfo(info)
    } catch {
      setVersionInfo(null)
    } finally {
      setIsCheckingVersion(false)
    }
  }, [])

  // Fetch backups
  const fetchBackups = useCallback(async () => {
    try {
      const result = await listBackups()
      setBackups(result.backups)
    } catch {
      setBackups([])
    }
  }, [])

  // Handle update
  const handleStartUpdate = async () => {
    const branchToUse = selectedBranch || gitBranches?.current || ""
    const msg = branchToUse 
      ? `Mettre a jour Aurige depuis la branche "${branchToUse}" ? Les services seront redemarres.`
      : "Voulez-vous mettre a jour Aurige ? Les services seront redemarres."
    if (!confirm(msg)) return
    setBackupMessage(null)
    try {
      await startUpdate(branchToUse || undefined)
    } catch {
      setBackupMessage("Erreur lors du lancement de la mise a jour")
    }
  }

  // Poll update output with error handling and auto-reload
  useEffect(() => {
    let errorCount = 0
    let reloadScheduled = false
    
    const pollUpdate = async () => {
      try {
        const output = await getUpdateOutput()
        setUpdateOutput(output)
        errorCount = 0 // Reset on success
        
        // Check if update completed successfully
        if (!output.running && output.lines.length > 0 && !reloadScheduled) {
          const hasSuccess = output.lines.some(l => 
            l.includes("[OK] Mise a jour terminee") || 
            l.includes("Installation complete") ||
            l.includes("AURIGE Installation Complete")
          )
          if (hasSuccess) {
            reloadScheduled = true
            setNeedsRestart(true)
            // Auto restart services and reload
            setTimeout(async () => {
              try {
                await restartServices()
                setUpdateOutput(prev => ({
                  ...prev,
                  lines: [...prev.lines, ">>> Services redemarres, rechargement de la page..."],
                }))
                setTimeout(() => {
                  window.location.reload()
                }, 2000)
              } catch {
                // If auto restart fails, show manual button
                setUpdateOutput(prev => ({
                  ...prev,
                  lines: [...prev.lines, ">>> Veuillez redemarrer les services manuellement"],
                }))
              }
            }, 1000)
          }
        }
      } catch (error: unknown) {
        // Silently handle network errors, only count real API failures
        const isNetworkError = error && typeof error === "object" && "message" in error &&
          (String(error.message).includes("network") || 
           String(error.message).includes("fetch") || 
           String(error.message).includes("timeout"))
        
        if (!isNetworkError) {
          errorCount++
          // If we get multiple errors in a row during an update, services are restarting
          // Try to reload the page after a delay
          if (errorCount >= 3 && updateOutput.running && !reloadScheduled) {
            reloadScheduled = true
            setUpdateOutput(prev => ({
              ...prev,
              lines: [...prev.lines, ">>> Services en cours de redemarrage...", ">>> Rechargement automatique dans 5 secondes..."],
              running: false
            }))
            setTimeout(() => {
              window.location.reload()
            }, 5000)
          }
        }
      }
    }

    const interval = setInterval(pollUpdate, 1500)
    return () => clearInterval(interval)
  }, [updateOutput.running])

  // Handle backup
  const handleCreateBackup = async () => {
    setIsCreatingBackup(true)
    setBackupMessage(null)
    try {
      const result = await createBackup()
      if (result.status === "success") {
        setBackupMessage(`Sauvegarde creee: ${result.filename}`)
        fetchBackups()
      } else {
        setBackupMessage(result.message)
      }
    } catch {
      setBackupMessage("Erreur lors de la sauvegarde")
    } finally {
      setIsCreatingBackup(false)
    }
  }

  // Handle delete backup
  const handleDeleteBackup = async (filename: string) => {
    if (!confirm(`Supprimer la sauvegarde ${filename} ?`)) return
    try {
      await deleteBackup(filename)
      fetchBackups()
    } catch {
      setBackupMessage("Erreur lors de la suppression")
    }
  }

  // Handle restore backup
  const handleRestoreBackup = async (filename: string) => {
    if (!confirm(`Restaurer la sauvegarde ${filename} ?\nLes donnees actuelles seront ecrasees.`)) return
    setBackupMessage(null)
    setNeedsRestart(false)
    try {
      const result = await restoreBackup(filename)
      setBackupMessage(result.message)
      if (result.status === "success") {
        setNeedsRestart(true)
      }
    } catch {
      setBackupMessage("Erreur lors de la restauration")
    }
  }

  // Handle restart services
  const handleRestartServices = async () => {
    setIsRestarting(true)
    try {
      await restartServices()
      setBackupMessage("Services redemarres. La page va se recharger...")
      setNeedsRestart(false)
      // Reload page after a short delay
      setTimeout(() => window.location.reload(), 2000)
    } catch {
      setBackupMessage("Erreur lors du redemarrage des services")
    } finally {
      setIsRestarting(false)
    }
  }

  // Tailscale handlers
  const fetchTailscale = useCallback(async () => {
    setTsLoading(true)
    try {
      const status = await getTailscaleStatus()
      setTsStatus(status)
    } catch (error: unknown) {
      // Silently handle network errors
      if (error && typeof error === "object" && "message" in error) {
        const msg = String(error.message)
        if (!msg.includes("network") && !msg.includes("fetch") && !msg.includes("timeout")) {
          console.error("[v0] Unexpected tailscale fetch error:", error)
        }
      }
      setTsStatus(null)
    } finally {
      setTsLoading(false)
    }
  }, [])
  
  const handleTsUp = async () => {
    setTsAction("up")
    setTsMessage(null)
    try {
      const result = await tailscaleUp()
      if (result.status === "auth_needed") {
        setTsMessage({ type: "auth", text: "Authentification requise", url: result.authUrl })
      } else if (result.status === "success") {
        setTsMessage({ type: "success", text: result.message })
      } else {
        setTsMessage({ type: "error", text: result.message })
      }
      await fetchTailscale()
    } catch (e) {
      setTsMessage({ type: "error", text: e instanceof Error ? e.message : "Erreur" })
    } finally {
      setTsAction(null)
    }
  }
  
  const handleTsDown = async () => {
    setTsAction("down")
    setTsMessage(null)
    try {
      const result = await tailscaleDown()
      setTsMessage({ type: result.status === "success" ? "success" : "error", text: result.message })
      await fetchTailscale()
    } catch (e) {
      setTsMessage({ type: "error", text: e instanceof Error ? e.message : "Erreur" })
    } finally {
      setTsAction(null)
    }
  }
  
  const handleTsLogout = async () => {
    setTsAction("logout")
    setTsMessage(null)
    try {
      const result = await tailscaleLogout()
      setTsMessage({ type: result.status === "success" ? "success" : "error", text: result.message })
      await fetchTailscale()
    } catch (e) {
      setTsMessage({ type: "error", text: e instanceof Error ? e.message : "Erreur" })
    } finally {
      setTsAction(null)
    }
  }
  
  const handleTsExitNode = async (ip: string) => {
    setTsAction("exit")
    setTsMessage(null)
    try {
      const result = await tailscaleSetExitNode(ip)
      setTsMessage({ type: result.status === "success" ? "success" : "error", text: result.message })
      await fetchTailscale()
    } catch (e) {
      setTsMessage({ type: "error", text: e instanceof Error ? e.message : "Erreur" })
    } finally {
      setTsAction(null)
    }
  }
  
  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 B"
    const k = 1024
    const sizes = ["B", "KB", "MB", "GB"]
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
  }
  
  const getPeerOsIcon = (os: string) => {
    const osLower = os.toLowerCase()
    if (osLower.includes("android") || osLower.includes("ios")) return Smartphone
    if (osLower.includes("windows") || osLower.includes("macos")) return Laptop
    if (osLower.includes("linux")) return Server
    return Monitor
  }
  
  // Initial load
  useEffect(() => {
    fetchConnectionStatus()
    handleScan()
    fetchVersionInfo()
    fetchBranches()
    fetchBackups()
    fetchTailscale()
  }, [fetchConnectionStatus, fetchVersionInfo, fetchBranches, fetchBackups, fetchTailscale])

  // Signal strength helper
  const getSignalIcon = (signal: number) => {
    if (signal >= 70) return <Signal className="h-4 w-4 text-success" />
    if (signal >= 40) return <Signal className="h-4 w-4 text-warning" />
    return <Signal className="h-4 w-4 text-destructive" />
  }

  return (
    <AppShell
      title="Configuration"
      description="Administration reseau et systeme du Raspberry Pi"
    >
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Connection Status Card */}
        <Card className="border-border bg-card">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                  <Globe className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <CardTitle className="text-lg">Etat connexion</CardTitle>
                  <CardDescription>Wi-Fi et Ethernet</CardDescription>
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={fetchConnectionStatus} className="bg-transparent">
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Wi-Fi Section */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                {wifiStatus?.connected ? (
                  <Wifi className="h-4 w-4 text-success" />
                ) : (
                  <WifiOff className="h-4 w-4 text-muted-foreground" />
                )}
                <span className="font-medium">Wi-Fi</span>
                {wifiStatus?.connected && (
                  <span className="text-xs text-success ml-auto">
                    {wifiStatus.isHotspot ? "Mode Hotspot" : "Connecte"}
                  </span>
                )}
              </div>
              {wifiStatus?.connected ? (
                wifiStatus.isHotspot ? (
                  <div className="pl-6 text-sm space-y-3">
                    <Alert className="border-primary/50 bg-primary/10 py-2">
                      <Wifi className="h-4 w-4 text-primary" />
                      <AlertDescription className="text-primary text-xs">
                        Hotspot &quot;{wifiStatus.hotspotSsid || "Aurige"}&quot; actif
                      </AlertDescription>
                    </Alert>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <p className="text-xs text-muted-foreground">IP Hotspot</p>
                        <p className="font-mono text-xs">{wifiStatus.ipLocal}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">IP Publique</p>
                        <p className="font-mono text-xs">{wifiStatus.ipPublic || "-"}</p>
                      </div>
                    </div>
                    
                    {/* Secondary interfaces - sources de connectivite */}
                    {wifiStatus.secondaryInterfaces && wifiStatus.secondaryInterfaces.length > 0 && (
                      <div className="space-y-2 pt-2 border-t border-border/50">
                        <p className="text-xs text-muted-foreground font-medium">Interfaces reseau</p>
                        {wifiStatus.secondaryInterfaces.map((iface: { name: string; type: string; label: string; ssid: string; ip: string; signal: number; connected: boolean; isDefaultRoute?: boolean }) => (
                          <div
                            key={iface.name}
                            className={`rounded-md border p-2.5 ${
                              iface.isDefaultRoute
                                ? "border-success/40 bg-success/5"
                                : iface.connected
                                  ? "border-border bg-secondary/30"
                                  : "border-border/50 bg-muted/20 opacity-60"
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                {iface.type === "wifi" && <Wifi className={`h-3.5 w-3.5 ${iface.connected ? "text-primary" : "text-muted-foreground"}`} />}
                                {iface.type === "usb" && <Usb className={`h-3.5 w-3.5 ${iface.connected ? "text-primary" : "text-muted-foreground"}`} />}
                                {iface.type === "ethernet" && <Cable className={`h-3.5 w-3.5 ${iface.connected ? "text-primary" : "text-muted-foreground"}`} />}
                                <span className="text-xs font-medium">{iface.label}</span>
                                <span className="text-xs text-muted-foreground font-mono">({iface.name})</span>
                              </div>
                              <div className="flex items-center gap-1.5">
                                {iface.isDefaultRoute && (
                                  <span className="text-[10px] font-medium text-success bg-success/15 px-1.5 py-0.5 rounded">INTERNET</span>
                                )}
                                {iface.connected ? (
                                  <CheckCircle2 className="h-3 w-3 text-success" />
                                ) : (
                                  <AlertCircle className="h-3 w-3 text-muted-foreground" />
                                )}
                              </div>
                            </div>
                            {iface.connected && (
                              <div className="flex items-center gap-3 mt-1.5 pl-5.5 text-xs text-muted-foreground">
                                {iface.ssid && (
                                  <span>SSID: <span className="text-foreground font-medium">{iface.ssid}</span></span>
                                )}
                                {iface.ip && (
                                  <span className="font-mono">{iface.ip}</span>
                                )}
                                {iface.signal !== 0 && (
                                  <span>{iface.signal} dBm</span>
                                )}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    
                    {/* Internet connectivity test */}
                    <div className="pt-2 border-t border-border/50">
                      <p className="text-xs text-muted-foreground mb-1">Connectivite Internet</p>
                      {wifiStatus.hasInternet ? (
                        <div className="flex items-center gap-3">
                          <span className="flex items-center gap-1.5 text-success text-xs font-medium">
                            <CheckCircle2 className="h-3 w-3" />
                            Connecte
                          </span>
                          {wifiStatus.pingMs > 0 && (
                            <span className="text-xs text-muted-foreground">
                              Ping: {wifiStatus.pingMs} ms
                            </span>
                          )}
                          {wifiStatus.downloadSpeed && (
                            <span className="text-xs text-muted-foreground">
                              DL: {wifiStatus.downloadSpeed}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="flex items-center gap-1.5 text-destructive text-xs font-medium">
                          <AlertCircle className="h-3 w-3" />
                          Pas d&apos;acces Internet
                        </span>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3 pl-6 text-sm">
                    <div>
                      <p className="text-xs text-muted-foreground">SSID</p>
                      <p className="font-medium">{wifiStatus.ssid || "-"}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Signal</p>
                      <p className="font-medium flex items-center gap-1">
                        {wifiStatus.signal} dBm
                        {getSignalIcon(wifiStatus.signal + 100)}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">IP Locale</p>
                      <p className="font-mono text-xs">{wifiStatus.ipLocal}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">IP Publique</p>
                      <p className="font-mono text-xs">{wifiStatus.ipPublic || "-"}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Debit TX</p>
                      <p className="font-medium">{wifiStatus.txRate || "-"}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Debit RX</p>
                      <p className="font-medium">{wifiStatus.rxRate || "-"}</p>
                    </div>
                    <div className="col-span-2 pt-2 border-t border-border/50">
                      <p className="text-xs text-muted-foreground mb-1">Connectivite Internet</p>
                      {wifiStatus.hasInternet ? (
                        <div className="flex items-center gap-3">
                          <span className="flex items-center gap-1.5 text-success text-xs font-medium">
                            <CheckCircle2 className="h-3 w-3" />
                            Connecte
                          </span>
                          {wifiStatus.pingMs > 0 && (
                            <span className="text-xs text-muted-foreground">
                              Ping: {wifiStatus.pingMs} ms
                            </span>
                          )}
                          {wifiStatus.downloadSpeed && (
                            <span className="text-xs text-muted-foreground">
                              DL: {wifiStatus.downloadSpeed}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="flex items-center gap-1.5 text-destructive text-xs font-medium">
                          <AlertCircle className="h-3 w-3" />
                          Pas d&apos;acces Internet
                        </span>
                      )}
                    </div>
                  </div>
                )
              ) : (
                <p className="text-xs text-muted-foreground pl-6">Non connecte</p>
              )}
            </div>

            <div className="border-t border-border" />

            {/* Ethernet Section */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                {ethernetStatus?.connected ? (
                  <Network className="h-4 w-4 text-success" />
                ) : (
                  <Network className="h-4 w-4 text-muted-foreground" />
                )}
                <span className="font-medium">Ethernet</span>
                {ethernetStatus?.connected && (
                  <span className="text-xs text-success ml-auto">Connecte</span>
                )}
              </div>
              {ethernetStatus?.connected ? (
                <div className="pl-6 text-sm">
                  <p className="text-xs text-muted-foreground">IP Locale</p>
                  <p className="font-mono text-xs">{ethernetStatus.ipLocal}</p>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground pl-6">Non connecte</p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Tailscale VPN Card */}
        <Card className="border-border bg-card">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${
                  tsStatus?.running && tsStatus.online ? "bg-success/10" : "bg-muted"
                }`}>
                  {tsStatus?.running && tsStatus.online ? (
                    <ShieldCheck className="h-5 w-5 text-success" />
                  ) : tsStatus?.installed ? (
                    <ShieldOff className="h-5 w-5 text-muted-foreground" />
                  ) : (
                    <Shield className="h-5 w-5 text-muted-foreground" />
                  )}
                </div>
                <div>
                  <CardTitle className="text-lg">Tailscale VPN</CardTitle>
                  <CardDescription>
                    {!tsStatus?.installed 
                      ? "Non installe" 
                      : tsStatus.running && tsStatus.online
                        ? "Connecte au reseau"
                        : tsStatus.running
                          ? "En cours de connexion..."
                          : "Deconnecte"}
                  </CardDescription>
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={fetchTailscale} disabled={tsLoading} className="bg-transparent">
                <RefreshCw className={`h-4 w-4 ${tsLoading ? "animate-spin" : ""}`} />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {!tsStatus?.installed ? (
              <div className="text-sm text-muted-foreground">
                <p>Tailscale n&apos;est pas installe sur ce Pi.</p>
                <p className="mt-1 font-mono text-xs bg-secondary rounded px-2 py-1">
                  curl -fsSL https://tailscale.com/install.sh | sh
                </p>
              </div>
            ) : (
              <>
                {/* Connection info */}
                {tsStatus.running && tsStatus.online && (
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <p className="text-xs text-muted-foreground">IP Tailscale</p>
                        <div className="flex items-center gap-1.5">
                          <p className="font-mono text-xs">{tsStatus.tailscaleIp}</p>
                          <button
                            onClick={() => navigator.clipboard.writeText(tsStatus.tailscaleIp)}
                            className="text-muted-foreground hover:text-foreground transition-colors"
                            title="Copier"
                          >
                            <Copy className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Hostname</p>
                        <p className="font-mono text-xs">{tsStatus.hostname}</p>
                      </div>
                      {tsStatus.magicDns && (
                        <div className="col-span-2">
                          <p className="text-xs text-muted-foreground">Magic DNS</p>
                          <div className="flex items-center gap-1.5">
                            <p className="font-mono text-xs truncate">{tsStatus.magicDns}</p>
                            <button
                              onClick={() => navigator.clipboard.writeText(tsStatus.magicDns)}
                              className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                              title="Copier"
                            >
                              <Copy className="h-3 w-3" />
                            </button>
                          </div>
                        </div>
                      )}
                      <div>
                        <p className="text-xs text-muted-foreground">Version</p>
                        <p className="text-xs">{tsStatus.version}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Exit Node</p>
                        <p className="text-xs">{tsStatus.exitNode ? "Actif" : "Desactive"}</p>
                      </div>
                    </div>
                  </div>
                )}
                
                {/* Auth URL if needed */}
                {tsStatus.authUrl && (
                  <Alert className="border-amber-500/50 bg-amber-500/10">
                    <AlertTriangle className="h-4 w-4 text-amber-500" />
                    <AlertDescription className="text-amber-500 text-xs">
                      <a href={tsStatus.authUrl} target="_blank" rel="noopener noreferrer" className="underline flex items-center gap-1">
                        Authentifier ce device <ExternalLink className="h-3 w-3" />
                      </a>
                    </AlertDescription>
                  </Alert>
                )}
                
                {tsMessage && (
                  <Alert className={
                    tsMessage.type === "success" ? "border-success/50 bg-success/10" :
                    tsMessage.type === "auth" ? "border-amber-500/50 bg-amber-500/10" :
                    "border-destructive/50 bg-destructive/10"
                  }>
                    {tsMessage.type === "success" ? <CheckCircle2 className="h-4 w-4 text-success" /> :
                     tsMessage.type === "auth" ? <AlertTriangle className="h-4 w-4 text-amber-500" /> :
                     <AlertCircle className="h-4 w-4 text-destructive" />}
                    <AlertDescription className={
                      tsMessage.type === "success" ? "text-success text-xs" :
                      tsMessage.type === "auth" ? "text-amber-500 text-xs" :
                      "text-destructive text-xs"
                    }>
                      {tsMessage.text}
                      {tsMessage.url && (
                        <a href={tsMessage.url} target="_blank" rel="noopener noreferrer" className="ml-2 underline inline-flex items-center gap-1">
                          Ouvrir <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </AlertDescription>
                  </Alert>
                )}
                
                {/* Peers list */}
                {tsStatus.running && tsStatus.online && tsStatus.peers.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground font-medium">
                      Machines ({tsStatus.peers.filter(p => p.online).length}/{tsStatus.peers.length} en ligne)
                    </p>
                    <ScrollArea className="h-44 rounded-md border border-border">
                      <div className="p-2 space-y-1">
                        {tsStatus.peers.map((peer) => {
                          const OsIcon = getPeerOsIcon(peer.os)
                          return (
                            <div
                              key={peer.id}
                              className={`flex items-center gap-2.5 p-2 rounded-md text-sm ${
                                peer.online ? "bg-secondary/50" : "opacity-50"
                              }`}
                            >
                              <OsIcon className={`h-4 w-4 shrink-0 ${peer.online ? "text-primary" : "text-muted-foreground"}`} />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-xs font-medium truncate">{peer.hostname}</span>
                                  {peer.online && (
                                    <span className="h-1.5 w-1.5 rounded-full bg-success shrink-0" />
                                  )}
                                  {peer.isExitNode && (
                                    <Badge variant="outline" className="text-[9px] px-1 py-0 border-success/50 text-success">EXIT</Badge>
                                  )}
                                </div>
                                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                                  <span className="font-mono">{peer.ip}</span>
                                  <span>{peer.os}</span>
                                  {peer.online && (peer.rxBytes > 0 || peer.txBytes > 0) && (
                                    <span>rx:{formatBytes(peer.rxBytes)} tx:{formatBytes(peer.txBytes)}</span>
                                  )}
                                </div>
                              </div>
                              {peer.exitNodeOption && !peer.isExitNode && peer.online && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 shrink-0"
                                  onClick={() => handleTsExitNode(peer.ip)}
                                  disabled={!!tsAction}
                                  title="Utiliser comme exit node"
                                >
                                  <Globe className="h-3 w-3" />
                                </Button>
                              )}
                              {peer.isExitNode && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 shrink-0 text-success"
                                  onClick={() => handleTsExitNode("")}
                                  disabled={!!tsAction}
                                  title="Desactiver exit node"
                                >
                                  <Globe className="h-3 w-3" />
                                </Button>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </ScrollArea>
                  </div>
                )}
                
                {/* Action buttons */}
                <div className="flex gap-2">
                  {tsStatus.running ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleTsDown}
                      disabled={!!tsAction}
                      className="gap-1.5 bg-transparent"
                    >
                      {tsAction === "down" ? <Loader2 className="h-3 w-3 animate-spin" /> : <PowerOff className="h-3 w-3" />}
                      Deconnecter
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      onClick={handleTsUp}
                      disabled={!!tsAction}
                      className="gap-1.5"
                    >
                      {tsAction === "up" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Power className="h-3 w-3" />}
                      Connecter
                    </Button>
                  )}
                  {tsStatus.running && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleTsLogout}
                      disabled={!!tsAction}
                      className="gap-1.5 text-destructive hover:text-destructive bg-transparent"
                    >
                      {tsAction === "logout" ? <Loader2 className="h-3 w-3 animate-spin" /> : <LogOut className="h-3 w-3" />}
                      Logout
                    </Button>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Wi-Fi Networks Card */}
        <Card className="border-border bg-card">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                  <Network className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <CardTitle className="text-lg">Reseaux disponibles</CardTitle>
                  <CardDescription>Selectionnez un reseau Wi-Fi</CardDescription>
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={handleScan} disabled={isScanning}>
                <RefreshCw className={`h-4 w-4 mr-2 ${isScanning ? "animate-spin" : ""}`} />
                Scanner
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {wifiError && (
              <Alert className="border-destructive/50 bg-destructive/10">
                <AlertTriangle className="h-4 w-4 text-destructive" />
                <AlertDescription className="text-destructive">{wifiError}</AlertDescription>
              </Alert>
            )}
            {wifiSuccess && (
              <Alert className="border-success/50 bg-success/10">
                <CheckCircle2 className="h-4 w-4 text-success" />
                <AlertDescription className="text-success">{wifiSuccess}</AlertDescription>
              </Alert>
            )}

            <ScrollArea className="h-48 rounded-md border border-border">
              <div className="p-2 space-y-1">
                {networks.map((network) => (
                  <button
                    key={network.bssid || network.ssid}
                    onClick={() => setSelectedNetwork(network.ssid)}
                    className={`w-full flex items-center justify-between p-2 rounded-md text-left transition-colors ${
                      selectedNetwork === network.ssid
                        ? "bg-primary/20 border border-primary"
                        : "hover:bg-secondary"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {network.security !== "Open" && network.security !== "" ? (
                        <Lock className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <Unlock className="h-4 w-4 text-muted-foreground" />
                      )}
                      <span className="font-medium">{network.ssid}</span>
                      {savedNetworks.includes(network.ssid) && (
                        <Star className="h-3 w-3 text-warning fill-warning" title="Reseau enregistre" />
                      )}
                      {wifiStatus?.ssid === network.ssid && (
                        <CheckCircle2 className="h-4 w-4 text-success" />
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">{network.signal}%</span>
                      {getSignalIcon(network.signal)}
                    </div>
                  </button>
                ))}
                {networks.length === 0 && !isScanning && (
                  <p className="text-center text-muted-foreground text-sm py-4">
                    Aucun reseau trouve
                  </p>
                )}
              </div>
            </ScrollArea>

            {selectedNetwork && (
              <div className="space-y-3 pt-2 border-t border-border">
                <div className="flex items-center gap-2">
                  <p className="font-medium">Connexion a: {selectedNetwork}</p>
                  {savedNetworks.includes(selectedNetwork) && (
                    <span className="text-xs bg-warning/20 text-warning px-2 py-0.5 rounded flex items-center gap-1">
                      <Star className="h-3 w-3 fill-warning" />
                      Enregistre
                    </span>
                  )}
                </div>
                {savedNetworks.includes(selectedNetwork) ? (
                  <p className="text-sm text-muted-foreground">
                    Ce reseau est deja enregistre. Cliquez sur Se connecter pour vous reconnecter.
                  </p>
                ) : (
                  <div className="space-y-2">
                    <Label htmlFor="wifi-password">Mot de passe</Label>
                    <div className="relative">
                      <Input
                        id="wifi-password"
                        type={showPassword ? "text" : "password"}
                        value={wifiPassword}
                        onChange={(e) => setWifiPassword(e.target.value)}
                        placeholder="Mot de passe Wi-Fi"
                        className="pr-10"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                        onClick={() => setShowPassword(!showPassword)}
                      >
                        {showPassword ? (
                          <EyeOff className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <Eye className="h-4 w-4 text-muted-foreground" />
                        )}
                      </Button>
                    </div>
                  </div>
                )}
                <Button onClick={handleConnect} disabled={isConnecting} className="w-full">
                  {isConnecting ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Wifi className="h-4 w-4 mr-2" />
                  )}
                  {isConnecting ? "Connexion..." : "Se connecter"}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* System Updates Card */}
        <Card className="border-border bg-card lg:col-span-2">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <Terminal className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-lg">Mises a jour systeme</CardTitle>
                <CardDescription>apt update & upgrade</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-3">
              <Button
                onClick={handleAptUpdate}
                disabled={aptOutput.running}
                variant="outline"
                className="gap-2 bg-transparent"
              >
                <Download className="h-4 w-4" />
                apt update
              </Button>
              <Button
                onClick={handleAptUpgrade}
                disabled={aptOutput.running}
                variant="outline"
                className="gap-2 bg-transparent"
              >
                <ArrowUpCircle className="h-4 w-4" />
                apt upgrade
              </Button>
              {aptOutput.running && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-sm">{aptOutput.command} en cours...</span>
                </div>
              )}
            </div>

            {aptOutput.lines.length > 0 && (
              <ScrollArea className="h-64 rounded-md border border-border bg-secondary/30 p-3">
                <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap">
                  {aptOutput.lines.join("\n")}
                </pre>
              </ScrollArea>
            )}
          </CardContent>
        </Card>

        {/* Aurige Update Card */}
        <Card className="border-border bg-card">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-success/10">
                  <GitBranch className="h-5 w-5 text-success" />
                </div>
                <div>
                  <CardTitle className="text-lg">Mise a jour Aurige</CardTitle>
                  <CardDescription>Version et mise a jour depuis Git</CardDescription>
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={fetchVersionInfo} disabled={isCheckingVersion} className="bg-transparent">
                <RefreshCw className={`h-4 w-4 ${isCheckingVersion ? "animate-spin" : ""}`} />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {versionInfo ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">Branche actuelle</p>
                    <p className="font-mono">{versionInfo.branch}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Commit</p>
                    <p className="font-mono">{versionInfo.commit}</p>
                  </div>
                  {versionInfo.commitDate && (
                    <div className="col-span-2">
                      <p className="text-xs text-muted-foreground">Date</p>
                      <p className="text-sm">{versionInfo.commitDate}</p>
                    </div>
                  )}
                </div>
                
                {/* Branch selector */}
                <div className="space-y-2 rounded-lg border border-border/50 bg-secondary/20 p-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <GitBranch className="h-3.5 w-3.5 text-primary" />
                      <p className="text-xs font-medium">Branche cible</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={fetchBranches}
                      disabled={isFetchingBranches}
                      className="h-6 px-2 text-xs"
                    >
                      <RefreshCw className={`h-3 w-3 mr-1 ${isFetchingBranches ? "animate-spin" : ""}`} />
                      Actualiser
                    </Button>
                  </div>
                  <div className="relative">
                    <select
                      value={selectedBranch}
                      onChange={(e) => setSelectedBranch(e.target.value)}
                      disabled={updateOutput.running || isFetchingBranches}
                      className="w-full appearance-none rounded-md border border-border bg-background px-3 py-2 pr-8 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
                    >
                      {!gitBranches && (
                        <option value="">Chargement des branches...</option>
                      )}
                      {gitBranches?.branches.map((branch) => (
                        <option key={branch} value={branch}>
                          {branch}
                          {branch === versionInfo.branch ? " (actuelle)" : ""}
                          {branch === gitBranches.current && branch !== versionInfo.branch ? " (sauvegardee)" : ""}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                  </div>
                  {selectedBranch && selectedBranch !== versionInfo.branch && (
                    <p className="text-[11px] text-warning flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3" />
                      Changement de branche : {versionInfo.branch} → {selectedBranch}
                    </p>
                  )}
                </div>
                
                {versionInfo.updateAvailable && (
                  <Alert className="border-success/50 bg-success/10">
                    <ArrowUpCircle className="h-4 w-4 text-success" />
                    <AlertDescription className="text-success">
                      {versionInfo.commitsBehind} commit(s) disponible(s)
                    </AlertDescription>
                  </Alert>
                )}
                <Button
                  onClick={handleStartUpdate}
                  disabled={updateOutput.running}
                  className="w-full gap-2"
                >
                  {updateOutput.running ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  {updateOutput.running ? "Mise a jour..." : "Mettre a jour Aurige"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    try {
                      await restartServices()
                      setTimeout(() => {
                        window.location.reload()
                      }, 3000)
                    } catch (e) {
                      console.error("Failed to restart services:", e)
                    }
                  }}
                  className="gap-2 bg-transparent"
                >
                  <RotateCcw className="h-4 w-4" />
                  Redemarrer services
                </Button>
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">Chargement...</p>
            )}

            {updateOutput.lines.length > 0 && (
              <div className="space-y-2">
                {/* Success/Error indicator */}
                {!updateOutput.running && updateOutput.lines.length > 0 && (
                  updateOutput.success || updateOutput.lines.some(l => l.includes("[OK]") || l.includes("Update complete") || l.includes("Installation Complete")) ? (
                    <Alert className="border-success/50 bg-success/10">
                      <CheckCircle2 className="h-4 w-4 text-success" />
                      <AlertDescription className="text-success flex items-center gap-2">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Mise a jour terminee! Rechargement automatique...
                      </AlertDescription>
                    </Alert>
                  ) : updateOutput.error || updateOutput.lines.some(l => l.includes("[ERROR]")) ? (
                    <Alert className="border-destructive/50 bg-destructive/10">
                      <AlertTriangle className="h-4 w-4 text-destructive" />
                      <AlertDescription className="text-destructive">
                        Erreur lors de la mise a jour. Verifiez les logs ci-dessous.
                      </AlertDescription>
                    </Alert>
                  ) : null
                )}
                <ScrollArea className="h-32 rounded-md border border-border bg-secondary/30 p-3">
                  <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap">
                    {updateOutput.lines.join("\n")}
                  </pre>
                </ScrollArea>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Backup Card */}
        <Card className="border-border bg-card">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <Archive className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-lg">Sauvegardes</CardTitle>
                <CardDescription>Sauvegarde des donnees missions</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Archive le dossier <code className="bg-secondary px-1 rounded">/opt/aurige/data/</code> contenant toutes les missions, captures CAN, logs d{"'"}isolation et fichiers DBC. Utilisez la restauration pour recuperer vos donnees apres un crash ou reinstallation.
            </p>
            <Button
              onClick={handleCreateBackup}
              disabled={isCreatingBackup}
              className="w-full gap-2"
            >
              {isCreatingBackup ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <HardDrive className="h-4 w-4" />
              )}
              {isCreatingBackup ? "Sauvegarde..." : "Creer une sauvegarde"}
            </Button>

            {backupMessage && (
              <Alert className={needsRestart ? "border-warning/50 bg-warning/10" : "border-muted"}>
                {needsRestart ? <AlertTriangle className="h-4 w-4 text-warning" /> : <CheckCircle2 className="h-4 w-4" />}
                <AlertDescription className={needsRestart ? "text-warning" : ""}>{backupMessage}</AlertDescription>
              </Alert>
            )}

            {needsRestart && (
              <Button
                onClick={handleRestartServices}
                disabled={isRestarting}
                variant="outline"
                className="w-full gap-2 border-warning text-warning hover:bg-warning/10 bg-transparent"
              >
                {isRestarting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                {isRestarting ? "Redemarrage..." : "Redemarrer les services"}
              </Button>
            )}

            {backups.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground font-medium">Sauvegardes existantes</p>
                <ScrollArea className="h-40">
                  <div className="space-y-2">
                    {backups.map((backup) => (
                      <div key={backup.filename} className="flex items-center justify-between p-2 rounded bg-secondary/50">
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-mono truncate">{backup.filename}</p>
                          <p className="text-xs text-muted-foreground">
                            {backup.size > 0 ? `${(backup.size / 1024 / 1024).toFixed(2)} Mo` : "Vide"}
                          </p>
                        </div>
                        <div className="flex gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-primary"
                            onClick={() => handleRestoreBackup(backup.filename)}
                            title="Restaurer"
                          >
                            <RotateCcw className="h-3 w-3" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-destructive"
                            onClick={() => handleDeleteBackup(backup.filename)}
                            title="Supprimer"
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Power Controls Card */}
        <Card className="border-border bg-card lg:col-span-2">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-destructive/10">
                <Power className="h-5 w-5 text-destructive" />
              </div>
              <div>
                <CardTitle className="text-lg">Alimentation</CardTitle>
                <CardDescription>Redemarrage et arret du systeme</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {systemMessage && (
              <Alert className="border-warning/50 bg-warning/10">
                <AlertTriangle className="h-4 w-4 text-warning" />
                <AlertDescription className="text-warning">{systemMessage}</AlertDescription>
              </Alert>
            )}
            <div className="flex gap-3">
              <Button
                onClick={handleReboot}
                disabled={isRebooting || isShuttingDown}
                variant="outline"
                className="gap-2 bg-transparent"
              >
                {isRebooting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                Redemarrer
              </Button>
              <Button
                onClick={handleShutdown}
                disabled={isRebooting || isShuttingDown}
                variant="destructive"
                className="gap-2"
              >
                {isShuttingDown ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <PowerOff className="h-4 w-4" />
                )}
                Eteindre
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Licence */}
        <Card className="border-border bg-card lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                  <Scale className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <CardTitle className="text-lg">Licence</CardTitle>
                  <CardDescription>Propriete intellectuelle et conditions d{"'"}utilisation</CardDescription>
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={() => setShowLicence(!showLicence)} className="bg-transparent gap-2">
                <ChevronRight className={`h-4 w-4 transition-transform ${showLicence ? "rotate-90" : ""}`} />
                {showLicence ? "Masquer" : "Voir la licence"}
              </Button>
            </div>
          </CardHeader>
          {showLicence && (
            <CardContent>
              <ScrollArea className="h-[400px]">
                <pre className="whitespace-pre-wrap text-xs font-mono text-muted-foreground leading-relaxed p-4 rounded-lg bg-muted/30 border border-border/30">
{`AURIGE - Mastery of CAN
Licence proprietaire - Tous droits reserves

Copyright (c) 2024-2026 Yoann ETE / AURIGE.

AVIS DE PROPRIETE INTELLECTUELLE

Ce logiciel, incluant sans limitation son code source, son architecture,
ses algorithmes, ses interfaces utilisateur, sa documentation et tous les
materiaux associes (ci-apres "le Logiciel"), est la propriete exclusive
de Yoann ETE / AURIGE.

Le Logiciel fait l'objet d'un depot de brevet couvrant notamment :
- Les algorithmes de detection automatique de signaux CAN par analyse
  entropique et correlation temporelle
- La methode d'analyse des dependances inter-ID par fenetre temporelle
  glissante avec calcul de lift probabiliste
- Le procede de validation causale par injection controlee et observation
  de reactions sur bus CAN
- L'architecture integree d'analyse forensique CAN embarquee

RESTRICTIONS

Sauf accord ecrit prealable du titulaire des droits, il est STRICTEMENT
INTERDIT de :

1. Reproduire, copier ou dupliquer tout ou partie du Logiciel
2. Distribuer, publier ou rendre accessible le Logiciel a des tiers
3. Modifier, adapter, traduire ou creer des oeuvres derivees du Logiciel
4. Decompiler, desassembler ou tenter d'extraire le code source
5. Utiliser le Logiciel a des fins commerciales
6. Sous-licencier, louer ou preter le Logiciel
7. Retirer ou modifier les mentions de propriete intellectuelle

LIMITATION DE RESPONSABILITE

LE LOGICIEL EST FOURNI "EN L'ETAT", SANS GARANTIE D'AUCUNE SORTE.

AVERTISSEMENT DE SECURITE

Ce logiciel permet l'injection de trames sur un bus CAN automobile.
L'utilisation sur un vehicule en circulation est STRICTEMENT INTERDITE
et peut mettre en danger la securite des personnes.

CONTACT : contact@aurige.io`}
                </pre>
              </ScrollArea>
            </CardContent>
          )}
        </Card>

        {/* Guide d'utilisation */}
        <Card className="border-border bg-card lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                  <BookOpen className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <CardTitle className="text-lg">Guide d{"'"}utilisation</CardTitle>
                  <CardDescription>Notice complete de chaque page et fonctionnalite</CardDescription>
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={() => setShowGuide(!showGuide)} className="bg-transparent gap-2">
                <ChevronRight className={`h-4 w-4 transition-transform ${showGuide ? "rotate-90" : ""}`} />
                {showGuide ? "Masquer" : "Ouvrir le guide"}
              </Button>
            </div>
          </CardHeader>
          {showGuide && (
            <CardContent>
              <div className="space-y-2">
                {[
                  {
                    id: "dashboard", icon: Globe, title: "Dashboard",
                    content: "Page d'accueil affichant l'etat general du systeme : statut de connexion au Raspberry Pi, missions actives, acces rapide aux modules. Permet de creer une nouvelle mission via l'assistant vehicule (marque, modele, annee, VIN, motorisation)."
                  },
                  {
                    id: "missions", icon: FileText, title: "Mission",
                    content: "Vue detaillee d'une mission : informations vehicule, statistiques (nombre de logs, trames decouvertes, interface/bitrate), derniere capture. Actions disponibles : renommer, modifier le vehicule, exporter (ZIP), supprimer. Donne acces a tous les modules d'analyse depuis une grille de raccourcis."
                  },
                  {
                    id: "controle-can", icon: Settings, title: "Controle CAN",
                    content: "Configuration de l'interface CAN du Raspberry Pi. Permet de monter/demonter les interfaces (can0, can1, vcan0), definir le bitrate (125k, 250k, 500k, 1M), activer le mode listen-only. Affiche l'etat temps reel de chaque interface avec statistiques de trames TX/RX."
                  },
                  {
                    id: "capture-replay", icon: Video, title: "Capture & Replay",
                    content: "Enregistrement de sessions CAN avec candump. Nommez le fichier de capture (ou laissez le nom auto-genere avec horodatage), ajoutez une description. La capture enregistre toutes les trames du bus CAN selectionne. Replay : rejouer un log enregistre sur le bus CAN pour reproduire un scenario. Gestion des logs avec parentage (log parent / enfant pour tracer les derivations)."
                  },
                  {
                    id: "replay-rapide", icon: Zap, title: "Replay Rapide",
                    content: "Rejeu rapide d'un log CAN avec controle de vitesse (1x, 2x, 5x, 10x). Permet de filtrer les IDs a rejouer, de definir une plage temporelle, et d'observer les reactions du vehicule en temps reel via le CAN Sniffer."
                  },
                  {
                    id: "isolation", icon: GitBranch, title: "Isolation",
                    content: "Isole les trames par fonction vehicule. Methode : (1) capturer un log de reference (etat repos), (2) capturer un log pendant une action (ex: ouverture porte), (3) comparer automatiquement pour isoler les trames specifiques a l'action. Supporte le mode live (capture + comparaison en un clic) et le mode manuel (selection de 2 logs existants). Resultat : liste des IDs et bytes qui changent, avec possibilite de rejouer uniquement les trames isolees."
                  },
                  {
                    id: "comparaison", icon: GitCompare, title: "Comparaison",
                    content: "Compare deux logs CAN cote a cote. Affiche les differences par ID : trames presentes/absentes, payloads differents, frequences modifiees. Vue diff coloree byte par byte. Supporte les logs parents/enfants dans les selecteurs. Utile pour verifier l'effet d'une modification ou comparer deux etats du vehicule."
                  },
                  {
                    id: "analyse-can", icon: BarChart3, title: "Analyse CAN",
                    content: "Trois onglets d'analyse avancee :\n\n- Heatmap : visualisation byte par byte de chaque ID CAN. Couleur = entropie (bleu = statique, rouge = tres variable). Cliquez sur un ID pour voir le detail de chaque byte avec min/max/valeurs uniques.\n\n- Auto-detect : detection automatique de signaux dans les logs. Analyse entropique et correlationnelle pour identifier les bytes qui forment un signal coherent (compteur, temperature, etc.). Propositions de configuration DBC avec un clic pour sauvegarder.\n\n- Dependances : graphe des dependances inter-ID. Detecte quels IDs reagissent apres un changement de payload sur un autre ID. Affiche les aretes SOURCE -> CIBLE avec score de correlation, lift probabiliste, et co-occurrences. Bouton 'Valider causalite' pour tester experimentalement par injection CAN."
                  },
                  {
                    id: "dbc", icon: FileCode, title: "DBC",
                    content: "Gestion des signaux DBC (Database CAN). Import de fichiers .dbc standards. Edition manuelle des signaux : nom, ID CAN, bit de depart, longueur, facteur, offset, unite, endianness (little/big). Les signaux DBC sont utilises par le CAN Sniffer pour decoder les trames en temps reel et par l'auto-detect pour proposer des configurations."
                  },
                  {
                    id: "obd-ii", icon: Activity, title: "OBD-II",
                    content: "Diagnostics OBD-II standard. Lecture des PIDs standards (regime moteur, vitesse, temperature, pression, etc.). Lecture/effacement des codes defaut (DTC). Monitoring temps reel avec graphiques. Compatible avec les vehicules equipes d'un port OBD-II standard (ISO 15765-4)."
                  },
                  {
                    id: "signal-finder", icon: Search, title: "Signal Finder",
                    content: "Recherche de signaux par action physique. Methode : (1) selectionner un log CAN, (2) definir une hypothese (ex: 'signal de vitesse'), (3) l'algorithme analyse les correlations entre les bytes CAN et identifie les candidats les plus probables. Filtrage par plage d'ID, longueur de signal, type (compteur, analogique, booleen)."
                  },
                  {
                    id: "fuzzing", icon: Flame, title: "Fuzzing",
                    content: "Tests de fuzzing CAN pour decouvrir des fonctions cachees. Modes : aleatoire (payloads random sur un ID), sequentiel (incrementation systematique), cible (mutation d'un payload connu). Parametres : ID cible, plage de bytes, intervalle entre trames, nombre d'iterations. Journalisation de chaque trame envoyee avec horodatage pour analyse post-mortem."
                  },
                  {
                    id: "crash-recovery", icon: ShieldAlert, title: "Crash Recovery",
                    content: "Analyse forensique post-fuzzing. Permet de restaurer l'etat du vehicule apres un test de fuzzing en rejouant le log de reference (pre-fuzzing). Compare l'etat actuel avec l'etat de reference pour identifier les ecarts persistants. Selecteur de logs avec hierarchie parent/enfant."
                  },
                  {
                    id: "generateur", icon: Cpu, title: "Generateur",
                    content: "Generation de trames CAN personnalisees. Definissez l'ID, le payload (hex), l'interface, et l'intervalle d'envoi. Mode burst : envoi rapide de N trames. Mode continu : envoi periodique jusqu'a arret manuel. Utile pour simuler un ECU, tester une hypothese, ou reproduire un comportement specifique."
                  },
                  {
                    id: "configuration", icon: Settings, title: "Configuration Pi",
                    content: "Administration du Raspberry Pi. Wi-Fi : scan, connexion, mode hotspot. Ethernet : etat et IP. Tailscale VPN : connexion, peers, exit nodes. Systeme : apt update/upgrade, redemarrage, arret. Git : branches, mise a jour Aurige. Sauvegardes : creation, restauration, suppression."
                  },
                ].map((section) => (
                  <div key={section.id} className="rounded-lg border border-border/50 overflow-hidden">
                    <button
                      onClick={() => setGuideSection(guideSection === section.id ? null : section.id)}
                      className="w-full flex items-center gap-3 p-3 hover:bg-muted/30 transition-colors text-left"
                    >
                      <section.icon className="h-4 w-4 text-primary shrink-0" />
                      <span className="text-sm font-medium text-foreground flex-1">{section.title}</span>
                      <ChevronRight className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${guideSection === section.id ? "rotate-90" : ""}`} />
                    </button>
                    {guideSection === section.id && (
                      <div className="px-3 pb-3 pt-0">
                        <div className="rounded-md bg-muted/20 p-3 border border-border/30">
                          <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-line">{section.content}</p>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          )}
        </Card>

        {/* CAN Sniffer guide */}
        <Card className="border-border bg-card lg:col-span-2">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <Terminal className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-lg">CAN Sniffer (fenetre flottante)</CardTitle>
                <CardDescription>Disponible sur toutes les pages via le bouton en bas a droite</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="rounded-md bg-muted/20 p-4 border border-border/30">
              <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-line">
{`Terminal CAN temps reel, accessible depuis n'importe quelle page.

Fonctions :
- Start/Stop : demarrer ou arreter l'ecoute candump sur l'interface selectionnee
- Pause/Resume : geler l'affichage sans arreter la capture
- Highlight Changes : colorer les bytes qui changent entre deux trames (mode Payload, Signal ou Both)
- Changed Only : n'afficher que les IDs dont le payload a change
- Noisy filter (N) : masquer les IDs trop bruyants (changent a chaque trame)
- DBC overlay : decoder les trames en temps reel avec les signaux DBC definis
- Interface : selectionner can0, can1 ou vcan0
- Expand/Minimize : agrandir en plein ecran ou minimiser en icone
- Clear : vider l'affichage

Colonnes : ID CAN | Message DBC | DLC | Data (bytes colores) | Cycle (ms) | Count
La fenetre est deplacable (drag) et redimensionnable.`}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Copyright footer */}
      <div className="mt-8 border-t border-border/50 pt-6 pb-4 text-center">
        <p className="text-xs text-muted-foreground">
          {"(c) 2026 Yoann ETE. Tous droits reserves."}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          {"AURIGE\u2122 est un projet protege."}
        </p>
        <p className="text-[10px] text-muted-foreground/60 mt-1">
          Reproduction interdite sans autorisation.
        </p>
      </div>
    </AppShell>
  )
}
