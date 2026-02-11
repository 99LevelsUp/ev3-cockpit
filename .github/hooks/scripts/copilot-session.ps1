$repoRoot = (Resolve-Path ".").Path
$workDir = Join-Path $repoRoot ".work"
New-Item -ItemType Directory -Path $workDir -Force | Out-Null
$logPath = Join-Path $workDir "copilot-sessions-real.log"

Add-Content $logPath ("REAL_SESSION_START`t" + (Get-Date).ToString("o"))
copilot
$exitCode = $LASTEXITCODE
Add-Content $logPath ("REAL_SESSION_END`t" + (Get-Date).ToString("o") + "`tEXITCODE=$exitCode")
exit $exitCode
