# EV3 Cockpit — Návrhový dokument

## 0. Rozsah a předpoklady

### Cíl dokumentu

Tento dokument definuje implementační návrh rozšíření `EV3 Cockpit` pro VS Code:

- připojení a správa více EV3 kostek,
- monitorování senzorů a motorů v reálném čase,
- ovládání kostky přes EV3 System/Direct Commands,
- práce se soubory na kostce.

### Scope projektu

- Primární cíl: originální firmware LEGO EV3.
- Podporované transporty: USB HID, Bluetooth RFCOMM, TCP (WiFi).
- Multi-brick je základní architektonický princip od MVP.

### Primární reference

- `docs/Firmware/EV3_Communication_Developer_Kit.md`
- `docs/Firmware/EV3_Firmware_Developer_Kit.md`
- `docs/Firmware/Hardware Developer Kit.md`
- `docs/ev3duder_src/src/*`
- fallback v tomto repu:
  - `resources/01_LEGO_Official_Developer_Kits/*`
  - `resources/03_GitHub_Libraries_And_Tools/ev3duder/src/*`
  - `resources/11_Firmware/ev3_firmware_109d_developer_edition/c_com/source/*`

## 1. Přehled projektu

### Co je EV3 Cockpit

Rozšíření pro VS Code, které umožní připojit jednu nebo více EV3 kostek a ovládat je bez přepínání do externího LEGO software.

### Cílová skupina

- studenti a učitelé robotiky/programování,
- technicky orientovaní uživatelé EV3, kteří chtějí pracovat přímo ve VS Code.

### Problémy, které řešíme

- oficiální nástroje mají omezenou použitelnost a integraci,
- chybí jednotné prostředí editor + runtime hardware kontrola,
- chybí robustní workflow pro více kostek současně.

## 2. Architektura

### 2.1 Hlavní komponenty

| Komponenta | Odpovědnost |
|---|---|
| `ConnectionManager` | Kolekce `BrickConnection`, životní cyklus kostek, aktivní kostka |
| `BrickConnection` | Jedna kostka: transport, stav, scheduler, device API, file API |
| `TransportAdapter` | USB HID / RFCOMM / TCP read-write-close + reconnect hooks |
| `CommandScheduler` | Serializace příkazů, `messageCounter`, timeouty, retry policy |
| `DeviceProvider` | Senzory/motory/UI opkódy, dekódování odpovědí |
| `RemoteFsProvider` | `FileSystemProvider` + mapování `ev3://` URI |
| `BrickTreeProvider` | Jeden stromový view s root uzly podle kostek |
| `BrickPanel` | Webview: záložky kostek, vizualizace a ovládání |
| `Diagnostics` | Output channel, trace událostí a chyb |

### 2.2 Model dat

#### BrickIdentity

- `brickId` (interní UUID),
- `name`,
- `serialNumber`,
- `transport` (`usb` | `bt` | `tcp`),
- `address` (USB path / BT MAC / IP:port),
- `role` (`standalone` | `master` | `slave`),
- `layer` (`0..3` pro daisy chain),
- `firmwareInfo`.

#### BrickState

- `NEW`,
- `CONNECTING`,
- `READY`,
- `UNAVAILABLE` (dočasně nedostupné, záložka zůstává),
- `RECONNECTING`,
- `ERROR` (neobnovitelná chyba),
- `REMOVED` (explicitní akce uživatele).

#### Active Brick

Aktivní kostka je určena vybranou záložkou v `BrickPanel`. Všechny příkazy z Command Palette, které cílí na jednu kostku, jdou na aktivní kostku.

### 2.3 Životní cyklus připojení

#### Přechody stavů

- `NEW -> CONNECTING -> READY`
- `READY -> UNAVAILABLE -> RECONNECTING -> READY`
- `READY|UNAVAILABLE|ERROR -> REMOVED` (jen explicitně)
- `RECONNECTING -> ERROR` po vyčerpání politiky obnovy

#### Reconnect politika

- exponenciální backoff (`1s, 2s, 4s, ...`, max `30s`),
- jitter `+-20%`,
- oddělená politika pro transport (`USB` kratší timeout, `BT/TCP` delší).

### 2.4 Protokolová vrstva a scheduler

#### EV3 packet pravidla

- Little-endian hlavička (`size`, `message counter`, `type`, ...).
- Každý request má unikátní `messageCounter` per `BrickConnection`.
- `reply` se páruje přes `messageCounter`.
- `messageCounter` je `uint16`; po `0xFFFF` následuje wrap na `0x0000`.
- Nikdy nesmí být znovu použita hodnota, která je stále pending.
- Framing je transport-specific:
  - USB HID: report prefix (`hid/report id`) je součástí transport vrstvy.
  - BT RFCOMM + TCP: bez HID prefixu, čistý EV3 packet.

