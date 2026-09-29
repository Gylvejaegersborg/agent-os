// Tests for the watchdog (core/watchdog.ts) with the real work runner and a
// scripted team: Nyx really adds her captions to BaseSpace; Hermes claims a
// press list was "sent to 12 blogs" without doing anything, then does it
// properly once sent back; Aether never delivers.
// Proves:
//   1. Nothing is verified while an item under the watch is still running;
//      once all have stopped, the verifier gets ONE verification item whose
//      evidence shows claims next to what actually ran (and what an added
//      note really says).
//   2. The verifier runs with only `work` and `basespace`, may reopen the
//      items it's verifying — and nothing else.
//   3. A reopened item re-runs and is verified again; the watch ends
//      "verified", and the verdict is posted back to the asking thread.
//   4. After MAX_ROUNDS failed verifications the watch is left for the
//      operator; an all-cancelled watch just closes.
//   5. delegate {verify:true}, POST /work {verify:true}, POST /work/:id/verify,
//      GET /watches.
// Run with: node dist/test-watchdog.js

import "./test-helpers/isolate.js";
process.env.CLAUDE_CLI_PATH = "/nonexistent/claude"; // no real providers in this test

import {
  MAX_ROUNDS,
  OPERATOR,
  addOverlayItem,
  loadOverlay,
  readSnapshotSection,
  saveSnapshot,
  cancelWork,
  checkWatches,
  createSession,
  createStubWorker,
  createWork,
  getSessionHistory,
  getWatch,
  getWork,
  listWatches,
  pauseAgent,
  reopenWork,
  resumeAgent,
  runTurn,
  seedDefaultAgents,
  subscribeToAllEvents,
  watchWork,
  type ModelAdapter,
  type ModelCallOptions,
  type ModelMessage,
  type ModelResponse,
} from "./core/index.js";
import { startGateway } from "./gateway/server.js";
import { startWorkRunner } from "./gateway/work-runner.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

async function throwsWith(p: Promise<unknown>, re: RegExp): Promise<boolean> {
  try {
    await p;
    return false;
  } catch (err) {
    return re.test(String(err));
  }
}

const attempts = new Map<string, number>();
const verifyBriefs: string[] = [];
const verifierTools: string[][] = [];
const workPrompts: string[] = [];
let lazyVerifier = false;

