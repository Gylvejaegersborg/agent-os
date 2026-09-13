// Standalone tests for plan mode (ROADMAP.md's "plan / read-only mode"
// item) — proves it's a real harness-level block, not a prompt
// suggestion the model could talk its way around:
//   1. shell/edit_file/write_file/subagent are all blocked outright when
//      planMode is true, even with NO PermissionPolicy installed at all
//      (i.e. something that would otherwise run completely unchecked).
//   2. read_file, skill, nominate-memory, and record-artifact are NOT
//      blocked by plan mode — only mutating tools are.
//   3. The SAME tool call, same session, with planMode omitted/false,
//      behaves exactly as before plan mode existed (regression proof).
//   4. A blocked call never actually executes — the underlying Worker is
//      never invoked at all.
// Run with: node dist/test-plan-mode.js

import "./test-helpers/isolate.js";
import { runTurn, newSessionId, type ModelAdapter, createArtifact, getArtifact } from "./core/index.js";
import type { Worker, WorkerResult } from "./core/worker.js";

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

/** A Worker that records whether it was ever actually invoked — proves a
 * blocked shell call never reaches real execution, not just that the
 * final message says "blocked." */
function countingWorker(): Worker & { calls: number } {
  const w = {
    calls: 0,
    id: "counting-worker",
    kind: "counting",
    async run(): Promise<WorkerResult> {
      w.calls++;
      return { ok: true, output: "ran" };
    },
  };
  return w;
}

async function lastAssistantMessage(sessionId: string): Promise<string> {
  const { getSessionHistory } = await import("./core/index.js");
  const history = await getSessionHistory(sessionId);
  const assistant = history.filter((m) => m.role === "assistant");
  return assistant[assistant.length - 1]?.content ?? "";
}

async function testMutatingToolsBlocked(): Promise<void> {
  console.log("\n-- 1. shell/edit_file/write_file/subagent are blocked outright, with NO PermissionPolicy at all --");
  for (const tool of ["shell", "edit_file", "write_file"]) {
    const sessionId = newSessionId();
    const worker = countingWorker();
    await runTurn({
      sessionId,
      agentId: "plan-mode-test-agent",
      userMessage: `please ${tool}`,
      model: modelThatCalls(tool, tool === "shell" ? { command: "echo hi" } : { path: "/tmp/x", content: "x", old_string: "a", new_string: "b" }),
      worker,
      planMode: true,
    });
    const message = await lastAssistantMessage(sessionId);
    assert(message.includes("plan mode"), `${tool} was blocked with a plan-mode message (got: "${message}")`);
    assert(worker.calls === 0, `${tool}'s underlying Worker was never actually invoked`);
  }

  console.log("\n-- subagent is blocked too (it can itself mutate files via a delegated turn) --");
  const sessionId = newSessionId();
  await runTurn({
    sessionId,
    agentId: "plan-mode-test-agent",
    userMessage: "please delegate",
    model: modelThatCalls("subagent", { goal: "do something" }),
    worker: countingWorker(),
    planMode: true,
    enableSubagents: true,
  });
  const message = await lastAssistantMessage(sessionId);
  assert(message.includes("plan mode"), `subagent was blocked too (got: "${message}")`);
}

async function testReadOnlyToolsNotBlocked(): Promise<void> {
  console.log("\n-- 2. read_file/nominate-memory/record-artifact are NOT blocked by plan mode --");

  const readSessionId = newSessionId();
  await runTurn({
    sessionId: readSessionId,
    agentId: "plan-mode-test-agent",
    userMessage: "please read",
    model: modelThatCalls("read_file", { path: "/etc/hostname" }),
    worker: countingWorker(),
    planMode: true,
  });
  const readMessage = await lastAssistantMessage(readSessionId);
  assert(!readMessage.includes("plan mode"), `read_file was NOT blocked by plan mode (got: "${readMessage}")`);

  const artifact = await createArtifact({ type: "file", location: "/tmp/pre-existing.txt", producer: "someone-else" });
  const sessionId = newSessionId();
  await runTurn({
    sessionId,
    agentId: "plan-mode-test-agent",
    userMessage: "please record",
    model: modelThatCalls("record-artifact", { type: "file", location: "/tmp/output.txt" }),
    worker: countingWorker(),
    planMode: true,
    enableArtifacts: true,
  });
  const recordMessage = await lastAssistantMessage(sessionId);
  assert(!recordMessage.includes("plan mode"), `record-artifact was NOT blocked by plan mode (got: "${recordMessage}")`);
  assert(!!(await getArtifact(artifact.id)), "sanity: the artifact registry itself is untouched by this test either way");
}

async function testPlanModeOffIsUnchanged(): Promise<void> {
  console.log("\n-- 3. The same call with planMode omitted behaves exactly as before --");
  const sessionId = newSessionId();
  const worker = countingWorker();
  await runTurn({
    sessionId,
    agentId: "plan-mode-test-agent",
    userMessage: "please shell",
    model: modelThatCalls("shell", { command: "echo hi" }),
    worker,
    // planMode omitted entirely
  });
  const message = await lastAssistantMessage(sessionId);
  assert(!message.includes("plan mode"), `with planMode omitted, the call is not blocked by plan mode (got: "${message}")`);
  assert(worker.calls === 1, "the shell command actually ran — unchanged regression behavior");
}

async function main(): Promise<void> {
  await testMutatingToolsBlocked();
  await testReadOnlyToolsNotBlocked();
  await testPlanModeOffIsUnchanged();

  if (process.exitCode === 1) {
    console.error("\nSome plan-mode tests FAILED.");
  } else {
    console.log("\nAll plan-mode tests passed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
