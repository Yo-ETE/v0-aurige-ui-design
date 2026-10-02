"use client"

import { useCallback, useEffect, useState } from "react"
import {
  listDBCLibraries,
  createDBCLibrary,
  renameDBCLibrary,
  deleteDBCLibrary,
  getLibDBCExportUrl,
  type DBCLibrarySummary,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Library, Plus, Pencil, Trash2, Download, FolderOpen, Check, X, Loader2 } from "lucide-react"

export function LibraryPanel({
  onOpen,
  activeId,
  onDeleted,
  onRenamed,
}: {
  onOpen: (id: string, name: string) => void
  activeId?: string
  onDeleted?: (id: string) => void
  onRenamed?: (id: string, name: string) => void
}) {
  const [libs, setLibs] = useState<DBCLibrarySummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [newName, setNewName] = useState("")
  const [creating, setCreating] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState("")

  const refresh = useCallback(async () => {
    try {
      const res = await listDBCLibraries()
      setLibs(res.libraries)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur de chargement")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) return
    setCreating(true)
    try {
      const created = await createDBCLibrary(name)
      setNewName("")
      await refresh()
      onOpen(created.id, created.name)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Création impossible")
    } finally {
      setCreating(false)
    }
  }

  const handleRename = async (id: string) => {
    const name = renameValue.trim()
    if (!name) return
    try {
      await renameDBCLibrary(id, name)
      setRenamingId(null)
      onRenamed?.(id, name)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Renommage impossible")
    }
  }

  const handleDelete = async (lib: DBCLibrarySummary) => {
    if (!confirm(`Supprimer la bibliothèque "${lib.name}" ? Cette action est irréversible.`)) return
    try {
      await deleteDBCLibrary(lib.id)
      onDeleted?.(lib.id)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Suppression impossible")
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Library className="h-5 w-5 text-primary" />
              Bibliothèque DBC
            </CardTitle>
            <CardDescription>DBC autonomes, indépendants des missions</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              placeholder="Nom de la nouvelle bibliothèque"
              className="w-56"
            />
            <Button className="gap-2" onClick={handleCreate} disabled={creating || !newName.trim()}>
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Créer
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {error && <p className="text-xs text-destructive mb-3 break-all">{error}</p>}
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
          </div>
        ) : libs.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            Aucune bibliothèque. Créez-en une pour commencer.
          </p>
        ) : (
          <div className="space-y-2">
            {libs.map((lib) => (
              <div
                key={lib.id}
                className={`flex flex-wrap items-center gap-2 rounded-lg border p-3 ${
                  lib.id === activeId ? "border-primary bg-primary/5" : "border-border bg-secondary/30"
                }`}
              >
                <div className="min-w-0 flex-1">
                  {renamingId === lib.id ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleRename(lib.id)}
                        className="h-8 w-56"
                        autoFocus
                      />
                      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => handleRename(lib.id)}>
                        <Check className="h-4 w-4" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setRenamingId(null)}>
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ) : (
                    <>
                      <p className="text-sm font-medium break-all">{lib.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {lib.message_count} message(s) - {lib.signal_count} signal(s)
                      </p>
                    </>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <Button
                    size="sm"
                    variant={lib.id === activeId ? "default" : "outline"}
                    className={lib.id === activeId ? "gap-1" : "bg-transparent gap-1"}
                    onClick={() => onOpen(lib.id, lib.name)}
                  >
                    <FolderOpen className="h-4 w-4" />
                    Ouvrir
                  </Button>
                  <Button size="icon" variant="ghost" className="h-8 w-8" asChild title="Exporter DBC">
                    <a href={getLibDBCExportUrl(lib.id)} download>
                      <Download className="h-4 w-4" />
                    </a>
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    title="Renommer"
                    onClick={() => {
                      setRenamingId(lib.id)
                      setRenameValue(lib.name)
                    }}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 text-destructive hover:text-destructive"
                    title="Supprimer"
                    onClick={() => handleDelete(lib)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
