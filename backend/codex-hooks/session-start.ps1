$ErrorActionPreference = 'Stop'
$payload = [Console]::In.ReadToEnd()
if (-not $env:EASYCC_PORT -or -not $env:EASYCC_SESSION_ID -or -not $env:EASYCC_CODEX_HOOK_TOKEN) { exit 0 }
$headers = @{
  'x-easycc-session-id' = $env:EASYCC_SESSION_ID
  'x-easycc-hook-token' = $env:EASYCC_CODEX_HOOK_TOKEN
}
try {
  Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($env:EASYCC_PORT)/api/codex-windows/session-start" -Headers $headers -ContentType 'application/json' -Body $payload | Out-Null
} catch {
  exit 0
}
