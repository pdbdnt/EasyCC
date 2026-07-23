$ErrorActionPreference = 'Stop'
$payload = [Console]::In.ReadToEnd()

if ($env:EASYCC_PORT -and $env:EASYCC_SESSION_ID -and $env:EASYCC_CODEX_HOOK_TOKEN) {
  $headers = @{
    'x-easycc-session-id' = $env:EASYCC_SESSION_ID
    'x-easycc-hook-token' = $env:EASYCC_CODEX_HOOK_TOKEN
  }
  try {
    Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($env:EASYCC_PORT)/api/codex-windows/turn-timing" -Headers $headers -ContentType 'application/json' -Body $payload | Out-Null
  } catch {
    # Timing must never prevent a Codex turn from starting or finishing.
  }
}

# Stop hooks require JSON on stdout. An empty object is also harmless for
# UserPromptSubmit, so the same helper can serve both lifecycle events.
[Console]::Out.Write('{}')
