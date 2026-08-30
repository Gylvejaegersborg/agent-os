// Harness protocol — the wire contract between BaseOS (the UI) and
// agent-os (the runtime), per AGENT-HARNESS-IMPLEMENTATION-PLAN.md §6-7.
//
// This file defines TYPES ONLY. No transport, no runtime logic — that's
// gateway.ts (Phase 2). The point of separating the contract into its own
// file first is exactly what the plan's Phase 1 asks for: both the
// (future) WebSocket server in this repo and the (future) WebSocket
// client in BaseOS can import the SAME types, so a protocol drift between
// frontend and backend becomes a compile error instead of a runtime bug
// discovered in production.
//
// Design notes:
//   - Every event carries a HarnessEventBase (id/type/timestamp + optional
//     session/agent/task scoping) so a generic "does this event belong to
//     the session I'm subscribed to" filter works without a switch over
//     every event type (see gateway.ts's future subscription filtering).
//   - Payloads reuse this scaffold's OWN core types (Task, Automation,
//     AgentIdentity, WorkerResult) wherever the wire shape and the
//     internal shape are the same thing — no parallel "DTO" types that
//     could silently drift from the real Task/Automation shape over time.
//   - Client->server is HarnessClientEvent (commands); server->client is
//     HarnessServerEvent. Kept as two separate unions (not one shared
//     union with a `direction` field) so a switch over one can never
//     accidentally include a case that only makes sense for the other.

import type { Task, TaskStatus, Automation } from "../core/types.js";
import type { AgentIdentity } from "../core/identity.js";
import type { WorkerResult } from "../core/worker.js";

export const HARNESS_PROTOCOL_VERSION = 1;

// ---- Base shape every event/command shares ----

export interface HarnessEventBase {
  id: string;
  type: string;
  timestamp: string; // ISO 8601
  sessionId?: string;
  agentId?: string;
  taskId?: string;
}

// ---- Runtime status vocabulary (plan §13) ----

export type AgentRuntimeStatus =
  | "idle"
  | "thinking"
  | "working"
  | "waiting"
  | "blocked"
  | "completed"
  | "error";

// ---- Conversation item vocabulary (plan §29) — what the UI renders in
// the single unified message stream, distinct from ModelMessage (which
// is what actually goes to the model). A UI mapper (harnessEventToConversationItem,
// built client-side in BaseOS per plan §74) turns HarnessServerEvents into
// these; a server-side mapper (sessions.ts's buildSessionState) turns
// session-stream events into these for session.sync snapshots. Both sides
// converge on the SAME per-kind shapes below so a message rendered from a
// live stream and one rehydrated after reload/reconnect look identical to
// the UI. ----

export type ConversationItemKind =
  | "user-message"
  | "agent-message"
  | "tool-call"
  | "tool-result"
  | "permission-request"
  | "task-update"
  | "system-event";

interface ConversationItemBase {
  id: string;
  timestamp: string;
  sessionId: string;
  agentId?: string;
}

export interface UserMessageItem extends ConversationItemBase {
  kind: "user-message";
  text: string;
}

export interface AgentMessageItem extends ConversationItemBase {
  kind: "agent-message";
  text: string;
}

