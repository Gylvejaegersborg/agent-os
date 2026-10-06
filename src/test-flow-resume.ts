// Tests that Resume works on a flow that stopped.
//   1. A flow where a step ran out of tool steps is "failed" and its dependents cancelled. Resume reopens it: the
//      failed step and its dependents run again, the steps that already succeeded are NOT run again.
//   2. The retried step is told an earlier attempt existed (so it checks BaseSpace instead of adding everything twice).
//   3. A cancelled flow stays cancelled for the library (driving it does nothing), but the operator's Resume
//      (reopenFlow with includeCancelled) reopens it.
//   4. A flow that already succeeded is left alone.
// Run with: node dist/test-flow-resume.js

import "./test-helpers/isolate.js";
import { buildFlowReport, cancelFlow, createFlow, createStubWorker, getFlow, reopenFlow, resumeFlow, runFlow, seedDefaultAgents, type ModelAdapter, type ModelResponse } from "./core/index.js";

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`ok: ${msg}`);
  else {
    failed = true;
    console.log(`FAIL: ${msg}`);
  }
}

await seedDefaultAgents();
let busy = true;
const goals: string[] = [];
const model: ModelAdapter = {
  id: "scripted",
  async complete(messages): Promise<ModelResponse> {
    const first = messages.find((m) => m.role === "user")?.content ?? "";
    goals.push(first);
    if (busy && first.startsWith("BUSY")) return { content: "", toolCall: { name: "basespace", args: { section: "summary" } } };
    return { content: `done: ${first.slice(0, 20)}` };
  },
};
const steps = [
  { id: "a", agentId: "aether", goal: "A: plain step" },
  { id: "b", agentId: "nyx", goal: "BUSY: many tool calls", dependsOn: ["a"] },
  { id: "c", agentId: "hermes", goal: "C: after b", dependsOn: ["b"] },
];
const opts = { model, worker: createStubWorker(), enableBaseSpace: true, maxToolHopsPerStep: 2 };

const first = await runFlow(steps, opts);
const flowId = first.flowId;
const st = async () => new Map((await getFlow(flowId))!.steps.map((s) => [s.id, s.status]));
let by = await st();
assert((await getFlow(flowId))!.status === "failed" && by.get("a") === "succeeded" && by.get("b") === "failed" && by.get("c") === "cancelled", "b ran out of tool steps: the flow failed, c was cancelled, a succeeded");

busy = false;
goals.length = 0;
const resumed = await resumeFlow(flowId, steps, opts);
by = await st();
assert(resumed.status === "succeeded" && (await getFlow(flowId))!.status === "succeeded" && [...by.values()].every((v) => v === "succeeded"), "Resume reopened the flow and every step now succeeded");
assert(!goals.some((g) => g.startsWith("A:")) && goals.some((g) => g.startsWith("BUSY")) && goals.some((g) => g.startsWith("C:")), "the finished step wasn't run again; the failed one and its dependent were");
assert(goals.find((g) => g.startsWith("BUSY"))!.includes("an earlier attempt at this step was stopped"), "the retried step is told an earlier attempt existed");
assert(!goals.find((g) => g.startsWith("C:"))!.includes("earlier attempt"), "…a step that never ran before is not");

// a finished flow is left alone
goals.length = 0;
await resumeFlow(flowId, steps, opts);
assert(goals.length === 0 && (await getFlow(flowId))!.status === "succeeded", "resuming a flow that succeeded does nothing");

// cancelled
const cf = await createFlow("managed", [{ id: "a", dependsOn: [] }]);
await cancelFlow(cf.id, "test");
goals.length = 0;
await resumeFlow(cf.id, [{ id: "a", agentId: "aether", goal: "A: plain step" }], opts);
assert((await getFlow(cf.id))!.status === "cancelled" && goals.length === 0, "driving a cancelled flow from the library leaves it cancelled");
await reopenFlow(cf.id, { includeCancelled: true });
await resumeFlow(cf.id, [{ id: "a", agentId: "aether", goal: "A: plain step" }], opts);
assert((await getFlow(cf.id))!.status === "succeeded" && goals.length === 1, "the operator's Resume reopens a cancelled flow and it runs");

// the report: one place for the whole flow
const report = (await buildFlowReport(flowId))!;
const rb = report.steps.find((x) => x.id === "b")!;
assert(report.status === "succeeded" && report.steps.length === 3 && rb.attempts.length === 2, "the report lists every step, with both attempts of the one that was retried");
assert(rb.attempts[0]!.status === "failed" && /tool steps/.test(rb.attempts[0]!.error ?? "") && rb.attempts[0]!.toolCalls.length >= 1 && rb.attempts[1]!.status === "succeeded" && /done/.test(rb.attempts[1]!.result ?? ""), "the failed attempt keeps its reason and tool calls; the retry keeps its result");
assert(rb.agentId === "nyx" && report.totals.toolCalls >= 1 && (await buildFlowReport("nope")) === undefined, "agent and totals are filled in; an unknown flow has no report");

console.log(failed ? "\nSome flow-resume tests FAILED." : "\nAll flow-resume tests passed.");
process.exit(failed ? 1 : 0);
