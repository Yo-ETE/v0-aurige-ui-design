"use client"

import { useState, useEffect, useCallback } from "react"
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
  Power,
  PowerOff,
  Lock,
  Unlock,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
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
  Usb,
  Cable,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import {
  scanWifiNetworks,
  getWifiStatus,
  getEthernetStatus,
  connectToWifi,
  getSavedNetworks,
  getTailscaleStatus,
  tailscaleUp,
  tailscaleDown,
  tailscaleLogout,
  tailscaleSetExitNode,
  getHotspotStatus,
  getHotspotCredentials,
  setHotspotPassword,
  startHotspot,
  stopHotspot,
  type HotspotStatus,
  type WifiNetwork,
  type WifiStatus,
  type TailscaleStatus,
  type EthernetStatus,
} from "@/lib/api"

export function NetworkPanel() {
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

  // Tailscale VPN
  const [tsStatus, setTsStatus] = useState<TailscaleStatus | null>(null)
  const [tsLoading, setTsLoading] = useState(false)
  const [tsAction, setTsAction] = useState<string | null>(null)
  const [tsMessage, setTsMessage] = useState<{ type: "success" | "error" | "auth"; text: string; url?: string } | null>(null)

  // Hotspot (SSID local)
  const [hsStatus, setHsStatus] = useState<HotspotStatus | null>(null)
  const [hsCreds, setHsCreds] = useState<{ ssid: string; password: string } | null>(null)
  const [hsNewPassword, setHsNewPassword] = useState("")
  const [hsBusy, setHsBusy] = useState<string | null>(null)
  const [hsMessage, setHsMessage] = useState<{ type: "success" | "error"; text: string } | null>(null)

  const fetchHotspotStatus = useCallback(async () => {
    try {
      setHsStatus(await getHotspotStatus())
    } catch {
      setHsStatus(null)
    }
  }, [])

  const fetchHotspotCredentials = useCallback(async () => {
    try {
      setHsCreds(await getHotspotCredentials())
    } catch {
      setHsCreds(null)
    }
  }, [])

  const handleHotspotAction = async (action: "start" | "stop") => {
    setHsBusy(action)
    setHsMessage(null)
    try {
      const res = action === "start" ? await startHotspot() : await stopHotspot()
      setHsMessage({ type: "success", text: res.detail || (action === "start" ? "Hotspot demarre" : "Hotspot arrete") })
    } catch (e) {
      setHsMessage({ type: "error", text: e instanceof Error ? e.message : "Echec de l'operation" })
    } finally {
      await fetchHotspotStatus()
      setHsBusy(null)
    }
  }

  const handleHotspotPassword = async () => {
    setHsBusy("password")
    setHsMessage(null)
    try {
      await setHotspotPassword(hsNewPassword)
      setHsNewPassword("")
      setHsMessage({ type: "success", text: "Mot de passe mis a jour" })
      await fetchHotspotCredentials()
    } catch (e) {
      setHsMessage({ type: "error", text: e instanceof Error ? e.message : "Echec de l'operation" })
    } finally {
      setHsBusy(null)
    }
  }

  const hsPasswordValid = hsNewPassword.length >= 8 && hsNewPassword.length <= 63

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
    fetchTailscale()
    fetchHotspotStatus()
    fetchHotspotCredentials()
  }, [])

  // Signal strength helper
  const getSignalIcon = (signal: number) => {
    if (signal >= 70) return <Signal className="h-4 w-4 text-success" />
    if (signal >= 40) return <Signal className="h-4 w-4 text-warning" />
    return <Signal className="h-4 w-4 text-destructive" />
  }

  return (
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Connection Status Card */}
        <Card className="border-border bg-card">
          <CardHeader>
            <div className="flex items-center justify-between min-w-0 gap-2">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                  <Globe className="h-5 w-5 text-primary" />
                </div>
                <div className="min-w-0">
                  <CardTitle className="text-lg truncate">Etat connexion</CardTitle>
                  <CardDescription>Wi-Fi et Ethernet</CardDescription>
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={fetchConnectionStatus} className="shrink-0 bg-transparent">
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
                      <AlertDescription className="text-primary text-xs break-words">
                        Hotspot &quot;{wifiStatus.hotspotSsid || "Aurige"}&quot; actif
                      </AlertDescription>
                    </Alert>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="min-w-0">
                        <p className="text-xs text-muted-foreground">IP Hotspot</p>
                        <p className="font-mono text-xs break-all">{wifiStatus.ipLocal}</p>
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs text-muted-foreground">IP Publique</p>
                        <p className="font-mono text-xs break-all">{wifiStatus.ipPublic || "-"}</p>
                      </div>
                    </div>
                    
                    {/* Secondary interfaces - sources de connectivite */}
                    {wifiStatus.secondaryInterfaces && wifiStatus.secondaryInterfaces.length > 0 && (
                      <div className="space-y-2 pt-2 border-t border-border/50">
                        <p className="text-xs text-muted-foreground font-medium">Interfaces reseau</p>
                        {wifiStatus.secondaryInterfaces.map((iface) => (
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
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex min-w-0 items-center gap-2">
                                {iface.type === "wifi" && <Wifi className={`h-3.5 w-3.5 ${iface.connected ? "text-primary" : "text-muted-foreground"}`} />}
                                {iface.type === "usb" && <Usb className={`h-3.5 w-3.5 ${iface.connected ? "text-primary" : "text-muted-foreground"}`} />}
                                {iface.type === "ethernet" && <Cable className={`h-3.5 w-3.5 ${iface.connected ? "text-primary" : "text-muted-foreground"}`} />}
                                <span className="shrink-0 text-xs font-medium">{iface.label}</span>
                                <span className="min-w-0 truncate text-xs text-muted-foreground font-mono" title={iface.name}>({iface.name})</span>
                              </div>
                              <div className="flex shrink-0 items-center gap-1.5">
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
                              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 pl-5.5 text-xs text-muted-foreground">
                                {iface.ssid && (
                                  <span className="min-w-0 break-all">SSID: <span className="text-foreground font-medium">{iface.ssid}</span></span>
                                )}
                                {iface.ip && (
                                  <span className="min-w-0 break-all font-mono">{iface.ip}</span>
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
                          {(wifiStatus.pingMs ?? 0) > 0 && (
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
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">SSID</p>
                      <p className="min-w-0 break-all font-medium">{wifiStatus.ssid || "-"}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Signal</p>
                      <p className="font-medium flex items-center gap-1">
                        {wifiStatus.signal} dBm
                        {getSignalIcon(wifiStatus.signal + 100)}
                      </p>
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">IP Locale</p>
                      <p className="font-mono text-xs break-all">{wifiStatus.ipLocal}</p>
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">IP Publique</p>
                      <p className="font-mono text-xs break-all">{wifiStatus.ipPublic || "-"}</p>
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
                          {(wifiStatus.pingMs ?? 0) > 0 && (
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
                <div className="pl-6 text-sm min-w-0">
                  <p className="text-xs text-muted-foreground">IP Locale</p>
                  <p className="font-mono text-xs break-all">{ethernetStatus.ipLocal}</p>
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
            <div className="flex items-center justify-between min-w-0 gap-2">
              <div className="flex min-w-0 items-center gap-3">
                <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
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
                <div className="min-w-0">
                  <CardTitle className="text-lg truncate">Tailscale VPN</CardTitle>
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
              <Button variant="outline" size="sm" onClick={fetchTailscale} disabled={tsLoading} className="shrink-0 bg-transparent">
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
                      <div className="min-w-0">
                        <p className="text-xs text-muted-foreground">IP Tailscale</p>
                        <div className="flex items-center gap-1.5">
                          <p className="min-w-0 font-mono text-xs break-all">{tsStatus.tailscaleIp}</p>
                          <button
                            onClick={() => navigator.clipboard.writeText(tsStatus.tailscaleIp)}
                            className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                            title="Copier"
                          >
                            <Copy className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs text-muted-foreground">Hostname</p>
                        <p className="font-mono text-xs break-all">{tsStatus.hostname}</p>
                      </div>
                      {tsStatus.magicDns && (
                        <div className="col-span-2 min-w-0">
                          <p className="text-xs text-muted-foreground">Magic DNS</p>
                          <div className="flex items-center gap-1.5">
                            <p className="min-w-0 font-mono text-xs truncate" title={tsStatus.magicDns}>{tsStatus.magicDns}</p>
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
                                  <span className="min-w-0 text-xs font-medium break-all">{peer.hostname}</span>
                                  {peer.online && (
                                    <span className="h-1.5 w-1.5 rounded-full bg-success shrink-0" />
                                  )}
                                  {peer.isExitNode && (
                                    <Badge variant="outline" className="text-[9px] px-1 py-0 border-success/50 text-success">EXIT</Badge>
                                  )}
                                </div>
                                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                                  <span className="font-mono break-all">{peer.ip}</span>
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
            <div className="flex items-center justify-between min-w-0 gap-2">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                  <Network className="h-5 w-5 text-primary" />
                </div>
                <div className="min-w-0">
                  <CardTitle className="text-lg break-words">Reseaux disponibles</CardTitle>
                  <CardDescription>Selectionnez un reseau Wi-Fi</CardDescription>
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={handleScan} disabled={isScanning} className="shrink-0">
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
                    <div className="flex min-w-0 items-center gap-2">
                      {network.security !== "Open" && network.security !== "" ? (
                        <Lock className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <Unlock className="h-4 w-4 text-muted-foreground" />
                      )}
                      <span className="min-w-0 break-all font-medium" title={network.ssid}>{network.ssid}</span>
                      {savedNetworks.includes(network.ssid) && (
                        <span title="Reseau enregistre" className="inline-flex"><Star className="h-3 w-3 text-warning fill-warning" /></span>
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

        {/* Hotspot Card */}
        <Card className="border-border bg-card">
          <CardHeader>
            <div className="flex items-center justify-between min-w-0 gap-2">
              <div className="flex min-w-0 items-center gap-3">
                <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${hsStatus?.active ? "bg-success/10" : "bg-primary/10"}`}>
                  <Wifi className={`h-5 w-5 ${hsStatus?.active ? "text-success" : "text-primary"}`} />
                </div>
                <div className="min-w-0">
                  <CardTitle className="text-lg truncate">Hotspot (SSID local)</CardTitle>
                  <CardDescription>Point d{"'"}acces Wi-Fi du Pi</CardDescription>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => { fetchHotspotStatus(); fetchHotspotCredentials() }}
                className="shrink-0 bg-transparent"
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm" suppressHydrationWarning>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Statut</p>
                <p className={`text-xs font-medium ${hsStatus?.active ? "text-success" : "text-muted-foreground"}`} suppressHydrationWarning>
                  {hsStatus ? (hsStatus.active ? "Actif" : "Inactif") : "-"}
                </p>
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Clients</p>
                <p className="min-w-0 font-mono text-xs break-all" suppressHydrationWarning>{hsStatus ? hsStatus.clients : "-"}</p>
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">SSID</p>
                <p className="min-w-0 font-mono text-xs break-all" suppressHydrationWarning>{hsStatus?.ssid || hsCreds?.ssid || "-"}</p>
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Interface</p>
                <p className="min-w-0 font-mono text-xs break-all" suppressHydrationWarning>{hsStatus?.interface || "-"}</p>
              </div>
            </div>

            <div className="space-y-2 rounded-lg border border-border p-3">
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">SSID</p>
                <div className="flex items-center gap-1.5">
                  <p className="min-w-0 font-mono text-xs break-all" suppressHydrationWarning>{hsCreds?.ssid ?? "-"}</p>
                  {hsCreds?.ssid && (
                    <button
                      onClick={() => navigator.clipboard.writeText(hsCreds.ssid)}
                      className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                      title="Copier"
                    >
                      <Copy className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Mot de passe</p>
                <div className="flex items-center gap-1.5">
                  <p className="min-w-0 font-mono text-xs break-all" suppressHydrationWarning>{hsCreds?.password ?? "-"}</p>
                  {hsCreds?.password && (
                    <button
                      onClick={() => navigator.clipboard.writeText(hsCreds.password)}
                      className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                      title="Copier"
                    >
                      <Copy className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="hotspot-password" className="text-xs">Nouveau mot de passe (8 a 63 caracteres)</Label>
              <div className="flex gap-2">
                <Input
                  id="hotspot-password"
                  type="password"
                  value={hsNewPassword}
                  onChange={(e) => setHsNewPassword(e.target.value)}
                  maxLength={63}
                  autoComplete="new-password"
                  placeholder="Nouveau mot de passe"
                />
                <Button
                  onClick={handleHotspotPassword}
                  disabled={!hsPasswordValid || hsBusy !== null}
                  variant="outline"
                  className="bg-transparent"
                >
                  {hsBusy === "password" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Appliquer"}
                </Button>
              </div>
            </div>

            <div className="flex gap-2">
              <Button onClick={() => handleHotspotAction("start")} disabled={hsBusy !== null} className="flex-1">
                {hsBusy === "start" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Power className="h-4 w-4 mr-2" />}
                Demarrer
              </Button>
              <Button
                onClick={() => handleHotspotAction("stop")}
                disabled={hsBusy !== null}
                variant="outline"
                className="flex-1 bg-transparent"
              >
                {hsBusy === "stop" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <PowerOff className="h-4 w-4 mr-2" />}
                Arreter
              </Button>
            </div>

            {hsMessage && (
              <Alert variant={hsMessage.type === "error" ? "destructive" : "default"}>
                <AlertDescription>{hsMessage.text}</AlertDescription>
              </Alert>
            )}

            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                Sur une seule carte WiFi, demarrer le hotspot coupe la connexion client.
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      </div>
  )
}
