// Standalone, end-to-end test for the observability projection
// (observability.ts) — creates REAL Tasks, a REAL dreaming pass, and
// REAL automation fires through the existing core APIs (never mocked),
// then asserts computeMetricsSnapshot() reports the exact counts that
// really landed in the event log. Run with: node dist/test-observability.js
//
// Every assertion below is a before/after DIFF scoped to one dedicated
// agentId, not an absolute count — this keeps the test correct even if
// `npm run demo` (or a previous test run) already left data on disk for
// other agents, matching how demoScheduler()/demoEventBusAndWebhooks()
// in cli.ts already diff counts across a known operation.

import "./test-helpers/isolate.js";
import {
  createTask,
  transitionTask,
  spawnSubagentTask,
  registerAutomation,
  runSchedulerTick,
  fireEventAutomations,
  fireWebhookAutomations,
  writeEpisodic,
  runDreamingPass,
  runTurn,
  newSessionId,
  createStubModel,
  createStubWorker,
  computeMetricsSnapshot,
  fsRead,
} from "./core/index.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

async function main(): Promise<void> {
  const agentId = `observability-test-agent-${Date.now()}`; // unique per run — no cross-run pollution
  const model = createStubModel();
  const worker = createStubWorker();

  const before = await computeMetricsSnapshot(agentId);
  assert(before.tasks.total === 0, "fresh agentId starts with zero tasks (sanity check on scoping)");
  assert(before.dreaming.totalPasses === 0, "fresh agentId starts with zero dreaming passes");
  assert(before.automations.totalFired === 0, "fresh agentId starts with zero automation fires");

  // ---- 1. Tasks: create a known mix of terminal statuses + a subagent task ----
  const succeededTask = await createTask({ type: "cli", agentId, input: {} });
  await transitionTask(succeededTask.id, "running");
  await transitionTask(succeededTask.id, "succeeded", { output: { ok: true } });

  const failedTask = await createTask({ type: "cli", agentId, input: {} });
  await transitionTask(failedTask.id, "running");
  await transitionTask(failedTask.id, "failed", { output: { error: "boom" } });

  const timedOutTask = await createTask({ type: "cron", agentId, input: {} });
  await transitionTask(timedOutTask.id, "running");
  await transitionTask(timedOutTask.id, "timed_out");

  const queuedTask = await createTask({ type: "user-request", agentId, input: {} }); // stays queued, non-terminal

  // Two real subagent delegations, going through the actual subagent.ts
  // primitive (creates a Task with type "subagent", runs it to completion).
  await spawnSubagentTask({ agentId, goal: "run shell: echo one", model, worker });
  await spawnSubagentTask({ agentId, goal: "run shell: echo two", model, worker });

  const afterTasks = await computeMetricsSnapshot(agentId);
  assert(afterTasks.tasks.total === 6, `6 tasks created total (got ${afterTasks.tasks.total})`);
  assert(afterTasks.tasks.byStatus.succeeded === 3, `3 succeeded (1 direct + 2 subagent, got ${afterTasks.tasks.byStatus.succeeded})`);
  assert(afterTasks.tasks.byStatus.failed === 1, `1 failed (got ${afterTasks.tasks.byStatus.failed})`);
  assert(afterTasks.tasks.byStatus.timed_out === 1, `1 timed_out (got ${afterTasks.tasks.byStatus.timed_out})`);
  assert(afterTasks.tasks.byStatus.queued === 1, `1 still queued (got ${afterTasks.tasks.byStatus.queued})`);
  assert(afterTasks.tasks.terminalTotal === 5, `5 reached a terminal status (got ${afterTasks.tasks.terminalTotal})`);
  assert(
    Math.abs((afterTasks.tasks.successRate ?? -1) - 3 / 5) < 1e-9,
    `successRate === 3/5 (got ${afterTasks.tasks.successRate})`,
  );
  assert(
    Math.abs((afterTasks.tasks.failureRate ?? -1) - 1 / 5) < 1e-9,
    `failureRate === 1/5 (got ${afterTasks.tasks.failureRate})`,
  );
  assert(afterTasks.tasks.subagentDelegationCount === 2, `2 subagent delegations counted (got ${afterTasks.tasks.subagentDelegationCount})`);

  // ---- 2. Automations: one of each trigger kind, each fired exactly once ----
  const now = new Date();
  const thisMinuteCron = `${now.getMinutes()} ${now.getHours()} * * *`;
  await registerAutomation({
    trigger: { kind: "cron", expr: thisMinuteCron },
    agentId,
    promptTemplate: "cron check-in",
    enabled: true,
  });
  await registerAutomation({
    trigger: { kind: "event", eventType: "observability-test.event" },
    agentId,
    promptTemplate: "event check-in",
    enabled: true,
  });
  await registerAutomation({
    trigger: { kind: "webhook", path: "/observability-test/hook" },
    agentId,
    promptTemplate: "webhook check-in",
    enabled: true,
  });

  const deps = { model, worker };
  const cronFired = await runSchedulerTick(deps, now);
  assert(cronFired.length === 1, `scheduler tick fired exactly the 1 due cron automation (got ${cronFired.length})`);

  const eventFired = await fireEventAutomations("observability-test.event", {}, deps);
  assert(eventFired.length === 1, `1 event-triggered automation fired (got ${eventFired.length})`);

  const webhookFired = await fireWebhookAutomations("/observability-test/hook", {}, deps);
  assert(webhookFired.length === 1, `1 webhook-triggered automation fired (got ${webhookFired.length})`);

  const afterAutomations = await computeMetricsSnapshot(agentId);
  assert(afterAutomations.automations.registeredCount === 3, `3 automations registered for this agent (got ${afterAutomations.automations.registeredCount})`);
  assert(afterAutomations.automations.totalFired === 3, `3 total fires recorded (got ${afterAutomations.automations.totalFired})`);
  assert(afterAutomations.automations.firesByTriggerKind.cron === 1, `1 cron fire (got ${afterAutomations.automations.firesByTriggerKind.cron})`);
  assert(afterAutomations.automations.firesByTriggerKind.event === 1, `1 event fire (got ${afterAutomations.automations.firesByTriggerKind.event})`);
  assert(afterAutomations.automations.firesByTriggerKind.webhook === 1, `1 webhook fire (got ${afterAutomations.automations.firesByTriggerKind.webhook})`);
  // These fires also created 3 more "cron"-type Tasks (fireAutomation() in
  // scheduler.ts always creates a Task, regardless of trigger kind), so
  // task totals grew too — confirms the two projections agree with each other.
  const totalTasksAfterFires = afterAutomations.tasks.total;
  assert(totalTasksAfterFires === 9, `task ledger grew by the 3 automation firings too (got ${totalTasksAfterFires}, expected 9)`);

  // ---- 3. Dreaming: a pass with a known mix of promoted/held entries ----
  const sourceSessionId = newSessionId();
  await writeEpisodic({
    agentId,
    content: "User always wants observability-test answers in bullet points.",
    kind: "preference",
    sourceSessionId,
    wasExplicitCorrection: true, // scores 50+20 = 70 -> well above PROMOTION_THRESHOLD (40) -> promoted
  });
  await writeEpisodic({
    agentId,
    content: "A totally unremarkable one-off remark that will never repeat.",
    kind: "fact",
    sourceSessionId,
    // no correction, no repetition, no failure signal -> score 0 -> held
  });

  const pass1 = await runDreamingPass(agentId);
  assert(pass1.episodicEntriesReviewed === 2, `dreaming pass reviewed exactly the 2 entries written (got ${pass1.episodicEntriesReviewed})`);
  const promotedCount = pass1.promotions.filter((p) => p.decision === "promoted").length;
  const heldCount = pass1.promotions.filter((p) => p.decision === "held").length;
  assert(promotedCount === 1, `1 entry promoted this pass (got ${promotedCount})`);
  assert(heldCount === 1, `1 entry held this pass (got ${heldCount})`);

  // A second pass with no new writes: still 1 pass added to totalPasses,
  // 2 more entries reviewed (audit trail re-scores every entry every
  // pass — see memory.ts's runDreamingPass doc comment), 0 NEW promotions
  // since the already-promoted entry is deduped out of re-appending, but
  // its eligibility decision is still recorded as "promoted" again.
  const pass2 = await runDreamingPass(agentId);
  assert(pass2.episodicEntriesReviewed === 2, "second dreaming pass reviews the same 2 entries again");

  const afterDreaming = await computeMetricsSnapshot(agentId);
  assert(afterDreaming.dreaming.totalPasses === 2, `2 dreaming passes recorded (got ${afterDreaming.dreaming.totalPasses})`);
  assert(afterDreaming.dreaming.totalEpisodicEntriesReviewed === 4, `4 total entries-reviewed across both passes (got ${afterDreaming.dreaming.totalEpisodicEntriesReviewed})`);
  assert(afterDreaming.dreaming.totalPromoted === 2, `promoted decision recorded twice, once per pass (got ${afterDreaming.dreaming.totalPromoted})`);
  assert(afterDreaming.dreaming.totalHeld === 2, `held decision recorded twice, once per pass (got ${afterDreaming.dreaming.totalHeld})`);
  assert(afterDreaming.dreaming.agentsCovered.includes(agentId), "agentsCovered includes this test's agentId");

  // ---- 4. Turn latency: real agent-loop turns produce real timestamp pairs ----
  const turnSessionId = newSessionId();
  await runTurn({ sessionId: turnSessionId, agentId, userMessage: "run shell: echo latency check one", model, worker });
  await runTurn({ sessionId: turnSessionId, agentId, userMessage: "run shell: echo latency check two", model, worker });

  const afterTurns = await computeMetricsSnapshot(agentId);
  // spawnSubagentTask() and the automation firings above also each ran a
  // real runTurn() internally (2 subagents + 3 automation firings + 2
  // direct turns = 7 turn samples for this agentId).
  assert(afterTurns.turnLatency.sampleCount === 7, `7 turn-latency samples collected (got ${afterTurns.turnLatency.sampleCount})`);
  assert(afterTurns.turnLatency.avgMs !== null && afterTurns.turnLatency.avgMs >= 0, `avgMs is a real non-negative number (got ${afterTurns.turnLatency.avgMs})`);
  assert(
    afterTurns.turnLatency.minMs !== null && afterTurns.turnLatency.maxMs !== null && afterTurns.turnLatency.minMs <= afterTurns.turnLatency.maxMs,
    "minMs <= maxMs",
  );

  // ---- 5. Whole-system snapshot (no agentId) includes this agent's numbers too ----
  const wholeSystem = await computeMetricsSnapshot();
  assert(wholeSystem.tasks.total >= afterTurns.tasks.total, "whole-system task total is >= this agent's own task total");
  assert(wholeSystem.dreaming.totalPasses >= afterDreaming.dreaming.totalPasses, "whole-system dreaming passes >= this agent's own");

  // ---- 6. Reachable through the agent filesystem too (agentfs.ts) ----
  const viaFs = await fsRead("/agent/metrics/summary.json");
  const parsedFromFs = JSON.parse(viaFs) as Awaited<ReturnType<typeof computeMetricsSnapshot>>;
  assert(parsedFromFs.tasks.total === wholeSystem.tasks.total, "fsRead('/agent/metrics/summary.json') matches computeMetricsSnapshot() directly");
  assert(typeof parsedFromFs.generatedAt === "string" && parsedFromFs.generatedAt.length > 0, "fsRead snapshot has a real generatedAt timestamp");

  if (process.exitCode === 1) {
    console.error("\nSome observability tests FAILED.");
  } else {
    console.log("\nAll observability tests passed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
