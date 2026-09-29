// Work — handing tasks between agents, adapted from Paperclip
// (github.com/paperclipai/paperclip, doc/SPEC.md §3 and §5): agents
// delegate by creating a work item assigned to a teammate, not by chatting
// at each other, so every handoff is a record with an owner, a status and a
// reason. Event-sourced on the `work` stream like everything else.
//
// The rules, as Paperclip has them:
//   - One assignee per item, claimed atomically (open → in_progress); a
//     second claim fails and names who has it.
//   - An assignee can't cancel work handed to it. It finishes it (done),
//     says why it can't (blocked), or hands it back to its manager with a
//     reason ("hand-back" — reportsTo, see identity.ts). Only the requester
//     or the operator cancels.
//   - Delegation depth is tracked and capped (MAX_DEPTH), so work can't
//     cascade forever through the team.
//   - Tokens spent working an item are recorded on it and roll up to the
//     item that asked for it ("billing codes") — so the operator can see
//     what a request really cost across everyone it touched.
//   - Items inherit the requesting session's focus (a goal or project), so
//     delegated work keeps its "why".
//   - Managing an item someone else is doing (reassign, reopen, escalate
//     to the operator) is for whoever asked for it, the assignee's manager,
//     or the operator — the lead's review (review.ts) runs on this.
//
// Running the work is the gateway's job (gateway/work-runner.ts); this file
// is the ledger and its rules.

import { appendEvent, project } from "./eventlog.js";
import { publishEvent } from "./eventbus.js";
import { generateId } from "./id.js";
import { getAgentIdentity, listAgentIdentities } from "./identity.js";
import type { SessionFocus } from "./types.js";

const WORK_STREAM = "work";
export const OPERATOR = "operator";
/** Hops from the original request: operator → Hemera (0) → Nyx (1) → … */
export const MAX_DEPTH = 3;

export type WorkStatus = "open" | "in_progress" | "blocked" | "done" | "cancelled";

export interface WorkNote {
  at: string;
  by: string;
  text: string;
}

