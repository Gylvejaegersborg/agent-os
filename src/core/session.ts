// Session registry — the first-class, resumable/listable entity a
// networked runtime needs on top of the raw `session:<id>` message stream
// runTurn() already writes (agent-loop.ts). Before this file, "a session"
// was purely a naming convention (`session:${sessionId}`) with no way to
// list active sessions, know their status, or ask "is this one still
// running" from a process that didn't happen to create it. This is that
// missing registry, built the same way every other primitive in this
// codebase is: an append-only stream (`sessions`) reduced by project().
//
// Deliberately separate from the message stream itself — a Session's
// registry entry (status, ownership, relationships) changes on a very
// different cadence than its message history, and keeping them as two
// streams means a gateway can cheaply list/filter sessions (small,
// bounded `sessions` stream) without reading every message transcript on
// disk to do it.

import { project, appendEvent } from "./eventlog.js";
import { generateId } from "./id.js";
import type { Session, SessionStatus } from "./types.js";

const SESSIONS_STREAM = "sessions";

const TERMINAL_STATUSES: SessionStatus[] = ["cancelled", "completed", "error"];

export interface CreateSessionInput {
  agentId: string;
  title?: string;
  parentSessionId?: string;
  metadata?: Record<string, unknown>;
  /** Explicit id, e.g. for a caller that already generated one via
   *  newSessionId() (agent-loop.ts) and needs the registry entry and the
   *  message stream to share the same id. Omit to have this call generate
   *  one itself. */
  id?: string;
}

export async function createSession(input: CreateSessionInput): Promise<Session> {
  const id = input.id ?? generateId();
  await appendEvent(SESSIONS_STREAM, "session.created", {
    sessionId: id,
    agentId: input.agentId,
    title: input.title,
    parentSessionId: input.parentSessionId,
    metadata: input.metadata ?? {},
  });
  const session = await getSession(id);
  if (!session) throw new Error("session.created event did not project to a session");
  return session;
}

/** Idempotent create-or-touch: if `id` already names a Session, its
 *  `updatedAt` is bumped (via `session.activity`) and the existing entry
 *  is returned; otherwise a new one is created. This is what lets
 *  runTurn() (agent-loop.ts) call this unconditionally at the top of
 *  every turn without callers having to pre-create a Session first —
 *  existing callers/tests that only ever dealt with the raw sessionId
 *  string keep working unchanged, and now also get a real registry entry
 *  for free. */
export async function ensureSession(id: string, agentId: string): Promise<Session> {
  const existing = await getSession(id);
  if (existing) {
    await appendEvent(SESSIONS_STREAM, "session.activity", { sessionId: id });
    const touched = await getSession(id);
    return touched ?? existing;
  }
  return createSession({ id, agentId });
}

interface SessionProjectionState {
  sessions: Map<string, Session>;
}

async function projectSessions(): Promise<SessionProjectionState> {
  return project<SessionProjectionState>(SESSIONS_STREAM, { sessions: new Map() }, (state, event) => {
    if (event.type === "session.created") {
      const p = event.payload as any;
      state.sessions.set(p.sessionId, {
        id: p.sessionId,
        agentId: p.agentId,
        status: "active",
        createdAt: event.timestamp,
        updatedAt: event.timestamp,
        title: p.title,
        parentSessionId: p.parentSessionId,
        metadata: p.metadata ?? {},
      });
    } else if (event.type === "session.activity") {
      const p = event.payload as any;
      const existing = state.sessions.get(p.sessionId);
      if (existing) state.sessions.set(p.sessionId, { ...existing, updatedAt: event.timestamp });
    } else if (event.type === "session.status.changed") {
      const p = event.payload as any;
      const existing = state.sessions.get(p.sessionId);
      if (!existing) return state;
      state.sessions.set(p.sessionId, { ...existing, status: p.status, updatedAt: event.timestamp });
    } else if (event.type === "session.task.linked") {
      const p = event.payload as any;
      const existing = state.sessions.get(p.sessionId);
      if (!existing) return state;
      state.sessions.set(p.sessionId, {
        ...existing,
        taskId: p.taskId ?? existing.taskId,
        flowId: p.flowId ?? existing.flowId,
        updatedAt: event.timestamp,
      });
    }
    return state;
  });
}

