# scan-bitrate : interface UP au meilleur debit
- Helper reutilise : `main.can_interface_up(interface, bitrate)` (down -> type can bitrate -> up).
- Appel : `backend/routers/can.py`, `scan_bitrate`, apres le tri des resultats, si `best` est truthy (try/except, le scan reste valide). Sans best : interface laissee DOWN.
- Reponse `BitrateScanResponse` inchangee.
- Tests : `backend/tests/test_scan_bitrate.py` (login admin, mock `main.run_command` + `asyncio.create_subprocess_exec`) : derniere commande = `up` apres reglage du meilleur debit ; sans trafic derniere commande = `down`.
