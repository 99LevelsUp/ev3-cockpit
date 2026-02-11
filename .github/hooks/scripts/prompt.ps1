$ErrorActionPreference = "Stop"

$payload = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($payload)) { exit 0 }
$input = $payload | ConvertFrom-Json

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
$workDir  = Join-Path $repoRoot ".work"
New-Item -ItemType Directory -Path $workDir -Force | Out-Null

$logPath = Join-Path $workDir "copilot-prompts.log"

$ts = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$input.timestamp).ToString("o")
$cwd = $input.cwd
$prompt = $input.prompt

Add-Content -Path $logPath -Value "PROMPT`t$ts`tCWD=$cwd`t$prompt"
exit 0
