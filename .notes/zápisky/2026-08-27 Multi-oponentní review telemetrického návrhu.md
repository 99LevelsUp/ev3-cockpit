# Multi-oponentní review telemetrického návrhu

27.08.2026 · DESIGN §9.1–9.1c, IMPLEMENTATION_PLAN 3.1.6–3.1.11
Protokol: `~/.claude/rules/cross-cli-review.md`

Telemetrický návrh vznikl 26.08. večer z rozhovoru o tom, co všechno do telemetrické vrstvy
patří. Tenhle zápisek je jeho první nezávislá kontrola — pěti lensy, pěti dodavateli.

---

## Co kolo doopravdy pokrylo

První pokus proběhl proti repu a **pět z devíti buněk padlo na prostředí, ne na modelu**:

- `opencode/*` se sandboxuje do pracovního adresáře a `../ev3-resources` odmítne
  (`external_directory ...; auto-rejecting`),
- `codex` narazil na lean-ctx `PreToolUse` hooky a `CreateProcessWithLogonW failed: 1385`;
  vrátil `[]` po 37 000 tokenech.

`[]` od zablokovaného engine se nedá odlišit od `[]` od engine, který nic nenašel — a kolo,
které to nerozliší, hlásí „shodu dodavatelů" tam, kde většina buněk vůbec neproběhla.

**Oprava: soběstačný `PACKET.md`** — návrh, úkoly plánu i všechny referenční výňatky vložené
inline, plus pokyn neotvírat soubory. Engine, který nesáhne na soubor, na přístupu k souboru
nepadne. Do repa navíc přibyl junction `ev3-resources` (v `.gitignore`), aby cesta ven
z pracovního adresáře přestala být potřeba.

| Engine | Dodavatel | Lensy | Nálezy |
|---|---|---|---|
| interní | Anthropic | correctness, honesty, api-design, performance, doc-drift | 37 |
| `codex` (gpt-5.6-terra) | OpenAI | performance, correctness, doc-drift | 11 |
| `opencode/hy3-free` | Tencent | performance, api-design | 3+ |
| `opencode/nemotron-3-ultra-free` | NVIDIA | correctness, honesty | 6 |
| `opencode/mimo-v2.5-free` | Xiaomi | api-design, honesty | uzavírací kolo |

Po opravě balíčkem dodaly nálezy všechny enginy, které předtím vrátily prázdno.

---

## Blocker: na HID se návrh zadrhne natrvalo

Nahlásily nezávisle **dva dodavatele** (interní + codex). Aritmetika:

```
64 B paket − 7 B hlavička      = 57 B na instrukce
8 portů × GET_TYPEMODE po 6 B  = 48 B
                                 ─────
zbývá                            9 B  =  jedna hodnota
```

§9.1c říká, že typy se čtou vždycky pro všechny porty. Na HID to sežere celý rozpočet a
ořezové pravidlo pak nevybírá mezi volitelnými řádky — vybírá mezi detekcí hot-plugu a vším
ostatním. Priorita je statická, takže **poražené řádky prohrávají napořád**.

Kořen našel až codex na doc-drift lensu: **§9.1a řadí obsazenost portů do pomalého tieru,
§9.1c ji o dva odstavce níž prohlašuje za povinnou v každém rámci.** Ten sweep není tvrdý
požadavek, je to rozpor uvnitř jedné sekce. Když obsazenost patří tam, kam ji §9.1a řadí,
blocker mizí.

---

## Co se ukázalo ve firmwaru

Ověřeno čtením zdrojáku, ne převzato z nálezu.

| Tvrzení | Zdroj |
|---|---|
| `READY_*` na busy zařízení dělá `SetObjectIp(TmpIp-1); SetDispatchStatus(BUSYBREAK)` — instrukce se opakuje a blokuje VM thread až `MAX_DEVICE_BUSY_TIME` = **1200 ms** | `c_input.c:4623-4628`, `lms2012.h:313` |
| Neobsazený/chybový port dostane **zapsaný** `DATA8_NAN`/`DATA32_NAN`/`DATAF_NAN` | `c_input.c:4630-4655` |
| `GET_TYPEMODE` nikdy neblokuje — čte `DeviceType`/`DeviceMode` přímo z paměti | `c_input.c` |
| Odpověď = **deklarované** globály + 5 B, bez ohledu na zapsané bajty a bez kontroly proti `MAX_MSG_SIZE` | `c_com.c:3519-3532` |
| `TYPE_TERMINAL = 124` — pátý stav portu, v tabulce chyběl | `bytecodes.h:1018` |

Dva důsledky, které §9.1 tvrdila obráceně:

1. **„Přibrat hodnotu je zadarmo" neplatí.** Jedno neusazené zařízení pozastaví celý složený
   rámec o 1,2 s — plus heartbeat a všechny příkazy ve frontě za ním. Hladové skládání tu
   expozici maximalizuje.
2. **Firmware do slotu neobsazeného portu nezapíše „nic", zapíše NAN.** Skutečný důvod
   nečíst hodnotu neusazeného portu není zastaralý buffer, ale ten stall.

