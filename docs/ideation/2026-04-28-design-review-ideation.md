---
date: 2026-04-28
topic: design-review
focus: architektonická rozhodnutí, potenciální problémy, příležitosti ke zlepšení
mode: repo-grounded
---

# Ideation: Revize návrhu EVƎ Cockpit

## Grounding Context

**Codebase:** VS Code extension pro EV3 cihly — discovery, connection, telemetry, public API pro dependent extensions. TypeScript, node-hid (USB), TCP, serialport+FFI (BT), mock transport. Phase 2 complete; Phases 3–7 planned. 197 unit testů.

**Klíčové vrstvy:** `src/contracts/` (types, API surface), `src/protocol/` (pure EV3 bytecode), `src/transports/` (USB/TCP/BT/mock), `src/runtime/` (PresenceAggregator, SessionManager, CommandQueue, heartbeat/reconnect), `src/mock/`, `src/ui/` (stub), `src/persistence/` (stub)

**Zjištěné napětí:** telemetry design nedokončen; BT multi-backend (WinRT→Winsock→SPP) neotestován; CommandQueue nemá timeout; heartbeat sdílí frontu s user commands; extension deactivate() je stub; DESIGN §15.2 vs. implementace SessionManager jsou v protikladu u dual-transport.

**Externí kontext:** vscode-ev3dev-browser (predecessor) — žádný auto-reconnect, žádná resilience, BT nikdy nefungovalo, macOS dep rot; node-hid na Windows: exclusive HID mode, sync API blokuje UV thread pool; VS Code native USB/HID v backlogu; PlatformIO: thin extension + external daemon přežil kde vscode-arduino selhal; deactivation ~5s cutoff.

## Ranked Ideas

### 1. PhysicalBrickRegistry — fyzická identita cihly přes transporty ★ EXPLORED
**Description:** brickKey zůstává transport-prefixovaný (`usb:ABC`, `bt:11:22`). Přidá se nová vrstva `PhysicalBrickRegistry`, která mapuje BT MAC adresu (fyzický identifikátor cihly) na množinu brickKey a sdílenou `CommandQueue`. Korelace se provádí odesláním `opCOM_GET(GET_ID)` přes libovolný transport po úspěšném session setup — příkaz vrací BT MAC přes USB HID, BT SPP i TCP stejně. Výsledek se cachuje do globalState. Dual-connect: `usb:ABC` a `bt:11:22` sdílejí jednu serializovanou frontu — Cockpit UI je ukazuje jako dvě nezávislé cihly, příkazy procházejí v sérii.

**Warrant:** `direct:` `src/runtime/sessionManager.ts connect()` — odmítá duplicitní brickKey, dual-connect strukturálně znemožňuje; DESIGN §15.2 — "shared queue for multi-transport connections"; EV3 firmware `opCOM_GET(GET_ID)` exponuje BT MAC přes všechny transporty (LEGO EV3 Communication Developer Kit); `src/transports/usbNodeUsb.ts` — USB name probing pattern je precedentem pro post-connect probe.

**Rationale:** BT MAC je hardwarový, uživatelsky neměnitelný, unikátní identifikátor — spolehlivější než jméno cihly. Příkaz `opCOM_GET(GET_ID)` funguje přes všechny tři transporty, takže korelace nevyžaduje žádné OS-level hacks ani uživatelský input.

**Downsides:** Přidává probe krok při každém novém connect (zvyšuje latenci prvního připojení). PhysicalBrickRegistry musí být koordinována s PresenceAggregator a SessionManager.

**Confidence:** 88% | **Complexity:** High | **Status:** Explored → brainstorm

---

### 2. CommandQueue nemá timeout — stalled USB read hanguje navždy
**Description:** `commandQueue.ts drain()` volá `await this.executor!(entry)` bez timeout wrapperu. Na Windows node-hid blokuje UV thread pool při odpojení zařízení — promise se nikdy nesplní. Heartbeat sdílí tutéž FIFO frontu s user commands; connection failure maskuje sama sebe tím, že blokuje heartbeat probe. Musí být vyřešeno před Phase 3 (foreground telemetrie zatíží frontu).

**Warrant:** `direct:` `src/runtime/commandQueue.ts drain()` — žádný AbortController ani timeout; `src/runtime/sessionManager.ts createHeartbeat()` — heartbeat ve sdílené frontě; `external:` node-hid #307, #312 — exclusive HID mode + UV thread pool blocking na Windows.

**Rationale:** Phase 3 přidá subscribed telemetrii; zaseklý příkaz zamaskuje transport failure blokováním heartbeatu, který má failure detekovat.

**Downsides:** Nutno rozhodnout, kde timeout žije — v adaptéru, frontě nebo `sendCommandViaAdapter`. Mock a test fidelita závisí na volbě.

**Confidence:** 95% | **Complexity:** Medium | **Status:** Unexplored

---

### 3. API versioning od prvního dne
**Description:** `BrickCommand` union, `BrickResponse` a API export objekt nemají version field. `TelemetrySnapshot.data: unknown` bez schema version. Phase 3 přidá nové command kindy — tichá breaking change pro každého konzumenta. Přidání `apiVersion: 1` do export objektu a version discriminatoru do command union stojí desítky řádků.

**Warrant:** `direct:` `src/contracts/transport.ts` — BrickCommand union bez version; `src/contracts/api.ts` — `data: unknown`, `delta: unknown`; `external:` Debug Adapter Protocol — integer `seq` a version field od první zprávy.

**Rationale:** Nejlevnější nevratná věc na seznamu. Umožní Phase 3, 4 a 6 detekovat a komunikovat inkompatibilitu místo tiché korupce dat.

