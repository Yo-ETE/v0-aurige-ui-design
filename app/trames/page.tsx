"use client"

import { AppShell } from "@/components/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { FileText, Radio } from "lucide-react"

export default function Trames() {
  return (
    <AppShell
      title="Trames"
      description="Trames CAN découvertes et cataloguées"
    >
      <div className="grid gap-6">
        <Card className="border-border bg-card">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <FileText className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-lg">Catalogue de trames</CardTitle>
                <CardDescription>
                  Trames CAN identifiées et documentées
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="relative mb-6">
                <Radio className="h-16 w-16 text-muted-foreground/30" />
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="h-8 w-8 animate-ping rounded-full bg-primary/20" />
                </div>
              </div>
              <h3 className="text-lg font-semibold text-foreground">
                Aucune trame CAN découverte
              </h3>
              <p className="mt-2 max-w-md text-sm text-muted-foreground">
                Démarrez une capture pour découvrir et cataloguer les trames CAN 
                présentes sur le bus. Les trames isolées et identifiées apparaîtront ici.
              </p>
              <div className="mt-6 flex gap-3">
                <a
                  href="/capture-replay"
                  className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  Démarrer une capture
                </a>
                <a
                  href="/isolation"
                  className="inline-flex items-center justify-center rounded-md border border-border bg-transparent px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
                >
                  Isoler une trame
                </a>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  )
}
