// Tests for several tool calls in one model reply (agent-loop.ts, claude-cli.ts's parseToolCalls).
// Proves:
//   1. Independent calls in one reply all run, in order, and the turn takes fewer model calls than one-at-a-time.
//   2. A failure stops the rest of the reply (they are recorded as skipped, and genuinely not run).
//   3. Approval gates, plan mode and cancellation stop the rest too, and every call still goes through the same checks.
//   4. A reply carries at most 4 calls; a run executes at most 8 tools in total (AGENT_OS_MAX_TOOL_EXECUTIONS), however
//      they are batched, and says so when it stops.
//   5. A model that returns one call at a time behaves exactly as before.
//   6. The parser reads every block of a reply and skips a malformed one.
// Run with: node dist/test-multicall.js

import "./test-helpers/isolate.js";
import {
  cancelSession,
  createSession,
  createStubWorker,
  getSessionHistory,
  listApprovals,
  runFlow,
  runTurn,
  saveSnapshot,
  seedDefaultAgents,
  type ModelAdapter,
  type ModelResponse,
  type Worker,
} from "./core/index.js";
import { MAX_CALLS_PER_REPLY } from "./core/model.js";
import { parseToolCalls, renderToolProtocol } from "./core/models/claude-cli.js";
import { loadOverlay } from "./core/basespace.js";
const readOverlayNotes = async () => (await loadOverlay()).notes;

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`ok: ${msg}`);
  else {
    failed = true;
    console.log(`FAIL: ${msg}`);
  }
}

type Call = { name: string; args: Record<string, unknown> };
const summary: Call = { name: "basespace", args: { section: "summary" } };
const goals: Call = { name: "basespace", args: { section: "goals" } };
const note = (title: string): Call => ({ name: "basespace-add", args: { kind: "note", title, body: "x", folder: "Agents/test" } });

/** A model that plays back scripted replies (each a list of calls, or text). It records how many times it was called. */
function script(replies: (Call[] | string)[]): ModelAdapter & { calls: number } {
  const m = {
    id: "script",
    calls: 0,
    async complete(): Promise<ModelResponse> {
      const r = replies[Math.min(m.calls++, replies.length - 1)]!;
      if (typeof r === "string") return { content: r };
      return r.length === 1 ? { content: "", toolCall: r[0]! } : { content: "", toolCall: r[0]!, toolCalls: r };
    },
  };
  return m;
}

await seedDefaultAgents();
await saveSnapshot({ schema: 1, goals: [] });
const worker = createStubWorker();
const run = async (model: ModelAdapter, opts: Record<string, unknown> = {}, agentId = "nyx") => {
  const s = await createSession({ agentId });
  const result = await runTurn({ sessionId: s.id, agentId, userMessage: "go", model, worker, enableBaseSpace: true, maxToolHops: 8, ...opts });
  return { result, history: await getSessionHistory(s.id), sessionId: s.id };
};
const toolMsgs = (h: { role: string; content: string; call?: string }[]) => h.filter((m) => m.role === "tool") as { role: string; content: string; call?: string }[];

// --- 1. batching ---------------------------------------------------------------------------------
const batched = script([[summary, goals], "done"]);
const a = await run(batched);
assert(batched.calls === 2 && a.result.finalContent === "done", `two independent calls in one reply: the turn takes 2 model calls, not 3 (${batched.calls})`);
const am = toolMsgs(a.history as any);
assert(am.length === 2 && /basespace \{"section":"summary"\}/.test(am[0]!.call ?? "") && /basespace \{"section":"goals"\}/.test(am[1]!.call ?? ""), "both ran, in the order asked, each result labeled with its call");

// --- 2. failure stops the rest -----------------------------------------------------------------------
const f = script([[{ name: "basespace", args: { section: "nope" } }, note("must-not-exist")], "ok"]);
const fr = await run(f);
const fm = toolMsgs(fr.history as any);
assert(fm.length === 2 && /^error:/.test(fm[0]!.content) && /^skipped: an earlier call in this reply failed/.test(fm[1]!.content), "a failed call: the next one is recorded as skipped, with the reason");
assert(!(await readOverlayNotes()).some((n: any) => n.title === "must-not-exist"), "…and it genuinely wasn't run (no note was written)");

// --- 3. blocks and cancellation --------------------------------------------------------------------------
const gate = script([[summary, { name: "propose-plan", args: { goalId: "g", summary: "s", steps: [{ to: "aether", title: "t" }] } }, note("after-gate")]]);
await saveSnapshot({ schema: 1, goals: [{ id: "g", title: "A goal", status: "active" }] });
const gr = await run(gate, {}, "hemera");
assert(gr.result.stopReason === "tool-blocked" && toolMsgs(gr.history as any).length === 1, "an approval-gated call mid-reply ends the turn after the calls before it ran");
assert((await listApprovals({ status: "pending" })).some((p) => p.toolName === "propose-plan") && !(await readOverlayNotes()).some((n: any) => n.title === "after-gate"), "…the approval was filed, and the call after it didn't run");