**Downsides:** Minimální — přidání pár polí do contracts. Riziko: příliš brzy před stabilizací API shapes.

**Confidence:** 92% | **Complexity:** Low | **Status:** Unexplored

---

### 4. Mock jako fault-injection harness
**Description:** `defaultConfig.ts` podporuje `loss` (zmizení), ale žádnou injekci latence, partial responses, malformed frames ani error rate. Phase 3 adaptive throttling potřebuje validaci proti pomalé cihle — bez fault injection jsou throttling testy vakuové.

**Warrant:** `direct:` `src/mock/defaultConfig.ts` — `loss` pattern zavedený; `src/mock/mockTransportProvider.ts send()` — žádný delay hook; `reasoned:` throttling validovaný proti zero-latency mock nic nedokazuje.

**Rationale:** Extension config pattern existuje — přidání `fault: { latencyMs, errorRate, malformRate }` je low-cost. Leverage: Phase 3 throttling testy, Phase 4 error paths, Phase 7 stress testy v CI.

**Downsides:** Musí být přidáno před Phase 3 testy. Mírně zvyšuje komplexitu mock transport provideru.

**Confidence:** 88% | **Complexity:** Low–Medium | **Status:** Unexplored

---

### 5. Hard adapter seam pro nativní binárky
**Description:** `TransportAdapter` interface (`open`, `close`, `sendPacket`) je definován ale testován pouze nepřímo přes provider. `usbNodeUsb.ts` (untracked) naznačuje aktivní exploraci alternativy. VS Code native USB/HID API je v backlogu.

**Warrant:** `direct:` `src/contracts/transport.ts TransportAdapter`; `src/transports/usbNodeUsb.ts` — untracked, aktivní explorace; `external:` vscode-ev3dev-browser opuštěn kvůli native binary rot; VS Code native USB API proposal.

**Rationale:** Izolovaný testovaný adapter seam = swap na native VS Code USB API nebo node-usb je one-file změna místo provider rewrite.

**Downsides:** Vyžaduje izolované adapter testy. Nutná dohoda na API kontraktu před alternativními implementacemi.

**Confidence:** 85% | **Complexity:** Low–Medium | **Status:** Unexplored

---

### 6. Extension deactivation bez pre-staged cleanup
**Description:** `deactivate()` je prázdný stub. `BT.INTER_CONNECTION_COOLDOWN_MS = 15000` přesahuje ~5s VS Code deactivation budget. Phase 6 přidá persistence writes — bez budgetovaného teardown = tichá data loss.

**Warrant:** `direct:` `src/extension.ts deactivate()` — stub; `src/transports/transportConstants.ts BT.INTER_CONNECTION_COOLDOWN_MS: 15000`; `src/runtime/sessionManager.ts dispose()` — void, async provider disconnect; `external:` VS Code issue #11895 — ~5s cutoff potvrzeno.

**Rationale:** Doporučená implementace: async `deactivate()` s `ShutdownRegistry` — kritické operace (persistence write) mají timeout 1s, fast I/O (USB/TCP) await 2s, BT RFCOMM protocol cooldown je abandonment-safe (zavři handle, nečekej).

**Downsides:** Koordinace přes všechny provider dispose metody. Nutno rozhodnout hranici critical vs abandonment-safe.

**Confidence:** 93% | **Complexity:** Medium | **Status:** Unexplored

---

### 7. DESIGN vs. implementace: dual-transport contradiction → RESOLVED
**Description:** DESIGN §15.2 vyžaduje sdílenou frontu pro dual-connect. SessionManager dual-connect strukturálně zakazuje. Resolved v konverzaci: viz Survivor #1 (PhysicalBrickRegistry). Tři designové otázky zodpovězeny: (1) dual-connect je v1 use case, (2) fyzická identita = BT MAC via `opCOM_GET(GET_ID)`, (3) sdílená serializovaná CommandQueue per PhysicalBrick.

**Warrant:** `direct:` DESIGN §15.2; `src/runtime/sessionManager.ts connect()`.

**Confidence:** 87% | **Complexity:** viz #1 | **Status:** Resolved → merged into #1

---

## Rejection Summary

| # | Nápad | Důvod zamítnutí |
|---|-------|-----------------|
| F2-1/F3-2/F6-1 | External daemon (ev3d) | Příliš drahé pro v1; brainstorm direction |
| F2-3/F3-4/F6-5 | node-usb hotplug / event-driven presence | Taktická one-file změna; pod ambition floor |
| F1-5 | mergeLocalMetadata ?? bug | Konkrétní bug, taktický; řešitelný standardním PR |
| F1-7 | setActiveBrick → Subscribed vždy | Projeví se až Phase 3; nižší priorita |
| F6-3 | Flat session model | Platné, ale heavyweight architektonický rewrite |
| F6-4 | MCP-first public API | Kreativní, spekulativní; brainstorm po Phase 4 |
| F5-2 | ECS telemetry components | Phase 3 design exploration |
| F5-8 | Z-Wave mesh routing | Příliš spekulativní pro v1 |
| F1-6 | Discovery scan failures swallowed | Phase 7 observability task pokryje |
| F2-2 | Remove WinRT/Winsock (SPP-only) | Phase 7 scope decision |
| F4-2 | Metrics bus | Taktický; pod ambition floor |
| F4-3 | Webview jako API consumer | Engineering philosophy; brainstorm Phase 5 |
| F4-7 | supportsForget flag | Taktické |
| F6-7 | Zero-brick mode | Spekulativní, scope expansion |
| F5-1,F5-3–F5-7 | BGP, RTOS, ATC, VectorClocks, Quorum, OBD-II | Překryté silnějšími survivory nebo příliš spekulativní |
