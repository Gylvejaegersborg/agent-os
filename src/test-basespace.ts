// Standalone tests for the BaseSpace bridge (basespace.ts), the team-cron
// slot maths (gateway/basespace-crons.ts), registry → model tool specs
// (models/real.ts) and the optional Hindsight client (hindsight.ts),
// against a fake Hindsight HTTP server — no Docker, no network.
// Run with: node dist/test-basespace.js

import "./test-helpers/isolate.js";
import { createServer } from "node:http";
import {
  saveSnapshot,
  readSnapshotSection,
  addOverlayItem,
  loadOverlay,
  removeOverlayItem,
  registryToolSpecs,
  hindsightConfigured,
  hindsightRetain,
  hindsightRecall,
  hindsightReflect,
  hindsightBank,
  runTurn,
  newSessionId,
  createStubModel,
  createStubWorker,
  registerTool,
  RECALL_MEMORY_TOOL,
} from "./core/index.js";
import { previousSlotMs, standupPrompt } from "./gateway/basespace-crons.js";

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`ok: ${msg}`);
  else {
    failed = true;
    console.log(`FAIL: ${msg}`);
  }
}

const today = new Date().toISOString().slice(0, 10);

async function testSnapshot(): Promise<void> {
  const before = await readSnapshotSection("summary");
  assert(!before.ok && /hasn't sent a snapshot/.test(before.error ?? ""), "reading before any snapshot says so instead of failing obscurely");

  let rejected = false;
  try {
    await saveSnapshot({ notes: [] });
  } catch {
    rejected = true;
  }
  assert(rejected, "a body without a schema field is rejected");

  const saved = await saveSnapshot({
    schema: 1,
    exportedAt: new Date().toISOString(),
    notes: [
      { id: "n1", title: "Mixing checklist", folder: "Music", tags: ["mix"], updated: today, body: "- gain stage\n- check mono" },
      { id: "n2", title: "Grocery list", folder: "Life", tags: [], updated: today, body: "eggs" },
    ],
    projects: [{ id: "p1", name: "Switch release", status: "active", progress: 60, tags: [], props: {}, nextMoves: ["Master"], recent: [] }],
    todos: [
      { id: "t1", title: "Send stems", status: "todo", priority: "high", due: today, source: "manual" },
      { id: "t2", title: "Old thing", status: "done", priority: "low", source: "manual" },
    ],
    events: [{ id: "e1", title: "Studio", kind: "work", date: today, start: 10, end: 12, recurring: false }],
    crons: [],
    teams: [{ id: "isark", name: "ISΛRK artist team", members: ["hemera", "nyx"] }],
  });
  assert(saved.bytes > 0, "a valid snapshot is saved");

  const summary = await readSnapshotSection("summary");
  assert(summary.ok && summary.output.includes("Send stems") && !summary.output.includes("Old thing"), "summary lists open todos due this week, not done ones");
  assert(summary.output.includes("Switch release"), "summary lists active projects");

  const notes = await readSnapshotSection("notes");
  assert(notes.ok && notes.output.includes("Mixing checklist") && !notes.output.includes("gain stage"), "notes are listed without their bodies");
  const one = await readSnapshotSection("notes", { id: "n1" });
  assert(one.ok && one.output.includes("gain stage"), "a note fetched by id includes its body");
  const byTitle = await readSnapshotSection("notes", { id: "grocery list" });
  assert(byTitle.ok && byTitle.output.includes("eggs"), "a note can be fetched by (case-insensitive) title too");
  const q = await readSnapshotSection("notes", { query: "mono" });
  assert(q.ok && q.output.includes("1 notes matching") && q.output.includes("Mixing checklist"), "query filters by text, including bodies");
  const bad = await readSnapshotSection("widgets");
  assert(!bad.ok, "an unknown section is an error that names the valid ones");
}

async function testOverlay(): Promise<void> {
  const empty = await loadOverlay();
  assert(empty.notes.length === 0 && empty.tasks.length === 0, "overlay starts empty");

  const note = await addOverlayItem("note", { title: "Standup — 2026-09-27", body: "Decisions: …", folder: "Team/Meetings" }, "hemera");
  assert(note.ok, "an agent can add a note");
  const todo = await addOverlayItem("todo", { title: "Approve cover art", due: "2026-10-01", time: "09:30", priority: "high" }, "nyx");
  assert(todo.ok, "an agent can add a timed todo");
  const badDue = await addOverlayItem("todo", { title: "x", due: "next friday" }, "nyx");
  assert(!badDue.ok, "a malformed due date is rejected");
  const upd = await addOverlayItem("project-update", { projectId: "p1", text: "Mastered v2" }, "aether");
  assert(upd.ok, "an agent can post a project update for a known project");
  const unknown = await addOverlayItem("project-update", { projectId: "nope", text: "x" }, "aether");
  assert(!unknown.ok, "a project update for an unknown project is refused");

  const o = await loadOverlay();
  assert(o.notes.length === 1 && o.notes[0].folder === "Team/Meetings", "the note lands in the requested folder");
  const t = o.tasks[0] as Record<string, unknown>;
  assert(t.due === "2026-10-01" && t.dueTime === 9.5 && t.notify === true, "the todo keeps its due date, time (as hours) and notifies");
  assert(String(t.notes).includes("Nyx"), "the todo says which agent added it");
  assert((o.projects[0] as Record<string, unknown>).lastMove === "Mastered v2 — Aether", "the project update is attributed");

  const removed = await removeOverlayItem("todo", String(t.id));
  assert(removed && (await loadOverlay()).tasks.length === 0, "an agent-added item can be removed");
}

function testSlots(): void {
  const at = (h: number, m: number) => {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d.getTime();
  };
  const daily = previousSlotMs({ type: "daily", hour: 7.5 }, at(8, 0));
  assert(daily === at(7, 30), "a daily 07:30 job's latest slot at 08:00 is today 07:30");
  const early = previousSlotMs({ type: "daily", hour: 7.5 }, at(6, 0))!;
  assert(early === at(7, 30) - 86_400_000, "before 07:30 the latest slot is yesterday's");
  assert(previousSlotMs({ type: "everyHours", n: 6 }, at(13, 5)) === at(12, 0), "a 6-hourly job's latest slot at 13:05 is 12:00");
  const prompt = standupPrompt(
    { id: "c1", name: "ISΛRK standup", owner: "Hemera", team: "isark", schedule: { type: "daily", hour: 7.5 } },
    { id: "isark", name: "ISΛRK artist team", members: ["hemera", "nyx"] },
    new Date(at(7, 30)),
  );
  assert(prompt.includes("Team/Meetings") && prompt.includes("basespace-add") && prompt.includes("nyx"), "the standup prompt tells the chair where to write minutes and who's in it");
}

function testToolSpecs(): void {
  const specs = registryToolSpecs();
  const bs = specs.find((s) => s.name === "basespace");
  assert(!!bs, "registry tool specs include the basespace tool");
  const params = bs?.parameters as { required?: string[]; properties?: Record<string, unknown> };
  assert(params.required?.includes("section") === true && !!params.properties?.query, "tool specs carry JSON-schema properties and required fields");
  assert(specs.some((s) => s.name === "basespace-add") && specs.some((s) => s.name === "shell"), "all registered tools are offered, not just new ones");
}

async function testTurnToolDispatch(): Promise<void> {
  // A scripted model: first asks for the basespace tool, then answers with
  // whatever the tool returned — proves dispatch reaches basespace.ts.
  let calls = 0;
  let toolOutput = "";
  const model = {
    id: "scripted",
    async complete(messages: { role: string; content: string }[]) {
      calls++;
      if (calls === 1) return { content: "", toolCall: { name: "basespace", args: { section: "todos", query: "stems" } } };
      toolOutput = messages.filter((m) => m.role === "tool").pop()?.content ?? "";
      return { content: "done" };
    },
  };
  const result = await runTurn({ sessionId: newSessionId(), agentId: "hemera", userMessage: "what's on?", model: model as never, worker: createStubWorker(), injectMemory: false });
  assert(result.toolCalled === "basespace" && toolOutput.includes("Send stems"), "a model's basespace tool call is dispatched and its result fed back");
}

async function testHindsight(): Promise<void> {
  delete process.env.HINDSIGHT_URL;
  assert(!hindsightConfigured(), "Hindsight is off without HINDSIGHT_URL");
  assert((await hindsightRecall("hemera", "anything")).length === 0, "recall is a quiet no-op when off");
  assert((await hindsightRetain("hemera", "x")) === false, "retain is a quiet no-op when off");

  const seen: { method: string; url: string; body: any; auth?: string }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ method: req.method!, url: req.url!, body, auth: req.headers.authorization });
      res.setHeader("content-type", "application/json");
      if (req.url!.endsWith("/memories/recall")) res.end(JSON.stringify({ results: String(body?.query).includes("zzz-nothing-known") ? [] : [{ id: "1", text: "ISΛRK prefers sparse lowercase copy." }] }));
      else if (req.url!.endsWith("/reflect")) res.end(JSON.stringify({ text: "Keep captions short." }));
      else if (req.url!.endsWith("/memories")) res.end(JSON.stringify({ success: true }));
      else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  process.env.HINDSIGHT_URL = `http://127.0.0.1:${port}`;
  process.env.HINDSIGHT_API_KEY = "test-key";

  assert(await hindsightRetain("nyx", "Posted the W26 teaser.", { tags: ["outcome"] }), "retain succeeds against the API");
  const r = seen.find((s) => s.url === `/v1/default/banks/${hindsightBank("nyx")}/memories`);
  assert(!!r && r.body.items[0].content === "Posted the W26 teaser." && r.body.async === true, "retain posts items to the agent's bank asynchronously");
  assert(r?.auth === "Bearer test-key", "the API key is sent as a Bearer token");

  const lines = await hindsightRecall("nyx", "how should captions sound?");
  assert(lines[0] === "ISΛRK prefers sparse lowercase copy.", "recall returns the memory texts");
  assert((await hindsightReflect("nyx", "captions?")) === "Keep captions short.", "reflect returns the answer text");

  // Recall shows up in a real turn's system message.
  const recorded: { role: string; content: string }[][] = [];
  const stub = createStubModel();
  const offeredTools: string[][] = [];
  const model = { ...stub, complete: async (m: { role: string; content: string }[], o?: { tools?: { name: string }[] }) => (recorded.push(m), offeredTools.push((o?.tools ?? []).map((t) => t.name)), stub.complete(m as never)) } as typeof stub;
  delete (model as { completeStream?: unknown }).completeStream;
  await runTurn({ sessionId: newSessionId(), agentId: "nyx", userMessage: "write a caption", model, worker: createStubWorker() });
  const system = recorded[0]?.find((m) => m.role === "system")?.content ?? "";
  assert(system.includes("Recalled from long-term memory") && system.includes("sparse lowercase"), "recalled memories are injected into the turn's system message");
  await new Promise((r) => setTimeout(r, 50));
  assert(seen.some((s) => s.url.endsWith("/memories") && String(s.body.items[0].content).startsWith("User: write a caption")), "the finished exchange is retained");

  // recall-memory duplicates the automatic recall already in the system prompt, so it is only
  // offered when that recall found nothing (a small model handed it looped on it, live).
  registerTool(RECALL_MEMORY_TOOL);
  const callsBefore = offeredTools.length;
  await runTurn({ sessionId: newSessionId(), agentId: "nyx", userMessage: "what do you remember about captions?", model, worker: createStubWorker() });
  assert(offeredTools.slice(callsBefore).every((t) => !t.includes("recall-memory")), "recall-memory is not offered when automatic recall already found something");
  const emptyFrom = offeredTools.length;
  await runTurn({ sessionId: newSessionId(), agentId: "nyx", userMessage: "zzz-nothing-known about this", model, worker: createStubWorker(), enableBaseSpace: true });
  assert(offeredTools.slice(emptyFrom).some((t) => t.includes("recall-memory")), "…and is offered when it found nothing");
  assert(recorded.at(-1)?.find((m) => m.role === "system")?.content.includes("Nothing relevant was recalled automatically") === true, "…with a system-prompt line saying so");

  // The harness talking to itself isn't memory: a [Work] brief, a [Review]
  // digest, an [Approvals] note and a cron standup prompt finish as real
  // answers but are not retained (each retain costs an LLM extraction, and
  // the outcome already lives in work items / notes / approvals).
  const retainsBefore = () => seen.filter((s) => s.url.endsWith("/memories")).length;
  const before = retainsBefore();
  for (const harness of ["[Work] Hemera handed you this (work item x): Draft captions", "[Review] Team review: 1 item needs you.", "[Approvals] Approved abc: shell {}. Go ahead", `It's time for "Morning standup" — you chair it.`]) {
    await runTurn({ sessionId: newSessionId(), agentId: "nyx", userMessage: harness, model, worker: createStubWorker() });
  }
  await new Promise((r) => setTimeout(r, 80));
  assert(retainsBefore() === before, "harness-written turns ([Work], [Review], [Approvals], cron standups) are not retained");
  await runTurn({ sessionId: newSessionId(), agentId: "nyx", userMessage: "keep it lowercase please", model, worker: createStubWorker() });
  await new Promise((r) => setTimeout(r, 80));
  assert(retainsBefore() === before + 1, "an operator's own message still is");

  // A turn with a tool hop still recalls only once (the query doesn't
  // change between hops).
  const recallsBefore = seen.filter((s) => s.url.endsWith("/memories/recall")).length;
  const hopTurn = await runTurn({ sessionId: newSessionId(), agentId: "nyx", userMessage: "run shell: echo hi", model, worker: createStubWorker() });
  const recallsDuring = seen.filter((s) => s.url.endsWith("/memories/recall")).length - recallsBefore;
  assert(hopTurn.toolCalled === "shell" && recallsDuring === 1, `a turn with a tool hop recalls once (got ${recallsDuring})`);

  process.env.HINDSIGHT_URL = "http://127.0.0.1:1"; // nothing listening
  assert((await hindsightRecall("nyx", "x")).length === 0, "an unreachable Hindsight degrades to no recall instead of failing the turn");
  delete process.env.HINDSIGHT_URL;
  server.close();
}

await testSnapshot();
await testOverlay();
testSlots();
testToolSpecs();
await testTurnToolDispatch();
await testHindsight();

console.log(failed ? "\nSome basespace tests FAILED." : "\nAll basespace tests passed.");
process.exit(failed ? 1 : 0);
