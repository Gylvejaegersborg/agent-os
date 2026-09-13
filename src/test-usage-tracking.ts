// Standalone tests for token usage tracking (ROADMAP.md's "cost/token
// usage tracking" item) — proves:
//   1. A single-hop turn's model.usage ends up on the turn's own
//      agent.turn.end event AND on runTurn()'s return value.
//   2. A tool-calling turn (multiple model hops) SUMS usage across every
//      hop, not just the last one.
//   3. getSessionUsage() aggregates usage across every turn in a
//      session's whole history.
//   4. A model that never reports usage (the stub, or any model without
//      a `usage` field) produces NO usage field at all on agent.turn.end
//      — never a fabricated {0,0} — and getSessionUsage() reports
//      turnsWithUsage: 0 for such a session.
// Run with: node dist/test-usage-tracking.js

import "./test-helpers/isolate.js";
import { runTurn, getSessionUsage, newSessionId, createStubWorker, type ModelAdapter, type ModelResponse } from "./core/index.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

/** Returns each of `responses` in order, one per complete() call — lets a
 * test script a multi-hop turn (text -> tool call -> text) with a
 * different usage figure reported at each hop. */
function scriptedModel(responses: ModelResponse[]): ModelAdapter {
  let i = 0;
  return {
    id: "scripted",
    async complete() {
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return r;
    },
  };
}

async function testSingleHopUsage(): Promise<void> {
  console.log("\n-- 1. A single-hop turn's usage lands on agent.turn.end and the return value --");
  const sessionId = newSessionId();
  const result = await runTurn({
    sessionId,
    agentId: "usage-test-agent",
    userMessage: "hi",
    model: scriptedModel([{ content: "hello back", usage: { inputTokens: 12, outputTokens: 4 } }]),
    worker: createStubWorker(),
  });
  assert(result.usage?.inputTokens === 12 && result.usage?.outputTokens === 4, `runTurn()'s return value carries the usage (got ${JSON.stringify(result.usage)})`);

  const usage = await getSessionUsage(sessionId);
  assert(usage.inputTokens === 12 && usage.outputTokens === 4, `getSessionUsage() reflects the same figures (got ${JSON.stringify(usage)})`);
  assert(usage.turnsWithUsage === 1, "exactly one turn reported usage");
}

async function testMultiHopUsageSums(): Promise<void> {
  console.log("\n-- 2. A tool-calling turn sums usage across every hop, not just the last --");
  const sessionId = newSessionId();
  const result = await runTurn({
    sessionId,
    agentId: "usage-test-agent",
    userMessage: "run something",
    model: scriptedModel([
      { content: "running it", toolCall: { name: "shell", args: { command: "echo hi" } }, usage: { inputTokens: 20, outputTokens: 5 } },
      { content: "done", usage: { inputTokens: 30, outputTokens: 8 } },
    ]),
    worker: createStubWorker(),
  });
  assert(result.usage?.inputTokens === 50, `input tokens summed across both hops (got ${result.usage?.inputTokens})`);
  assert(result.usage?.outputTokens === 13, `output tokens summed across both hops (got ${result.usage?.outputTokens})`);
}

async function testSessionAggregation(): Promise<void> {
  console.log("\n-- 3. getSessionUsage() aggregates across multiple turns in one session --");
  const sessionId = newSessionId();
  await runTurn({
    sessionId,
    agentId: "usage-test-agent",
    userMessage: "first",
    model: scriptedModel([{ content: "ok", usage: { inputTokens: 10, outputTokens: 2 } }]),
    worker: createStubWorker(),
  });
  await runTurn({
    sessionId,
    agentId: "usage-test-agent",
    userMessage: "second",
    model: scriptedModel([{ content: "ok again", usage: { inputTokens: 15, outputTokens: 3 } }]),
    worker: createStubWorker(),
  });
  const usage = await getSessionUsage(sessionId);
  assert(usage.inputTokens === 25 && usage.outputTokens === 5, `usage is summed across both turns (got ${JSON.stringify(usage)})`);
  assert(usage.turnsWithUsage === 2, "both turns are counted");
}

async function testNoUsageReportedIsHonest(): Promise<void> {
  console.log("\n-- 4. A model that never reports usage leaves NO usage field, not a fabricated {0,0} --");
  const sessionId = newSessionId();
  const result = await runTurn({
    sessionId,
    agentId: "usage-test-agent",
    userMessage: "hi",
    model: scriptedModel([{ content: "hello, no usage reported here" }]),
    worker: createStubWorker(),
  });
  assert(result.usage === undefined, "runTurn()'s return value has no usage field at all");

  const usage = await getSessionUsage(sessionId);
  assert(usage.inputTokens === 0 && usage.outputTokens === 0, "aggregated totals are zero");
  assert(usage.turnsWithUsage === 0, "turnsWithUsage is 0 — distinguishable from 'a real turn that used zero tokens'");
}

async function main(): Promise<void> {
  await testSingleHopUsage();
  await testMultiHopUsageSums();
  await testSessionAggregation();
  await testNoUsageReportedIsHonest();

  if (process.exitCode === 1) {
    console.error("\nSome usage-tracking tests FAILED.");
  } else {
    console.log("\nAll usage-tracking tests passed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
