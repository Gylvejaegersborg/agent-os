// Tests for the provider router (models/real.ts) and the Claude CLI adapter
// (models/claude-cli.ts). The CLI is replaced by a small fake `claude`
// script (CLAUDE_CLI_PATH) that prints the same stream-json events the real
// CLI prints — captured from `claude -p --output-format stream-json
// --verbose --include-partial-messages` — so no login or network is needed.
// Proves:
//   1. parseModelRef: only the four known prefixes pick a provider; Ollama
//      names with colons ("llama3.2:3b") stay bare model names.
//   2. The adapter streams visible text, hides a <tool_call> block from the
//      live deltas, and returns it as ModelResponse.toolCall.
//   3. The adapter passes the flags that keep Agent-OS in charge (built-in
//      tools off, no session persistence) and feeds the conversation on stdin.
//   4. A CLI error result (e.g. not logged in) rejects with its message.
//   5. createModelFromRef: "claude-cli:<model>" uses the CLI; an unusable
//      provider falls back to the default instead of failing; a bare
//      "claude-…" name goes to the CLI when no Anthropic key is set.
//   6. A real turn through runTurn() dispatches a CLI-issued tool call.
// Run with: node dist/test-model-router.js

import "./test-helpers/isolate.js";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModelFromRef, parseModelRef } from "./core/models/real.js";
import { createClaudeCliModel, parseToolCall, resetClaudeCliAvailability } from "./core/models/claude-cli.js";
import { newSessionId, runTurn } from "./core/agent-loop.js";
import { createStubWorker } from "./core/worker.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

const dir = mkdtempSync(path.join(os.tmpdir(), "fake-claude-"));
const fakeClaude = path.join(dir, "claude");
const callLog = path.join(dir, "calls.jsonl");
writeFileSync(
  fakeClaude,
  `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
let stdin = "";
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(callLog)}, JSON.stringify({ args, stdin }) + "\\n");
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  out({ type: "system", subtype: "init", tools: [] });
  const mode = process.env.FAKE_CLAUDE_MODE || "text";
  if (mode === "error") {
    out({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" });
    return;
  }
  // After a tool result, just answer.
  const text = mode === "tool" && !stdin.includes("[tool result]")
    ? 'Checking. <tool_call>{"name": "shell", "args": {"command": "echo hi"}}</tool_call>'
    : "pong from the cli";
  for (let i = 0; i < text.length; i += 7) {
    out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(i, i + 7) } } });
  }
  out({ type: "result", subtype: "success", is_error: false, result: text, usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 } });
});
`,
);
chmodSync(fakeClaude, 0o755);
process.env.CLAUDE_CLI_PATH = fakeClaude;

