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
                    content: `Page d'accueil et centre de controle d'AURIGE.

ELEMENTS DE L'INTERFACE :
- Carte "Etat du systeme" : indicateur vert/rouge de connexion au Raspberry Pi avec l'adresse IP courante. Si rouge, verifiez que le Pi est allume et sur le meme reseau.
- Bouton "Nouvelle mission" : ouvre l'assistant de creation. Remplissez : nom de la mission, marque du vehicule, modele, annee, VIN (optionnel), motorisation (essence/diesel/hybride/electrique).
- Liste des missions recentes : cliquez sur une mission pour l'ouvrir. L'icone etoile permet de la marquer comme favorite.

CONSEILS :
- Creez une mission par vehicule ou par campagne de tests.
- Le VIN est optionnel mais recommande pour la tracabilite.
- Verifiez la connexion au Pi avant toute operation CAN.`
                  },
                  {
                    id: "missions", icon: FileText, title: "Mission (vue detaillee)",
                    content: `Vue complete d'une mission selectionnee.

INFORMATIONS AFFICHEES :
- En-tete : nom de mission, vehicule (marque / modele / annee), VIN, motorisation.
- Statistiques : nombre de logs captures, trames totales decouvertes, interface et bitrate configures.
- Derniere capture : nom du fichier, date, duree, nombre de trames.

BOUTONS D'ACTION :
- Crayon (Editer) : modifier le nom de la mission et les informations vehicule.
- Telecharger : exporter la mission complete en archive ZIP (logs + config + DBC).
- Corbeille : supprimer definitivement la mission et tous ses logs. Action irreversible.

GRILLE DE RACCOURCIS :
- Chaque carte correspond a un module d'analyse. Cliquez pour y acceder directement dans le contexte de la mission active.
- Les modules affichent une icone, un nom, et une description courte de leur fonction.

CONSEIL : Exportez regulierement vos missions en ZIP pour sauvegarde.`
                  },
                  {
                    id: "controle-can", icon: Settings, title: "Controle CAN",
                    content: `Configuration et gestion des interfaces CAN du Raspberry Pi.

CARTE PAR INTERFACE (can0, can1, vcan0) :
- Indicateur d'etat : vert = montee (UP), rouge = demontee (DOWN).
- Bitrate : selecteur deroulant (125000, 250000, 500000, 1000000 bit/s). Choisissez le bitrate correspondant au bus CAN de votre vehicule. En cas de doute, commencez par 500000 (le plus courant).
- Mode listen-only : cochez pour ecouter sans emettre. Recommande pour la premiere exploration d'un vehicule inconnu.

BOUTONS :
- "Monter" / "Demonter" : active ou desactive l'interface. L'interface doit etre montee avant toute capture ou injection.
- Statistiques TX/RX : nombre de trames envoyees et recues depuis le montage.

INTERFACE VCAN0 :
- Interface CAN virtuelle pour les tests sans vehicule. Utile pour verifier le bon fonctionnement du logiciel.

CONSEILS :
- Montez toujours l'interface AVANT d'ouvrir le CAN Sniffer ou de lancer une capture.
- Si vous ne recevez aucune trame, verifiez le bitrate (essayez 250k puis 500k).
- Le mode listen-only est OBLIGATOIRE sur un vehicule en circulation.`
                  },
                  {
                    id: "capture-replay", icon: Video, title: "Capture & Replay",
                    content: `Enregistrement et rejeu de sessions CAN.

ONGLET CAPTURE :
- Selecteur d'interface : choisissez can0, can1 ou vcan0.
- Champ "Nom du fichier" (optionnel) : nommez votre capture pour la retrouver facilement (ex: "demarrage_moteur", "ouverture_porte"). Si laisse vide, un nom avec horodatage est genere automatiquement. Seuls les caracteres alphanumeriques, tirets et underscores sont autorises.
- Champ "Description" (optionnel) : ajoutez un contexte (ex: "Moteur froid, contact mis, porte fermee").
- Bouton "Demarrer la capture" : lance l'enregistrement candump. Un compteur de duree et de trames s'affiche.
- Bouton "Arreter" : stoppe la capture et sauvegarde le fichier .log.

ONGLET REPLAY :
- Selecteur de log : choisissez parmi vos captures. Les logs sont groupes par famille (parent / enfants) grace a des indentations.
- Selecteur d'interface : interface de sortie pour le rejeu.
- Bouton "Rejouer" : envoie les trames du log sur le bus CAN en respectant les delais originaux.

PARENTAGE DES LOGS :
- Quand un log est derive d'un autre (ex: par isolation), il apparait comme "enfant" dans le selecteur, indente sous son parent. Cela permet de tracer l'origine de chaque fichier.

CONSEILS :
- Nommez TOUJOURS vos captures pour les retrouver facilement.
- Avant un replay, assurez-vous que le vehicule est a l'arret et en securite.
- Utilisez vcan0 pour tester un replay sans vehicule.`
                  },
                  {
                    id: "replay-rapide", icon: Zap, title: "Replay Rapide",
                    content: `Rejeu rapide d'un log CAN avec options avancees.

CONTROLES :
- Selecteur de log : avec hierarchie parent/enfant.
- Selecteur d'interface de sortie.
- Vitesse de replay : boutons 1x, 2x, 5x, 10x. Multiplie la vitesse d'envoi des trames. Utile pour accelerer un long log ou observer un comportement au ralenti (< 1x non supporte, utilisez Capture & Replay pour le timing original).
- Filtre d'IDs : saisissez les IDs CAN a rejouer (ex: "0x100, 0x200"). Si vide, tous les IDs sont rejoues.
- Plage temporelle : definissez un debut et une fin en secondes pour ne rejouer qu'un extrait du log.

BOUTONS :
- "Lancer" : demarre le replay avec les parametres configures.
- "Arreter" : interrompt le replay en cours.
- Barre de progression : affiche l'avancement du rejeu.

CONSEILS :
- Combinez avec le CAN Sniffer ouvert pour observer les reactions en temps reel.
- Utilisez le filtre d'IDs pour rejouer uniquement les trames isolees d'une fonction.
- La vitesse 10x est utile pour les logs tres longs (> 5 min).`
                  },
                  {
                    id: "isolation", icon: GitBranch, title: "Isolation",
                    content: `Module cle pour isoler les trames specifiques a une action vehicule.

PRINCIPE :
Comparer un etat de repos (reference) avec un etat pendant une action (ex: appui sur freins) pour identifier les trames qui changent. Seules les differences significatives sont conservees.

MODE LIVE (recommande pour debuter) :
1. Bouton "Capturer reference" : enregistre 5-10 secondes de bus CAN au repos (moteur tourne, rien ne bouge).
2. Bouton "Capturer action" : cliquez PUIS effectuez l'action vehicule (ouvrir porte, allumer phares, tourner volant, etc.). Enregistre pendant la duree configuree.
3. Bouton "Comparer" : lance automatiquement l'algorithme de comparaison.
Le resultat s'affiche : liste des IDs et bytes qui different entre les deux captures.

MODE MANUEL :
- Selecteur "Log reference" : choisissez un log existant comme reference (etat repos).
- Selecteur "Log action" : choisissez un log capture pendant l'action.
- Bouton "Lancer l'isolation" : compare les deux logs selectionnes.
Utile quand vous avez deja des captures et voulez les comparer a posteriori.

RESULTATS :
- Tableau des differences : chaque ligne = un ID CAN avec les bytes qui changent.
- Colonne "Bytes modifies" : indices des bytes (0-7) qui different entre reference et action, avec la valeur de reference et la valeur pendant l'action.
- Bouton "Rejouer les trames isolees" : genere un log contenant UNIQUEMENT les trames differentes et le rejoue sur le bus. Permet de verifier si l'action est reproduite.
- Bouton "Exporter" : sauvegarde le resultat d'isolation comme nouveau log enfant.

QUALIFIER UNE ISOLATION :
Apres avoir isole des trames, vous pouvez les qualifier :
1. Rejouez les trames isolees (bouton "Replay isole") et observez si l'action se reproduit sur le vehicule.
2. Si oui : vous avez identifie les trames responsables. Sauvegardez en DBC.
3. Si non : affinez en retirant des IDs du resultat un par un et en rejouant a chaque fois. L'ID dont le retrait empeche l'action est le signal cle.

CONSEILS :
- Pendant la capture de reference, ne touchez a RIEN sur le vehicule.
- L'action doit etre nette et unique (un seul geste a la fois).
- Capturez au moins 5 secondes pour chaque phase.
- Si trop de trames changent (> 20 IDs), votre reference n'etait pas assez stable. Recommencez.
- Pour les actions breves (appui bouton), capturez en mode action pendant 3 secondes et appuyez 2-3 fois.`
                  },
                  {
                    id: "comparaison", icon: GitCompare, title: "Comparaison",
                    content: `Comparaison detaillee de deux logs CAN.

SELECTION DES LOGS :
- Selecteur "Log A" et "Log B" : choisissez deux logs a comparer. Les selecteurs affichent les logs avec hierarchie parent/enfant. Vous pouvez comparer un parent avec son enfant, deux captures a des moments differents, ou un log brut avec un log isole.

TYPES DE DIFFERENCES DETECTEES :
- IDs presents uniquement dans A ou uniquement dans B (trames apparues/disparues).
- IDs presents dans les deux mais avec des payloads differents.
- IDs presents dans les deux mais avec des frequences d'emission differentes.

AFFICHAGE DES RESULTATS :
- Vue par ID : cliquez sur un ID pour voir le detail byte par byte.
- Vue diff coloree : les bytes identiques sont gris, les bytes differents sont colores (rouge = valeur A, vert = valeur B).
- Statistiques : nombre total de differences, pourcentage d'IDs communs, frequence moyenne.

BOUTONS :
- "Lancer la comparaison" : execute l'algorithme de comparaison.
- Filtres : afficher uniquement les IDs ajoutes, supprimes, ou modifies.
- "Exporter le diff" : sauvegarde le resultat de comparaison.

CAS D'USAGE :
- Verifier l'effet d'un fuzzing : comparez le log pre-fuzzing avec le log post-fuzzing.
- Analyser une panne intermittente : comparez un log "ca marche" avec un log "ca ne marche pas".
- Valider une isolation : comparez le log complet avec le log isole pour verifier que seules les trames attendues sont presentes.

CONSEILS :
- Comparez toujours des logs captures dans des conditions similaires (meme duree, meme etat vehicule de base).
- Si la comparaison montre trop de differences, verifiez que les deux logs ont ete captures avec le meme bitrate.
- Utilisez les filtres pour vous concentrer sur les IDs modifies uniquement.`
                  },
                  {
                    id: "analyse-can", icon: BarChart3, title: "Analyse CAN",
                    content: `Trois onglets d'analyse avancee pour comprendre le trafic CAN.

--- ONGLET HEATMAP ---

Visualisation de l'entropie byte par byte de chaque ID CAN.

LECTURE DE LA HEATMAP :
- Chaque ligne = un ID CAN. Chaque colonne = un byte (0 a 7).
- Couleur = entropie (variabilite) :
  - Bleu fonce : byte statique (toujours la meme valeur). Souvent un identifiant fixe ou un byte inutilise.
  - Bleu clair/vert : faible variation. Probablement un compteur lent ou un etat binaire.
  - Jaune/orange : variation moyenne. Signal analogique (temperature, tension, angle).
  - Rouge : forte variation. Compteur rapide, signal haute frequence, ou bruit.
- Cliquez sur une ligne pour voir le detail : min, max, valeurs uniques, distribution de chaque byte.

BOUTONS :
- Selecteur de log + mission.
- Filtre par ID : saisissez un ID pour filtrer la vue.
- Bouton "Lancer l'analyse" : genere la heatmap.

--- ONGLET AUTO-DETECT ---

Detection automatique de signaux dans un log CAN.

FONCTIONNEMENT :
L'algorithme analyse l'entropie et les correlations entre bytes consecutifs pour identifier des groupes de bytes formant un signal coherent (ex: bytes 2-3 d'un ID forment un entier 16 bits representant la vitesse).

RESULTATS :
- Liste des signaux detectes : ID CAN, bytes concernes, type probable (compteur, analogique, booleen), confiance (%).
- Bouton "Ajouter au DBC" : sauvegarde le signal detecte directement dans votre base DBC en un clic. Renseigne automatiquement l'ID, le bit de depart, la longueur et le nom suggere.
- Bouton "Ignorer" : masque un signal non pertinent.

CONSEILS :
- Lancez l'auto-detect sur un log avec du trafic varie (moteur tourne + actions).
- Les signaux avec > 70% de confiance sont generalement fiables.
- Verifiez toujours en croisant avec la heatmap et le CAN Sniffer en live.

--- ONGLET DEPENDANCES ---

Graphe des dependances inter-ID : quel ID reagit quand un autre change.

FONCTIONNEMENT :
L'algorithme observe les changements de payload sur chaque ID. Quand l'ID A change, il verifie si l'ID B change aussi dans une fenetre temporelle configurable (defaut : 50 ms). Le "lift" mesure si cette co-occurrence est significative par rapport au hasard.

PARAMETRES :
- Fenetre temporelle (ms) : duree d'observation apres un changement. Augmentez pour capter des reactions lentes, diminuez pour des reactions rapides.
- Seuil de score : filtre les aretes faibles.

RESULTATS :
- Tableau des aretes : Source -> Cible, score de correlation, lift, co-occurrences.
- Cliquez sur une arete pour voir le detail : taux de reaction, payload source, distribution temporelle.

BOUTON "Valider causalite" (icone fiole sur chaque arete) :
1. Cliquez sur l'icone fiole a droite d'une arete.
2. Un avertissement s'affiche : cette operation va INJECTER une trame sur le bus CAN.
3. Selectionnez l'interface CAN (can0, can1, vcan0).
4. Confirmez : le systeme injecte la trame source 5 fois et observe si la cible reagit.
5. Resultat : taux de succes (%), lag median, classification (ELEVEE / MODEREE / FAIBLE).
Causalite ELEVEE (>= 70%) = la dependance est confirmee experimentalement.

CONSEILS :
- La validation causale doit UNIQUEMENT etre utilisee vehicule a l'arret, en environnement de test.
- Un lift > 2 indique une dependance probablement reelle.
- Commencez par les aretes avec le score le plus eleve.`
                  },
                  {
                    id: "dbc", icon: FileCode, title: "DBC",
                    content: `Gestion des signaux DBC (Database CAN).

QU'EST-CE QU'UN SIGNAL DBC ?
Un signal DBC decrit comment decoder un groupe de bits dans une trame CAN : "les bits 16 a 31 de l'ID 0x200 representent la vitesse vehicule en km/h, avec un facteur 0.01".

IMPORT DE FICHIER .DBC :
- Bouton "Importer .dbc" : charge un fichier DBC standard (format Vector). Tous les signaux sont importes et associes a la mission active.
- Les doublons sont detectes et signales.

EDITION MANUELLE :
- Bouton "Ajouter un signal" : cree un signal vide a remplir.
- Champs : Nom du signal, ID CAN (hex), Bit de depart (0-63), Longueur (bits), Facteur (multiplicateur), Offset (decalage), Unite (texte libre, ex: "km/h"), Endianness (Little Endian = Intel, Big Endian = Motorola).
- Bouton "Sauvegarder" : enregistre les modifications.
- Bouton "Supprimer" : retire le signal.

UTILISATION DES SIGNAUX :
- CAN Sniffer : activez l'overlay DBC (bouton fichier vert) pour decoder les trames en temps reel. Les IDs connus affichent le nom du message et les valeurs decodees.
- Auto-detect : les signaux proposes par l'auto-detect sont pre-remplis pour ajout rapide.
- Export : les signaux sont inclus dans l'export ZIP de la mission.

CONSEILS :
- Si vous avez le fichier DBC du constructeur, importez-le en premier.
- Sinon, utilisez l'auto-detect pour generer les premiers signaux puis affinez manuellement.
- Attention a l'endianness : la plupart des vehicules europeens utilisent Big Endian (Motorola), les vehicules americains/asiatiques utilisent souvent Little Endian (Intel).`
                  },
                  {
                    id: "obd-ii", icon: Activity, title: "OBD-II",
                    content: `Diagnostics OBD-II standard via le port OBD du vehicule.

PRE-REQUIS :
- Interface CAN montee et connectee au port OBD-II du vehicule.
- Contact mis (moteur tourne ou non selon les PIDs).

ONGLET PIDs :
- Liste des PIDs standards (Service 01) : regime moteur (RPM), vitesse vehicule, temperature liquide de refroidissement, charge moteur, pression collecteur, etc.
- Bouton "Lire" a cote de chaque PID : envoie la requete OBD et affiche la reponse decodee avec l'unite.
- Bouton "Lire tous" : interroge tous les PIDs supportes par le vehicule en une seule fois.
- Icone graphique : ouvre un graphique temps reel pour le PID selectionne.

ONGLET DTC (Codes defaut) :
- Bouton "Lire les codes" : recupere les codes defaut actifs (DTC) stockes dans le calculateur.
- Affichage : code (ex: P0300), description, type (generique/constructeur).
- Bouton "Effacer les codes" : envoie la commande de reset des DTCs. Eteint le voyant moteur.

ONGLET MONITORING :
- Selection de 1 a 4 PIDs a surveiller simultanement.
- Graphiques temps reel avec historique glissant.
- Frequence de rafraichissement configurable.

CONSEILS :
- Tous les vehicules ne supportent pas tous les PIDs. La fonction "Lire tous" detecte automatiquement les PIDs supportes.
- Effacer les codes defaut ne repare pas la panne, il efface simplement l'historique. Le code reviendra si la panne persiste.
- Pour le monitoring, limitez-vous a 2-3 PIDs simultanes pour garantir une frequence de rafraichissement correcte.`
                  },
                  {
                    id: "signal-finder", icon: Search, title: "Signal Finder",
                    content: `Recherche de signaux CAN par correlation avec une action physique.

METHODE D'UTILISATION :
1. Selectionnez un log CAN dans le selecteur (avec hierarchie parent/enfant).
2. Definissez votre hypothese dans le champ texte : ex: "vitesse vehicule", "angle volant", "pedale frein".
3. Lancez la recherche : l'algorithme analyse les correlations.

PARAMETRES AVANCES :
- Plage d'IDs : restreignez la recherche a une plage (ex: 0x100-0x300) si vous avez une idee de l'ID.
- Longueur de signal : 8 bits, 16 bits, ou auto-detect.
- Type de signal : compteur (valeur incrementale), analogique (valeur continue), booleen (0/1).

RESULTATS :
- Liste des candidats classes par score de correlation.
- Pour chaque candidat : ID CAN, bytes concernes, type detecte, score (%), graphique de la valeur sur le temps.
- Bouton "Ajouter au DBC" : enregistre le signal valide.
- Bouton "Tester en live" : ouvre le CAN Sniffer filtre sur cet ID pour verification.

CONSEILS :
- Utilisez un log capture PENDANT l'action (ex: rouler a differentes vitesses pour chercher le signal vitesse).
- Plus le log contient de variations de l'action, meilleure sera la detection.
- Croisez le resultat avec la heatmap pour confirmer (les bytes du signal doivent etre orange/rouge dans la heatmap).`
                  },
                  {
                    id: "fuzzing", icon: Flame, title: "Fuzzing",
                    content: `Tests de fuzzing CAN pour decouvrir des fonctions et comportements caches.

AVERTISSEMENT : Le fuzzing envoie des trames arbitraires sur le bus CAN. Utilisez UNIQUEMENT vehicule a l'arret, en environnement de test. Ne JAMAIS fuzzer un vehicule en circulation.

MODES DE FUZZING :

1. Mode ALEATOIRE :
   - Envoie des payloads generes aleatoirement sur un ID cible.
   - Parametres : ID cible (hex), nombre d'iterations, intervalle entre trames (ms).
   - Usage : exploration initiale d'un ID inconnu pour observer les reactions.

2. Mode SEQUENTIEL :
   - Incremente systematiquement les valeurs d'un ou plusieurs bytes.
   - Parametres : ID cible, byte(s) a varier (index 0-7), valeur de depart, valeur de fin, pas d'incrementation.
   - Usage : balayage methodique pour trouver les seuils de declenchement d'une fonction.

3. Mode CIBLE :
   - Mute un payload connu en modifiant un byte a la fois.
   - Parametres : ID cible, payload de reference (hex), byte a muter, plage de mutation.
   - Usage : affiner un signal deja partiellement identifie.

BOUTONS :
- "Lancer le fuzzing" : demarre l'envoi des trames selon le mode selectionne.
- "Arreter" : interrompt immediatement le fuzzing.
- "Journal" : affiche chaque trame envoyee avec horodatage, payload, et reaction observee.

JOURNALISATION :
- Chaque session de fuzzing cree automatiquement un log avec toutes les trames envoyees et les horodatages.
- Ce log peut etre rejoue ou compare avec d'autres captures.

CONSEILS :
- TOUJOURS capturer un log de reference AVANT le fuzzing (via Capture & Replay). Il servira pour le Crash Recovery.
- Commencez par le mode aleatoire avec un intervalle long (200 ms) pour observer les reactions.
- Observez le vehicule ET le CAN Sniffer simultanement pendant le fuzzing.
- Si vous observez une reaction (clignotant, bip, mouvement), notez immediatement le numero d'iteration dans le journal.
- Apres le fuzzing, lancez un Crash Recovery si le vehicule est dans un etat anormal.`
                  },
                  {
                    id: "crash-recovery", icon: ShieldAlert, title: "Crash Recovery",
                    content: `Analyse forensique et restauration post-fuzzing.

QUAND UTILISER :
Apres une session de fuzzing, si le vehicule est dans un etat anormal (voyant allume, fonction bloquee, comportement inattendu), utilisez Crash Recovery pour restaurer l'etat initial.

ETAPES :
1. Selectionnez le log de reference (capture effectuee AVANT le fuzzing) dans le selecteur. Les logs sont affiches avec hierarchie parent/enfant.
2. Bouton "Analyser l'ecart" : le systeme capture l'etat actuel du bus CAN et le compare avec la reference pour identifier les divergences.
3. Tableau des ecarts : affiche les IDs dont le payload actuel differe de la reference, avec les valeurs attendues vs observees.
4. Bouton "Restaurer" : rejoue le log de reference sur le bus CAN pour tenter de ramener le vehicule a son etat initial.
5. Bouton "Verifier" : relance une comparaison pour confirmer que la restauration a fonctionne.

CONSEILS :
- La restauration n'est pas toujours possible : certains ECU ne reviennent pas a leur etat precedent par simple rejeu de trames. Un redemarrage du vehicule peut etre necessaire.
- Gardez TOUJOURS un log de reference avant chaque session de fuzzing.
- Si la restauration echoue, coupez le contact, attendez 30 secondes, et redemarrez le vehicule.`
                  },
                  {
                    id: "generateur", icon: Cpu, title: "Generateur de trames",
                    content: `Generation et envoi de trames CAN personnalisees.

PARAMETRES :
- ID CAN (hex) : l'identifiant de la trame a envoyer (ex: "1A0", "7DF").
- Payload (hex) : les donnees a envoyer, 1 a 8 bytes (ex: "00FF0102AABB0011").
- Interface : selectionnez can0, can1 ou vcan0.
- Intervalle (ms) : delai entre chaque envoi en mode continu.

MODES D'ENVOI :

1. Mode UNIQUE :
   - Bouton "Envoyer" : envoie une seule trame avec l'ID et le payload configures.
   - Usage : tester une hypothese precise, reproduire un comportement.

2. Mode BURST :
   - Champ "Nombre de trames" : definissez combien de trames envoyer.
   - Bouton "Burst" : envoie N trames rapidement avec l'intervalle configure.
   - Usage : simuler un signal repetitif, saturer un ID pour observer les reactions.

3. Mode CONTINU :
   - Bouton "Start continu" : envoie la trame en boucle a l'intervalle configure.
   - Bouton "Stop" : arrete l'envoi.
   - Usage : simuler un ECU, maintenir un signal actif pendant un test.

CONSEILS :
- Utilisez vcan0 pour tester vos trames sans vehicule.
- Combinez avec le CAN Sniffer pour observer les reactions en temps reel.
- Pour simuler un compteur qui incremente, utilisez le mode continu et modifiez manuellement le payload a chaque envoi.
- L'intervalle typique pour un signal CAN est de 10-100 ms. En dessous de 5 ms, vous risquez de saturer le bus.`
                  },
                  {
                    id: "cansniffer", icon: Terminal, title: "CAN Sniffer (fenetre flottante)",
                    content: `Terminal CAN temps reel, accessible depuis toutes les pages via le bouton en bas a droite de l'ecran.

OUVRIR / FERMER :
- Cliquez sur l'icone Terminal en bas a droite pour ouvrir la fenetre.
- La fenetre est deplacable (glissez la barre de titre) et redimensionnable (coin inferieur droit).
- Bouton "Minimize" (chevron bas) : reduit en icone.
- Bouton "Expand" (carres) : agrandit en plein ecran.

BARRE DE COMMANDES (icones de gauche a droite) :

- Eclair (Highlight Changes) : colore en surbrillance les bytes qui changent entre deux trames successives du meme ID. Trois modes :
  - Payload : detecte tout changement de byte brut.
  - Signal : detecte les changements en tenant compte des signaux DBC definis.
  - Both : combine les deux modes.

- "N" (Noisy filter) : masque les IDs "bruyants" qui changent a chaque trame (compteurs, checksums). Permet de se concentrer sur les signaux utiles.

- Graphique montant (Changed Only) : n'affiche que les IDs dont le payload a change depuis la derniere mise a jour. Les IDs statiques disparaissent. Tres utile pour isoler visuellement une action.

- Fichier code (DBC overlay) : active le decodage DBC en temps reel. Les IDs reconnus affichent un badge vert "DBC" avec le nom du message. Les IDs inconnus affichent "???".

- Selecteur d'interface : choisissez can0, can1 ou vcan0 AVANT de lancer l'ecoute.

COLONNES DU TABLEAU :
- ID : identifiant CAN en hexadecimal.
- Message : nom DBC si l'overlay est actif.
- L (DLC) : longueur des donnees (1-8 bytes).
- Data : bytes du payload, colores si le highlight est actif (orange = byte qui vient de changer).
- Cycle : temps entre deux trames du meme ID (en ms). Utile pour connaitre la frequence d'emission.
- Count : nombre total de trames recues pour cet ID.

BARRE DE PIED :
- Bouton vert "Start" / "Go" : demarrer l'ecoute candump.
- Bouton jaune "Pause" / "Resume" : geler/reprendre l'affichage sans arreter la capture.
- Bouton rouge "Stop" : arreter completement l'ecoute.
- Bouton "Clear" : vider toutes les trames affichees.
- Compteurs : nombre d'IDs actifs, nombre total de messages.

CONSEILS :
- Ouvrez le Sniffer AVANT de lancer une action sur le vehicule pour observer les trames en temps reel.
- Utilisez "Changed Only" + "Noisy filter" pour isoler visuellement : activez les deux, puis effectuez une action. Seuls les IDs impactes apparaitront.
- Le Sniffer reste ouvert quand vous changez de page. Pratique pour surveiller le bus tout en utilisant d'autres modules.
- Si le sniffer affiche 0 IDs, verifiez que l'interface est montee (page Controle CAN).`
                  },
                  {
                    id: "configuration", icon: Settings, title: "Configuration Pi",
                    content: `Administration du Raspberry Pi.

SECTION WI-FI :
- Bouton "Scanner" : detecte les reseaux Wi-Fi disponibles.
- Liste des reseaux : SSID, signal (dBm), securite. Cliquez sur un reseau pour vous connecter (saisissez le mot de passe).
- Bouton "Mode Hotspot" : transforme le Pi en point d'acces Wi-Fi. Utile sur le terrain sans reseau disponible. Connectez-vous au reseau "AURIGE" depuis votre telephone.

SECTION ETHERNET :
- Etat de la connexion filaire, adresse IP.

SECTION TAILSCALE VPN :
- Bouton "Connecter" : active le VPN Tailscale pour acces distant.
- Liste des peers : machines connectees au meme reseau Tailscale.
- Exit nodes : routage du trafic via un autre noeud.

SECTION SYSTEME :
- Bouton "Mise a jour" : execute apt update + apt upgrade.
- Bouton "Redemarrer" : reboot du Pi (attention, deconnecte toutes les sessions).
- Bouton "Eteindre" : arret propre du Pi.
- Informations : version OS, uptime, temperature CPU, espace disque.

SECTION GIT :
- Branche courante d'AURIGE.
- Bouton "Mettre a jour" : git pull pour recuperer la derniere version.

SECTION SAUVEGARDES :
- Bouton "Creer une sauvegarde" : archive toutes les missions, logs et configurations.
- Liste des sauvegardes existantes avec date et taille.
- Bouton "Restaurer" : ecrase la configuration actuelle par la sauvegarde selectionnee.
- Bouton "Supprimer" : supprime une sauvegarde.

CONSEILS :
- Faites une sauvegarde avant chaque mise a jour systeme ou AURIGE.
- Le mode Hotspot est la methode recommandee pour utiliser AURIGE sur le terrain (parking, garage).
- Tailscale permet d'acceder au Pi a distance depuis n'importe ou dans le monde.`
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