const plan = script([[summary, { name: "audio", args: { action: "edit", path: "a.wav", output: "b.wav" } }]]);
const pr = await run(plan, { planMode: true }, "claude");
assert(pr.result.stopReason === "tool-blocked" && toolMsgs(pr.history as any).length === 1 && /plan mode/.test(pr.result.finalContent), "plan mode still blocks a write in the middle of a batch (the read before it ran)");

let sessionToCancel = "";
const cancelling: Worker = { id: "cancelling", kind: "test", async run() { await cancelSession(sessionToCancel, "test"); return { ok: true, output: "ran" }; } };
const cs = await createSession({ agentId: "claude" });
sessionToCancel = cs.id;
const cancelModel = script([[{ name: "shell", args: { command: "echo hi" } }, note("after-cancel")]]);
const cr = await runTurn({ sessionId: cs.id, agentId: "claude", userMessage: "go", model: cancelModel, worker: cancelling, enableBaseSpace: true, maxToolHops: 8 });
assert(cr.cancelled === true && !(await readOverlayNotes()).some((n: any) => n.title === "after-cancel"), "a cancel during one call stops the calls after it");

// --- 4. the caps -------------------------------------------------------------------------------------------
assert(MAX_CALLS_PER_REPLY === 4 && new RegExp(`up to ${MAX_CALLS_PER_REPLY} blocks`).test(renderToolProtocol([{ name: "t", description: "d", parameters: { type: "object", properties: {} } }] as any)), "the prompt tells the model the per-reply limit (4)");
const six = script([[summary, summary, summary, summary, summary, summary], "done"]);
const sr = await run(six);
const sm = toolMsgs(sr.history as any);
assert(sm.filter((m) => !/^skipped/.test(m.content)).length === 4 && sm.some((m) => /only the first 4 calls of a reply/.test(m.content)), "six calls in one reply: only the first 4 run, and the model is told to ask for the rest");

delete process.env.AGENT_OS_MAX_TOOL_EXECUTIONS;
const greedy = script([[summary, summary, summary, summary], [summary, summary, summary, summary], [summary, summary, summary, summary], "never reached"]);
const gd = await run(greedy, { maxToolHops: 20 });
const gm = toolMsgs(gd.history as any);
const executed = gm.filter((m) => !/^skipped/.test(m.content)).length;
assert(executed === 8 && gd.result.stopReason === "max-hops", `a run executes at most 8 tools however they are batched (${executed} ran, stop reason ${gd.result.stopReason})`);
assert(gm.some((m) => /reached its limit of 8 tool executions/.test(m.content)) && /limit of 8 tool executions/.test(gd.result.finalContent) && greedy.calls === 3, "…the rest are recorded as skipped, the turn says it hit the limit, and no further model call is made");

process.env.AGENT_OS_MAX_TOOL_EXECUTIONS = "3";
const small = await run(script([[summary, summary, summary, summary], "x"]));
assert(toolMsgs(small.history as any).filter((m) => !/^skipped/.test(m.content)).length === 3, "AGENT_OS_MAX_TOOL_EXECUTIONS changes the cap (3)");
delete process.env.AGENT_OS_MAX_TOOL_EXECUTIONS;

// A flow step that hits the cap is a failed step, like any step that runs out of tool steps.
const flowResult = await runFlow([{ id: "busy", agentId: "nyx", goal: "keep going" }], { model: script([[summary, summary, summary, summary], [summary, summary, summary, summary], [summary, summary, summary, summary]]), worker, enableBaseSpace: true, maxToolHopsPerStep: 20, maxToolExecutionsPerStep: 8 });
assert(flowResult.steps[0]!.status === "failed" && flowResult.status === "failed", "a flow step that runs into the cap is reported failed, not succeeded");

// --- 5. one at a time is unchanged ------------------------------------------------------------------------------
const single = script([[summary], [goals], "fine"]);
const sg = await run(single);
assert(single.calls === 3 && toolMsgs(sg.history as any).length === 2 && sg.result.finalContent === "fine", "a model that returns one call per reply behaves exactly as before");

// --- 6. the parser -------------------------------------------------------------------------------------------------
const reply = 'Let me check both.\n<tool_call>{"name": "basespace", "args": {"section": "goals"}}</tool_call>\n<tool_call>{"name": "soundlab", "args": {"action": "packs"}}</tool_call>\n<tool_call>{broken json</tool_call>\n<tool_call>{"name": "library", "args": {"action": "list"}}</tool_call>';
const parsed = parseToolCalls(reply);
assert(parsed.toolCalls.map((c) => c.name).join() === "basespace,soundlab,library" && parsed.content === "Let me check both.", "every block is parsed, in order; a malformed one is skipped; the visible text is what came before the first");
assert(parseToolCalls("just an answer").toolCalls.length === 0 && parseToolCalls("just an answer").content === "just an answer", "no blocks: just the text");
assert(parseToolCalls('<tool_call>{"name": "soundlab", "args": {"action": "kept"}}').toolCalls.length === 1, "a final block with no closing tag still parses");
assert(parseToolCalls("<tool_call>{nope}</tool_call>").toolCalls.length === 0 && parseToolCalls("<tool_call>{nope}</tool_call>").content.includes("nope"), "a lone malformed block is left in the text, not guessed at");

console.log(failed ? "\nSome multicall tests FAILED." : "\nAll multicall tests passed.");
process.exit(failed ? 1 : 0);