const scripted: ModelAdapter = {
  id: "scripted",
  async complete(messages: ModelMessage[], callOpts?: ModelCallOptions): Promise<ModelResponse> {
    const first = messages.find((m) => m.role === "user")?.content ?? "";
    const toolMsgs = messages.filter((m) => m.role === "tool");
    const last = messages[messages.length - 1]!;
    const call = (name: string, args: Record<string, unknown>): ModelResponse => ({ content: "", toolCall: { name, args } });

    if (first.includes("asked you to verify")) {
      verifierTools.push((callOpts?.tools ?? []).map((t) => t.name).sort());
      if (!toolMsgs.length) verifyBriefs.push(first);
      // Send back every item whose claim has nothing behind it, then report.
      const unbacked = [...first.matchAll(/### (\S+) "[^"]+" — \w+, done\n(?:.*\n)*?  what actually ran:\n  \(no tool calls/g)].map((m) => m[1]!);
      // A verifier that sends things back, then wanders off without a verdict.
      if (lazyVerifier && toolMsgs.length) return call("basespace", { section: "notes", query: "anything" });
      const next = unbacked[toolMsgs.length];
      if (next) return call("work", { action: "reopen", id: next, text: "No evidence this happened — nothing was added or sent." });
      return call("work", { action: "done", text: unbacked.length ? `Reopened ${unbacked.length}: claims without evidence. Rest accepted.` : "All accepted: claims match what ran." });
    }
    if (!first.startsWith("[Work]")) {
      if (last.content.includes("delegate captions")) return call("delegate", { to: "nyx", title: "Captions for the teaser", verify: true });
      return { content: "ok" };
    }
    const title = /: (.*)$/m.exec(first.split("\n")[0]!)?.[1] ?? "";
    if (!toolMsgs.length) workPrompts.push(first);
    if (toolMsgs.length) return call("work", { action: "done", text: `Done: ${title} — in Notes.` });
    const n = (attempts.get(title) ?? 0) + 1;
    if (!toolMsgs.length) attempts.set(title, n);
    if (title.includes("Captions")) {
      return call("basespace-add", { kind: "note", title: "Teaser captions", body: "a / b / c" });
    }
    if (title.includes("Press list")) {
      // First time: a claim with nothing behind it. Sent back: does it.
      if (n === 1) return call("work", { action: "done", text: "Press list sent to 12 blogs." });
      return call("basespace-add", { kind: "note", title: "Press list", body: "12 blogs: …" });
    }
    if (title.includes("Stems")) return call("work", { action: "done", text: "Stems delivered." }); // never backed
    return { content: "Done." };
  },
};

let runner: ReturnType<typeof startWorkRunner>;
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await runner.idle();
    await checkWatches();
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function testVerifyAndReopen(): Promise<void> {
  const hemera = await createSession({ agentId: "hemera" });
  const captions = await createWork({ title: "Captions for the teaser", assignee: "nyx", requestedBy: "hemera", requestedFromSessionId: hemera.id });
  const press = await createWork({ title: "Press list for Switch", assignee: "hermes", requestedBy: "hemera", requestedFromSessionId: hemera.id });
  const watch = await watchWork({ rootIds: [captions.id, press.id], label: "Switch teaser week", createdBy: "hemera", originSessionId: hemera.id });
  assert((await watchWork({ rootIds: [press.id, captions.id], createdBy: "hemera" })).id === watch.id, "watching the same items again returns the same watch");

  await settle();
  const w = (await getWatch(watch.id))!;
  assert(verifyBriefs.length >= 1, "once both stopped, the verifier got a verification");
  const brief = verifyBriefs[0]!;
  assert(/"Captions for the teaser" — nyx, done[\s\S]*basespace-add[\s\S]*it says: a \/ b \/ c/.test(brief), "the evidence shows what actually ran and what the added note says");
  assert(/"Press list for Switch" — hermes, done\n  claims: Press list sent to 12 blogs\.\n  what actually ran:\n  \(no tool calls/.test(brief), "…and a claim with nothing behind it");
  assert(verifierTools.every((t) => t.join() === "basespace,work"), "the verifier only has work and basespace");
  assert(attempts.get("Press list for Switch") === 2 && attempts.get("Captions for the teaser") === 1, "the unbacked item was sent back and re-run; the backed one wasn't");
  assert(w.status === "verified" && w.rounds === 2 && /All accepted/.test(w.verdict ?? ""), "round 2 accepts everything: the watch is verified");
  const notes = (await getSessionHistory(hemera.id)).filter((m) => m.content.startsWith("[Work] ")).map((m) => m.content);
  assert(notes.some((n) => /Argus finished "Verify: Switch teaser week": Reopened 1/.test(n)) && notes.some((n) => /All accepted/.test(n)), "each verdict is posted back to the thread that asked");

  assert(workPrompts.some((p) => p.includes("Press list for Switch") && /sent back to you by argus: No evidence this happened/.test(p)), "the re-run is told why it was sent back");
  const other = await createWork({ title: "Unrelated", assignee: "theia", requestedBy: OPERATOR });
  assert(await throwsWith(reopenWork(other.id, "argus", "x"), /manager or the operator/), "the verifier can't reopen work it isn't verifying");
}

async function testOverlayAndDedupe(): Promise<void> {
  const first = await addOverlayItem("note", { title: "Moodboard", body: "v1" }, "nyx");
  const id = /id (agent-[\w-]+)/.exec(first.output)![1]!;
  const read = await readSnapshotSection("notes", { id });
  assert(read.ok && read.output.includes('"v1"'), "an agent can read a note a teammate just added, before BaseSpace syncs");
  const again = await addOverlayItem("note", { title: "Moodboard", body: "v2" }, "nyx");
  const notes = (await loadOverlay()).notes.filter((n) => n.title === "Moodboard");
  assert(notes.length === 1 && notes[0]!.body === "v2" && /replaced, not duplicated/.test(again.output), "adding the same note again updates it instead of duplicating");
}

async function testLazyVerifier(): Promise<void> {
  lazyVerifier = true;
  attempts.delete("Press list for Switch");
  const press = await createWork({ title: "Press list for Switch", assignee: "hermes", requestedBy: OPERATOR });
  const watch = await watchWork({ rootIds: [press.id], label: "press again", createdBy: OPERATOR });
  // Run until the first verification has settled, then let round 2 be done properly.
  for (let i = 0; i < 12 && (await getWatch(watch.id))!.rounds < 1; i++) {
    await runner.idle();
    await checkWatches();
  }
  lazyVerifier = false;
  await settle();
  const w = (await getWatch(watch.id))!;
  const verdicts = w.verificationIds.length;
  assert(verdicts === 2 && w.status === "verified", "a verifier that sent an item back but ran out of steps still counts: the item re-ran and round 2 verified it");
}

async function testVerifierPassesOwnId(): Promise<void> {
  // Argus live: reopened "the item" by passing his own verification's id.
  const item = await createWork({ title: "Bio for the EPK", assignee: "theia", requestedBy: OPERATOR });
  const v = await createWork({ title: "Verify: bio", assignee: "argus", requestedBy: OPERATOR, kind: "verification", verifies: [item.id] });
  const { claimWork, completeWork } = await import("./core/index.js");
  await claimWork(item.id, "theia", "s-bio");
  await completeWork(item.id, "theia", "written");
  const s = await createSession({ agentId: "argus" });
  await claimWork(v.id, "argus", s.id);
  const own: ModelAdapter = {
    id: "own",
    async complete(messages: ModelMessage[]): Promise<ModelResponse> {
      if (messages[messages.length - 1]!.role === "tool") return { content: "Sent back." };
      return { content: "", toolCall: { name: "work", args: { action: "reopen", id: v.id, text: "No bio was added anywhere." } } };
    },
  };
  await runTurn({ sessionId: s.id, agentId: "argus", userMessage: "verify", model: own, worker: createStubWorker(), enableBaseSpace: true });
  const after = (await getWork(item.id))!;
  assert(after.status === "open" && after.notes.at(-1)?.text === "reopened: No bio was added anywhere.", "a verifier passing its own verification's id reopens the item it checks");
  await cancelWork(item.id, OPERATOR, "tidy");
  await cancelWork(v.id, OPERATOR, "tidy");
}

async function testGivesUp(): Promise<void> {
  const stems = await createWork({ title: "Stems for the remix", assignee: "aether", requestedBy: OPERATOR });
  const watch = await watchWork({ rootIds: [stems.id], createdBy: OPERATOR });
  await settle();
  const w = (await getWatch(watch.id))!;
  assert(w.status === "needs-operator" && w.rounds === MAX_ROUNDS, `after ${MAX_ROUNDS} failed verifications the watch is left for the operator`);

  const gone = await createWork({ title: "Old idea", assignee: "theia", requestedBy: OPERATOR });
  const gw = await watchWork({ rootIds: [gone.id], createdBy: OPERATOR });
  await cancelWork(gone.id, OPERATOR, "dropped");
  await settle();
  assert((await getWatch(gw.id))!.status === "closed", "a watch whose work was all cancelled just closes");
}

async function testNotBeforeStopped(): Promise<void> {
  // Nyx is paused, so the delegated item stays open (not stopped).
  await pauseAgent("nyx", { reason: "test" });
  const before = verifyBriefs.length;
  const s = await createSession({ agentId: "hemera" });
  await runTurn({ sessionId: s.id, agentId: "hemera", userMessage: "please delegate captions", model: scripted, worker: createStubWorker(), enableBaseSpace: true });
  await settle();
  const watch = (await listWatches()).find((w) => w.originSessionId === s.id)!;
  assert(!!watch && watch.status === "watching" && verifyBriefs.length === before, "delegate {verify: true} puts a watch on it; nothing is verified while it's still open");
  await resumeAgent("nyx");
  await settle();
  assert((await getWatch(watch.id))!.status === "verified", "once it runs and stops, it's verified");
}

async function testRoutes(): Promise<void> {
  const gateway = await startGateway({ model: scripted, worker: createStubWorker(), enableBaseSpace: true });
  const base = `http://127.0.0.1:${gateway.port}`;
  const post = (path: string, body: unknown = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const created = (await (await post("/work", { title: "Tour dates", assignee: "hermes", verify: true })).json()) as { id: string };
    const plain = (await (await post("/work", { title: "Moodboard", assignee: "nyx" })).json()) as { id: string };
    const watched = (await (await post(`/work/${plain.id}/verify`)).json()) as { rootIds: string[] };
    const list = (await (await fetch(`${base}/watches`)).json()) as { watches: { rootIds: string[] }[]; verifier: string };
    assert(list.verifier === "argus" && list.watches.some((w) => w.rootIds.includes(created.id)) && watched.rootIds[0] === plain.id, "POST /work {verify}, POST /work/:id/verify and GET /watches");
    assert(!(await getWork(created.id))!.kind, "the watched item itself is ordinary work");
  } finally {
    await gateway.stop();
  }
}

async function main(): Promise<void> {
  await seedDefaultAgents();
  await saveSnapshot({ schema: 1, notes: [] });
  await testVerifierPassesOwnId(); // before the runner starts picking items up
  runner = startWorkRunner({ model: scripted, worker: createStubWorker(), enableBaseSpace: true, maxToolHops: 4 }, { intervalMs: 60_000 });
  const unsub = subscribeToAllEvents((type) => {
    if (type.startsWith("work.") || type === "watch.created") void checkWatches();
  });
  try {
    await testVerifyAndReopen();
    await testOverlayAndDedupe();
    await testLazyVerifier();
    await testGivesUp();
    await testNotBeforeStopped();
    await testRoutes();
  } finally {
    unsub();
    runner.stop();
  }
  if (process.exitCode === 1) console.error("\nSome watchdog tests FAILED.");
  else console.log("\nAll watchdog tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
