// Tests that Resume works on a flow that stopped.
//   1. A flow where a step ran out of tool steps is "failed" and its dependents cancelled. Resume reopens it: the
//      failed step and its dependents run again, the steps that already succeeded are NOT run again.
//   2. The retried step is told an earlier attempt existed (so it checks BaseSpace instead of adding everything twice).
//   3. A cancelled flow stays cancelled for the library (driving it does nothing), but the operator's Resume
//      (reopenFlow with includeCancelled) reopens it.
//   4. A flow that already succeeded is left alone.
// Run with: node dist/test-flow-resume.js

import "./test-helpers/isolate.js";
import { addOverlayItem, markStepDone, flowStepExecutions, storeFlowDefinition, buildFlowReport, createArtifact, recordFileRevision, subscribeToEvent, cancelFlow, createFlow, createStubWorker, getFlow, reopenFlow, resumeFlow, runFlow, seedDefaultAgents, type ModelAdapter, type ModelResponse } from "./core/index.js";

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

// Argus' verdict: no verifier step yet, then waiting (an earlier step failed), then his words once he has run
assert(report.verdict.agentId === "argus" && report.verdict.status === "not-run", "a flow with no Argus step says he has not been asked");
busy = true;
const vsteps = [
  { id: "work", agentId: "nyx", goal: "BUSY: work" },
  { id: "check", agentId: "argus", goal: "V: verify the work", dependsOn: ["work"] },
];
const vf = await runFlow(vsteps, opts);
await storeFlowDefinition({ flowId: vf.flowId, proposedBy: "hemera", summary: "verify", steps: vsteps });
const waiting = (await buildFlowReport(vf.flowId))!.verdict;
assert(waiting.status === "waiting" && waiting.stepId === "check", "when the step before him failed, his check is waiting, not done");
busy = false;
await resumeFlow(vf.flowId, vsteps, opts);
const done = (await buildFlowReport(vf.flowId))!.verdict;
assert(done.status === "done" && /done: V:/.test(done.text ?? ""), "after Resume his check runs and the report carries what he said");

// live updates: artifacts and file revisions announce themselves so open panels refresh
const seen: string[] = [];
const off = [subscribeToEvent("artifact.created", () => { seen.push("artifact"); }), subscribeToEvent("file.revision.recorded", () => { seen.push("file"); })];
await createArtifact({ type: "report", location: "x", producer: "nyx" } as any);
await recordFileRevision({ path: "a.txt", previousContent: "", existedBefore: false, tool: "write_file" } as any);
off.forEach((d) => d());
assert(seen.includes("artifact") && seen.includes("file"), "creating an artifact and recording a file revision each publish an event");

// the operator accepts a stopped step as done; the flow carries on without re-running it
busy = true;
const ds = [
  { id: "list", agentId: "nyx", goal: "BUSY: write the list", dependsOn: [] as string[] },
  { id: "verify", agentId: "argus", goal: "V: check the list", dependsOn: ["list"] },
];
const df = await runFlow(ds, opts);
assert((await getFlow(df.flowId))!.status === "failed", "a step that ran out of tool steps stops the flow");
goals.length = 0;
busy = false;
await markStepDone(df.flowId, "list", ds, opts);
const after = (await getFlow(df.flowId))!;
assert(after.status === "succeeded" && after.steps.find((x) => x.id === "list")!.status === "succeeded" && goals.every((g) => !g.startsWith("BUSY")) && goals.some((g) => g.startsWith("V:")), "marking the step done runs the next step and does not run the accepted one again");
assert(await markStepDone(df.flowId, "list", ds, opts).then(() => false, () => true), "a step that already succeeded can not be marked done");

// a flow step gets a bigger execution cap than a chat turn (25 vs 8)
assert(flowStepExecutions() === 25, "a flow step's default cap is 25 tool executions");

