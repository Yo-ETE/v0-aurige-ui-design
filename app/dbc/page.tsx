"use client"

import { useState, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import { AppShell } from "@/components/app-shell"
import { useMissionStore } from "@/lib/mission-store"
import { useExportStore } from "@/lib/export-store"
import {
  getMissionDBC,
  deleteDBCSignal,
  getDBCExportUrl,
  addDBCSignal,
  sendCANFrame,
  type DBCSignal,
  type DBCMessage,
  type MissionDBC,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  FileCode,
  Download,
  Trash2,
  MoreVertical,
  Plus,
  Pencil,
  Send,
  Play,
  ChevronRight,
  ChevronDown,
  AlertCircle,
  Search,
  FileText,
  FolderOpen,
  ArrowLeft,
  Loader2,
  CheckCircle2,
  Zap,
  Upload,
  ExternalLink,
} from "lucide-react"

export default function DBCPage() {
  const router = useRouter()
  const currentMission = useMissionStore((state) => state.getCurrentMission())
  const missionId = currentMission?.id
  const addFrames = useExportStore((state) => state.addFrames)
  
  const [dbcData, setDbcData] = useState<MissionDBC | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState("")
  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set())
  const [canInterface, setCanInterface] = useState<"can0" | "can1" | "vcan0">("can0")
  const [sendingSignalId, setSendingSignalId] = useState<string | null>(null)
  const [sentSignalId, setSentSignalId] = useState<string | null>(null)
  
  // Import DBC state
  const [isImporting, setIsImporting] = useState(false)
  const [importResult, setImportResult] = useState<{ success: boolean; message: string } | null>(null)
  
  // Edit dialog state
  const [editingSignal, setEditingSignal] = useState<DBCSignal | null>(null)
  const [showEditDialog, setShowEditDialog] = useState(false)
  
  // Add signal dialog state
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [newSignal, setNewSignal] = useState<Partial<DBCSignal>>({
    can_id: "",
    name: "",
    start_bit: 0,
    length: 8,
    byte_order: "little_endian",
    is_signed: false,
    scale: 1,
    offset: 0,
    min_val: 0,
    max_val: 255,
    unit: "",
    comment: "",
  })

  // Import DBC file
  const handleImportDBC = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!missionId || !event.target.files || event.target.files.length === 0) return
    
    const file = event.target.files[0]
    setIsImporting(true)
    setImportResult(null)
    
    try {
      const formData = new FormData()
      formData.append('file', file)
      
      const response = await fetch(`/api/missions/${missionId}/dbc/import`, {
        method: 'POST',
        body: formData,
      })
      
      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.detail || 'Import failed')
      }
      
      const result = await response.json()
      setImportResult({
        success: true,
        message: `Successfully imported ${result.imported_signals} signals from ${result.total_messages} messages`
      })
      
      // Reload DBC data
      await loadDBC()
    } catch (error) {
      console.error('DBC import failed:', error)
      setImportResult({
        success: false,
        message: error instanceof Error ? error.message : 'Import failed'
      })
    } finally {
      setIsImporting(false)
      // Reset file input
      event.target.value = ''
    }
  }

  // Load DBC data
  const loadDBC = useCallback(async () => {
    if (!missionId) return
    setIsLoading(true)
    try {
      const data = await getMissionDBC(missionId)
      setDbcData(data)
      // Expand all messages by default
      setExpandedMessages(new Set(data.messages.map(m => m.can_id)))
    } catch (error) {
      console.error("Failed to load DBC:", error)
    } finally {
      setIsLoading(false)
    }
  }, [missionId])

  useEffect(() => {
    loadDBC()
  }, [loadDBC])

  // Toggle message expansion
  const toggleMessage = (canId: string) => {
    setExpandedMessages(prev => {
      const next = new Set(prev)
      if (next.has(canId)) {
        next.delete(canId)
      } else {
        next.add(canId)
      }
      return next
    })
  }

  // Delete signal
  const handleDeleteSignal = async (signalId: string) => {
    if (!missionId) return
    try {
      await deleteDBCSignal(missionId, signalId)
      await loadDBC()
    } catch (error) {
      console.error("Failed to delete signal:", error)
    }
  }

  // Save edited signal
  const handleSaveSignal = async () => {
    if (!missionId || !editingSignal) return
    try {
      // Delete old and add new (simple update)
      if (editingSignal.id) {
        await deleteDBCSignal(missionId, editingSignal.id)
      }
      await addDBCSignal(missionId, editingSignal)
      setShowEditDialog(false)
      setEditingSignal(null)
      await loadDBC()
    } catch (error) {
      console.error("Failed to save signal:", error)
    }
  }

  // Add new signal
  const handleAddSignal = async () => {
    if (!missionId || !newSignal.can_id) return
    try {
      await addDBCSignal(missionId, newSignal)
      setShowAddDialog(false)
      setNewSignal({
        can_id: "",
        name: "",
        start_bit: 0,
        length: 8,
        byte_order: "little_endian",
        is_signed: false,
        scale: 1,
        offset: 0,
        min_val: 0,
        max_val: 255,
        unit: "",
        comment: "",
      })
      await loadDBC()
    } catch (error) {
      console.error("Failed to add signal:", error)
    }
  }

  // Play direct: envoie la trame STATUS (ou ACK, ou AVANT) sur l'interface CAN
  const handlePlaySignal = async (signal: DBCSignal) => {
    const payload = signal.sample_status || signal.sample_ack || signal.sample_before
    if (!payload || !payload.trim()) return
    
    const signalKey = signal.id || signal.name
    setSendingSignalId(signalKey)
    setSentSignalId(null)
    try {
      await sendCANFrame({ interface: canInterface, canId: signal.can_id, data: payload.replace(/\s/g, "") })
      setSentSignalId(signalKey)
      setTimeout(() => setSentSignalId(prev => prev === signalKey ? null : prev), 2000)
    } catch (err) {
      console.error("Erreur envoi CAN:", err)
    } finally {
      setSendingSignalId(null)
    }
  }

  // Replay Rapide pour un seul signal
  const handleReplaySignal = (signal: DBCSignal) => {
    const frames: Array<{canId: string, data: string, timestamp: string, source: string}> = []
    const cleanPayload = (p: string | undefined) => p && p.trim() ? p.replace(/\s/g, "") : null
    const avant = cleanPayload(signal.sample_before)
    const ack = cleanPayload(signal.sample_ack)
    const status = cleanPayload(signal.sample_status)
    
    if (avant) frames.push({ canId: signal.can_id, data: avant, timestamp: "0", source: `${signal.name}-AVANT` })
    if (ack && ack !== avant) frames.push({ canId: signal.can_id, data: ack, timestamp: "0", source: `${signal.name}-ACK` })
    if (status && status !== avant && status !== ack) frames.push({ canId: signal.can_id, data: status, timestamp: "0", source: `${signal.name}-STATUS` })
    if (!avant && !ack && !status) frames.push({ canId: signal.can_id, data: "00".repeat(8), timestamp: "0", source: signal.name })
    
    addFrames(frames)
    router.push("/replay-rapide")
  }

  // Send signals to Replay Rapide - sends all 3 frame states (AVANT, ACK, STATUS)
  const handleSendToReplay = (signals: DBCSignal[]) => {
    const frames: Array<{canId: string, data: string, timestamp: string, source: string}> = []
    
    signals.forEach(s => {
      // Helper to clean payload (remove spaces, check for empty/undefined)
      const cleanPayload = (p: string | undefined) => p && p.trim() ? p.replace(/\s/g, "") : null
      
      const avant = cleanPayload(s.sample_before)
      const ack = cleanPayload(s.sample_ack)
      const status = cleanPayload(s.sample_status)
      
      // Add AVANT frame
      if (avant) {
        frames.push({
          canId: s.can_id,
          data: avant,
          timestamp: "0",
          source: `${s.name}-AVANT`,
        })
      }
      // Add ACK frame if different from AVANT
      if (ack && ack !== avant) {
        frames.push({
          canId: s.can_id,
          data: ack,
          timestamp: "0",
          source: `${s.name}-ACK`,
        })
      }
      // Add STATUS frame if different from AVANT and ACK
      if (status && status !== avant && status !== ack) {
        frames.push({
          canId: s.can_id,
          data: status,
          timestamp: "0",
          source: `${s.name}-STATUS`,
        })
      }
      
      // If no samples, add a default frame
      if (!avant && !ack && !status) {
        frames.push({
          canId: s.can_id,
          data: "00".repeat(8),
          timestamp: "0",
          source: `${s.name}`,
        })
      }
    })
    
    addFrames(frames)
    router.push("/replay-rapide")
  }

  // Filter messages
  const filteredMessages = dbcData?.messages.filter(msg => {
    const term = searchTerm.toLowerCase()
    if (msg.can_id.toLowerCase().includes(term)) return true
    if (msg.signals.some(s => s.name?.toLowerCase().includes(term))) return true
    if (msg.signals.some(s => s.comment?.toLowerCase().includes(term))) return true
    return false
  }) || []

  // Stats
  const totalMessages = dbcData?.messages.length || 0
  const totalSignals = dbcData?.messages.reduce((acc, m) => acc + m.signals.length, 0) || 0

  if (!missionId) {
    return (
      <AppShell>
        <div className="p-6">
          <Card className="border-border bg-card">
            <CardContent className="flex flex-col items-center justify-center py-16">
              <FolderOpen className="h-16 w-16 text-muted-foreground/30 mb-4" />
              <h2 className="text-xl font-semibold text-foreground mb-2">Aucune mission selectionnee</h2>
              <p className="text-muted-foreground text-center max-w-md mb-6">
                Selectionnez ou creez une mission depuis le Dashboard pour acceder a l&apos;editeur DBC.
              </p>
              <Button onClick={() => router.push("/")} className="gap-2">
                <ArrowLeft className="h-4 w-4" />
                Ouvrir le Dashboard
              </Button>
            </CardContent>
          </Card>
        </div>
      </AppShell>
    )
  }

  return (
    <AppShell>
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <FileCode className="h-6 w-6 text-primary" />
            DBC - {currentMission?.name}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Gestion des signaux et messages CAN pour l&apos;export DBC
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="file"
            id="dbc-file-input"
            accept=".dbc"
            className="hidden"
            onChange={handleImportDBC}
            disabled={isImporting}
          />
          <Button 
            variant="outline" 
            className="bg-transparent gap-2" 
            onClick={() => document.getElementById('dbc-file-input')?.click()}
            disabled={isImporting}
          >
            {isImporting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Import en cours...
              </>
            ) : (
              <>
                <Upload className="h-4 w-4" />
                Importer DBC
              </>
            )}
          </Button>
          <Button variant="outline" className="bg-transparent gap-2" onClick={() => setShowAddDialog(true)}>
            <Plus className="h-4 w-4" />
            Ajouter signal
          </Button>
          <Button variant="outline" className="bg-transparent gap-2" asChild>
            <a href={getDBCExportUrl(missionId)} download>
              <Download className="h-4 w-4" />
              Exporter DBC
            </a>
          </Button>
          <Button variant="outline" className="bg-transparent gap-2" asChild>
            <a href="https://github.com/commaai/opendbc/tree/master/dbc" target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-4 w-4" />
              OpenDBC
            </a>
          </Button>
        </div>
      </div>

      {/* Import result notification */}
      {importResult && (
        <Card className={importResult.success ? "border-green-500 bg-green-500/10" : "border-destructive bg-destructive/10"}>
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              {importResult.success ? (
                <CheckCircle2 className="h-5 w-5 text-green-500 mt-0.5" />
              ) : (
                <AlertCircle className="h-5 w-5 text-destructive mt-0.5" />
              )}
              <div className="flex-1">
                <p className={importResult.success ? "text-green-700 dark:text-green-400" : "text-destructive"}>
                  {importResult.message}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setImportResult(null)}
                className="h-6 w-6 p-0"
              >
                ×
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Messages CAN</CardDescription>
            <CardTitle className="text-3xl">{totalMessages}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Signaux definis</CardDescription>
            <CardTitle className="text-3xl">{totalSignals}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Mission</CardDescription>
            <CardTitle className="text-lg truncate">{currentMission?.name}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Search and Actions */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Rechercher par CAN ID, nom ou commentaire..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10"
          />
        </div>
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground whitespace-nowrap">Interface CAN:</Label>
          <select
            value={canInterface}
            onChange={(e) => setCanInterface(e.target.value as "can0" | "can1" | "vcan0")}
            className="rounded border border-border bg-secondary px-2 py-1 text-xs text-foreground h-8"
          >
            <option value="can0">can0</option>
            <option value="can1">can1</option>
            <option value="vcan0">vcan0 (test)</option>
          </select>
          <Button 
            variant="default" 
            size="sm" 
            className="gap-1"
            onClick={() => {
              const allSignals = filteredMessages.flatMap(m => m.signals)
              handleSendToReplay(allSignals)
            }}
            disabled={filteredMessages.length === 0}
          >
            <Send className="h-4 w-4" />
            Envoyer tout vers Replay
          </Button>
        </div>
      </div>

      {/* Messages List */}
      <Card>
        <CardHeader>
          <CardTitle>Messages et Signaux</CardTitle>
          <CardDescription>
            {filteredMessages.length} message(s) - Cliquez sur un message pour voir ses signaux
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
            </div>
          ) : filteredMessages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <FileText className="h-12 w-12 text-muted-foreground/50 mb-4" />
              <p className="text-sm text-muted-foreground mb-2">
                {searchTerm ? "Aucun resultat pour cette recherche" : "Aucun signal defini"}
              </p>
              <p className="text-xs text-muted-foreground">
                Utilisez l&apos;Isolation pour qualifier des trames et creer des signaux.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {filteredMessages.map((message) => (
                <div key={message.can_id} className="border rounded-lg overflow-hidden">
                  {/* Message Header */}
                  <div 
                    className="flex items-center gap-3 p-3 bg-secondary/30 hover:bg-secondary/50 cursor-pointer transition-colors"
                    onClick={() => toggleMessage(message.can_id)}
                  >
                    {expandedMessages.has(message.can_id) ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    )}
                    <Badge variant="outline" className="font-mono">
                      0x{message.can_id}
                    </Badge>
                    <span className="text-sm text-muted-foreground">
                      {message.signals.length} signal(s)
                    </span>
                    <div className="ml-auto flex items-center gap-1">
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        className="h-7 w-7 bg-transparent"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleSendToReplay(message.signals)
                        }}
                      >
                        <Play className="h-3.5 w-3.5" />
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                          <Button variant="ghost" size="icon" className="h-7 w-7 bg-transparent">
                            <MoreVertical className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => handleSendToReplay(message.signals)}>
                            <Send className="h-4 w-4 mr-2" />
                            Envoyer vers Replay
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem 
                            className="text-destructive"
                            onClick={() => {
                              message.signals.forEach(s => {
                                if (s.id) handleDeleteSignal(s.id)
                              })
                            }}
                          >
                            <Trash2 className="h-4 w-4 mr-2" />
                            Supprimer tous les signaux
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>

                  {/* Signals Table */}
                  {expandedMessages.has(message.can_id) && message.signals.length > 0 && (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Nom</TableHead>
                          <TableHead>Start bit</TableHead>
                          <TableHead>Longueur</TableHead>
                          <TableHead>Byte order</TableHead>
                          <TableHead>Scale/Offset</TableHead>
                          <TableHead>Unite</TableHead>
                          <TableHead>Commentaire</TableHead>
                          <TableHead>Samples</TableHead>
                          <TableHead className="w-32">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {message.signals.map((signal) => (
                          <TableRow key={signal.id || signal.name}>
                            <TableCell className="font-mono font-medium">{signal.name}</TableCell>
                            <TableCell>{signal.start_bit}</TableCell>
                            <TableCell>{signal.length}</TableCell>
                            <TableCell className="text-xs">
                              {signal.byte_order === "little_endian" ? "LE" : "BE"}
                            </TableCell>
                            <TableCell className="text-xs">
                              {signal.scale}x + {signal.offset}
                            </TableCell>
                            <TableCell>{signal.unit || "-"}</TableCell>
                            <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                              {signal.comment || "-"}
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-col gap-0.5 text-xs font-mono">
                                {signal.sample_before && <span className="text-muted-foreground truncate max-w-[120px]" title={`AVANT: ${signal.sample_before}`}>AV: {signal.sample_before}</span>}
                                {signal.sample_ack && <span className="text-muted-foreground truncate max-w-[120px]" title={`ACK: ${signal.sample_ack}`}>ACK: {signal.sample_ack}</span>}
                                {signal.sample_status && <span className="text-muted-foreground truncate max-w-[120px]" title={`STATUS: ${signal.sample_status}`}>ST: {signal.sample_status}</span>}
                                {!signal.sample_before && !signal.sample_ack && !signal.sample_status && <span className="text-muted-foreground/50">-</span>}
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1">
                                {/* Bouton Play direct (envoi sur CAN) */}
                                <Button 
                                  variant="ghost" 
                                  size="icon" 
                                  className={`h-7 w-7 bg-transparent ${sentSignalId === (signal.id || signal.name) ? "text-success" : "text-foreground"}`}
                                  disabled={sendingSignalId === (signal.id || signal.name) || (!signal.sample_status && !signal.sample_ack && !signal.sample_before)}
                                  onClick={() => handlePlaySignal(signal)}
                                  title={`Envoyer sur ${canInterface}: ${signal.can_id}#${signal.sample_status || signal.sample_ack || signal.sample_before || ""}`}
                                >
                                  {sendingSignalId === (signal.id || signal.name) ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  ) : sentSignalId === (signal.id || signal.name) ? (
                                    <CheckCircle2 className="h-3.5 w-3.5" />
                                  ) : (
                                    <Play className="h-3.5 w-3.5" />
                                  )}
                                </Button>
                                {/* Bouton Replay Rapide (page dediee) */}
                                <Button 
                                  variant="ghost" 
                                  size="icon" 
                                  className="h-7 w-7 bg-transparent"
                                  onClick={() => handleReplaySignal(signal)}
                                  title="Ouvrir dans Replay Rapide"
                                  disabled={!signal.sample_status && !signal.sample_ack && !signal.sample_before}
                                >
                                  <Zap className="h-3.5 w-3.5" />
                                </Button>
                                <Button 
                                  variant="ghost" 
                                  size="icon" 
                                  className="h-7 w-7 bg-transparent"
                                  onClick={() => {
                                    setEditingSignal(signal)
                                    setShowEditDialog(true)
                                  }}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </Button>
                                <Button 
                                  variant="ghost" 
                                  size="icon" 
                                  className="h-7 w-7 bg-transparent text-destructive hover:text-destructive"
                                  onClick={() => signal.id && handleDeleteSignal(signal.id)}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Edit Signal Dialog */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Modifier le signal</DialogTitle>
            <DialogDescription>
              Modifiez les proprietes du signal DBC
            </DialogDescription>
          </DialogHeader>
          {editingSignal && (
            <div className="space-y-4 py-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>CAN ID</Label>
                  <Input value={editingSignal.can_id} disabled className="font-mono" />
                </div>
                <div className="space-y-2">
                  <Label>Nom du signal</Label>
                  <Input 
                    value={editingSignal.name || ""} 
                    onChange={(e) => setEditingSignal(prev => prev ? {...prev, name: e.target.value} : null)}
                  />
                </div>
              </div>
              
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label>Start bit</Label>
                  <Input 
                    type="number"
                    value={editingSignal.start_bit ?? 0}
                    onChange={(e) => setEditingSignal(prev => prev ? {...prev, start_bit: parseInt(e.target.value)} : null)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Longueur (bits)</Label>
                  <Input 
                    type="number"
                    value={editingSignal.length ?? 8}
                    onChange={(e) => setEditingSignal(prev => prev ? {...prev, length: parseInt(e.target.value)} : null)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Byte order</Label>
                  <Select
                    value={editingSignal.byte_order || "little_endian"}
                    onValueChange={(v) => setEditingSignal(prev => prev ? {...prev, byte_order: v as "little_endian" | "big_endian"} : null)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="little_endian">Little Endian</SelectItem>
                      <SelectItem value="big_endian">Big Endian</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div className="space-y-2">
                  <Label>Scale</Label>
                  <Input 
                    type="number"
                    step="0.001"
                    value={editingSignal.scale ?? 1}
                    onChange={(e) => setEditingSignal(prev => prev ? {...prev, scale: parseFloat(e.target.value)} : null)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Offset</Label>
                  <Input 
                    type="number"
                    value={editingSignal.offset ?? 0}
                    onChange={(e) => setEditingSignal(prev => prev ? {...prev, offset: parseFloat(e.target.value)} : null)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Min</Label>
                  <Input 
                    type="number"
                    value={editingSignal.min_val ?? 0}
                    onChange={(e) => setEditingSignal(prev => prev ? {...prev, min_val: parseFloat(e.target.value)} : null)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Max</Label>
                  <Input 
                    type="number"
                    value={editingSignal.max_val ?? 255}
                    onChange={(e) => setEditingSignal(prev => prev ? {...prev, max_val: parseFloat(e.target.value)} : null)}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Unite</Label>
                  <Input 
                    value={editingSignal.unit || ""} 
                    onChange={(e) => setEditingSignal(prev => prev ? {...prev, unit: e.target.value} : null)}
                    placeholder="ex: km/h, RPM"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Signe</Label>
                  <Select
                    value={editingSignal.is_signed ? "signed" : "unsigned"}
                    onValueChange={(v) => setEditingSignal(prev => prev ? {...prev, is_signed: v === "signed"} : null)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="unsigned">Non signe</SelectItem>
                      <SelectItem value="signed">Signe</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Commentaire</Label>
                <Input 
                  value={editingSignal.comment || ""} 
                  onChange={(e) => setEditingSignal(prev => prev ? {...prev, comment: e.target.value} : null)}
                  placeholder="Description du signal"
                />
              </div>

              <div className="flex justify-end gap-2 pt-4 border-t">
                <Button variant="outline" className="bg-transparent" onClick={() => setShowEditDialog(false)}>
                  Annuler
                </Button>
                <Button onClick={handleSaveSignal}>
                  Enregistrer
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Add Signal Dialog */}
      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Ajouter un signal</DialogTitle>
            <DialogDescription>
              Creez un nouveau signal DBC manuellement
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>CAN ID (hex)</Label>
                <Input 
                  value={newSignal.can_id || ""} 
                  onChange={(e) => setNewSignal(prev => ({...prev, can_id: e.target.value.toUpperCase()}))}
                  placeholder="ex: 7E0"
                  className="font-mono"
                />
              </div>
              <div className="space-y-2">
                <Label>Nom du signal</Label>
                <Input 
                  value={newSignal.name || ""} 
                  onChange={(e) => setNewSignal(prev => ({...prev, name: e.target.value}))}
                  placeholder="SIG_NAME"
                />
              </div>
            </div>
            
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Start bit</Label>
                <Input 
                  type="number"
                  value={newSignal.start_bit ?? 0}
                  onChange={(e) => setNewSignal(prev => ({...prev, start_bit: parseInt(e.target.value)}))}
                />
              </div>
              <div className="space-y-2">
                <Label>Longueur (bits)</Label>
                <Input 
                  type="number"
                  value={newSignal.length ?? 8}
                  onChange={(e) => setNewSignal(prev => ({...prev, length: parseInt(e.target.value)}))}
                />
              </div>
              <div className="space-y-2">
                <Label>Byte order</Label>
                <Select
                  value={newSignal.byte_order || "little_endian"}
                  onValueChange={(v) => setNewSignal(prev => ({...prev, byte_order: v as "little_endian" | "big_endian"}))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="little_endian">Little Endian</SelectItem>
                    <SelectItem value="big_endian">Big Endian</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Unite</Label>
                <Input 
                  value={newSignal.unit || ""} 
                  onChange={(e) => setNewSignal(prev => ({...prev, unit: e.target.value}))}
                  placeholder="ex: km/h, RPM"
                />
              </div>
              <div className="space-y-2">
                <Label>Commentaire</Label>
                <Input 
                  value={newSignal.comment || ""} 
                  onChange={(e) => setNewSignal(prev => ({...prev, comment: e.target.value}))}
                  placeholder="Description"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-4 border-t">
              <Button variant="outline" className="bg-transparent" onClick={() => setShowAddDialog(false)}>
                Annuler
              </Button>
              <Button onClick={handleAddSignal} disabled={!newSignal.can_id || !newSignal.name}>
                Ajouter
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
    </AppShell>
  )
}
