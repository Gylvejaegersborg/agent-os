// Tests the fact check done by code (pack-check.ts) and its place in a flow step.
//   1. Counts written as "N x kind", "kind (N)" and table rows are compared to the pack; the total too; lowercase isark/salient.
//   2. A correct note has no problems; plurals work; a kind the pack does not have is flagged.
//   3. In a flow step with check "pack-facts": wrong numbers are sent back to the agent as an exact list, and a step whose notes
//      are fixed in the correction round succeeds; one that stays wrong FAILS with the list, whatever it reports.
// Run with: node dist/test-pack-check.js

import "./test-helpers/isolate.js";
import { addOverlayItem, checkTextAgainstPack, createStubWorker, getFlow, getTask, runFlow, seedDefaultAgents, setPackFactsSource, type ModelAdapter, type ModelResponse } from "./core/index.js";

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`ok: ${msg}`);
  else {
    failed = true;
    console.log(`FAIL: ${msg}`);
  }
}

const counts = { "808": 6, kick: 4, snare: 4, clap: 4, "hat-closed": 7, "hat-open": 5, bell: 5, keys: 9, pad: 5, lead: 4, perc: 7, pluck: 6, strings: 5 };
const facts = { name: "Salient", counts, total: 71 };
setPackFactsSource(async () => facts);

// --- 1/2. the text check -----------------------------------------------------------------------
const good = "# Salient\n**Kicks:** 4 × kick\n**808s:** 6 × 808\nkeys (9), hat-closed (7)\n| snare | 4 |\n71 sounds by ISARK. 5 × bell, 4 claps? no: 4 × clap";
assert(checkTextAgainstPack(good, facts).length === 0, "a note whose numbers are right has no problems (× or x, 'kind (N)', table rows, plurals)");
const bad = checkTextAgainstPack("5 × kick, 5 × snare, keys (10), | pad | 6 |, 70 sounds, tagged isark, the salient pack", facts);
assert(bad.some((p) => /has 4 kick, not 5/.test(p)) && bad.some((p) => /has 4 snare, not 5/.test(p)) && bad.some((p) => /has 9 keys, not 10/.test(p)) && bad.some((p) => /has 5 pad, not 6/.test(p)), "every wrong count is named with the real one");
assert(bad.some((p) => /71 sounds, not 70/.test(p)) && bad.some((p) => /write ISARK/.test(p)) && bad.some((p) => /Salient/.test(p)), "the wrong total, lowercase isark and lowercase salient are flagged");
assert(checkTextAgainstPack("made by isark tag", facts).length === 1, "lowercase isark followed by a space is still flagged");
assert(checkTextAgainstPack("see isark.net and @isark and ISARK", facts).length === 0, "a url or handle containing isark is not flagged; ISARK is fine");
assert(checkTextAgainstPack("6 × 808 and 6 × 808 and 6 × 808", facts).length === 0 && checkTextAgainstPack("5 × kick 5 × kick", facts).length === 1, "the same problem is listed once");

// --- 3. in a flow step ---------------------------------------------------------------------------
await seedDefaultAgents();
let mode: "fixes" | "stubborn" = "fixes";
const prompts: string[] = [];
const noteCall = (title: string, body: string) => ({ name: "basespace-add", args: { kind: "note", title, body, folder: "Agents/Nyx" } });
const model: ModelAdapter = {
  id: "scripted",
  async complete(messages): Promise<ModelResponse> {
    const user = messages.filter((m) => m.role === "user").map((m) => m.content);
    const last = user[user.length - 1] ?? "";
    prompts.push(last);
    const lastRole = messages[messages.length - 1]!.role;
    if (last.startsWith("A check run by code")) {
      if (lastRole === "tool") return { content: "Fixed: kicks now 4." };
      if (mode === "stubborn") return { content: "", toolCall: noteCall("Listing", "5 × kick again") };
      return { content: "", toolCall: { name: "basespace-add", args: { kind: "note", title: "Listing", edit: [{ find: "5 × kick", replace: "4 × kick" }] } } };
    }
    if (lastRole === "tool") return { content: "Wrote the listing." };
    return { content: "", toolCall: noteCall("Listing", "Salient: 5 × kick, 6 × 808") };
  },
};
const steps = [{ id: "write", agentId: "nyx", goal: "Write the listing", check: "pack-facts" as const }];
const r1 = await runFlow(steps, { model, worker: createStubWorker(), enableBaseSpace: true, maxToolHopsPerStep: 6 });
assert(r1.status === "succeeded" && prompts.some((p) => /has 4 kick, not 5/.test(p)), "wrong counts go back to the agent as an exact list, and the step succeeds once they are fixed");
assert(!checkTextAgainstPack(((await import("./core/basespace.js")).loadOverlay && (await (await import("./core/basespace.js")).loadOverlay()).notes.find((n) => n.title === "Listing")!.body) as string, facts).length, "…and the saved note really holds the right number");

mode = "stubborn";
await addOverlayItem("note", { title: "Listing", body: "Salient: 5 × kick" }, "nyx");
prompts.length = 0;
const r2 = await runFlow([{ id: "write2", agentId: "nyx", goal: "Write the listing again", check: "pack-facts" as const }], { model, worker: createStubWorker(), enableBaseSpace: true, maxToolHopsPerStep: 6 });
const t2 = (await getFlow(r2.flowId))!.steps[0]!;
const task2 = await getTask(t2.taskId!);
assert(r2.status === "failed" && /fact check still fails/.test(String(task2?.output?.error)) && /has 4 kick, not 5/.test(String(task2?.output?.error)), "a step whose notes stay wrong FAILS with the list, after at most two correction rounds");
assert(prompts.filter((p) => p.startsWith("A check run by code")).length >= 1 && prompts.filter((p) => p.startsWith("A check run by code")).length <= 4, "the correction rounds are bounded");

// no check requested: nothing is run
prompts.length = 0;
mode = "fixes";
const r3 = await runFlow([{ id: "plain", agentId: "nyx", goal: "Write the listing, no check" }], { model, worker: createStubWorker(), enableBaseSpace: true, maxToolHopsPerStep: 6 });
assert(r3.status === "succeeded" && !prompts.some((p) => p.startsWith("A check run by code")), "a step without the check is not checked");

setPackFactsSource(undefined);
console.log(failed ? "\nSome pack-check tests FAILED." : "\nAll pack-check tests passed.");
process.exit(failed ? 1 : 0);
