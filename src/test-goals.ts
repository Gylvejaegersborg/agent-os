// Tests for goals and session focus: BaseSpace's goals → projects → todos
// and notes, as agents see them (basespace.ts), and a session "focused" on
// a goal or project (session.ts) getting the why-chain in every turn.
// Proves:
//   1. The basespace tool reads goals; the summary lists active goals; a
//      goal or project read by id comes with its chain, notes and todos.
//   2. focusContext for a project: next moves, the goal chain up to the top,
//      linked notes, only that project's open todos.
//   3. focusContext for a goal: its projects, sub-goals, its own todos and
//      its projects' todos.
//   4. A focused session's turns carry that block in the system message;
//      clearing the focus removes it.
//   5. Continuity back into BaseSpace: a note added in a focused session gets
//      a [[wikilink]] to the focus; a todo gets its projectId/goalId; a
//      project-update defaults to the focused project.
//   6. A subagent inherits its parent session's focus (session and Task).
//   7. Gateway: POST /sessions {focus}, PUT /sessions/:id/focus, 400s.
//   8. MCP: ask_agent {goalId} starts a focused conversation; basespace_add
//      {goalId} links the todo.
// Run with: node dist/test-goals.js

import "./test-helpers/isolate.js";
import {
  addOverlayItem,
  createSession,
  createStubModel,
  createStubWorker,
  focusContext,
  getSession,
  listTasks,
  loadOverlay,
  readSnapshotSection,
  registerAgent,
  runTurn,
  saveSnapshot,
  setSessionFocus,
  spawnSubagentTask,
  type ModelAdapter,
  type ModelMessage,
} from "./core/index.js";
import { startGateway } from "./gateway/server.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

const today = new Date().toISOString().slice(0, 10);

async function seed(): Promise<void> {
  await saveSnapshot({
    schema: 1,
    exportedAt: new Date().toISOString(),
    goals: [
      { id: "g-grow", title: "Grow ISΛRK as an artist", why: "Make music my main work", status: "active", projectIds: [], noteIds: ["n-vision"], progress: null },
      { id: "g-switch", title: "Release Switch in October", why: "First single of the new era", status: "active", target: "2026-10-30", parentId: "g-grow", projectIds: ["p-switch"], noteIds: ["n-mix"], progress: 60 },
    ],
    projects: [
      { id: "p-switch", name: "Switch release", status: "active", tagline: "The single", progress: 60, tags: [], props: {}, nextMoves: ["Master the single", "Brief the cover art"], recent: [{ date: `${today}T10:00:00Z`, text: "Mix approved" }], goalIds: ["g-switch"], noteIds: ["n-mix"] },
      { id: "p-other", name: "Beat store", status: "active", tagline: "", progress: 30, tags: [], props: {}, nextMoves: ["Add stems"], recent: [], goalIds: [], noteIds: [] },
    ],
    notes: [
      { id: "n-mix", title: "Mixing checklist", folder: "Music", tags: [], updated: today, body: "- gain stage\n[[Switch release]]" },
      { id: "n-vision", title: "Artist vision", folder: "Life", tags: [], updated: today, body: "[[Grow ISΛRK as an artist]]" },
    ],
    todos: [
      { id: "t1", title: "Send stems to mastering", status: "todo", priority: "high", due: today, source: "manual", projectId: "p-switch" },
      { id: "t2", title: "Old done thing", status: "done", priority: "low", source: "manual", projectId: "p-switch" },
      { id: "t3", title: "Pick a release date", status: "doing", priority: "med", source: "manual", goalId: "g-switch" },
      { id: "t4", title: "Unrelated chore", status: "todo", priority: "low", source: "manual" },
    ],
    events: [],
    crons: [],
    teams: [],
  });
}

