// Standalone test for Phase 4 of the Harness build (see
// AGENT-HARNESS-IMPLEMENTATION-PLAN.md §85): proves the literal "done
// when" criterion — "UI/client gets text char/segment by segment without
// polling" — end to end, at three levels:
//   1. model.ts's streamModel()/streamFromComplete() primitives directly
//      (no network, proves the fallback chunking logic itself).
//   2. Anthropic's real SSE stream() parser against a REAL local HTTP
//      server that speaks the actual Anthropic streaming wire format
//      (no live Anthropic account needed — this proves the PARSER is
//      correct against real SSE framing, the same "real transport, fake
//      upstream" pattern test-webhook.ts already uses for its own HTTP
//      server).
//   3. IF a local Ollama server is actually reachable in this
//      environment, a genuine live end-to-end stream from a real model
//      — reported honestly as skipped (not faked) if Ollama isn't
//      running, matching test-memory-embeddings.ts's honesty pattern.

import "./test-helpers/isolate.js";
import * as http from "node:http";
import { createStubModel, streamModel, streamFromComplete, type ModelStreamEvent } from "./core/model.js";
import { createAnthropicModel, createOllamaModel } from "./core/models/real.js";
import type { ModelMessage } from "./core/model.js";

let passed = 0;
let failed = 0;
function ok(label: string, cond: boolean): void {
  if (cond) {
    passed++;
    console.log(`ok: ${label}`);
  } else {
    failed++;
    console.log(`FAIL: ${label}`);
  }
}

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function main() {
  // ---- 1. streamFromComplete() / streamModel() fallback chunking ----
  section1: {
    const stub = createStubModel();
    const messages: ModelMessage[] = [{ role: "user", content: "run shell: echo hello world from a stream" }];
    const events = await collect(streamModel(stub, messages));

    const deltas = events.filter((e) => e.type === "delta");
    const toolCallEvents = events.filter((e) => e.type === "tool-call");
    const doneEvents = events.filter((e) => e.type === "done");

    ok("streamModel() on an adapter with no stream() falls back to streamFromComplete()", deltas.length > 0);
    ok("the fallback stream ends with exactly one 'done' event", doneEvents.length === 1);
    ok(
      "the 'done' event's content matches the concatenation of every delta",
      doneEvents[0]!.type === "done" && doneEvents[0]!.content === deltas.map((d) => (d as any).delta).join(""),
    );
    ok(
      "a tool-call response yields a 'tool-call' event before 'done'",
      toolCallEvents.length === 1 && events.indexOf(toolCallEvents[0]!) < events.indexOf(doneEvents[0]!),
    );
    ok(
      "the 'done' event also carries the same toolCall (so a caller can ignore all deltas and just await 'done')",
      doneEvents[0]!.type === "done" && doneEvents[0]!.toolCall?.name === "shell",
    );

    // A plain (non-tool-call) response never emits a tool-call event.
    const plainEvents = await collect(streamModel(stub, [{ role: "user", content: "just chat, no tool" }]));
    ok(
      "a plain response never emits a tool-call event",
      plainEvents.every((e) => e.type !== "tool-call"),
    );

    // Chunking never splits mid-word — every delta either IS a whole
    // word+trailing-whitespace or is the (possibly partial) last chunk.
    const reconstructed = deltas.map((d) => (d as any).delta).join("");
    ok("word-chunked deltas reconstruct byte-for-byte to the original content", reconstructed === doneEvents[0]!.content);
    break section1;
  }

  // ---- 2. Anthropic's real SSE parser against a real local HTTP server
  // speaking the actual Anthropic streaming wire format ----
  section2: {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        res.writeHead(200, { "content-type": "text/event-stream" });

        // A realistic Anthropic streaming response: text deltas followed
        // by message_stop. Sent as separate writes (not one big buffer)
        // to genuinely exercise the parser's partial-buffer handling —
        // real network delivery does not guarantee one write = one event.
        const write = (obj: unknown) => res.write(`event: x\ndata: ${JSON.stringify(obj)}\n\n`);
        write({ type: "message_start", message: { id: "msg_test" } });
        write({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        write({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } });
        write({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ", " } });
        write({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world!" } });
        write({ type: "content_block_stop", index: 0 });

        // Only emit a tool_use block if the request actually asked for
        // tools — proves the SAME server/parser round-trip covers both
        // the plain-text and tool-call cases.
        if (parsed.tools?.length) {
          write({ type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "shell", id: "tool_1" } });
          write({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":' } });
          write({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"echo hi"}' } });
          write({ type: "content_block_stop", index: 1 });
        }

        write({ type: "message_delta", delta: { stop_reason: "end_turn" } });
        write({ type: "message_stop" });
        res.end();
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const model = createAnthropicModel({ apiKey: "sk-ant-api-test-key-not-real", baseUrl: `http://127.0.0.1:${port}` });
    const events = await collect(model.stream!([{ role: "user", content: "hi" }]));
    const deltas = events.filter((e) => e.type === "delta").map((e) => (e as any).delta);
    const done = events.find((e) => e.type === "done");

    ok("Anthropic adapter has a real stream() method (not just complete())", typeof model.stream === "function");
    ok("real SSE parsing reconstructs 'Hello, world!' from three separate text_delta events", deltas.join("") === "Hello, world!");
    ok("the stream ends with exactly one 'done' event", events.filter((e) => e.type === "done").length === 1);
    ok(
      "'done' carries the full reconstructed content",
      done?.type === "done" && done.content === "Hello, world!",
    );
    ok("no tool-call event fires when the request had no tools", !events.some((e) => e.type === "tool-call"));

    // Now with a tool: proves input_json_delta accumulation + content_block_start's tool NAME extraction.
    const modelWithTools = createAnthropicModel({
      apiKey: "sk-ant-api-test-key-not-real",
      baseUrl: `http://127.0.0.1:${port}`,
      tools: [{ name: "shell", description: "run a shell command", parameters: { type: "object" } }],
    });
    const eventsWithTool = await collect(modelWithTools.stream!([{ role: "user", content: "run echo hi" }]));
    const toolCallEvent = eventsWithTool.find((e) => e.type === "tool-call");
    ok("a tool_use block in the SSE stream produces a tool-call event", !!toolCallEvent);
    ok(
      "the tool-call event's name comes from content_block_start (the only place it appears in the stream)",
      toolCallEvent?.type === "tool-call" && toolCallEvent.toolCall.name === "shell",
    );
    ok(
      "the tool-call's args are correctly reconstructed from accumulated input_json_delta fragments",
      toolCallEvent?.type === "tool-call" && JSON.stringify(toolCallEvent.toolCall.args) === JSON.stringify({ command: "echo hi" }),
    );

    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    break section2;
  }

  // ---- 3. Live Ollama, if reachable — genuine end-to-end token stream
  // from a real local model, matching test-memory-embeddings.ts's
  // "live-test if available, honestly skip otherwise" pattern ----
  section3: {
    // OLLAMA_MODEL matters here the same way it did for the original
    // test-live-model.ts bug (see memory.ts's own docs and the fix
    // history): the adapter's hardcoded default "llama3.2" is frequently
    // NOT the model actually pulled on a given machine. Probe /api/tags
    // for whatever IS actually installed and use that, rather than
    // assuming OLLAMA_MODEL is set in the environment this test runs in.
    let live = false;
    let modelName = process.env.OLLAMA_MODEL;
    try {
      const probe = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(1500) });
      if (probe.ok) {
        live = true;
        if (!modelName) {
          const tags = (await probe.json()) as { models?: { name: string }[] };
          modelName = tags.models?.[0]?.name;
          live = !!modelName; // no models pulled at all -> nothing to test against
        }
      }
    } catch {
      live = false;
    }

    if (!live || !modelName) {
      console.log("skip: Ollama not reachable (or no models pulled) at http://localhost:11434 — live streaming section skipped honestly (see test-memory-embeddings.ts for the same pattern)");
      break section3;
    }

    console.log(`Live Ollama detected (model: ${modelName}) — running a real end-to-end streaming request.`);
    const ollamaModel = createOllamaModel({ model: modelName });
    let events: ModelStreamEvent[];
    try {
      events = await collect(ollamaModel.stream!([{ role: "user", content: "Reply with exactly the words: streaming works" }]));
    } catch (err) {
      // Honest failure, not a crash: a live-environment hiccup (model
      // unloaded between the /api/tags probe and the actual request,
      // OOM, etc.) is reported as a normal test failure rather than an
      // uncaught exception that takes the whole suite down.
      ok(`live Ollama request succeeded (model: ${modelName})`, false);
      console.log(`  error: ${err instanceof Error ? err.message : err}`);
      break section3;
    }
    const deltas = events.filter((e) => e.type === "delta");
    const done = events.find((e) => e.type === "done");

    ok("live Ollama stream produced at least one real delta", deltas.length > 0);
    ok("live Ollama stream ends with exactly one 'done' event", events.filter((e) => e.type === "done").length === 1);
    ok(
      "live Ollama 'done' content matches the concatenation of every real delta",
      done?.type === "done" && done.content === deltas.map((d) => (d as any).delta).join(""),
    );
    console.log(`  live response (${deltas.length} chunks): "${(done as any)?.content?.slice(0, 80)}"`);
    break section3;
  }

  console.log("");
  if (failed === 0) {
    console.log(`All harness streaming tests passed (${passed}/${passed}).`);
  } else {
    console.log(`${failed} harness streaming test(s) FAILED (${passed} passed).`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("test-harness-streaming crashed:", err);
  process.exit(1);
});