// several stopped steps accepted at once: none of them runs again, and the step waiting on them does
busy = true;
const ms = [
  { id: "p", agentId: "nyx", goal: "BUSY: p", dependsOn: [] as string[] },
  { id: "q", agentId: "aether", goal: "BUSY: q", dependsOn: [] as string[] },
  { id: "r", agentId: "hermes", goal: "R: fine", dependsOn: [] as string[] },
  { id: "check", agentId: "argus", goal: "V: recheck", dependsOn: ["p", "q", "r"] },
];
const mf = await runFlow(ms, opts);
const mst = new Map((await getFlow(mf.flowId))!.steps.map((x) => [x.id, x.status]));
assert(mst.get("p") === "failed" && mst.get("q") === "failed" && mst.get("r") === "succeeded" && mst.get("check") === "cancelled", "two steps stopped, one finished, the check was cancelled");
goals.length = 0;
busy = false;
await markStepDone(mf.flowId, ["p", "q"], ms, opts);
assert((await getFlow(mf.flowId))!.status === "succeeded" && goals.length === 1 && goals[0]!.startsWith("V:"), "accepting both runs only the check (the accepted steps and the finished one are not run again)");
busy = true;
const mf2 = await runFlow(ms, opts);
assert(await markStepDone(mf2.flowId, ["p", "nope"], ms, opts).then(() => false, () => true) && (await getFlow(mf2.flowId))!.status === "failed", "one unknown step in the list changes nothing");

// the outcome: what each agent did, and what is left
await storeFlowDefinition({ flowId: mf2.flowId, proposedBy: "hemera", summary: "m", steps: ms });
const oc = (await buildFlowReport(mf2.flowId))!.outcome;
assert(/1 of 4 steps done/.test(oc.headline) && oc.byAgent.map((a) => a.agentId).sort().join() === "aether,argus,hermes,nyx", "the outcome says how many steps are done and lists every agent");
assert(oc.toDo.some((t) => /Step "p" \(nyx\) stopped/.test(t.text) && /tool steps/.test(t.detail ?? "")) && oc.toDo.some((t) => /Step "check" \(argus\) did not run/.test(t.text)), "what is left: the stopped steps with the reason, and the step that never ran");
assert(oc.toDo.some((t) => t.kind === "review" && /waiting/.test(t.text)), "…and that the verifier is still waiting");
const oFlow = await runFlow([{ id: "w", agentId: "hermes", goal: "WRITE: note and todo" }], { model: { id: "w", async complete(msgs): Promise<ModelResponse> { return msgs[msgs.length - 1]!.role === "tool" ? { content: "wrote them" } : { content: "", toolCalls: [{ name: "basespace-add", args: { kind: "note", title: "Outcome note", body: "x" } }, { name: "basespace-add", args: { kind: "todo", title: "Outcome todo" } }], toolCall: { name: "basespace-add", args: { kind: "note", title: "Outcome note", body: "x" } } }; } }, worker: createStubWorker(), enableBaseSpace: true, maxToolHopsPerStep: 4 });
const ow = (await buildFlowReport(oFlow.flowId))!.outcome.byAgent.find((a) => a.agentId === "hermes")!;
assert(ow.notes.some((n) => n.title === "Outcome note") && ow.todos.some((t) => t.title === "Outcome todo" && t.open) && (await buildFlowReport(oFlow.flowId))!.outcome.toDo.some((t) => t.kind === "todo" && t.text === "Outcome todo"), "notes and todos an agent wrote are listed, and an open todo is something still to do");
const { removeOverlayItem } = await import("./core/index.js");
const todoId = (await (await import("./core/index.js")).loadOverlay()).tasks.find((t) => t.title === "Outcome todo")!.id as string;
await removeOverlayItem("todo", todoId);
assert(!(await buildFlowReport(oFlow.flowId))!.outcome.toDo.some((t) => t.text === "Outcome todo"), "a todo deleted since is no longer listed");

console.log(failed ? "\nSome flow-resume tests FAILED." : "\nAll flow-resume tests passed.");
process.exit(failed ? 1 : 0);
