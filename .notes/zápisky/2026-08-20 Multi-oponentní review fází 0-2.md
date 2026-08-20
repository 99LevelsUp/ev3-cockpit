---
tags:
  - ev3-cockpit
  - zápisek
  - review
datum: 2026-08-20
téma: Multi-oponentní review dokončené práce (fáze 0–2)
fáze: 0-2
---

# Multi-oponentní review fází 0–2

## Kontext

Po ~4 měsících pauzy jsme se vrátili k projektu. Nejdřív commit rozpracované
práce (libusb name resolution, perzistentní TCP beacon listener), pak iterativní
review veškeré dokončené práce — `ce-doc-review` a `ce-code-review` po vrstvách,
paralelně s nezávislými externími oponenty přes konkurenční CLI, opakovaně dokud
se oponenti neshodnou na dostatečné kvalitě.

**Panel oponentů:** claude (ce-doc-review persony: coherence, feasibility,
scope-guardian, adversarial) · codex/GPT-5 · nemotron-3-ultra · deepseek-v4-flash ·
mimo-v2.5 · laguna-s-2.1.

**Nedostupní:** `gemini-cli` (rozbitá instalace — v bundlu chybí
`policies/sandbox-default.toml`), `qwen` (nenakonfigurovaný auth type, v prostředí
žádný API klíč). Placené modely přes OpenCode Zen nejedou (no payment method),
OpenRouter free tier je rate-limited. Panel tedy jel na free modelech + codex.

**Kritérium průchodu:** žádný oponent nehlásí nový CRITICAL ani MAJOR. MINOR se
loguje, neblokuje.

## Pozorování / nález

### Nejcennější zjištění o procesu samotném

**Každá vlna oprav si vyžádala vlastní audit — dvakrát byly opravy samy tou vadou.**

| Kolo | Reálné nové CRITICAL/MAJOR |
|---|---|
| 1 | 1 + 16 |
| 2 | 6 — z toho 2× byla oprava z kola 1 špatně |
| 3 | 1 + 2, plus 8 bookkeeping chyb zavlečených editacemi z kol 1–2 |
| 4 | 4 — z toho 2× byla oprava z kola 3 špatně |

Konkrétně: oprava „zahoď pomalý connect" zavírala spojení podle `brickKey`, takže
zavřela **živý socket** novější session. A pojistka proti překryvu skenů přeskočila
transport, ale missy pak počítala přes všechny cihly. Obojí bylo horší než původní
chyba a odhalilo to až následující kolo.

Bez opakovaných kol by v repu zůstaly dvě nové regrese místo dvou opravených chyb.

### Nejvážnější nálezy v kódu

- **CRITICAL — heartbeat byl po reconnectu mrtvý.** `tick()` po dosažení miss
  threshold zavolal `onFailure` a vrátil se, aniž shodil `_running`. `start()` po
  úspěšném reconnectu narazil na guard „už běžím" a tiše se vrátil → cihla, která
  jednou vypadla a vrátila se, už nebyla nikdy probována. Session zůstala navěky
  `connected` na mrtvé cihle. Našel **deepseek**, codex ani nemotron ne.
- **CRITICAL (L2, zapracování čeká) — `buildFsWriteCommand` tiše zahazuje obsah
  souboru.** Připojuje ho do payloadu `BEGIN_DOWNLOAD`; `CONTINUE_DOWNLOAD` (0x93)
  je v `ev3Packet.ts` definovaný a **nikde neposílaný**, takže přenos je z
  konstrukce jednorázový. `parseFsWrite` přitom bezpodmínečně hlásí úspěch.
  V testech nevidět, protože mock odpovídá správně.
- **Dva leaky spojení** — disconnect prohrával závod s `recover()` i s `connect()`.
- **Mock loss simulace nedělala nic připojeným cihlám** — skrývala je jen
  v `discover()`. **Proto ten heartbeat CRITICAL přežil: žádný test se k němu
  nemohl dostat.**
- **`TransportGuard` je hotový a instancovaný jen v testech** → rate limit
  ≤10 cmd/s z DESIGN §4.1 se nevynucuje nikde.
- **`SendOptions.timeoutMs` a `signal` deklarované, ctěné nikým.**
- **`parseBattery` vracel proud v poli `voltage`** a `level` počítal z odběru
  proudu, který sleduje zátěž motorů, ne kapacitu.
- **`updateBrick` neměl v produkci volajícího** → `connected` v discovery listu
  zůstával navždy `false`.
