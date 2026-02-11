$ErrorActionPreference = "Stop"

$payload = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($payload)) { exit 0 }
$input = $payload | ConvertFrom-Json

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
$workDir  = Join-Path $repoRoot ".work"
New-Item -ItemType Directory -Path $workDir -Force | Out-Null

$logPath = Join-Path $workDir "copilot-errors.log"

$ts = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$input.timestamp).ToString("o")
$cwd = $input.cwd
$name = $input.error.name
$msg  = $input.error.message

Add-Content -Path $logPath -Value "ERROR`t$ts`tCWD=$cwd`t[$name] $msg"
exit 0
