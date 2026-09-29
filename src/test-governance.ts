// Tests for governance gates and agent config revisions (core/governance.ts).
// Proves:
//   1. Only leads are offered propose-agent / propose-plan.
//   2. A gated call never runs from a turn: it files ONE approval (a retry
//      reuses it), the turn stops, nothing is created. It can't be
//      always-allowed, and dispatch refuses it without an approval.
//   3. Approved (the gateway's approve route): the agent is hired with its
//      manager and BaseSpace defaults; the plan becomes work items serving
//      the goal. Bad input creates nothing (all-or-nothing).
//   4. Config revisions list every change and restore one as new events;
//      later edits aren't folded into the restore. Routes work.
// Run with: node dist/test-governance.js

import "./test-helpers/isolate.js";
process.env.CLAUDE_CLI_PATH = "/nonexistent/claude"; // no real providers in this test

import {
  addAllowRule,
  createSession,
  createStubWorker,
  executeApprovedCall,
  getAgentControlState,
  getAgentDefaultModel,
  getAgentIdentity,
  listAgentRevisions,
  listAllowRules,
  listApprovals,
  listWork,
  restoreAgentRevision,
  runTurn,
  saveSnapshot,
  seedDefaultAgents,
  setAgentBudget,
  updateAgent,
  type ModelAdapter,
  type ModelCallOptions,
  type ModelMessage,
  type ModelResponse,
} from "./core/index.js";
import { startGateway } from "./gateway/server.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

async function throwsWith(p: Promise<unknown>, re: RegExp): Promise<boolean> {
  try {
    await p;
    return false;
  } catch (err) {
    return re.test(String(err));
  }
}

const HIRE = { id: "lyra", name: "Lyra", role: "Sync licensing · Outreach", persona: "Finds sync placements for ISΛRK's catalog and drafts pitches for the operator to send.", why: "Sync pitching is weekly work nobody owns." };
const PLAN = { goalId: "g-switch", summary: "Tease, then release.", steps: [{ to: "nyx", title: "Draft the teaser captions" }, { to: "hermes", title: "Line up two playlist curators", detail: "Indie electronic." }] };

let offered: string[] = [];
/** Calls whatever tool the user message names as JSON: `call {name, args}`. */
const scripted: ModelAdapter = {
  id: "scripted",
  async complete(messages: ModelMessage[], callOpts?: ModelCallOptions): Promise<ModelResponse> {
    offered = (callOpts?.tools ?? []).map((t) => t.name);
    const last = messages[messages.length - 1]!;
    if (last.role === "tool") return { content: "Filed it." };
    const m = /^call (.*)$/s.exec(last.content);
    if (m) return { content: "Proposing.", toolCall: JSON.parse(m[1]!) };
    return { content: "ok" };
  },
};
const worker = createStubWorker();
const turn = (sessionId: string, agentId: string, userMessage: string) => runTurn({ sessionId, agentId, userMessage, model: scripted, worker, enableBaseSpace: true });

