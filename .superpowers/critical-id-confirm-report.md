# Confirmation injection volontaire sur ID critique (AUD-06)

Helper `lib/critical-ids.ts`:
- `normalizeCanId(id)`: trim, uppercase, strip leading 0X.
- `useCriticalIds()` -> `{ ids, isCritical(canId), refresh() }`; loads `getBlocklist()` on mount (error -> empty); match = normalized string or integer-equal hex.

Replay Rapide (`app/replay-rapide/page.tsx`): `guardCritical(canIds, run)` + `pendingCritical` state + AlertDialog. Applied to slot send (click + keyboard shortcuts), burst, manual send, single exported frame, "Rejouer tout". Validation errors still surface before the dialog. Multi-frame (replay all): one dialog listing the distinct critical ids found among valid frames, then the whole batch runs. Burst: one confirm before the loop.

Comparaison (`app/comparaison/page.tsx`): `handleLoopFrame` -> if `isCritical(frame.can_id)` sets `pendingLoop` and shows AlertDialog; confirm calls `doLoopFrame` (startInjectFrame). Non-critical: unchanged.

Not touched: keep-alive, crash-recovery known-frame replay, Comparaison single "Envoyer" (sendCANFrame) button.
