# Generateur backend - rapport

## Construction de cmd
- Base : `cangen <iface> -g <delay>`.
- `-L <len>` ajoute sauf si data_mode=fixed (cangen deduit la longueur des octets de `-D` ; -L omis).
- ID : fixed -> `-I <can_id>` (can_id requis, 400 sinon) ; increment -> `-I i` ; random -> `-I r` (explicite, pas omis).
- id_mode absent (None) = retro-compat : fixed si can_id fourni, sinon random.
- Data : fixed -> `-D <HEX upper>` (regex `^([0-9A-Fa-f]{2}){1,8}$`, 400 sinon) ; increment -> `-D i` ; random -> omis.
- count (1..1_000_000, 400 sinon) -> `-n <count>`.
- AUD-06 : fixed -> is_id_blocked -> 403 ; random OU increment + blocklist non vide -> 403 (message existant). Jamais base sur les donnees.

## Signature client
`startGenerator(iface, { delayMs, dataLength, idMode?, canId?, dataMode?, dataValue?, count? })` (type `GeneratorOptions`, plus `GeneratorIdMode`/`GeneratorDataMode`). Breaking vs positional : app/generateur/page.tsx adapte minimalement (T2 le refera).

## Tests
backend/tests/test_generator.py (8 tests). Suite complete verte.
