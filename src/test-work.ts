// Tests for reporting lines (identity.ts), the work ledger (core/work.ts),
// the agent tools (delegate, work), the runner (gateway/work-runner.ts) and
// the /work + MCP surfaces. A scripted model stands in for the agents.
// Proves:
//   1. Default reporting lines are seeded once; loops are rejected; the
//      operator's "reports to nobody" survives a restart.
//   2. Ledger rules: no self-delegation, unknown agents rejected, claims are
//      exclusive, an assignee can't cancel (requester/operator can), depth
//      is capped, delegating straight back is refused, hand-back goes to the
//      manager (or to the operator, blocked, without one).
//   3. `delegate` inside a real turn creates an item carrying the session's
//      focus and origin; the org block lists who reports to whom.
//   4. The runner works items: an explicit `work done`, auto-completion with
//      the final reply, a failed run → blocked, a paused assignee waits until
//      resumed. Results are posted back into the requester's session.
//   5. Tokens are recorded per item and roll up to the item that asked.
//   6. Gateway /work routes and MCP assign_work/list_work.
// Run with: node dist/test-work.js

import "./test-helpers/isolate.js";
process.env.CLAUDE_CLI_PATH = "/nonexistent/claude"; // no real providers in this test

import {
  OPERATOR,
  blockWork,
  cancelWork,
  claimWork,
  createSession,
  createStubWorker,
  createWork,
  getAgentIdentity,
  getSessionHistory,
  getWork,
  handBackWork,
  listWork,
  pauseAgent,
  recordWorkUsage,
  resumeAgent,
  runTurn,
  seedDefaultAgents,
  updateAgent,
  type ModelAdapter,
  type ModelMessage,
  type ModelResponse,
} from "./core/index.js";
import { startGateway } from "./gateway/server.js";
import { startWorkRunner } from "./gateway/work-runner.js";

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

const systems: string[] = [];
/** Behaves by what it's asked: a [Work] prompt titled "…auto…" just
 *  answers, "…explode…" throws, anything else calls `work done`; a chat
 *  asking to "delegate captions" delegates to Nyx. 10+5 tokens per call. */
const scripted: ModelAdapter = {
  id: "scripted",
  async complete(messages: ModelMessage[]): Promise<ModelResponse> {
    systems.push(messages.find((m) => m.role === "system")?.content ?? "");
    const usage = { inputTokens: 10, outputTokens: 5 };
    const last = messages[messages.length - 1]!;
    const firstUser = messages.find((m) => m.role === "user")?.content ?? "";
    // Never finishes: keeps calling a tool until the steps run out.
    if (firstUser.startsWith("[Work]") && firstUser.includes("endless")) return { content: "", toolCall: { name: "work", args: { action: "list" } }, usage };
    if (last.role === "tool") return { content: "Finished.", usage };
    if (firstUser.startsWith("[Work]")) {
      if (firstUser.includes("explode")) throw new Error("model fell over");
      if (firstUser.includes("auto")) return { content: "Here are three captions: a, b, c.", usage };
      return { content: "", toolCall: { name: "work", args: { action: "done", text: "Three captions drafted in Notes." } }, usage };
    }
    if (last.content.includes("delegate captions")) {
      return { content: "Handing that to Nyx.", toolCall: { name: "delegate", args: { to: "nyx", title: "Draft three captions for the teaser", detail: "Short, lowercase." } }, usage };
    }
    return { content: "ok", usage };
  },
};

async function testOrg(): Promise<void> {
  await seedDefaultAgents();
  assert((await getAgentIdentity("nyx"))?.reportsTo === "hemera" && !(await getAgentIdentity("argus"))?.reportsTo, "default reporting lines: the artist team → Hemera; Argus → operator");
  assert(await throwsWith(updateAgent("hemera", { reportsTo: "nyx" }), /loop/), "a reporting loop (Hemera → Nyx → Hemera) is rejected");
  await updateAgent("theia", { reportsTo: null });
  await seedDefaultAgents(); // a restart
  assert(!(await getAgentIdentity("theia"))?.reportsTo, "clearing a manager survives a restart (seeding runs once)");
  await updateAgent("theia", { reportsTo: "hemera" });
}

