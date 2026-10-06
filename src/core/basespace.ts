// BaseSpace bridge — how agents see and add to the operator's own
// dashboard (BaseSpace, the BaseOStest repo). Two small JSON documents
// under the data dir, no database:
//
//   basespace/snapshot.json  written by BaseSpace (POST /basespace/snapshot)
//                            a few seconds after anything changes there —
//                            notes, projects, todos, events, cron jobs,
//                            teams. Agents READ it with the `basespace`
//                            tool.
//   basespace/overlay.json   written by agents with the `basespace-add`
//                            tool; BaseSpace reads it (GET
//                            /basespace/overlay) and merges it into its
//                            pages. Internal to the operator's own OS, so
//                            not approval-gated — anything outward-facing
//                            still goes through approvals.ts.
//
// The snapshot is the operator's data, so the tool only ever reads it;
// agents can't rewrite a note or project in place, only add alongside.

import type { SessionFocus } from "./types.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { publishEvent } from "./eventbus.js";

const DATA_DIR = process.env.AGENT_OS_DATA_DIR ?? path.join(process.cwd(), "data");
const DIR = path.join(DATA_DIR, "basespace");
const SNAPSHOT = path.join(DIR, "snapshot.json");
const OVERLAY = path.join(DIR, "overlay.json");
const MAX_OUTPUT = 12_000;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_LIST_ITEMS = 30;

export type OverlayKind = "note" | "todo" | "project-update";

interface Overlay {
  updatedAt?: string;
  notes: Record<string, unknown>[];
  tasks: Record<string, unknown>[];
  projects: Record<string, unknown>[];
  [key: string]: unknown;
}

interface ToolResult {
  ok: boolean;
  output: string;
  error?: string;
}

async function writeAtomic(file: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, data, "utf8");
  await fs.rename(tmp, file);
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

// ---- snapshot (BaseSpace → agents) ------------------------------------------

export async function saveSnapshot(body: unknown): Promise<{ savedAt: string; bytes: number }> {
  if (typeof body !== "object" || body === null || !("schema" in body)) throw new Error("not a BaseSpace snapshot (missing schema)");
  const text = JSON.stringify({ ...(body as object), receivedAt: new Date().toISOString() });
  if (text.length > MAX_SNAPSHOT_BYTES) throw new Error(`snapshot too large (${text.length} bytes)`);
  await writeAtomic(SNAPSHOT, text);
  await publishEvent("basespace.snapshot.updated", { bytes: text.length });
  return { savedAt: new Date().toISOString(), bytes: text.length };
}

export async function loadSnapshot(): Promise<Record<string, any> | undefined> {
  return readJson<Record<string, any>>(SNAPSHOT);
}