- **Degradace z foregroundu vždy na `Subscribed`** — hlásili 4 oponenti ve 3 kolech,
  já to vedl jako dokumentační poznámku místo opravy. Špatný odhad.
- **Discovery selhání šla do `console.warn`** nebo nikam, zatímco selhávající
  provider stejně stojí cihly missy → transport mohl zhasnout a odvést všechny
  cihly do `Removed`, aniž se to kdekoli objevilo.

### Nejvážnější nálezy v dokumentech

Plán tvrdil hotovou práci, která v kódu není:

- **BT: šest podúkolů `[x]` bez řádky kódu.** `BtRfcommAdapter` neexistuje jako
  soubor ani symbol; WinRT ani Winsock backend, worker thready, bthprops discovery
  — nic. `extension.ts` registruje providera úplně bez discovery funkce.
- **Linux BlueZ backend** — DESIGN §4.1.1 se k němu zavazuje, REQUIREMENTS §12
  dělá z Linuxu povinnou platformu, a v plánu nebyl ani jeden úkol.
- **Zápisový příkaz pro přejmenování cihly** — `BrickCommand` je pro stav zařízení
  read-only, ale 5.7.2 a DESIGN §12.3 přejmenování vyžadují.
- 2.8.5/2.8.6 reconnect testy `[x]`, neexistovaly — proto ten CRITICAL přežil.
- Fáze 2 slibovala teardown subscriptions, ale registr je 3.3.5 a API 4.5.

### Dvě premisy, které zpochybnil adversarial

1. **Foreground telemetrie má tvrdé dno, ne strop.** Snímek = 4 sériové
   round-tripy přes striktně sériovou frontu → ~0,5 Hz na USB, 0,25 Hz na TCP,
   **0,125 Hz na BT**. DESIGN §12.2 přitom specifikuje animované prvky (gyro
   oblouk, distanční pruh). Žádný dokument nikdy neuvedl cílovou frekvenci.
2. **Adaptive throttling možná řeší problém, který sériová fronta odstranila.**
   Oba vstupy (latence, hloubka fronty) mají proti sériové frontě skoro nulový
   rozsah — throttler by měřil hlavně vlastní příchozí frekvenci. Úkol 3.4 je
   proto **gated**: nejdřív reprodukovat degradaci, kterou má řešit.

## Rozhodnutí

- **U bajtů protokolu nehádám.** `UI_READ_SUB` tabulka v tomhle repu se u
  `GET_PRESS` a `GET_SDCARD` rozchází s publikovanými lms2012 hodnotami, takže
  oprava subcode z paměti může být horší než chyba. Úkoly 1.7.6 (`GET_LBATT`),
  1.7.7 (`parseFsList` hlavička) a 1.7.8 (`OUTPUT_GET_COUNT` — **disputed**) drží
  symptom i obě čtení pro ověření na hardwaru.
- **Každý externí nález ověřen proti kódu, než jsem ho aplikoval.** Zamítnuto
  celkem 6 — mj. nemotronův CRITICAL, že BT MAC dělá `brickKey` nejednoznačným
  (žádný transport neobsahuje dvojtečku, dělení na první z nich je jednoznačné a
  všechna tři místa to tak dělají), a codexovo tvrzení o `NOS` bitovém poli.
- **Nemotron v kole 3 ignoroval exclusion list** a re-reportoval už vyřešené věci
  eskalované na CRITICAL. Jeho verdikt v tom kole neváží nic. Pro potvrzovací kola
  je reviewer, který ignoruje vylučovací seznam, aktivně škodlivý.
- Rodičovské checkboxy a stavová tabulka teď následují děti: fáze 1 má `⚠ gaps`,
  ne `✅ done`. `IMPLEMENTATION_PLAN.md §2` je **jediná** enumerace otevřené práce
  fáze 1 — tabulka na ni odkazuje, protože duplikát dvakrát rozešel.

## TODO / otevřené otázky

### Zapracování čeká

- [ ] **L1** (contracts/errors/events) — 8 nálezů. Nejvážnější: `SessionError` a
      `HeartbeatError` se nikde nevyhazují (bare `Error` v `sessionManager`,
      `sessionEntry`, `commandQueue`, `transportGuard`); `discoveryScheduler` posílá
      `previousState: Removed` pro nikdy neviděnou cihlu, čímž ničí rozlišení,
      kvůli kterému existuje úkol 6.4.0
