// Tests for board controls (core/controls.ts): pause/resume and token
// budgets, enforced in runTurn() and exposed over the gateway. Proves:
//   1. Usage from finished turns is recorded per agent and summed per period.
//   2. Crossing 80% fires agent.budget.warning once; reaching the limit fires
//      agent.budget.exceeded once, and the next turn is refused (and says why
//      in the session instead of vanishing).
//   3. Raising the limit, or clearing the budget, lets the agent run again —
//      the block is derived, not stuck.
//   4. Pause refuses turns until resumed.
//   5. Scheduled work (a cron automation) is skipped for a paused agent.
//   6. Gateway: POST /agents/:id/pause|resume, PUT /agents/:id/budget; a
//      blocked turn is a 409 with `blocked`; GET /agents carries `control`.
//   7. Period boundaries: day, ISO week from Monday, month (UTC).
// Run with: node dist/test-controls.js

import "./test-helpers/isolate.js";
import {
  AgentBlockedError,
  createStubModel,
  createStubWorker,
  getAgentControlState,
  getSessionHistory,
  newSessionId,
  pauseAgent,
  periodStart,
  registerAgent,
  registerAutomation,
  resumeAgent,
  runSchedulerTick,
  runTurn,
  setAgentBudget,
  subscribeToAllEvents,
  type ModelAdapter,
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

/** The stub model, reporting a fixed token count per call. */
function modelUsing(tokens: number): ModelAdapter {
  const stub = createStubModel();
  return { id: "counting", complete: async (m) => ({ ...(await stub.complete(m)), usage: { inputTokens: tokens - 10, outputTokens: 10 } }) };
}

async function turn(agentId: string, tokens: number, sessionId = newSessionId()) {
  return runTurn({ sessionId, agentId, userMessage: "hello", model: modelUsing(tokens), worker: createStubWorker() });
}

async function blockedReason(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return err instanceof AgentBlockedError ? err.blocked : `other: ${err}`;
  }
}

async function testBudget(): Promise<void> {
  const events: string[] = [];
  const unsubscribe = subscribeToAllEvents((type) => {
    if (type.startsWith("agent.budget.")) events.push(type);
  });

  await turn("nyx", 40);
  assert((await getAgentControlState("nyx")).usedTokens === 40, "a finished turn's tokens are recorded for the agent");

  await setAgentBudget("nyx", { period: "day", limitTokens: 100 });
  await turn("nyx", 30); // 70
  assert(events.length === 0, "no warning below 80%");
  await turn("nyx", 20); // 90
  assert(events.join() === "agent.budget.warning", "crossing 80% warns once");
  await turn("nyx", 20); // 110 — this turn was allowed (started under the limit)
  assert(events.join() === "agent.budget.warning,agent.budget.exceeded", "reaching the limit fires exceeded once");

  const sessionId = newSessionId();
  assert((await blockedReason(turn("nyx", 5, sessionId))) === "budget", "the next turn is refused as over budget");
  const history = await getSessionHistory(sessionId);
  assert(history.some((m) => m.role === "assistant" && /daily budget/.test(m.content)), "the refusal is written to the session");
  assert((await getAgentControlState("nyx")).blocked === "budget", "state shows blocked: budget");

  await setAgentBudget("nyx", { period: "day", limitTokens: 1000 });
  assert((await blockedReason(turn("nyx", 5))) === undefined, "raising the limit lifts the block");
  await setAgentBudget("nyx", { period: "day", limitTokens: 50 });
  await setAgentBudget("nyx", { limitTokens: null });
  const cleared = await getAgentControlState("nyx");
  assert(!cleared.budget && !cleared.blocked, "clearing the budget (null) removes the ceiling");

  let bad = "";
  try {
    await setAgentBudget("nyx", { limitTokens: -5 });
  } catch (err) {
    bad = String(err);
  }
  assert(/positive number/.test(bad), "an invalid limit is rejected");
  unsubscribe();
}

