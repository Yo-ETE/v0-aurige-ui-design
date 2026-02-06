"use client"

import { useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { useMissionStore, type Vehicle, type Mission } from "@/lib/mission-store"
import { cn } from "@/lib/utils"
import { ChevronLeft, ChevronRight, Check, FileText, Car } from "lucide-react"

interface MissionWizardProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  editMission?: Mission | null
  editVehicleOnly?: boolean
}

const currentYear = new Date().getFullYear()

function isValidVin(vin: string): boolean {
  if (!vin) return true // Empty is valid (optional field)
  return vin.length === 17
}

export function MissionWizard({
  open,
  onOpenChange,
  editMission,
  editVehicleOnly = false,
}: MissionWizardProps) {
  const router = useRouter()
  const addMission = useMissionStore((state) => state.addMission)
  const updateMission = useMissionStore((state) => state.updateMission)
  const updateMissionVehicle = useMissionStore((state) => state.updateMissionVehicle)
  const setCurrentMission = useMissionStore((state) => state.setCurrentMission)

  // Step state
  const [step, setStep] = useState(editVehicleOnly ? 2 : 1)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Step 1: Mission details
  const [name, setName] = useState(editMission?.name ?? "")
  const [notes, setNotes] = useState(editMission?.notes ?? "")

  // Step 2: Vehicle details
  const [brand, setBrand] = useState(editMission?.vehicle.brand ?? "")
  const [model, setModel] = useState(editMission?.vehicle.model ?? "")
  const [year, setYear] = useState(editMission?.vehicle.year?.toString() ?? "")
  const [vin, setVin] = useState(editMission?.vehicle.vin ?? "")
  const [fuel, setFuel] = useState(editMission?.vehicle.fuel ?? "")
  const [engine, setEngine] = useState(editMission?.vehicle.engine ?? "")
  const [trim, setTrim] = useState(editMission?.vehicle.trim ?? "")

  // Validation
  const isStep1Valid = name.trim().length > 0
  const yearNum = Number.parseInt(year, 10)
  const isYearValid = !Number.isNaN(yearNum) && yearNum >= 1900 && yearNum <= currentYear
  const isVinValid = isValidVin(vin)
  const isStep2Valid = brand.trim().length > 0 && model.trim().length > 0 && isYearValid && isVinValid

  const resetForm = useCallback(() => {
    setStep(1)
    setName("")
    setNotes("")
    setBrand("")
    setModel("")
    setYear("")
    setVin("")
    setFuel("")
    setEngine("")
    setTrim("")
    setIsSubmitting(false)
  }, [])

  const handleClose = () => {
    onOpenChange(false)
    // Reset form after animation
    setTimeout(resetForm, 200)
  }

  const handleNext = () => {
    if (step === 1 && isStep1Valid) {
      setStep(2)
    }
  }

  const handleBack = () => {
    if (step === 2 && !editVehicleOnly) {
      setStep(1)
    }
  }

  const handleSubmit = async () => {
    if (!isStep2Valid) return
    if (!editVehicleOnly && !isStep1Valid) return

    setIsSubmitting(true)

    const vehicle: Vehicle = {
      brand: brand.trim(),
      model: model.trim(),
      year: yearNum,
      vin: vin.trim() || undefined,
      fuel: fuel.trim() || undefined,
      engine: engine.trim() || undefined,
      trim: trim.trim() || undefined,
    }

    try {
      if (editMission) {
        if (editVehicleOnly) {
          await updateMissionVehicle(editMission.id, vehicle)
        } else {
          await updateMission(editMission.id, {
            name: name.trim(),
            notes: notes.trim() || undefined,
            vehicle,
          })
        }
        handleClose()
      } else {
        const newMission = await addMission({
          name: name.trim(),
          notes: notes.trim() || undefined,
          vehicle,
        })
        if (newMission) {
          setCurrentMission(newMission.id)
          handleClose()
          router.push(`/missions/${newMission.id}`)
        } else {
          setIsSubmitting(false)
        }
      }
    } catch (error) {
      console.error("Failed to save mission:", error)
      setIsSubmitting(false)
    }
  }

  const title = editMission
    ? editVehicleOnly
      ? "Modifier le véhicule"
      : "Modifier la mission"
    : "Nouvelle mission"

  const description = editMission
    ? editVehicleOnly
      ? "Modifiez les informations du véhicule associé à cette mission."
      : "Modifiez les informations de la mission."
    : "Créez une nouvelle mission d'analyse CAN."

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="bg-card border-border sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="text-foreground flex items-center gap-2">
            {step === 1 ? (
              <FileText className="h-5 w-5 text-primary" />
            ) : (
              <Car className="h-5 w-5 text-primary" />
            )}
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {/* Step indicator */}
        {!editVehicleOnly && (
          <div className="flex items-center justify-center gap-2 py-2">
            <div
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium transition-colors",
                step === 1
                  ? "bg-primary text-primary-foreground"
                  : "bg-primary/20 text-primary"
              )}
            >
              {step > 1 ? <Check className="h-4 w-4" /> : "1"}
            </div>
            <div className="h-0.5 w-12 bg-border" />
            <div
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium transition-colors",
                step === 2
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-muted-foreground"
              )}
            >
              2
            </div>
          </div>
        )}

        {/* Step 1: Mission details */}
        {step === 1 && !editVehicleOnly && (
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="mission-name">
                Nom de la mission <span className="text-destructive">*</span>
              </Label>
              <Input
                id="mission-name"
                placeholder="Ex: BMW Série 1 - Diagnostic ABS"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="bg-input border-border"
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="notes">Notes (optionnel)</Label>
              <Textarea
                id="notes"
                placeholder="Informations complémentaires sur la mission..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                className="bg-input border-border resize-none"
              />
            </div>
          </div>
        )}

        {/* Step 2: Vehicle details */}
        {step === 2 && (
          <div className="space-y-4 py-2">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="brand">
                  Marque <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="brand"
                  placeholder="Ex: BMW"
                  value={brand}
                  onChange={(e) => setBrand(e.target.value)}
                  className="bg-input border-border"
                  autoFocus={editVehicleOnly}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="model">
                  Modèle <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="model"
                  placeholder="Ex: Série 1"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="bg-input border-border"
                />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="year">
                  Année <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="year"
                  type="number"
                  placeholder={currentYear.toString()}
                  value={year}
                  onChange={(e) => setYear(e.target.value)}
                  min={1900}
                  max={currentYear}
                  className={cn(
                    "bg-input border-border",
                    year && !isYearValid && "border-destructive"
                  )}
                />
                {year && !isYearValid && (
                  <p className="text-xs text-destructive">
                    Année entre 1900 et {currentYear}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="vin">VIN (optionnel)</Label>
                <Input
                  id="vin"
                  placeholder="17 caractères"
                  value={vin}
                  onChange={(e) => setVin(e.target.value.toUpperCase())}
                  maxLength={17}
                  className={cn(
                    "bg-input border-border font-mono",
                    vin && !isVinValid && "border-destructive"
                  )}
                />
                {vin && !isVinValid && (
                  <p className="text-xs text-destructive">
                    Le VIN doit contenir 17 caractères
                  </p>
                )}
              </div>
            </div>

            {/* Advanced vehicle options */}
            <Accordion type="single" collapsible className="w-full">
              <AccordionItem value="advanced" className="border-border">
                <AccordionTrigger className="text-sm text-muted-foreground hover:text-foreground py-2">
                  Options avancées
                </AccordionTrigger>
                <AccordionContent className="space-y-4 pt-2">
                  <div className="grid gap-4 sm:grid-cols-3">
                    <div className="space-y-2">
                      <Label htmlFor="fuel">Carburant</Label>
                      <Input
                        id="fuel"
                        placeholder="Essence"
                        value={fuel}
                        onChange={(e) => setFuel(e.target.value)}
                        className="bg-input border-border"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="engine">Moteur</Label>
                      <Input
                        id="engine"
                        placeholder="2.0L 150ch"
                        value={engine}
                        onChange={(e) => setEngine(e.target.value)}
                        className="bg-input border-border"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="trim">Finition</Label>
                      <Input
                        id="trim"
                        placeholder="Sport"
                        value={trim}
                        onChange={(e) => setTrim(e.target.value)}
                        className="bg-input border-border"
                      />
                    </div>
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          {step === 2 && !editVehicleOnly && (
            <Button
              variant="outline"
              onClick={handleBack}
              className="gap-2 bg-transparent"
            >
              <ChevronLeft className="h-4 w-4" />
              Retour
            </Button>
          )}
          <div className="flex-1" />
          {step === 1 && !editVehicleOnly ? (
            <Button onClick={handleNext} disabled={!isStep1Valid} className="gap-2">
              Suivant
              <ChevronRight className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              onClick={handleSubmit}
              disabled={!isStep2Valid || isSubmitting}
              className="gap-2"
            >
              {isSubmitting ? (
                "Enregistrement..."
              ) : editMission ? (
                <>
                  <Check className="h-4 w-4" />
                  Enregistrer
                </>
              ) : (
                <>
                  <Check className="h-4 w-4" />
                  Créer la mission
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