- [ ] **L2** (protokol) — 4 nálezy včetně toho CRITICAL na `fs:write`
- [ ] **L3** transporty, **L4** runtime, **L5** mock + extension
- [ ] **R0 kolo 5** — potvrzení oprav z kola 4

### Rozhodnutí pro Petra

- [ ] **`useDiscovery: false` — tiché prázdno, nebo chyba?** Dva oponenti nezávisle
      (correctness P3, api-contract P2) chtějí, aby `discover()` skončil pojmenovanou
      chybou: prázdný seznam navždy je nerozlišitelný od „na síti nejsou cihly", což je
      přesně ta nejednoznačnost, kvůli které existuje větev `beaconBindError`. Proti
      tomu: vypnutí discovery je **vědomá volba volajícího**, ne nehoda jako selhaný
      bind. Nerozhodl jsem to sám, protože nový test `beaconDiscovery.test.ts` přibil
      opak (prázdný seznam) — a přepnout chování tichou úpravou testu je právě ten
      způsob, jak se rozhodnutí ztratí.
- [ ] **Fáze 5 závisí na fázi 6** — 5.4.3, 5.5.3 a 5.3.5 potřebují storage, kterou
      staví fáze 6, ale §12 fixuje pořadí 5 před 6. Přesunout persistenci dopředu,
      nebo ty UI úkoly dozadu?
- [ ] **Rozsah adaptive throttlingu** — DESIGN §4.5 říká „telemetrie", §9.5
      „subscription telemetrie". Smí throttling zpomalit i foreground?
- [ ] **Zdroj display name USB cihly** — poznámka v DESIGN §7.3 říká BTHPORT
      registr; kód čte libusb deskriptory a `regkey` v `src/` neimportuje.
      **Dva nezávislí oponenti (feasibility, codex) tvrdí, že poznámka je po
      libusb refaktoru zastaralá.** Nepřepsal jsem to — je to laborní evidence.
- [ ] **`regkey`** — deklarovaný v `optionalDependencies`, importovaný nikde.
      Mrtvá závislost, nebo příprava na 6.6.4?
- [ ] **`parseFsWrite`** — implementovat chunkovaný protokol (bez cihly bych hádal
      byte layout), nebo nechat hlasitě selhat a přenechat fázi 4 s hardwarem?

## Kolo 6 — oprava, která nikam nedosáhla

Tři nálezy kola 6 byly **moje vlastní opravy z kola 5, které nedosáhly kódu**. Ne
špatné opravy (to byl vzor kol 2 a 4) — opravy, které v diffu vypadají hotově a
nemají žádný efekt:

| Oprava z kola 5 | Proč nedosáhla |
|---|---|
| `BT.CONNECT_TIMEOUT_MS` 6000 → 15000 (změřeno na hardwaru) | konstantu nečetl žádný kód; `BtSppAdapter.open()` neměl deadline vůbec a držel při tom jediný RFCOMM slot |
| `sendCommandViaAdapter(..., options)` | `TransportProvider.send` options nepřijímal, takže je neměl kdo předat |
| layout system reply změřen a zdokumentován | `validateReply` dál čítal `payload[0]` (echo příkazu) místo `[1]` — každá chyba FS se hlásila jako `0x99` |

Zvlášť u té první: hodnotu jsem v témže kole **změřil na cihle**, což dalo falešný
pocit, že je věc vyřešená. Poznámka: `COMMAND_RTT_MS` je bez čtenáře **dál** —
úmyslně, prvním čtenářem bude úkol 3.8.

### Konvergence dvou oponentů

Reliability i api-contract došli **nezávisle** ke stejné vadě, a je to nejcennější
nález kola. Řetěz: `parseBattery` od kola 5 hází výjimku na krátký payload →
heartbeat probe **je** ten battery příkaz → `handleHeartbeatFailure` bere každé
odmítnutí jako ztrátu linky → Reconnecting → reconnect uspěje → `reconnect.reset()`
smaže počítadlo pokusů → **nekonečná smyčka**. Moje kontrola délky z kola 5 udělala
ze špatného procenta baterie nepoužitelnou cihlu.

Opraveno typovaným `ProtocolError` a `HeartbeatMonitor.isLinkFailure`. Kontrola
patří do monitoru, ne do session manageru: `onFailure` je **terminální** (`tick()`
volá `stop()` před předáním), takže „zůstaň Connected" v manageru by session nechalo
navždy bez probu. To je přesně ta chyba, kterou opravoval commit `bcddd55`.