export interface WorkItem {
  id: string;
  title: string;
  detail?: string;
  /** Agent id doing it. */
  assignee: string;
  /** Agent id that asked, or "operator". */
  requestedBy: string;
  /** The requester's session it came from — results are reported there. */
  requestedFromSessionId?: string;
  parentId?: string;
  depth: number;
  focus?: SessionFocus;
  status: WorkStatus;
  /** The assignee's session while working it. */
  sessionId?: string;
  result?: string;
  blockedReason?: string;
  /** Raised to the operator by a lead (or the requester); cleared when the
   *  item moves again (reopened, reassigned, finished, cancelled). */
  escalation?: { by: string; reason: string; at: string };
  /** "verification": the watchdog's check of other items (watchdog.ts). */
  kind?: "verification";
  /** For a verification: the items it checks. Its assignee (the verifier)
   *  may reopen or escalate those — and nothing else. */
  verifies?: string[];
  watchId?: string;
  notes: WorkNote[];
  /** Tokens spent on this item itself. */
  tokens: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkView extends WorkItem {
  childIds: string[];
  /** This item's tokens plus every item it delegated, recursively. */
  totalTokens: number;
}

export class WorkError extends Error {}

async function projectWork(): Promise<Map<string, WorkItem>> {
  return project<Map<string, WorkItem>>(WORK_STREAM, new Map(), (state, event) => {
    const p = event.payload as any;
    const item = p.id ? state.get(p.id) : undefined;
    const touch = (patch: Partial<WorkItem>) => item && state.set(item.id, { ...item, ...patch, updatedAt: event.timestamp });
    const note = (text: string) => (item ? [...item.notes, { at: event.timestamp, by: p.by, text }] : []);
    switch (event.type) {
      case "work.created":
        state.set(p.item.id, { ...p.item, notes: [], tokens: 0, createdAt: event.timestamp, updatedAt: event.timestamp });
        break;
      case "work.claimed":
        touch({ status: "in_progress", sessionId: p.sessionId });
        break;
      case "work.noted":
        touch({ notes: note(p.text) });
        break;
      case "work.completed":
        touch({ status: "done", result: p.result, escalation: undefined, notes: note(`done: ${p.result}`) });
        break;
      case "work.blocked":
        touch({ status: "blocked", blockedReason: p.reason, notes: note(`blocked: ${p.reason}`) });
        break;
      case "work.reassigned":
        touch({ status: "open", assignee: p.to, sessionId: undefined, blockedReason: undefined, escalation: undefined, notes: note(`handed to ${p.to}: ${p.reason}`) });
        break;
      case "work.reopened":
        // The old result stays in the notes ("done: …"), not as the result.
        touch({ status: "open", sessionId: undefined, blockedReason: undefined, escalation: undefined, result: undefined, notes: note(`reopened: ${p.reason}`) });
        break;
      case "work.cancelled":
        touch({ status: "cancelled", escalation: undefined, notes: note(`cancelled: ${p.reason}`) });
        break;
      case "work.escalated":
        touch({ escalation: { by: p.by, reason: p.reason, at: event.timestamp }, notes: note(`escalated to the operator: ${p.reason}`) });
        break;
      case "work.usage":
        touch({ tokens: (item?.tokens ?? 0) + (p.tokens ?? 0) });
        break;
    }
    return state;
  });
}

function toViews(items: Map<string, WorkItem>): WorkView[] {
  const children = new Map<string, string[]>();
  for (const i of items.values()) if (i.parentId) children.set(i.parentId, [...(children.get(i.parentId) ?? []), i.id]);
  const total = (id: string, seen = new Set<string>()): number => {
    if (seen.has(id)) return 0;
    seen.add(id);
    return (items.get(id)?.tokens ?? 0) + (children.get(id) ?? []).reduce((s, c) => s + total(c, seen), 0);
  };
  return [...items.values()].map((i) => ({ ...i, childIds: children.get(i.id) ?? [], totalTokens: total(i.id) }));
}

export async function getWork(id: string): Promise<WorkView | undefined> {
  return toViews(await projectWork()).find((w) => w.id === id);
}

export async function listWork(filter: { assignee?: string; requestedBy?: string; status?: WorkStatus; involving?: string; team?: string } = {}): Promise<WorkView[]> {
  let list = toViews(await projectWork());
  if (filter.assignee) list = list.filter((w) => w.assignee === filter.assignee);
  if (filter.requestedBy) list = list.filter((w) => w.requestedBy === filter.requestedBy);
  if (filter.involving) list = list.filter((w) => w.assignee === filter.involving || w.requestedBy === filter.involving);
  if (filter.team) {
    // What a lead oversees: its own work plus its reports', whoever asked.
    const lead = filter.team;
    const reports = new Set((await listAgentIdentities()).filter((a) => a.reportsTo === lead).map((a) => a.id));
    list = list.filter((w) => w.assignee === lead || w.requestedBy === lead || reports.has(w.assignee));
  }
  if (filter.status) list = list.filter((w) => w.status === filter.status);
  return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The item an agent's session is working, if it's a work session. With
 *  `anyStatus`, also one it already finished this turn — for recording the
 *  turn's tokens after the agent marked it done mid-turn. */
export async function workForSession(sessionId: string, opts: { anyStatus?: boolean } = {}): Promise<WorkView | undefined> {
  // Blocked counts as "being worked": an item blocked on a pending approval
  // is finished from the same session once the approval resumes it.
  return (await listWork()).find((w) => w.sessionId === sessionId && (opts.anyStatus || w.status === "in_progress" || w.status === "blocked"));
}

// All state changes go through one in-process queue, so a check-then-append
// (e.g. claiming) can't interleave with another — the gateway is a single
// process, which is what makes "atomic checkout" hold.
let chain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

export async function createWork(input: {
  title: string;
  detail?: string;
  assignee: string;
  requestedBy: string;
  requestedFromSessionId?: string;
  parentId?: string;
  focus?: SessionFocus;
  kind?: "verification";
  verifies?: string[];
  watchId?: string;
}): Promise<WorkView> {
  return serialized(async () => {
    const title = input.title.trim();
    if (!title) throw new WorkError("work needs a title");
    if (!(await getAgentIdentity(input.assignee))) throw new WorkError(`no agent "${input.assignee}"`);
    if (input.assignee === input.requestedBy) throw new WorkError("you can't hand work to yourself — just do it");
    const items = await projectWork();
    const parent = input.parentId ? items.get(input.parentId) : undefined;
    const depth = parent ? parent.depth + 1 : 0;
    if (depth > MAX_DEPTH) {
      throw new WorkError(`this is already ${depth} hand-offs deep (max ${MAX_DEPTH}) — do it yourself, or hand it back to your manager`);
    }
    // Handing something back to whoever handed it to you is a hand-back,
    // not a new delegation — that path keeps the history in one item.
    if (parent && parent.requestedBy === input.assignee && parent.assignee === input.requestedBy) {
      throw new WorkError(`${input.assignee} asked you for this — use the work tool's hand-back or blocked instead of delegating it back`);
    }
    const item = {
      id: generateId(),
      title,
      ...(input.detail?.trim() ? { detail: input.detail.trim() } : {}),
      assignee: input.assignee,
      requestedBy: input.requestedBy,
      ...(input.requestedFromSessionId ? { requestedFromSessionId: input.requestedFromSessionId } : {}),
      ...(parent ? { parentId: parent.id } : {}),
      depth,
      ...(input.focus ?? parent?.focus ? { focus: input.focus ?? parent!.focus } : {}),
      status: "open" as const,
      ...(input.kind ? { kind: input.kind, verifies: input.verifies ?? [], ...(input.watchId ? { watchId: input.watchId } : {}) } : {}),
    };
    await appendEvent(WORK_STREAM, "work.created", { item });
    await publishEvent("work.created", { id: item.id, assignee: item.assignee, requestedBy: item.requestedBy });
    return (await getWork(item.id))!;
  });
}

async function mustGet(id: string): Promise<WorkItem> {
  const item = (await projectWork()).get(id);
  if (!item) throw new WorkError(`no work item ${id}`);
  return item;
}

/** open → in_progress for its assignee. Fails if someone already has it. */
export async function claimWork(id: string, by: string, sessionId: string): Promise<WorkView> {
  return serialized(async () => {
    const item = await mustGet(id);
    if (item.assignee !== by) throw new WorkError(`${id} is assigned to ${item.assignee}, not ${by}`);
    if (item.status !== "open") throw new WorkError(`${id} is ${item.status}${item.status === "in_progress" ? ` (${item.assignee} has it)` : ""}`);
    await appendEvent(WORK_STREAM, "work.claimed", { id, by, sessionId });
    return (await getWork(id))!;
  });
}

const ACTIVE: WorkStatus[] = ["open", "in_progress", "blocked"];

/** May `by` manage an item someone else is doing? The operator, whoever
 *  asked for it, or the assignee's manager. */
export async function mayManageWork(item: Pick<WorkItem, "id" | "assignee" | "requestedBy">, by: string, action?: string): Promise<boolean> {
  if (by === OPERATOR || by === item.requestedBy) return true;
  if ((await getAgentIdentity(item.assignee))?.reportsTo === by) return true;
  // The watchdog's verifier may send back (reopen) or flag (escalate) the
  // items it's verifying right now — report problems, not fix them.
  if (action === "reopen" || action === "escalate") {
    return [...(await projectWork()).values()].some(
      (v) => v.kind === "verification" && v.assignee === by && v.status === "in_progress" && (v.verifies ?? []).includes(item.id),
    );
  }
  return false;
}

async function mustManage(item: WorkItem, by: string, what: string): Promise<void> {
  if (!(await mayManageWork(item, by, what))) {
    const who = item.requestedBy === OPERATOR ? `${item.assignee}'s manager or the operator` : `${item.requestedBy}, ${item.assignee}'s manager or the operator`;
    throw new WorkError(`only ${who} can ${what} ${item.id}${item.kind === "verification" ? " (that's a verification — pass the id of the item it checks)" : ""}`);
  }
}

export async function completeWork(id: string, by: string, result: string): Promise<WorkView> {
  return serialized(async () => {
    const item = await mustGet(id);
    if (item.assignee !== by) throw new WorkError(`only ${item.assignee} can complete ${id}`);
    if (!ACTIVE.includes(item.status)) throw new WorkError(`${id} is already ${item.status}`);
    await appendEvent(WORK_STREAM, "work.completed", { id, by, result: result.trim() || "(no summary)" });
    await publishEvent("work.completed", { id, by });
    return (await getWork(id))!;
  });
}

export async function blockWork(id: string, by: string, reason: string): Promise<WorkView> {
  return serialized(async () => {
    const item = await mustGet(id);
    if (item.assignee !== by && by !== OPERATOR) throw new WorkError(`only ${item.assignee} can mark ${id} blocked`);
    if (!ACTIVE.includes(item.status)) throw new WorkError(`${id} is already ${item.status}`);
    if (!reason.trim()) throw new WorkError("say why it's blocked");
    await appendEvent(WORK_STREAM, "work.blocked", { id, by, reason: reason.trim() });
    await publishEvent("work.blocked", { id, by });
    return (await getWork(id))!;
  });
}

/** The assignee hands it to its manager (reportsTo) with a reason — how an
 *  agent says "I don't think this is worth doing / I'm the wrong one"
 *  without cancelling. No manager: it's blocked for the operator. */
export async function handBackWork(id: string, by: string, reason: string): Promise<WorkView> {
  const item = await mustGet(id);
  if (item.assignee !== by) throw new WorkError(`only ${item.assignee} can hand ${id} back`);
  if (!reason.trim()) throw new WorkError("say why you're handing it back");
  const manager = (await getAgentIdentity(by))?.reportsTo;
  if (!manager) return blockWork(id, by, `handed back to the operator: ${reason.trim()}`);
  return reassignWork(id, by, manager, reason);
}

export async function reassignWork(id: string, by: string, to: string, reason: string): Promise<WorkView> {
  return serialized(async () => {
    const item = await mustGet(id);
    // The assignee passing it on is a hand-back (handBackWork checks that).
    if (by !== item.assignee) await mustManage(item, by, "reassign");
    if (!ACTIVE.includes(item.status)) throw new WorkError(`${id} is already ${item.status}`);
    if (!(await getAgentIdentity(to))) throw new WorkError(`no agent "${to}"`);
    if (to === item.assignee) throw new WorkError(`${id} is already ${to}'s`);
    await appendEvent(WORK_STREAM, "work.reassigned", { id, by, to, reason: reason.trim() || "reassigned" });
    await publishEvent("work.reassigned", { id, by, to });
    return (await getWork(id))!;
  });
}

/** Back to open for the same assignee — e.g. the operator unblocked it, a
 *  run failed before the agent could finish, or a verifier found a done
 *  item's claim didn't hold up. */
export async function reopenWork(id: string, by: string, reason: string): Promise<WorkView> {
  return serialized(async () => {
    const item = await mustGet(id);
    await mustManage(item, by, "reopen");
    // A done item can be sent back (its claim didn't hold up — watchdog.ts);
    // a cancelled one is gone.
    if (item.status === "cancelled") throw new WorkError(`${id} is cancelled`);
    if (item.status === "open") throw new WorkError(`${id} is already open`);
    await appendEvent(WORK_STREAM, "work.reopened", { id, by, reason: reason.trim() || "reopened" });
    await publishEvent("work.reopened", { id, by });
    return (await getWork(id))!;
  });
}

/** Flags an item for the operator's attention — a lead's way of saying
 *  "this needs you" without deciding it. Nothing else changes. */
export async function escalateWork(id: string, by: string, reason: string): Promise<WorkView> {
  return serialized(async () => {
    const item = await mustGet(id);
    await mustManage(item, by, "escalate");
    if (!ACTIVE.includes(item.status)) throw new WorkError(`${id} is already ${item.status}`);
    if (!reason.trim()) throw new WorkError("say what the operator needs to decide");
    await appendEvent(WORK_STREAM, "work.escalated", { id, by, reason: reason.trim() });
    await publishEvent("work.escalated", { id, by });
    return (await getWork(id))!;
  });
}

/** Requester or operator only — the assignee hands back instead. */
export async function cancelWork(id: string, by: string, reason: string): Promise<WorkView> {
  return serialized(async () => {
    const item = await mustGet(id);
    if (by !== OPERATOR && by !== item.requestedBy) {
      throw new WorkError(
        by === item.assignee
          ? `you can't cancel work handed to you — finish it, mark it blocked, or hand it back to your manager with a reason`
          : `only ${item.requestedBy} or the operator can cancel ${id}`,
      );
    }
    if (!ACTIVE.includes(item.status)) throw new WorkError(`${id} is already ${item.status}`);
    await appendEvent(WORK_STREAM, "work.cancelled", { id, by, reason: reason.trim() || "cancelled" });
    await publishEvent("work.cancelled", { id, by });
    return (await getWork(id))!;
  });
}

export async function noteWork(id: string, by: string, text: string): Promise<WorkView> {
  if (!text.trim()) throw new WorkError("a note needs text");
  await mustGet(id);
  await appendEvent(WORK_STREAM, "work.noted", { id, by, text: text.trim() });
  return (await getWork(id))!;
}

export async function recordWorkUsage(id: string, tokens: number): Promise<void> {
  if (tokens > 0) await appendEvent(WORK_STREAM, "work.usage", { id, tokens });
}

// ---- The org, as agents see it -------------------------------------------

/** "Who you report to, who reports to you, who's on the team" — injected
 *  so an agent knows whom to hand what, and where hand-backs go. */
export async function orgContext(agentId: string): Promise<string> {
  const all = await listAgentIdentities();
  const me = all.find((a) => a.id === agentId);
  if (!me) return "";
  const nameOf = (id: string) => all.find((a) => a.id === id)?.name ?? id;
  const reports = all.filter((a) => a.reportsTo === agentId);
  const lines = [
    "# Your team",
    `You report to ${me.reportsTo ? `${nameOf(me.reportsTo)} (${me.reportsTo})` : "the operator directly"}.` +
      (reports.length ? ` Reporting to you: ${reports.map((r) => `${r.name} (${r.id})`).join(", ")}.` : ""),
    `Team: ${all.filter((a) => a.id !== agentId).map((a) => `${a.id}${a.role ? ` — ${a.role}` : ""}`).join("; ")}.`,
    "To hand a teammate a piece of work, use the `delegate` tool (it becomes a tracked work item they run); don't just ask in prose. " +
      "Use the `work` tool to see what's assigned to you and to finish it (done), say why you can't (blocked), or hand it back to your manager. " +
      "You can't cancel work handed to you.",
  ];
  const mine = (await listWork({ assignee: agentId })).filter((w) => w.status === "open" || w.status === "in_progress" || w.status === "blocked");
  if (mine.length) lines.push(`Assigned to you: ${mine.slice(0, 6).map((w) => `"${w.title}" (${w.id}, ${w.status})`).join("; ")}.`);
  return lines.join("\n");
}
