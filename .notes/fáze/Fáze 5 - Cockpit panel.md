---
tags:
  - ev3-cockpit
  - fáze
fáze: 5
název: Cockpit panel a UX
stav: plánováno
---

# Fáze 5 — Cockpit panel a UX

**Stav:** ⬜ plánováno  
**Cíl:** Hlavní produkt UX nad hotovým runtimem.

## Úkoly

### 5.1 Webview panel infrastruktura
- [ ] Panel provider registrace (pravý sekundární panel)
- [ ] Panel lifecycle (show / hide / dispose)
- [ ] Asset pipeline (CSS, images, fonts)
- [ ] Content Security Policy pro webview

### 5.2 Extension ↔ Webview messaging protocol
- [ ] Message type definitions (actions z webview, events z runtime)
- [ ] Snapshot request/response (pull model)
- [ ] Event push (state changes, telemetry updates)
- [ ] Action dispatch (connect, disconnect, focus, forget, toggle favorite…)
- [ ] Webview recovery po reload — request fresh snapshot

### 5.3 Discovery tab
- [ ] Unified brick list (available + connected + remembered)
- [ ] Transport icons per provider type
- [ ] Color-coded status indicators
- [ ] Supplementary icons — signal strength, favorite star (display), trash
- [ ] Quick actions: connect, focus/open, forget
- [ ] Stabilní řazení (transport group → signal → brickKey)
- [ ] Efficient rendering pro desítky položek

### 5.4 Brick tab
- [ ] Tab creation on connect, removal on disconnect
- [ ] Tab header: transport icon + status color + brick name + gear + X
- [ ] Status bar: available transports | battery | favorite star (klikatelný toggle)
- [ ] Brick image s interaktivními tlačítky
- [ ] Motor porty A–D — peripheral icon + measured value
- [ ] Sensor porty 1–4 — peripheral icon + measured value
- [ ] Disconnected peripheral indication

### 5.5 Value display modes
- [ ] Numeric style — exact text value
- [ ] Visual style — per-peripheral grafické elementy:
  - [ ] Color sensor → color target
  - [ ] Touch sensor → press state indicator
  - [ ] Gyro → arc s indikátorem
  - [ ] Ultrasonic → distance bar
  - [ ] Motor → schematic rotation
- [ ] Style preference uložena per brik

### 5.6 Foreground activation
- [ ] Tab switching triggeruje `setActiveBrick()` / `clearActiveBrick()`
- [ ] Discovery tab = žádný aktivní brik
- [ ] Active brick read model řídí obsah tabu

### 5.7 Config mode
- [ ] Gear icon toggles between normal and config mode (stejný tab)
- [ ] Editovatelné jméno briku s auto-save
- [ ] System + technical info (read-only)
- [ ] Visual style toggle (`numeric` / `visual`)
- [ ] Status bar konfigurace
- [ ] Auto-save debounce — timer per field, save on focus loss nebo po 1s
- [ ] Optimistic updates — local event hned, telemetrie potvrdí
- [ ] Žádný star toggle v config mode
- [ ] Žádné porty/senzory v config mode

### 5.8 CSS a vizuální design
- [ ] VS Code theme integrace (dark / light / high contrast)
- [ ] Responsive layout pro různé velikosti panelu
- [ ] Icon set pro transporty, periferie, status indikátory

### 5.9 Smoke testy
- [ ] Panel se otevře a vykreslí discovery tab
- [ ] Connect na mock brik vytvoří brick tab
- [ ] Tab switching aktualizuje foreground brik
- [ ] Config mode toggle funguje
- [ ] Disconnect odstraní brick tab

## UX pravidla

> [!important]
> - Panel zobrazuje jen runtime read model
> - Žádná domain logika pro reconnecty ve webview
> - Žádný filesystem browser v panelu

## Definition of Done

- Uživatel může provádět vše přes panel
- Aktivní brik odpovídá tabům
- Discovery tab podporuje connect/focus/forget
- Config mode mění runtime data přes definované akce
- Všechny smoke testy procházejí
- Antipattern cleanup

## Viz také

- [[moduly/Extension]] — panel provider registrace
- [[fáze/Fáze 4 - Public API]] — předchozí fáze
- [[fáze/Fáze 6 - Persistence]] — navazující fáze
- [[Požadavky]] §6 — UX requirements
- [[Plán implementace]]
