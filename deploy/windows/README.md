# Running the OS on a Windows server, Tailscale-only

Scripts for running agent-os (the gateway) and BaseSpace (BaseOStest) on a
Windows machine so that they are reachable **only over Tailscale**, and come back
by themselves after a reboot.

Layout assumed: `agent-os` and `BaseOStest` are cloned side by side in one folder
(`<root>`), Node is installed, Tailscale is installed and its service runs at boot.

| what | where it listens |
|---|---|
| gateway | `127.0.0.1:8787` (agent-os binds loopback itself, nothing else can reach it) |
| BaseSpace | `<tailscale ip>:5173`, the Tailscale interface only; it proxies `/agent-os` to the gateway |
| Hindsight (the agents' long-term memory) | `127.0.0.1:8888`, forced: its own default is `0.0.0.0` and it has no auth |

Hindsight runs through `uvx` (needs `uv`), extracts facts with Hindsight's `claude-code`
provider on Haiku (your Claude login; measured against local models in the main README,
"Which LLM should extract the facts?"), and is on by default. The first start downloads its
models and takes a while. To run without it, create an empty file `<root>\os-server\hindsight.off`
and restart; to use another extraction model set `HINDSIGHT_LLM_PROVIDER` / `HINDSIGHT_LLM_MODEL`
as machine environment variables. It needs `PYTHONUTF8=1`, which the supervisor sets (its
startup banner crashes on Windows' default encoding when output goes to a file).

Nothing listens on the LAN or Wi-Fi address. **Fails closed:** with no Tailscale
address the supervisor waits and starts nothing; it never falls back to a LAN
address. The Terminal feature (a shell over HTTP) is forced off.

## Install (once)

From a PowerShell in this folder (a boot-time task may need "Run as administrator"):

    .\install-autostart.ps1

This copies the scripts to `<root>\os-server` (so switching branches in the repo
can't break the boot task), registers the **ISARK OS** scheduled task (at boot and
at logon), and starts it. Re-run it after changing these scripts.

## Day to day (from `<root>\os-server`)

    .\start-os.ps1     restart everything (rebuilds agent-os first)
    .\stop-os.ps1      stop everything

Logs: `<root>\os-server\logs` (`supervisor.log` first; `gateway.err.log` and
`basespace.err.log` for crashes). Open `http://<tailscale ip>:5173` on any device
on your tailnet. `http://<machine name>:5173` is refused by Vite's host check
unless you add the name to `server.allowedHosts`.

## Why a supervisor

Task Scheduler kills the child processes of a task when its action exits. A task
that just started the servers and returned would lose them a moment later, so the
task runs `run-os.ps1`, which stays alive, owns both servers and restarts either
one if it dies (with a back-off if it crashes right after starting).

## Not covered

- The Windows Firewall. These scripts don't change it. Anything else that listens
  on the machine (RDP, SMB, Ollama on `0.0.0.0`, ...) is as reachable as before.
- Auth. The gateway has none; anyone on your tailnet can use the agents.
