# TS cleanup report
tsc --noEmit: 80 -> 0. npm run build: green.

1. SentFrame.interface widened to CANInterface; trackFrame sendFn now Promise<unknown> (unmasked 5 replay-rapide errors).
2. WifiStatus: hasInternet, pingMs, downloadSpeed, secondaryInterfaces (new WifiSecondaryInterface type) optional.
3. DBCSignal: sample_before/ack/status optional (backend model has them). message_id NOT added: analyse-can save sent wrong field names (message_id, bit_length, factor, min_value, max_value) whereas backend DBCSignal requires can_id, length, scale, min_val, max_val -> would 422, silently swallowed. Fixed the call (REAL BUG).
4. Mission: canInterface/bitrate are NOT flat; they live in mission.canConfig.interface/bitrate. UI read wrong path (mission-list showed blank interface; mission page always showed "can0 @ 500k"). Fixed UI (REAL BUG). lastCaptureDate?: added to both Mission types (lib/api.ts and lib/mission-store.ts).
5. lucide title prop: wrapped icons in <span title>.
6. AppShell title: analyse-can, crash-recovery, dbc passed no title (empty header band + own duplicated h1). Now pass title/description to AppShell and removed the duplicate inner headings (visual change: heading now in shell bar like other pages).
7. Isolation: IsolationLog.parentId added; LogFrame cast removed (omitted timestamp: 0, keeps same early-return behavior); canId undefined guards (early return); selectedFrame.timestamp ?? "0".
   :2250/:2258 bug: diffViewMode === "outline" never true (mixed up with Button variant), so inactive Octets/Bits buttons never got bg-transparent. Now !== "bytes" / !== "bits".
Unconfirmed: lastCaptureDate serialization alias assumed per backend main.py:182.
