"use client"

import { useState } from "react"
import { AppShell } from "@/components/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { GitBranch, Play, FlaskConical, Trash2, FileText, ChevronRight, Info } from "lucide-react"

interface LogItem {
  id: string
  name: string
  tags: string[]
  children?: LogItem[]
}

const mockLogTree: LogItem[] = [
  {
    id: "1",
    name: "capture_door_unlock.log",
    tags: ["original"],
    children: [
      {
        id: "1-1",
        name: "capture_door_unlock_part1.log",
        tags: ["success"],
        children: [
          { id: "1-1-1", name: "capture_door_unlock_p1_a.log", tags: ["success"] },
          { id: "1-1-2", name: "capture_door_unlock_p1_b.log", tags: ["failed"] },
        ],
      },
      { id: "1-2", name: "capture_door_unlock_part2.log", tags: ["failed"] },
    ],
  },
  {
    id: "2",
    name: "capture_window_control.log",
    tags: ["original"],
  },
]

const steps = [
  { number: 1, title: "Capturer une action", description: "Enregistrez le trafic CAN pendant une action véhicule" },
  { number: 2, title: "Importer le log", description: "Importez le fichier de capture dans l'outil" },
  { number: 3, title: "Rejouer", description: "Rejouez le log complet et vérifiez si l'action se reproduit" },
  { number: 4, title: "Diviser le log", description: "Coupez le log en deux et testez chaque partie" },
  { number: 5, title: "Itérer", description: "Répétez jusqu'à isoler la trame responsable" },
]

function LogTreeItem({ item, depth = 0 }: { item: LogItem; depth?: number }) {
  const [isExpanded, setIsExpanded] = useState(true)
  const hasChildren = item.children && item.children.length > 0

  return (
    <div className="space-y-1">
      <div
        className="flex items-center gap-2 rounded-md border border-border bg-secondary/50 p-3 hover:bg-secondary"
        style={{ marginLeft: depth * 24 }}
      >
        {hasChildren && (
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            onClick={() => setIsExpanded(!isExpanded)}
          >
            <ChevronRight className={`h-4 w-4 transition-transform ${isExpanded ? "rotate-90" : ""}`} />
          </Button>
        )}
        {!hasChildren && <div className="w-6" />}
        <FileText className="h-4 w-4 text-muted-foreground" />
        <span className="flex-1 truncate font-mono text-sm">{item.name}</span>
        <div className="flex items-center gap-2">
          {item.tags.map((tag) => (
            <Badge
              key={tag}
              variant={tag === "success" ? "default" : tag === "failed" ? "destructive" : "secondary"}
              className={tag === "success" ? "bg-success text-success-foreground" : ""}
            >
              {tag}
            </Badge>
          ))}
          <div className="flex items-center gap-1 ml-2">
            <Button size="icon" variant="ghost" className="h-7 w-7">
              <Play className="h-3 w-3" />
            </Button>
            <Button size="icon" variant="ghost" className="h-7 w-7">
              <FlaskConical className="h-3 w-3" />
            </Button>
            <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive">
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </div>
      {hasChildren && isExpanded && (
        <div className="space-y-1">
          {item.children?.map((child) => (
            <LogTreeItem key={child.id} item={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

export default function Isolation() {
  const [logs] = useState<LogItem[]>(mockLogTree)

  return (
    <AppShell
      title="Isolation"
      description="Isoler une trame CAN responsable d'une action"
    >
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Instructions Card */}
        <Card className="border-border bg-card lg:col-span-1">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <Info className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-lg">Instructions</CardTitle>
                <CardDescription>
                  Méthode d&apos;isolation binaire
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {steps.map((step) => (
                <div key={step.number} className="flex gap-3">
                  <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                    {step.number}
                  </div>
                  <div>
                    <p className="font-medium text-foreground">{step.title}</p>
                    <p className="text-xs text-muted-foreground">{step.description}</p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Log Tree Card */}
        <Card className="border-border bg-card lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                  <GitBranch className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <CardTitle className="text-lg">Arbre de logs</CardTitle>
                  <CardDescription>
                    Logs et sous-divisions pour l&apos;isolation
                  </CardDescription>
                </div>
              </div>
              <Button variant="outline" size="sm">
                Importer un log
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {logs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <GitBranch className="mb-3 h-12 w-12 text-muted-foreground/50" />
                <p className="text-sm text-muted-foreground">
                  Aucun log importé
                </p>
                <p className="text-xs text-muted-foreground">
                  Importez un log pour commencer l&apos;isolation
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {logs.map((log) => (
                  <LogTreeItem key={log.id} item={log} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  )
}
