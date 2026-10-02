"use client"
import { ALL_PERMISSION_FLAGS, OPERATOR_PRESET, VIEWER_PRESET, type PermissionFlag, type UserPermissions } from "@/lib/api"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"

const AREA = ALL_PERMISSION_FLAGS.filter((f) => f.startsWith("area_"))
const ACTION = ALL_PERMISSION_FLAGS.filter((f) => !f.startsWith("area_"))

export function PermissionEditor({ value, onChange }: {
  value: UserPermissions; onChange: (v: UserPermissions) => void
}) {
  const set = (flag: PermissionFlag, on: boolean) => onChange({ ...value, [flag]: on })
  const applyPreset = (p: UserPermissions) => onChange({ ...p })
  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => applyPreset(OPERATOR_PRESET)}>Preset operator</Button>
        <Button type="button" variant="outline" size="sm" onClick={() => applyPreset(VIEWER_PRESET)}>Preset viewer</Button>
      </div>
      {[{ title: "Zones", flags: AREA }, { title: "Actions", flags: ACTION }].map((grp) => (
        <div key={grp.title} className="space-y-2">
          <p className="text-xs font-semibold text-muted-foreground">{grp.title}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {grp.flags.map((f) => (
              <label key={f} className="flex items-center justify-between gap-2 rounded border border-border px-2 py-1 text-xs">
                <span className="font-mono">{f}</span>
                <Switch checked={!!value[f]} onCheckedChange={(on) => set(f, on)} />
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