function cap(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… (truncated — narrow it with query or id)` : text;
}

function matches(obj: unknown, q: string): boolean {
  return JSON.stringify(obj).toLowerCase().includes(q.toLowerCase());
}

/** What the `basespace` tool returns. Sections: summary, goals, notes,
 *  projects, todos, events, crons, teams. `query` filters by text, `id` returns one
 *  item in full (for notes: the whole body). */
export async function readSnapshotSection(section: string, opts: { query?: string; id?: string } = {}): Promise<ToolResult> {
  const snap = await loadSnapshot();
  if (!snap) {
    return { ok: false, output: "", error: "BaseSpace hasn't sent a snapshot yet — it syncs automatically while BaseSpace is open and connected." };
  }
  const header = `BaseSpace snapshot from ${snap.exportedAt ?? snap.receivedAt}.`;
  // What agents added (the overlay) shows up in the snapshot only after
  // BaseSpace syncs again — until then, read it straight from the overlay,
  // or an agent can't see what a teammate just added (a verifier would
  // call finished work missing).
  const overlay = await loadOverlay();
  const pending = (key: string, have: any[]): any[] => {
    const src = key === "notes" ? overlay.notes : key === "todos" ? overlay.tasks : [];
    const ids = new Set(have.map((i) => i.id));
    return src.filter((i) => !ids.has(i.id));
  };
  const list = (key: string): any[] => {
    const have = Array.isArray(snap[key]) ? snap[key] : [];
    return [...have, ...pending(key, have)];
  };

  if (section === "summary") {
    const today = new Date().toISOString().slice(0, 10);
    const soon = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const openTodos = list("todos").filter((t) => t.status !== "done");
    const out = {
      counts: {
        notes: list("notes").length,
        projects: list("projects").length,
        openTodos: openTodos.length,
        events: list("events").length,
        crons: list("crons").length,
        teams: list("teams").length,
        songs: list("songs").length,
      },
      overdueOrDueThisWeek: openTodos.filter((t) => t.due && t.due.slice(0, 10) <= soon).map((t) => ({ id: t.id, title: t.title, due: t.due, priority: t.priority })),
      eventsThisWeek: list("events").filter((e) => e.date >= today && e.date <= soon).map((e) => ({ title: e.title, date: e.date, start: e.start })),
      activeProjects: list("projects").filter((p) => p.status === "active").map((p) => ({ id: p.id, name: p.name, progress: p.progress, nextMoves: p.nextMoves })),
      teams: list("teams"),
      activeGoals: list("goals")
        .filter((g) => g.status === "active")
        .map((g) => ({ id: g.id, title: g.title, why: g.why, target: g.target, progress: g.progress, projects: (g.projectIds ?? []).map((id: string) => nameOf(snap, "project", id)) })),
    };
    return { ok: true, output: cap(`${header}\n${JSON.stringify(out)}`) };
  }

  const key = section === "todo" ? "todos" : section === "goal" ? "goals" : section;
  if (!["notes", "projects", "todos", "events", "crons", "teams", "goals", "songs"].includes(key)) {
    return { ok: false, output: "", error: `unknown section "${section}" — use summary, goals, notes, projects, todos, events, crons, teams or songs` };
  }
  let items = list(key);
  if (opts.id) {
    const one = items.find((i) => i.id === opts.id || (typeof i.title === "string" && i.title.toLowerCase() === opts.id!.toLowerCase()));
    if (!one) return { ok: false, output: "", error: `no ${key} item with id "${opts.id}"` };
    // A goal or project read in full comes with what it's connected to.
    const context = key === "projects" || key === "goals" ? `\n\n${renderFocus(snap, { kind: key === "goals" ? "goal" : "project", id: one.id })}` : "";
    return { ok: true, output: cap(`${header}\n${JSON.stringify(one)}${context}`) };
  }
  if (opts.query) items = items.filter((i) => matches(i, opts.query!));
  // Notes are listed without bodies (and without other bulky/duplicate
  // frontmatter like `props`, which usually just repeats `tags`) — ask for
  // one by id to read it in full. Small local models have tight context
  // windows (often 4096 tokens), so a big flat listing can overflow and get
  // silently cut mid-item; capping item count here (not just bytes) keeps
  // every shown item complete. Compact JSON: every character is context.
  const shown = key === "notes" ? items.map(({ id, title, folder, tags }) => ({ id, title, folder, tags })) : items;
  const limited = shown.length > MAX_LIST_ITEMS ? shown.slice(0, MAX_LIST_ITEMS) : shown;
  const more = shown.length > MAX_LIST_ITEMS ? `\n… ${shown.length - MAX_LIST_ITEMS} more — narrow with query (folder/tag/title text) to see them.` : "";
  return { ok: true, output: cap(`${header} ${items.length} ${key}${opts.query ? ` matching "${opts.query}"` : ""}.\n${JSON.stringify(limited)}${more}`) };
}

// ---- focus: what a conversation's work serves ---------------------------------
//
// BaseSpace links goals → projects → todos and notes (features/goals in
// BaseOStest); the snapshot carries those links. A session focused on a
// goal or project gets this rendered into every turn (agent-loop.ts), so
// the agent always knows why it's doing the work and what's already there —
// continuity instead of starting from zero each conversation.

const MAX_LISTED = 12;

function nameOf(snap: Record<string, any>, kind: "project" | "goal" | "note", id: string): string {
  const key = kind === "project" ? "projects" : kind === "goal" ? "goals" : "notes";
  const item = (Array.isArray(snap[key]) ? snap[key] : []).find((i: any) => i.id === id);
  return item ? String(item.name ?? item.title) : id;
}

function goalChainOf(snap: Record<string, any>, goalId: string | undefined): any[] {
  const goals: any[] = Array.isArray(snap.goals) ? snap.goals : [];
  const out: any[] = [];
  const seen = new Set<string>();
  let cur = goals.find((g) => g.id === goalId);
  while (cur && !seen.has(cur.id)) {
    out.push(cur);
    seen.add(cur.id);
    cur = cur.parentId ? goals.find((g) => g.id === cur.parentId) : undefined;
  }
  return out;
}

const goalLine = (g: any) =>
  `"${g.title}"${g.status && g.status !== "active" ? ` (${g.status})` : ""}${g.target ? `, target ${g.target}` : ""}${typeof g.progress === "number" ? `, ${g.progress}% across its projects` : ""}${g.why ? ` — why: ${g.why}` : ""}`;

function renderFocus(snap: Record<string, any>, focus: SessionFocus): string {
  const list = (k: string): any[] => (Array.isArray(snap[k]) ? snap[k] : []);
  const lines: string[] = ["# What this work serves"];
  let projectIds: string[] = [];
  let goalIds: string[] = [];
  let noteIds: string[] = [];

  if (focus.kind === "project") {
    const p = list("projects").find((x) => x.id === focus.id);
    if (!p) return `# What this work serves\nThis conversation is about project "${focus.id}", which isn't in BaseSpace's latest snapshot.`;
    const tagline = p.tagline ? ` — ${String(p.tagline).replace(/[.!?]+$/, "")}` : "";
    lines.push(`This conversation is about the project "${p.name}" (${p.status}, ${p.progress}%)${tagline}.`);
    if (p.nextMoves?.length) lines.push(`Next moves:\n${p.nextMoves.slice(0, 5).map((m: string) => `- ${m}`).join("\n")}`);
    if (p.recent?.length) lines.push(`Recently:\n${p.recent.slice(0, 3).map((r: any) => `- ${String(r.date).slice(0, 10)}: ${r.text}`).join("\n")}`);
    const serves = (p.goalIds ?? []) as string[];
    for (const gid of serves) {
      const [first, ...above] = goalChainOf(snap, gid);
      if (!first) continue;
      lines.push(`It serves the goal ${goalLine(first)}${above.map((g) => `\n  which serves ${goalLine(g)}`).join("")}`);
    }
    if (!serves.length) lines.push("It isn't linked to a goal yet.");
    projectIds = [p.id];
    goalIds = serves;
    noteIds = p.noteIds ?? [];
  } else {
    const chain = goalChainOf(snap, focus.id);
    const g = chain[0];
    if (!g) return `# What this work serves\nThis conversation is about goal "${focus.id}", which isn't in BaseSpace's latest snapshot.`;
    lines.push(`This conversation is about the goal ${goalLine(g)}.${chain.slice(1).map((x) => `\n  which serves ${goalLine(x)}`).join("")}`);
    const projects = list("projects").filter((p) => (g.projectIds ?? []).includes(p.id));
    if (projects.length) {
      lines.push(
        `Its projects:\n${projects.map((p) => `- "${p.name}" (${p.status}, ${p.progress}%, id ${p.id})${p.nextMoves?.length ? ` — next: ${p.nextMoves.slice(0, 3).join("; ")}` : ""}`).join("\n")}`,
      );
    } else lines.push("No projects are linked to it yet.");
    const subGoals = list("goals").filter((x) => x.parentId === g.id);
    if (subGoals.length) lines.push(`Sub-goals:\n${subGoals.map((x) => `- ${goalLine(x)}`).join("\n")}`);
    projectIds = projects.map((p) => p.id);
    goalIds = [g.id];
    noteIds = g.noteIds ?? [];
  }

  const notes = noteIds.slice(0, MAX_LISTED).map((id) => `- "${nameOf(snap, "note", id)}" (id ${id})`);
  if (notes.length) lines.push(`Linked notes (read one with the basespace tool, section notes + id):\n${notes.join("\n")}${noteIds.length > MAX_LISTED ? `\n- …and ${noteIds.length - MAX_LISTED} more` : ""}`);
  const todos = list("todos").filter((t) => t.status !== "done" && ((t.projectId && projectIds.includes(t.projectId)) || (t.goalId && goalIds.includes(t.goalId))));
  if (todos.length) {
    lines.push(
      `Open todos:\n${todos.slice(0, MAX_LISTED).map((t) => `- "${t.title}" (${t.priority}${t.due ? `, due ${t.due}` : ""}${t.status === "doing" ? ", in progress" : ""})`).join("\n")}`,
    );
  }
  lines.push("Notes and todos you add to BaseSpace in this conversation are linked to it automatically. Say so if a request doesn't serve it.");
  return lines.join("\n");
}

