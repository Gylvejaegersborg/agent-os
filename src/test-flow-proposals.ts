// Tests for leader-designed flows checked by Argus (core/flow-proposals.ts).
// Proves:
//   1. Argus's check (code) catches what would break a flow: bad/duplicate ids, unknown
//      agents, unknown or circular dependencies, vague steps, too many steps, a paused
//      agent, an unknown goal. It also offers notes for working better (a long chain with
//      no parallelism, endings nobody combines, no review step).
//   2. Only a lead is offered `propose-flow`. A flawed proposal is refused at once with
//      Argus's findings and files no approval; a sound one waits for the operator, with
//      Argus's verdict on the request, and creates nothing before approval.
//   3. Once approved the flow runs: independent steps in parallel, a dependent step is shown
//      what its upstream steps produced, the definition is stored, and the outcome is posted
//      back to the session that proposed it.
//   4. A gated tool still can't be put on an always-allow list.
// Run with: node dist/test-flow-proposals.js

import "./test-helpers/isolate.js";
import {
  createSession,
  createStubWorker,
  executeApprovedCall,
  getFlow,
  getSessionHistory,
  listApprovals,
  pauseAgent,
  resumeAgent,
  runTurn,
  saveSnapshot,
  seedDefaultAgents,
  validateFlow,
  getFlowDefinition,
  argusVerdict,
  type ModelAdapter,
  type ModelResponse,
} from "./core/index.js";

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`ok: ${msg}`);
  else {
    failed = true;
    console.log(`FAIL: ${msg}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let offered: string[] = [];
/** "call {json}" → that tool call; anything else → echoes what it was asked (so a step's input is visible in its output). */
const scripted: ModelAdapter = {
  id: "scripted",
  async complete(messages, opts): Promise<ModelResponse> {
    offered = (opts?.tools ?? []).map((t) => t.name);
    const last = messages[messages.length - 1]!;
    if (last.role === "user" && last.content.startsWith("call ")) {
      const call = JSON.parse(last.content.slice(5));
      return { content: "", toolCall: { name: call.name, args: call.args } };
    }
    return { content: last.role === "tool" ? "ok" : `did: ${last.content}` };
  },
};
const worker = createStubWorker();
const turn = (sessionId: string, agentId: string, userMessage: string) => runTurn({ sessionId, agentId, userMessage, model: scripted, worker, enableBaseSpace: true });
const call = (name: string, args: unknown) => `call ${JSON.stringify({ name, args })}`;

await seedDefaultAgents();
await saveSnapshot({ schema: 1, goals: [{ id: "g-switch", title: "Release Switch in October", status: "active" }] });

const GOAL = "Research the release window and write down what you find for the team.";
const good = {
  title: "Switch release prep",
  summary: "Research in parallel, then write, then review.",
  goalId: "g-switch",
  steps: [
    { id: "market", agent: "nyx", goal: `Market side: ${GOAL}` },
    { id: "audience", agent: "aether", goal: `Audience side: ${GOAL}` },
    { id: "write", agent: "hermes", goal: "Write the one-page release plan from both research results.", dependsOn: ["market", "audience"] },
    { id: "review", agent: "argus", goal: "Review the plan against what the research actually said.", dependsOn: ["write"] },
  ],
};

// --- 1. Argus's check -------------------------------------------------------
const errs = async (args: Record<string, unknown>) => (await validateFlow({ title: "Test flow", ...args }, "hemera")).issues.filter((i) => i.level === "error").map((i) => i.message);
const notes = async (args: Record<string, unknown>) => (await validateFlow({ title: "Test flow", ...args }, "hemera")).issues.filter((i) => i.level === "note").map((i) => i.message);

assert((await errs(good)).length === 0, "a sound flow has no errors");
assert((await errs({ ...good, title: "" })).some((e) => /short name/.test(e)) && (await errs({ ...good, title: "x".repeat(61) })).some((e) => /short name/.test(e)) && (await errs({ ...good, title: undefined })).some((e) => /short name/.test(e)), "a flow must be given a short, understandable name (3 to 60 characters)");
assert(/no steps|at least one step/.test((await errs({ steps: [] }))[0] ?? ""), "an empty flow is refused");
assert((await errs({ steps: Array.from({ length: 11 }, (_, i) => ({ id: `s${i}`, agent: "nyx", goal: GOAL })) })).some((e) => /at most 10/.test(e)), "more than 10 steps is refused");
assert((await errs({ steps: [{ id: "a", agent: "ghost", goal: GOAL }] })).some((e) => /no agent "ghost"/.test(e)), "an unknown agent is refused");
assert((await errs({ steps: [{ id: "a", agent: "nyx", goal: "do it" }] })).some((e) => /say what this step should produce/.test(e)), "a vague step is refused");
assert((await errs({ steps: [{ id: "a", agent: "nyx", goal: GOAL }, { id: "a", agent: "nyx", goal: GOAL }] })).some((e) => /two steps are called "a"/.test(e)), "duplicate ids are refused");
assert((await errs({ steps: [{ id: "Bad Id", agent: "nyx", goal: GOAL }] })).some((e) => /lowercase/.test(e)), "a bad id is refused");
assert((await errs({ steps: [{ id: "a", agent: "nyx", goal: GOAL, dependsOn: ["zzz"] }] })).some((e) => /isn't a step/.test(e)), "a dependency on a missing step is refused");
assert((await errs({ steps: [{ id: "a", agent: "nyx", goal: GOAL, dependsOn: ["a"] }] })).some((e) => /depend on itself/.test(e)), "a step depending on itself is refused");
assert((await errs({ steps: [{ id: "a", agent: "nyx", goal: GOAL, dependsOn: ["b"] }, { id: "b", agent: "aether", goal: GOAL, dependsOn: ["a"] }] })).some((e) => /in a circle/.test(e)), "a circular dependency is refused");
assert((await errs({ ...good, steps: [{ id: "a", agent: "nyx", goal: GOAL, retries: 9 }] })).some((e) => /retries/.test(e)), "too many retries are refused");
assert((await errs({ ...good, goalId: "g-nope" })).some((e) => /no goal "g-nope"/.test(e)), "a goal that isn't in BaseSpace is refused");
await pauseAgent("nyx", { reason: "test" });
assert((await errs(good)).some((e) => /nyx is paused/.test(e)), "a paused agent is refused");
await resumeAgent("nyx");

const chain = { goalId: "g-switch", steps: ["a", "b", "c", "d"].map((id, i, all) => ({ id, agent: ["nyx", "aether", "hermes", "argus"][i]!, goal: GOAL, dependsOn: i ? [all[i - 1]!] : [] })) };
assert((await notes(chain)).some((n) => /strictly one after another/.test(n)), "a long chain with no parallelism gets a note");
const forks = { goalId: "g-switch", steps: [{ id: "a", agent: "nyx", goal: GOAL }, { id: "b", agent: "aether", goal: GOAL }, { id: "c", agent: "argus", goal: GOAL }] };
assert((await notes(forks)).some((n) => /have nothing after them/.test(n)), "several endings nobody combines get a note");
assert((await notes({ goalId: "g-switch", steps: [{ id: "a", agent: "nyx", goal: GOAL }, { id: "b", agent: "nyx", goal: GOAL }, { id: "c", agent: "nyx", goal: GOAL }] })).some((n) => /nyx has 3 steps running at once/.test(n)), "one agent holding three parallel steps gets a note");
assert((await notes({ goalId: "g-switch", steps: good.steps.slice(0, 3) })).some((n) => /no step for argus/.test(n)), "a flow with no review step gets a note");
assert((await notes(good)).length === 0 && /argus checked it: no problems found/.test(argusVerdict(await validateFlow(good, "hemera"))), "a sound flow gets a clean verdict from Argus");
assert((await notes({ steps: good.steps })).some((n) => /isn't tied to a goal/.test(n)), "a flow with no goal is noted");

// --- 2. The gate ------------------------------------------------------------
const hemera = await createSession({ agentId: "hemera", focus: { kind: "goal", id: "g-switch" } });
await turn(hemera.id, "hemera", "hi");
assert(offered.includes("propose-flow"), "a lead is offered propose-flow");
const nyx = await createSession({ agentId: "nyx" });
await turn(nyx.id, "nyx", "hi");
assert(!offered.includes("propose-flow"), "an agent with no reports isn't");

const bad = { ...good, steps: [...good.steps, { id: "loop", agent: "ghost", goal: "x" }] };
const refused = await turn(hemera.id, "hemera", call("propose-flow", bad));
const toolMsg = (await getSessionHistory(hemera.id)).filter((m) => m.role === "tool").at(-1)?.content ?? "";
assert(refused.stopReason === "answered" && /not filed — fix this and propose again: argus found problems/.test(toolMsg), "a flawed flow goes straight back to the lead with Argus's findings");
assert(!(await listApprovals({ status: "pending" })).some((a) => a.toolName === "propose-flow"), "and nothing waits in Approvals for it");

const filed = await turn(hemera.id, "hemera", call("propose-flow", good));
const pending = (await listApprovals({ status: "pending" })).filter((a) => a.toolName === "propose-flow");
assert(filed.stopReason === "tool-blocked" && /always needs the operator's OK/.test(filed.finalContent), "a sound flow stops the turn, waiting for approval");
assert(pending.length === 1 && /^Flow "Switch release prep": hemera proposes 4 steps across nyx, aether, hermes, argus for "Release Switch in October"/.test(pending[0]!.reason) && /argus checked it: no problems found/.test(pending[0]!.reason), "the approval names who, what and Argus's verdict");

// --- 3. Approved: it runs ---------------------------------------------------
const approved = await executeApprovedCall({ sessionId: hemera.id, agentId: "hemera", toolCall: { name: "propose-flow", args: good }, model: scripted, worker });
const flowId = /started \(([^)]+)\)/.exec(approved.output)?.[1] ?? "";
assert(approved.ok && !!flowId && /Flow "Switch release prep" started/.test(approved.output), "approved: the flow starts in the background, by its name");
let flow = await getFlow(flowId);
for (let i = 0; i < 100 && flow?.status === "running"; i++) {
  await sleep(100);
  flow = await getFlow(flowId);
}
assert(flow?.status === "succeeded" && flow.steps.every((s) => s.status === "succeeded"), `all four steps succeeded (${flow?.steps.map((s) => `${s.id}:${s.status}`).join(", ")})`);
const { getTask } = await import("./core/index.js");
const out = async (id: string) => String((await getTask(flow!.steps.find((s) => s.id === id)!.taskId!))?.output?.finalContent ?? "");
assert(/Result of step "market"/.test(await out("write")) && /Result of step "audience"/.test(await out("write")), "the writer was shown what both research steps produced");
assert(/Result of step "write"/.test(await out("review")) && /Release Switch|did: Write the one-page/.test(await out("review")), "the reviewer was shown the written plan");
assert(!/Result of step/.test(await out("market")), "a step with no dependencies is given only its own goal");
const def = await getFlowDefinition(flowId);
assert(def?.steps.length === 4 && def.proposedBy === "hemera" && def.goalId === "g-switch" && def.title === "Switch release prep" && flow?.title === "Switch release prep", "the definition is stored, not just its shape, and the flow carries its name");
await sleep(200);
const note = (await getSessionHistory(hemera.id)).filter((m) => m.role === "user" && m.content.startsWith("[Flow]")).at(-1)?.content ?? "";
assert(/The flow "Switch release prep" finished as succeeded/.test(note) && /review: succeeded/.test(note), "the outcome is posted back to the session that proposed it, by name");

// --- 4. Still gated ---------------------------------------------------------
const { addAllowRule } = await import("./core/index.js");
let refusedAllow = false;
try {
  await addAllowRule({ agentId: "hemera", toolName: "propose-flow" });
} catch (e) {
  refusedAllow = /always needs your approval/.test(String(e));
}
assert(refusedAllow, "propose-flow can't be put on an always-allow list");

console.log(failed ? "\nSome flow-proposal tests FAILED." : "\nAll flow-proposal tests passed.");
process.exit(failed ? 1 : 0);
