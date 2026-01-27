"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { MissionWizard } from "./mission-wizard"
import { Plus, Upload, Car } from "lucide-react"

export function MissionCreate() {
  const [showWizard, setShowWizard] = useState(false)

  const handleImport = () => {
    // Mock import functionality
    alert("Fonctionnalité d'import à venir")
  }

  return (
    <>
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg font-semibold text-foreground">
            Créer une mission
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 mb-4">
              <Car className="h-8 w-8 text-primary" />
            </div>
            <h3 className="text-base font-medium text-foreground mb-2">
              Nouvelle analyse véhicule
            </h3>
            <p className="text-sm text-muted-foreground max-w-xs mb-6">
              Créez une nouvelle mission pour analyser le bus CAN d'un véhicule.
              Renseignez les informations du véhicule pour commencer.
            </p>
            <div className="flex gap-3">
              <Button onClick={() => setShowWizard(true)} className="gap-2">
                <Plus className="h-4 w-4" />
                Créer
              </Button>
              <Button
                variant="outline"
                onClick={handleImport}
                className="gap-2 bg-transparent"
              >
                <Upload className="h-4 w-4" />
                Importer
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <MissionWizard open={showWizard} onOpenChange={setShowWizard} />
    </>
  )
}
