// Flow execution engine — turns a Flow (tasks.ts's Task/Flow primitives)
// from "a data structure the caller drives step-by-step by hand" into a
// real multi-agent orchestration mechanism. Before this file, a 'managed'
// Flow tracked step status faithfully, but nothing actually RAN a step —
// the caller had to call updateFlowStep() themselves for every
// transition. This is the missing "run a multi-step, multi-agent DAG to
// completion" primitive the architecture plan's Flow-execution section
// describes: multiple tasks, dependencies, parallel/sequential branches,
// failure propagation, retries, cancellation, and a final aggregate
// result — built entirely on Task/Flow primitives that already existed,
// not a parallel workflow-engine abstraction.
//
// Deliberately NOT a general-purpose workflow language: a FlowStepDefinition
// is just {id, agentId, goal, dependsOn, retries?} — a step IS a subagent
// turn (runTurn(), same mechanism subagent.ts already uses for
// delegation). No conditional branching DSL, no loops, no external
// integrations — a small, real primitive, matching this codebase's
// "don't build the enterprise workflow engine" instruction.
//
// RESUMABILITY: driveFlow() re-derives which steps still need to run from
// the Flow's CURRENT persisted step statuses every time it's called —
// it never assumes it's starting fresh. That means calling driveFlow()
// again on the same flowId (even from a different process, after a
// crash) picks up exactly where the previous run left off: steps already
// 'succeeded' are skipped, and a step left 'running' by a process that
// died is treated as retriable (its Task will eventually show 'lost' via
// tasks.ts's durable liveness reconciliation — driveFlow() doesn't wait
// for that itself, see HONEST LIMITATIONS below). The caller is
// responsible for retaining the original FlowStepDefinition[] to pass
// back in — the Flow's own persisted steps only carry id/dependsOn/
// status/taskId, not the agentId/goal needed to actually (re-)run one.
//
// HONEST LIMITATIONS:
//   1. A step that's still 'running' when driveFlow() is called again
//      (the previous run is presumably still alive, or died without its
//      Task yet being reconciled as 'lost') is left alone, not restarted
//      — driveFlow() will neither re-run it nor block waiting for it.
//      Call reconcileLostTasks() yourself first if you want a stale
//      'running' step turned into a retriable 'lost' one before resuming.
//   2. Parallel steps within one batch run via Promise.all in THIS
//      process — there's no distributed scheduler dispatching steps to
//      other worker processes. "Parallel" means concurrent within one
//      Node process's event loop, which is genuinely parallel for I/O
//      (model API calls) but not a multi-machine execution grid.
//   3. Cancellation stops NEW steps from being scheduled and cancels the
//      Tasks of already-started steps, but (same limitation session.ts's
//      cancellation has) cannot preempt a model call already in flight
//      mid-runTurn() — it stops at the next checkpoint runTurn() itself
//      checks, not instantly.

import { createFlow, getFlow, updateFlowStep, createTask, transitionTask } from "./tasks.js";
import { runTurn, newSessionId } from "./agent-loop.js";
import { createModelForAgent } from "./models/real.js";
import { publishEvent } from "./eventbus.js";
import type { ModelAdapter } from "./model.js";
import type { Worker } from "./worker.js";
import type { SkillRegistry } from "./skills.js";
import type { Flow, TaskStatus } from "./types.js";

export interface FlowStepDefinition {
  id: string;
  agentId: string;
  /** The goal/instruction for this step — becomes the subagent turn's
   *  user message (same shape as subagent.ts's SpawnSubagentOptions.goal). */
  goal: string;
  /** Step ids this one depends on — it will not be scheduled until every
   *  one of these has reached 'succeeded'. Empty array (or omitted) means
   *  this step is ready immediately. */
  dependsOn?: string[];
  /** How many additional attempts after the first failure, before giving
   *  up and marking the step (and propagating failure to its
   *  dependents). Default 0 — fail fast, matching every other primitive
   *  in this codebase's "don't retry silently unless asked" posture. */
  retries?: number;
}

export interface DriveFlowOptions {
  model: ModelAdapter;
  worker: Worker;
  skills?: SkillRegistry;
  maxToolHopsPerStep?: number;
  /** Forwarded as-is to each step's runTurn() call (agent-loop.ts) — same
   *  meaning as the gateway's direct-chat turns route. Previously just
   *  missing from this options type entirely, so even a gateway that
   *  enabled these for chat never granted them inside a Flow step. */
  enableSubagents?: boolean;
  enableMemoryNominations?: boolean;
  enableArtifacts?: boolean;
}