#### Direct Commands

- `DIRECT_COMMAND_REPLY (0x00)` je default.
- `DIRECT_COMMAND_NO_REPLY (0x80)` se používá jen u explicitně bezpečných akcí.
- Rezervace local/global bufferů musí být deklarována korektně per command.

#### System Commands

- `SYSTEM_COMMAND_REPLY (0x01)` je default pro file/management operace.
- No-reply system command je výjimka.

#### CommandScheduler pravidla

- Jeden write/read pipeline per kostka (žádné paralelní write na stejném socketu/handle).
- Priority lanes: `emergency`, `high`, `normal`, `low`.
- Max in-flight: `1` (MVP), později volitelné `>1` pouze s robustním párováním reply.
- Každý request má timeout, typicky `2000ms` (transport specificky upravitelné).
- Retry pouze u idempotentních operací.
- `emergency` lane má absolutní prioritu nad vším ostatním (včetně file transferů).
- Emergency příkazy (`STOP_ALL`, motor stop, safe-output-off) musí být plánovatelné nejpozději na hraně chunku probíhající operace.
- Každý timeout/cancel requestu přechází do stavu `orphan-risk`; scheduler pak:
  - nepřijímá nový write do stejného kanálu, dokud neproběhne resync,
  - provede transport-level recover (`drain-if-possible`, jinak reconnect),
  - invaliduje všechny pending požadavky s nižší prioritou.

### 2.5 Transportní adaptéry

#### USB HID

- Primární transport pro stabilní spojení.
- Nutno respektovat limit packetu; chunk data maximálně ~`1000 B`.

#### Bluetooth RFCOMM

- SPP profil.
- Vyšší pravděpodobnost latence/jitteru; polling musí být méně agresivní než u USB.

#### TCP (WiFi)

Připojení není jen "otevři socket na IP:5555". Implementujeme EV3 handshake:

1. příjem UDP beaconu (`port 3015`),
2. UDP ACK (`1 byte`) na source port,
3. TCP connect (`port 5555`),
4. unlock request `GET /target?sn=... VMTP1.0`,
5. očekávané potvrzení `Accept: EV340`.

Při ručním IP režimu se handshake neskáče; proběhne TCP unlock fáze.

Kompatibilita firmware:

- Primární cíl je stock firmware.
- Pro jiné firmware verze je handshake tolerantní:
  - tvrdě validujeme úspěch unlock fáze,
  - ale parsování potvrzení je robustní na drobné textové odchylky, pokud navazující command/reply tok funguje korektně.

### 2.6 Topologie master/slave a daisy chain

#### Typy topologií

- samostatná kostka: role `master`, `layer 0`,
- BT síť: 1 master + max 7 slave, aktivní komunikace vždy s jedním slave v daný okamžik,
- USB daisy chain: max 4 kostky (`layer 0..3`).

#### Daisy command nuance

Není to jen `LAYER` parametr. Pro řetěz je potřeba:

- `DAISY_COMMAND_REPLY (0x0A)` / `DAISY_COMMAND_NO_REPLY (0x8A)`,
- `DAISY_CHAIN_DOWNSTREAM (0xA0)`, `DAISY_CHAIN_DOWNSTREAM_WITH_BUSY (0xA5)`,
- destination layer counter,
- busy-cookie informace pro motory.

Pro poslední vrstvu se používá direct command varianta s busy (`0x0F`, `0x8F`).

#### Praktický dopad pro UI

- update všech 16+16 portů v max chain konfiguraci je cca `100 ms` řádu, ne "instantní",
- polling pro slave je proto throttlovaný.

### 2.7 VS Code integrační omezení

#### Aktivace extension

Kvůli automatické USB detekci se extension aktivuje při `onStartupFinished`.  
Těžké části (webview, polling, dekodéry) se inicializují lazy až po prvním připojení.

#### Explorer UI model

Dynamické vytváření samostatného "panelu" per kostka není v praxi robustní model pro VS Code contribution lifecycle.  
Použijeme jeden view `EV3 Cockpit Bricks`, kde:

- root node = kostka,
- poduzly = souborový strom kostky.

Pořadí root node odpovídá pořadí záložek.

### 2.8 Perzistence

Ukládáme:

- seznam známých kostek (`brickId`, poslední adresa, jméno, preferovaný transport),
- uživatelské preference polling intervalů,
- poslední pořadí záložek.

Citlivé údaje (WiFi credentials, pokud použity) jdou do `SecretStorage`.

### 2.9 Capability negotiation (firmware-aware režim)

Po navázání spojení běží capability probe:

