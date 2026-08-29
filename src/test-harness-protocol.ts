// Standalone test for Phase 1 of the Harness build (see
// AGENT-HARNESS-IMPLEMENTATION-PLAN.md §82-83): proves the protocol
// contract in src/harness/protocol.ts actually compiles and type-narrows
// correctly as a discriminated union — the literal "done when" criterion
// for Phase 1 is "TypeScript compiles and both backend/frontend can
// import the same contract." This test constructs one example of every
// server event and every client command, then narrows each one through
// a switch on `.type` to prove the discriminated union actually
// discriminates (a payload typo would show up here as a compile error,
// not a runtime bug found later).

import type {
  HarnessServerEvent,
  HarnessClientEvent,
  HarnessReadyEvent,
  SessionCreatedEvent,
  SessionStateEvent,
  AgentStatusEvent,
  MessageStartEvent,
  MessageDeltaEvent,
  MessageEndEvent,
  ToolStartEvent,
  ToolOutputEvent,
  ToolEndEvent,
  PermissionRequestEvent,
  PermissionResolvedEvent,
  TaskEvent,
  AutomationEvent,
  WorkspaceEvent,
  TerminalOutputEvent,
  TerminalClosedEvent,
  ErrorEvent,
} from "./harness/protocol.js";
import { HARNESS_PROTOCOL_VERSION } from "./harness/protocol.js";
import type { Task, Automation } from "./core/types.js";

let passed = 0;
let failed = 0;
function ok(label: string, cond: boolean): void {
  if (cond) {
    passed++;
    console.log(`ok: ${label}`);
  } else {
    failed++;
    console.log(`FAIL: ${label}`);
  }
}

const now = new Date().toISOString();

// ---- Build one example of every server event ----

const exampleTask: Task = {
  id: "task_1",
  type: "user-request",
  agentId: "claude",
  status: "running",
  createdAt: now,
  input: {},
  notifyPolicy: "immediate",
};

const exampleAutomation: Automation = {
  id: "auto_1",
  trigger: { kind: "cron", expr: "0 8 * * *" },
  agentId: "claude",
  promptTemplate: "Morning brief",
  enabled: true,
};

const serverEvents: HarnessServerEvent[] = [
  { id: "e1", type: "harness.ready", timestamp: now, payload: { version: HARNESS_PROTOCOL_VERSION, capabilities: ["sessions"] } } satisfies HarnessReadyEvent,
  { id: "e2", type: "session.created", timestamp: now, sessionId: "sess_1", payload: { agentId: "claude" } } satisfies SessionCreatedEvent,
  { id: "e3", type: "session.state", timestamp: now, sessionId: "sess_1", payload: { messages: [], tasks: [exampleTask], pendingPermissions: [] } } satisfies SessionStateEvent,
  { id: "e4", type: "agent.status", timestamp: now, agentId: "claude", payload: { status: "thinking" } } satisfies AgentStatusEvent,
  { id: "e5", type: "agent.message.start", timestamp: now, sessionId: "sess_1", agentId: "claude", payload: { messageId: "msg_1" } } satisfies MessageStartEvent,
  { id: "e6", type: "agent.message.delta", timestamp: now, sessionId: "sess_1", agentId: "claude", payload: { messageId: "msg_1", delta: "Hello" } } satisfies MessageDeltaEvent,
  { id: "e7", type: "agent.message.end", timestamp: now, sessionId: "sess_1", agentId: "claude", payload: { messageId: "msg_1", finalContent: "Hello" } } satisfies MessageEndEvent,
  { id: "e8", type: "tool.started", timestamp: now, sessionId: "sess_1", agentId: "claude", payload: { tool: "shell", args: {}, renderer: "terminal" } } satisfies ToolStartEvent,
  { id: "e9", type: "tool.output", timestamp: now, sessionId: "sess_1", agentId: "claude", payload: { tool: "shell", chunk: "hello\n" } } satisfies ToolOutputEvent,
  { id: "e10", type: "tool.ended", timestamp: now, sessionId: "sess_1", agentId: "claude", payload: { tool: "shell", result: { ok: true, output: "hello\n" } } } satisfies ToolEndEvent,
  { id: "e11", type: "permission.request", timestamp: now, sessionId: "sess_1", agentId: "claude", payload: { requestId: "perm_1", tool: "shell", payload: { command: "npm install" }, risk: "medium", options: ["once", "always", "deny"] } } satisfies PermissionRequestEvent,
  { id: "e12", type: "permission.resolved", timestamp: now, sessionId: "sess_1", payload: { requestId: "perm_1", decision: "allow_once" } } satisfies PermissionResolvedEvent,
  { id: "e13", type: "task.updated", timestamp: now, taskId: "task_1", payload: { task: exampleTask, progress: 0.5 } } satisfies TaskEvent,
  { id: "e14", type: "automation.started", timestamp: now, payload: { automation: exampleAutomation, taskId: "task_1" } } satisfies AutomationEvent,
  { id: "e15", type: "workspace.document.updated", timestamp: now, payload: { documentId: "doc_1", content: "hi", version: 2, updatedBy: "claude" } } satisfies WorkspaceEvent,
  { id: "e16", type: "terminal.output", timestamp: now, payload: { terminalId: "term_1", chunk: "hello\n" } } satisfies TerminalOutputEvent,
  { id: "e17", type: "terminal.closed", timestamp: now, payload: { terminalId: "term_1", exitCode: 0 } } satisfies TerminalClosedEvent,
  { id: "e18", type: "harness.error", timestamp: now, payload: { code: "AGENT_UNAVAILABLE", message: "no model configured", recoverable: true } } satisfies ErrorEvent,
];

