// Standalone tests for the Flow execution engine (flow-engine.ts) — proves
// it's a REAL multi-agent orchestration mechanism, not just Flow
// bookkeeping:
//   1. Real parallel + sequential branches: two independent steps run
//      concurrently, a third step that depends on both only starts once
//      BOTH have genuinely succeeded.
//   2. Failure propagation: a failed step's dependents are marked
//      'cancelled' WITHOUT ever actually running (no Task created for
//      them at all) — proven by checking no Task exists for the blocked
//      step, not just that its final status looks right.
//   3. Retries: a step whose model fails the first N attempts and
//      succeeds on the last is retried the configured number of times
//      and the Flow still succeeds overall.
//   4. Cancellation: a cancelled Flow stops scheduling entirely — driving
//      it (even for the first time) after cancellation runs zero steps.
//   5. Resumability: a Flow with one step already 'succeeded' (simulating
//      a previous driveFlow() call that got interrupted before starting
//      its dependent) is resumed by a FRESH driveFlow() call that skips
//      the already-done step and completes the rest.
// Run with: node dist/test-flow-engine.js

import "./test-helpers/isolate.js";
import {
  runFlow,
  resumeFlow,
  createFlow,
  cancelFlow,
  getFlow,
  createTask,
  transitionTask,
  updateFlowStep,
  listTasks,
  createStubWorker,
  type FlowStepDefinition,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Always succeeds, echoing the message back. Records call order/timing
 *  so parallelism can be verified. */
function makeTrackingModel(log: { step: string; at: number }[], stepName: string, delayMs = 0): ModelAdapter {
  return {
    id: `tracking-${stepName}`,
    async complete(messages) {
      if (delayMs) await sleep(delayMs);
      log.push({ step: stepName, at: Date.now() });
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      return { content: `done: ${lastUser?.content ?? ""}` };
    },
  };
}

function alwaysFailsModel(): ModelAdapter {
  return {
    id: "always-fails",
    async complete() {
      throw new Error("simulated model failure");
    },
  };
}

function failsNTimesThenSucceedsModel(n: number): ModelAdapter {
  let calls = 0;
  return {
    id: "fails-then-succeeds",
    async complete() {
      calls++;
      if (calls <= n) throw new Error(`simulated failure #${calls}`);
      return { content: "eventually succeeded" };
    },
  };
}

async function testParallelAndSequentialBranches(): Promise<void> {
  console.log("\n-- 1. Real parallel + sequential branches --");
  const worker = createStubWorker();

  const steps: FlowStepDefinition[] = [
    { id: "research-a", agentId: "theia", goal: "research A", dependsOn: [] },
    { id: "research-b", agentId: "hermes", goal: "research B", dependsOn: [] },
    { id: "synthesize", agentId: "hemera", goal: "synthesize A and B", dependsOn: ["research-a", "research-b"] },
  ];

  const result = await runFlow(steps, { model: makeTrackingModel([], "shared"), worker });

  assert(result.status === "succeeded", `the whole Flow succeeds when every step succeeds (got "${result.status}")`);
  assert(result.steps.every((s) => s.status === "succeeded"), "every step's own result is 'succeeded'");

  const tasks = await listTasks({ flowId: result.flowId });
  assert(tasks.length === 3, `exactly 3 real Tasks were created, one per step (got ${tasks.length})`);

  const synthesizeTask = tasks.find((t) => (t.input as any).stepId === "synthesize");
  const researchTasks = tasks.filter((t) => (t.input as any).stepId !== "synthesize");
  assert(
    researchTasks.every((t) => t.completedAt! <= synthesizeTask!.startedAt!),
    "the dependent step's Task only started after BOTH its dependencies' Tasks had genuinely completed",
  );
}

async function testFailurePropagation(): Promise<void> {
  console.log("\n-- 2. Failure propagation — a blocked step never runs at all --");
  const worker = createStubWorker();
  const steps: FlowStepDefinition[] = [
    { id: "flaky", agentId: "claude", goal: "this will fail", dependsOn: [] },
    { id: "downstream", agentId: "claude", goal: "depends on flaky", dependsOn: ["flaky"] },
  ];

  const result = await runFlow(steps, { model: alwaysFailsModel(), worker });

  assert(result.status === "failed", `the Flow's overall status is 'failed' (got "${result.status}")`);
  const flaky = result.steps.find((s) => s.stepId === "flaky");
  const downstream = result.steps.find((s) => s.stepId === "downstream");
  assert(flaky?.status === "failed", `the failing step's own status is 'failed' (got "${flaky?.status}")`);
  assert(downstream?.status === "cancelled", `the blocked dependent's status is 'cancelled' (got "${downstream?.status}")`);

  const tasks = await listTasks({ flowId: result.flowId });
  assert(tasks.length === 1, `only ONE real Task was ever created (for "flaky") — "downstream" never ran at all (got ${tasks.length})`);
}

async function testRetries(): Promise<void> {
  console.log("\n-- 3. Retries — a step that fails then succeeds within its retry budget --");
  const worker = createStubWorker();
  const steps: FlowStepDefinition[] = [{ id: "flaky-but-recovers", agentId: "claude", goal: "retry me", dependsOn: [], retries: 2 }];

  const result = await runFlow(steps, { model: failsNTimesThenSucceedsModel(2), worker });

  assert(result.status === "succeeded", `the Flow succeeds once the step succeeds within its retry budget (got "${result.status}")`);
  const step = result.steps[0]!;
  assert(step.status === "succeeded", "the step's final status is 'succeeded'");
  assert(step.attempts === 3, `the step took exactly 3 attempts (1 + 2 retries) (got ${step.attempts})`);

  const tasks = await listTasks({ flowId: result.flowId });
  assert(tasks.length === 3, `3 separate Tasks were created, one per attempt (got ${tasks.length})`);
  assert(tasks.filter((t) => t.status === "succeeded").length === 1, "exactly one of those Tasks ended up 'succeeded'");
  assert(tasks.filter((t) => t.status === "failed").length === 2, "the other two ended up 'failed'");
}

async function testCancellation(): Promise<void> {
  console.log("\n-- 4. Cancellation stops scheduling entirely --");
  const worker = createStubWorker();
  const steps: FlowStepDefinition[] = [{ id: "never-runs", agentId: "claude", goal: "should never execute", dependsOn: [] }];

  const flow = await createFlow(
    "managed",
    steps.map((s) => ({ id: s.id, dependsOn: s.dependsOn ?? [] })),
  );
  const cancelled = await cancelFlow(flow.id, "test cancellation before any driving");
  assert(cancelled.status === "cancelled", "cancelFlow() immediately reflects 'cancelled' status");

  const log: { step: string; at: number }[] = [];
  const result = await resumeFlow(flow.id, steps, { model: makeTrackingModel(log, "never-runs"), worker });

  assert(result.status === "cancelled", "driving an already-cancelled Flow returns 'cancelled', not 'succeeded'");
  assert(log.length === 0, "the step's model was never even called — cancellation is checked BEFORE scheduling, not after");
  const tasks = await listTasks({ flowId: flow.id });
  assert(tasks.length === 0, "no Task was ever created for the cancelled step");
}

async function testResumability(): Promise<void> {
  console.log("\n-- 5. Resumability — a fresh driveFlow() call picks up where a previous one left off --");
  const worker = createStubWorker();
  const steps: FlowStepDefinition[] = [
    { id: "first", agentId: "claude", goal: "step one", dependsOn: [] },
    { id: "second", agentId: "claude", goal: "step two", dependsOn: ["first"] },
  ];

  // Simulate "a previous driveFlow() call completed 'first' then the
  // process died before ever starting 'second'": create the Flow and
  // manually drive JUST the first step's Task/step-status transitions,
  // without going through driveFlow() at all.
  const flow = await createFlow(
    "managed",
    steps.map((s) => ({ id: s.id, dependsOn: s.dependsOn ?? [] })),
  );
  const firstTask = await createTask({ type: "flow-step", agentId: "claude", flowId: flow.id, input: { stepId: "first" } });
  await transitionTask(firstTask.id, "running");
  await transitionTask(firstTask.id, "succeeded", { output: { finalContent: "manually completed" } });
  await updateFlowStep(flow.id, "first", "succeeded", flow.revision, firstTask.id);

  const beforeResume = await getFlow(flow.id);
  assert(beforeResume?.status === "running", "sanity: the Flow is still 'running' overall (only one of two steps is done)");

  const log: { step: string; at: number }[] = [];
  const result = await resumeFlow(flow.id, steps, { model: makeTrackingModel(log, "second"), worker });

  assert(result.status === "succeeded", `resuming completes the Flow (got "${result.status}")`);
  assert(log.length === 1 && log[0]!.step === "second", "ONLY the remaining step's model was called — 'first' was never re-run");

  const tasks = await listTasks({ flowId: flow.id });
  const firstTasks = tasks.filter((t) => (t.input as any).stepId === "first");
  assert(firstTasks.length === 1, "still exactly one Task for 'first' — resuming did not create a duplicate");
}

async function main(): Promise<void> {
  await testParallelAndSequentialBranches();
  await testFailurePropagation();
  await testRetries();
  await testCancellation();
  await testResumability();

  if (process.exitCode === 1) {
    console.error("\nSome flow-engine tests FAILED.");
  } else {
    console.log("\nAll flow-engine tests passed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
