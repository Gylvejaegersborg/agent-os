// The terminal's "Shell" profile picks a sensible program per platform (the PTY tests in test-terminal.ts
// assume a POSIX machine; this one runs anywhere).
// Run with: node dist/test-terminal-shell.js

import { terminalShell, terminalsEnabled } from "./gateway/terminal.js";

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`ok: ${msg}`);
  else {
    failed = true;
    console.log(`FAIL: ${msg}`);
  }
}

const win = terminalShell({}, "win32");
assert(win.file === "powershell.exe" && win.args.join() === "-NoLogo", "on Windows the shell is PowerShell (no `bash` to rely on)");
assert(terminalShell({ SHELL: "/bin/zsh" }, "linux").file === "/bin/zsh", "on Linux it is $SHELL");
assert(terminalShell({}, "linux").file === "bash" && terminalShell({}, "darwin").file === "bash", "…or bash when SHELL is unset");
assert(terminalShell({ AGENT_OS_SHELL: "pwsh.exe", SHELL: "x" }, "win32").file === "pwsh.exe", "AGENT_OS_SHELL overrides it");

const saved = process.env.AGENT_OS_TERMINAL;
delete process.env.AGENT_OS_TERMINAL;
assert(!terminalsEnabled(), "terminals are off unless AGENT_OS_TERMINAL=1");
process.env.AGENT_OS_TERMINAL = "1";
assert(terminalsEnabled(), "…and on when it is 1");
if (saved === undefined) delete process.env.AGENT_OS_TERMINAL;
else process.env.AGENT_OS_TERMINAL = saved;

console.log(failed ? "\nSome terminal-shell tests FAILED." : "\nAll terminal-shell tests passed.");
process.exit(failed ? 1 : 0);