ok("18 example server events constructed", serverEvents.length === 18);

// Prove the discriminated union actually narrows per-branch (a payload
// typo here would be a compile error, which is the point of this test).
let narrowedCount = 0;
for (const evt of serverEvents) {
  switch (evt.type) {
    case "harness.ready":
      narrowedCount += evt.payload.capabilities.length >= 0 ? 1 : 0;
      break;
    case "session.created":
      narrowedCount += evt.payload.agentId === "claude" ? 1 : 0;
      break;
    case "session.state":
      narrowedCount += evt.payload.tasks.length === 1 ? 1 : 0;
      break;
    case "agent.status":
      narrowedCount += evt.payload.status === "thinking" ? 1 : 0;
      break;
    case "agent.message.start":
      narrowedCount += evt.payload.messageId === "msg_1" ? 1 : 0;
      break;
    case "agent.message.delta":
      narrowedCount += evt.payload.delta === "Hello" ? 1 : 0;
      break;
    case "agent.message.end":
      narrowedCount += evt.payload.finalContent === "Hello" ? 1 : 0;
      break;
    case "tool.started":
      narrowedCount += evt.payload.renderer === "terminal" ? 1 : 0;
      break;
    case "tool.output":
      narrowedCount += evt.payload.chunk.length > 0 ? 1 : 0;
      break;
    case "tool.ended":
      narrowedCount += evt.payload.result.ok ? 1 : 0;
      break;
    case "permission.request":
      narrowedCount += evt.payload.options.includes("deny") ? 1 : 0;
      break;
    case "permission.resolved":
      narrowedCount += evt.payload.decision === "allow_once" ? 1 : 0;
      break;
    case "task.created":
    case "task.updated":
      narrowedCount += evt.payload.task.id === "task_1" ? 1 : 0;
      break;
    case "automation.started":
    case "automation.completed":
    case "automation.failed":
      narrowedCount += evt.payload.automation.id === "auto_1" ? 1 : 0;
      break;
    case "workspace.document.created":
    case "workspace.document.updated":
    case "workspace.document.deleted":
    case "workspace.conflict":
      narrowedCount += evt.payload.documentId === "doc_1" ? 1 : 0;
      break;
    case "terminal.output":
      narrowedCount += evt.payload.terminalId === "term_1" ? 1 : 0;
      break;
    case "terminal.closed":
      narrowedCount += evt.payload.exitCode === 0 ? 1 : 0;
      break;
    case "harness.error":
      narrowedCount += evt.payload.recoverable ? 1 : 0;
      break;
  }
}
ok("every server event narrows to its own payload shape via switch(.type)", narrowedCount === serverEvents.length);

// ---- Build one example of every client command ----

