"use client"

import React from "react"

import { useRef, useState } from "react"
import { Upload, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { importLog, type ImportLogResponse } from "@/lib/api"
import { useToast } from "@/hooks/use-toast"

interface LogImportButtonProps {
  missionId: string
  onImportSuccess?: (result: ImportLogResponse) => void
  variant?: "default" | "outline" | "ghost"
  size?: "default" | "sm" | "lg" | "icon"
  className?: string
}

export function LogImportButton({
  missionId,
  onImportSuccess,
  variant = "outline",
  size = "default",
  className,
}: LogImportButtonProps) {
  const { toast } = useToast()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isUploading, setIsUploading] = useState(false)

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (!file.name.endsWith(".log")) {
      toast({
        title: "Format invalide",
        description: "Le fichier doit etre un .log",
        variant: "destructive",
      })
      return
    }

    setIsUploading(true)
    try {
      const result = await importLog(missionId, file)
      toast({
        title: "Log importe",
        description: result.message,
      })
      onImportSuccess?.(result)
    } catch (err) {
      toast({
        title: "Erreur d'import",
        description: err instanceof Error ? err.message : "Erreur inconnue",
        variant: "destructive",
      })
    } finally {
      setIsUploading(false)
      // Reset input to allow re-selecting same file
      if (fileInputRef.current) {
        fileInputRef.current.value = ""
      }
    }
  }

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept=".log"
        onChange={handleFileSelect}
        className="hidden"
      />
      <Button
        variant={variant}
        size={size}
        className={className}
        onClick={() => fileInputRef.current?.click()}
        disabled={isUploading || !missionId}
      >
        {isUploading ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : (
          <Upload className="h-4 w-4 mr-2" />
        )}
        Importer un log
      </Button>
    </>
  )
}
