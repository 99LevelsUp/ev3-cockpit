---
tags:
  - ev3-cockpit
  - fáze
fáze: 6
název: Persistence, favorites, remembered
stav: plánováno
---

# Fáze 6 — Persistence, favorites, remembered devices

**Stav:** ⬜ plánováno  
**Cíl:** Dlouhodobé chování Cockpitu přes restarty.

## Úkoly

### 6.1 globalState adapter
- [ ] Schema definition pro persisted data
- [ ] Type-safe read/write přes `ExtensionContext.globalState`
- [ ] Schema versioning a migration strategy
- [ ] Inicializace při activation

### 6.2 Per-brick metadata storage
- [ ] `favorite` flag per `(brickKey, transport)` pár
- [ ] Preferred visual style (`numeric` / `visual`) per brik
- [ ] Status bar konfigurace per brik
- [ ] Remembered display metadata (name, transport, last seen)

### 6.3 Favorite toggle flow
- [ ] Toggle z brick tab status bar (star click)
- [ ] Persist hned do globalState
- [ ] Update discovery list star indikátor
- [ ] Favorite je bound na `(brickKey, transport)` — ne cross-transport

### 6.4 Auto-connect na favorite discovery
- [ ] Trigger na `removed → available` (rediscovery v session)
- [ ] Trigger na `remembered → available` (session start)
- [ ] Trigger na `[*] → available` (první discovery v session)
- [ ] Suppression po explicit disconnect v aktuální session
- [ ] Reset suppression na novou VS Code session

### 6.5 Remembered brick merge s OS evidence
- [ ] BT pairing detection — čtení OS-level paired devices
- [ ] Merge algorithm — kombinace persisted metadata s OS evidence
- [ ] Handle conflicts (persisted name vs OS name)
- [ ] Remembered briky viditelné v discovery listu i offline

### 6.6 Forget flow
- [ ] Trash action v discovery listu pro remembered offline briky
- [ ] Delete všechna local persisted metadata (včetně `favorite`)
- [ ] OS-level unpair kde provider podporuje
- [ ] Windows USB: delete `BTHPORT\Parameters\Devices\{mac}` registry entry (zdroj display name — bez smazání přežije stale name přejmenování)
- [ ] Provider capability check před nabídnutím forget action

### 6.7 Unit testy
- [ ] globalState adapter read/write/migration
- [ ] Favorite toggle persistence
- [ ] Auto-connect trigger a suppression
- [ ] Remembered brick merge
- [ ] Forget flow cleanup

## Definition of Done

- Favorite brik se auto-connectuje jen v definovaných scénářích
- Remembered briky jsou viditelné i offline
- Forget správně odstraní local i OS metadata
- Auto-connect suppression funguje po explicit disconnect
- Všechny persistence operace pokryty testy
- Antipattern cleanup

## Persistence lokace

`ExtensionContext.globalState` — standardní per-user VS Code storage.  
OS-specific evidence (BT pairing) zůstává mimo a čte se přes provider.

## Viz také

- [[moduly/Contracts]] — `(brickKey, transport)` identity
- [[koncepty/Presence State Machine]] — `remembered → available` transitions
- [[koncepty/BrickKey]] — stabilní identita
- [[fáze/Fáze 5 - Cockpit panel]] — předchozí fáze
- [[fáze/Fáze 7 - Hardening]] — navazující fáze
- [[Plán implementace]]