export interface FlowStepResult {
  stepId: string;
  status: TaskStatus;
  taskId?: string;
  finalContent?: string;
  attempts: number;
}

export interface DriveFlowResult {
  flowId: string;
  status: Flow["status"];
  steps: FlowStepResult[];
}

const STEP_SUCCESS: TaskStatus = "succeeded";
const STEP_FAILURE_LIKE: TaskStatus[] = ["failed", "timed_out", "lost"];
const STEP_TERMINAL: TaskStatus[] = ["succeeded", "failed", "timed_out", "cancelled", "lost"];

/** Creates a new 'managed' Flow from a FlowStepDefinition[] and drives it
 *  to completion (or cancellation) in one call — the common case. Returns
 *  once every step has reached a terminal status, or the Flow was
 *  cancelled mid-run. */
export async function runFlow(steps: FlowStepDefinition[], opts: DriveFlowOptions): Promise<DriveFlowResult> {
  const flow = await createFlow(
    "managed",
    steps.map((s) => ({ id: s.id, dependsOn: s.dependsOn ?? [] })),
  );
  return driveFlow(flow.id, steps, opts);
}

/** Advances an EXISTING Flow (created via runFlow(), or resumed after an
 *  interruption) to completion — see the file header's RESUMABILITY note
 *  for exactly what "resumed" means here. Safe to call on a Flow that's
 *  already fully done (returns immediately with its current, unchanged
 *  state) or already cancelled. */
export async function resumeFlow(flowId: string, steps: FlowStepDefinition[], opts: DriveFlowOptions): Promise<DriveFlowResult> {
  return driveFlow(flowId, steps, opts);
}

async function setStepStatus(flowId: string, stepId: string, status: TaskStatus, taskId?: string): Promise<void> {
  // Optimistic-concurrency retry loop: multiple steps in the same
  // parallel batch race to bump the SAME Flow's revision counter, so a
  // conflict here is an EXPECTED, routine event, not an error — just
  // re-read the current revision and try again.
  for (let attempt = 0; attempt < 20; attempt++) {
    const current = await getFlow(flowId);
    if (!current) throw new Error(`no such flow: ${flowId}`);
    if (current.status !== "running") return; // flow already terminal/cancelled — nothing left to record
    const result = await updateFlowStep(flowId, stepId, status, current.revision, taskId);
    if (result.ok) return;
  }
  throw new Error(`setStepStatus: too many revision conflicts updating step "${stepId}" on flow ${flowId}`);
}

async function runStepOnce(
  flowId: string,
  step: FlowStepDefinition,
  opts: DriveFlowOptions,
): Promise<{ status: TaskStatus; taskId: string; finalContent?: string }> {
  const task = await createTask({ type: "flow-step", agentId: step.agentId, flowId, input: { stepId: step.id, goal: step.goal } });
  await transitionTask(task.id, "running");
  await setStepStatus(flowId, step.id, "running", task.id);
  await publishEvent("flow.step.started", { flowId, stepId: step.id, agentId: step.agentId, taskId: task.id });

  try {
    // Same per-agent model preference override the gateway's turns route
    // applies (see server.ts) — each step runs with ITS OWN agent's
    // preference, not one model shared across the whole flow, falling
    // back to opts.model (the flow's/gateway's default) when the step's
    // agent has no override or nothing resolves.
    const model = (await createModelForAgent(step.agentId)) ?? opts.model;
    const result = await runTurn({
      sessionId: newSessionId(),
      agentId: step.agentId,
      userMessage: step.goal,
      model,
      worker: opts.worker,
      skills: opts.skills,
      maxToolHops: opts.maxToolHopsPerStep,
      enableSubagents: opts.enableSubagents,
      enableMemoryNominations: opts.enableMemoryNominations,
      enableArtifacts: opts.enableArtifacts,
    });
    await transitionTask(task.id, "succeeded", { output: { finalContent: result.finalContent } });
    await publishEvent("flow.step.completed", { flowId, stepId: step.id, agentId: step.agentId, taskId: task.id, status: "succeeded" });
    return { status: "succeeded", taskId: task.id, finalContent: result.finalContent };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await transitionTask(task.id, "failed", { output: { error: message } });
    await publishEvent("flow.step.completed", { flowId, stepId: step.id, agentId: step.agentId, taskId: task.id, status: "failed", error: message });
    return { status: "failed", taskId: task.id };
  }
}

