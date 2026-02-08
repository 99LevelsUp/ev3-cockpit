# Command Scheduler - Implementacni plan

Tento dokument popisuje implementacni plan pro `CommandScheduler` v projektu `ev3-cockpit`.

## Cile

- robustni scheduler pro EV3 commandy,
- lane priority: `emergency`, `high`, `normal`, `low`,
- `max in-flight = 1` per kostka,
- parovani reply pres `messageCounter`,
- recovery po timeout/cancel (`orphan-risk`),
- emergency ma absolutni prioritu pred cimkoliv.

## Ocekavane vystupy (soubory)

1. `src/scheduler/types.ts`
2. `src/scheduler/messageCounter.ts`
3. `src/scheduler/commandScheduler.ts`
4. `src/scheduler/orphanRecovery.ts`
5. `src/transport/transportAdapter.ts`
6. `src/diagnostics/logger.ts`
7. uprava `src/extension.ts` (wire-up scheduleru)
8. `src/__tests__/...` (unit + integration-style testy pres mock transport)

## Faze implementace

## Stav realizace (2026-02-07)

- `F0-F5`: hotovo v `src/scheduler/*` + unit testech.
- `F6`: castecne hotovo:
  - scheduler/config/logging runtime wire-up v `src/extension.ts`,
  - `connect probe` vede pres packet encode/decode a `Ev3CommandClient`,
  - probe umi pouzit realny transport dle `ev3-cockpit.transport.mode` (`usb|bluetooth|tcp|mock|auto`),
  - implementovany `UsbHidAdapter` a `BluetoothSppAdapter`,
  - BT ma auto fallback pres vice COM portu (`ev3-cockpit.transport.bluetooth.autoPortFallback`),
  - BT auto-port fallback pouziva hybridni selection strategie (`ev3-priority` + `legacy-order`) s fallbackem mezi strategiemi,
  - BT auto-port ma per-port retry/backoff + kratky post-open stabilization delay (`ev3-cockpit.transport.bluetooth.portAttempts`, `retryDelayMs`, `postOpenDelayMs`),
  - `ev3-priority` selekce preferuje jen pravdepodobne EV3 COM kandidaty (serial/pnp hint), `legacy-order` je az sekundarni fallback,
  - retry na BT portu se aplikuje jen na transient otevreni chyby (napr. Win `121/1256`), aby se necyklilo na zjevne spatnych COM portech.
  - pridany diagnosticky command `ev3-cockpit.inspectTransports` (USB/serial kandidati),
  - lifecycle obsahuje `open/close` transportu a `dispose` scheduleru,
  - capability probe navazuje firmware profile selection (`stock-default|stock-legacy|stock-strict|compat-conservative`),
  - pridan config reader pro `ev3-cockpit.compat.profile`,
  - pridan config reader pro `ev3-cockpit.fs.mode` + `ev3-cockpit.fs.defaultRoots` + `ev3-cockpit.fs.fullMode.confirmationRequired`,
  - pridan FS path policy modul (`safe/full` guardrails + canonicalizace),
  - implementovan `RemoteFsService` nad EV3 system commandy (`LIST/UPLOAD/DOWNLOAD/CREATE/DELETE/CLOSE_FILEHANDLE`),
  - `RemoteFsService` respektuje capability profile (`supportsContinueList`, `uploadChunkBytes`) a FS policy,
  - doplneny unit testy pro `RemoteFsService` (chunking, continue-list, truncated fallback, guardrails),
  - napojen VS Code `FileSystemProvider` pro schema `ev3://`,
  - implementovano UX potvrzeni pro `full` rezim s automatickym fallbackem na `safe` pri odmitnuti.
  - doplneno robustni cteni souboru s retry po `CONTINUE_UPLOAD UNKNOWN_HANDLE`,
  - doplnen browse fallback pro binarni soubory (`.rbf` atd.) bez messagebox failu.
