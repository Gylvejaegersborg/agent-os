// Regression tests for four flow bugs:
//   1. Cancel stops the work: the step's model call is aborted, its task stays cancelled (it used to be overwritten
//      with "succeeded" when the turn came back), no retry starts and the dependent step never runs.
//   2. A blocked step is not done: a step whose tool call went to Approvals fails "waiting on approval", and its
//      dependent doesn't run. Once the operator approves, the step finishes and the rest of the flow runs.
//   3. Restart recovery: a step whose task was lost (the gateway died mid-step) no longer stays "running" forever;
//      the flow ends failed and Resume runs that step again.
//   4. Approvals: "approve + always" on a request that was already rejected adds no allow rule; cancelling a flow
//      rejects the approvals its steps were waiting on. Resume pressed twice doesn't run a step twice.
// Run with: node dist/test-flow-fixes.js

import "./test-helpers/isolate.js";
import {
  cancelFlow,
  createFlow,
  createStubWorker,
  createTask,
  getFlow,
  getApproval,
  getTask,
  installPermissionPolicy,
  listFlows,
  listAllowRules,
  listApprovals,
  reconcileLostTasks,
  rejectRequest,
  requestApproval,
  resumeFlow,
  runFlow,
  seedDefaultAgents,
  storeFlowDefinition,
  transitionTask,
  updateFlowStep,
  type ModelAdapter,
  type ModelResponse,
} from "./core/index.js";
import { startGateway } from "./gateway/server.js";

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`ok: ${msg}`);
  else {
    failed = true;
    console.log(`FAIL: ${msg}`);
  }
}

