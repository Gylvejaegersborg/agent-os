# One-time setup (or re-run after changing these scripts): copies the scripts to
# <root>\os-server and registers the "ISARK OS" scheduled task that starts the
# supervisor (run-os.ps1) at boot and at logon, then starts it now.
#
# <root> is the folder that holds the agent-os and BaseOStest checkouts side by
# side. The scripts are copied out of the repo on purpose: the task must keep
# working when a branch is switched and this folder isn't on it.
#
# Run from a PowerShell in this folder:   .\install-autostart.ps1
# (Registering a boot-time task may need "Run as administrator".)

$ErrorActionPreference = 'Stop'
$src  = $PSScriptRoot
$root = Split-Path (Split-Path (Split-Path $src))          # <root>\agent-os\deploy\windows -> <root>
$dest = Join-Path $root 'os-server'
New-Item -ItemType Directory -Force $dest | Out-Null
foreach ($f in 'run-os.ps1', 'start-os.ps1', 'stop-os.ps1') { Copy-Item (Join-Path $src $f) $dest -Force }

$user   = (whoami)
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f (Join-Path $dest 'run-os.ps1'))
# ExecutionTimeLimit 0: the supervisor is meant to run forever (the default limit would kill it after 3 days).
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable `
  -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

try {
  # Preferred: starts at boot, whether or not anyone is logged on (no password stored).
  $triggers  = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -AtLogOn -User $user))
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
  Register-ScheduledTask -TaskName 'ISARK OS' -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Force | Out-Null
  Write-Host "Registered: starts at boot, whether or not you are logged on."
} catch {
  Write-Warning "Boot-time registration failed ($($_.Exception.Message))."
  Write-Warning "Falling back to: start when you log on. Re-run as administrator for start-at-boot."
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName 'ISARK OS' -Action $action -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $user) -Settings $settings -Principal $principal -Force | Out-Null
}

Start-ScheduledTask -TaskName 'ISARK OS'
Write-Host "Started. Scripts are in $dest (start-os.ps1 / stop-os.ps1 to restart or stop); logs in $dest\logs."