async function testPauseAndSchedulers(): Promise<void> {
  await pauseAgent("hermes", { reason: "reviewing outreach" });
  assert((await blockedReason(turn("hermes", 10))) === "paused", "a paused agent's turn is refused");
  const state = await getAgentControlState("hermes");
  assert(state.blocked === "paused" && state.paused?.reason === "reviewing outreach", "pause keeps its reason");

  const automation = await registerAutomation({ trigger: { kind: "cron", expr: "* * * * *" }, agentId: "hermes", promptTemplate: "check the inbox", enabled: true });
  const skipped = await runSchedulerTick({ model: createStubModel(), worker: createStubWorker() });
  assert(!skipped.some((r) => r.automationId === automation.id), "a paused agent's cron automation is skipped, not failed");

  await resumeAgent("hermes");
  assert((await blockedReason(turn("hermes", 10))) === undefined, "resume lets it run again");
  const fired = await runSchedulerTick({ model: createStubModel(), worker: createStubWorker() }, new Date(Date.now() + 60_000));
  assert(fired.some((r) => r.automationId === automation.id), "and its automation fires again");
}

async function testGateway(): Promise<void> {
  await registerAgent({ id: "theia", name: "Theia", persona: "You are Theia." });
  const gateway = await startGateway({ model: createStubModel(), worker: createStubWorker() });
  const base = `http://127.0.0.1:${gateway.port}`;
  const send = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    const paused = (await (await send("POST", "/agents/theia/pause", { reason: "holiday" })).json()) as { blocked?: string };
    assert(paused.blocked === "paused", "POST /agents/:id/pause pauses and returns the state");

    const session = (await (await send("POST", "/sessions", { agentId: "theia" })).json()) as { id: string };
    const refused = await send("POST", `/sessions/${session.id}/turns`, { userMessage: "hi" });
    const refusedBody = (await refused.json()) as { blocked?: string };
    assert(refused.status === 409 && refusedBody.blocked === "paused", "a blocked turn is a 409 with blocked, not a 500");

    const agents = (await (await send("GET", "/agents")).json()) as { agents: { id: string; control: { blocked?: string } }[] };
    assert(agents.agents.find((a) => a.id === "theia")?.control.blocked === "paused", "GET /agents carries each agent's control state");

    assert((await send("POST", "/agents/theia/resume")).status === 200, "POST /agents/:id/resume");
    assert((await send("POST", `/sessions/${session.id}/turns`, { userMessage: "hi" })).status === 200, "and turns run again");

    const budget = (await (await send("PUT", "/agents/theia/budget", { period: "week", limitTokens: 5000 })).json()) as { budget?: { period: string; limitTokens: number } };
    assert(budget.budget?.period === "week" && budget.budget.limitTokens === 5000, "PUT /agents/:id/budget sets it");
    assert((await send("PUT", "/agents/theia/budget", { limitTokens: "lots" })).status === 400, "an invalid budget is a 400");
    assert((await send("POST", "/agents/nobody/pause")).status === 404, "an unknown agent is a 404");
  } finally {
    await gateway.stop();
  }
}

function testPeriods(): void {
  const wed = new Date("2026-09-30T15:00:00Z"); // a Wednesday
  assert(periodStart("day", wed).toISOString() === "2026-09-30T00:00:00.000Z", "day starts at UTC midnight");
  assert(periodStart("week", wed).toISOString() === "2026-09-28T00:00:00.000Z", "week starts on Monday");
  assert(periodStart("week", new Date("2026-10-04T23:00:00Z")).toISOString() === "2026-09-28T00:00:00.000Z", "Sunday belongs to the week that began Monday");
  assert(periodStart("month", wed).toISOString() === "2026-09-01T00:00:00.000Z", "month starts on the 1st");
}

async function main(): Promise<void> {
  testPeriods();
  await testBudget();
  await testPauseAndSchedulers();
  await testGateway();
  if (process.exitCode === 1) console.error("\nSome controls tests FAILED.");
  else console.log("\nAll controls tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
