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

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { publishEvent } from "./eventbus.js";

const DATA_DIR = process.env.AGENT_OS_DATA_DIR ?? path.join(process.cwd(), "data");
const DIR = path.join(DATA_DIR, "basespace");
const SNAPSHOT = path.join(DIR, "snapshot.json");
const OVERLAY = path.join(DIR, "overlay.json");
const MAX_OUTPUT = 12_000;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

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

/** What the `basespace` tool returns. Sections: summary, notes, projects,
 *  todos, events, crons, teams. `query` filters by text, `id` returns one
 *  item in full (for notes: the whole body). */
export async function readSnapshotSection(section: string, opts: { query?: string; id?: string } = {}): Promise<ToolResult> {
  const snap = await loadSnapshot();
  if (!snap) {
    return { ok: false, output: "", error: "BaseSpace hasn't sent a snapshot yet — it syncs automatically while BaseSpace is open and connected." };
  }
  const header = `BaseSpace snapshot from ${snap.exportedAt ?? snap.receivedAt}.`;
  const list = (key: string): any[] => (Array.isArray(snap[key]) ? snap[key] : []);

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
      },
      overdueOrDueThisWeek: openTodos.filter((t) => t.due && t.due.slice(0, 10) <= soon).map((t) => ({ id: t.id, title: t.title, due: t.due, priority: t.priority })),
      eventsThisWeek: list("events").filter((e) => e.date >= today && e.date <= soon).map((e) => ({ title: e.title, date: e.date, start: e.start })),
      activeProjects: list("projects").filter((p) => p.status === "active").map((p) => ({ id: p.id, name: p.name, progress: p.progress, nextMoves: p.nextMoves })),
      teams: list("teams"),
    };
    return { ok: true, output: cap(`${header}\n${JSON.stringify(out, null, 1)}`) };
  }

  const key = section === "todo" ? "todos" : section;
  if (!["notes", "projects", "todos", "events", "crons", "teams"].includes(key)) {
    return { ok: false, output: "", error: `unknown section "${section}" — use summary, notes, projects, todos, events, crons or teams` };
  }
  let items = list(key);
  if (opts.id) {
    const one = items.find((i) => i.id === opts.id || (typeof i.title === "string" && i.title.toLowerCase() === opts.id!.toLowerCase()));
    return one ? { ok: true, output: cap(`${header}\n${JSON.stringify(one, null, 1)}`) } : { ok: false, output: "", error: `no ${key} item with id "${opts.id}"` };
  }
  if (opts.query) items = items.filter((i) => matches(i, opts.query!));
  // Notes are listed without bodies — ask for one by id to read it.
  const shown = key === "notes" ? items.map(({ body: _body, ...rest }) => rest) : items;
  return { ok: true, output: cap(`${header} ${items.length} ${key}${opts.query ? ` matching "${opts.query}"` : ""}.\n${JSON.stringify(shown, null, 1)}`) };
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

/** What the `basespace-add` tool does. */
export async function addOverlayItem(kind: OverlayKind, args: Record<string, unknown>, agentId: string): Promise<ToolResult> {
  const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string).trim() : "");
  const now = new Date().toISOString();
  const id = `agent-${agentId}-${Date.now().toString(36)}`;
  const o = await loadOverlay();

  if (kind === "note") {
    const title = str("title");
    if (!title) return { ok: false, output: "", error: "a note needs a title" };
    const folder = str("folder") || `Agents/${cap1(agentId)}`;
    o.notes.push({ id, title, folder, tags: [agentId], updated: now, created: now, body: str("body") });
    await saveOverlay(o);
    return { ok: true, output: `Added note "${title}" to BaseSpace (${folder}), id ${id}.` };
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
    });
    await saveOverlay(o);
    return { ok: true, output: `Added todo "${title}"${due ? ` due ${due}` : ""} to BaseSpace, id ${id}.` };
  }
  if (kind === "project-update") {
    const projectId = str("projectId");
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
