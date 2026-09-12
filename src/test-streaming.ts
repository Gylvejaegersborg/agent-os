// Standalone tests for true incremental token streaming — proves:
//   1. createStubModel().completeStream() delivers the SAME final
//      response complete() would, via multiple discrete onDelta calls
//      whose concatenation reconstructs the full text.
//   2. runTurn() (agent-loop.ts), when given a streaming-capable model,
//      publishes real `agent.turn.delta` events on the event bus AS THE
//      RESPONSE ARRIVES — not just the final assembled text once the
//      whole call finishes — and the durable session.message event still
//      only ever contains ONE final entry per turn (deltas are NOT
//      individually persisted to the durable log).
//   3. A model WITHOUT completeStream behaves byte-for-byte as before
//      this feature existed — no agent.turn.delta events at all,
//      pure regression proof for every existing model adapter.
//   4. createRecordingModel() correctly passes streaming through when the
//      wrapped model supports it, and correctly has NO completeStream at
//      all when the wrapped model doesn't (so runTurn()'s
//      `model.completeStream ? ... : ...` check still falls back
//      correctly even through the wrapper).
// Run with: node dist/test-streaming.js

import "./test-helpers/isolate.js";
import {
  createStubModel,
  createRecordingModel,
  runTurn,
  newSessionId,
  createStubWorker,
  subscribeToEvent,
  readStream,
  type ModelAdapter,
  type ModelMessage,
} from "./core/index.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

async function testStubStreamingMatchesComplete(): Promise<void> {
  console.log("\n-- 1. createStubModel().completeStream() delivers real incremental chunks --");
  const model = createStubModel();
  const messages: ModelMessage[] = [{ role: "user", content: "hello there" }];

  const nonStreamed = await model.complete(messages);

  const chunks: string[] = [];
  const streamed = await model.completeStream!(messages, (delta) => chunks.push(delta));

  assert(streamed.content === nonStreamed.content, "completeStream()'s final content matches complete()'s for the same input");
  assert(chunks.length > 1, `onDelta was called more than once (got ${chunks.length} chunks) — genuinely incremental, not one big chunk`);
  assert(chunks.join("") === streamed.content, "concatenating every delta reconstructs the exact final content");
}

async function testRunTurnPublishesDeltasNotDurable(): Promise<void> {
  console.log("\n-- 2. runTurn() publishes real agent.turn.delta events; durable log stays one entry per turn --");
  const sessionId = newSessionId();
  const agentId = "streaming-test-agent";

  const deltasReceived: string[] = [];
  const unsubscribe = subscribeToEvent("agent.turn.delta", (_type, payload) => {
    if (payload.sessionId === sessionId) deltasReceived.push(String(payload.delta));
  });

  const result = await runTurn({
    sessionId,
    agentId,
    userMessage: "hello there, please stream this back",
    model: createStubModel(),
    worker: createStubWorker(),
  });

  unsubscribe();

  assert(deltasReceived.length > 1, `multiple agent.turn.delta events were published (got ${deltasReceived.length})`);
  assert(
    deltasReceived.join("") === result.finalContent,
    "concatenating every published delta reconstructs the turn's actual finalContent",
  );

  const sessionEvents = await readStream(`session:${sessionId}`);
  const messageEvents = sessionEvents.filter((e) => e.type === "session.message" && (e.payload as any).role === "assistant");
  assert(
    messageEvents.length === 1,
    `the durable session stream still has exactly ONE assistant session.message for this turn, not one per delta (got ${messageEvents.length})`,
  );
  assert(
    (messageEvents[0]!.payload as any).content === result.finalContent,
    "that one durable message's content is the full, final text",
  );

  const deltaEventsInDurableLog = sessionEvents.filter((e) => e.type === "agent.turn.delta");
  assert(
    deltaEventsInDurableLog.length === 0,
    "agent.turn.delta events are NOT written to the durable session stream at all — bus-only, by design",
  );
}

function nonStreamingEchoModel(): ModelAdapter {
  return {
    id: "non-streaming-echo",
    async complete(messages) {
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      return { content: `echo: ${lastUser?.content ?? ""}` };
    },
    // deliberately no completeStream
  };
}

async function testNonStreamingModelUnaffected(): Promise<void> {
  console.log("\n-- 3. A model without completeStream: zero agent.turn.delta events, unchanged behavior --");
  const sessionId = newSessionId();
  const deltasReceived: string[] = [];
  const unsubscribe = subscribeToEvent("agent.turn.delta", (_type, payload) => {
    if (payload.sessionId === sessionId) deltasReceived.push(String(payload.delta));
  });

  const result = await runTurn({
    sessionId,
    agentId: "streaming-test-agent",
    userMessage: "plain non-streaming turn",
    model: nonStreamingEchoModel(),
    worker: createStubWorker(),
  });

  unsubscribe();

  assert(deltasReceived.length === 0, "zero agent.turn.delta events were published for a model with no completeStream");
  assert(result.finalContent === "echo: plain non-streaming turn", "the turn's result is exactly what the non-streaming model returned, unaffected by the streaming code path existing");
}

async function testRecordingModelWrapping(): Promise<void> {
  console.log("\n-- 4. createRecordingModel() correctly passes through (or omits) completeStream --");
  const streamingInner = createStubModel();
  const wrappedStreaming = createRecordingModel(streamingInner);
  assert(typeof wrappedStreaming.completeStream === "function", "wrapping a model WITH completeStream produces a wrapper that also has it");

  const chunks: string[] = [];
  await wrappedStreaming.completeStream!([{ role: "user", content: "wrapped streaming check" }], (d) => chunks.push(d));
  assert(chunks.length > 1, "the wrapped completeStream genuinely streams (multiple chunks), not just delegating to complete()");
  assert(wrappedStreaming.lastMessages()?.[0]?.content === "wrapped streaming check", "the wrapper still records messages passed through completeStream(), same as it does for complete()");

  const nonStreamingInner = nonStreamingEchoModel();
  const wrappedNonStreaming = createRecordingModel(nonStreamingInner);
  assert(
    wrappedNonStreaming.completeStream === undefined,
    "wrapping a model WITHOUT completeStream produces a wrapper with NO completeStream at all (not a stub that silently no-ops)",
  );
}

async function main(): Promise<void> {
  await testStubStreamingMatchesComplete();
  await testRunTurnPublishesDeltasNotDurable();
  await testNonStreamingModelUnaffected();
  await testRecordingModelWrapping();

  if (process.exitCode === 1) {
    console.error("\nSome streaming tests FAILED.");
  } else {
    console.log("\nAll streaming tests passed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
