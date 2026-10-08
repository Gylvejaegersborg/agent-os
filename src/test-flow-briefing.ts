// Tests the flow briefing: the detail the Results need to let the operator decide, and the briefing the lead writes from real evidence.
// Proves:
//   1. The outcome carries what was missing: the details an agent wrote on a todo (the options!), the notes it points at, the text of the
//      notes the agents wrote, and each agent's full report.
//   2. The evidence packet given to the lead holds the options, the notes' text, the open todos, what was already decided, the verdict.
//   3. The briefing is written from that packet and stored; numbers in it are checked by code against the pack, wrong ones go back once,
//      and what is still wrong is listed with the briefing instead of being passed off as fact.
//   4. worthBriefing: a small clean flow isn't worth one; a flow with something left for the operator is.
//   5. The routes: POST /flows/:id/briefing writes it, GET /flows/:id/report carries it, an unknown flow is a 404.
// Run with: node dist/test-flow-briefing.js

import "./test-helpers/isolate.js";
import {
  addOverlayItem,
  buildBriefingPacket,
  buildFlowReport,
  completeOverlayTodo,
  reopenOverlayTodo,
  createStubModel,
  createStubWorker,
  generateFlowBriefing,
  getFlowBriefing,
  loadOverlay,
  runFlow,
  seedDefaultAgents,
  setPackFactsSource,
  storeFlowDefinition,
  worthBriefing,
  type ModelAdapter,
  type ModelResponse,
} from "./core/index.js";
import { startGateway } from "./gateway/server.js";

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`ok: ${msg}`);
  else {
    failed = true;
    console.log(`FAIL: ${msg}`);
  }
}

await seedDefaultAgents();
const OPTIONS = "1. Salient – Trap Essentials & Melodic One-Shots\n2. Salient – 71 Drum & Keys Sounds\n3. Salient – Versatile Drum Kit";
const todoArgs = (title: string, notes: string) => ({ name: "basespace-add", args: { kind: "todo", title, notes } });
const noteArgs = (title: string, body: string) => ({ name: "basespace-add", args: { kind: "note", title, body, folder: "Agents/Nyx" } });
const doing: ModelAdapter = {
  id: "doer",
  async complete(messages): Promise<ModelResponse> {
    const last = messages[messages.length - 1]!;
    const first = messages.find((m) => m.role === "user")!.content;
    if (last.role === "tool") return { content: first.startsWith("N:") ? "Wrote the listing and one question for you." : "Checked it: fine." };
    if (first.startsWith("N:")) {
      const calls = [
        noteArgs("Salient: Listing draft", "Kicks: 4 × kick\nTitle ideas are in the todo."),
        todoArgs("Final pack name: choose a title", `Pick one title:\n${OPTIONS}\n\nReference: Listing draft (Agents/Nyx). ISARK choice only.`),
      ];
      return { content: "", toolCall: calls[0]!, toolCalls: calls };
    }
    return { content: "Reviewed. No problems." };
  },
};
const steps = [
  { id: "write", agentId: "nyx", goal: "N: write the listing and a question" },
  { id: "a", agentId: "aether", goal: "A: look" },
  { id: "b", agentId: "theia", goal: "B: look" },
  { id: "check", agentId: "argus", goal: "V: review", dependsOn: ["write", "a", "b"] },
];
const flow = await runFlow(steps, { model: doing, worker: createStubWorker(), enableBaseSpace: true, maxToolHopsPerStep: 4 });
await storeFlowDefinition({ flowId: flow.flowId, title: "Salient launch prep", proposedBy: "hemera", summary: "prep", steps });

// --- 1. the outcome ------------------------------------------------------------------------------
const oc = (await buildFlowReport(flow.flowId))!.outcome;
const q = oc.toDo.find((t) => t.kind === "todo")!;
assert(!!q && !!q.info?.includes("Salient – 71 Drum & Keys Sounds") && !!q.info.includes("Salient – Versatile Drum Kit") && !/added by/.test(q.info), "the todo carries what the agent wrote on it: every option, exactly (the part that was missing)");
assert(q.priority === "med" && q.refs?.length === 1 && q.refs[0]!.title === "Salient: Listing draft" && /4 × kick/.test(q.refs[0]!.body), "…and the note it points at, with its text, found from the name in the todo");
const nyx = oc.byAgent.find((a) => a.agentId === "nyx")!;
assert(!!nyx.notes[0]!.body?.includes("Title ideas are in the todo") && /Wrote the listing/.test(nyx.fullReport ?? ""), "notes carry their text, and each agent's report is there in full");

// --- 2. the packet ------------------------------------------------------------------------------------
const packet = (await buildBriefingPacket(flow.flowId))!;
assert(/Salient launch prep/.test(packet) && /write \(nyx\): succeeded/.test(packet) && /4 × kick/.test(packet), "the packet has the flow, its steps and the notes' text");
assert(/Final pack name: choose a title/.test(packet) && /Versatile Drum Kit/.test(packet) && !/added by/.test(packet), "…the open todo with every option the agent wrote on it");
const todoId = (await loadOverlay()).tasks.find((t) => /Final pack name/.test(String(t.title)))!.id as string;
await completeOverlayTodo(todoId, { answer: "Salient" });
assert(/ALREADY DECIDED BY THE OPERATOR:\n- Final pack name: choose a title → Salient/.test((await buildBriefingPacket(flow.flowId))!), "…what the operator already decided, with the answer");
await reopenOverlayTodo(todoId);
void addOverlayItem;
assert(/VERIFIER \(argus\): done/.test(packet) && /Reviewed\. No problems/.test(packet), "…and the verifier's verdict");

