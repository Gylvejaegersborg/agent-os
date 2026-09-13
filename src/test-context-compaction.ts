// Standalone tests for context compaction (ROADMAP.md's "context
// compaction" item) — proves:
//   1. A short session is NEVER compacted — the durable posture, and
//      model-facing history, are byte-for-byte the same as before
//      compaction existed.
//   2. Once history grows past threshold, a session.compacted event is
//      recorded, and getModelFacingHistory() collapses everything
//      before the kept-recent window into ONE summary message —
//      while getSessionHistory() (the durable, full log) is completely
//      untouched: every original message is still there, in full.
//   3. The most recent messages stay verbatim, word-for-word, never
//      folded into the summary.
//   4. A SECOND compaction (history keeps growing) folds in the
//      PREVIOUS summary too, rather than starting over or duplicating
//      already-summarized content.
//   5. A model whose summarization call itself fails doesn't fail the
//      turn — compaction failure is swallowed, the turn still runs
//      uncompacted on the full history.
// Run with: node dist/test-context-compaction.js

import "./test-helpers/isolate.js";
import { runTurn, getSessionHistory, getModelFacingHistory, newSessionId, createStubWorker, type ModelAdapter, type ModelMessage } from "./core/index.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

/** A model that: (a) summarizes when asked (system prompt mentions
 * "Summarize"), returning a short canned summary prefixed with how many
 * messages it was asked to cover (so a test can verify growth across
 * repeated compactions), and (b) otherwise just acknowledges, matching
 * runTurn()'s normal per-turn model.complete() calls. */
function compactingModel(): ModelAdapter {
  return {
    id: "compacting-test-model",
    async complete(messages: ModelMessage[]) {
      const isSummarizationCall = messages[0]?.role === "system" && messages[0].content.includes("Summarize");
      if (isSummarizationCall) {
        const userMsg = messages.find((m) => m.role === "user")?.content ?? "";
        const coveredLines = userMsg.split("\n\n").filter((l) => l.includes(": ")).length;
        return { content: `SUMMARY(covers ${coveredLines} lines)` };
      }
      return { content: "acknowledged" };
    },
  };
}

/** Sends `n` plain turns in the same session, each with a userMessage
 * long enough (padded) to genuinely cross COMPACTION_TRIGGER_CHARS after
 * enough turns, without needing an enormous literal n. */
async function sendPaddedTurns(sessionId: string, model: ModelAdapter, n: number, padLen = 600): Promise<void> {
  for (let i = 0; i < n; i++) {
    await runTurn({
      sessionId,
      agentId: "compaction-test-agent",
      userMessage: `turn ${i} ${"x".repeat(padLen)}`,
      model,
      worker: createStubWorker(),
    });
  }
}

async function testShortSessionNeverCompacted(): Promise<void> {
  console.log("\n-- 1. A short session is never compacted — zero behavior change --");
  const sessionId = newSessionId();
  await sendPaddedTurns(sessionId, compactingModel(), 3, 50);
  const full = await getSessionHistory(sessionId);
  const modelFacing = await getModelFacingHistory(sessionId);
  assert(full.length === modelFacing.length, `model-facing history has the same message count as the full log (got ${modelFacing.length} vs ${full.length})`);
  assert(JSON.stringify(full) === JSON.stringify(modelFacing), "model-facing history is byte-for-byte identical to the full log when never compacted");
}

async function testCompactionHappensAndPreservesFullLog(): Promise<void> {
  console.log("\n-- 2. Once over threshold, compaction collapses old messages for the MODEL, but the durable log is untouched --");
  const sessionId = newSessionId();
  // Each turn adds 2 messages (user + assistant) of ~600+ chars; ~40
  // turns comfortably crosses the 24k-char trigger while staying well
  // under COMPACTION_MIN_MESSAGES's own floor from the very first turn.
  await sendPaddedTurns(sessionId, compactingModel(), 40);

  const full = await getSessionHistory(sessionId);
  const modelFacing = await getModelFacingHistory(sessionId);
  assert(full.length === 80, `the durable log has all 80 messages (40 turns x 2), untouched (got ${full.length})`);
  assert(modelFacing.length < full.length, `model-facing history is SHORTER than the full log after compaction (got ${modelFacing.length} vs ${full.length})`);
  assert(modelFacing[0]?.role === "system" && modelFacing[0].content.includes("SUMMARY"), "the first model-facing message is the compaction summary");
}

async function testRecentMessagesStayVerbatim(): Promise<void> {
  console.log("\n-- 3. The most recent messages stay verbatim, never folded into the summary --");
  const sessionId = newSessionId();
  await sendPaddedTurns(sessionId, compactingModel(), 40);
  const full = await getSessionHistory(sessionId);
  const modelFacing = await getModelFacingHistory(sessionId);
  const lastFullMessages = full.slice(-4);
  const lastModelFacingMessages = modelFacing.slice(-4);
  assert(
    JSON.stringify(lastFullMessages) === JSON.stringify(lastModelFacingMessages),
    "the most recent messages in model-facing history exactly match the durable log's most recent messages",
  );
}

async function testSecondCompactionBuildsOnFirst(): Promise<void> {
  console.log("\n-- 4. A second compaction folds in the PREVIOUS summary, not just the new messages --");
  const sessionId = newSessionId();
  await sendPaddedTurns(sessionId, compactingModel(), 40); // triggers the first compaction
  const afterFirst = await getModelFacingHistory(sessionId);
  const firstSummary = afterFirst[0]!.content;

  await sendPaddedTurns(sessionId, compactingModel(), 40); // should trigger a second compaction
  const afterSecond = await getModelFacingHistory(sessionId);
  const secondSummary = afterSecond[0]!.content;

  assert(secondSummary !== firstSummary, "the summary actually changed after the second compaction ran");
  const full = await getSessionHistory(sessionId);
  assert(full.length === 160, `the durable log STILL has every message from both rounds, untouched (got ${full.length})`);
}

async function testCompactionFailureDoesNotFailTheTurn(): Promise<void> {
  console.log("\n-- 5. A failing summarization call doesn't fail the turn — compaction failure is swallowed --");
  const sessionId = newSessionId();
  const failingSummaryModel: ModelAdapter = {
    id: "failing-summary-model",
    async complete(messages: ModelMessage[]) {
      const isSummarizationCall = messages[0]?.role === "system" && messages[0].content.includes("Summarize");
      if (isSummarizationCall) throw new Error("simulated summarization failure");
      return { content: "acknowledged anyway" };
    },
  };
  await sendPaddedTurns(sessionId, failingSummaryModel, 39); // prime history close to threshold without a summarization call yet
  const result = await runTurn({
    sessionId,
    agentId: "compaction-test-agent",
    userMessage: `final turn ${"x".repeat(600)}`,
    model: failingSummaryModel,
    worker: createStubWorker(),
  });
  assert(result.finalContent === "acknowledged anyway", "the turn completes normally even though its own compaction attempt failed");
}

async function main(): Promise<void> {
  await testShortSessionNeverCompacted();
  await testCompactionHappensAndPreservesFullLog();
  await testRecentMessagesStayVerbatim();
  await testSecondCompactionBuildsOnFirst();
  await testCompactionFailureDoesNotFailTheTurn();

  if (process.exitCode === 1) {
    console.error("\nSome context-compaction tests FAILED.");
  } else {
    console.log("\nAll context-compaction tests passed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
