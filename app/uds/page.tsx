"use client"

import { useState } from "react"
import { AppShell } from "@/components/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
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
import { AlertTriangle, Info, Loader2, Send } from "lucide-react"
import { udsRequest, type CANInterface, type UDSResult } from "@/lib/api"
import { useCriticalIds } from "@/lib/critical-ids"
import { cn } from "@/lib/utils"

type PresetId = "ext" | "def" | "tp" | "seed" | "key" | "io" | "routine" | "rdbi" | "raw"

const PRESETS: { id: PresetId; label: string }[] = [
  { id: "ext", label: "Session étendue" },
  { id: "def", label: "Session défaut" },
  { id: "tp", label: "TesterPresent" },
  { id: "seed", label: "SecurityAccess: demander seed" },
  { id: "key", label: "SecurityAccess: envoyer clé" },
  { id: "io", label: "IOControl" },
  { id: "routine", label: "RoutineControl start" },
  { id: "rdbi", label: "ReadDataByIdentifier" },
  { id: "raw", label: "Raw" },
]

const clean = (s: string) => s.replace(/[^0-9a-fA-F]/g, "").toUpperCase()

type Extra = { did: string; ctrl: string; rid: string; key: string }

/** Construit service + data a partir d'un preset et de ses champs additionnels. */
function buildPreset(id: PresetId, x: Extra): { service: string; data: string } | null {
  switch (id) {
    case "ext": return { service: "10", data: "03" }
    case "def": return { service: "10", data: "01" }
    case "tp": return { service: "3E", data: "00" }
    case "seed": return { service: "27", data: "01" }
    case "key": return { service: "27", data: "02" + clean(x.key) }
    case "io": return { service: "2F", data: clean(x.did) + clean(x.ctrl) }
    case "routine": return { service: "31", data: "01" + clean(x.rid) }
    case "rdbi": return { service: "22", data: clean(x.did) }
    default: return null
  }
}

/** Service d'action/ecriture : necessite une confirmation. */
function isActionService(service: string, data: string): boolean {
  const s = clean(service)
  if (["2F", "31", "2E", "11", "14"].includes(s)) return true
  const sub = clean(data).slice(0, 2)
  if (s === "27") {
    if (!sub) return true
    return parseInt(sub, 16) % 2 === 0 // sendKey
  }
  if (s === "10") return sub !== "01"
  return false
}

interface Exchange {
  id: number
  time: string
  iface: string
  req: string
  result: UDSResult
}

function describe(r: UDSResult): { text: string; tone: "ok" | "neg" | "err" } {
  if (r.status !== "ok" || !r.response) return { text: r.error || "Erreur de transport", tone: "err" }
  const resp = r.response
  if (resp.positive) {
    const echo = resp.service_echo !== undefined ? resp.service_echo.toString(16).toUpperCase().padStart(2, "0") : "??"
    return { text: `${echo}${resp.data_hex ? " " + resp.data_hex : ""}`, tone: "ok" }
  }
  // Pas de vraie reponse negative (ni NRC, ni trame brute) = aucune reponse de l'ECU, pas un 7F.
  if (!resp.nrc && !resp.raw) {
    return { text: resp.error === "pas de reponse" ? "Pas de réponse de l'ECU" : (resp.error || "Pas de réponse"), tone: "err" }
  }
  const code = resp.nrc ? resp.nrc.code.toString(16).toUpperCase().padStart(2, "0") : "??"
  return { text: `7F ${resp.nrc ? `${resp.nrc.label} (0x${code})` : resp.raw}`, tone: "neg" }
}

const toneClass = {
  ok: "text-green-600 dark:text-green-400",
  neg: "text-destructive",
  err: "text-destructive",
}

