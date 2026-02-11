$ErrorActionPreference = "Stop"

# Read JSON from stdin (GitHub hook format)
$payload = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($payload)) { exit 0 }
$input = $payload | ConvertFrom-Json

# Ensure .work exists (repo root relative)
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
$workDir  = Join-Path $repoRoot ".work"
New-Item -ItemType Directory -Path $workDir -Force | Out-Null

$logPath = Join-Path $workDir "copilot-sessions.log"

$ts = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$input.timestamp).ToString("o")
$source = $input.source
$cwd = $input.cwd
$initialPrompt = $input.initialPrompt

Add-Content -Path $logPath -Value "SESSION_START`t$ts`tSOURCE=$source`tCWD=$cwd`tPROMPT=$initialPrompt"
exit 0