- `F7`: castecne hotovo:
  - `MockTransportAdapter` pripraven pro success/error test scenare,
  - nove testy pro packet vrstvu a command client,
  - pokryte transport scenare: `timeout`, `disconnect + retry`, `stale/out-of-order reply`,
  - pridan `TcpAdapter` + testy unlock handshake, packet roundtrip a abort,
  - TCP handshake robustni na varianty odpovedi `Accept:EV340` a discovery metadata (host/port/serial/protocol),
  - doplneny scheduler testy pro multi-lane interference (dynamicke poradi `high` vs `normal` po low in-flight),
  - doplneny scheduler test pro chunked preempci s interference (`emergency` + pending `high`),
  - doplnen test reconnect recovery pro `TcpAdapter` (re-open po remote close),
  - doplnen test, ze `TcpAdapter` v discovery rezimu nevyzaduje non-empty host.
  - doplnena testovana vrstva `remoteFsOps` (copy/rename/recursive delete + typ detekce path),
  - `FileSystemProvider` pouziva `remoteFsOps` a podporuje `rename` + `copy`,
  - offline write operace mapovany do read-only chyby, read operace do unavailable.
  - doplneny reconnect recovery testy pro `UsbHidAdapter` a `BluetoothSppAdapter` (simulace driver-level failover),
  - doplneny integration-style testy pro `Ev3FileSystemProvider` (`rename/copy/offline`),
  - doplnen extension-host test harness (`npm run test:host`) pro aktivaci extension, registraci commandu, bezpecne spusteni non-interactive commandu bez HW a `ev3://` FileSystemProvider offline read/write wiring,
  - UX pro binarni soubory ve `Browse Remote FS`: volba `Open Preview` nebo `Download to Local...`.
  - `Browse Remote FS` doplneno o akce `Upload File Here...`, `Create Folder...`, `Delete Entry...`,
  - pridany helpery `browserActions` + unit testy pro validaci nazvu a mapovani local->remote cest.
  - `RemoteFsService.runProgram()` implementuje compound direct command (`opFILE LOAD_IMAGE` + `opPROGRAM_START`) pro `.rbf`,
  - v browseru binarnich souboru pridana akce `Run on EV3` pro spousteni `.rbf` z `ev3://active/...`.
  - pridana command akce `EV3 Cockpit: Emergency Stop (active)` pres `BrickControlService` (`opPROGRAM_STOP` + `opOUTPUT_STOP`) na scheduler lane `emergency`.
  - HW smoke podporuje volitelny real-run check pres `EV3_COCKPIT_HW_RUN_RBF_PATH` (transport probe + skutecne spusteni `.rbf`).
  - HW smoke podporuje fixture rezim `EV3_COCKPIT_HW_RUN_RBF_FIXTURE` (`upload -> run -> delete`) s vestavenym `Empty.rbf` fixture (`src/hw/fixtures/emptyProgram.ts`) nebo explicitni lokalni cestou.
  - HW smoke defaultne provadi i `emergency stop` verifikaci (`EV3_COCKPIT_HW_EMERGENCY_STOP_CHECK=true`) pro USB/TCP/BT.
  - HW smoke mapuje transientni post-probe transport chyby (napr. BT COM 121/1256 pri emergency-check) na `SKIP` misto `FAIL`.
  - HW smoke obsahuje volitelny scenar reconnect-recovery (`EV3_COCKPIT_HW_RECONNECT_CHECK=true`) pro USB/TCP/BT (`open -> probe -> close -> reopen -> probe`).
  - pridana command akce `EV3 Cockpit: Disconnect EV3 (active)` pro explicitni uzavreni aktivni session a cleanup runtime sluzeb.
  - pridana command akce `EV3 Cockpit: Reconnect EV3 (active settings)` pro rychly reconnect pres stejny connect-probe/capability flow.
  - pridana command akce `EV3 Cockpit: Deploy and Run .rbf (active)` (`local pick -> upload -> run`) nad `RemoteFsService`.
  - pridana command akce `EV3 Cockpit: Preview Deploy Changes (active)` pro dry planning upload/skip/cleanup bez zmen na EV3.
  - pridana command akce `EV3 Cockpit: Sync Project to EV3 (active)` (`folder pick -> recursive upload/sync`) bez automatickeho spusteni programu.
  - pridana command akce `EV3 Cockpit: Deploy Project and Run .rbf (active)` (`folder pick -> recursive upload -> run selected .rbf`).
  - pridany run-control workflow commandy: `Run Remote Program (.rbf)`, `Stop Program (active)`, `Restart Program (active)` s pamatovanim posledniho run targetu.
  - pridana diagnosticka command akce `EV3 Cockpit: Transport Health Report` (USB/TCP/BT probe + capability souhrn PASS/SKIP/FAIL).
  - project deploy podporuje filtry/limity (`ev3-cockpit.deploy.excludeDirectories`, `ev3-cockpit.deploy.excludeExtensions`, `ev3-cockpit.deploy.maxFileBytes`) a loguje skipped entries.
  - project deploy podporuje volitelny incremental rezim (`ev3-cockpit.deploy.incremental.enabled`) s md5/size porovnanim proti remote indexu.
  - project deploy podporuje volitelny cleanup/sync rezim (`ev3-cockpit.deploy.cleanup.enabled`) pro mazani stale remote souboru/adresaru mimo lokalni projektovy snapshot.
  - cleanup rezim ma potvrzovaci UX guard (`ev3-cockpit.deploy.cleanup.confirmBeforeDelete`, default `true`) s preview stale entry seznamu pred mazanim.
  - cleanup rezim podporuje `dry-run` variantu (`ev3-cockpit.deploy.cleanup.dryRun`), ktera stale entry pouze reportuje bez mazani.
  - project deploy podporuje `atomic` rezim (`ev3-cockpit.deploy.atomic.enabled`) se staging root + swap + rollback fallbackem.
  - transport adaptery (USB/TCP/BT) filtruji stale reply packety podle `expectedMessageCounter` a ignoruji out-of-order odpovedi.
  - extension-host testy (`test:host`) rozsireny o fake TCP EV3 FS scenar s CRUD flow pres `ev3://active/...` (`write/read/copy/rename/delete`) + overeni odmítnuti ne-`active` authority.
  - opraven edge-case v `remoteFsOps.getRemotePathKind`: safe-root adresar je detekovan primym `listDirectory(path)` bez nutnosti listovat zakazany parent mimo safe roots.

