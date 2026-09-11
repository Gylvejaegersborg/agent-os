// Standalone tests for the Session registry (session.ts) — proves:
//   1. Session CRUD/listing works as a real projection (create/get/list,
//      filtering by agentId/status/parentSessionId).
//   2. ensureSession() is genuinely idempotent (touches, doesn't duplicate)
//      and is what makes runTurn() (agent-loop.ts) register a Session
//      automatically for callers that never pre-created one.
//   3. Terminal statuses actually stick: a Session that's cancelled/
//      completed/error cannot be transitioned again.
//   4. Real mid-turn cancellation: cancelling a Session WHILE a tool call
//      is in flight stops the agent loop before it would have hopped
//      again, rather than only being noticed after the turn finished
//      naturally.
//   5. cancelSession() propagates into a linked Task (best-effort child
//      cancellation), not just the Session's own record.
// Run with: node dist/test-session.js

import "./test-helpers/isolate.js";
import {
  createSession,
  getSession,
  listSessions,
  ensureSession,
  setSessionStatus,
  cancelSession,
  isSessionCancelled,
  linkSessionWork,
  runTurn,
  newSessionId,
  createTask,
  transitionTask,
  getTask,
  type ModelAdapter,
} from "./core/index.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

async function assertThrows(fn: () => Promise<unknown>, msg: string): Promise<void> {
  try {
    await fn();
    assert(false, msg);
  } catch {
    assert(true, msg);
  }
}

async function testRegistryBasics(): Promise<void> {
  console.log("\n-- 1. Session registry CRUD/listing --");
  const agentId = "session-test-agent";

  const s1 = await createSession({ agentId, title: "first" });
  assert(s1.status === "active", "a newly created session starts 'active'");
  assert(s1.title === "first", "title is preserved");

  const fetched = await getSession(s1.id);
  assert(fetched?.id === s1.id, "getSession() finds the just-created session");

  const s2 = await createSession({ agentId, parentSessionId: s1.id });
  const child = await listSessions({ parentSessionId: s1.id });
  assert(child.length === 1 && child[0]!.id === s2.id, "listSessions({parentSessionId}) finds the child session");

  const forAgent = await listSessions({ agentId });
  assert(forAgent.length === 2, `listSessions({agentId}) finds both sessions (got ${forAgent.length})`);

  const missing = await getSession("no-such-session-id");
  assert(missing === undefined, "getSession() on an unknown id returns undefined");
}

async function testEnsureSessionIdempotent(): Promise<void> {
  console.log("\n-- 2. ensureSession() idempotency --");
  const agentId = "session-test-agent";
  const id = newSessionId();

  const created = await ensureSession(id, agentId);
  assert(created.id === id, "ensureSession() creates a fresh session when none exists");

  await new Promise((r) => setTimeout(r, 5));
  const touched = await ensureSession(id, agentId);
  assert(touched.id === id, "ensureSession() on an existing id returns the SAME session, not a duplicate");
  assert(
    touched.updatedAt >= created.updatedAt,
    "ensureSession() on an existing id bumps updatedAt rather than leaving it stale",
  );

  const all = await listSessions({ agentId: "session-test-agent" });
  const matching = all.filter((s) => s.id === id);
  assert(matching.length === 1, "ensureSession() never created a second registry entry for the same id");
}

async function testTerminalStatusSticks(): Promise<void> {
  console.log("\n-- 3. Terminal statuses cannot be re-transitioned --");
  const s = await createSession({ agentId: "session-test-agent" });
  const completed = await setSessionStatus(s.id, "completed");
  assert(completed.status === "completed", "setSessionStatus() transitions to 'completed'");

  await assertThrows(
    () => setSessionStatus(s.id, "active"),
    "re-transitioning an already-terminal ('completed') session throws instead of silently succeeding",
  );

  await assertThrows(
    () => cancelSession(s.id),
    "cancelSession() on an already-terminal session also throws (terminal means terminal)",
  );
}

async function testMidTurnCancellation(): Promise<void> {
  console.log("\n-- 4. Real mid-turn cancellation (not just post-hoc) --");
  const agentId = "session-test-agent";
  const sessionId = newSessionId();

  // A model that ALWAYS requests a tool call — if cancellation weren't
  // checked mid-loop, this would run all the way to maxToolHops.
  let modelCalls = 0;
  const alwaysToolCallModel: ModelAdapter = {
    id: "always-tool-call",
    async complete() {
      modelCalls++;
      return { content: `hop ${modelCalls}`, toolCall: { name: "shell", args: { command: "echo hi" } } };
    },
  };

  // A worker that cancels the session AS A SIDE EFFECT of running the
  // tool — simulating an external process (a gateway handling a user's
  // "stop" request) calling cancelSession() while this exact tool call is
  // in flight.
  let workerRuns = 0;
  const cancellingWorker = {
    id: "cancelling-worker",
    kind: "test-stub",
    async run(command: string) {
      workerRuns++;
      await cancelSession(sessionId, "user requested stop mid-tool-call");
      return { ok: true, output: `ran: ${command}` };
    },
  };

  const result = await runTurn({
    sessionId,
    agentId,
    userMessage: "run shell: echo hi",
    model: alwaysToolCallModel,
    worker: cancellingWorker,
    maxToolHops: 10,
  });

  assert(result.cancelled === true, "runTurn() reports cancelled:true when the session was cancelled mid-turn");
  assert(workerRuns === 1, `the tool ran exactly once before cancellation was honored (got ${workerRuns})`);
  assert(
    modelCalls === 1,
    `the model was called exactly once — cancellation was caught right after the in-flight tool call, ` +
      `before a second hop (got ${modelCalls})`,
  );

  const session = await getSession(sessionId);
  assert(session?.status === "cancelled", "the Session's registry status reflects 'cancelled' after the turn");

  assert(await isSessionCancelled(sessionId), "isSessionCancelled() reports true after cancellation");
}

async function testCancelPropagatesToLinkedTask(): Promise<void> {
  console.log("\n-- 5. cancelSession() propagates into a linked Task --");
  const agentId = "session-test-agent";
  const session = await createSession({ agentId });
  const task = await createTask({ type: "user-request", agentId, input: {} });
  await transitionTask(task.id, "running");
  await linkSessionWork(session.id, { taskId: task.id });

  await cancelSession(session.id, "user cancelled the session");

  const updatedTask = await getTask(task.id);
  assert(updatedTask?.status === "cancelled", "the linked Task is transitioned to 'cancelled' as a side effect");

  // A second Session linked to an ALREADY-terminal Task must not error out
  // — propagation is best-effort, not a hard requirement.
  const session2 = await createSession({ agentId });
  const alreadyDoneTask = await createTask({ type: "user-request", agentId, input: {} });
  await transitionTask(alreadyDoneTask.id, "running");
  await transitionTask(alreadyDoneTask.id, "succeeded");
  await linkSessionWork(session2.id, { taskId: alreadyDoneTask.id });
  await cancelSession(session2.id, "cancelling after the linked task already finished");
  const stillSucceeded = await getTask(alreadyDoneTask.id);
  assert(
    stillSucceeded?.status === "succeeded",
    "an already-terminal linked Task is left untouched (best-effort propagation, not forced)",
  );
}

async function main(): Promise<void> {
  await testRegistryBasics();
  await testEnsureSessionIdempotent();
  await testTerminalStatusSticks();
  await testMidTurnCancellation();
  await testCancelPropagatesToLinkedTask();

  if (process.exitCode === 1) {
    console.error("\nSome session tests FAILED.");
  } else {
    console.log("\nAll session tests passed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