### Další opravy kola 6

- BT `open()` adoptuje port **před** DTR krokem — selhaný assert dřív nechal otevřený
  OS handle bez reference, `close()` na chybějícím poli skončil a další otevření toho
  COM portu padalo na access-denied až do restartu hostitele
- `beaconConflicts` je timestampovaná mapa s expirací na hodinách cache — obnovení
  DHCP leasu uvnitř freshness okna dřív vyřadilo cihlu **natrvalo**
- `BatteryResponse.level` zpátky clampnutý na 0–100; bound odešel s heuristikou,
  ke které patřil
- `createPendingReply` řeší už zrušený signál místo vyčkání celého budgetu
- první spatření cihly loguje `new`, ne `undefined`

### Nové testy

`beaconDiscovery.test.ts` — beacon byl jediné místo, kam do provideru vstupují
nedůvěryhodné síťové byty, a netestovalo ho nic. Plus heartbeat rozlišení a battery
clamp. **222 unit testů zelených**, compile i lint čisté.

Zásadní o testech: off-by-one ve `validateReply` přežil proto, že test posílal jen
status byte a matchoval `/system command error/` — assertoval **existenci** chyby,
ne její obsah. Teď assertuje rozřešené jméno `ILLEGAL_PATH`.

### Externí pokrytí kola 6 — částečné

Jen **codex**. `mimo`, `gemini` a `qwen` jsou nainstalované, ale blokuje je
lean-ctx shell allowlist (i při volání plnou cestou — kontroluje se název). Allowlist
je Petrova bezpečnostní konfigurace, tak jsem ji nerozvolňoval; kdo chce širší
pokrytí, spustí `lean-ctx allow mimo gemini qwen`. `nemotron` vrátil prázdný výstup
(22 B), `deepseek` v tomto kole nespuštěn.

## Kolo 7 — audit vlny oprav z kola 6

Podle vlastního pravidla [[review-fixes-need-own-audit]]: každá vlna oprav dostane
potvrzovací kolo. Kolo 7 auditovalo diff `212fca6` a **našlo jednu opravu, která
leak jen přestěhovala**.

`BtSppAdapter.open()`: DTR cesta je krytá správně (`close()` se řídí `this.port`,
ne `_isOpen`, takže catch větev port skutečně zavře). Ale **open krok** racuje
deadline *před* přiřazením `this.port` a *mimo* try. Když vyhraje časovač, funkce
vyhodí TimeoutError — a serialport callback může port otevřít až potom. Osiřelý OS
handle, tedy přesně ten access-denied symptom, který oprava měla odstranit, jen
přesunutý z DTR cesty na timeout cestu. Opraveno catchem, který zavírá **lokální**
proměnnou (`this.port` v tom bodě ještě není, takže `this.close()` je špatný nástroj).

Druhý nález, na kterém se sešli dva oponenti nezávisle: `makeBrickKey` teď hází na
prázdný identifikátor a volá se **uvnitř** discovery smyčky, zatímco filtr testoval
jen truthiness. Jedno HID zařízení se serialem z bílých znaků by shodilo **celý USB
scan** místo aby vypadlo samo. Filtr teď trimuje.

`test:ci` (včetně host testů) exit 0, 222 testů zelených.

## Kola 8–9 — jedno místo, čtyři pokusy

Codex dal na kolo 6 `FAIL` se čtyřmi MAJOR. Jeden z nich (`BtSppAdapter.open()` osiřelý
port při timeoutu) už byl opravený v `f484889` **nezávisle** — codex a advisor na něj
přišli každý sám, což je nejužitečnější druh souhlasu. Zbylé tři byly znovu tentýž
podpis „nedosáhlo všech míst":

- `ev3Packet.ts` házel bare `Error` na rozbité rámování. To je **nejčistší** případ
  „cihla odpověděla a neumíme to přečíst" — a typování ho minulo, takže heartbeat ho
  čítal jako ztrátu linky. Přesně to, co typování mělo zastavit.
- `mockTransportProvider` je **čtvrtý** implementátor `TransportProvider.send` a options
  nepřijímal. Tady to vadí víc než u reálného transportu: proti mocku se vyvíjí fáze 4,
  takže kontrakt, který mock tiše ignoruje, se konzumenti naučí špatně.
