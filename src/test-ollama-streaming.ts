// Standalone test for createOllamaModel()'s completeStream() — mocks
// global.fetch to simulate Ollama's OpenAI-compatible SSE stream, since
// this codebase's convention for the real provider adapters (real.ts) is
// a manual, credentials-gated live smoke test (test-live-model.ts), not
// an automated one — reasonable for "does the real API still accept
// this shape," but NOT a substitute for testing the actual SSE-parsing
// logic itself, which is exactly the kind of easy-to-get-subtly-wrong
// code (partial frames split across chunks, multi-chunk tool-call
// argument accumulation) that deserves a real test. Proves:
//   1. Text deltas accumulate in order and onDelta is called once per
//      chunk, not just once at the end.
//   2. A tool call's name + incrementally-streamed argument fragments
//      (the exact shape Ollama's own OpenAI-compatible endpoint uses)
//      are reassembled correctly into one parsed JSON object.
//   3. A malformed/partial JSON frame is skipped rather than crashing
//      the whole stream.
//   4. An SSE frame split across TWO separate fetch chunks (the
//      buffer/carry-over logic) still parses correctly.
// Run with: node dist/test-ollama-streaming.js

import "./test-helpers/isolate.js";
import { createOllamaModel, fetchWithOllamaRetry } from "./core/models/real.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

/** Builds a fake Response whose body is a ReadableStream yielding exactly
 * the given raw text chunks, one per underlying read() — lets a test
 * control precisely how SSE frames are split across reads, including
 * splitting a single frame across two chunks. */
function fakeSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]));
        i++;
      } else {
        controller.close();
      }
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function withMockedFetch<T>(chunks: string[], run: () => Promise<T>): Promise<T> {
  const real = global.fetch;
  global.fetch = (async () => fakeSseResponse(chunks)) as typeof fetch;
  try {
    return await run();
  } finally {
    global.fetch = real;
  }
}

async function testTextStreaming(): Promise<void> {
  console.log("\n-- 1. Text deltas accumulate in order, onDelta called per chunk --");
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: "lo, " } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: "world!" } }] })}\n\n`,
    "data: [DONE]\n\n",
  ];
  const deltas: string[] = [];
  const model = createOllamaModel({ model: "test-model" });
  const result = await withMockedFetch(chunks, () =>
    model.completeStream!([{ role: "user", content: "hi" }], (d) => deltas.push(d)),
  );
  assert(deltas.length === 3, `onDelta was called once per chunk (got ${deltas.length})`);
  assert(deltas.join("") === "Hello, world!", `the deltas concatenate to the full text (got "${deltas.join("")}")`);
  assert(result.content === "Hello, world!", `the final result.content matches (got "${result.content}")`);
  assert(result.toolCall === undefined, "no toolCall when none was streamed");
}

async function testToolCallStreaming(): Promise<void> {
  console.log("\n-- 2. A tool call's name + multi-chunk arguments reassemble correctly --");
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "shell", arguments: "" } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":' } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"echo hi"}' } }] } }] })}\n\n`,
    "data: [DONE]\n\n",
  ];
  const model = createOllamaModel({ model: "test-model" });
  const result = await withMockedFetch(chunks, () => model.completeStream!([{ role: "user", content: "run echo" }], () => {}));
  assert(result.toolCall?.name === "shell", `the tool call's name is reassembled (got "${result.toolCall?.name}")`);
  assert(result.toolCall?.args.command === "echo hi", `the tool call's args are reassembled from fragments (got ${JSON.stringify(result.toolCall?.args)})`);
}

async function testMalformedFrameSkipped(): Promise<void> {
  console.log("\n-- 3. A malformed frame is skipped, not fatal --");
  const chunks = [
    `data: {not valid json\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: "still works" } }] })}\n\n`,
    "data: [DONE]\n\n",
  ];
  const model = createOllamaModel({ model: "test-model" });
  const result = await withMockedFetch(chunks, () => model.completeStream!([{ role: "user", content: "hi" }], () => {}));
  assert(result.content === "still works", `parsing continues past a malformed frame (got "${result.content}")`);
}

