"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { getBlocklist } from "@/lib/api"

/** Normalise un ID CAN : trim, majuscules, sans prefixe 0x. */
export function normalizeCanId(id: string): string {
  return (id || "").trim().toUpperCase().replace(/^0X/, "")
}

/**
 * Charge la liste d'IDs critiques (blocklist AUD-06) pour proposer une
 * confirmation avant une injection volontaire. Garde-fou UI uniquement :
 * le backend ne bloque pas ces actions explicites.
 */
export function useCriticalIds() {
  const [ids, setIds] = useState<string[]>([])

  const refresh = useCallback(() => {
    getBlocklist()
      .then((res) => setIds((res?.ids ?? []).map(normalizeCanId)))
      .catch(() => setIds([]))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const set = useMemo(() => new Set(ids), [ids])
  const isCritical = useCallback(
    (canId: string) => {
      const n = normalizeCanId(canId)
      if (!n) return false
      if (set.has(n)) return true
      // Egalite entiere (ex. "07DF" vs "7DF").
      const v = parseInt(n, 16)
      if (Number.isNaN(v)) return false
      return ids.some((i) => parseInt(i, 16) === v)
    },
    [set, ids],
  )

  return { ids, isCritical, refresh }
}