Zbyva:
- rozsirit extension-host test harness o dalsi scenare nad `ev3://` (aktualne pokryva aktivaci, command registrace a provider wiring),
- doplnit HW/integration reconnect-recovery scenare pro USB/Bluetooth pri realnem driver-level vypadku (unit testy adapteru jsou hotove, chybi end-to-end verifikace),
- doladit BT HW smoke stabilitu (port lock/unknown 121 je stale intermitentni v nekterych behach).

## Checkpoint pred prerusenim (2026-02-07)

Tento checkpoint slouzi jako navazovaci bod po vetsi pauze.

Hotovo:
- scheduler runtime + lane priority + retry + orphan-risk recovery jsou implementovane a pokryte unit testy,
- transporty `usb`, `bluetooth`, `tcp` jsou integrovane a proverene pres `connect probe` + `capability probe`,
- capability profile auto-vyber (`stock-default` atd.) + FS policy rezimy `safe/full` jsou zapojene,
- `ev3://` remote FS browse/read/write/copy/rename/delete je funkcni,
- emergency stop command je dostupny a posila stop payload pres lane `emergency`,
- `readFile` ma fallback retry pri `CONTINUE_UPLOAD UNKNOWN_HANDLE`,
- stale/out-of-order reply filtrace podle `expectedMessageCounter` je zapojena v USB/TCP/BT adaptorech,
- browse binarnich souboru uz nepada messageboxem; VS Code ukaze standardni binary-not-text hlasku,
- fixture `Empty.rbf` je ulozena v `src/hw/fixtures/emptyProgram.ts` a je dopsana o komentovany rozpis instrukci + pseudokod.

HW overeni, ktere uz probehlo:
- USB: probe + capability + remote FS browse/read overeno,
- TCP (Wi-Fi): probe + capability + remote FS browse/read overeno,
- Bluetooth: probe + capability overeno (stabilita muze byt intermitentni podle stavu COM/BT stacku).

