// Tests for two robustness fixes found running local models against real
// Hindsight:
//   1. parseToolArgs: tool-call arguments a model sent malformed (valid JSON
//      followed by more, the object twice, garbage) no longer throw and kill
//      the turn; and a streamed Ollama turn with such arguments completes.
//   2. Hindsight: a missing bank (a new agent that hasn't remembered anything)
//      is an empty memory, not a failure — and doesn't use up the one-time
//      warning that reports a real outage.
// Run with: node dist/test-tool-args.js

import "./test-helpers/isolate.js";
import { createServer } from "node:http";
import { createOllamaModel, hindsightRecall, parseToolArgs } from "./core/index.js";

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`ok: ${msg}`);
  else {
    failed = true;
    console.log(`FAIL: ${msg}`);
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function main(): Promise<void> {
  // 1. The parser.
  assert(same(parseToolArgs('{"query":"a"}'), { query: "a" }), "well-formed arguments parse as before");
  assert(same(parseToolArgs(undefined), {}) && same(parseToolArgs(""), {}), "missing arguments are {}");
  assert(same(parseToolArgs('{"query":"a"}{"query":"a"}'), { query: "a" }), "the object sent twice: the first one is used");
  assert(same(parseToolArgs('{"query":"a"} and then some words'), { query: "a" }), "trailing text after the object is ignored");
  assert(same(parseToolArgs('{"text":"has } and { inside \\" a string"}{"x":1}'), { text: 'has } and { inside " a string' }), "braces inside strings don't end the object early");
  assert(same(parseToolArgs('{"query":"unfinished'), {}), "an unfinished object is {} (the tool reports the missing argument)");
  assert(same(parseToolArgs("[1,2]"), {}) && same(parseToolArgs('"str"'), {}), "a non-object is {}");
  assert(same(parseToolArgs("garbage"), {}), "garbage is {}");

  // 2. A streamed Ollama turn whose tool arguments arrive doubled completes instead of throwing.
  const ollama = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: object) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
      res.write(chunk({ tool_calls: [{ index: 0, function: { name: "recall-memory", arguments: '{"query":"captions","deep":"false"}' } }] }));
      res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"query":"captions","deep":"false"}' } }] }));
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => ollama.listen(0, "127.0.0.1", () => r()));
  const port = (ollama.address() as { port: number }).port;
  const model = createOllamaModel({ baseUrl: `http://127.0.0.1:${port}/v1/chat/completions`, model: "test" });
  let threw = "";
  const reply = await model.completeStream!([{ role: "user", content: "hi" }], () => {}).catch((e: Error) => ((threw = e.message), undefined));
  ollama.close();
  assert(!threw, `a streamed tool call with doubled arguments doesn't throw the turn away (${threw || "ok"})`);
  assert(reply?.toolCall?.name === "recall-memory" && reply.toolCall.args.query === "captions", "…and its arguments are recovered");

  // 3. Hindsight: a missing bank is quiet; a real failure still warns (once).
  const hindsight = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url!.includes("/banks/agent-os-newcomer/")) {
        res.statusCode = 404;
        res.end(JSON.stringify({ detail: "Bank 'agent-os-newcomer' not found" }));
      } else if (req.url!.includes("/banks/agent-os-wrongurl/")) {
        res.statusCode = 404;
        res.end(JSON.stringify({ detail: "Not Found" }));
      } else res.end(JSON.stringify({ results: [] }));
    });
  });
  await new Promise<void>((r) => hindsight.listen(0, "127.0.0.1", () => r()));
  process.env.HINDSIGHT_URL = `http://127.0.0.1:${(hindsight.address() as { port: number }).port}`;
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => void warnings.push(a.join(" "));
  try {
    assert((await hindsightRecall("newcomer", "anything")).length === 0 && warnings.length === 0, "recall on an agent with no bank yet is an empty result with no warning");
    await hindsightRecall("wrongurl", "anything");
    assert(warnings.length === 1 && /recall failed/.test(warnings[0]!), "a 404 that isn't 'bank not found' (a wrong URL) still warns — the newcomer didn't use up the warning");
  } finally {
    console.warn = realWarn;
    delete process.env.HINDSIGHT_URL;
    hindsight.close();
  }

  if (failed) {
    console.error("\nSome tool-args tests FAILED.");
    process.exit(1);
  }
  console.log("\nAll tool-args tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
