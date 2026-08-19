---
tags:
  - ev3-cockpit
  - požadavky
zdroj: "[[REQUIREMENTS.md]]"
verze: 2026-04-02
---

# Požadavky

> Kanonická verze: [[REQUIREMENTS.md]]

## Co je EVƎ Cockpit

VS Code extension, která:
- **odkrývá** EV3 briky přes Mock, USB, TCP, BT
- **připojuje** briky do runtime a **monitoruje** jejich stav v panelu
- **poskytuje veřejné API** pro jiné VS Code extensions

> [!warning] Co Cockpit není
> ❌ Není to IDE pro programování briku.  
> ❌ Není to prohlížeč filesystému v GUI.

## Uživatelé

Primárně od ~10 let do dospělých.

- základní režim: jednoduchý a přehledný
- pokročilý režim: vše dostupné přes settings a config mode
- architektura nesmí být omezena zjednodušeným GUI

## Scope této verze

**V scope:**
- Discovery a continuous tracking briků
- Connect / disconnect výhradně přes Cockpit
- Více simultánně připojených briků
- Jeden aktivní brik v popředí (foreground monitoring)
- Background heartbeat + reconnect pro připojené briky
- Subscription telemetrie pro jiné extensions
- Veřejné API (read-only session management)
- Základní filesystem API: upload, download, executeRbf, list, read
- Transporty: Mock, USB, TCP, BT
- Mock runtime (plnohodnotný transport)
- Persistence oblíbených a zapamatovaných briků

**Odloženo na další verzi:**
- Panel se seznamem programů (.rbf/.rpf) a jejich spouštění
- Run/stop workflow z panelu
- Pokročilý full-folder deploy workflow

## Hlavní workflow

1. Otevře Cockpit → vidí seznam briků
2. Vybere brik → připojí
3. Monitoruje porty, senzory, motory, systémová data
4. Přepíná mezi více připojenými briky
5. Používá jiné extensions přes Cockpit API
6. Dočasně ztratí a znovu najde brik
7. Odpojí brik nebo ho vypne

## UX

- Hlavní UX: webview v pravém sekundárním panelu VS Code
- **Discovery tab**: unified seznam (available + connected + remembered)
- **Brick tab**: per brik — image, porty A–D + 1–4, status bar, config mode
- **Config mode**: editace jména, system info, visual style toggle, status bar config
- Auto-save: debounce per field, uložení po focus loss nebo po 1 s
- Command Palette: jen fallback a diagnostika, ne primární UX

### Visual style měřených hodnot

| Styl | Popis |
| ---- | ----- |
| **Numeric** | přesná textová hodnota ze senzoru |
| **Visual** | grafický element per typ periferie (color target, arc, slider…) |

Preference se ukládá per brik.

## Stav modelu

### Presence (discovery)

```
remembered → available → unavailable → removed
                ↑              ↓
            (rediscovery)   (timeout)
```

Viz [[koncepty/Presence State Machine]]

### Session (connection)

`connecting` → `connected` → `reconnecting` → `disconnected`

### Aktivita

- Nejvýše jeden `foreground` brik
- Discovery tab = žádný aktivní brik
- `subscribed` — background brik s API subscription
- `minimal` — heartbeat only

## Identita briku

- `brickKey` — stabilní ID per transport, viz [[koncepty/BrickKey]]
- Favorite: `(brickKey, transport)` pár — není cross-transport

## Telemetrie

Kategorie: `ports` · `filesystem` · `system`

Režimy:
- `foreground` — nejrychlejší, plná data
- `subscribed` — redukovaná frekvence, jen požadované kategorie
- `minimal` — pouze heartbeat + reconnect

## Veřejné API

Exportuje: registrace consumera, snapshot, state events, telemetrie subscriptions, filesystem operace

**Neexportuje:** fyzický connect/disconnect, přímý přístup k discovery listu

Viz [[fáze/Fáze 4 - Public API]]

## Persistence

- `favorite` flag per `(brickKey, transport)`
- Visual style preference per brik
- Status bar konfigurace per brik
- Remembered metadata (jméno, transport, last seen)
- Favorite brick: auto-connect při přechodu `removed → available`
- Suppressi auto-connectu po explicit disconnect (reset na novou session)

## Kvalita

Po každé změně: `compile` + `lint` + `test-smoke`  
Pravidelně: full test suite, refactoring, performance review
