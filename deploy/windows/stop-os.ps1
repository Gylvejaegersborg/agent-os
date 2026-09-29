# Stops the OS: the "ISARK OS" supervisor task, and anything still listening on
# the gateway (8787), BaseSpace (5173) and Hindsight (8888) ports.
Stop-ScheduledTask -TaskName 'ISARK OS' -ErrorAction SilentlyContinue
foreach ($port in 8787, 5173, 8888) {
  Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}
Start-Sleep -Seconds 1