/** The "what this work serves" block for a focused session, or "" when
 *  there's no snapshot yet. */
export async function focusContext(focus: SessionFocus | undefined): Promise<string> {
  if (!focus) return "";
  const snap = await loadSnapshot();
  return snap ? renderFocus(snap, focus) : "";
}

/** How an item added in a focused session links back to the focus. */
async function focusLinks(focus: SessionFocus | undefined): Promise<{ wikiName?: string; projectId?: string; goalId?: string }> {
  if (!focus) return {};
  const snap = (await loadSnapshot()) ?? {};
  // Only link by a name BaseSpace knows: an id in [[…]] would be a dead link.
  const found = nameOf(snap, focus.kind, focus.id);
  const wikiName = found === focus.id ? undefined : found;
  return focus.kind === "project" ? { wikiName, projectId: focus.id } : { wikiName, goalId: focus.id };
}

// ---- overlay (agents → BaseSpace) -------------------------------------------

export async function loadOverlay(): Promise<Overlay> {
  const o = await readJson<Partial<Overlay>>(OVERLAY);
  return { notes: [], tasks: [], projects: [], ...(o ?? {}) } as Overlay;
}

async function saveOverlay(o: Overlay): Promise<void> {
  o.updatedAt = new Date().toISOString();
  await writeAtomic(OVERLAY, JSON.stringify(o, null, 1));
  await publishEvent("basespace.overlay.updated", { updatedAt: o.updatedAt });
}

