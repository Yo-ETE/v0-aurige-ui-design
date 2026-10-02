"use client"
import { useEffect, useState } from "react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"

export interface MessageMeta { can_id: string; name: string; dlc: number; comment: string }

export function MessageDialog({
  open, onOpenChange, initial, onSubmit,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  initial?: MessageMeta | null
  onSubmit: (m: MessageMeta) => void
}) {
  const [m, setM] = useState<MessageMeta>({ can_id: "", name: "", dlc: 8, comment: "" })
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    setM(initial ?? { can_id: "", name: "", dlc: 8, comment: "" })
    setErr(null)
  }, [initial, open])
  const editMode = !!initial
  const submit = () => {
    if (!/^[0-9A-Fa-f]{1,8}$/.test(m.can_id.trim())) { setErr("CAN ID invalide (hex, 1-8 caracteres)"); return }
    if (!Number.isInteger(m.dlc) || m.dlc < 0 || m.dlc > 64) { setErr("DLC invalide (entier 0-64)"); return }
    onSubmit({ ...m, can_id: m.can_id.trim() })
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-border">
        <DialogHeader>
          <DialogTitle>{editMode ? "Éditer le message" : "Nouveau message"}</DialogTitle>
          <DialogDescription>Métadonnées du message CAN (les signaux se gèrent séparément).</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label>CAN ID (hex)</Label>
            <Input className="font-mono" value={m.can_id} disabled={editMode}
              onChange={(e) => setM({ ...m, can_id: e.target.value.replace(/[^0-9A-Fa-f]/g, "").toUpperCase() })} placeholder="0C6" />
          </div>
          <div className="space-y-1.5">
            <Label>Nom</Label>
            <Input value={m.name} onChange={(e) => setM({ ...m, name: e.target.value })} placeholder="BrakeStatus" />
          </div>
          <div className="space-y-1.5">
            <Label>DLC</Label>
            <Input type="number" min={0} max={64} value={m.dlc} onChange={(e) => setM({ ...m, dlc: Number(e.target.value) })} />
          </div>
          <div className="space-y-1.5">
            <Label>Commentaire</Label>
            <Input value={m.comment} onChange={(e) => setM({ ...m, comment: e.target.value })} />
          </div>
          {err && <p className="text-xs text-destructive">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Annuler</Button>
          <Button onClick={submit}>{editMode ? "Enregistrer" : "Créer"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