async function testReading(): Promise<void> {
  const goals = await readSnapshotSection("goals");
  assert(goals.ok && goals.output.includes("Release Switch in October") && goals.output.includes("2 goals"), "section goals lists goals");
  const summary = await readSnapshotSection("summary");
  assert(summary.output.includes("activeGoals") && summary.output.includes("Switch release"), "the summary lists active goals with their projects");
  const project = await readSnapshotSection("projects", { id: "p-switch" });
  assert(project.output.includes("# What this work serves") && project.output.includes("which serves \"Grow ISΛRK as an artist\""), "a project by id comes with its goal chain");
}

async function testFocusContext(): Promise<void> {
  const p = await focusContext({ kind: "project", id: "p-switch" });
  assert(p.includes('the project "Switch release" (active, 60%)') && p.includes("- Master the single"), "project focus: name, status and next moves");
  assert(p.includes('It serves the goal "Release Switch in October", target 2026-10-30, 60% across its projects — why: First single of the new era'), "project focus: the goal it serves, with why and target");
  assert(p.includes('which serves "Grow ISΛRK as an artist"'), "project focus: up the chain to the top goal");
  assert(p.includes('"Mixing checklist" (id n-mix)'), "project focus: linked notes with ids");
  assert(p.includes("Send stems to mastering") && !p.includes("Old done thing") && !p.includes("Unrelated chore"), "project focus: only its open todos");

  const g = await focusContext({ kind: "goal", id: "g-switch" });
  assert(g.includes('the goal "Release Switch in October"') && g.includes('"Switch release" (active, 60%, id p-switch) — next: Master the single'), "goal focus: its projects and their next moves");
  assert(g.includes("Pick a release date") && g.includes("in progress") && g.includes("Send stems to mastering"), "goal focus: its own todos and its projects' todos");
  const top = await focusContext({ kind: "goal", id: "g-grow" });
  assert(top.includes("Sub-goals:") && top.includes("Release Switch in October") && top.includes('"Artist vision"'), "top goal: sub-goals and linked notes");
  assert((await focusContext({ kind: "project", id: "nope" })).includes("isn't in BaseSpace's latest snapshot"), "an unknown focus says so instead of failing");
  assert((await focusContext(undefined)) === "", "no focus, no block");
}

function recordingModel(): { model: ModelAdapter; systems: string[] } {
  const stub = createStubModel();
  const systems: string[] = [];
  return {
    systems,
    model: {
      id: "recording",
      complete: async (m: ModelMessage[]) => {
        systems.push(m.find((x) => x.role === "system")?.content ?? "");
        return stub.complete(m);
      },
    },
  };
}

