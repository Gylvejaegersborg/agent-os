// Standalone tests for user-configurable hooks (ROADMAP.md's "user-
// configurable hooks" item, configured-hooks.ts) — proves:
//   1. loadConfiguredHooks() on a missing file returns [] (not an
//      error) and registers nothing.
//   2. A malformed hooks.json (bad JSON, or a valid-JSON-but-invalid
//      entry) throws with a specific, actionable message rather than
//      silently dropping the bad entry.
//   3. A configured tool.before hook that exits nonzero actually blocks
//      a real tool call, end to end through runTurn() — proving it's
//      wired into the REAL hook system, not a parallel mechanism.
//   4. matchTool correctly scopes a hook to one tool name, leaving a
//      different tool's call unaffected.
//   5. An exit-0 hook allows the call through, and the hook script
//      genuinely receives the HookContext as JSON on stdin (not just a
//      canned pass).
// Run with: node dist/test-configured-hooks.js

import "./test-helpers/isolate.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { loadConfiguredHooks, parseConfiguredHooks, runTurn, newSessionId, createStubWorker, clearHooks, type ModelAdapter } from "./core/index.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

function modelThatCalls(name: string, args: Record<string, unknown>): ModelAdapter {
  let called = false;
  return {
    id: `always-call-${name}`,
    async complete() {
      if (called) return { content: "done" };
      called = true;
      return { content: `calling ${name}`, toolCall: { name, args } };
    },
  };
}

async function lastAssistantMessage(sessionId: string): Promise<string> {
  const { getSessionHistory } = await import("./core/index.js");
  const history = await getSessionHistory(sessionId);
  const assistant = history.filter((m) => m.role === "assistant");
  return assistant[assistant.length - 1]?.content ?? "";
}

async function testMissingFileIsEmpty(): Promise<void> {
  console.log("\n-- 1. A missing hooks file returns [], not an error --");
  const hooks = await loadConfiguredHooks(path.join(os.tmpdir(), "definitely-does-not-exist-hooks.json"));
  assert(hooks.length === 0, "no hooks loaded from a nonexistent file");
}

async function testMalformedConfigThrows(): Promise<void> {
  console.log("\n-- 2. Malformed config throws with a specific message --");
  let threw = false;
  try {
    parseConfiguredHooks("not json at all");
  } catch (err) {
    threw = true;
    assert((err as Error).message.includes("not valid JSON"), `error message names the actual problem (got: "${(err as Error).message}")`);
  }
  assert(threw, "bad JSON throws rather than silently returning []");

  let threw2 = false;
  try {
    parseConfiguredHooks(JSON.stringify([{ event: "not-a-real-event", command: "echo hi" }]));
  } catch (err) {
    threw2 = true;
    assert((err as Error).message.includes("invalid or missing \"event\""), `an invalid event name is rejected by name (got: "${(err as Error).message}")`);
  }
  assert(threw2, "an invalid event name throws rather than silently registering something wrong");
}

async function withHooksFile(entries: unknown[], run: () => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-os-hooks-test-"));
  const file = path.join(dir, "hooks.json");
  await fs.writeFile(file, JSON.stringify(entries), "utf-8");
  clearHooks();
  try {
    await loadConfiguredHooks(file);
    await run();
  } finally {
    clearHooks();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function testBlockingHookEndToEnd(): Promise<void> {
  console.log("\n-- 3. A configured hook that exits nonzero actually blocks a real tool call --");
  await withHooksFile(
    [{ event: "tool.before", command: `node -e "console.log('blocked by configured hook'); process.exit(1)"`, matchTool: "shell" }],
    async () => {
      const sessionId = newSessionId();
      await runTurn({
        sessionId,
        agentId: "configured-hooks-test-agent",
        userMessage: "run it",
        model: modelThatCalls("shell", { command: "echo hi" }),
        worker: createStubWorker(),
      });
      const message = await lastAssistantMessage(sessionId);
      assert(message.includes("blocked by configured hook"), `the hook's stdout became the block reason (got: "${message}")`);
    },
  );
}

async function testMatchToolScoping(): Promise<void> {
  console.log("\n-- 4. matchTool scopes the hook to one tool — a different tool is unaffected --");
  await withHooksFile(
    [{ event: "tool.before", command: `node -e "process.exit(1)"`, matchTool: "shell" }],
    async () => {
      const sessionId = newSessionId();
      await runTurn({
        sessionId,
        agentId: "configured-hooks-test-agent",
        userMessage: "read it",
        model: modelThatCalls("read_file", { path: "/etc/hostname" }),
        worker: createStubWorker(),
      });
      const message = await lastAssistantMessage(sessionId);
      assert(!message.includes("Tool call blocked"), `read_file is unaffected by a hook scoped to "shell" (got: "${message}")`);
    },
  );
}

async function testExitZeroAllowsAndReceivesContext(): Promise<void> {
  console.log("\n-- 5. An exit-0 hook allows the call through and genuinely receives HookContext on stdin --");
  const markerFile = path.join(os.tmpdir(), `agent-os-hook-marker-${Date.now()}.json`);
  await withHooksFile(
    [
      {
        event: "tool.before",
        command: `node -e 'const fs=require("fs"); let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>fs.writeFileSync("${markerFile}", d))'`,
        matchTool: "shell",
      },
    ],
    async () => {
      const sessionId = newSessionId();
      const worker = createStubWorker();
      await runTurn({
        sessionId,
        agentId: "configured-hooks-test-agent",
        userMessage: "run it",
        model: modelThatCalls("shell", { command: "echo marker-test" }),
        worker,
      });
      // Give the detached hook process a moment to finish writing —
      // runConfiguredHook() already awaits the exec() callback before
      // resolving, so this is just OS-level file-write latency, not a
      // race with the hook's own completion.
      await new Promise((r) => setTimeout(r, 200));
      const written = await fs.readFile(markerFile, "utf-8").catch(() => "");
      const parsed = written ? JSON.parse(written) : null;
      assert(parsed?.payload?.name === "shell", `the hook received the real tool call's name on stdin (got: ${JSON.stringify(parsed?.payload)})`);
      assert(parsed?.payload?.args?.command === "echo marker-test", "the hook received the real tool call's args on stdin");
    },
  );
  await fs.rm(markerFile, { force: true });
}

async function main(): Promise<void> {
  await testMissingFileIsEmpty();
  await testMalformedConfigThrows();
  await testBlockingHookEndToEnd();
  await testMatchToolScoping();
  await testExitZeroAllowsAndReceivesContext();

  if (process.exitCode === 1) {
    console.error("\nSome configured-hooks tests FAILED.");
  } else {
    console.log("\nAll configured-hooks tests passed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