export default function UdsPage() {
  const { isCritical } = useCriticalIds()
  const [iface, setIface] = useState<CANInterface>("can0")
  const [requestId, setRequestId] = useState("7E0")
  const [responseId, setResponseId] = useState("7E8")
  const [service, setService] = useState("10")
  const [data, setData] = useState("03")
  const [preset, setPreset] = useState<PresetId>("ext")
  const [extra, setExtra] = useState<Extra>({ did: "", ctrl: "", rid: "", key: "" })
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState(false)
  const [last, setLast] = useState<Exchange | null>(null)
  const [history, setHistory] = useState<Exchange[]>([])

  const choosePreset = (id: PresetId) => {
    setPreset(id)
    const b = buildPreset(id, extra)
    if (b) {
      setService(b.service)
      setData(b.data)
    }
  }

  const setExtraField = (k: keyof Extra, v: string) => {
    const x = { ...extra, [k]: v }
    setExtra(x)
    const b = buildPreset(preset, x)
    if (b) setData(b.data)
  }

  const needsConfirm = isActionService(service, data) || isCritical(requestId)
  const valid = clean(service).length === 2 && clean(requestId).length > 0 && clean(responseId).length > 0

  const doSend = async () => {
    setPending(false)
    setBusy(true)
    const req = `${clean(service)}${clean(data) ? " " + clean(data) : ""}`
    let result: UDSResult
    try {
      result = await udsRequest({
        interface: iface,
        requestId: clean(requestId),
        responseId: clean(responseId),
        service: clean(service),
        data: clean(data),
      })
    } catch (e) {
      result = { status: "error", error: e instanceof Error ? e.message : "Erreur inconnue" }
    }
    const ex: Exchange = {
      id: Date.now(),
      time: new Date().toLocaleTimeString("fr-FR"),
      iface: `${iface} ${clean(requestId)}→${clean(responseId)}`,
      req,
      result,
    }
    setLast(ex)
    setHistory((h) => [ex, ...h].slice(0, 50))
    setBusy(false)
  }

  const onSend = () => {
    if (!valid || busy) return
    if (needsConfirm) setPending(true)
    else void doSend()
  }

  const lastDesc = last ? describe(last.result) : null

  return (
    <AppShell title="UDS" description="Diagnostic avancé (ISO 14229)">
      <div className="space-y-4">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            UDS agit directement sur un ECU réel ; utilisez sur votre propre véhicule, branché sur le bon bus.
          </AlertDescription>
        </Alert>

        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription>
            L'ECU cible est souvent derrière le gateway → branchez-vous sur son bus (cf capture multi-bus).
            Fournissez la session/clé/DID corrects de votre véhicule.
          </AlertDescription>
        </Alert>

        <Card>
          <CardHeader>
            <CardTitle>Requête UDS</CardTitle>
            <CardDescription>Les presets pré-remplissent service et données, ajustables ensuite.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <Button
                  key={p.id}
                  size="sm"
                  variant={preset === p.id ? "default" : "outline"}
                  onClick={() => choosePreset(p.id)}
                >
                  {p.label}
                </Button>
              ))}
            </div>

            {(preset === "key" || preset === "io" || preset === "routine" || preset === "rdbi") && (
              <div className="flex flex-wrap gap-3">
                {preset === "key" && (
                  <div className="space-y-1 min-w-[12rem] flex-1">
                    <Label>Clé (hex)</Label>
                    <Input className="font-mono" placeholder="ex. A1B2C3D4" value={extra.key}
                      onChange={(e) => setExtraField("key", e.target.value)} />
                  </div>
                )}
                {(preset === "io" || preset === "rdbi") && (
                  <div className="space-y-1 min-w-[10rem] flex-1">
                    <Label>DID (hex, 2 octets)</Label>
                    <Input className="font-mono" placeholder="ex. F190" value={extra.did}
                      onChange={(e) => setExtraField("did", e.target.value)} />
                  </div>
                )}
                {preset === "io" && (
                  <div className="space-y-1 min-w-[12rem] flex-1">
                    <Label>Octets de contrôle (hex)</Label>
                    <Input className="font-mono" placeholder="ex. 03 01" value={extra.ctrl}
                      onChange={(e) => setExtraField("ctrl", e.target.value)} />
                  </div>
                )}
                {preset === "routine" && (
                  <div className="space-y-1 min-w-[10rem] flex-1">
                    <Label>RID (hex, 2 octets)</Label>
                    <Input className="font-mono" placeholder="ex. FF00" value={extra.rid}
                      onChange={(e) => setExtraField("rid", e.target.value)} />
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              <div className="space-y-1 w-28">
                <Label>Interface</Label>
                <Select value={iface} onValueChange={(v) => setIface(v as CANInterface)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="can0">can0</SelectItem>
                    <SelectItem value="can1">can1</SelectItem>
                    <SelectItem value="vcan0">vcan0</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1 w-28">
                <Label>Request ID</Label>
                <Input className="font-mono" value={requestId} onChange={(e) => setRequestId(e.target.value)} />
              </div>
              <div className="space-y-1 w-28">
                <Label>Response ID</Label>
                <Input className="font-mono" value={responseId} onChange={(e) => setResponseId(e.target.value)} />
              </div>
              <div className="space-y-1 w-24">
                <Label>Service</Label>
                <Input className="font-mono" maxLength={2} value={service}
                  onChange={(e) => { setPreset("raw"); setService(e.target.value) }} />
              </div>
              <div className="space-y-1 min-w-[12rem] flex-1">
                <Label>Données (hex)</Label>
                <Input className="font-mono" value={data}
                  onChange={(e) => { setPreset("raw"); setData(e.target.value) }} />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={onSend} disabled={!valid || busy}>
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                Envoyer
              </Button>
              {needsConfirm && <Badge variant="destructive">Confirmation requise</Badge>}
              <span className="font-mono text-sm text-muted-foreground">
                {clean(requestId)} ← {clean(service)} {clean(data)}
              </span>
            </div>
          </CardContent>
        </Card>

        {last && lastDesc && (
          lastDesc.tone === "err" ? (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>{lastDesc.text}</AlertTitle>
              <AlertDescription className="break-words">
                Aucun ECU n'a répondu sur <span className="font-mono">{clean(responseId)}</span>. Vérifie : le bon bus
                (OBD pour <span className="font-mono">7E0/7E8</span>, ou le bus de l'ECU cible derrière le gateway) et les
                IDs UDS (request/response) de l'ECU visé.
              </AlertDescription>
            </Alert>
          ) : (
            <Card className={lastDesc.tone === "ok" ? "border-green-600/50" : "border-destructive/50"}>
              <CardHeader>
                <CardTitle className={cn("text-base", toneClass[lastDesc.tone])}>
                  {lastDesc.tone === "ok" ? "Réponse positive" : "Réponse négative"}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className={cn("font-mono break-all", toneClass[lastDesc.tone])}>{lastDesc.text}</p>
                <p className="mt-1 font-mono text-xs text-muted-foreground break-all">
                  raw: {last.result.response?.raw}
                </p>
              </CardContent>
            </Card>
          )
        )}

        <Card>
          <CardHeader>
            <CardTitle>Historique</CardTitle>
          </CardHeader>
          <CardContent>
            {history.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucun échange.</p>
            ) : (
              <ul className="space-y-2">
                {history.map((h) => {
                  const d = describe(h.result)
                  return (
                    <li key={h.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-xs">
                      <span className="text-muted-foreground" suppressHydrationWarning>{h.time}</span>
                      <span className="text-muted-foreground">{h.iface}</span>
                      <span>{h.req}</span>
                      <span>→</span>
                      <span className={cn("break-all", toneClass[d.tone])}>{d.text}</span>
                    </li>
                  )
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <AlertDialog open={pending} onOpenChange={(o) => !o && setPending(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmer l'action UDS</AlertDialogTitle>
            <AlertDialogDescription>
              Action UDS sur un ECU — peut déclencher un actionneur réel (essuie-glace, verrou…). Confirmer l'envoi ?
              <span className="mt-2 block font-mono">
                {clean(requestId)} ← {clean(service)} {clean(data)}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction onClick={() => void doSend()}>Confirmer l'envoi</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppShell>
  )
}