async function testLedger(): Promise<void> {
  assert(await throwsWith(createWork({ title: "x", assignee: "nyx", requestedBy: "nyx" }), /yourself/), "no handing work to yourself");
  assert(await throwsWith(createWork({ title: "x", assignee: "ghost", requestedBy: "hemera" }), /no agent/), "unknown assignee rejected");

  const a = await createWork({ title: "Plan the teaser week", assignee: "hemera", requestedBy: OPERATOR });
  await claimWork(a.id, "hemera", "s-1");
  assert(await throwsWith(claimWork(a.id, "hemera", "s-2"), /in_progress/), "a second claim fails and says it's taken");
  assert(await throwsWith(cancelWork(a.id, "hemera", "meh"), /can't cancel work handed to you/), "the assignee can't cancel");

  const b = await createWork({ title: "Captions", assignee: "nyx", requestedBy: "hemera", parentId: a.id });
  assert(b.depth === 1, "depth counts hand-offs");
  assert(await throwsWith(createWork({ title: "back", assignee: "hemera", requestedBy: "nyx", parentId: b.id }), /hand-back/), "delegating straight back to the requester is refused");
  const c = await createWork({ title: "c", assignee: "aether", requestedBy: "nyx", parentId: b.id });
  const d = await createWork({ title: "d", assignee: "theia", requestedBy: "aether", parentId: c.id });
  assert(d.depth === 3 && (await throwsWith(createWork({ title: "e", assignee: "hermes", requestedBy: "theia", parentId: d.id }), /deep/)), "delegation depth is capped at 3 hand-offs");

  const handed = await handBackWork(b.id, "nyx", "this needs a brief first");
  assert(handed.assignee === "hemera" && handed.status === "open", "hand-back goes to the manager, open again");
  const top = await createWork({ title: "Audit", assignee: "argus", requestedBy: OPERATOR });
  const noManager = await handBackWork(top.id, "argus", "out of scope");
  assert(noManager.status === "blocked" && /operator/.test(noManager.blockedReason ?? ""), "without a manager a hand-back is blocked for the operator");
  assert((await cancelWork(a.id, OPERATOR, "changed plans")).status === "cancelled", "the operator can cancel");

  await recordWorkUsage(c.id, 100);
  await recordWorkUsage(d.id, 40);
  assert((await getWork(b.id))!.totalTokens === 140 && (await getWork(c.id))!.totalTokens === 140, "tokens roll up to the item that asked");
  await blockWork(c.id, "aether", "no stems yet");
  assert((await getWork(c.id))!.blockedReason === "no stems yet", "blocked keeps the reason");
}

async function testToolsAndRunner(): Promise<void> {
  const runner = startWorkRunner({ model: scripted, worker: createStubWorker(), enableBaseSpace: true }, { intervalMs: 60_000 });
  try {
    // Hemera delegates from a focused conversation.
    const session = await createSession({ agentId: "hemera", focus: { kind: "goal", id: "g-switch" } });
    await runTurn({ sessionId: session.id, agentId: "hemera", userMessage: "please delegate captions", model: scripted, worker: createStubWorker(), enableBaseSpace: true });
    assert(systems.some((s) => s.includes("# Your team") && s.includes("Reporting to you: Nyx (nyx)")), "Hemera's turn knows who reports to her");
    const item = (await listWork({ requestedBy: "hemera" })).find((w) => w.title === "Draft three captions for the teaser")!;
    assert(!!item && item.focus?.id === "g-switch" && item.requestedFromSessionId === session.id, "delegate creates an item with the session's focus and origin");

    await runner.idle();
    const done = (await getWork(item.id))!;
    assert(done.status === "done" && done.result === "Three captions drafted in Notes.", "the runner ran Nyx's turn and she marked it done");
    assert(done.tokens > 0, "tokens spent on it are recorded on the item");
    await new Promise((r) => setTimeout(r, 100));
    const notes = (await getSessionHistory(session.id)).filter((m) => m.content.startsWith("[Work] "));
    assert(notes.some((m) => m.content.includes('Nyx finished "Draft three captions for the teaser": Three captions drafted in Notes.')), "the result is posted back into Hemera's conversation");

    const auto = await createWork({ title: "auto: write a tagline", assignee: "aether", requestedBy: OPERATOR });
    const boom = await createWork({ title: "explode please", assignee: "hermes", requestedBy: OPERATOR });
    await runner.idle();
    assert((await getWork(auto.id))!.status === "done" && (await getWork(auto.id))!.result === "Here are three captions: a, b, c.", "a run that ends without `work` completes with its reply");
    const failed = (await getWork(boom.id))!;
    assert(failed.status === "blocked" && /model fell over/.test(failed.blockedReason ?? ""), "a failed run leaves the item blocked with the error");

    const endless = await createWork({ title: "endless: check everything", assignee: "theia", requestedBy: OPERATOR });
    await runner.idle();
    const stopped = (await getWork(endless.id))!;
    assert(stopped.status === "blocked" && /tool steps/.test(stopped.blockedReason ?? ""), "a run that stops without an answer (out of tool steps) is blocked, not done");

    await pauseAgent("mnemosyne", { reason: "test" });
    const waiting = await createWork({ title: "auto: tidy the archive", assignee: "mnemosyne", requestedBy: OPERATOR });
    await runner.idle();
    assert((await getWork(waiting.id))!.status === "open", "a paused assignee's work waits");
    await resumeAgent("mnemosyne");
    await runner.idle();
    assert((await getWork(waiting.id))!.status === "done", "and runs once resumed");
  } finally {
    runner.stop();
  }
}

async function testGatewayAndMcp(): Promise<void> {
  const gateway = await startGateway({ model: scripted, worker: createStubWorker(), enableBaseSpace: true });
  const base = `http://127.0.0.1:${gateway.port}`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const created = (await (await post("/work", { title: "Check the release calendar", assignee: "hemera", focus: { kind: "goal", id: "g-switch" } })).json()) as { id: string; requestedBy: string };
    assert(created.requestedBy === "operator", "POST /work assigns on the operator's behalf");
    assert((await post("/work", { title: "x", assignee: "nobody" })).status === 409, "a rule violation is a 409");
    const list = (await (await fetch(`${base}/work?assignee=hemera&status=open`)).json()) as { work: { id: string }[] };
    assert(list.work.some((w) => w.id === created.id), "GET /work filters");
    const cancelled = (await (await post(`/work/${created.id}/cancel`, { reason: "not now" })).json()) as { status: string };
    assert(cancelled.status === "cancelled", "POST /work/:id/cancel");

    const rpc = async (name: string, args: Record<string, unknown>) =>
      ((await (await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).json()) as any).result;
    const assigned = await rpc("assign_work", { agentId: "theia", title: "Find three comparable artists", goalId: "g-switch" });
    assert(!assigned.isError && /work item/.test(assigned.content[0].text), "MCP assign_work creates an item");
    const listed = await rpc("list_work", { agentId: "theia" });
    assert(listed.content[0].text.includes("Find three comparable artists"), "MCP list_work shows it");
    const agents = await rpc("list_agents", {});
    assert(agents.content[0].text.includes("nyx — Nyx") && agents.content[0].text.includes("reports to hemera"), "list_agents shows reporting lines");
  } finally {
    await gateway.stop();
  }
}

async function main(): Promise<void> {
  await testOrg();
  await testLedger();
  await testToolsAndRunner();
  await testGatewayAndMcp();
  if (process.exitCode === 1) console.error("\nSome work tests FAILED.");
  else console.log("\nAll work tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
