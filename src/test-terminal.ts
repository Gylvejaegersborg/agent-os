// Tests for the in-OS terminals (gateway/terminal.ts) through the real
// HTTP routes, once with node-pty and once with the `script` fallback.
// The "claude" profile is pointed at a fake CLI (CLAUDE_CLI_PATH) so no
// login is needed. Proves:
//   1. Terminals are off unless AGENT_OS_TERMINAL=1 (403 with how to enable).
//   2. A shell session runs typed input and streams its output over SSE.
//   3. A client that re-attaches gets the scrollback first.
//   4. The exit code is reported, and DELETE removes the session.
//   5. The claude profile starts the Claude CLI in BASEOS_REPO_DIR.
//   6. With node-pty, resize reaches the process (`tput cols`).
// Run with: node dist/test-terminal.js

import "./test-helpers/isolate.js";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startGateway } from "./gateway/server.js";
import { closeAllTerminals, resetPtyBackend } from "./gateway/terminal.js";
import { createStubModel, createStubWorker } from "./core/index.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

const dir = mkdtempSync(path.join(os.tmpdir(), "term-test-"));
const fakeClaude = path.join(dir, "claude");
writeFileSync(fakeClaude, `#!/bin/sh\necho "fake claude in $(pwd)"\nread line\necho "you said: $line"\n`);
chmodSync(fakeClaude, 0o755);
process.env.CLAUDE_CLI_PATH = fakeClaude;
process.env.BASEOS_REPO_DIR = dir;
process.env.SHELL = "/bin/sh";

/** Reads a terminal's SSE stream until `until` matches the collected
 *  output (or an exit event arrives, or the timeout passes). */
async function readStream(base: string, id: string, until: RegExp, timeoutMs = 8000): Promise<{ output: string; exitCode?: number }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let output = "";
  let exitCode: number | undefined;
  try {
    const res = await fetch(`${base}/terminals/${id}/stream`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const event = frame.match(/^event: (.*)$/m)?.[1];
        const data = frame.match(/^data: (.*)$/m)?.[1];
        if (!event || !data) continue;
        if (event === "output") output += JSON.parse(data).data;
        if (event === "exit") exitCode = JSON.parse(data).code;
      }
      if (until.test(output) || exitCode !== undefined) break;
    }
  } catch {
    // aborted by the timeout
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
  return { output, exitCode };
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function run(backend: "node-pty" | "script"): Promise<void> {
  process.env.AGENT_OS_TERMINAL_BACKEND = backend === "script" ? "script" : "";
  resetPtyBackend();
  const gateway = await startGateway({ model: createStubModel(), worker: createStubWorker() });
  const base = `http://127.0.0.1:${gateway.port}`;
  try {
    const list = (await (await fetch(`${base}/terminals`)).json()) as { enabled: boolean; backend: string };
    assert(list.enabled && list.backend === backend, `[${backend}] GET /terminals reports enabled with the ${backend} backend`);

    const shell = (await (await post(`${base}/terminals`, { profile: "shell", cols: 90, rows: 20 })).json()) as { id: string };
    await post(`${base}/terminals/${shell.id}/input`, { data: "echo sum-$((40+2))\n" });
    const first = await readStream(base, shell.id, /sum-42/);
    assert(/sum-42/.test(first.output), `[${backend}] typed input runs and its output streams back`);

    const again = await readStream(base, shell.id, /sum-42/, 3000);
    assert(/sum-42/.test(again.output), `[${backend}] re-attaching replays the scrollback`);

    if (backend === "node-pty") {
      await post(`${base}/terminals/${shell.id}/resize`, { cols: 123, rows: 40 });
      await post(`${base}/terminals/${shell.id}/input`, { data: "echo cols-$(tput cols)\n" });
      const resized = await readStream(base, shell.id, /cols-123/);
      assert(/cols-123/.test(resized.output), "[node-pty] resize reaches the process");
    }

    await post(`${base}/terminals/${shell.id}/input`, { data: "exit 3\n" });
    const ended = await readStream(base, shell.id, /$^/);
    assert(ended.exitCode === 3, `[${backend}] the exit code is reported (got ${ended.exitCode})`);
    const inputAfterExit = await post(`${base}/terminals/${shell.id}/input`, { data: "x" });
    assert(inputAfterExit.status === 404, `[${backend}] input to an exited terminal is refused`);
    assert((await fetch(`${base}/terminals/${shell.id}`, { method: "DELETE" })).status === 200, `[${backend}] DELETE removes it`);

    const claude = (await (await post(`${base}/terminals`, { profile: "claude" })).json()) as { id: string; cwd: string; title: string };
    assert(claude.title === "Claude Code" && claude.cwd === dir, `[${backend}] the claude profile starts in BASEOS_REPO_DIR`);
    const started = await readStream(base, claude.id, /fake claude in/);
    assert(started.output.includes(`fake claude in ${dir}`), `[${backend}] it runs the Claude CLI`);
    await post(`${base}/terminals/${claude.id}/input`, { data: "hello\r" });
    const replied = await readStream(base, claude.id, /you said: hello/);
    assert(/you said: hello/.test(replied.output), `[${backend}] keystrokes reach it`);
  } finally {
    closeAllTerminals();
    await gateway.stop();
  }
}

async function main(): Promise<void> {
  delete process.env.AGENT_OS_TERMINAL;
  {
    const gateway = await startGateway({ model: createStubModel(), worker: createStubWorker() });
    const base = `http://127.0.0.1:${gateway.port}`;
    const res = await post(`${base}/terminals`, { profile: "shell" });
    const body = (await res.json()) as { error?: string };
    assert(res.status === 403 && /AGENT_OS_TERMINAL=1/.test(body.error ?? ""), "terminals are off by default, and the error says how to enable them");
    await gateway.stop();
  }

  process.env.AGENT_OS_TERMINAL = "1";
  let hasNodePty = false;
  try {
    const name = "node-pty";
    await import(name);
    hasNodePty = true;
  } catch {
    console.log("skip: node-pty not installed — only the script fallback is tested");
  }
  if (hasNodePty) await run("node-pty");
  await run("script");

  if (process.exitCode === 1) console.error("\nSome terminal tests FAILED.");
  else console.log("\nAll terminal tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
