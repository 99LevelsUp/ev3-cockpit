---
tags:
  - ev3-cockpit
  - koncept
koncept: Firmware Safety
---

# Firmware Safety

EV3 firmware je citlivé na přetížení příkazy — příliš rychlé odesílání nebo rychlé přepínání transportů může způsobit **freeze** (zamrznutí firmware), které vyžaduje fyzický reboot briku.

## Omezení

### Rate limit: ≤ 10 příkazů/s per brik

Maximálně 10 příkazů za sekundu na jeden brik, bez ohledu na to, kolik consumerů posílá příkazy.

```typescript
FIRMWARE_SAFETY.MAX_COMMANDS_PER_SECOND = 10
```

### Transport switch cooldown: 2s

Po přepnutí transportu (např. z USB na BT) musí uplynout 2 sekundy před odesláním dalšího příkazu. Okamžité přepnutí může způsobit firmware freeze.

```typescript
FIRMWARE_SAFETY.TRANSPORT_SWITCH_COOLDOWN_MS = 2000
```

## TransportGuard

`TransportGuard` (`src/transports/transportGuard.ts`) vynucuje obě omezení:

- **Rate limiting**: udržuje token bucket nebo timestamp posledního příkazu per brik, blokuje/odkládá příkazy nad limit
- **Switch cooldown**: trackuje active transport per brik, aplikuje 2s delay při změně
- **Degradation tracking**: sleduje, jak často brik nestíhá (indikátor přetížení)

TransportGuard leží mezi CommandQueue a physical TransportAdapter — viz [[Architektura]].

## Heartbeat a minimální interval

```typescript
FIRMWARE_SAFETY.MIN_HEARTBEAT_INTERVAL_MS  // nejkratší povolený heartbeat interval
```

Heartbeat probe (battery query) je lightweight, ale pořád se počítá do rate limitu.

## Proč to nestačí jen "být opatrný"

- Telemetrie posílá příkazy vysokou frekvencí
- Různé komponenty (UI, API consumeři, heartbeat) posílají příkazy nezávisle
- CommandQueue + TransportGuard jsou architektonická bariéra, ne konvence

## Viz také

- [[moduly/Transports]] — TransportGuard implementace
- [[moduly/Runtime]] — CommandQueue (vrstevník s TransportGuardem)
- [[fáze/Fáze 3 - Telemetrie]] §3.4 — Adaptive Throttling (navazuje na firmware safety)
- [[wiki/concepts/firmware-safety-constraints.md]] — zkompilovaný wiki artikel