export async function getSession(id: string): Promise<Session | undefined> {
  return (await projectSessions()).sessions.get(id);
}

export async function listSessions(filter?: {
  agentId?: string;
  status?: SessionStatus;
  parentSessionId?: string;
}): Promise<Session[]> {
  const { sessions } = await projectSessions();
  let list = [...sessions.values()];
  if (filter?.agentId) list = list.filter((s) => s.agentId === filter.agentId);
  if (filter?.status) list = list.filter((s) => s.status === filter.status);
  if (filter?.parentSessionId) list = list.filter((s) => s.parentSessionId === filter.parentSessionId);
  return list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Rejects a transition out of a terminal status (cancelled/completed/
 *  error) — once a Session is done, it stays done; resuming means
 *  creating a new Session with `parentSessionId` set to it, not reviving
 *  the old one. Mirrors tasks.ts's TERMINAL_STATUSES convention. */
export async function setSessionStatus(
  id: string,
  status: SessionStatus,
  extra: { reason?: string } = {},
): Promise<Session> {
  const existing = await getSession(id);
  if (!existing) throw new Error(`no such session: ${id}`);
  if (TERMINAL_STATUSES.includes(existing.status)) {
    throw new Error(`session ${id} is already terminal ("${existing.status}") and cannot transition to "${status}"`);
  }
  await appendEvent(SESSIONS_STREAM, "session.status.changed", { sessionId: id, status, reason: extra.reason });
  const updated = await getSession(id);
  if (!updated) throw new Error("session.status.changed event did not project to a session");
  return updated;
}

/** Cancels a Session and, best-effort, propagates the cancellation into
 *  any Task it's currently driving — the "propagate cancellation into
 *  child work" requirement (see README/docs). Uses a dynamic import of
 *  tasks.js for the same reason agent-loop.ts's dispatchTool() does for
 *  subagent.js/memory.js: avoids a module-init-time circular import
 *  (tasks.ts has no need to import session.ts, but keeping the coupling
 *  lazy here means adding it never risks one). Propagation is
 *  best-effort: if the linked Task is already terminal, transitionTask()
 *  is simply not called for it (nothing to cancel), and the Session
 *  cancellation itself always proceeds regardless of the Task's state. */
export async function cancelSession(id: string, reason?: string): Promise<Session> {
  const session = await setSessionStatus(id, "cancelled", { reason: reason ?? "cancelled by caller" });
  if (session.taskId) {
    const { getTask, transitionTask } = await import("./tasks.js");
    const task = await getTask(session.taskId);
    const TERMINAL: string[] = ["succeeded", "failed", "timed_out", "cancelled", "lost"];
    if (task && !TERMINAL.includes(task.status)) {
      await transitionTask(session.taskId, "cancelled", { reason: `parent session ${id} was cancelled` });
    }
  }
  return session;
}

/** True once a Session has been cancelled — the check runTurn() (agent-
 *  loop.ts) uses at the top of every hop and right after every tool
 *  dispatch to stop mid-turn instead of running to completion after the
 *  cancellation was requested. Any OTHER terminal status (completed,
 *  error) is deliberately NOT treated as "should stop mid-turn" here —
 *  those are set as a turn's own natural outcome, not an external
 *  interrupt, so a caller checking mid-loop only needs to know about the
 *  interrupt case. */
export async function isSessionCancelled(id: string): Promise<boolean> {
  const session = await getSession(id);
  return session?.status === "cancelled";
}

/** Links a Session to the Task/Flow it's currently driving — e.g. a chat
 *  turn that spawns a subagent Task, or a session backing a Flow-based
 *  multi-agent run. Purely additive/idempotent: passing only one of
 *  taskId/flowId leaves the other field untouched (see the reducer's
 *  `?? existing.taskId` above). */
export async function linkSessionWork(
  id: string,
  work: { taskId?: string; flowId?: string },
): Promise<Session> {
  await appendEvent(SESSIONS_STREAM, "session.task.linked", { sessionId: id, ...work });
  const updated = await getSession(id);
  if (!updated) throw new Error(`no such session: ${id}`);
  return updated;
}
