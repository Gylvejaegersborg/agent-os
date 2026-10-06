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
  foreach ($port in 8787, 5173, 8888) {
    Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
      ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  }
  Start-Sleep -Seconds 1
}

# Hindsight: the agents' long-term memory (github.com/vectorize-io/hindsight), a
# Python server run through uvx. Create os-server\hindsight.off to run without it.
#   - extraction LLM: Hindsight's own claude-code provider (your Claude login) with
#     Haiku. Measured on this machine (see the README): qwen2.5:3b kept none of the
#     durable specifics, llama3.1:8b took 17 minutes and failed 2 of 6 turns on a
#     4 GB GPU, claude-code+Haiku kept everything in ~3 minutes and leaves the GPU
#     to the agents. Override with HINDSIGHT_LLM_PROVIDER / HINDSIGHT_LLM_MODEL.
#   - bound to 127.0.0.1: its default is 0.0.0.0 and it has no auth by default.
#   - PYTHONUTF8: its startup banner crashes on Windows' cp1252 when stdout is a file.
$hindsightVersion = '0.10.1'   # the version agent-os's client was checked against
$hindsightOn      = -not (Test-Path (Join-Path $PSScriptRoot 'hindsight.off'))
$hsProvider       = if ($env:HINDSIGHT_LLM_PROVIDER) { $env:HINDSIGHT_LLM_PROVIDER } else { 'claude-code' }
$hsModel          = if ($env:HINDSIGHT_LLM_MODEL)    { $env:HINDSIGHT_LLM_MODEL }    else { 'haiku' }

function Start-Hindsight {
  $env:PYTHONUTF8 = '1'
  $env:PYTHONIOENCODING = 'utf-8'
  $env:HINDSIGHT_API_LLM_PROVIDER = $hsProvider
  $env:HINDSIGHT_API_LLM_MODEL = $hsModel
  if ($hsProvider -eq 'ollama') { $env:HINDSIGHT_API_LLM_BASE_URL = 'http://localhost:11434/v1' }
  try {
    Start-Process -FilePath 'uvx' -ArgumentList @('--from', "hindsight-api==$hindsightVersion", 'hindsight-api', '--host', '127.0.0.1', '--port', '8888') `
      -WorkingDirectory $root -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput (Join-Path $logs 'hindsight.log') -RedirectStandardError (Join-Path $logs 'hindsight.err.log')
  } finally {
    # keep these out of the gateway's environment
    'PYTHONUTF8', 'PYTHONIOENCODING', 'HINDSIGHT_API_LLM_PROVIDER', 'HINDSIGHT_API_LLM_MODEL', 'HINDSIGHT_API_LLM_BASE_URL' |
      ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }
  }
}

function Start-Gateway {
  # Terminals (a full shell as this user, for anyone who can reach BaseSpace, i.e. your tailnet) are OFF unless you create
  # an empty file os-server\terminal.on. Delete it and restart to turn them off again.
  if (Test-Path (Join-Path $PSScriptRoot 'terminal.on')) { $env:AGENT_OS_TERMINAL = '1' } else { Remove-Item Env:AGENT_OS_TERMINAL -ErrorAction SilentlyContinue }
  # Agents recall from Hindsight when this is set; a down or still-starting Hindsight just means "no recall".
  if ($hindsightOn) { $env:HINDSIGHT_URL = 'http://127.0.0.1:8888' } else { Remove-Item Env:HINDSIGHT_URL -ErrorAction SilentlyContinue }
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

$hs = $null
if ($hindsightOn) {
  $hs = Start-Hindsight
  Log ("started Hindsight pid {0} (127.0.0.1:8888, extraction: {1}/{2}); the first start downloads models" -f $hs.Id, $hsProvider, $hsModel)
} else {
  Log 'Hindsight is off (hindsight.off exists): agents run without long-term memory'
}
$hsStart = Get-Date
$gw = Start-Gateway
$bs = Start-BaseSpace $ts
$gwStart = Get-Date
$bsStart = Get-Date
Log ("started gateway pid {0} (127.0.0.1:8787) and BaseSpace pid {1} ({2}:5173)" -f $gw.Id, $bs.Id, $ts)

while ($true) {
  Start-Sleep -Seconds 10

  if ($hindsightOn -and $hs.HasExited) {
    Log ("Hindsight exited (code {0}) - restarting" -f $hs.ExitCode)
    if (((Get-Date) - $hsStart).TotalSeconds -lt 60) { Start-Sleep -Seconds 120 }   # crash loop: back off
    $hs = Start-Hindsight
    $hsStart = Get-Date
  }

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