async function testFrameSplitAcrossChunks(): Promise<void> {
  console.log("\n-- 4. One SSE frame split across two separate fetch chunks still parses --");
  const whole = `data: ${JSON.stringify({ choices: [{ delta: { content: "split-frame-ok" } }] })}\n\n`;
  const splitPoint = Math.floor(whole.length / 2);
  const chunks = [whole.slice(0, splitPoint), whole.slice(splitPoint), "data: [DONE]\n\n"];
  const model = createOllamaModel({ model: "test-model" });
  const result = await withMockedFetch(chunks, () => model.completeStream!([{ role: "user", content: "hi" }], () => {}));
  assert(result.content === "split-frame-ok", `a frame split mid-JSON across two chunks still parses correctly (got "${result.content}")`);
}

async function testRetriesConnectionFailureThenSucceeds(): Promise<void> {
  console.log("\n-- 5. fetchWithOllamaRetry() retries a connection-level failure, then succeeds --");
  const real = global.fetch;
  let calls = 0;
  global.fetch = (async () => {
    calls++;
    if (calls < 3) throw new TypeError("fetch failed"); // simulates Ollama's server not accepting connections YET
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  try {
    const res = await fetchWithOllamaRetry("http://localhost:11434/v1/chat/completions", {}, "test-model", 3, 10);
    assert(res.status === 200, "the retried call eventually succeeds once the connection stops failing");
    assert(calls === 3, `fetch was actually retried (attempted exactly 3 times before succeeding, got ${calls})`);
  } finally {
    global.fetch = real;
  }
}

async function testRetriesExhaustedThrowsClearError(): Promise<void> {
  console.log("\n-- 6. Exhausting all retry attempts throws a clear, actionable error --");
  const real = global.fetch;
  let calls = 0;
  global.fetch = (async () => {
    calls++;
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  try {
    let threw = false;
    try {
      await fetchWithOllamaRetry("http://localhost:11434/v1/chat/completions", {}, "test-model", 3, 10);
    } catch (err) {
      threw = true;
      assert((err as Error).message.includes("after 3 attempts"), `the error names how many attempts were made (got: "${(err as Error).message}")`);
      assert((err as Error).message.includes("ollama serve"), "the error still gives the same actionable troubleshooting hint as before retry existed");
    }
    assert(threw, "exhausting all attempts throws rather than hanging or silently resolving");
    assert(calls === 3, `fetch was attempted exactly 3 times, not more or fewer (got ${calls})`);
  } finally {
    global.fetch = real;
  }
}

async function testHttpErrorResponseIsNotRetried(): Promise<void> {
  console.log("\n-- 7. A real HTTP error RESPONSE (server up, request rejected) is NOT retried --");
  const real = global.fetch;
  let calls = 0;
  global.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ error: "model not found" }), { status: 404 });
  }) as typeof fetch;
  try {
    const res = await fetchWithOllamaRetry("http://localhost:11434/v1/chat/completions", {}, "test-model", 3, 10);
    assert(res.status === 404, "the 404 response is returned as-is");
    assert(calls === 1, `an HTTP error response is NOT retried — only connection-level failures are (got ${calls} call(s))`);
  } finally {
    global.fetch = real;
  }
}

async function main(): Promise<void> {
  await testTextStreaming();
  await testToolCallStreaming();
  await testMalformedFrameSkipped();
  await testFrameSplitAcrossChunks();
  await testRetriesConnectionFailureThenSucceeds();
  await testRetriesExhaustedThrowsClearError();
  await testHttpErrorResponseIsNotRetried();

  if (process.exitCode === 1) {
    console.error("\nSome ollama-streaming tests FAILED.");
  } else {
    console.log("\nAll ollama-streaming tests passed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
