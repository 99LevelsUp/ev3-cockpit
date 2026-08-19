---
tags:
  - ev3-cockpit
  - modul
modul: protocol
složka: src/protocol/
stav: hotovo
---

# Protocol

**Složka:** `src/protocol/`  
**Účel:** Čisté funkce pro EV3 bytecode encoding, packet framing, command building a response parsing. Žádné I/O.

## Klíčové soubory

| Soubor | Účel |
| ------ | ---- |
| [[src/protocol/ev3Bytecode.ts]] | Encoding primitives |
| [[src/protocol/ev3Packet.ts]] | Packet framing |
| [[src/protocol/ev3Commands.ts]] | Command builder |
| [[src/protocol/ev3Responses.ts]] | Response parser |

## Packet format

```
[length: 2 bytes LE][counter: 2 bytes LE][type: 1 byte][payload: N bytes]
```

- `length` = délka zbytku (bez length field)
- `counter` = sekvenční číslo pro párování reply → request
- `type` = `DIRECT_COMMAND_REPLY` / `DIRECT_COMMAND_NOREPLY` / `SYSTEM_COMMAND_*` / `DIRECT_REPLY`

## ev3Bytecode — encoding primitives

Funkce pro sestavení EV3 bytecode instrukce:

| Funkce | Účel |
| ------ | ---- |
| `lc0(value)` | Local constant 0–31 (1 byte) |
| `lc1(value)` | Local constant 0–255 (2 bytes) |
| `lc2(value)` | Local constant 0–65535 (3 bytes) |
| `lcs(str)` | Local constant string (null-terminated) |
| `gv0(index)` | Global variable index 0–31 |
| `uint16le(n)` | Unsigned 16-bit little-endian |
| `uint32le(n)` | Unsigned 32-bit little-endian |
| `concatBytes(...arrays)` | Concatenate byte arrays |

## ev3Commands — BrickCommand → bytecode

Mapuje `BrickCommand` (high-level typed command) na EV3 direct/system command bytecode.

Příklady příkazů:
- `battery` — čtení napětí baterie (heartbeat probe)
- `getPortMap` — mapování portů
- `getSensorValue(port)` — hodnota senzoru
- `getMotorSpeed(port)` — rychlost motoru
- `firmwareInfo` — verze firmware

## ev3Responses — raw reply → BrickResponse

Parsuje raw EV3 reply bytes na typovanou `BrickResponse`.

## Pipeline

```
BrickCommand
    ↓ ev3Commands.buildCommand()
  { type, payload: Uint8Array }
    ↓ ev3Packet.encodePacket()
  Uint8Array (framed)
    ↓ TransportAdapter.sendPacket()
  Uint8Array (raw reply)
    ↓ ev3Packet.decodePacket()
  { counter, type, payload }
    ↓ ev3Responses.parseResponse()
  BrickResponse
```

## Testy

Unit testy v `src/__tests__/ev3Protocol.test.ts` — encoding/decoding round-trips pro všechny typy příkazů.

## Viz také

- [[moduly/Transports]] — TransportAdapter používá protocol
- [[koncepty/Firmware Safety]] — rate limiting platí na úrovni nad protokolem
- [[fáze/Fáze 1 - Transport a discovery]] — kdy bylo implementováno