- zjištění `fw_version`, `fw_build`, `os_version`, `os_build`,
- detekce podporovaných/nespolehlivých command patternů,
- vytvoření `CapabilityProfile` per kostka.

`CapabilityProfile` ovlivňuje:

- file listing strategii (single-shot vs continue-list),
- timeouty a retry policy,
- dostupnost pokročilých funkcí (daisy/mailbox),
- bezpečnostní guardrails pro filesystem.

Stock firmware má dedikovaný profile `stock-default`.

## 3. Funkční požadavky

### F1: Připojení a správa kostek

- připojení přes USB/BT/TCP,
- USB auto-detekce,
- BT/TCP ruční přidání přes dialog,
- nedostupná kostka se neodstraňuje automaticky,
- odstranění pouze explicitní akcí uživatele.

Akceptační kritéria:

- reconnect po dočasném výpadku bez ztráty záložky,
- aktivní kostka se zachová po reconnectu, pokud stále existuje.

### F2: Brick Panel

- záložky kostek + záložka `[+]`,
- přepnutí záložky přepne aktivní kostku,
- drag-drop reorder záložek.

Aktualizace dat:

- aktivní záložka: rychlý polling (default `500 ms`),
- neaktivní záložky: pomalý heartbeat (`2-5 s`) pro stav online/offline.

### F3: Senzory

- detekce připojených senzorů per port `1..4`,
- čtení hodnot,
- změna módu senzoru,
- robustní fallback při `DEVICE_NOT_FOUND`/neplatném módu.

### F4: Motory

- přehled motorů per port `A..D`,
- run/stop/speed,
- čtení pozice/tacho,
- respektování busy stavu a bezpečné zastavení.

### F5: Zvuk, LED, tlačítka, displej

- tón + přehrání souboru,
- LED pattern `0x00..0x09`,
- čtení stavu tlačítek + software press/release.

Displej:

- podporujeme kreslení přes `opUI_DRAW`,
- "zrcadlení aktuálního displeje" je omezené: firmware neposkytuje jednoduché framebuffer readback API,
- MVP implementuje "command shadow" (zobrazuje, co posíláme my), ne garantovaný snímek cizího UI.

### F6: Souborový systém kostky

- `FileSystemProvider` přes URI `ev3://<brickId>/<abs_path>`,
- strom v Explorer view pod root uzlem kostky,
- upload/download/delete/mkdir/run `.rbf`,
- `Ctrl+S` na otevřený remote soubor pushne změny zpět na kostku.
- dva režimy práce:
  - `safe` (default),
  - `full` (pokročilý, explicitně zapnutý uživatelem).

Implementační pravidla:

- chunkování dat `1000 B`,
- povinné zavírání remote file handle i při chybě,
- canonicalizace cesty před každou operací (normalizace `/`, odstranění `..`, collapse `//`),
- validace názvů/cest: preferovaný ASCII-safe subset pro maximální kompatibilitu stock firmware,
- `safe` režim:
  - povolené roots: `/home/root/lms2012/prjs/`, `/media/card/`,
  - blokace systémových cest (`/proc`, `/sys`, `/dev`, `/boot`, `/etc`, `/bin`, `/sbin`, `/usr`, `/var`),
- `full` režim:
  - přístup na celý FS po explicitním potvrzení rizika,
  - stále blokace nejrizikovějších pseudo-fs (`/proc`, `/sys`, `/dev`) kvůli stabilitě VM.
- listing strategie je capability-driven:
  - preferovat `LIST_FILES`,
  - `CONTINUE_LIST_FILES` použít jen pokud je profilem označeno jako funkční,
  - jinak fallback na menší listing kroky bez reliance na continue-list.

Chování při výpadku:

- root kostky v Exploreru zůstává viditelný, ale je disabled/read-only.

### F7: Logy a diagnostika

- output channel `EV3 Cockpit`,
- každý log obsahuje `timestamp`, `brickId`, `messageCounter`, command type/opcode,
- úrovně logu: `error`, `warn`, `info`, `debug`, `trace`,
- volitelný raw hex dump při `trace` režimu.

### F8: Nastavení kostky

Čtení/zápis:

- název kostky,
- hlasitost,
- sleep timer.

Pouze čtení:

- baterie,
- firmware verze,
- BT adresa,
- stav WiFi donglu.

### F9: Chybové stavy a obnova

- mapování EV3 status kódů (`UNKNOWN_HANDLE`, `NO_PERMISSION`, `SIZE_ERROR`, ...),
- user-facing chybové hlášky s doporučenou akcí,
- retry policy podle typu příkazu,
- cancellation token u dlouhých operací (upload/download/list).
- timeout/cancel musí mít definovaný recovery kontrakt:
  - stop scheduler lane,
  - resync/reconnect,
  - znovuotevření transportu až po potvrzení konzistence parseru.