export interface ToolCallItem extends ConversationItemBase {
  kind: "tool-call";
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolResultItem extends ConversationItemBase {
  kind: "tool-result";
  tool?: string;
  ok: boolean;
  output: string;
  error?: string;
}

export interface PermissionItem extends ConversationItemBase {
  kind: "permission-request";
  request: PermissionRequestPayload;
}

export interface TaskItem extends ConversationItemBase {
  kind: "task-update";
  task: Task;
}

export interface SystemEventItem extends ConversationItemBase {
  kind: "system-event";
  text: string;
}

export type ConversationItem =
  | UserMessageItem
  | AgentMessageItem
  | ToolCallItem
  | ToolResultItem
  | PermissionItem
  | TaskItem
  | SystemEventItem;

// ---- Tool rendering vocabulary (plan §41) ----

export type ToolRenderer = "text" | "diff" | "file" | "terminal" | "browser" | "image" | "json";

// ---- Permission vocabulary (plan §14-17) ----

export type PermissionRisk = "low" | "medium" | "high";
export type PermissionDecision = "allow_once" | "allow_always" | "deny";

export interface PermissionRequestPayload {
  requestId: string;
  tool: string;
  payload: Record<string, unknown>;
  risk: PermissionRisk;
  options: Array<"once" | "always" | "deny">;
}

// =====================================================================
// SERVER -> CLIENT (events)
// =====================================================================

export interface HarnessReadyEvent extends HarnessEventBase {
  type: "harness.ready";
  payload: {
    version: number;
    capabilities: string[];
  };
}

export interface SessionCreatedEvent extends HarnessEventBase {
  type: "session.created";
  sessionId: string;
  payload: {
    agentId: string;
  };
}

/** Full session projection — sent in response to a session.sync command
 *  (plan §73) so a reconnecting/reloading client can rehydrate without
 *  trusting stale React state. Deliberately a snapshot, not a diff. */
export interface SessionStateEvent extends HarnessEventBase {
  type: "session.state";
  sessionId: string;
  payload: {
    messages: ConversationItem[];
    tasks: Task[];
    pendingPermissions: PermissionRequestPayload[];
  };
}

export interface AgentStatusEvent extends HarnessEventBase {
  type: "agent.status";
  agentId: string;
  payload: {
    status: AgentRuntimeStatus;
    detail?: string;
  };
}

export interface MessageStartEvent extends HarnessEventBase {
  type: "agent.message.start";
  sessionId: string;
  agentId: string;
  payload: {
    messageId: string;
  };
}

export interface MessageDeltaEvent extends HarnessEventBase {
  type: "agent.message.delta";
  sessionId: string;
  agentId: string;
  payload: {
    messageId: string;
    delta: string;
  };
}

export interface MessageEndEvent extends HarnessEventBase {
  type: "agent.message.end";
  sessionId: string;
  agentId: string;
  payload: {
    messageId: string;
    finalContent: string;
    toolCalled?: string;
  };
}

export interface ToolStartEvent extends HarnessEventBase {
  type: "tool.started";
  sessionId: string;
  agentId: string;
  payload: {
    tool: string;
    args: Record<string, unknown>;
    renderer: ToolRenderer;
  };
}

export interface ToolOutputEvent extends HarnessEventBase {
  type: "tool.output";
  sessionId: string;
  agentId: string;
  payload: {
    tool: string;
    chunk: string;
  };
}

export interface ToolEndEvent extends HarnessEventBase {
  type: "tool.ended";
  sessionId: string;
  agentId: string;
  payload: {
    tool: string;
    result: WorkerResult;
  };
}

export interface PermissionRequestEvent extends HarnessEventBase {
  type: "permission.request";
  sessionId: string;
  agentId: string;
  payload: PermissionRequestPayload;
}

/** Sent once a pending permission.request has been resolved (by any
 *  client), so every connected client — not just the one that clicked
 *  the button — can remove the inline Action Card from its own view. */
export interface PermissionResolvedEvent extends HarnessEventBase {
  type: "permission.resolved";
  sessionId: string;
  payload: {
    requestId: string;
    decision: PermissionDecision;
  };
}

export interface TaskEvent extends HarnessEventBase {
  type: "task.created" | "task.updated";
  taskId: string;
  payload: {
    task: Task;
    /** 0..1, optional — most Task kinds don't have a meaningful notion of
     *  fractional progress; omit rather than fake a number. */
    progress?: number;
  };
}

export interface AutomationEvent extends HarnessEventBase {
  type: "automation.started" | "automation.completed" | "automation.failed";
  payload: {
    automation: Automation;
    taskId?: string;
    error?: string;
  };
}

/** Sent in response to automations.list — the full current catalog in one
 *  event, distinct from automation.started/completed/failed (which are
 *  per-firing lifecycle events, not a listing mechanism). Mirrors how
 *  session.state is a snapshot distinct from the per-message stream
 *  events. */
export interface AutomationsSnapshotEvent extends HarnessEventBase {
  type: "automations.snapshot";
  payload: {
    automations: Automation[];
  };
}

export interface WorkspaceEvent extends HarnessEventBase {
  type: "workspace.document.created" | "workspace.document.updated" | "workspace.document.deleted" | "workspace.conflict";
  payload: {
    documentId: string;
    /** Present for created/updated, absent for deleted/conflict. */
    content?: string;
    version?: number;
    updatedBy?: string;
    /** Present only for workspace.conflict — the version the writer
     *  expected to be overwriting, vs. the version actually on record
     *  (see plan §39, optimistic concurrency mirroring Flow.revision). */
    expectedVersion?: number;
    currentVersion?: number;
  };
}

export interface TerminalOutputEvent extends HarnessEventBase {
  type: "terminal.output";
  payload: {
    terminalId: string;
    chunk: string;
  };
}

export interface TerminalClosedEvent extends HarnessEventBase {
  type: "terminal.closed";
  payload: {
    terminalId: string;
    exitCode: number | null;
  };
}

export interface ErrorEvent extends HarnessEventBase {
  type: "harness.error";
  payload: {
    code: string;
    message: string;
    recoverable: boolean;
    requestId?: string;
  };
}

export type HarnessServerEvent =
  | HarnessReadyEvent
  | SessionCreatedEvent
  | SessionStateEvent
  | AgentStatusEvent
  | MessageStartEvent
  | MessageDeltaEvent
  | MessageEndEvent
  | ToolStartEvent
  | ToolOutputEvent
  | ToolEndEvent
  | PermissionRequestEvent
  | PermissionResolvedEvent
  | TaskEvent
  | AutomationEvent
  | AutomationsSnapshotEvent
  | WorkspaceEvent
  | TerminalOutputEvent
  | TerminalClosedEvent
  | ErrorEvent;

// =====================================================================
// CLIENT -> SERVER (commands)
// =====================================================================

export interface HelloCommand {
  type: "hello";
  client: string; // e.g. "baseos"
  version: number;
}

export interface CreateSessionCommand {
  type: "session.create";
  agentId: string;
}

export interface SubscribeSessionCommand {
  type: "session.subscribe";
  sessionId: string;
}

/** Requests a full SessionStateEvent snapshot — used both on initial
 *  subscribe and on reconnect (plan §72-73). */
export interface SyncSessionCommand {
  type: "session.sync";
  sessionId: string;
}

export interface SendMessageCommand {
  type: "send.message";
  sessionId: string;
  agentId: string;
  text: string;
}

export interface CancelTurnCommand {
  type: "turn.cancel";
  sessionId: string;
}

export interface ResolvePermissionCommand {
  type: "permission.resolve";
  requestId: string;
  decision: PermissionDecision;
}

export interface CreateTaskCommand {
  type: "task.create";
  agentId: string;
  input: Record<string, unknown>;
}

export interface CancelTaskCommand {
  type: "task.cancel";
  taskId: string;
}

export interface RetryTaskCommand {
  type: "task.retry";
  taskId: string;
}

export interface ListAutomationsCommand {
  type: "automations.list";
}

export interface CreateAutomationCommand {
  type: "automations.create";
  automation: Omit<Automation, "id">;
}

export interface SetAutomationEnabledCommand {
  type: "automations.setEnabled";
  automationId: string;
  enabled: boolean;
}

export interface RunAutomationCommand {
  type: "automations.run";
  automationId: string;
}

export interface TerminalCreateCommand {
  type: "terminal.create";
  cols: number;
  rows: number;
}

export interface TerminalInputCommand {
  type: "terminal.input";
  terminalId: string;
  data: string;
}

export interface TerminalResizeCommand {
  type: "terminal.resize";
  terminalId: string;
  cols: number;
  rows: number;
}

export interface TerminalCloseCommand {
  type: "terminal.close";
  terminalId: string;
}

export interface WorkspaceUpdateCommand {
  type: "workspace.update";
  documentId: string;
  content: string;
  /** The version the client believes it is overwriting — required so the
   *  server can detect a stale write (plan §39). A brand-new document
   *  uses expectedVersion: 0. */
  expectedVersion: number;
}

export interface SetAgentCommand {
  type: "agent.set";
  sessionId: string;
  agentId: string;
}

export type HarnessClientEvent =
  | HelloCommand
  | CreateSessionCommand
  | SubscribeSessionCommand
  | SyncSessionCommand
  | SendMessageCommand
  | CancelTurnCommand
  | ResolvePermissionCommand
  | CreateTaskCommand
  | CancelTaskCommand
  | RetryTaskCommand
  | ListAutomationsCommand
  | CreateAutomationCommand
  | SetAutomationEnabledCommand
  | RunAutomationCommand
  | TerminalCreateCommand
  | TerminalInputCommand
  | TerminalResizeCommand
  | TerminalCloseCommand
  | WorkspaceUpdateCommand
  | SetAgentCommand;

// ---- Re-exports so consumers of the harness contract don't need a
// separate import from core/ just to read Task/Automation/AgentIdentity
// shapes referenced in the payloads above. ----

export type { Task, TaskStatus, Automation, AgentIdentity, WorkerResult };