---

## Zarovnání: dvě měření a jeden špatný závěr mezi nimi

Nález (interní doc-drift, confidence medium) tvrdil, že §9.1b zobecňuje nad rámec důkazu:
LEGOev3 posílá 32bitové globály nezarovnané v šesti z osmi portů a funguje.

**Kolo 1.** Poslal jsem nezarovnaný `opINPUT_READSI` (0x9d) na offset 2. Cihla vrátila bajt
po bajtu otravu, `replyType 0x4`. Prohlásil jsem protipříklad za vyvrácený.

**To byla chyba.** LEGOev3 tenhle opcode nepoužívá — používá subcode `READY_SI` (29) pod
`opINPUT_DEVICE` (0x99). Vyvracel jsem tvrzení, které nikdo nevyslovil.

**Kolo 2**, přesná replika rozvržení LEGOev3 (typ@0, mód@1, SI@2, RAW@6, PCT@10):

```
lego layout  raw 21000000c8426400000064   replyType 0x2
  type 33  mode 0  SI@2 100  RAW@6 100  PCT@10 100
```

Prošlo, 3/3, se správnými hodnotami.

| Instrukce | 32bit výsledek na offsetu 2 | Odpověď |
|---|---|---|
| `opINPUT_READSI` (0x9d) | odmítnuto | `DIRECT_REPLY_ERROR` (0x04) |
| `opINPUT_DEVICE`/`READY_SI` (0x99, sub 29) | přijato, správná hodnota | `DIRECT_REPLY` (0x02) |

**Zarovnání není vlastnost globálního bufferu, ale instrukce, která do něj píše.** My
používáme 0x9d, takže pravidlo na nás platí — ale jako omezení zvolených opcodů, ne jako
zákon firmwaru.

Vedlejší zjištění s praktickým dopadem: přepnutí na `READY_*` subcody zruší zarovnávací
výplň za cenu jednoho bajtu na instrukci. Když bude HID rozpočet těsný, je to páka, kterou
návrh zatím nezná.

A mechanismus: cihla **nemlčí**. Ohlásí `DIRECT_REPLY_ERROR` a přiloží celý deklarovaný
buffer. „Čte se to jako data" platí jen pro parser, který ignoruje bajt typu odpovědi. Náš
odesílaný parser ho kontroluje (`validateReply`); obě moje sondy ne.

---

## Co říkají zralé implementace

Obě čtou telemetrii z EV3 roky a **obě dělají dvě věci, které náš návrh nedělal**.

**Protitlak zdarma.** LEGOev3 má `await PollSensorsAsync(); await Task.Delay(pollingTime)` —
jeho „100 ms" je *mezera po odpovědi*, ne perioda, takže nemůže předběhnout cihlu. Device
Manager má `Interlocked.Increment(ref _autoIDHardwareInterlock)` a tik přeskočí, pokud
předchozí ještě běží. Náš seznam splatností tiká podle nástěnných hodin proti sériové frontě
a nemá ani jedno.

**Základní tik s celočíselným dělitelem.** Device Manager jede 200 ms a
`_checkDeviceInfoCounter = 5` — pomalý tier každý pátý tik, **vlastním příkazem**, ne
přimíchaný do rychlého. Můj brief tvrdil, že obě reference pollují „jednou pevnou frekvencí";
nebyla to pravda a review to opravilo.

Ani jedna neskládá tiery hladově dohromady. To je konkrétní sázka §9.1b, kterou je potřeba
buď přijmout, nebo opustit — vědomě.

---

## Zapracováno

Opravy, které platí bez ohledu na to, jak dopadnou otevřená rozhodnutí:

- §9.1c: firmware zapíše NAN; skutečný důvod nečíst hodnotu je 1,2s stall, ne stará data;
  `TYPE_TERMINAL` do tabulky; rozhoduje se podle typu z **minulého** rámce a to má dva
  pojmenované důsledky
- §9.1b: zarovnání jako omezení per opcode s tabulkou obou měření; strop deklarace globálů;
  konflikt je mezi **módy**, ne mezi čteními (SI+RAW+PCT jednoho portu je v pořádku)
- §9.1: použitelný strop bufferu 1019 B; „jeden round trip ať nese čtyřicet hodnot" staženo
  na to, co měření 3→16 unese; ~250/~120 B označeno jako projekce
- §9.2: naměřené trvalé rychlosti (176/62/10,7 cmd/s); průměr i nejhorší případ zvlášť,
  protože sekce dřív míchala 121 ms nejhorší případ do průměrového rámce; „dělení čtyřmi"
  přeformulováno jako horní mez zlepšení, ne predikce
- plán 3.1.5 a 3.8: konstanty z naměřených rychlostí; odvolaný `MAX_COMMANDS_PER_SEC = 10`
  vyškrtnut i s otázkou, která z něj plynula
- plán 3.1.8/3.1.9/3.1.11: vlastnictví módu **napříč rámci**, ne per-frame kontrola; ořez
  hlídá i deklaraci; pátý stav portu