async function waitFor(check: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

await seedDefaultAgents();

// What each model call was asked (the latest user message), and how many calls were aborted.
const asked: string[] = [];
let aborted = 0;
const model: ModelAdapter = {
  id: "scripted",
  async complete(messages, callOpts): Promise<ModelResponse> {
    const last = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    asked.push(last);
    if (last.startsWith("HANG")) {
      // Never answers on its own: only an abort ends it.
      return new Promise<ModelResponse>((_, reject) => {
        callOpts?.signal?.addEventListener("abort", () => {
          aborted++;
          reject(new Error("aborted"));
        });
      });
    }
    if (last.startsWith("SHELL")) return { content: "", toolCall: { name: "shell", args: { command: "echo hi" } } };
    return { content: `done: ${last.slice(0, 30)}` };
  },
};
const opts = { model, worker: createStubWorker() };

console.log("\n-- 1. cancel stops the step's work --");
{
  asked.length = 0;
  const steps = [
    { id: "a", agentId: "aether", goal: "HANG: works until stopped", retries: 2 },
    { id: "b", agentId: "nyx", goal: "B: after a", dependsOn: ["a"] },
  ];
  const run = runFlow(steps, opts);
  await waitFor(async () => asked.some((g) => g.startsWith("HANG")));
  const flowId = (await listFlows()).at(-1)!.id;
  const before = (await getFlow(flowId))!;
  const taskId = before.steps.find((s) => s.id === "a")!.taskId!;
  await cancelFlow(flowId, "test");
  const result = await Promise.race([run, new Promise<null>((r) => setTimeout(() => r(null), 5000))]);
  assert(result !== null, "the flow's driver returns after the cancel instead of waiting on the model");
  assert(aborted === 1, "the step's in-flight model call was aborted");
  assert((await getTask(taskId))!.status === "cancelled", "the step's task stays cancelled (not overwritten with succeeded)");
  const after = (await getFlow(flowId))!;
  assert(after.status === "cancelled" && after.steps.find((s) => s.id === "a")!.status !== "succeeded", "the flow is cancelled and step a is not recorded as succeeded");
  assert(asked.filter((g) => g.startsWith("HANG")).length === 1, "no retry was started after the cancel (retries: 2)");
  assert(!asked.some((g) => g.startsWith("B:")), "the dependent step never ran");
}

console.log("\n-- 2. a blocked step is not done; approving it carries the flow on --");
installPermissionPolicy({ agentId: "hermes", rules: [{ tool: "shell", decision: "ask" }] });
const gateway = await startGateway({ model, worker: createStubWorker() });
const base = `http://127.0.0.1:${gateway.port}`;
const post = (path: string, body: unknown) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
try {
  asked.length = 0;
  const steps = [
    { id: "a", agentId: "hermes", goal: "SHELL: needs a shell command" },
    { id: "b", agentId: "nyx", goal: "B: after the approved step", dependsOn: ["a"] },
  ];
  const created = (await (await post("/flows", { steps, title: "approval flow" })).json()) as { id: string };
  const flowId = created.id;
  const stopped = await waitFor(async () => (await getFlow(flowId))?.status !== "running");
  const flow = (await getFlow(flowId))!;
  const a = flow.steps.find((s) => s.id === "a")!;
  const aTask = (await getTask(a.taskId!))!;
  assert(stopped && flow.status === "failed" && a.status === "failed", "a step whose tool call went to Approvals is failed, not succeeded");
  assert(/waiting on approval/.test(String(aTask.output?.error)) && typeof aTask.output?.approvalId === "string", "…and says which approval it waits on");
  assert(!asked.some((g) => g.startsWith("B:")), "its dependent did not run");

  const approvalId = aTask.output!.approvalId as string;
  const res = await post(`/approvals/${approvalId}/approve`, {});
  assert(res.status === 200, "the operator approves it");
  const done = await waitFor(async () => (await getFlow(flowId))?.status === "succeeded");
  const finished = (await getFlow(flowId))!;
  assert(done && finished.steps.every((s) => s.status === "succeeded"), "after the approval the step finishes and the flow succeeds");
  assert(asked.some((g) => g.startsWith("B:")), "the dependent step ran once the approved step was done");
  assert((await getTask(a.taskId!))!.status === "succeeded", "the step's task is succeeded, with the follow-up turn's answer");

  console.log("\n-- 4. approvals: always-allow on a rejected request; cancel rejects waiting approvals --");
  const stale = await requestApproval({ agentId: "hermes", sessionId: "s-test", toolName: "shell", args: { command: "echo stale" }, reason: "test" });
  await rejectRequest(stale.id);
  const again = await post(`/approvals/${stale.id}/approve`, { always: "exact" });
  assert(again.status === 409, "approving an already rejected request is refused");
  assert(!(await listAllowRules("hermes")).some((r) => JSON.stringify(r.args ?? {}).includes("echo stale")), "…and leaves no always-allow rule behind");

  asked.length = 0;
  const waiting = (await (await post("/flows", { steps: [{ id: "a", agentId: "hermes", goal: "SHELL: again" }] })).json()) as { id: string };
  await waitFor(async () => (await getFlow(waiting.id))?.status !== "running");
  const wTask = (await getTask((await getFlow(waiting.id))!.steps[0]!.taskId!))!;
  const wApproval = wTask.output!.approvalId as string;
  // The stopped flow is failed, and only a running flow can be cancelled: Resume it (this attempt hangs), then cancel.
  await post(`/flows/${waiting.id}/resume`, { steps: [{ id: "a", agentId: "hermes", goal: "HANG: second attempt" }] });
  await waitFor(async () => asked.some((g) => g.startsWith("HANG")));
  await post(`/flows/${waiting.id}/cancel`, {});
  assert((await getFlow(waiting.id))!.status === "cancelled", "the resumed flow is cancelled");
  assert((await getApproval(wApproval))!.status === "rejected", "the approval its first attempt was waiting on is rejected, not left pending");
  assert(!(await listApprovals({ status: "pending" })).some((p) => p.id === wApproval), "…so it no longer shows under needs-you");
} finally {
  await gateway.stop();
}

console.log("\n-- 3. restart recovery: a lost step doesn't stay running --");
{
  asked.length = 0;
  const steps = [{ id: "a", agentId: "aether", goal: "A: survives a restart" }];
  const flow = await createFlow("managed", [{ id: "a", dependsOn: [] }]);
  await storeFlowDefinition({ flowId: flow.id, proposedBy: "operator", summary: "restart", steps });
  const task = await createTask({ type: "flow-step", agentId: "aether", flowId: flow.id, input: { stepId: "a" } });
  await transitionTask(task.id, "running");
  await updateFlowStep(flow.id, "a", "running", (await getFlow(flow.id))!.revision, task.id);
  // The process that ran it is gone: a reconcile after the liveness window marks the task lost.
  await reconcileLostTasks({ now: new Date(Date.now() + 120_000) });
  const after = (await getFlow(flow.id))!;
  assert(after.steps[0]!.status === "lost" && after.status === "failed", "the step is recorded as lost and the flow ends failed");
  const resumed = await resumeFlow(flow.id, steps, opts);
  assert(resumed.status === "succeeded" && asked.some((g) => g.startsWith("A:")), "Resume runs the lost step again and the flow succeeds");
}

console.log("\n-- 4b. Resume pressed twice runs a step once --");
{
  asked.length = 0;
  const steps = [{ id: "a", agentId: "aether", goal: "TWICE: one step" }];
  const flow = await createFlow("managed", [{ id: "a", dependsOn: [] }]);
  await Promise.all([resumeFlow(flow.id, steps, opts), resumeFlow(flow.id, steps, opts)]);
  assert(asked.filter((g) => g.startsWith("TWICE")).length === 1, "two concurrent drives of the same flow ran the step once");
  assert((await getFlow(flow.id))!.status === "succeeded", "…and the flow succeeded");
}

console.log(failed ? "\nSOME TESTS FAILED" : "\nall flow-fix tests passed");
process.exit(failed ? 1 : 0);
