// Tests completing an agent's todo, answering a question todo, and todos that complete when a note changes.
// Proves:
//   1. Completing through the gateway marks the todo done in the overlay and keeps the operator's answer on it, which agents then read.
//   2. A todo ticked in BaseSpace (it arrives in the next snapshot) is done in the overlay too.
//   3. A todo with doneWhen completes by itself, with an event, once the text it waits on is gone from the note: not before the note
//      ever held that text, and not while it is still there.
//   4. A note the operator edited in BaseSpace after the agent wrote it is the one agents read.
//   5. The gateway route completes and reopens; an unknown todo is a 404.
// Run with: node dist/test-todo-complete.js

import "./test-helpers/isolate.js";
import { addOverlayItem, completeOverlayTodo, createStubModel, createStubWorker, loadOverlay, readSnapshotSection, reopenOverlayTodo, saveSnapshot, subscribeToEvent } from "./core/index.js";
import { startGateway } from "./gateway/server.js";

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`ok: ${msg}`);
  else {
    failed = true;
    console.log(`FAIL: ${msg}`);
  }
}
const idOf = (out: string) => /id (\S+?)[,.]/.exec(out)![1]!;
const todo = async (id: string) => (await loadOverlay()).tasks.find((t) => t.id === id)!;
const events: { id: string; auto: boolean; reason?: string; answer?: string }[] = [];
subscribeToEvent("basespace.todo.completed", (_type, payload) => void events.push(payload as never));

// --- 1. completing with an answer ------------------------------------------------------------
const q = idOf((await addOverlayItem("todo", { title: "Final pack name: choose from 4 options" }, "mnemosyne")).output);
const done = await completeOverlayTodo(q, { answer: "  Salient  " });
const t1 = await todo(q);
assert(done.ok && t1.status === "done" && t1.answer === "Salient" && t1.completedBy === "operator" && typeof t1.completedAt === "string", "completing a todo marks it done and keeps the answer (trimmed), who and when");
await saveSnapshot({ schema: 1, todos: [], notes: [] });
const read = await readSnapshotSection("todos", { id: q });
assert(/Salient/.test(read.output) && /"answer"/.test(read.output), "an agent reading the todo sees the answer, not only that it is done");
assert(events.some((e) => e.id === q && e.auto === false && e.answer === "Salient"), "an event announces the completion");
assert((await completeOverlayTodo("nope")).ok === false, "an unknown todo is refused");
assert((await reopenOverlayTodo(q)) && (await todo(q)).status === "todo" && (await todo(q)).answer === undefined, "reopening clears the answer and the done state");

// --- 2. ticked in BaseSpace -----------------------------------------------------------------------
const tick = idOf((await addOverlayItem("todo", { title: "Cover art" }, "mnemosyne")).output);
await saveSnapshot({ schema: 1, notes: [], todos: [{ id: tick, title: "Cover art", status: "done" }] });
assert((await todo(tick)).status === "done" && (await todo(tick)).completedBy === "operator", "a todo ticked in BaseSpace is done in the overlay after the next snapshot");
assert(!events.some((e) => e.id === tick), "…without announcing it back to the person who ticked it");

// --- 3. completes when the note changes ----------------------------------------------------------------
await addOverlayItem("note", { title: "License in plain words", body: "Open: [email] and [governing law]" }, "mnemosyne");
const w = idOf((await addOverlayItem("todo", { title: "License: fill [email]", doneWhenNote: "License in plain words", doneWhenGone: "[email]" }, "mnemosyne")).output);
const early = idOf((await addOverlayItem("todo", { title: "Never armed", doneWhenNote: "License in plain words", doneWhenGone: "[something else]" }, "mnemosyne")).output);
const snapWith = (body: string, updated: string) => ({ schema: 1, todos: [], notes: [{ id: "n1", title: "License in plain words", body, updated }] });
await saveSnapshot(snapWith("Open: [email] and [governing law]", new Date().toISOString()));
assert((await todo(w)).status === "todo" && (await todo(w)).doneWhen !== undefined, "while the note still holds the text, the todo stays open");
await saveSnapshot(snapWith("Open: [governing law]", new Date(Date.now() + 5000).toISOString()));
const t3 = await todo(w);
assert(t3.status === "done" && t3.completedBy === "auto" && /no longer in the note/.test(String(t3.completedBecause)), "once the text is gone from the note the todo completes by itself, and says why");
assert(events.some((e) => e.id === w && e.auto === true && /\[email\]/.test(e.reason ?? "")), "…with an event the app turns into a notification");
assert((await todo(early)).status === "todo", "a todo whose text was never in the note is not completed (it was never armed)");
const governing = idOf((await addOverlayItem("todo", { title: "License: fill [governing law]", doneWhenNote: "License in plain words", doneWhenGone: "[governing law]" }, "mnemosyne")).output);
await saveSnapshot(snapWith("Open: [governing law]", new Date(Date.now() + 9000).toISOString()));
assert((await todo(governing)).status === "todo", "a different bracket still in the note keeps its own todo open");

// --- 4. the operator's edit is read ----------------------------------------------------------------------
const nid = idOf((await addOverlayItem("note", { title: "Plan B", body: "agent version" }, "nyx")).output);
await saveSnapshot({ schema: 1, todos: [], notes: [{ id: nid, title: "Plan B", body: "operator edit", updated: new Date(Date.now() + 60_000).toISOString() }] });
assert(/operator edit/.test((await readSnapshotSection("notes", { id: nid })).output), "a note the operator edited after the agent wrote it is read in their version");
await saveSnapshot({ schema: 1, todos: [], notes: [{ id: nid, title: "Plan B", body: "old snapshot", updated: "2020-01-01T00:00:00.000Z" }] });
assert(/agent version/.test((await readSnapshotSection("notes", { id: nid })).output), "…but an older snapshot copy does not override the agent's newer one");

// --- 5. the route ----------------------------------------------------------------------------------------------
const gateway = await startGateway({ model: createStubModel(), worker: createStubWorker() });
const base = `http://127.0.0.1:${gateway.port}`;
try {
  const rid = idOf((await addOverlayItem("todo", { title: "Price: set final price and currency" }, "mnemosyne")).output);
  const post = (p: string, body?: unknown) => fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const ok = await post(`/basespace/overlay/tasks/${rid}/complete`, { answer: "29 USD" });
  assert(ok.status === 200 && ((await ok.json()) as any).answer === "29 USD" && (await todo(rid)).status === "done", "POST …/complete with an answer completes it");
  assert((await post(`/basespace/overlay/tasks/${rid}/reopen`)).status === 200 && (await todo(rid)).status === "todo", "POST …/reopen puts it back");
  assert((await post(`/basespace/overlay/tasks/ghost/complete`)).status === 404, "an unknown todo is a 404");
} finally {
  await gateway.stop();
}

console.log(failed ? "\nSome todo-complete tests FAILED." : "\nAll todo-complete tests passed.");
process.exit(failed ? 1 : 0);