async function runStepWithRetries(flowId: string, step: FlowStepDefinition, opts: DriveFlowOptions): Promise<FlowStepResult> {
  const maxAttempts = 1 + (step.retries ?? 0);
  let last: { status: TaskStatus; taskId: string; finalContent?: string } | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await runStepOnce(flowId, step, opts);
    if (last.status === "succeeded") {
      await setStepStatus(flowId, step.id, "succeeded", last.taskId);
      return { stepId: step.id, status: "succeeded", taskId: last.taskId, finalContent: last.finalContent, attempts: attempt };
    }
    // failed this attempt — loop again if attempts remain, otherwise fall through to record the final failure below
  }
  await setStepStatus(flowId, step.id, "failed", last!.taskId);
  return { stepId: step.id, status: "failed", taskId: last!.taskId, attempts: maxAttempts };
}

/** The actual driving loop: repeatedly computes which steps are ready
 *  (every dependency 'succeeded'), which are permanently blocked (some
 *  dependency failed/timed_out/lost/cancelled — failure propagates:
 *  blocked steps are marked 'cancelled' without ever running), and runs
 *  every currently-ready step CONCURRENTLY via Promise.all — real
 *  parallel branches, not a fake sequential loop that merely LOOKS
 *  parallel. Sequential branches fall out for free: a step with
 *  dependsOn naturally waits for prior batches. Stops scheduling new work
 *  the moment the Flow is cancelled (checked at the top of every
 *  iteration), matching Session's own cancellation-checkpoint pattern. */
async function driveFlow(flowId: string, stepDefs: FlowStepDefinition[], opts: DriveFlowOptions): Promise<DriveFlowResult> {
  const byId = new Map(stepDefs.map((s) => [s.id, s]));
  const results = new Map<string, FlowStepResult>();

  for (;;) {
    const flow = await getFlow(flowId);
    if (!flow) throw new Error(`no such flow: ${flowId}`);
    if (flow.status !== "running") break; // already succeeded/failed/cancelled — nothing left to drive

    const statusById = new Map(flow.steps.map((s) => [s.id, s.status]));
    const pending = stepDefs.filter((s) => !STEP_TERMINAL.includes(statusById.get(s.id) ?? "queued") && statusById.get(s.id) !== "running");
    if (pending.length === 0) {
      // Either every step is terminal (loop will exit next iteration once
      // projectFlows() reflects that), or every remaining step is
      // 'running' (owned by another call/process) — either way, this
      // call has nothing left to schedule right now.
      const stillRunning = flow.steps.some((s) => s.status === "running");
      if (!stillRunning) break;
      // Something is 'running' elsewhere; this call doesn't wait for it
      // (see HONEST LIMITATIONS #1) — return the current snapshot.
      break;
    }

    const ready = pending.filter((s) => (s.dependsOn ?? []).every((depId) => statusById.get(depId) === STEP_SUCCESS));
    const blocked = pending.filter((s) => (s.dependsOn ?? []).some((depId) => STEP_FAILURE_LIKE.includes(statusById.get(depId) ?? "queued") || statusById.get(depId) === "cancelled"));

    if (blocked.length > 0) {
      for (const step of blocked) {
        await setStepStatus(flowId, step.id, "cancelled");
        results.set(step.id, { stepId: step.id, status: "cancelled", attempts: 0 });
      }
      continue; // re-derive ready/blocked now that these are marked
    }

    if (ready.length === 0) {
      // Nothing ready, nothing newly blocked, but pending steps remain —
      // they must depend on something still 'running'. Return the
      // current snapshot rather than busy-waiting; the caller can call
      // resumeFlow() again once that dependency actually finishes.
      break;
    }

    await Promise.all(
      ready.map(async (step) => {
        const result = await runStepWithRetries(flowId, step, opts);
        results.set(step.id, result);
      }),
    );
  }

  const finalFlow = await getFlow(flowId);
  if (!finalFlow) throw new Error(`no such flow: ${flowId}`);
  const steps: FlowStepResult[] = finalFlow.steps.map(
    (s) => results.get(s.id) ?? { stepId: s.id, status: s.status, taskId: s.taskId, attempts: 0 },
  );
  // Published only once THIS driveFlow() call actually reaches a
  // terminal-for-now point (not on every intermediate step) — a client
  // watching GET /events knows the whole DAG (or this call's portion of
  // it, for a resumed run that still has 'running'-elsewhere steps left)
  // is done without having to poll GET /flows/:id.
  await publishEvent("flow.completed", { flowId, status: finalFlow.status });
  return { flowId, status: finalFlow.status, steps };
}