Navazujici kroky po navratu:
1. Dokoncit extension-host test harness pro `FileSystemProvider` (realny VS Code host proces).
2. Dodelat e2e reconnect-recovery HW scenare (USB/Bluetooth) pri simulovanem driver-level vypadku.
3. Stabilizovat BT HW smoke behy a zlepsit diagnostiku pro COM lock/timeouts.
4. Pokracovat v implementaci dalsich funkci nad FS (spousteni programu/operace workflow) podle planu.

Aktualni rozhodnuti scope:
- Do casu dalsi diagnostiky hostitelskeho BT stacku je aktivni implementacni/test scope primarne `USB + TCP (WiFi)`.
- Bluetooth zustava podporovan, ale neni blocker pro pokracovani hlavni implementace.

## Porovnani komunikacniho stacku s official EV3 Classroom (2026-02-07)

Zdroj official analyzy:
- `resources/13_ev3_classroom/README.md`

### Shrnuti rozdilu (ev3-cockpit vs official)

1. Bluetooth transport vrstva:
- `official`: WinRT RFCOMM (`BluetoothDevice` + `RfcommDeviceService` + `StreamSocket`), pairing uvnitr aplikace.
- `ev3-cockpit`: `serialport` pres virtual COM (SPP), pairing mimo aplikaci (OS-level).

2. Bluetooth reconnect/retry:
- `official`: EV3 default `BtConnectionRetry = 1` (prakticky bez resiliency).
- `ev3-cockpit`: auto-port fallback pres vice COM kandidatu + probe (`0x9d`), ale bez per-port retry smycky v extension runtime.

3. Packet safety:
- `official`: bez explicitni obrany proti stale/out-of-order reply na transport vrstve.
- `ev3-cockpit`: adaptery USB/TCP/BT filtruji reply podle `expectedMessageCounter` + `Ev3CommandClient` ma hard check mismatch.

4. Scanner policy:
- `official`: scanner je pri aktivnim spojeni pausnuty.
- `ev3-cockpit`: scanner neni centralni dlouhozici service; port kandidati se zjistuji ad-hoc commandem/factory.

5. EV3 profil:
- `official`: EV3 BT filtr podle MAC prefixu `00:16:53`; EV3 preferuje `usb-hid` scanner.
- `ev3-cockpit`: BT kandidati se berou ze serial seznamu COM; EV3 identifikace je az probe odpovedi.

### Co je v ev3-cockpit objektivne robustnejsi nez official

- scheduler lane model + retry policy + orphan-risk recovery,
- messageCounter safety na transportu i clientu,
- capability probe + profile selection (`stock-default/legacy/...`),
- jednotna abstrakce transportu USB/BT/TCP s HW smoke kategoriemi.

### Co muze stale zpusobovat BT intermitentni nestabilitu v ev3-cockpit

1. COM vrstva je nativne mene deterministicka nez WinRT RFCOMM
- chyby typu `Unknown error code 121/1256` jsou z virtual serial stacku Windows, ne z EV3 protokolu.

2. Auto-port fallback nema vlastni retry/backoff per port v extension runtime
- pri kratkem "cold" stavu BT linky (tesne po connectu/pairingu) prvni probe casto timeoutne, druhy uz projde.

3. Kandidatni COM poradi neni EV3-prioritized stejne jako v HW smoke
- v `transportFactory` se COM kandidati berou bez EV3-specific ranking (napr. `_005D`, serial match).

4. Pairing workflow je externalizovany mimo app
- official stack pairing explicitne ridi; v `ev3-cockpit` je zavisly na predchozim stavu OS pairingu.

### Priority dalsich kroku (z pohledu BT stability)

1. Sjednotit production BT candidate ranking s HW smoke logikou
- prioritizovat EV3 COM (`pnpId` obsahuje `_005D`) + serial match proti USB kandidatu.

2. Pridat per-port retry/backoff do `BluetoothAutoPortAdapter`
- alespon 2-3 pokusy na port s kratkou prodlevou pred failover na dalsi COM.

