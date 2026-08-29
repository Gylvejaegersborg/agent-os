// Standalone tests for the Heartbeat scheduling mode (heartbeat.ts) —
// proves the three properties that make it genuinely different from
// Automations (scheduler.ts), not just a renamed copy:
//   1. No Task is ever created by a heartbeat tick.
//   2. Context accumulates across ticks (same session, full history).
//   3. Timing has jitter — consecutive intervals are not identical.
// Run with: node dist/test-heartbeat.js

import "./test-helpers/isolate.js";
import {
  runHeartbeatTick,
  startHeartbeat,
  createStubModel,
  createStubWorker,
  newSessionId,
  listTasks,
  getSessionHistory,
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
  const agentId = "heartbeat-test-agent";
  const sessionId = newSessionId();
  const model = createStubModel();
  const worker = createStubWorker();

  // 1. No Task is created by a heartbeat tick (unlike scheduler.ts's
  // fireAutomation, which always creates a type:"cron" Task).
  const tasksBefore = await listTasks({ agentId });
  await runHeartbeatTick({
    agentId,
    sessionId,
    promptTemplate: "First check-in.",
    model,
    worker,
    intervalMs: 1000,
  });
  const tasksAfter = await listTasks({ agentId });
  assert(tasksAfter.length === tasksBefore.length, "a heartbeat tick creates NO Task in the ledger");

  // 2. Context accumulates: two ticks into the SAME session should both
  // show up in that session's history, proving each tick sees the
  // previous one's turn (full main-session context, per the architecture
  // doc) rather than starting fresh each time (which is what Automations do).
  await runHeartbeatTick({
    agentId,
    sessionId,
    promptTemplate: "Second check-in.",
    model,
    worker,
    intervalMs: 1000,
  });
  const history = await getSessionHistory(sessionId);
  const userMessages = history.filter((m) => m.role === "user").map((m) => m.content);
  assert(
    userMessages.includes("First check-in.") && userMessages.includes("Second check-in."),
    "both ticks' prompts are present in the SAME session's accumulated history",
  );

  // 3. Timing has jitter: run several intervals through startHeartbeat's
  // scheduling logic indirectly by checking the delay is NOT always
  // exactly intervalMs. We test this by starting a heartbeat with a short
  // interval + large jitter and checking actual elapsed gaps vary.
  const tickTimestamps: number[] = [];
  const handle = startHeartbeat({
    agentId,
    promptTemplate: "Jitter test tick.",
    model,
    worker,
    intervalMs: 300,
    jitterMs: 250, // large relative to interval, to make variation obvious
  });

  await new Promise<void>((resolve) => {
    const poll = setInterval(async () => {
      const hist = await getSessionHistory(handle.sessionId);
      const count = hist.filter((m) => m.role === "user").length;
      if (count > tickTimestamps.length) {
        tickTimestamps.push(Date.now());
      }
      if (tickTimestamps.length >= 4) {
        clearInterval(poll);
        resolve();
      }
    }, 50);
    // Safety timeout in case ticks are slower than expected.
    setTimeout(() => {
      clearInterval(poll);
      resolve();
    }, 8000);
  });
  handle.stop();

  const gaps: number[] = [];
  for (let i = 1; i < tickTimestamps.length; i++) {
    gaps.push(tickTimestamps[i] - tickTimestamps[i - 1]);
  }
  assert(gaps.length >= 2, `collected at least 2 gaps between ticks (got ${gaps.length})`);
  const allIdentical = gaps.every((g) => g === gaps[0]);
  assert(!allIdentical, `consecutive tick gaps are NOT all identical (jitter present): [${gaps.join(", ")}]`);

  if (process.exitCode === 1) {
    console.error("\nSome heartbeat tests FAILED.");
  } else {
    console.log("\nAll heartbeat tests passed.");
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