// --- 3. the briefing ----------------------------------------------------------------------------------
setPackFactsSource(async () => ({ name: "Salient", counts: { kick: 4, "808": 6 }, total: 71 }));
const seen: { system: string; user: string }[] = [];
const writer: ModelAdapter = {
  id: "writer",
  async complete(messages, opts): Promise<ModelResponse> {
    seen.push({ system: messages[0]!.content, user: messages[messages.length - 1]!.content });
    assert(Array.isArray(opts?.tools) && opts!.tools!.length === 0, "the briefing call carries no tools");
    const bad = seen.length === 1;
    return { content: `## Bottom line\nNot ready: one thing to do.\n## What you need to decide\n${bad ? "5 × kick" : "4 × kick"} in the pack.`, usage: { inputTokens: 1000, outputTokens: 100 } };
  },
};
const b1 = (await generateFlowBriefing(flow.flowId, writer))!;
assert(seen.length === 2 && /has 4 kick, not 5/.test(seen[1]!.user) && b1.text.includes("4 × kick") && !b1.unverified, "a wrong number goes back once, with the real one, and the corrected briefing is kept");
assert(/ONLY from that evidence/.test(seen[0]!.system) && /## What you need to decide/.test(seen[0]!.system) && /Out of date or contradictory/.test(seen[0]!.system) && /Versatile Drum Kit/.test(seen[0]!.user), "the lead is given the sections to write and the real evidence");
assert(b1.by === "hemera" && b1.usage?.inputTokens === 2000 && (await getFlowBriefing(flow.flowId))?.text === b1.text, "it is stored with who wrote it and what it cost (both calls)");

const stubborn: ModelAdapter = { id: "s", async complete(): Promise<ModelResponse> { return { content: "## Bottom line\n9 × kick." }; } };
const b2 = (await generateFlowBriefing(flow.flowId, stubborn))!;
assert(!!b2.unverified?.some((p) => /has 4 kick, not 9/.test(p)), "numbers that stay wrong are listed with the briefing instead of being passed off as fact");
assert((await generateFlowBriefing("nope", stubborn)) === undefined, "an unknown flow has no briefing");
setPackFactsSource(undefined);

// --- 4. worth it? ----------------------------------------------------------------------------------------
const small = await runFlow([{ id: "only", agentId: "nyx", goal: "B: one small thing" }], { model: doing, worker: createStubWorker(), enableBaseSpace: true, maxToolHopsPerStep: 3 });
assert((await worthBriefing(small.flowId)) === false && (await worthBriefing(flow.flowId)) === true, "a small clean flow does not get a briefing; one with 4 steps and a todo left does");

// --- 4b. the flow that made a todo is recorded, and "needs you" lists it ------------------------------------------
const mine = (await loadOverlay()).tasks.find((t) => /Final pack name/.test(String(t.title)))!;
assert(mine.flowId === flow.flowId && typeof mine.createdAt === "string", "a todo made inside a flow step records the flow it came from");

// --- 5. routes -------------------------------------------------------------------------------------------------
const gateway = await startGateway({ model: createStubModel(), worker: createStubWorker() });
const base = `http://127.0.0.1:${gateway.port}`;
try {
  const r = await fetch(`${base}/flows/${flow.flowId}/briefing`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert(r.status === 200 && typeof ((await r.json()) as { text?: string }).text === "string", "POST /flows/:id/briefing writes one");
  const rep = (await (await fetch(`${base}/flows/${flow.flowId}/report`)).json()) as { briefing?: { text?: string; by?: string } };
  assert(typeof rep.briefing?.text === "string" && rep.briefing.by === "hemera", "GET /flows/:id/report carries it");
  const ny = (await (await fetch(`${base}/basespace/needs-you`)).json()) as { total: number; approvals: unknown[]; todos: { title: string; flowId?: string; flowTitle?: string; priority: string }[] };
  const nt = ny.todos.find((t) => /Final pack name/.test(t.title));
  assert(!!nt && nt.flowId === flow.flowId && nt.flowTitle === "Salient launch prep" && ny.total === ny.approvals.length + ny.todos.length, "GET /basespace/needs-you lists the open todos with the flow (and its title) they came from");
  await completeOverlayTodo(mine.id as string, { answer: "x" });
  const ny2 = (await (await fetch(`${base}/basespace/needs-you`)).json()) as { todos: { title: string }[] };
  assert(!ny2.todos.some((t) => /Final pack name/.test(t.title)), "…and a completed one is no longer listed");
  assert((await fetch(`${base}/flows/nope/briefing`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status === 404, "an unknown flow is a 404");
} finally {
  await gateway.stop();
}

console.log(failed ? "\nSome flow-briefing tests FAILED." : "\nAll flow-briefing tests passed.");
process.exit(failed ? 1 : 0);
