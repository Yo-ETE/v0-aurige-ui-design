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
  HardDrive,
  Trash2,
  Archive,
  RotateCcw,
  Usb,
  Cable,
  Eye,
  EyeOff,
  Star,
} from "lucide-react"
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
  restartServices,
  type WifiNetwork,
  type WifiStatus,
  type EthernetStatus,
  type AptOutput,
  type VersionInfo,
  type BackupInfo,
  type UpdateOutput,
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

  // Backup state
  const [backups, setBackups] = useState<BackupInfo[]>([])
  const [isCreatingBackup, setIsCreatingBackup] = useState(false)
  const [backupMessage, setBackupMessage] = useState<string | null>(null)
  const [needsRestart, setNeedsRestart] = useState(false)
  const [isRestarting, setIsRestarting] = useState(false)

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
      } catch {
        // Ignore
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
    if (!confirm("Voulez-vous mettre a jour Aurige ? Les services seront redemarres.")) return
    setBackupMessage(null)
    try {
      await startUpdate()
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
            // Wait 3 seconds then reload
            setTimeout(() => {
              window.location.reload()
            }, 3000)
          }
        }
      } catch {
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

  // Initial load
  useEffect(() => {
    fetchConnectionStatus()
    handleScan()
    fetchVersionInfo()
    fetchBackups()
  }, [fetchConnectionStatus, fetchVersionInfo, fetchBackups])

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
                    <p className="text-xs text-muted-foreground">Branche</p>
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
      </div>
    </AppShell>
  )
}
