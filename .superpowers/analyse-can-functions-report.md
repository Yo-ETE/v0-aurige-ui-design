# Analyse CAN - 4 fonctions

File: app/analyse-can/page.tsx (only file changed).
1. Auto-detect table: search Input (can_id/name), sortable headers Plage (span) / Entropie / Confiance (toggle desc/asc), count "N / total signaux", select-all acts on the filtered set. Dependencies: source-ID search + min score % number input (0-100, default 0) + "N / total aretes".
2. Type column: Flag (bit_length===1), Compteur? (change_rate>=0.95), Valeur.
3. Send to Replay Rapide: Send button per signal row and per heatmap row; addFrames([{canId, data:"", timestamp:"0", source:"analyse-<name|id>"}]) then router.push("/replay-rapide"). Tooltip "Pré-remplit l'ID dans Replay Rapide". No bus injection.
4. Heatmap "Signaux" button: sets signalSearch=can_id, setTab("autodetect"), and runs the existing runAutoDetect() if detectResult is null, not loading, and a log is selected (otherwise only switches tab + filter).
Deviation: none. tsc: 80 errors after (baseline 80/81 measured while editing); the 2 errors in this file are pre-existing (message_id, AppShell title). Build green.
