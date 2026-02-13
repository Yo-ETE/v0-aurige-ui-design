"use client"

import { useMemo } from "react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { FolderTree } from "lucide-react"
import type { LogEntry } from "@/lib/api"

interface LogSelectorProps {
  logs: LogEntry[]
  value: string
  onValueChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  className?: string
  triggerClassName?: string
}

interface LogNode {
  log: LogEntry
  children: LogNode[]
  depth: number
}

function buildTree(logs: LogEntry[]): LogNode[] {
  const logMap = new Map<string, LogEntry>()
  logs.forEach((l) => logMap.set(l.id, l))

  const childrenMap = new Map<string, LogEntry[]>()
  const rootLogs: LogEntry[] = []

  logs.forEach((l) => {
    if (l.parentId && logMap.has(l.parentId)) {
      const children = childrenMap.get(l.parentId) || []
      children.push(l)
      childrenMap.set(l.parentId, children)
    } else {
      rootLogs.push(l)
    }
  })

  function toNode(log: LogEntry, depth: number): LogNode {
    const children = (childrenMap.get(log.id) || [])
      .sort((a, b) => a.filename.localeCompare(b.filename))
      .map((c) => toNode(c, depth + 1))
    return { log, children, depth }
  }

  return rootLogs
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map((l) => toNode(l, 0))
}

function flattenTree(nodes: LogNode[]): LogNode[] {
  const result: LogNode[] = []
  function walk(node: LogNode) {
    result.push(node)
    node.children.forEach(walk)
  }
  nodes.forEach(walk)
  return result
}

export function LogSelector({
  logs,
  value,
  onValueChange,
  placeholder = "Selectionnez un log",
  disabled = false,
  className,
  triggerClassName,
}: LogSelectorProps) {
  const flatNodes = useMemo(() => flattenTree(buildTree(logs)), [logs])

  const selectedLog = logs.find((l) => l.id === value || l.filename === value)
  const displayValue = selectedLog
    ? `${selectedLog.filename} (${selectedLog.framesCount?.toLocaleString() ?? "?"} trames)`
    : undefined

  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger className={triggerClassName || "h-8 text-xs"}>
        <SelectValue placeholder={placeholder}>
          {displayValue}
        </SelectValue>
      </SelectTrigger>
      <SelectContent className={className}>
        {flatNodes.map((node) => {
          const { log, depth } = node
          const hasChildren = node.children.length > 0
          const isChild = depth > 0
          const indent = depth * 16

          return (
            <SelectItem
              key={log.id || log.filename}
              value={log.filename}
              className="text-xs"
            >
              <span className="flex items-center gap-1.5" style={{ paddingLeft: `${indent}px` }}>
                {hasChildren && <FolderTree className="h-3 w-3 text-primary shrink-0" />}
                {isChild && (
                  <span className="text-muted-foreground/50 mr-0.5">{"└"}</span>
                )}
                <span className={isChild ? "text-muted-foreground" : ""}>
                  {log.filename}
                </span>
                <span className="text-muted-foreground/60 ml-1">
                  ({log.framesCount?.toLocaleString() ?? "?"} tr.)
                </span>
              </span>
            </SelectItem>
          )
        })}
      </SelectContent>
    </Select>
  )
}
