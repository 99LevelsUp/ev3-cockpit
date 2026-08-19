---
tags:
  - ev3-cockpit
  - koncept
koncept: BrickKey
---

# BrickKey

**BrickKey** je stabilní interní identita briku per transport. Je to branded string s formátem `transport:id`.

## Proč branded string?

TypeScript branded type (`type BrickKey = string & { readonly __brand: 'BrickKey' }`) zabraňuje náhodnému záměně s jiným stringem. Compiler odmítne předat plain string tam, kde se čeká BrickKey.

## Formát

```
transport:id
```

| Transport | Formát | Příklad |
| --------- | ------ | ------- |
| USB | `usb:<serial>` | `usb:0170SBB1` |
| BT | `bt:<mac>` | `bt:00:16:53:AB:CD:EF` |
| TCP | `tcp:<serial>` nebo `tcp:<ip>` | `tcp:0170SBB1` nebo `tcp:192.168.1.42` |
| Mock | `mock:<id>` | `mock:my-brick` |

## Klíčové vlastnosti

1. **Nezávisí na `displayName`** — displayName je user-editable; přejmenování briku nesmí změnit jeho pozici v listu nebo zrušit session.

2. **Stabilní řazení** — PresenceAggregator řadí discovery list per transport group, pak podle BrickKey. Bez stabilního klíče by se pořadí měnilo při každém discovery scanu.

3. **Per-transport** — stejný fyzický brik připojený přes BT i USB má dva různé BrickKey (`bt:...` a `usb:...`). Favorite je svázaný s `(brickKey, transport)` párem.

4. **Cross-session stabilní** — BrickKey se nemění mezi VS Code sessions, protože vychází z hardware identity (serial, MAC, IP).

## Použití v kódu

```typescript
// Vytvoření
const key = `usb:${serialNumber}` as BrickKey;

// Jako Map klíč
const sessions = new Map<BrickKey, SessionEntry>();

// Favorite per transport pair
const favorites = new Map<`${BrickKey}`, boolean>();
```

## Viz také

- [[moduly/Contracts]] — BrickKey type definition
- [[moduly/Runtime]] — SessionManager sessions Map, PresenceAggregator
- [[koncepty/Presence State Machine]] — BrickKey jako identity v state machine
