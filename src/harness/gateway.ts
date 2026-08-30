// Harness Gateway — the WebSocket server BaseOS connects to. Per
// AGENT-HARNESS-IMPLEMENTATION-PLAN.md §9-11, §82-84 (Phases 2-3): this is
// the ONLY live transport between BaseOS and agent-os. Every command this
// file dispatches goes straight to this scaffold's OWN existing
// primitives (runTurn, createTask/transitionTask, listAutomations, ...) —
// there is no separate "harness runtime" reimplementing agent execution.
//
// Listens on 127.0.0.1 by default, never 0.0.0.0, per plan §77 — this
// process eventually has shell/PTY access, so it must not be reachable
// off-box without an explicit, deliberate opt-in.
//
// Design:
//   - `subscriptions`: per-socket set of sessionIds that socket wants
//     events for (a browser tab can watch multiple sessions/panels).
//   - `sessionSubscribers`: inverse index (sessionId -> sockets) for
//     broadcasting session-scoped events without an O(sockets) scan per
//     event.
//   - `globalSubscribers`: sockets that get task/automation events
//     regardless of session — matches the plan's Right Rail always
//     showing live task/automation state independent of which
//     conversation is open (every connected socket is a global
//     subscriber; there's no opt-out today since nothing here yet needs
//     one).
//   - Streaming (Phase 4) is NOT implemented yet: send.message emits
//     message.start, ONE message.delta carrying the entire final
//     content, then message.end — proving the event sequence and wire
//     format work end-to-end before model.stream()'s async-iterator
//     upgrade replaces the single big delta with real per-token chunks.

import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { generateId } from "../core/id.js";
import { runTurn } from "../core/agent-loop.js";
import {
  createTask,
  transitionTask,
  listTasks,
  listAutomations,
  registerAutomation,
  setAutomationEnabled,
} from "../core/tasks.js";
import { runAutomationNow, type SchedulerDeps } from "../core/scheduler.js";
import type { ModelAdapter } from "../core/model.js";
import type { Worker } from "../core/worker.js";
import type { SkillRegistry } from "../core/skills.js";
import {
  createHarnessSession,
  getHarnessSession,
  sessionExists,
  buildSessionState,
} from "./sessions.js";
import { HARNESS_PROTOCOL_VERSION } from "./protocol.js";
import type { HarnessClientEvent, HarnessServerEvent, HarnessEventBase } from "./protocol.js";

export interface GatewayDeps {
  model: ModelAdapter;
  worker: Worker;
  skills?: SkillRegistry;
}

export interface GatewayOptions {
  port?: number;
  host?: string;
}

export interface GatewayHandle {
  wss: WebSocketServer;
  /** Resolves once the underlying server has actually bound to a port —
   *  WebSocketServer's own constructor binds asynchronously, so reading
   *  wss.address() immediately after construction can race a real
   *  connection attempt (observed as EADDRNOTAVAIL in
   *  test-harness-gateway.ts before this was added). Always await this
   *  before reading wss.address() or connecting a client. */
  ready: Promise<void>;
  /** Number of currently-connected sockets — exposed for tests/health
   *  checks rather than reaching into the WebSocketServer internals. */
  connectionCount: () => number;
  stop: () => Promise<void>;
}

function baseFields(type: string, extra: Partial<HarnessEventBase> = {}): HarnessEventBase {
  return { id: generateId(), type, timestamp: new Date().toISOString(), ...extra };
}

const CAPABILITIES = ["sessions", "streaming", "tasks", "permissions", "terminal", "workspace"];

