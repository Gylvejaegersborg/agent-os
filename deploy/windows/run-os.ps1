# Supervisor for the ISARK OS on a Windows server, reachable ONLY over Tailscale.
#
# Runs from <root>\os-server (copied there by install-autostart.ps1), where <root>
# holds the agent-os and BaseOStest checkouts side by side. The "ISARK OS"
# scheduled task runs this and it never exits: Task Scheduler kills the child
# processes of a task when its action ends, so the servers have to be children
# of a process that stays alive. It also restarts either server if it dies.
#
#   gateway   127.0.0.1:8787        agent-os binds loopback itself
#   BaseSpace <tailscale ip>:5173   Vite dev server; proxies /agent-os to the gateway
#
# Fails closed: without a Tailscale address nothing starts (it waits, it never
# falls back to a LAN address). The Terminal feature (a shell over HTTP) is off.

$ErrorActionPreference = 'Continue'
$root      = Split-Path $PSScriptRoot
$agentOs   = Join-Path $root 'agent-os'
$baseSpace = Join-Path $root 'BaseOStest'
$logs      = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force $logs | Out-Null

function Log($m) { Add-Content -Path (Join-Path $logs 'supervisor.log') -Value ('{0} {1}' -f (Get-Date -Format 's'), $m) }

# A boot-time (no interactive logon) session can lack the profile variables; the
# Claude CLI finds its login under the profile, and npm wants APPDATA.
if (-not $env:USERPROFILE)  { $env:USERPROFILE  = $root }
if (-not $env:HOME)         { $env:HOME         = $env:USERPROFILE }
if (-not $env:APPDATA)      { $env:APPDATA      = Join-Path $root 'AppData\Roaming' }
if (-not $env:LOCALAPPDATA) { $env:LOCALAPPDATA = Join-Path $root 'AppData\Local' }

# A non-interactive session may not have the user-level PATH: make sure node,
# tailscale and the Claude CLI (claude.exe, in the user's .local\bin) resolve.
foreach ($p in @((Join-Path $root '.local\bin'), 'C:\Program Files\Tailscale', 'C:\Program Files\nodejs')) {
  if ((Test-Path $p) -and ($env:Path -notlike "*$p*")) { $env:Path = "$p;$env:Path" }
}

function Get-TailscaleIp {
  try { $ip = & tailscale ip -4 2>$null | Select-Object -First 1; if ($ip -match '^100\.') { return $ip } } catch { }
  return $null
}

function Stop-Ports {
  foreach ($port in 8787, 5173) {
    Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
      ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  }
  Start-Sleep -Seconds 1
}

function Start-Gateway {
  Remove-Item Env:AGENT_OS_TERMINAL -ErrorAction SilentlyContinue   # terminals stay off
  $env:BASEOS_REPO_DIR = $baseSpace
  Start-Process -FilePath 'node' -ArgumentList 'dist/gateway/cli.js' -WorkingDirectory $agentOs -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $logs 'gateway.log') -RedirectStandardError (Join-Path $logs 'gateway.err.log')
}

function Start-BaseSpace($ip) {
  Start-Process -FilePath 'node' -ArgumentList @('node_modules\vite\bin\vite.js', '--host', $ip, '--port', '5173', '--strictPort') `
    -WorkingDirectory $baseSpace -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $logs 'basespace.log') -RedirectStandardError (Join-Path $logs 'basespace.err.log')
}

Log ("supervisor starting as {0}; root {1}; USERPROFILE={2}" -f (whoami), $root, $env:USERPROFILE)
try { Log ("claude cli: {0}" -f ((& claude --version 2>&1 | Select-Object -First 1))) } catch { Log 'claude cli: NOT FOUND on PATH (claude-cli: agents will not work)' }

$ts = Get-TailscaleIp
while (-not $ts) { Log 'waiting for Tailscale to have an address...'; Start-Sleep -Seconds 10; $ts = Get-TailscaleIp }
Log "Tailscale address $ts"

Stop-Ports

Push-Location $agentOs
& npx.cmd tsc -b 2>&1 | Out-File (Join-Path $logs 'build.log')
if ($LASTEXITCODE -ne 0) { Log 'WARNING: the agent-os build reported errors (see build.log) - starting the existing build' }
Pop-Location

$gw = Start-Gateway
$bs = Start-BaseSpace $ts
$gwStart = Get-Date
$bsStart = Get-Date
Log ("started gateway pid {0} (127.0.0.1:8787) and BaseSpace pid {1} ({2}:5173)" -f $gw.Id, $bs.Id, $ts)

while ($true) {
  Start-Sleep -Seconds 10

  if ($gw.HasExited) {
    Log ("gateway exited (code {0}) - restarting" -f $gw.ExitCode)
    if (((Get-Date) - $gwStart).TotalSeconds -lt 30) { Start-Sleep -Seconds 60 }   # crash loop: back off
    $gw = Start-Gateway
    $gwStart = Get-Date
  }

  $now = Get-TailscaleIp
  if ($bs.HasExited -or ($now -and $now -ne $ts)) {
    if (-not $bs.HasExited) { Stop-Process -Id $bs.Id -Force -ErrorAction SilentlyContinue }
    Log ("BaseSpace restarting (exited, or the Tailscale address changed: {0} -> {1})" -f $ts, $now)
    if ($now) { $ts = $now }
    if (((Get-Date) - $bsStart).TotalSeconds -lt 30) { Start-Sleep -Seconds 60 }
    $bs = Start-BaseSpace $ts
    $bsStart = Get-Date
  }
}
