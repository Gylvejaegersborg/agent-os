// Harness sessions — a thin layer over agent-loop.ts's own session stream
// (session:<id>) that adds exactly what the Harness Gateway needs and the
// agent loop doesn't already provide: (1) a way to know which agentId a
// session belongs to without re-deriving it from event history every
// time, and (2) buildSessionState(), which turns a session's history into
// the ConversationItem[] shape the wire protocol (protocol.ts) actually
// sends to clients — the mapping BaseOS needs on session.sync / initial
// subscribe (plan §10, §73).
//
// Deliberately NOT a new mutable store: session->agentId is itself
// recorded as an event (harness.session.created) on the SAME session
// stream agent-loop.ts already writes to, so a session's "which agent"
// binding is just another projection, not a side-channel that could
// drift from the event log.

import { appendEvent, project, readStream } from "../core/eventlog.js";
import { newSessionId, getSessionHistory } from "../core/agent-loop.js";
import { getTask } from "../core/tasks.js";
import type { Task } from "../core/types.js";
import type {
  ConversationItem,
  PermissionRequestPayload,
} from "./protocol.js";

function sessionStream(sessionId: string): string {
  return `session:${sessionId}`;
}

export interface HarnessSession {
  id: string;
  agentId: string;
  createdAt: string;
}

/** Creates a new Harness session bound to one agentId. Returns the
 *  sessionId immediately usable with runTurn()/getSessionHistory() from
 *  agent-loop.ts, since it's the exact same session stream. */
export async function createHarnessSession(agentId: string): Promise<HarnessSession> {
  const id = newSessionId();
  await appendEvent(sessionStream(id), "harness.session.created", { agentId });
  const session = await getHarnessSession(id);
  if (!session) throw new Error("harness.session.created event did not project");
  return session;
}

async function projectSession(sessionId: string): Promise<HarnessSession | undefined> {
  return project<HarnessSession | undefined>(sessionStream(sessionId), undefined, (state, event) => {
    if (event.type === "harness.session.created") {
      const p = event.payload as { agentId: string };
      return { id: sessionId, agentId: p.agentId, createdAt: event.timestamp };
    }
    return state;
  });
}

export async function getHarnessSession(sessionId: string): Promise<HarnessSession | undefined> {
  return projectSession(sessionId);
}

/** True if this sessionId has ever had a harness.session.created event —
 *  i.e. it's a real, known session, not an id a client made up. Checked
 *  before subscribing/syncing so the gateway can reject bogus session ids
 *  with a clear harness.error rather than silently returning empty state
 *  that looks like "session exists but has no messages yet." */
export async function sessionExists(sessionId: string): Promise<boolean> {
  const events = await readStream(sessionStream(sessionId));
  return events.length > 0;
}

/** Reads pending (not-yet-resolved) permission requests directly from the
 *  session stream — a request is pending if a `permission.request` event
 *  exists with no later `permission.resolved` event carrying the same
 *  requestId. Mirrors the same "derive everything from the log" approach
 *  as every other projection in this codebase; there is no separate
 *  "pending permissions" table to drift out of sync. */
async function projectPendingPermissions(sessionId: string): Promise<PermissionRequestPayload[]> {
  const events = await readStream(sessionStream(sessionId));
  const pending = new Map<string, PermissionRequestPayload>();
  for (const event of events) {
    if (event.type === "harness.permission.requested") {
      const p = event.payload as unknown as PermissionRequestPayload;
      pending.set(p.requestId, p);
    } else if (event.type === "harness.permission.resolved") {
      const p = event.payload as { requestId: string };
      pending.delete(p.requestId);
    }
  }
  return [...pending.values()];
}

/** Maps a session's ModelMessage history (agent-loop.ts's own format —
 *  role: system|user|assistant|tool) into the ConversationItem[] shape
 *  the wire protocol sends. System messages are dropped: they're
 *  synthesized fresh every turn from memory/skills/identity (see
 *  agent-loop.ts's runTurn) and are never something a human typed or an
 *  agent said — showing them in a chat UI would be noise, not signal.
 *  Tool-role messages become ToolResultItem (the agent loop doesn't
 *  currently record the original tool NAME on the result message itself,
 *  only on the separate tool.call.start/tool.call.end audit events — a
 *  known gap flagged here rather than guessed at). */
export async function buildSessionState(sessionId: string, agentId: string): Promise<{
  messages: ConversationItem[];
  tasks: Task[];
  pendingPermissions: PermissionRequestPayload[];
}> {
  const history = await getSessionHistory(sessionId);
  const messages: ConversationItem[] = history.map((m, i) => {
    const base = { id: `${sessionId}_${i}`, timestamp: new Date().toISOString(), sessionId, agentId };
    if (m.role === "user") return { ...base, kind: "user-message" as const, text: m.content };
    if (m.role === "assistant") return { ...base, kind: "agent-message" as const, text: m.content };
    // role === "tool" (system is filtered out below)
    return { ...base, kind: "tool-result" as const, ok: !m.content.startsWith("error:"), output: m.content };
  }).filter((_, i) => history[i]!.role !== "system");

  // Tasks associated with this session: agent-loop.ts's runTurn() itself
  // creates no Task for plain chat turns (by design — see types.ts's Task
  // doc comment), so this list is only ever populated by whatever the
  // GATEWAY layer separately records as session<->task associations
  // (Phase 11, Tasks/Subagents wiring) — kept as an explicit empty-array
  // default here rather than guessing at an association mechanism that
  // doesn't exist yet.
  const tasks: Task[] = [];

  const pendingPermissions = await projectPendingPermissions(sessionId);

  return { messages, tasks, pendingPermissions };
}

// Re-exported so gateway.ts can look up a Task by id without a second
// import from core/tasks.js just for this one pass-through.
export { getTask };
