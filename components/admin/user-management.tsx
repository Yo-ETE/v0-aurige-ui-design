"use client"
import { useEffect, useState } from "react"
import { Loader2, Trash2 } from "lucide-react"
import { VIEWER_PRESET, createUser, deleteUser, listUsers, updateUser,
         type ManagedUser, type UserPermissions } from "@/lib/api"
import { useAuth } from "@/lib/auth-context"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PermissionEditor } from "@/components/admin/permission-editor"

export function UserManagement() {
  const { user: me } = useAuth()
  const [users, setUsers] = useState<ManagedUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [role, setRole] = useState<"admin" | "viewer">("viewer")
  const [busyId, setBusyId] = useState<number | null>(null)
  const [perms, setPerms] = useState<UserPermissions>({ ...VIEWER_PRESET })

  async function reload() {
    setLoading(true)
    try { setUsers(await listUsers()); setError(null) }
    catch { setError("Chargement impossible.") }
    finally { setLoading(false) }
  }
  useEffect(() => { void reload() }, [])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault(); setError(null)
    try {
      await createUser({ username: username.trim(), password, role,
                         permissions: role === "admin" ? null : perms })
      setUsername(""); setPassword(""); setRole("viewer"); setPerms({ ...VIEWER_PRESET })
      await reload()
    } catch (err) { setError(err instanceof Error ? err.message : "Création impossible.") }
  }

  async function handleToggle(u: ManagedUser) {
    setBusyId(u.id)
    try { await updateUser(u.id, { is_active: !u.is_active }); await reload() }
    catch { setError("Modification refusée.") }
    finally { setBusyId(null) }
  }

  async function handleDelete(u: ManagedUser) {
    if (!window.confirm(`Supprimer le compte « ${u.username} » ? Cette action est irréversible.`)) return
    setBusyId(u.id)
    try { await deleteUser(u.id); await reload() }
    catch { setError("Suppression refusée.") }
    finally { setBusyId(null) }
  }

  if (loading) return <Loader2 className="h-5 w-5 animate-spin" />

  return (
    <div className="space-y-6">
      {error && <p className="text-xs text-destructive">{error}</p>}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Comptes</h2>
        <ul className="divide-y divide-border rounded border border-border">
          {users.map((u) => (
            <li key={u.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="min-w-0 break-words">{u.username}
                <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase">{u.role}</span>
                {!u.is_active && <span className="ml-2 text-[10px] text-destructive">inactif</span>}
                {me?.id === u.id && <span className="ml-2 text-[10px] text-muted-foreground">(vous)</span>}
                <span className="ml-2 text-[10px] text-muted-foreground" suppressHydrationWarning>
                  {u.last_login ? `dernière connexion : ${new Date(u.last_login).toLocaleString("fr-FR")}` : "jamais connecté"}
                </span>
              </span>
              {me?.id !== u.id && (
                <div className="flex shrink-0 items-center gap-2">
                  <Button variant="outline" size="sm" disabled={busyId === u.id}
                    onClick={() => void handleToggle(u)}>
                    {u.is_active ? "Désactiver" : "Activer"}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busyId === u.id}
                    onClick={() => void handleDelete(u)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      <form onSubmit={handleCreate} className="space-y-4 rounded border border-border p-4">
        <h2 className="text-sm font-semibold">Nouveau compte</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="nu">Identifiant</Label>
            <Input id="nu" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="np">Mot de passe (min 10)</Label>
            <Input id="np" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Label>Rôle</Label>
          <select className="rounded border border-border bg-background px-2 py-1"
                  value={role} onChange={(e) => setRole(e.target.value as "admin" | "viewer")}>
            <option value="viewer">viewer</option>
            <option value="admin">admin</option>
          </select>
        </div>
        {role === "viewer" && <PermissionEditor value={perms} onChange={setPerms} />}
        <Button type="submit" disabled={username.trim().length < 2 || password.length < 10}>Créer</Button>
      </form>
    </div>
  )
}