export function startHarnessGateway(deps: GatewayDeps, opts: GatewayOptions = {}): GatewayHandle {
  const port = opts.port ?? 8787;
  const host = opts.host ?? "127.0.0.1"; // localhost only — see file header
  const wss = new WebSocketServer({ port, host });
  const ready = new Promise<void>((resolve) => wss.once("listening", () => resolve()));

  const schedulerDeps: SchedulerDeps = { model: deps.model, worker: deps.worker, skills: deps.skills };

  const subscriptions = new Map<WebSocket, Set<string>>();
  const sessionSubscribers = new Map<string, Set<WebSocket>>();
  const globalSubscribers = new Set<WebSocket>();

  function send(ws: WebSocket, event: HarnessServerEvent): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
  }

  function sendError(ws: WebSocket, code: string, message: string, recoverable = true, requestId?: string): void {
    send(ws, {
      ...baseFields("harness.error"),
      payload: { code, message, recoverable, requestId },
    } as HarnessServerEvent);
  }

  function broadcastToSession(sessionId: string, event: HarnessServerEvent): void {
    for (const ws of sessionSubscribers.get(sessionId) ?? []) send(ws, event);
  }

  function broadcastToAll(event: HarnessServerEvent): void {
    for (const ws of globalSubscribers) send(ws, event);
  }

  function subscribeToSession(ws: WebSocket, sessionId: string): void {
    subscriptions.get(ws)!.add(sessionId);
    if (!sessionSubscribers.has(sessionId)) sessionSubscribers.set(sessionId, new Set());
    sessionSubscribers.get(sessionId)!.add(ws);
  }

  async function handleSendMessage(cmd: Extract<HarnessClientEvent, { type: "send.message" }>): Promise<void> {
    const messageId = generateId();
    const { sessionId, agentId } = cmd;

    broadcastToSession(sessionId, {
      ...baseFields("agent.status", { agentId }),
      agentId,
      payload: { status: "thinking" },
    } as HarnessServerEvent);
    broadcastToSession(sessionId, {
      ...baseFields("agent.message.start", { sessionId, agentId }),
      sessionId,
      agentId,
      payload: { messageId },
    } as HarnessServerEvent);

    let result;
    try {
      result = await runTurn({
        sessionId,
        agentId,
        userMessage: cmd.text,
        model: deps.model,
        worker: deps.worker,
        skills: deps.skills,
      });
    } catch (err) {
      broadcastToSession(sessionId, {
        ...baseFields("agent.status", { agentId }),
        agentId,
        payload: { status: "error", detail: err instanceof Error ? err.message : String(err) },
      } as HarnessServerEvent);
      throw err;
    }

    // No real streaming yet (Phase 4 upgrades model.complete() to
    // model.stream()) — the whole response arrives as one delta so the
    // event SEQUENCE (start -> delta -> end) is already correct for
    // whenever real per-token chunks replace this single chunk.
    broadcastToSession(sessionId, {
      ...baseFields("agent.message.delta", { sessionId, agentId }),
      sessionId,
      agentId,
      payload: { messageId, delta: result.finalContent },
    } as HarnessServerEvent);
    broadcastToSession(sessionId, {
      ...baseFields("agent.message.end", { sessionId, agentId }),
      sessionId,
      agentId,
      payload: { messageId, finalContent: result.finalContent, toolCalled: result.toolCalled },
    } as HarnessServerEvent);
    broadcastToSession(sessionId, {
      ...baseFields("agent.status", { agentId }),
      agentId,
      payload: { status: "idle" },
    } as HarnessServerEvent);
  }

  async function dispatch(ws: WebSocket, cmd: HarnessClientEvent): Promise<void> {
    switch (cmd.type) {
      case "hello": {
        send(ws, {
          ...baseFields("harness.ready"),
          payload: { version: HARNESS_PROTOCOL_VERSION, capabilities: CAPABILITIES },
        } as HarnessServerEvent);
        return;
      }

      case "session.create": {
        const session = await createHarnessSession(cmd.agentId);
        subscribeToSession(ws, session.id);
        send(ws, {
          ...baseFields("session.created", { sessionId: session.id }),
          sessionId: session.id,
          payload: { agentId: session.agentId },
        } as HarnessServerEvent);
        return;
      }

      case "session.subscribe": {
        if (!(await sessionExists(cmd.sessionId))) {
          sendError(ws, "NO_SUCH_SESSION", `no such session: ${cmd.sessionId}`);
          return;
        }
        subscribeToSession(ws, cmd.sessionId);
        return;
      }

      case "session.sync": {
        const session = await getHarnessSession(cmd.sessionId);
        if (!session) {
          sendError(ws, "NO_SUCH_SESSION", `no such session: ${cmd.sessionId}`);
          return;
        }
        subscribeToSession(ws, cmd.sessionId); // sync implies "and keep me updated"
        const state = await buildSessionState(cmd.sessionId, session.agentId);
        send(ws, {
          ...baseFields("session.state", { sessionId: cmd.sessionId }),
          sessionId: cmd.sessionId,
          payload: state,
        } as HarnessServerEvent);
        return;
      }

      case "send.message": {
        if (!(await sessionExists(cmd.sessionId))) {
          sendError(ws, "NO_SUCH_SESSION", `no such session: ${cmd.sessionId}`);
          return;
        }
        await handleSendMessage(cmd);
        return;
      }

      case "turn.cancel": {
        // Honest scope: runTurn() has no cancellation hook today (no
        // AbortSignal threaded through model.complete()/worker.run()) —
        // reported as a recoverable error rather than silently
        // pretending to cancel something that keeps running.
        sendError(ws, "NOT_IMPLEMENTED", "turn cancellation is not implemented yet (runTurn has no abort hook)");
        return;
      }

      case "task.create": {
        const task = await createTask({ type: "user-request", agentId: cmd.agentId, input: cmd.input });
        broadcastToAll({
          ...baseFields("task.created", { taskId: task.id }),
          taskId: task.id,
          payload: { task },
        } as HarnessServerEvent);
        return;
      }

      case "task.cancel": {
        await transitionTask(cmd.taskId, "cancelled", { reason: "cancelled via Harness UI" });
        const tasks = await listTasks();
        const task = tasks.find((t) => t.id === cmd.taskId);
        if (task) {
          broadcastToAll({
            ...baseFields("task.updated", { taskId: task.id }),
            taskId: task.id,
            payload: { task },
          } as HarnessServerEvent);
        }
        return;
      }

      case "task.retry": {
        // Honest interpretation of "retry": there is no re-run-in-place
        // primitive in tasks.ts — a Task's status transitions are
        // one-directional and terminal statuses stay terminal (see
        // types.ts's TaskStatus). "Retry" here means creating a NEW Task
        // with the same agentId/input as the original, which is the only
        // semantics that doesn't quietly rewrite history on an
        // already-terminal ledger entry.
        const tasks = await listTasks();
        const original = tasks.find((t) => t.id === cmd.taskId);
        if (!original) {
          sendError(ws, "NO_SUCH_TASK", `no such task: ${cmd.taskId}`);
          return;
        }
        const retried = await createTask({
          type: original.type,
          agentId: original.agentId,
          input: original.input,
          parentTaskId: original.id,
        });
        broadcastToAll({
          ...baseFields("task.created", { taskId: retried.id }),
          taskId: retried.id,
          payload: { task: retried },
        } as HarnessServerEvent);
        return;
      }

      case "automations.list": {
        const automations = await listAutomations();
        send(ws, {
          ...baseFields("automations.snapshot"),
          payload: { automations },
        } as HarnessServerEvent);
        return;
      }

      case "automations.create": {
        await registerAutomation(cmd.automation);
        const automations = await listAutomations();
        broadcastToAll({
          ...baseFields("automations.snapshot"),
          payload: { automations },
        } as HarnessServerEvent);
        return;
      }

      case "automations.setEnabled": {
        await setAutomationEnabled(cmd.automationId, cmd.enabled);
        const automations = await listAutomations();
        broadcastToAll({
          ...baseFields("automations.snapshot"),
          payload: { automations },
        } as HarnessServerEvent);
        return;
      }

      case "automations.run": {
        try {
          const result = await runAutomationNow(cmd.automationId, schedulerDeps);
          const automations = await listAutomations();
          const automation = automations.find((a) => a.id === cmd.automationId)!;
          broadcastToAll({
            ...baseFields("automation.completed", { taskId: result.taskId }),
            payload: { automation, taskId: result.taskId },
          } as HarnessServerEvent);
        } catch (err) {
          const automations = await listAutomations();
          const automation = automations.find((a) => a.id === cmd.automationId);
          if (automation) {
            broadcastToAll({
              ...baseFields("automation.failed"),
              payload: { automation, error: err instanceof Error ? err.message : String(err) },
            } as HarnessServerEvent);
          } else {
            sendError(ws, "NO_SUCH_AUTOMATION", `no such automation: ${cmd.automationId}`);
          }
        }
        return;
      }

      case "terminal.create":
      case "terminal.input":
      case "terminal.resize":
      case "terminal.close":
        // Phase 9 (real PTY via node-pty) not built yet.
        sendError(ws, "NOT_IMPLEMENTED", `${cmd.type} is not implemented yet — terminal support lands in Phase 9`);
        return;

      case "workspace.update":
        // Phase 14 (shared workspace with optimistic concurrency) not
        // built yet.
        sendError(ws, "NOT_IMPLEMENTED", "workspace.update is not implemented yet — shared workspace support lands in Phase 14");
        return;

      case "permission.resolve":
        // Phase 10 (async approval flow) not built yet — permissions.ts's
        // installPermissionPolicy() still only supports a synchronous
        // onAsk callback, not a request/response round-trip over the
        // wire. Reported honestly rather than accepting a resolution
        // that has nothing to resolve.
        sendError(ws, "NOT_IMPLEMENTED", "permission resolution is not implemented yet — lands in Phase 10");
        return;

      case "agent.set": {
        // No per-session "current agent" concept exists yet beyond the
        // agentId a session was created with (sessions.ts's
        // harness.session.created event) — switching agents mid-session
        // is intentionally out of scope until a real need for it shows
        // up in a later phase. Reported rather than silently ignored.
        sendError(ws, "NOT_IMPLEMENTED", "switching an existing session's agent mid-conversation is not implemented yet");
        return;
      }
    }
  }

  wss.on("connection", (ws: WebSocket) => {
    subscriptions.set(ws, new Set());
    globalSubscribers.add(ws);

    ws.on("message", (raw: RawData) => {
      void (async () => {
        let cmd: HarnessClientEvent;
        try {
          cmd = JSON.parse(raw.toString());
        } catch {
          sendError(ws, "BAD_JSON", "could not parse command as JSON");
          return;
        }
        try {
          await dispatch(ws, cmd);
        } catch (err) {
          sendError(ws, "COMMAND_FAILED", err instanceof Error ? err.message : String(err));
        }
      })();
    });

    ws.on("close", () => {
      const subs = subscriptions.get(ws);
      if (subs) {
        for (const sessionId of subs) sessionSubscribers.get(sessionId)?.delete(ws);
      }
      subscriptions.delete(ws);
      globalSubscribers.delete(ws);
    });
  });

  return {
    wss,
    ready,
    connectionCount: () => wss.clients.size,
    stop: () =>
      new Promise((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
        for (const ws of wss.clients) ws.terminate();
      }),
  };
}