function calls(): { args: string[]; stdin: string }[] {
  try {
    return readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function testParseModelRef(): void {
  const r1 = parseModelRef("claude-cli:sonnet");
  assert(r1.provider === "claude-cli" && r1.model === "sonnet", "claude-cli:sonnet → provider claude-cli, model sonnet");
  const r2 = parseModelRef("ollama:llama3.2:3b");
  assert(r2.provider === "ollama" && r2.model === "llama3.2:3b", "ollama:llama3.2:3b keeps the colon in the model name");
  const r3 = parseModelRef("llama3.2:3b");
  assert(r3.provider === undefined && r3.model === "llama3.2:3b", "a bare Ollama name with a colon is not mistaken for a provider");
  const r4 = parseModelRef("claude-cli");
  assert(r4.provider === "claude-cli" && r4.model === undefined, "a bare provider name uses that provider's default model");
  assert(parseModelRef(undefined).provider === undefined && parseModelRef("  ").model === undefined, "empty refs resolve to nothing");
}

function testParseToolCall(): void {
  const p = parseToolCall('Let me look. <tool_call>{"name":"read_file","args":{"path":"a.md"}}</tool_call>');
  assert(p.toolCall?.name === "read_file" && p.toolCall.args.path === "a.md" && p.content === "Let me look.", "a tool-call block is split from the visible text");
  const bad = parseToolCall("<tool_call>{not json</tool_call>");
  assert(!bad.toolCall && bad.content.includes("not json"), "an unparseable block is left as text, not guessed at");
  assert(!parseToolCall("plain answer").toolCall, "plain text has no tool call");
  // Formats Claude falls back to (seen live), each with invented text after.
  const fc = parseToolCall('Checking.\n<function_calls>\n[{"tool_name": "basespace", "args": {"section": "summary"}}]\n</function_calls>\nIt shows 3 todos.');
  assert(fc.toolCall?.name === "basespace" && fc.toolCall.args.section === "summary" && fc.content === "Checking.", "a JSON <function_calls> block is parsed and what follows it dropped");
  const xml = parseToolCall('<function_calls><invoke name="read_file"><parameter name="path">a.md</parameter><parameter name="limit">5</parameter></invoke></function_calls> made-up output');
  assert(xml.toolCall?.name === "read_file" && xml.toolCall.args.path === "a.md" && xml.toolCall.args.limit === 5 && xml.content === "", "an XML <invoke> call is parsed, parameters JSON-decoded when possible");
  const two = parseToolCall('<tool_call>{"name": "a", "args": {}}</tool_call><tool_call>{"name": "b", "args": {}}</tool_call>');
  assert(two.toolCall?.name === "a", "only the first of several calls is taken");
  const call = parseToolCall('<call>{"name": "basespace-add", "args": {"kind": "todo", "title": "x"}}</call>');
  assert(call.toolCall?.name === "basespace-add" && call.toolCall.args.kind === "todo", "a <call> wrapper works");
  const toolInput = parseToolCall('<tool_call>{"tool_name": "basespace-add", "tool_input": {"kind": "note", "title": "y"}}</tool_call>');
  assert(toolInput.toolCall?.args.kind === "note", "tool_input as the arguments key works");
  const openai = parseToolCall('<tool_call>{"type": "function", "function": {"name": "shell", "arguments": "{\\"command\\": \\"ls\\"}"}}</tool_call>');
  assert(openai.toolCall?.name === "shell" && openai.toolCall.args.command === "ls", "OpenAI-style function + string arguments work");
  // Seen live from Haiku via the CLI: a hybrid of three formats, then an invented result.
  const hybrid = parseToolCall('Let me check.\n<function_calls>\n[tool_call]\n{"name": "basespace", "args": {"section":"notes","id":"n{1}"}}\n</tool_call>\n</function_calls>\n\n[tool result]\nmade up');
  assert(hybrid.toolCall?.name === "basespace" && hybrid.toolCall.args.id === "n{1}" && hybrid.content === "Let me check.", "a hybrid block is parsed by finding the JSON call inside it");
  const flat = parseToolCall('<tool_call>{"name": "basespace", "section": "goals"}</tool_call>');
  assert(flat.toolCall?.args.section === "goals" && !("name" in flat.toolCall.args), "flat arguments next to the name work");
}

async function testAdapterText(): Promise<void> {
  process.env.FAKE_CLAUDE_MODE = "text";
  const model = createClaudeCliModel({ model: "sonnet" });
  const deltas: string[] = [];
  const res = await model.completeStream!(
    [
      { role: "system", content: "You are Hemera." },
      { role: "user", content: "ping" },
    ],
    (d) => deltas.push(d),
  );
  assert(res.content === "pong from the cli" && !res.toolCall, "plain text comes back as content");
  assert(deltas.length > 1 && deltas.join("") === "pong from the cli", "text streams as several deltas");
  assert(res.usage?.inputTokens === 15 && res.usage.outputTokens === 3, "usage counts cached input tokens too");
  const call = calls().at(-1)!;
  const flag = (name: string) => call.args[call.args.indexOf(name) + 1];
  assert(call.args.includes("--tools") && flag("--tools") === "", "the CLI's built-in tools are switched off");
  assert(call.args.includes("--no-session-persistence"), "each call is a fresh, unsaved CLI session");
  assert(flag("--model") === "sonnet", "the model is passed through");
  assert(flag("--system-prompt").startsWith("You are Hemera.") && flag("--system-prompt").includes("<tool_call>"), "the system prompt carries the agent's context and the tool protocol");
  assert(call.stdin.includes("[user]\nping"), "the conversation is sent on stdin");
}

async function testAdapterToolCall(): Promise<void> {
  process.env.FAKE_CLAUDE_MODE = "tool";
  const model = createClaudeCliModel();
  const deltas: string[] = [];
  const res = await model.completeStream!([{ role: "user", content: "say hi via shell" }], (d) => deltas.push(d));
  assert(res.toolCall?.name === "shell" && res.toolCall.args.command === "echo hi", "a <tool_call> block becomes a tool call");
  assert(!deltas.join("").includes("<tool"), `the raw block never reaches the live stream (streamed: ${JSON.stringify(deltas.join(""))})`);
}

async function testAdapterError(): Promise<void> {
  process.env.FAKE_CLAUDE_MODE = "error";
  let message = "";
  try {
    await createClaudeCliModel().complete([{ role: "user", content: "hi" }]);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  assert(message.includes("Not logged in"), "a CLI error result rejects with the CLI's own message");
}

async function testRouter(): Promise<void> {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_TOKEN;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  resetClaudeCliAvailability();
  const dead = { baseUrl: "http://127.0.0.1:1/v1/chat/completions" }; // no Ollama here

  const cli = await createModelFromRef("claude-cli:opus", dead);
  assert(cli?.id === "claude-cli:opus", "claude-cli:opus resolves to the CLI adapter");

  const bare = await createModelFromRef("claude-sonnet-5", dead);
  assert(bare?.id === "claude-cli:claude-sonnet-5", "a bare claude-… name uses the CLI when no Anthropic key is set");

  process.env.ANTHROPIC_API_KEY = "sk-ant-api-test";
  const viaApi = await createModelFromRef("claude-sonnet-5", dead);
  assert(viaApi?.id === "anthropic:claude-sonnet-5", "with an Anthropic key, a bare claude-… name uses the API as before");
  const fallback = await createModelFromRef("openai:gpt-4o", dead);
  assert(fallback?.id.startsWith("anthropic:") === true && !fallback.id.includes("gpt-4o"), "an unusable provider falls back to the default without its model name");
  delete process.env.ANTHROPIC_API_KEY;

  process.env.OPENAI_BASE_URL = "http://127.0.0.1:1234/v1";
  const compat = await createModelFromRef("openai:qwen2.5-7b", dead);
  assert(compat?.id === "openai:qwen2.5-7b", "openai: works keyless against an OpenAI-compatible OPENAI_BASE_URL");
  delete process.env.OPENAI_BASE_URL;

  process.env.CLAUDE_CLI_PATH = path.join(dir, "missing-claude");
  resetClaudeCliAvailability();
  const none = await createModelFromRef("claude-cli:sonnet", dead);
  assert(none === undefined, "with no CLI, no keys and no Ollama, nothing resolves (the gateway then uses the stub)");
  process.env.CLAUDE_CLI_PATH = fakeClaude;
  resetClaudeCliAvailability();
}

async function testTurnThroughCli(): Promise<void> {
  process.env.FAKE_CLAUDE_MODE = "tool";
  const result = await runTurn({
    sessionId: newSessionId(),
    agentId: "hemera",
    userMessage: "say hi via shell",
    model: createClaudeCliModel(),
    worker: createStubWorker(),
  });
  assert(result.toolCalled === "shell", "a real turn dispatches the tool call the CLI asked for");
  assert(result.finalContent === "pong from the cli", "the tool result goes back to the CLI and its answer ends the turn");
  const last = calls().at(-1)!;
  assert(last.stdin.includes("[tool result]"), "the tool's output is fed back on the next call");
}

async function main(): Promise<void> {
  testParseModelRef();
  testParseToolCall();
  await testAdapterText();
  await testAdapterToolCall();
  await testAdapterError();
  await testRouter();
  await testTurnThroughCli();
  if (process.exitCode === 1) console.error("\nSome model-router tests FAILED.");
  else console.log("\nAll model-router tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
