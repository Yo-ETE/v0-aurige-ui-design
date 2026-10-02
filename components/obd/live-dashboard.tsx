"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { LineChart, Line, YAxis, ResponsiveContainer } from "recharts"
import { Gauge, Play, Square } from "lucide-react"
import { readOBDPidValue, type CANInterface } from "@/lib/api"

export const PID_OPTIONS: { value: string; label: string; unit: string }[] = [
  { value: "0C", label: "Regime moteur (RPM)", unit: "tr/min" },
  { value: "0D", label: "Vitesse vehicule", unit: "km/h" },
  { value: "05", label: "Temperature liquide refroidissement", unit: "C" },
  { value: "0F", label: "Temperature air admission", unit: "C" },
  { value: "11", label: "Position papillon (%)", unit: "%" },
  { value: "10", label: "Debit air (MAF)", unit: "g/s" },
  { value: "2F", label: "Niveau carburant", unit: "%" },
  { value: "04", label: "Charge moteur (%)", unit: "%" },
  { value: "0B", label: "Pression collecteur (MAP)", unit: "kPa" },
  { value: "42", label: "Tension module commande", unit: "V" },
  { value: "46", label: "Temperature ambiante", unit: "C" },
  { value: "0A", label: "Pression carburant", unit: "kPa" },
  { value: "0E", label: "Avance allumage", unit: "deg" },
  { value: "1F", label: "Duree fonctionnement", unit: "s" },
]

const BUFFER_SIZE = 60
const MIN_INTERVAL_MS = 100

interface Point { t: number; value: number }

export function LiveDashboard({ iface }: { iface: CANInterface }) {
  const [selected, setSelected] = useState<string[]>(["0C", "0D"])
  const [intervalMs, setIntervalMs] = useState(500)
  const [running, setRunning] = useState(false)
  const [latest, setLatest] = useState<Record<string, number | null>>({})
  const [series, setSeries] = useState<Record<string, Point[]>>({})
  const [pollError, setPollError] = useState<string | null>(null)

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const inFlightRef = useRef(false)
  const selectedRef = useRef<string[]>(selected)
  const ifaceRef = useRef(iface)
  const startRef = useRef(0)
  selectedRef.current = selected
  ifaceRef.current = iface

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // Nettoyage au demontage
  useEffect(() => stopTimer, [stopTimer])

  const tick = useCallback(async () => {
    // Garde anti-chevauchement : on saute le tick si le lot precedent n'est pas fini
    if (inFlightRef.current) return
    inFlightRef.current = true
    try {
      const pids = [...selectedRef.current]
      // Lecture sequentielle : le bus OBD ne gere qu'une requete a la fois
      const results: { pid: string; value: number | null }[] = []
      for (const pid of pids) {
        try {
          const r = await readOBDPidValue(ifaceRef.current, pid)
          results.push({ pid, value: r.status === "error" ? null : r.value })
        } catch (e) {
          setPollError(e instanceof Error ? e.message : "Erreur de lecture PID")
          results.push({ pid, value: null })
        }
        if (!timerRef.current) break // arret demande pendant le lot
      }
      const t = (Date.now() - startRef.current) / 1000
      setLatest((prev) => {
        const next = { ...prev }
        for (const r of results) next[r.pid] = r.value
        return next
      })
      setSeries((prev) => {
        const next = { ...prev }
        for (const r of results) {
          if (r.value === null || r.value === undefined) continue
          // Tampon circulaire : on garde les BUFFER_SIZE derniers points
          next[r.pid] = [...(prev[r.pid] ?? []), { t, value: r.value }].slice(-BUFFER_SIZE)
        }
        return next
      })
    } finally {
      inFlightRef.current = false
    }
  }, [])

  const handleStart = () => {
    if (timerRef.current || selected.length === 0) return
    setPollError(null)
    setSeries({})
    setLatest({})
    startRef.current = Date.now()
    inFlightRef.current = false
    setRunning(true)
    timerRef.current = setInterval(() => void tick(), Math.max(MIN_INTERVAL_MS, intervalMs || 500))
    void tick()
  }

  const handleStop = () => {
    stopTimer()
    setRunning(false)
  }

  const toggle = (pid: string, on: boolean) =>
    setSelected((prev) => (on ? (prev.includes(pid) ? prev : [...prev, pid]) : prev.filter((p) => p !== pid)))

  return (
    <Card className="lg:col-span-2 bg-card border-border">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Gauge className="h-5 w-5 text-primary" />
          Dashboard live
        </CardTitle>
        <CardDescription>Lecture periodique de PIDs en temps reel (Service 01)</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {PID_OPTIONS.map((p) => (
            <label
              key={p.value}
              className="flex cursor-pointer items-center gap-2 rounded border border-border/50 bg-background/30 px-2.5 py-1.5 text-sm"
            >
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={selected.includes(p.value)}
                onChange={(e) => toggle(p.value, e.target.checked)}
              />
              <span className="font-mono text-xs text-primary">{p.value}</span>
              <span className="min-w-0 flex-1 truncate text-foreground">{p.label}</span>
            </label>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="live-interval" className="text-xs text-muted-foreground">Intervalle (ms)</Label>
          <Input
            id="live-interval"
            type="number"
            min={MIN_INTERVAL_MS}
            step={100}
            value={intervalMs}
            disabled={running}
            onChange={(e) => setIntervalMs(Number(e.target.value))}
            className="w-28 bg-input border-border"
          />
          {running ? (
            <Button variant="destructive" onClick={handleStop} className="gap-2">
              <Square className="h-4 w-4" /> Arreter
            </Button>
          ) : (
            <Button onClick={handleStart} disabled={selected.length === 0} className="gap-2">
              <Play className="h-4 w-4" /> Demarrer
            </Button>
          )}
        </div>

        {pollError && <p className="break-all text-xs text-destructive">{pollError}</p>}

        {selected.length > 0 && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {selected.map((pid) => {
              const opt = PID_OPTIONS.find((p) => p.value === pid)
              const v = latest[pid]
              const data = series[pid] ?? []
              return (
                <div key={pid} className="rounded-lg border border-border bg-muted/20 p-3">
                  <p className="truncate text-xs text-muted-foreground">{opt?.label ?? pid}</p>
                  <p className="break-all font-mono text-xl font-bold text-foreground">
                    {v === null || v === undefined ? "--" : Number.isInteger(v) ? v : v.toFixed(2)}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">{opt?.unit}</span>
                  </p>
                  <div className="h-16">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={data}>
                        <YAxis hide domain={["auto", "auto"]} />
                        <Line
                          type="monotone"
                          dataKey="value"
                          stroke="#3b82f6"
                          strokeWidth={1.5}
                          dot={false}
                          isAnimationActive={false}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
