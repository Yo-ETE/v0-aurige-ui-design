"use client"

import { useState, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import { useMissionStore } from "@/lib/mission-store"
import { useReplayStore } from "@/lib/replay-store"
import {
  getMissionDBC,
  deleteDBCSignal,
  getDBCExportUrl,
  addDBCSignal,
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
  Copy,
  FileText,
} from "lucide-react"

export default function DBCPage() {
  const router = useRouter()
  const currentMission = useMissionStore((state) => state.getCurrentMission())
  const missionId = currentMission?.id
  const addFrames = useReplayStore((state) => state.addFrames)
  
  const [dbcData, setDbcData] = useState<MissionDBC | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState("")
  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set())
  
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

  // Send signals to Replay Rapide
  const handleSendToReplay = (signals: DBCSignal[]) => {
    const frames = signals.map(s => ({
      canId: s.can_id,
      data: "00".repeat(8), // Default payload
      timestamp: "0",
      source: `dbc-${s.name}`,
    }))
    addFrames(frames)
    router.push("/replay-rapide")
  }

  // Copy CAN IDs to clipboard
  const handleCopyIds = (messages: DBCMessage[]) => {
    const ids = messages.map(m => m.can_id).join(",")
    navigator.clipboard.writeText(ids)
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
      <div className="p-6">
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <AlertCircle className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">Aucune mission selectionnee</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Selectionnez une mission depuis le Dashboard pour acceder au DBC.
            </p>
            <Button onClick={() => router.push("/")}>
              Aller au Dashboard
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
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
        </div>
      </div>

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
          <Button 
            variant="outline" 
            size="sm" 
            className="bg-transparent gap-1"
            onClick={() => handleCopyIds(filteredMessages)}
            disabled={filteredMessages.length === 0}
          >
            <Copy className="h-4 w-4" />
            Copier IDs
          </Button>
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
            Envoyer vers Replay
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
                          <DropdownMenuItem onClick={() => navigator.clipboard.writeText(message.can_id)}>
                            <Copy className="h-4 w-4 mr-2" />
                            Copier CAN ID
                          </DropdownMenuItem>
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
                          <TableHead className="w-20">Actions</TableHead>
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
                              <div className="flex items-center gap-1">
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
              <div className="grid grid-cols-2 gap-4">
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
              
              <div className="grid grid-cols-3 gap-4">
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

              <div className="grid grid-cols-4 gap-4">
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

              <div className="grid grid-cols-2 gap-4">
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
  )
}
