$ErrorActionPreference = "Stop"

$payload = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($payload)) { exit 0 }
$input = $payload | ConvertFrom-Json

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
$workDir  = Join-Path $repoRoot ".work"
New-Item -ItemType Directory -Path $workDir -Force | Out-Null

$logPath = Join-Path $workDir "copilot-sessions.log"

$ts = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$input.timestamp).ToString("o")
$reason = $input.reason
$cwd = $input.cwd

Add-Content -Path $logPath -Value "SESSION_END`t$ts`tREASON=$reason`tCWD=$cwd"
exit 0
