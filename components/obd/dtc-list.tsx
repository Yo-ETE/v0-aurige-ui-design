"use client"

import { Badge } from "@/components/ui/badge"
import type { OBDDtc } from "@/lib/api"

function categoryLetter(code: string): string {
  const c = code.charAt(0).toUpperCase()
  return c && "PCBU".includes(c) ? c : "?"
}

function categoryColor(letter: string): string {
  switch (letter) {
    case "P": return "bg-destructive text-destructive-foreground"
    case "C": return "bg-warning text-warning-foreground"
    case "B": return "bg-primary text-primary-foreground"
    default: return "bg-muted text-muted-foreground"
  }
}

interface DtcListProps {
  /** Raw code strings (fallback when no details are available) */
  codes: string[]
  /** Detailed DTCs from the backend (preferred when present) */
  details?: OBDDtc[] | null
  /** Local description lookup used when the backend gave none */
  fallbackDescribe?: (code: string) => string
}

/** Liste de DTC : "code — description" + badge de categorie (P/C/B/U). */
export function DtcList({ codes, details, fallbackDescribe }: DtcListProps) {
  const items: OBDDtc[] =
    details && details.length > 0
      ? details
      : codes.map((code) => ({ code, description: "", category: "" }))

  return (
    <div className="space-y-2">
      {items.map((d, i) => {
        const letter = categoryLetter(d.code)
        const desc = d.description || fallbackDescribe?.(d.code) || ""
        return (
          <div
            key={`${d.code}-${i}`}
            className="flex items-center gap-3 rounded-lg border border-border/50 bg-background/30 p-2.5"
          >
            <Badge className={`px-1.5 py-0.5 text-[10px] ${categoryColor(letter)}`} title={d.category || undefined}>
              {letter}
            </Badge>
            <p className="min-w-0 flex-1 break-words text-sm text-foreground">
              <span className="font-mono font-semibold">{d.code}</span>
              {" — "}
              {desc ? (
                <span>{desc}</span>
              ) : (
                <span className="italic text-muted-foreground">Description non disponible</span>
              )}
            </p>
          </div>
        )
      })}
    </div>
  )
}
