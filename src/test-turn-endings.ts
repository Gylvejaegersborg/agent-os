// Standalone tests for how a turn ends when a model keeps using tools —
// the "reply appears, then vanishes" bug: a turn that ran out of tool
// steps used to end with an empty answer and nothing saved, so a client
// re-reading the history dropped the text it had just streamed.
// Also checks the Anthropic adapter's request shape for tool results.
// Run with: node dist/test-turn-endings.js

import "./test-helpers/isolate.js";
import { createServer } from "node:http";
import { runTurn, newSessionId, createStubWorker, getSessionHistory, createAnthropicModel } from "./core/index.js";

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`ok: ${msg}`);
  else {
    failed = true;
    console.log(`FAIL: ${msg}`);
  }
}

// A model that always says something and calls a tool — never finishes.
const loopingModel = {
  id: "looping",
  async complete() {
    return { content: "Let me check the calendar.", toolCall: { name: "basespace", args: { section: "summary" } } };
  },
};

async function testOutOfSteps(): Promise<void> {
  const sessionId = newSessionId();
  const result = await runTurn({ sessionId, agentId: "turn-endings", userMessage: "what's on today?", model: loopingModel as never, worker: createStubWorker(), maxToolHops: 3 });
  assert(/used all 3 tool steps/.test(result.finalContent), "running out of tool steps ends with an explanation, not an empty reply");
  const history = await getSessionHistory(sessionId);
  const assistant = history.filter((m) => m.role === "assistant").map((m) => m.content);
  assert(assistant.filter((c) => c === "Let me check the calendar.").length === 3, "text written alongside each tool call is kept in the history");
  assert(/used all 3 tool steps/.test(assistant[assistant.length - 1] ?? ""), "the explanation is saved as the last message");
  const tool = history.find((m) => m.role === "tool") as { call?: string } | undefined;
  assert(tool?.call?.startsWith("basespace ") === true, "tool results record which call produced them");
}

async function testAnthropicRequestShape(): Promise<void> {
  let body: any;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      body = JSON.parse(raw);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ content: [{ type: "text", text: "done" }], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const model = createAnthropicModel({ apiKey: "sk-ant-api-test", baseUrl: `http://127.0.0.1:${port}/v1/messages` });
  await model.complete([
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    { role: "tool", content: "[basespace {}]\nresult" },
    { role: "assistant", content: "a" },
    { role: "assistant", content: "b" },
  ]);
  server.close();
  const msgs: { role: string; content: unknown }[] = body.messages;
  assert(msgs.every((m) => typeof m.content === "string"), "tool results are sent as plain text (no tool_result block without its tool_use id)");
  assert(msgs.every((m, i) => i === 0 || m.role !== msgs[i - 1]!.role), "roles alternate (consecutive same-role messages merged)");
  assert(msgs[0]?.role === "user" && body.system === "sys", "starts with the user and keeps the system prompt separate");
  assert(Array.isArray(body.tools) && body.tools.some((t: { name: string }) => t.name === "basespace"), "registered tools are offered to the model");
}

await testOutOfSteps();
await testAnthropicRequestShape();
console.log(failed ? "\nSome turn-endings tests FAILED." : "\nAll turn-endings tests passed.");
process.exit(failed ? 1 : 0);
