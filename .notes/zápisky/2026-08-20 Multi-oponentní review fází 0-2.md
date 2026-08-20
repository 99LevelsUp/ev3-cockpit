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

## Viz také

- [[Plán implementace]] · [[Architektura]] · [[Požadavky]]
- `docs/ideation/2026-04-28-design-review-ideation.md` — ideace, ze které vyšly
  pre-fáze-3 blockery
- Commity: `865a9a0` `732d6a8` `3bba7f4` `ca45bb9` `32a93d4` `e9d416b` `bf4996a`
  `5485137` `dfd0667` `bcddd55`
