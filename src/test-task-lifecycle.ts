// Standalone tests for real Task lifecycle enforcement (tasks.ts additions
// on top of the original queued->running->succeeded|failed skeleton):
//   1. Timeout enforcement: a 'running' Task whose configured timeoutMs
//      has elapsed transitions to 'timed_out' via checkTaskTimeouts().
//   2. 'lost' detection: reconcileLostTasks()'s liveTaskIds-based
//      reconciliation sweep marks a Task 'lost' when the process that was
//      running it "restarts" (simulateProcessRestart()) before it
//      completes — and does NOT falsely mark a genuinely-live Task lost.
//   3. notifyPolicy wired to something real for all three policies:
//      'immediate' fires per-task on the real event bus, 'digest'
//      batches until flushDigest() drains the queue, 'silent' suppresses
//      the bus publish entirely (but still audits the suppression).
//   4. Flow.kind:'mirrored': a 1:1 wrapper Flow around a single Task,
//      auto-propagating the Task's own status onto the Flow's one step
//      with zero direct updateFlowStep() calls from the caller —
//      contrasted with the existing 'managed' explicit-step-control path.
// Run with: node dist/test-task-lifecycle.js

import {
  createTask,
  transitionTask,
  getTask,
  listTasks,
  checkTaskTimeouts,
  reconcileLostTasks,
  simulateProcessRestart,
  flushDigest,
  peekDigestQueue,
  subscribeToEvent,
  createFlow,
  createMirroredFlow,
  updateFlowStep,
  getFlow,
  readStream,
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

async function testTimeoutEnforcement(): Promise<void> {
  console.log("\n-- 1. Timeout enforcement --");
  const agentId = "lifecycle-test-agent";

  // A Task with a very short timeout that we let genuinely elapse.
  const shortLived = await createTask({
    type: "cli",
    agentId,
    input: {},
    timeoutMs: 50,
  });
  await transitionTask(shortLived.id, "running");
  await sleep(80); // let it actually exceed its 50ms budget

  // A Task with a long timeout that should NOT be touched by the sweep.
  const longLived = await createTask({
    type: "cli",
    agentId,
    input: {},
    timeoutMs: 60_000,
  });
  await transitionTask(longLived.id, "running");

  // A Task with NO timeoutMs at all — sweep must skip it even though
  // it's been "running" the whole time, unless a defaultTimeoutMs is given.
  const untimed = await createTask({ type: "cli", agentId, input: {} });
  await transitionTask(untimed.id, "running");

  const result = await checkTaskTimeouts();
  assert(result.timedOut.includes(shortLived.id), "sweep transitions the elapsed short-timeout Task to timed_out");
  assert(!result.timedOut.includes(longLived.id), "sweep leaves the not-yet-elapsed long-timeout Task alone");
  assert(!result.timedOut.includes(untimed.id), "sweep skips a Task with no timeoutMs configured");

  const afterShort = await getTask(shortLived.id);
  const afterLong = await getTask(longLived.id);
  const afterUntimed = await getTask(untimed.id);
  assert(afterShort?.status === "timed_out", `elapsed Task's projected status is "timed_out" (got "${afterShort?.status}")`);
  assert(afterShort?.completedAt !== undefined, "a timed_out Task gets a completedAt, same as any other terminal status");
  assert(afterLong?.status === "running", `not-yet-elapsed Task's status is untouched, still "running" (got "${afterLong?.status}")`);
  assert(afterUntimed?.status === "running", `untimed Task's status is untouched, still "running" (got "${afterUntimed?.status}")`);

  // A defaultTimeoutMs applies retroactively to Tasks with no per-task timeoutMs.
  await sleep(10);
  const result2 = await checkTaskTimeouts({ defaultTimeoutMs: 5 });
  assert(result2.timedOut.includes(untimed.id), "a sweep-wide defaultTimeoutMs catches a Task with no per-task timeoutMs");

  // Re-running the sweep on an already-terminal Task is a no-op (it's no
  // longer 'running', so it's not even a candidate).
  const result3 = await checkTaskTimeouts();
  assert(!result3.timedOut.includes(shortLived.id), "an already timed_out Task is never re-processed by a later sweep");

  // The sweep itself is auditable: task.timeout.checked events exist.
  const events = await readStream("tasks");
  const checkedEvents = events.filter((e) => e.type === "task.timeout.checked");
  assert(checkedEvents.length >= 2, `at least 2 task.timeout.checked audit events were appended (got ${checkedEvents.length})`);
}

async function testLostDetection(): Promise<void> {
  console.log("\n-- 2. 'lost' detection (reconciliation sweep) --");
  const agentId = "lifecycle-test-agent";

  // Task A: started running in "this process" and never finished — this
  // is the orphan we expect reconciliation to catch after a "restart".
  const orphan = await createTask({ type: "cli", agentId, input: {} });
  await transitionTask(orphan.id, "running");

  // Task B: also running, but we'll leave the process registry intact for
  // it — reconciliation must NOT falsely mark a genuinely-live Task lost.
  const stillAlive = await createTask({ type: "cli", agentId, input: {} });
  await transitionTask(stillAlive.id, "running");

  // Sanity: reconciling BEFORE any restart finds nothing lost — both
  // Tasks are registered live in this process's liveTaskIds.
  const before = await reconcileLostTasks();
  assert(!before.lost.includes(orphan.id) && !before.lost.includes(stillAlive.id), "reconciling with an intact live registry finds nothing lost");

  // Simulate this process crashing and a fresh process starting up: the
  // in-memory liveTaskIds registry is wiped, exactly like a real restart.
  simulateProcessRestart();

  // The fresh process picks stillAlive back up and marks it running again
  // (its own transitionTask() call re-registers it as live) BEFORE
  // running reconciliation — modeling "we resumed ownership of this one".
  await transitionTask(stillAlive.id, "running");

  const after = await reconcileLostTasks();
  assert(after.lost.includes(orphan.id), "reconciliation marks the orphaned Task (never re-registered) as lost");
  assert(!after.lost.includes(stillAlive.id), "reconciliation does NOT mark the re-registered-as-live Task lost");

  const orphanTask = await getTask(orphan.id);
  const aliveTask = await getTask(stillAlive.id);
  assert(orphanTask?.status === "lost", `orphaned Task's projected status is "lost" (got "${orphanTask?.status}")`);
  assert(aliveTask?.status === "running", `re-registered Task's status remains "running" (got "${aliveTask?.status}")`);

  const events = await readStream("tasks");
  const sweptEvents = events.filter((e) => e.type === "task.reconciliation.swept");
  assert(sweptEvents.length >= 2, `task.reconciliation.swept audit events were appended (got ${sweptEvents.length})`);
}

async function testNotifyPolicy(): Promise<void> {
  console.log("\n-- 3. notifyPolicy wiring (immediate / digest / silent) --");
  const agentId = "lifecycle-test-agent";

  // 'immediate' — fires per-task, synchronously, on the real event bus.
  const immediateEvents: unknown[] = [];
  const unsubImmediate = subscribeToEvent("task.notification", (_type, payload) => {
    immediateEvents.push(payload);
  });
  const immediateTask = await createTask({ type: "cli", agentId, input: {}, notifyPolicy: "immediate" });
  await transitionTask(immediateTask.id, "running");
  await transitionTask(immediateTask.id, "succeeded");
  unsubImmediate();
  assert(immediateEvents.length === 2, `'immediate' policy published one bus event PER status change (got ${immediateEvents.length}, expected 2)`);

  const immediateAudit = (await readStream("tasks")).filter(
    (e) => e.type === "task.notification.sent" && (e.payload as any).taskId === immediateTask.id,
  );
  assert(immediateAudit.length === 2 && immediateAudit.every((e) => (e.payload as any).batched === false), "'immediate' policy audits each notification individually (batched: false)");

  // 'digest' — queued, not published until flushDigest() drains it.
  const digestEvents: unknown[] = [];
  const unsubDigest = subscribeToEvent("task.notification.digest", (_type, payload) => {
    digestEvents.push(payload);
  });
  const digestTaskA = await createTask({ type: "cli", agentId, input: {}, notifyPolicy: "digest" });
  const digestTaskB = await createTask({ type: "cli", agentId, input: {}, notifyPolicy: "digest" });
  await transitionTask(digestTaskA.id, "running");
  await transitionTask(digestTaskB.id, "running");
  assert(digestEvents.length === 0, "'digest' policy publishes NOTHING on the bus before flushDigest()");
  const queued = peekDigestQueue();
  assert(
    queued.some((q) => q.taskId === digestTaskA.id) && queued.some((q) => q.taskId === digestTaskB.id),
    "'digest' policy queues both Tasks' status changes in-memory pending flush",
  );

  await transitionTask(digestTaskA.id, "succeeded");
  await transitionTask(digestTaskB.id, "succeeded");
  const flushResult = await flushDigest();
  unsubDigest();
  assert(flushResult !== null && flushResult.count === queued.length + 2, `flushDigest() drains the FULL accumulated batch in one shot (count=${flushResult?.count})`);
  assert(digestEvents.length === 1, `flushDigest() publishes exactly ONE batched bus event regardless of queue size (got ${digestEvents.length})`);
  assert(peekDigestQueue().length === 0, "the digest queue is empty again after flushing");
  const secondFlush = await flushDigest();
  assert(secondFlush === null, "flushing an already-empty digest queue is a safe no-op (returns null, publishes nothing)");

  const digestAudit = (await readStream("tasks")).filter((e) => e.type === "task.notification.sent" && (e.payload as any).batched === true);
  assert(digestAudit.length >= 1, "'digest' policy's flush is itself audited as a single batched task.notification.sent event");

  // 'silent' — suppressed entirely: no bus publish, but the suppression itself is audited.
  const silentImmediateEvents: unknown[] = [];
  const unsubSilent = subscribeToEvent("task.notification", (_type, payload) => {
    silentImmediateEvents.push(payload);
  });
  const silentTask = await createTask({ type: "cli", agentId, input: {}, notifyPolicy: "silent" });
  await transitionTask(silentTask.id, "running");
  await transitionTask(silentTask.id, "succeeded");
  unsubSilent();
  assert(silentImmediateEvents.length === 0, "'silent' policy publishes NOTHING on the event bus, ever");

  const silentAudit = (await readStream("tasks")).filter(
    (e) => e.type === "task.notification.suppressed" && (e.payload as any).taskId === silentTask.id,
  );
  assert(silentAudit.length === 2, `'silent' policy still records an audit trail of what was suppressed (got ${silentAudit.length}, expected 2)`);
}

async function testMirroredFlow(): Promise<void> {
  console.log("\n-- 4. Flow.kind:'mirrored' vs 'managed' --");
  const agentId = "lifecycle-test-agent";

  // Contrast case: 'managed' still requires explicit updateFlowStep() calls.
  const managed = await createFlow("managed", [{ id: "only-step", dependsOn: [] }]);
  assert(managed.kind === "managed" && managed.steps[0]?.status === "queued", "a fresh 'managed' Flow's step starts 'queued' and is NOT auto-advanced");

  // 'mirrored' — created via createMirroredFlow(), wrapping exactly one Task.
  const { flow: mirrored, task: wrapped } = await createMirroredFlow({
    type: "cli",
    agentId,
    input: { note: "mirrored flow test" },
  });
  assert(mirrored.kind === "mirrored", `created Flow has kind "mirrored" (got "${mirrored.kind}")`);
  assert(mirrored.steps.length === 1, `a mirrored Flow has EXACTLY one FlowStep (got ${mirrored.steps.length})`);
  assert(mirrored.steps[0]?.taskId === wrapped.id, "the single step is bound to the wrapped Task's id from creation");
  assert(wrapped.flowId === mirrored.id, "the wrapped Task's own flowId points back at the mirrored Flow");

  // Drive the wrapped Task's lifecycle directly — the Flow must follow
  // automatically, with ZERO direct updateFlowStep() calls from us.
  await transitionTask(wrapped.id, "running");
  const runningFlow = await getFlow(mirrored.id);
  assert(runningFlow?.steps[0]?.status === "running", `mirrored Flow's step mirrors the Task's "running" status automatically (got "${runningFlow?.steps[0]?.status}")`);
  assert(runningFlow?.status === "running", "mirrored Flow's overall status is still 'running' while its one Task runs");

  await transitionTask(wrapped.id, "succeeded", { output: { ok: true } });
  const doneFlow = await getFlow(mirrored.id);
  assert(doneFlow?.steps[0]?.status === "succeeded", `mirrored Flow's step auto-advances to "succeeded" when the Task succeeds (got "${doneFlow?.steps[0]?.status}")`);
  assert(doneFlow?.status === "succeeded", `mirrored Flow's overall status becomes "succeeded" purely from the Task lifecycle (got "${doneFlow?.status}")`);
  assert((doneFlow?.revision ?? 0) > (mirrored.revision ?? 0), "mirroring bumps the Flow's revision counter just like a direct updateFlowStep() call would");

  // A second mirrored Flow whose wrapped Task fails/times out should
  // reflect that as the Flow's own 'failed' status too (timed_out/lost
  // count as failure at the Flow level — Flow has no such status of its own).
  const { flow: mirroredFail, task: wrappedFail } = await createMirroredFlow({
    type: "cli",
    agentId,
    input: {},
    timeoutMs: 10,
  });
  await transitionTask(wrappedFail.id, "running");
  await sleep(30);
  const sweep = await checkTaskTimeouts();
  assert(sweep.timedOut.includes(wrappedFail.id), "the mirrored Flow's wrapped Task itself times out via the normal sweep");
  const failedFlow = await getFlow(mirroredFail.id);
  assert(failedFlow?.steps[0]?.status === "timed_out", `mirrored Flow's step reflects the Task's "timed_out" status (got "${failedFlow?.steps[0]?.status}")`);
  assert(failedFlow?.status === "failed", `mirrored Flow's overall status is "failed" when its wrapped Task times out (got "${failedFlow?.status}")`);

  // Confirm the contrast holds: the earlier 'managed' Flow was NOT
  // touched by any of this Task-driven propagation.
  const managedStill = await getFlow(managed.id);
  assert(managedStill?.steps[0]?.status === "queued", "a 'managed' Flow is never auto-advanced by Task transitions — still 'queued'");
}

async function main(): Promise<void> {
  await testTimeoutEnforcement();
  await testLostDetection();
  await testNotifyPolicy();
  await testMirroredFlow();

  if (process.exitCode === 1) {
    console.error("\nSome task-lifecycle tests FAILED.");
    process.exit(1);
  } else {
    console.log("\nAll task-lifecycle tests passed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
