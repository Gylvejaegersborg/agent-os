// Standalone tests for the tool registry (tool-registry.ts) and its
// timeout-enforcement wiring into runTurn() (agent-loop.ts) — proves:
//   1. The built-in tools (shell/skill/subagent/nominate-memory) are
//      registered with real metadata, introspectable via
//      listToolDefinitions()/getToolDefinition().
//   2. registerTool() lets a caller add/override a definition.
//   3. withTimeout() itself: preempts a slow promise, passes through a
//      fast one, and is a true no-op when timeoutMs is undefined.
//   4. END-TO-END: registering a timeoutMs for "shell" and running a
//      slow Worker through a real runTurn() call actually produces a
//      timeout tool-result — proving the wiring at the dispatchTool()
//      call site works, not just the withTimeout() utility in isolation.
//   5. A tool with NO timeoutMs registered is never preempted, even when
//      its Worker is slow — proving the no-op case holds through the
//      real call site too, not just in testTimeoutUtility().
// Run with: node dist/test-tool-registry.js

import "./test-helpers/isolate.js";
import {
  listToolDefinitions,
  getToolDefinition,
  registerTool,
  resetToolRegistry,
  withTimeout,
  runTurn,
  newSessionId,
  createStubModel,
} from "./core/index.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testBuiltinsRegistered(): Promise<void> {
  console.log("\n-- 1. Built-in tools are registered with real metadata --");
  const all = listToolDefinitions();
  const names = all.map((t) => t.name);
  for (const expected of ["shell", "skill", "subagent", "nominate-memory"]) {
    assert(names.includes(expected), `listToolDefinitions() includes "${expected}"`);
  }

  const shell = getToolDefinition("shell");
  assert(!!shell?.description, "the 'shell' definition has a non-empty description");
  assert(shell?.inputSchema.command?.required === true, "'shell' declares 'command' as a required input");
  assert(shell?.timeoutMs === undefined, "no built-in tool has a timeout by default");
}

async function testRegisterAndOverride(): Promise<void> {
  console.log("\n-- 2. registerTool() adds/overrides definitions --");
  registerTool({
    name: "custom-tool",
    description: "a test-only tool definition",
    inputSchema: { foo: { type: "string" } },
  });
  const custom = getToolDefinition("custom-tool");
  assert(custom?.description === "a test-only tool definition", "a newly registered custom tool is retrievable");

  registerTool({ name: "shell", description: "overridden", inputSchema: {}, timeoutMs: 12345 });
  const overridden = getToolDefinition("shell");
  assert(overridden?.timeoutMs === 12345, "registerTool() overrides an existing built-in definition");

  resetToolRegistry();
  const restored = getToolDefinition("shell");
  assert(restored?.timeoutMs === undefined, "resetToolRegistry() restores the built-in default (no timeout)");
  assert(getToolDefinition("custom-tool") === undefined, "resetToolRegistry() drops custom-only registrations");
}

async function testWithTimeoutUtility(): Promise<void> {
  console.log("\n-- 3. withTimeout() utility --");
  const fast = withTimeout(sleep(5).then(() => "fast-result"), 200, () => "timed-out");
  assert((await fast) === "fast-result", "a promise resolving before timeoutMs wins the race");

  const slow = withTimeout(sleep(200).then(() => "slow-result"), 20, () => "timed-out");
  assert((await slow) === "timed-out", "a promise resolving after timeoutMs is preempted by onTimeout()");

  const noLimit = withTimeout(sleep(30).then(() => "unbounded-result"), undefined, () => "timed-out");
  assert((await noLimit) === "unbounded-result", "timeoutMs undefined never preempts (true no-op)");
}

async function testEndToEndTimeoutViaRunTurn(): Promise<void> {
  console.log("\n-- 4. End-to-end: a registered timeout preempts a slow tool call inside runTurn() --");
  resetToolRegistry();
  registerTool({
    name: "shell",
    description: "shell (test override with a short timeout)",
    inputSchema: {},
    timeoutMs: 30,
  });

  const slowWorker = {
    id: "slow-worker",
    kind: "test-slow",
    async run(command: string) {
      await sleep(200); // much slower than the 30ms timeout above
      return { ok: true, output: `ran: ${command}` };
    },
  };

  const result = await runTurn({
    sessionId: newSessionId(),
    agentId: "tool-registry-test-agent",
    userMessage: "run shell: echo hi",
    model: createStubModel(),
    worker: slowWorker,
  });

  assert(
    /timed out after 30ms/.test(result.finalContent),
    `runTurn() surfaces the timeout as the tool's result content (got: "${result.finalContent}")`,
  );

  resetToolRegistry();
}

async function testNoTimeoutMeansNoPreemptionEndToEnd(): Promise<void> {
  console.log("\n-- 5. No timeout registered -> a slow tool call is NOT preempted, even end-to-end --");
  const slowishWorker = {
    id: "slowish-worker",
    kind: "test-slowish",
    async run(command: string) {
      await sleep(50);
      return { ok: true, output: `ran: ${command}` };
    },
  };

  const result = await runTurn({
    sessionId: newSessionId(),
    agentId: "tool-registry-test-agent",
    userMessage: "run shell: echo hi",
    model: createStubModel(),
    worker: slowishWorker,
  });

  assert(!/timed out/.test(result.finalContent), "with no registered timeout, the slow tool call completes normally");
}

async function main(): Promise<void> {
  await testBuiltinsRegistered();
  await testRegisterAndOverride();
  await testWithTimeoutUtility();
  await testEndToEndTimeoutViaRunTurn();
  await testNoTimeoutMeansNoPreemptionEndToEnd();

  if (process.exitCode === 1) {
    console.error("\nSome tool-registry tests FAILED.");
  } else {
    console.log("\nAll tool-registry tests passed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
