"use client"

import { useCallback, useEffect, useState } from "react"
import { Radio, Square } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { getInjectStatus, stopInject, type InjectStatus } from "@/lib/api"
import { cn } from "@/lib/utils"

export function InjectStatusBar({ className }: { className?: string }) {
  const [status, setStatus] = useState<InjectStatus | null>(null)
  const [stopping, setStopping] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setStatus(await getInjectStatus())
    } catch {
      // erreur transitoire : on garde le dernier état connu
    }
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 1000)
    return () => clearInterval(id)
  }, [refresh])

  const handleStop = async () => {
    setStopping(true)
    try {
      await stopInject()
    } catch {
      // ignoré : le re-poll reflète l'état réel
    } finally {
      setStopping(false)
      await refresh()
    }
  }

  if (!status?.running) return null

  return (
    <Alert
      variant="destructive"
      className={cn("flex items-center justify-between gap-3", className)}
    >
      <Radio className="h-4 w-4 animate-pulse" />
      <AlertDescription className="flex-1">
        Injection de fond : {status.description}
      </AlertDescription>
      <Button
        size="sm"
        variant="destructive"
        onClick={handleStop}
        disabled={stopping}
      >
        <Square className="mr-1 h-3 w-3" />
        Stop
      </Button>
    </Alert>
  )
}