3. Pridat jemny post-open stabilizacni delay pred prvnim probe
- maly `open->probe` delay (napr. 100-300 ms) snizuje false timeout na nekterych BT stack konfiguracich.

4. Dodelat e2e HW reconnect-recovery test scenare pro BT
- simulace vypnuti/zapnuti kostky nebo BT service resetu uprostred aktivni session.

Poznamka:
- bod (4) byl uz driv identifikovan jako coverage mezera; zustava aktivni priorita.

## F0 - Kontrakty a typy

- definovat datove typy:
  - `CommandRequest`,
  - `CommandReply`,
  - `Lane`,
  - `SchedulerState`,
  - `SchedulerError`.
- definovat invariants:
  - `messageCounter` je `uint16`,
  - zadna kolize s pending requesty.

**Done kdyz**: TypeScript kompiluje a scheduler API ma stabilni signatury.

## F1 - MessageCounter service

- implementovat generator s rollover `0xFFFF -> 0x0000`,
- pridat rezervaci counteru proti pending mape,
- pridat release counteru po dokoncenem requestu.

**Testy**:
- rollover test,
- collision-avoidance test.

## F2 - Core queue + single in-flight

- fronty per lane: `emergency/high/normal/low`,
- dispatcher bere vzdy nejvyssi nepradnou lane,
- hard enforcement `max in-flight = 1`,
- timeout handling requestu.

**Done kdyz**:
- bez paralelniho write na stejnou kostku,
- korektni poradi requestu dle lane.

## F3 - Emergency preempce

- `emergency` ma absolutni prioritu,
- preempce probiha na hranici chunku (ne uprostred write),
- pridat API `enqueueEmergencyStop(...)`.

**Testy**:
- bezi upload, prijde emergency, scheduler posle emergency pred dalsim non-emergency chunkem.

## F4 - Orphan-risk recovery

- pri timeout/cancel prechod do stavu `ORPHAN_RISK`,
- blokace novych write operaci,
- pokus o `drain-if-possible`, jinak reconnect callback,
- po recover:
  - resync parser kontextu,
  - invalidace pending requestu nizsich priorit.

**Testy**:
- late reply po timeoutu,
- cancel v prubehu requestu,
- reconnect varianta.

## F5 - Retry policy

- retry pouze pro idempotentni operace,
- backoff + limit pokusu podle typu chyby,
- bez implicitniho retry pro mutacni FS operace.

**Testy**:
- idempotent request se retryne,
- non-idempotent request se neretryne.

## F6 - Integrace do extension

- napojit scheduler do `extension.ts`,
- doplnit output channel logy:
  - `timestamp`,
  - `brickId`,
  - `messageCounter`,
  - `opcode`,
  - `lane`,
  - `duration`,
  - `result`.
- doplnit `dispose` lifecycle (cancel pending + close transport).

## F7 - Test harness

- mock transport rezimy:
  - success,
  - timeout,
  - disconnect,
  - out-of-order,
  - late reply.
- pripravit test matrix:
  - lane priority,
  - emergency preemption,
  - rollover,
  - orphan-risk recovery,
  - retry pravidla.

## Akceptacni kriteria

1. Zadny paralelni write na jednu kostku.
2. Emergency request je vzdy pred non-emergency pending requesty.
3. `messageCounter` nekoliduje ani po rolloveru.
4. Po timeout/cancel probehne deterministic recover pred dalsim write.
5. Testy pokryji priority, preempci, orphan-risk, rollover a retry policy.
6. `npm run compile` projde bez chyb.

## Doporucene poradi realizace

1. F0-F2 (funkcni jadro),
2. F3-F4 (bezpecnost + robustnost),
3. F5-F7 (stabilita + testovatelnost).

## Poznamky k scope

- Primarni cil je stock firmware.
- Scheduler musi byt pripraveny na capability/profile rezim pro firmware odchylky.
- Remote FS rezimy (`safe`/`full`) se opiraji o scheduler stejne jako ostatni commandy.