- `parseBattery` clampoval `level` na 0–100. Tady si dva oponenti **protiřečili**:
  api-contract chtěl vynutit dokumentovaný rozsah, codex namítl, že clamp reportuje
  falešně **plnou** baterii a nechá heartbeat uspět, čímž skryje právě tu změnu layoutu.
  Codex má pravdu a odmítnutí splní obojí — rozsah je vynucený na hranici a anomálie je
  vidět. Bezpečné **jen** díky práci kola 6; před ní by to shodilo session.

### To jedno místo

`BtSppAdapter.open()` timeout cesta byla opravená **třikrát špatně**, každý pokus jinak:

| Pokus | Co bylo špatně |
|---|---|
| 1 (kolo 6) | `this.port` se přiřazoval po DTR kroku → selhaný assert nechal handle bez reference |
| 2 (kolo 7) | ošetřena DTR cesta, ale open krok racoval deadline **před** přiřazením a mimo try → leak jen přestěhován |
| 3 (kolo 7) | `port.close()` v catchi je **no-op** — open ještě letí, serialport odpoví „Port is not open", a callback handle osiří chvíli poté |

Čtvrtý pokus (`30ccc1b`) přestal hádat: **kdo reálně skončí s otevřeným portem, ten ho
zavře.** Callback ho uvolní, když dorazí až po vypršení; catch ho uvolní, když
`port.isOpen` ukáže, že dorazil o chlup dřív.

Příčina toho opakování je jednoduchá — **ta cesta neměla test**, a neměla ho proto, že
adaptér si port konstruoval přes `require` bez jakéhokoli seamu. Přidané
`connectTimeoutMs` a `serialPortFactory` (obě opt-in, defaulty nezměněné) to řeší.
`connectTimeoutMs` je zároveň **druhý čtenář** `BT.CONNECT_TIMEOUT_MS`, což je po tom,
co první přišel až po review, samo o sobě poznámky hodné.

Nový test byl **ověřen, že rozlišuje**: s odebranou pojistkou padá s „the late arrival
must be released, not leaked". Zelený test, který projde tak i tak, je přesně to, co
nechalo přežít off-by-one ve `validateReply` — o dva commity dřív.

Vedlejší chyba, kterou si zapisuju: `git checkout <file>` použitý na odklizení schválně
rozbitého kódu vrátil soubor na HEAD, tedy **smazal i tu opravu**. Rozbíjet kód kvůli
verifikaci testu chce reverzní patch, ne checkout.

`test:ci` (včetně host testů) exit 0, **225 testů zelených**.

## Konvergenční brána

Codex na `30ccc1b` vrátil **`VERDICT: PASS`, `FINDINGS: none`** — po třech předchozích
odmítnutích téhož místa. Explicitně dostal za úkol posoudit i to, jestli test rozlišuje,
a jestli neexistuje třetí pořadí, které ani jedna větev nekryje.

**Brána je ale uzavřená úzce a je fér to pojmenovat.** Protokol cross-CLI review
vyžaduje jednomyslné READY od **různých dodavatelů** — a to se v tomto kole nepodařilo:

| Oponent | Stav |
|---|---|
| codex | PASS (po 3 kolech FAIL) — jediný, kdo dojel celý cyklus |
| correctness, api-contract, reliability, security | nálezy dodány a zapracovány (interní, ne nezávislý dodavatel) |
| testing reviewer | **spadl** na session limit, výstup 0 B |
| nemotron | **prázdný výstup** (22 B) |
| mimo, gemini, qwen | **nespuštěny** — blokuje lean-ctx shell allowlist (kontroluje název i u plné cesty) |

Allowlist je Petrova bezpečnostní konfigurace, tak jsem ji nerozvolňoval. Kdo chce
plné pokrytí, spustí `lean-ctx allow mimo gemini qwen` a kolo se dá zopakovat.

Takže: **žádný přežívající blocker ani major**, ale shoda napříč dodavateli chybí —
signál, který u těchto modelů odděluje reálnou vadu od halucinace, je tu tenčí než
v kolech 1–5.

## Viz také

- [[Plán implementace]] · [[Architektura]] · [[Požadavky]]
- `docs/ideation/2026-04-28-design-review-ideation.md` — ideace, ze které vyšly
  pre-fáze-3 blockery
- Commity: `865a9a0` `732d6a8` `3bba7f4` `ca45bb9` `32a93d4` `e9d416b` `bf4996a`
  `5485137` `dfd0667` `bcddd55` `e365c35` `ab05d6d` `212fca6` `f2ee41e` `f484889` `c347275` `30ccc1b` `6696f85`
