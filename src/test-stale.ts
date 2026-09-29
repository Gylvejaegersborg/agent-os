// Tests for stale-work visibility (core/stale.ts).
// Proves: an in-progress work item whose run went quiet is listed; one with
// recent session activity isn't; a running task that only renews liveness
// is listed as quiet; lost/failed runs from the last day are listed, older
// ones aren't; nothing is changed by looking. Plus GET /stale.
// Run with: node dist/test-stale.js

import "./test-helpers/isolate.js";
process.env.CLAUDE_CLI_PATH = "/nonexistent/claude";

import {
  OPERATOR,
  appendEvent,
  claimWork,
  createStubModel,
  createStubWorker,
  createTask,
  createWork,
  getWork,
  listStaleWork,
  renewTaskLiveness,
  seedDefaultAgents,
  transitionTask,
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

const MIN = 60_000;

async function main(): Promise<void> {
  await seedDefaultAgents();
  const hung = await createWork({ title: "Mix notes", assignee: "aether", requestedBy: OPERATOR });
  await claimWork(hung.id, "aether", "s-hung");
  await appendEvent("session:s-hung", "session.message", { role: "user", content: "[Work] …" });
  const busy = await createWork({ title: "Captions", assignee: "nyx", requestedBy: OPERATOR });
  await claimWork(busy.id, "nyx", "s-busy");

  const quietTask = await createTask({ type: "cron", agentId: "hemera", input: { goal: "Morning standup" } });
  await transitionTask(quietTask.id, "running");
  await renewTaskLiveness(quietTask.id); // alive, but doing nothing
  const lost = await createTask({ type: "subagent", agentId: "theia", input: { goal: "Research comparable artists" } });
  await transitionTask(lost.id, "running");
  await transitionTask(lost.id, "lost", { reason: "restart" });

  // 30 minutes on, nothing has happened anywhere.
  const now = Date.now() + 30 * MIN;
  const stale = await listStaleWork({ now, quietMs: 20 * MIN });

  assert(stale.some((e) => e.kind === "work" && e.id === hung.id && /nothing has happened for 30 min/.test(e.why)), "a work item whose run went quiet is listed, with how long");
  assert(stale.some((e) => e.kind === "run" && e.id === quietTask.id && /only renewing liveness/.test(e.why)), "a running task that only renews liveness is listed as quiet");
  assert(stale.some((e) => e.kind === "run" && e.id === lost.id && /^lost/.test(e.why)), "a run lost in the last day is listed");
  assert(!(await listStaleWork({ now: Date.now() + 25 * 3_600_000, quietMs: 20 * MIN })).some((e) => e.id === lost.id), "one that ended over a day ago isn't");
  assert(!(await listStaleWork({ quietMs: 20 * MIN })).some((e) => e.id === busy.id || e.id === hung.id), "freshly active work isn't listed");
  assert((await getWork(hung.id))!.status === "in_progress", "looking changes nothing: the item is still in progress");

  const gateway = await startGateway({ model: createStubModel(), worker: createStubWorker() });
  try {
    const res = (await (await fetch(`http://127.0.0.1:${gateway.port}/stale`)).json()) as { stale: { id: string }[]; quietMinutes: number };
    assert(res.quietMinutes === 20 && res.stale.some((e) => e.id === lost.id), "GET /stale");
  } finally {
    await gateway.stop();
  }
  if (process.exitCode === 1) console.error("\nSome stale-work tests FAILED.");
  else console.log("\nAll stale-work tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