function hours(time: unknown): number | undefined {
  const m = typeof time === "string" ? /^(\d{1,2}):(\d{2})$/.exec(time.trim()) : null;
  return m ? Number(m[1]) + Number(m[2]) / 60 : undefined;
}

const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const clip = (s: string, n = 70) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}...` : one;
};

/** Changes a note the agent wrote, in place: `edit` is a list of {find, replace} (each `find` must match exactly once) and/or
 *  `append` adds text at the end. All or nothing: one edit that doesn't match changes nothing and says which. The result echoes
 *  what changed, so the agent doesn't have to read the note back to check, and doesn't rewrite a whole note to change a line. */
async function editOwnNote(o: Overlay, args: Record<string, unknown>, agentId: string): Promise<ToolResult> {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  const title = typeof args.title === "string" ? args.title.trim() : "";
  const mine = o.notes.filter((n) => Array.isArray(n.tags) && (n.tags as string[]).includes(agentId));
  const note = id
    ? mine.find((n) => n.id === id)
    : mine.filter((n) => n.title === title).sort((a, b) => String(b.updated ?? "").localeCompare(String(a.updated ?? "")))[0];
  if (!note) return { ok: false, output: "", error: `no note of yours with ${id ? `id ${id}` : `the title "${title}"`} (you can only edit notes you wrote; give its id or exact title)` };
  const edits = Array.isArray(args.edit) ? (args.edit as unknown[]) : [];
  const append = typeof args.append === "string" ? args.append.trim() : "";
  if (!edits.length && !append) return { ok: false, output: "", error: "edit needs a list of {find, replace}, or append text" };
  const before = String(note.body ?? "");
  let body = before;
  const done: string[] = [];
  for (let i = 0; i < edits.length; i++) {
    const e = (edits[i] ?? {}) as { find?: unknown; replace?: unknown };
    const find = typeof e.find === "string" ? e.find : "";
    const replace = typeof e.replace === "string" ? e.replace : "";
    if (!find) return { ok: false, output: "", error: `edit ${i + 1}: find is empty (nothing was changed)` };
    const count = body.split(find).length - 1;
    if (count === 0) return { ok: false, output: "", error: `edit ${i + 1}: that text is not in the note (nothing was changed). Read the note with basespace (id ${note.id}) and copy the text exactly.` };
    if (count > 1) return { ok: false, output: "", error: `edit ${i + 1}: that text appears ${count} times (nothing was changed). Add surrounding words so it matches once.` };
    body = body.replace(find, () => replace);
    done.push(`"${clip(find)}" -> ${replace ? `"${clip(replace)}"` : "(removed)"}`);
  }
  if (append) {
    body = `${body}${body ? "\n\n" : ""}${append}`;
    done.push(`appended "${clip(append)}"`);
  }
  if (body === before) return { ok: true, output: `No change: the note "${note.title}" already reads that way.` };
  note.body = body;
  note.updated = new Date().toISOString();
  await saveOverlay(o);
  return { ok: true, output: `Saved note "${note.title}" (${note.folder}), id ${note.id}. ${done.length} change${done.length === 1 ? "" : "s"}:\n- ${done.join("\n- ")}\nIt is saved and checked: no need to read it back.` };
}

/** What the `basespace-add` tool does. */
export async function addOverlayItem(kind: OverlayKind, args: Record<string, unknown>, agentId: string, focus?: SessionFocus): Promise<ToolResult> {
  const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string).trim() : "");
  // Items added while working on a goal/project link back to it — notes with
  // a [[wikilink]] (so they show under it in BaseSpace), todos by id.
  const links = await focusLinks(focus);
  const now = new Date().toISOString();
  const id = `agent-${agentId}-${Date.now().toString(36)}`;
  const o = await loadOverlay();

  if (kind === "note") {
    const title = str("title");
    if (!title && !str("id") && (Array.isArray(args.edit) || str("append"))) return { ok: false, output: "", error: "to edit a note give its id or its exact title" };
    if (!title && !(Array.isArray(args.edit) || str("append"))) return { ok: false, output: "", error: "a note needs a title" };
    // Changing a note you wrote: edit/append, not a rewrite.
    if (Array.isArray(args.edit) || str("append")) return editOwnNote(o, args, agentId);
    const folder = str("folder") || `Agents/${cap1(agentId)}`;
    let body = str("body");
    // The same agent adding a note with the same title again (a retry, a
    // re-run after being sent back) updates it instead of piling up copies.
    const recent = o.notes.find(
      (n) => n.title === title && Array.isArray(n.tags) && (n.tags as string[]).includes(agentId) && Date.now() - Date.parse(String(n.created ?? "")) < 24 * 3_600_000,
    );
    if (links.wikiName && !body.toLowerCase().includes(`[[${links.wikiName.toLowerCase()}`)) {
      body = `${body}${body ? "\n\n" : ""}Serves: [[${links.wikiName}]]`;
    }
    if (recent) {
      Object.assign(recent, { body, folder, updated: now });
      await saveOverlay(o);
      return { ok: true, output: `Updated your note "${title}" (${folder}), id ${recent.id} — same title as one you added earlier, so it was replaced, not duplicated.` };
    }
    o.notes.push({ id, title, folder, tags: [agentId], updated: now, created: now, body });
    await saveOverlay(o);
    return { ok: true, output: `Added note "${title}" to BaseSpace (${folder}), id ${id}${links.wikiName ? `, linked to "${links.wikiName}"` : ""}.` };
  }
  if (kind === "todo") {
    const title = str("title");
    if (!title) return { ok: false, output: "", error: "a todo needs a title" };
    const due = str("due");
    if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return { ok: false, output: "", error: "due must be YYYY-MM-DD" };
    const priority = ["high", "med", "low"].includes(str("priority")) ? str("priority") : "med";
    o.tasks.push({
      id,
      title,
      status: "todo",
      priority,
      ...(due ? { due } : {}),
      ...(hours(args.time) != null ? { dueTime: hours(args.time), notify: true } : {}),
      notes: `${str("notes")}${str("notes") ? " " : ""}(added by ${cap1(agentId)})`,
      ...((str("projectId") || links.projectId) ? { projectId: str("projectId") || links.projectId } : {}),
      ...((str("goalId") || links.goalId) ? { goalId: str("goalId") || links.goalId } : {}),
    });
    await saveOverlay(o);
    return { ok: true, output: `Added todo "${title}"${due ? ` due ${due}` : ""} to BaseSpace, id ${id}${links.wikiName ? `, linked to "${links.wikiName}"` : ""}.` };
  }
  if (kind === "project-update") {
    const projectId = str("projectId") || links.projectId || "";
    const text = str("text");
    if (!projectId || !text) return { ok: false, output: "", error: "project-update needs projectId and text" };
    const snap = await loadSnapshot();
    if (snap && Array.isArray(snap.projects) && !snap.projects.some((p: any) => p.id === projectId)) {
      return { ok: false, output: "", error: `no project with id "${projectId}" — list them with the basespace tool (section: projects)` };
    }
    o.projects = o.projects.filter((p) => p.id !== projectId);
    o.projects.push({ id: projectId, lastMove: `${text} — ${cap1(agentId)}` });
    await saveOverlay(o);
    return { ok: true, output: `Posted an update on project ${projectId}.` };
  }
  return { ok: false, output: "", error: `unknown kind "${kind}" — use note, todo or project-update` };
}

/** Removes one agent-added item (DELETE /basespace/overlay/:kind/:id). */
export async function removeOverlayItem(kind: string, id: string): Promise<boolean> {
  const key = kind === "note" || kind === "notes" ? "notes" : kind === "todo" || kind === "tasks" ? "tasks" : kind === "project" || kind === "projects" ? "projects" : undefined;
  if (!key) return false;
  const o = await loadOverlay();
  const before = o[key].length;
  o[key] = o[key].filter((i) => i.id !== id);
  if (o[key].length === before) return false;
  await saveOverlay(o);
  return true;
}
