# Sniffer notch - rapport

## Store (lib/sniffer-store.ts)
Added state: notchActive, notchBaseline Map<id,string[]>, noiseMask Map<id,Set<number>>,
changedSinceNotchById Map<id,Set<number>>, changeCountSinceNotchById Map<id,number[]>.
Actions: setNotch (snapshot frameMap bytes, clear 3 maps), clearNotch, absorbNoise (union changed->mask, clear changed, zero counts; no-op if notch off).
clearFrames also drops the notch (baseline would refer to cleared frames).

## WS hook
In start() onmessage, just before `new Map(frameMap)`: if notchActive, missing baseline -> baseline=newBytes;
else loop i<dlc: skip if equal to baseline or in noiseMask, else add to changedSince set + increment count.
Maps mutated in place (keyed by id), included via get() each frame.

## Render (components/floating-terminal.tsx)
- ColoredByte: notch off = unchanged markup. Notch on: amber lit (ring) if changedSince, struck/dim if noise, count sub-label when >1.
- BitByte + per-row "bits" button: 8 bits (nibble gap); diff vs notchBaseline when notch on (amber) else vs prevBytes (red).
- Toolbar: Figer / "Référence figée" indicator / Noyer le bruit / Reset with tooltips.
- filteredIds memo: when notchActive, rows with non-empty changedSince pinned first (stable partition); idle rows opacity-40. Default order untouched.

## Perf
Store work O(dlc) per frame, no sorting in store. Partition is O(n IDs) in the render memo, only when notch on (memo already re-runs per frame because frameMap changes).
