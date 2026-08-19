---
topic: Development Environment
last_compiled: 2026-04-13
status: active
---

# Development Environment

## Purpose

Dokumentuje konfiguraci VS Code workspace pro bezproblémový vývoj extension. Tato stránka zachycuje opravy, které byly opakovaně nutné — čti ji dřív, než začneš řešit záhadné chyby při spouštění.

## Spuštění extension (F5)

1. Otevři workspace `ev3-cockpit` ve VS Code.
2. Stiskni **F5** (nebo Run → Start Debugging → "Run Extension").
3. VS Code automaticky spustí build task `build:dev` (esbuild bundle) a otevře nové okno **Extension Development Host**.
4. V tom novém okně je naše extension aktivní. Output channel „EVƎ Cockpit" ukazuje logy.

**Pozor:** Extension host log viditelný v původním okně (`Ctrl+Shift+U` → „Extension Host") patří _vnějšímu_ VS Code, ne Extension Development Hostu. Naše extension se tam správně _neobjevuje_.

## Architektura (co VS Code spouští)

```
launch.json → preLaunchTask: "build:dev"
                └─ esbuild src/extension.ts → out/extension.js  (114 KB bundle)
             → type: "extensionHost"
                └─ otevře nové okno s --extensionDevelopmentPath
                   a načte out/extension.js
```

## Klíčová konfigurace `.vscode/`

### `launch.json` — preLaunchTask musí být explicitní název, EDH musí zakázat problémové extensions

```json
"args": [
  "--extensionDevelopmentPath=${workspaceFolder}",
  "--disable-extension=GitHub.copilot-chat",
  "--disable-extension=GitHub.copilot",
  "--disable-extension=eamodio.gitlens"
],
"preLaunchTask": "build:dev"
```

**`preLaunchTask` nesmí být `"${defaultBuildTask}"`** — VS Code tuto proměnnou v `preLaunchTask` spolehlivě neresolvuje:
> Could not find the task '${defaultBuildTask}'.

**`--disable-extension` pro Copilot Chat, Copilot a GitLens** — viz sekce níže.

### Copilot Chat EMFILE — celý obraz

EMFILE bug v Copilot Chat 0.42.x/0.43.x způsobuje pád EDH **dvěma mechanismy**:

**Mechanismus 1 — uvnitř EDH procesu:** EDH načítá všechny user extensions znovu ve svém vlastním procesu. Copilot Chat tam leakuje fd deskriptory, EMFILE nastane za ~20 s a naše extension selže:
> Activating extension '99LevelsUp.ev3-cockpit' failed: EMFILE: too many open files

→ Opraveno přes `--disable-extension` v `launch.json`.

**Mechanismus 2 — dědičnost fd tabulky na Windows (závažnější):** Copilot Chat leakuje deskriptory i v **outer VS Code procesu**. EMFILE nastane tam za ~20 s po startu. Když VS Code spawní EDH jako child process, Windows **zdědí** celou fd tabulku rodiče. EDH startuje s téměř nulovým zbytkem limitu a okamžitě crashne.

→ **Toto `--disable-extension` neřeší.** Je nutné deaktivovat nebo upgradovat Copilot Chat v **outer VS Code** (globálně):
- Upgrade na ≥ 0.44.0 (doporučeno)
- Nebo: Extensions panel → GitHub Copilot Chat → **Disable** → Reload Window

Tyto extensions v EDH okně nepotřebuješ — jsou jen pro práci v kódu v outer VS Code okně.

### `tasks.json` — default build task

```json
{
  "label": "build:dev",
  "type": "shell",
  "command": "npm run build:dev",
  "group": { "kind": "build", "isDefault": true }
}
```

**Nesmí** být `"type": "npm"` s `"script": "build:dev"` — VS Code npm task provider na Windows (zejm. při EMFILE problémech z Copilot Chat) někdy selže a task pak nelze najít, i když je v `tasks.json` správně definovaný. `type: "shell"` je přímočaré a nezávisí na VS Code npm task provideru.

### `settings.json` — ochrana před pády VS Code interních extension

```json
"files.watcherExclude": {
  "**/node_modules/**": true,
  "**/out/**": true,
  "**/.git/**": true
},
"json.schemaDownload.enable": false
```

- `files.watcherExclude` — bez tohoto VS Code sleduje tisíce souborů v `out/` a `node_modules/`, čímž zbytečně zatěžuje file systém.
- `json.schemaDownload.enable: false` — bez tohoto JSON language server stahuje obrovské VS Code extension manifest schema a může OOM crashnout s chybou `Pending response rejected since connection got disposed`.

## Známé problémy třetích stran

### Copilot Chat 0.42.x a 0.43.x — EMFILE: too many open files

Verze 0.42.0 a 0.43.0 obsahují bug: monkey-patchují `require()` a při každém volání leakují file descriptor. Po dostatečném počtu načtených modulů systém vyčerpá limit a VS Code built-in extensions (json-language-features, configuration-editing, extension-editing) se odmítnou načíst.

**Symptom (0.43.0):**
```
Error: EMFILE: too many open files, open '...json-language-features\client\dist\node\jsonClientMain.js'
  at Module.require (github.copilot-chat-0.43.0\dist\extension.js:489:36340)
```

**Symptom (0.42.0):** lehčí forma — zasáhne jen GitLens telemetrii, VS Code built-ins se načtou.

**Fix:** aktualizovat Copilot Chat na verzi ≥ 0.44.0, nebo použít verzi ≤ 0.41.x.  
Downgrade přes: Extensions panel → GitHub Copilot Chat → ozubené kolečko → Install Another Version.

### Copilot Chat 0.42.x — `e is not iterable`

Vedlejší efekt stejného bugu: inicializační kód (`j2.init`) selže s `TypeError: e is not iterable` v `POe.setItems`. Nefunkčnost je kosmetická (Copilot Chat neinicializuje agenty), ale přispívá k file descriptor leaku.

## Native Optional Dependencies (node-hid, serialport, koffi, regkey)

Všechny native `.node` binary deps musí být označeny jako `--external` ve všech esbuild příkazech:

```
--external:node-hid --external:serialport --external:koffi --external:regkey
```

**Proč:** Esbuild při bundlování bundluje i JavaScript část native modulu. Při běhu se pak `__dirname` resolvuje na `out/` (kde je bundle), takže node-hid hledá svůj prebuild v `out\prebuilds\HID-win32-x64\node-napi-v4.node` místo správného `node_modules\node-hid\prebuilds\...`. S `--external` je `require('node-hid')` ponecháno jako runtime call a Node.js ho resolvuje normálně z `node_modules/`.

**Prebuilds:** `node-hid` 3.3.0 obsahuje prebuild pro `HID-win32-x64/node-napi-v4.node`. VS Code extension host (Node.js 20, N-API v9, zpětně kompatibilní s v4) ho načte bez problémů.

## Gotchas

- Po každé změně kódu je nutné znovu spustit F5 (nebo `Ctrl+Shift+F5` pro restart) — Extension Development Host nepickne živé změny automaticky.
- `out/extension.js` je výstup esbuild (bundled), ne tsc. `tsc` generuje individuální soubory v `out/**/*.js` pro type checking a testy, ale extension host načítá bundle.
- Pokud F5 hlásí `Couldn't find a debug adapter descriptor for debug type 'extensionHost'`, je to znak, že `vscode.extensionhost-debug` built-in selhal kvůli EMFILE. Řeš: Reload Window (`Ctrl+Shift+P` → Developer: Reload Window) + aktualizovat Copilot Chat.

## Sources

- [.vscode/launch.json](../../.vscode/launch.json)
- [.vscode/tasks.json](../../.vscode/tasks.json)
- [.vscode/settings.json](../../.vscode/settings.json)
- [package.json](../../package.json)