async function testGates(): Promise<void> {
  await seedDefaultAgents();
  await saveSnapshot({ schema: 1, goals: [{ id: "g-switch", title: "Release Switch in October", status: "active" }] });
  const hemera = await createSession({ agentId: "hemera" });
  await turn(hemera.id, "hemera", "hi");
  assert(offered.includes("propose-agent") && offered.includes("propose-plan"), "a lead is offered propose-agent and propose-plan");
  const nyx = await createSession({ agentId: "nyx" });
  await turn(nyx.id, "nyx", "hi");
  assert(!offered.includes("propose-agent") && !offered.includes("propose-plan"), "an agent with no reports isn't");

  const hire = await turn(hemera.id, "hemera", `call ${JSON.stringify({ name: "propose-agent", args: HIRE })}`);
  let pending = (await listApprovals({ status: "pending" })).filter((a) => a.toolName === "propose-agent");
  assert(hire.stopReason === "tool-blocked" && /always needs the operator's OK/.test(hire.finalContent), "a hire proposal stops the turn, waiting for approval");
  assert(pending.length === 1 && /^Hire: hemera proposes a new agent "Lyra"/.test(pending[0]!.reason), "one approval is filed, saying who and why");
  assert(!(await getAgentIdentity("lyra")), "nothing is created before approval");
  await turn(hemera.id, "hemera", `call ${JSON.stringify({ name: "propose-agent", args: HIRE })}`);
  pending = (await listApprovals({ status: "pending" })).filter((a) => a.toolName === "propose-agent");
  assert(pending.length === 1, "proposing the same thing again reuses the pending approval");
  assert(await throwsWith(addAllowRule({ agentId: "hemera", toolName: "propose-agent" }), /always needs your approval/), "a gated tool can't be always-allowed");

  const selfPlan = { ...PLAN, steps: [{ to: "hemera", title: "Run the standup" }, ...PLAN.steps] };
  const refused = await turn(hemera.id, "hemera", `call ${JSON.stringify({ name: "propose-plan", args: selfPlan })}`);
  const { getSessionHistory } = await import("./core/index.js");
  const toolMsg = (await getSessionHistory(hemera.id)).filter((m) => m.role === "tool").at(-1)?.content ?? "";
  assert(refused.stopReason === "answered" && /not filed — fix this and propose again: step "Run the standup" is assigned to you/.test(toolMsg), "a flawed plan isn't filed: the problem goes straight back to the agent");
  assert(!(await listApprovals({ status: "pending" })).some((a) => a.toolName === "propose-plan"), "and nothing waits in Approvals for it");
  const plan = await turn(hemera.id, "hemera", `call ${JSON.stringify({ name: "propose-plan", args: PLAN })}`);
  assert(plan.stopReason === "tool-blocked" && (await listApprovals({ status: "pending" })).some((a) => a.toolName === "propose-plan" && /2 work items/.test(a.reason)), "a plan proposal is filed too");
  assert(!(await listWork({ requestedBy: "hemera" })).length, "no work is created before approval");
}

async function testApproved(): Promise<void> {
  const s = await createSession({ agentId: "hemera", focus: { kind: "goal", id: "g-switch" } });
  const run = (name: string, args: Record<string, unknown>) =>
    executeApprovedCall({ sessionId: s.id, agentId: "hemera", toolCall: { name, args }, model: scripted, worker });

  const hired = await run("propose-agent", { ...HIRE, model: "claude-cli:haiku" });
  const lyra = await getAgentIdentity("lyra");
  assert(hired.ok && lyra?.reportsTo === "hemera" && lyra.role === HIRE.role, "approved: the agent is hired, reporting to whoever proposed it");
  assert((await getAgentDefaultModel("lyra")) === "claude-cli:haiku", "with the proposed model");
  assert((await listAllowRules("lyra")).some((r) => r.toolName === "basespace-add"), "and the roster's BaseSpace defaults");
  assert(!(await run("propose-agent", HIRE)).ok, "hiring an id that exists fails");
  assert(!(await run("propose-agent", { ...HIRE, id: "x y", persona: "short" })).ok, "a bad id or thin persona is refused");

  const bad = await run("propose-plan", { summary: "x", steps: [{ to: "nyx", title: "a" }, { to: "ghost", title: "b" }] });
  assert(!bad.ok && /no agent "ghost"/.test(bad.error ?? "") && !(await listWork({ requestedBy: "hemera" })).length, "a plan with a bad step creates nothing");
  assert(!(await run("propose-plan", { summary: "x", steps: [{ to: "hemera", title: "a" }] })).ok, "a lead can't plan work for itself");
  const adopted = await run("propose-plan", { summary: PLAN.summary, steps: JSON.stringify(PLAN.steps) });
  const items = await listWork({ requestedBy: "hemera" });
  assert(adopted.ok && items.length === 2 && items.every((w) => w.focus?.id === "g-switch" && w.requestedFromSessionId === s.id), "approved: one work item per step, serving the goal (from the session's focus), reported back here");
}

async function testRevisions(): Promise<void> {
  await updateAgent("theia", { persona: "Researches markets. v2" });
  await updateAgent("theia", { defaultModel: "ollama:llama3.2:3b" });
  await setAgentBudget("theia", { period: "week", limitTokens: 50000 });
  const revs = await listAgentRevisions("theia");
  // 1 = registered, 2 = the seeded reporting line, then persona, model, budget.
  assert(revs.length === 5 && revs[1]!.changed.join() === "reportsTo" && revs.at(-1)!.changed.join() === "budget", "every change is a revision");
  assert(revs[2]!.changed.join() === "persona" && revs[3]!.config.defaultModel === "ollama:llama3.2:3b", "each says what changed and the whole config after it");

  await new Promise((r) => setTimeout(r, 5));
  const after = await restoreAgentRevision("theia", 2);
  const theia = await getAgentIdentity("theia");
  assert(theia?.persona === revs[1]!.config.persona && theia?.reportsTo === "hemera" && !(await getAgentDefaultModel("theia")) && !(await getAgentControlState("theia")).budget, "restore brings persona, model and budget back to revision 2");
  const restoredRev = after.at(-1)!;
  assert(after.length === 6 && restoredRev.restoredFrom === 2 && restoredRev.changed.length === 3, "the restore is one new revision marked restoredFrom, history kept");
  assert(await throwsWith(restoreAgentRevision("theia", 2), /already at revision 2/), "restoring to the current config says so");
  await new Promise((r) => setTimeout(r, 2100));
  await updateAgent("theia", { role: "Market · Research · Trends" });
  const later = (await listAgentRevisions("theia")).at(-1)!;
  assert(later.rev === 7 && !later.restoredFrom && later.changed.join() === "role", "a later edit is its own revision, not part of the restore");
}

async function testRoutes(): Promise<void> {
  const gateway = await startGateway({ model: scripted, worker, enableBaseSpace: true });
  const base = `http://127.0.0.1:${gateway.port}`;
  const post = (path: string, body: unknown = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const list = (await (await fetch(`${base}/agents/theia/revisions`)).json()) as { revisions: { rev: number }[] };
    assert(list.revisions.length === 7, "GET /agents/:id/revisions");
    const restored = (await (await post("/agents/theia/revisions/3/restore")).json()) as { revisions: { restoredFrom?: number }[] };
    assert(restored.revisions.at(-1)!.restoredFrom === 3, "POST /agents/:id/revisions/:rev/restore");
    assert((await post("/agents/theia/revisions/99/restore")).status === 409, "an unknown revision is a 409");

    const pendingHire = (await listApprovals({ status: "pending" })).find((a) => a.toolName === "propose-agent")!;
    assert((await post(`/approvals/${pendingHire.id}/approve`, { always: "tool" })).status === 409 && (await listApprovals({ status: "pending" })).some((a) => a.id === pendingHire.id), "approving with 'always allow' is refused and approves nothing");
    const rejected = (await (await post(`/approvals/${pendingHire.id}/reject`, { resume: false })).json()) as { status: string };
    assert(rejected.status === "rejected", "a hire can be rejected");
  } finally {
    await gateway.stop();
  }
}

async function main(): Promise<void> {
  await testGates();
  await testApproved();
  await testRevisions();
  await testRoutes();
  if (process.exitCode === 1) console.error("\nSome governance tests FAILED.");
  else console.log("\nAll governance tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
