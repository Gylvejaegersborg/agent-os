// Tests that flows and BaseSpace team crons carry a focus (a goal or
// project), like a focused chat thread does.
// Proves:
//   1. A flow started with a focus runs every step in a session focused on
//      it: the step's agent gets the goal chain, and has the BaseSpace tools.
//      The step session is linked to its task (stale-work sees it).
//   2. The focus is remembered per flow, so a resume keeps it.
//   3. A team cron with a focus runs its standup in a focused session, and
//      its prompt says what the meeting serves.
//   4. POST /flows {focus}.
// Run with: node dist/test-focus-runs.js

import "./test-helpers/isolate.js";
process.env.CLAUDE_CLI_PATH = "/nonexistent/claude";

import {
  createStubWorker,
  getFlowFocus,
  getSession,
  listSessions,
  runFlow,
  saveSnapshot,
  seedDefaultAgents,
  subscribeToAllEvents,
  type ModelAdapter,
  type ModelCallOptions,
  type ModelMessage,
  type ModelResponse,
} from "./core/index.js";
import { startBaseSpaceCronRunner } from "./gateway/basespace-crons.js";
import { startGateway } from "./gateway/server.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

const seen: { system: string; user: string; tools: string[] }[] = [];
const model: ModelAdapter = {
  id: "recording",
  async complete(messages: ModelMessage[], callOpts?: ModelCallOptions): Promise<ModelResponse> {
    seen.push({
      system: messages.find((m) => m.role === "system")?.content ?? "",
      user: messages.find((m) => m.role === "user")?.content ?? "",
      tools: (callOpts?.tools ?? []).map((t) => t.name),
    });
    return { content: "done" };
  },
};
const GOAL = { kind: "goal" as const, id: "g-switch" };

async function main(): Promise<void> {
  await seedDefaultAgents();
  await saveSnapshot({
    schema: 1,
    goals: [{ id: "g-switch", title: "Release Switch in October", why: "First single of the new era.", status: "active", projectIds: [] }],
    teams: [{ id: "t-artist", name: "ISΛRK artist team", members: ["hemera", "nyx"] }],
    crons: [{ id: "c-standup", name: "Morning standup", owner: "Hemera", team: "t-artist", schedule: { type: "everyMinutes", n: 1 }, focus: GOAL }],
  });

  // 1–2. A focused flow.
  const flow = await runFlow([{ id: "captions", agentId: "nyx", goal: "Draft three captions." }], { model, worker: createStubWorker(), focus: GOAL, enableBaseSpace: true });
  const step = seen.find((s) => s.user === "Draft three captions.")!;
  assert(!!step && step.system.includes("Release Switch in October"), "a flow step's agent gets the goal it serves");
  assert(step.tools.includes("basespace-add"), "and the BaseSpace tools, so what it adds can link back");
  const stepSession = (await listSessions({ agentId: "nyx" })).find((s) => s.title === "Flow step: captions")!;
  assert(stepSession.focus?.id === "g-switch" && !!stepSession.taskId && stepSession.flowId === flow.flowId, "the step session is focused and linked to its task and flow");
  assert((await getFlowFocus(flow.flowId))?.id === "g-switch", "the flow remembers its focus (a resume keeps it)");

  // 3. A focused team cron.
  const done = new Promise<string>((resolve) => {
    const off = subscribeToAllEvents((type, payload) => {
      if (type === "basespace.cron.finished") {
        off();
        resolve(String((payload as { sessionId?: string }).sessionId));
      }
    });
  });
  const runner = startBaseSpaceCronRunner({ model, worker: createStubWorker() });
  const sessionId = await Promise.race([done, new Promise<string>((r) => setTimeout(() => r(""), 10_000))]);
  runner.stop();
  const standup = seen.find((s) => s.user.includes('It\'s time for "Morning standup"'));
  assert(!!sessionId && (await getSession(sessionId))?.focus?.id === "g-switch", "the standup runs in a session focused on the cron's goal");
  assert(!!standup && standup.system.includes("Release Switch in October") && /This meeting serves the goal or project described above/.test(standup.user), "the chair gets the goal, and the prompt says what the meeting serves");

  // 4. The route.
  const gateway = await startGateway({ model, worker: createStubWorker(), enableBaseSpace: true });
  try {
    const post = (body: unknown) => fetch(`http://127.0.0.1:${gateway.port}/flows`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = (await (await post({ steps: [{ id: "a", agentId: "theia", goal: "Find comparables." }], focus: GOAL })).json()) as { id: string };
    assert((await getFlowFocus(created.id))?.id === "g-switch", "POST /flows {focus} stores it");
    assert((await post({ steps: [{ id: "a", agentId: "theia", goal: "x" }], focus: { kind: "mood" } })).status === 400, "an invalid focus is a 400");
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    await gateway.stop();
  }
  if (process.exitCode === 1) console.error("\nSome focused-run tests FAILED.");
  else console.log("\nAll focused-run tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
