// Tests that a flow doesn't claim success it didn't earn, and that model calls through the Claude CLI
// can only see Agent-OS's own tools.
//   1. The CLI is launched with its own tools off; the operator's connectors stay available but are granted
//      explicitly, and the prompt says connector tools are extras (seen live: a model listed the account's
//      connectors as "its tools" and said it couldn't write to BaseSpace, until the prompt said otherwise).
//   2. A flow step that runs out of tool steps is FAILED, not succeeded; steps that depend on it are
//      cancelled; steps that don't are unaffected; the reason is recorded.
//   3. A step that finishes normally still succeeds.
// Run with: node dist/test-flow-honesty.js

import "./test-helpers/isolate.js";
import { createStubWorker, getTask, runFlow, seedDefaultAgents, type ModelAdapter, type ModelResponse } from "./core/index.js";
import { claudeCliArgs, renderToolProtocol } from "./core/models/claude-cli.js";

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`ok: ${msg}`);
  else {
    failed = true;
    console.log(`FAIL: ${msg}`);
  }
}

// --- 1. the CLI launch ---------------------------------------------------------------------
const args = claudeCliArgs("SYSTEM PROMPT", "haiku", { allow: ["mcp__claude_ai_BeatStars"], deny: ["mcp__discord", "mcp__telegram"] });
assert(args[args.indexOf("--tools") + 1] === "" && args.includes("--no-session-persistence") && args[args.indexOf("--setting-sources") + 1] === "", "the CLI's own tools, saved sessions and settings stay off");
assert(args[args.indexOf("--allowedTools") + 1] === "mcp__claude_ai_BeatStars" && args[args.indexOf("--disallowedTools") + 1] === "mcp__discord,mcp__telegram", "enabled connectors are granted and the rest withheld (a connector call is refused in non-interactive mode unless granted)");
assert(!args.includes("--strict-mcp-config"), "the operator's connectors are NOT cut off: they added them on purpose");
assert(args[args.indexOf("--system-prompt") + 1] === "SYSTEM PROMPT" && args[args.indexOf("--model") + 1] === "haiku", "the system prompt and model are passed through");
const bare = claudeCliArgs("x");
assert(!bare.includes("--model") && !bare.includes("--allowedTools") && !bare.includes("--disallowedTools"), "no model or grant flags when there are none");
const spec = [{ name: "soundlab", description: "d", parameters: { type: "object" as const, properties: {} } }, { name: "basespace", description: "d", parameters: { type: "object" as const, properties: {} } }];
const withC = renderToolProtocol(spec as any, true);
const withoutC = renderToolProtocol(spec as any, false);
assert(/exact names\): soundlab, basespace\./.test(withC) && /NOT native tools and not MCP/.test(withC), "the prompt lists the exact tool names and says they are not native or MCP (seen live: a small model read the list, then said a listed tool \"isn't available\")");
assert(/native connector tools/.test(withC) && /ONLY with the block/.test(withC), "…and, when connectors are granted, that connector tools are extras and Agent-OS tools use the block");
assert(!/native connector tools/.test(withoutC), "…and says nothing about connectors when none are granted");

// --- 2/3. honest step outcomes ---------------------------------------------------------------
await seedDefaultAgents();
/** The "busy" agent never stops asking for tools; everyone else just answers. */
const model: ModelAdapter = {
  id: "scripted",
  async complete(messages): Promise<ModelResponse> {
    const first = messages.find((m) => m.role === "user")?.content ?? "";
    if (first.startsWith("BUSY")) return { content: "", toolCall: { name: "basespace", args: { section: "summary" } } };
    return { content: `done: ${first.slice(0, 30)}` };
  },
};
const result = await runFlow(
  [
    { id: "busy", agentId: "nyx", goal: "BUSY: keep asking for tools and never finish" },
    { id: "fine", agentId: "aether", goal: "Answer plainly, no tools needed." },
    { id: "after-busy", agentId: "hermes", goal: "This depends on the busy step.", dependsOn: ["busy"] },
    { id: "after-fine", agentId: "theia", goal: "This depends on the fine step.", dependsOn: ["fine"] },
  ],
  { model, worker: createStubWorker(), enableBaseSpace: true, maxToolHopsPerStep: 2 },
);
const by = new Map(result.steps.map((s) => [s.stepId, s.status]));
assert(by.get("busy") === "failed", `a step that ran out of tool steps is failed, not succeeded (${by.get("busy")})`);
assert(by.get("after-busy") === "cancelled", `…the step that needed it is cancelled (${by.get("after-busy")})`);
assert(by.get("fine") === "succeeded" && by.get("after-fine") === "succeeded", "…a step that finished normally still succeeds, and so does what depends on it");
assert(result.status === "failed", `the flow as a whole is failed (${result.status}), not a green tick over a step that didn't finish`);
const busyTask = await getTask(result.steps.find((s) => s.stepId === "busy")!.taskId!);
assert(/ran out of tool steps/.test(String(busyTask?.output?.error)) && busyTask?.status === "failed", "the reason is recorded on the task");

console.log(failed ? "\nSome flow-honesty tests FAILED." : "\nAll flow-honesty tests passed.");
process.exit(failed ? 1 : 0);
