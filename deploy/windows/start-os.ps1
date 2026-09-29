# (Re)starts the OS through the "ISARK OS" scheduled task, so the supervisor
# keeps owning the servers. Run install-autostart.ps1 once first.
$ErrorActionPreference = 'Stop'
if (-not (Get-ScheduledTask -TaskName 'ISARK OS' -ErrorAction SilentlyContinue)) {
  throw "Autostart isn't installed yet: run install-autostart.ps1 first."
}
& (Join-Path $PSScriptRoot 'stop-os.ps1')
Start-ScheduledTask -TaskName 'ISARK OS'

$ts = (& tailscale ip -4 2>$null | Select-Object -First 1)
$up = $false
for ($i = 0; $i -lt 120 -and -not $up; $i++) {
  Start-Sleep -Seconds 1
  try { $up = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://${ts}:5173/agent-os/health").StatusCode -eq 200 } catch { }
}
if (-not $up) { throw "Didn't come up - see $(Join-Path $PSScriptRoot 'logs')" }
Write-Host "Up. Open on any device on your tailnet:  http://${ts}:5173"