const clientCommands: HarnessClientEvent[] = [
  { type: "hello", client: "baseos", version: HARNESS_PROTOCOL_VERSION },
  { type: "session.create", agentId: "claude" },
  { type: "session.subscribe", sessionId: "sess_1" },
  { type: "session.sync", sessionId: "sess_1" },
  { type: "send.message", sessionId: "sess_1", agentId: "claude", text: "Hello" },
  { type: "turn.cancel", sessionId: "sess_1" },
  { type: "permission.resolve", requestId: "perm_1", decision: "allow_once" },
  { type: "task.create", agentId: "claude", input: {} },
  { type: "task.cancel", taskId: "task_1" },
  { type: "task.retry", taskId: "task_1" },
  { type: "automations.list" },
  { type: "automations.create", automation: { trigger: { kind: "cron", expr: "0 8 * * *" }, agentId: "claude", promptTemplate: "brief", enabled: true } },
  { type: "automations.setEnabled", automationId: "auto_1", enabled: false },
  { type: "automations.run", automationId: "auto_1" },
  { type: "terminal.create", cols: 80, rows: 24 },
  { type: "terminal.input", terminalId: "term_1", data: "echo hi\n" },
  { type: "terminal.resize", terminalId: "term_1", cols: 100, rows: 30 },
  { type: "terminal.close", terminalId: "term_1" },
  { type: "workspace.update", documentId: "doc_1", content: "hi", expectedVersion: 1 },
  { type: "agent.set", sessionId: "sess_1", agentId: "nyx" },
];

ok("20 example client commands constructed", clientCommands.length === 20);

let commandNarrowedCount = 0;
for (const cmd of clientCommands) {
  switch (cmd.type) {
    case "hello":
      commandNarrowedCount += cmd.client === "baseos" ? 1 : 0;
      break;
    case "session.create":
      commandNarrowedCount += cmd.agentId === "claude" ? 1 : 0;
      break;
    case "session.subscribe":
    case "session.sync":
      commandNarrowedCount += cmd.sessionId === "sess_1" ? 1 : 0;
      break;
    case "send.message":
      commandNarrowedCount += cmd.text === "Hello" ? 1 : 0;
      break;
    case "turn.cancel":
      commandNarrowedCount += cmd.sessionId === "sess_1" ? 1 : 0;
      break;
    case "permission.resolve":
      commandNarrowedCount += cmd.decision === "allow_once" ? 1 : 0;
      break;
    case "task.create":
      commandNarrowedCount += cmd.agentId === "claude" ? 1 : 0;
      break;
    case "task.cancel":
    case "task.retry":
      commandNarrowedCount += cmd.taskId === "task_1" ? 1 : 0;
      break;
    case "automations.list":
      commandNarrowedCount += 1;
      break;
    case "automations.create":
      commandNarrowedCount += cmd.automation.enabled ? 1 : 0;
      break;
    case "automations.setEnabled":
      commandNarrowedCount += cmd.enabled === false ? 1 : 0;
      break;
    case "automations.run":
      commandNarrowedCount += cmd.automationId === "auto_1" ? 1 : 0;
      break;
    case "terminal.create":
      commandNarrowedCount += cmd.cols === 80 ? 1 : 0;
      break;
    case "terminal.input":
      commandNarrowedCount += cmd.data.length > 0 ? 1 : 0;
      break;
    case "terminal.resize":
      commandNarrowedCount += cmd.cols === 100 ? 1 : 0;
      break;
    case "terminal.close":
      commandNarrowedCount += cmd.terminalId === "term_1" ? 1 : 0;
      break;
    case "workspace.update":
      commandNarrowedCount += cmd.expectedVersion === 1 ? 1 : 0;
      break;
    case "agent.set":
      commandNarrowedCount += cmd.agentId === "nyx" ? 1 : 0;
      break;
  }
}
ok("every client command narrows to its own shape via switch(.type)", commandNarrowedCount === clientCommands.length);

// ---- JSON round-trip: prove the wire format survives serialization
// (the actual transport in gateway.ts will be JSON over WebSocket) ----

const roundTripped: HarnessServerEvent[] = JSON.parse(JSON.stringify(serverEvents));
ok("all server events survive a JSON round-trip", roundTripped.length === serverEvents.length && roundTripped[5].type === "agent.message.delta");

const roundTrippedCommands: HarnessClientEvent[] = JSON.parse(JSON.stringify(clientCommands));
ok("all client commands survive a JSON round-trip", roundTrippedCommands.length === clientCommands.length && roundTrippedCommands[4].type === "send.message");

console.log("");
if (failed === 0) {
  console.log(`All harness protocol tests passed (${passed}/${passed}).`);
} else {
  console.log(`${failed} harness protocol test(s) FAILED (${passed} passed).`);
  process.exit(1);
}