### F10: Bezpečnost

- žádná hesla/tokeny v logu,
- secret data pouze v `SecretStorage`,
- validace vstupů (cesty, názvy, rozsahy parametrů),
- command allowlist pro UI akce.

## 4. Nefunkční požadavky

### Výkon

- cold start extension do `200 ms` bez připojené kostky,
- polling aktivní kostky default `500 ms`,
- minimální intervaly podle transportu:
  - USB: `100 ms`,
  - BT/TCP: `250 ms`,
  - daisy/slave polling: `>=500 ms`,
- žádné paralelní těžké operace na stejné kostce bez scheduleru.

### Stabilita

- žádný uncaught exception nesmí shodit extension host,
- každá komunikace musí mít timeout a klasifikaci chyby,
- po reconnectu musí dojít k re-synchronizaci capability cache.

### Kompatibilita

- Windows jako primární cílová platforma MVP,
- architektura připravená i pro Linux/macOS transport adaptéry.

### Pozorovatelnost

- auditní trace u file operací a motor commandů,
- korelace request/reply přes `messageCounter`.

## 5. Testovací strategie

### Unit testy

- packet encoder/decoder,
- scheduler queue, timeout, retry,
- mapování error kódů.
- `messageCounter` rollover test (`0xFFFF -> 0x0000`) bez kolize pending requestů.
- path canonicalization + traversal guard testy (`..`, duplicate slash, mixed separators).

### Integrační testy

- mocked transport (simulace timeout/error/out-of-order reply),
- reconnect scénáře,
- file upload/download včetně přerušení.
- emergency preempce během probíhajícího uploadu/downloadu.
- late reply po cancel/timeout (ověření resync strategie).
- stock-vs-nonstock capability profile fallback.

### Hardware testy

- minimálně 1x USB, 1x BT, 1x TCP,
- 2-brick scénář (master+slave),
- daisy chain sanity (min. layer 0+1).

## 6. Známá omezení

- originální firmware nepodporuje jednoduchý full framebuffer readback pro obecné "live mirror" UI,
- BT master komunikuje s jedním slave v daném okamžiku, při přetížení hrozí ztráta dat,
- firmware má omezení packet size => nutné chunkování a konzervativní list/download strategie.

## 7. Roadmapa

### Fáze 1 — Core transport + scheduler

- [ ] `ConnectionManager`, `BrickConnection`, stavový automat
- [ ] USB/BT/TCP adaptéry
- [ ] EV3 handshake pro TCP
- [ ] `CommandScheduler` + `messageCounter` párování
- [ ] emergency lane s absolutní prioritou
- [ ] základní logování + diagnostika

### Fáze 2 — Brick Panel + základní ovládání

- [ ] Webview se záložkami a aktivní kostkou
- [ ] status, baterie, firmware, role/layer
- [ ] LED/tlačítka/zvuk (MVP)

### Fáze 3 — Souborový systém

- [ ] `FileSystemProvider` (`ev3://`)
- [ ] Tree view s root uzly per kostka
- [ ] upload/download/delete/mkdir/run `.rbf`
- [ ] safe/full FS režim + potvrzovací UX pro `full`
- [ ] robustní error handling + cancel + reconnect-safe operace

### Fáze 4 — Senzory a motory

- [ ] schéma portů a periferií
- [ ] polling + mode switch senzorů
- [ ] motor control včetně busy stavů

### Fáze 5 — Pokročilé scénáře

- [ ] daisy chain optimalizace (busy cookies, downstream routing)
- [ ] mailbox komunikace
- [ ] volitelný agent na kostce pro pokročilé display telemetry

## 8. Konfigurace (`ev3-cockpit.*`)

- `ev3-cockpit.polling.activeIntervalMs` (default `500`)
- `ev3-cockpit.polling.backgroundIntervalMs` (default `3000`)
- `ev3-cockpit.transport.timeoutMs` (default `2000`)
- `ev3-cockpit.reconnect.maxAttempts` (default `0` = nekonečno, pokud uživatel kostku neodebere)
- `ev3-cockpit.logging.level` (`error|warn|info|debug|trace`)
- `ev3-cockpit.fs.defaultRoots` (default `["/home/root/lms2012/prjs/", "/media/card/"]`)
- `ev3-cockpit.fs.mode` (`safe|full`, default `safe`)
- `ev3-cockpit.fs.fullMode.confirmationRequired` (default `true`)
- `ev3-cockpit.scheduler.emergencyPreemption` (default `true`)
- `ev3-cockpit.compat.profile` (`auto|stock-strict`, default `auto`)