- plán 3.2.3: vrstva daisy chainu v identitě portu, surový kód typu vedle jména
- nové 3.1.12 (změřit složený rámec) a 3.1.13 (co HID dělá s příliš dlouhou odpovědí) —
  obojí dosud neměřené a dosud citované jako fakt

Testy po zapracování: **280 unit / 0 fail, 4/4 host, exit 0.**

---

## Tři rozhodnutí — 3.1.14, rozhodnuto týž den

Review otevřelo tři vázané otázky, které nemá rozhodovat implementátor. Vlastník je rozhodl
všechny podle doporučení.

**1. Sweep typů není povinný každý rámec.** Obsazenost je událostní řádek s vlastním
dělitelem. Tím blocker mizí u zdroje. Přijatá cena: hot-plug se pozná, až obsazenost přijde
na řadu — neviditelné vedle 1–2 s, které zařízení stejně hlásí `TYPE_UNKNOWN`.

**2. Základní tik s celočíselnými děliteli** místo seznamu splatností. Nejvýš jeden rámec
v letu; tik, který přijde na neuzavřený rámec, se **přeskočí, ne zařadí**. Hladové
předbíhání z budoucích tiků padá; široké skládání *uvnitř* tiku zůstává a pomalý tier má
vlastní příkaz. Statický tier dostal třetí životnost — *one-shot* — protože „dělitel 0"
umí jen „nikdy", ne „jednou".

**3. Řádky jako veřejný povrch.** Kategorie zůstávají jen jako pohodlný svazek rozbalený při
přihlášení, nikdy jako jednotka kadence. Řádky dostaly, co jim k roli kontraktu chybělo:
stabilní id v namespace, `apiVersion`, `sampledAt` na řádek, **přidělený** interval vrácený
z `subscribeTelemetry` (požadavek není záruka — 10 Hz na BT by spolklo celých 10,7 cmd/s),
handle odběratele s cestou k odhlášení, a registraci, která nevyhovující řádek **odmítne**
místo zveřejnění limitů jako API.

Dopad: přepsané §4.4, §9.1a, §9.1b, §9.1c, §9.3, §9.5, §9.6, §5.4, §10.2 a úkoly
3.1.6–3.1.11. Úkoly 3.2.1, 3.2.2 a 3.3.5 označené k přepsání proti řádkům.

Testy po zapracování: **280 unit / 0 fail, 4/4 host, exit 0.**

Plná matice 25 klastrů s verdikty je v `.review-out/MATRIX.md` (gitignorováno).

---

## Málem jsem přišel o plán

Blok 3.1.14 je 38 řádků markdownu a shell allowlist ho inline mrzačí, takže jsem na výměnu
napsal skript. `Select-String -Pattern '3\.1\.14 '` ale trefil **dvakrát** — jednou v odkazu
v preambuli, jednou v samotném bloku. `$start` byl pole, `$start - 2` spadlo na
`op_Subtraction`, `$out` nikdy nedostal hlavu souboru a `Set-Content` zapsal jen zbytek.
**Prvních 326 řádků bylo pryč.**

Obnova ze tří zdrojů, protože ani jeden sám nestačil:

- **hlava** z `git HEAD` — fáze 0–2 a začátek fáze 3 jsou commitnuté a dnes se jich nikdo
  nedotkl,
- **3.1.6–3.1.13** z `.review-out/PACKET.md`, který jsem ve 13:40 regeneroval z živého
  souboru, takže nesl zapracovanou hromadu A,
- **3.1.14 a celý zbytek** z useknutého souboru, který od 3.1.14 dál zůstal celý.

Znovu jsem pak doaplikoval úpravy hromady B, které do packetu ještě nestihly.

Byte-exact se nevrátily **dva řádky otevírající preambuli** — nebyly v gitu ani ve výřezu
v packetu. Přepsal jsem je významově, ne verbatim.

Poučení, které stojí za skript: **každý index z `Select-String` vynuť na skalár a ověř
počet, než ho použiješ.** Vzor je v `.review-out/restore-plan.ps1` — `Get-OneLineNumber`
hodí výjimku, když počet shod není přesně jeden. A druhé: nedestruktivní `Set-Content` nad
celým souborem si zaslouží kontrolu délky výstupu proti vstupu předtím, než zapíše.

---

## Co si z toho odnést do příštího kola

- **Prázdná buňka není souhlas.** Bez balíčku by tohle kolo hlásilo shodu na datech, která
  nevznikla.
- **Sonda musí replikovat to, co vyvrací.** Jinak vyvrátí tvrzení, které nikdo nevyslovil —
  a moje první oprava §9.1b byla přesně tím nálezem, který měla opravit. Podruhé v tomhle
  projektu.
- **Vypisuj `replyType`.** Půl sekce popisovalo „tiché přeskočení" u něčeho, co cihla
  poctivě hlásila jako chybu.
- **Doc-drift až po zapracování.** Většinu driftu vyrobí samo review kolo.