async function testTurnsAndContinuity(): Promise<void> {
  const session = await createSession({ agentId: "hemera", focus: { kind: "project", id: "p-switch" } });
  const rec = recordingModel();
  await runTurn({ sessionId: session.id, agentId: "hemera", userMessage: "what's next?", model: rec.model, worker: createStubWorker() });
  assert(rec.systems[0]!.includes("# What this work serves") && rec.systems[0]!.includes("Release Switch in October"), "a focused session's turn carries the why-chain");

  await setSessionFocus(session.id, null);
  await runTurn({ sessionId: session.id, agentId: "hemera", userMessage: "and now?", model: rec.model, worker: createStubWorker() });
  assert(!rec.systems[1]!.includes("# What this work serves"), "clearing the focus removes it");
  let invalid = "";
  try {
    await setSessionFocus(session.id, { kind: "planet" as "goal", id: "x" });
  } catch (err) {
    invalid = String(err);
  }
  assert(/focus must be/.test(invalid), "an invalid focus is rejected");

  const focus = { kind: "project" as const, id: "p-switch" };
  await addOverlayItem("note", { title: "Cover brief", body: "Dark, grainy." }, "nyx", focus);
  await addOverlayItem("note", { title: "Already linked", body: "see [[Switch release]]" }, "nyx", focus);
  await addOverlayItem("todo", { title: "Book the photographer" }, "nyx", focus);
  await addOverlayItem("todo", { title: "Plan the rollout" }, "hemera", { kind: "goal", id: "g-switch" });
  await addOverlayItem("project-update", { text: "Master booked" }, "hemera", focus);
  const o = await loadOverlay();
  const note = o.notes.find((n: any) => n.title === "Cover brief") as any;
  assert(note?.body.endsWith("Serves: [[Switch release]]"), "a note added in a focused session links the project by name");
  assert(((o.notes.find((n: any) => n.title === "Already linked") as any).body.match(/\[\[Switch release\]\]/g) ?? []).length === 1, "a note that already links it isn't linked twice");
  assert((o.tasks.find((t: any) => t.title === "Book the photographer") as any)?.projectId === "p-switch", "a todo gets the focused project's id");
  assert((o.tasks.find((t: any) => t.title === "Plan the rollout") as any)?.goalId === "g-switch", "a todo in a goal-focused session gets the goal's id");
  assert(o.projects.some((p: any) => p.id === "p-switch" && /Master booked/.test(p.lastMove)), "a project-update defaults to the focused project");

  const sub = await spawnSubagentTask({ agentId: "hemera", goal: "draft the rollout", focus: { kind: "goal", id: "g-switch" }, model: createStubModel(), worker: createStubWorker() });
  assert((await getSession(sub.sessionId))?.focus?.id === "g-switch", "a subagent's session inherits the focus");
  const task = (await listTasks({ agentId: "hemera" })).find((t) => t.id === sub.taskId);
  assert((task?.input as any)?.focus?.id === "g-switch", "and its Task records it");
}

async function testGatewayAndMcp(): Promise<void> {
  await registerAgent({ id: "theia", name: "Theia", persona: "You are Theia." });
  const gateway = await startGateway({ model: createStubModel(), worker: createStubWorker(), enableBaseSpace: true });
  const base = `http://127.0.0.1:${gateway.port}`;
  const send = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    const created = (await (await send("POST", "/sessions", { agentId: "theia", focus: { kind: "goal", id: "g-switch" } })).json()) as { id: string; focus?: { id: string } };
    assert(created.focus?.id === "g-switch", "POST /sessions accepts a focus");
    assert((await send("POST", "/sessions", { agentId: "theia", focus: { kind: "x" } })).status === 400, "a malformed focus is a 400");
    const moved = (await (await send("PUT", `/sessions/${created.id}/focus`, { focus: { kind: "project", id: "p-other" } })).json()) as { focus?: { kind: string } };
    assert(moved.focus?.kind === "project", "PUT /sessions/:id/focus changes it");
    const cleared = (await (await send("PUT", `/sessions/${created.id}/focus`, { focus: null })).json()) as { focus?: unknown };
    assert(cleared.focus === undefined, "and {focus: null} clears it");

    const rpc = async (name: string, args: Record<string, unknown>) =>
      ((await (await send("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).json()) as any).result;
    const asked = await rpc("ask_agent", { agentId: "theia", message: "what should I research?", goalId: "g-switch" });
    const sessionId = String(asked.content[0].text).match(/sessionId: ([^;\]]+)/)?.[1];
    assert((await getSession(sessionId!))?.focus?.id === "g-switch", "MCP ask_agent with goalId starts a focused conversation");
    await rpc("basespace_add", { kind: "todo", title: "Research playlists", goalId: "g-switch" });
    assert(((await loadOverlay()).tasks.find((t: any) => t.title === "Research playlists") as any)?.goalId === "g-switch", "MCP basespace_add with goalId links the todo");
  } finally {
    await gateway.stop();
  }
}

async function main(): Promise<void> {
  await seed();
  await testReading();
  await testFocusContext();
  await testTurnsAndContinuity();
  await testGatewayAndMcp();
  if (process.exitCode === 1) console.error("\nSome goals tests FAILED.");
  else console.log("\nAll goals tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
