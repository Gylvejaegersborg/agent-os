// Agent-OS Gateway — the narrow HTTP/SSE API a client (BaseOS, or any
// other process) talks to instead of importing core/*.ts directly. This
// is the missing piece the architecture audit called out: before this
// file, the only interaction surface for the whole runtime was a
// readline-based CLI REPL (cli.ts) running in the same process as the
// model/worker — nothing external could create a session, watch it run,
// or resolve an approval from a different process.
//
// Deliberately minimal, matching this scaffold's zero-runtime-dependency
// philosophy (same reasoning as webhook.ts's hand-rolled HTTP server and
// scheduler.ts's hand-rolled cron parser): plain node:http, a small
// manual router, JSON in/out, and one SSE endpoint bridging the REAL
// event bus (eventbus.ts) to a live stream — no second/parallel event
// system, no framework. See the "HONEST LIMITATIONS" block below for what
// this deliberately does not attempt to be yet.
//
// HONEST LIMITATIONS (read before exposing this beyond localhost):
//   1. No authentication/authorization at all. Every request is treated
//      as fully trusted. A real deployment MUST put an auth layer in
//      front of this (or add one here) before it's reachable by anyone
//      but the local machine — same caveat webhook.ts states for itself.
//   2. No HTTPS — terminate TLS in front of this in any real deployment.
//   3. POST /sessions/:id/turns runs a turn to completion (or cancellation)
//      before responding; it does NOT stream the turn's own output
//      incrementally over that same request. Live activity for an
//      in-flight turn is only visible via GET /events (SSE) — a client
//      wanting both the eventual result AND live progress should call
//      POST .../turns and consume GET /events concurrently, not expect
//      one request to do both. A true token-by-token streaming response
//      (SSE/chunked on the turns endpoint itself) is future work — model.ts's
//      ModelAdapter.complete() is not itself a streaming interface yet.
//   4. A single gateway process holds ONE model/worker configuration
//      (GatewayDeps, below) shared by every session it serves — there is
//      no per-request model override endpoint yet (see README's "Provider
//      and model management" section for that future work).

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { ModelAdapter } from "../core/model.js";
import type { Worker } from "../core/worker.js";
import type { SkillRegistry } from "../core/skills.js";
import {
  createSession,
  getSession,
  listSessions,
  cancelSession,
  runTurn,
  getSessionHistory,
  newSessionId,
  listTasks,
  getTask,
  listFlows,
  getFlow,
  listApprovals,
  getApproval,
  approveRequest,
  rejectRequest,
  listWorkerRecords,
  getWorkerRecord,
  listToolDefinitions,
  subscribeToAllEvents,
} from "../core/index.js";
import type { SessionStatus, ApprovalStatus, TaskStatus } from "../core/types.js";

export interface GatewayDeps {
  model: ModelAdapter;
  worker: Worker;
  skills?: SkillRegistry;
  enableSubagents?: boolean;
  enableMemoryNominations?: boolean;
  maxToolHops?: number;
}

export interface GatewayHandle {
  server: Server;
  port: number;
  stop: () => Promise<void>;
}

function readRequestBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        resolve(typeof parsed === "object" && parsed !== null ? parsed : { body: parsed });
      } catch {
        resolve({});
      }
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Starts the gateway's HTTP server. Every route is JSON in/out except
 *  GET /events, which upgrades to a Server-Sent Events stream. Returns a
 *  handle whose stop() closes the server, same shape as every other
 *  start*() handle in this codebase (startScheduler, startHeartbeat,
 *  startWebhookServer). */
export function startGateway(deps: GatewayDeps, port = 0): Promise<GatewayHandle> {
  return new Promise((resolve) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      try {
        await route(req, res, deps);
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    });

    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolve({
        server,
        port: actualPort,
        stop: () => new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}

async function route(req: IncomingMessage, res: ServerResponse, deps: GatewayDeps): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";
  const segments = url.pathname.split("/").filter(Boolean);

  if (method === "GET" && segments.length === 1 && segments[0] === "health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === "GET" && segments.length === 1 && segments[0] === "events") {
    handleEventStream(req, res, url);
    return;
  }

  if (method === "GET" && segments.length === 1 && segments[0] === "tools") {
    sendJson(res, 200, { tools: listToolDefinitions() });
    return;
  }

  // ---- Sessions ----
  if (segments[0] === "sessions") {
    if (method === "POST" && segments.length === 1) {
      const body = await readRequestBody(req);
      if (!body.agentId || typeof body.agentId !== "string") {
        sendJson(res, 400, { error: "agentId (string) is required" });
        return;
      }
      const session = await createSession({
        agentId: body.agentId,
        title: typeof body.title === "string" ? body.title : undefined,
        parentSessionId: typeof body.parentSessionId === "string" ? body.parentSessionId : undefined,
      });
      sendJson(res, 201, session);
      return;
    }
    if (method === "GET" && segments.length === 1) {
      const sessions = await listSessions({
        agentId: url.searchParams.get("agentId") ?? undefined,
        status: (url.searchParams.get("status") as SessionStatus | null) ?? undefined,
        parentSessionId: url.searchParams.get("parentSessionId") ?? undefined,
      });
      sendJson(res, 200, { sessions });
      return;
    }
    if (method === "GET" && segments.length === 2) {
      const session = await getSession(segments[1]!);
      if (!session) {
        sendJson(res, 404, { error: `no such session: ${segments[1]}` });
        return;
      }
      sendJson(res, 200, session);
      return;
    }
    if (method === "GET" && segments.length === 3 && segments[2] === "history") {
      const session = await getSession(segments[1]!);
      if (!session) {
        sendJson(res, 404, { error: `no such session: ${segments[1]}` });
        return;
      }
      const history = await getSessionHistory(segments[1]!);
      sendJson(res, 200, { history });
      return;
    }
    if (method === "POST" && segments.length === 3 && segments[2] === "cancel") {
      const body = await readRequestBody(req);
      try {
        const session = await cancelSession(segments[1]!, typeof body.reason === "string" ? body.reason : undefined);
        sendJson(res, 200, session);
      } catch (err) {
        sendJson(res, 409, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    if (method === "POST" && segments.length === 3 && segments[2] === "turns") {
      const session = await getSession(segments[1]!);
      if (!session) {
        sendJson(res, 404, { error: `no such session: ${segments[1]}` });
        return;
      }
      const body = await readRequestBody(req);
      if (typeof body.userMessage !== "string" || !body.userMessage) {
        sendJson(res, 400, { error: "userMessage (string) is required" });
        return;
      }
      const result = await runTurn({
        sessionId: session.id,
        agentId: session.agentId,
        userMessage: body.userMessage,
        model: deps.model,
        worker: deps.worker,
        skills: deps.skills,
        enableSubagents: deps.enableSubagents,
        enableMemoryNominations: deps.enableMemoryNominations,
        maxToolHops: deps.maxToolHops,
      });
      sendJson(res, 200, result);
      return;
    }
  }

  // ---- Tasks ----
  if (segments[0] === "tasks") {
    if (method === "GET" && segments.length === 1) {
      const tasks = await listTasks({
        agentId: url.searchParams.get("agentId") ?? undefined,
        status: (url.searchParams.get("status") as TaskStatus | null) ?? undefined,
        parentTaskId: url.searchParams.get("parentTaskId") ?? undefined,
      });
      sendJson(res, 200, { tasks });
      return;
    }
    if (method === "GET" && segments.length === 2) {
      const task = await getTask(segments[1]!);
      if (!task) {
        sendJson(res, 404, { error: `no such task: ${segments[1]}` });
        return;
      }
      sendJson(res, 200, task);
      return;
    }
  }

  // ---- Flows ----
  if (segments[0] === "flows") {
    if (method === "GET" && segments.length === 1) {
      sendJson(res, 200, { flows: await listFlows() });
      return;
    }
    if (method === "GET" && segments.length === 2) {
      const flow = await getFlow(segments[1]!);
      if (!flow) {
        sendJson(res, 404, { error: `no such flow: ${segments[1]}` });
        return;
      }
      sendJson(res, 200, flow);
      return;
    }
  }

  // ---- Approvals ----
  if (segments[0] === "approvals") {
    if (method === "GET" && segments.length === 1) {
      const approvals = await listApprovals({
        status: (url.searchParams.get("status") as ApprovalStatus | null) ?? undefined,
        agentId: url.searchParams.get("agentId") ?? undefined,
        sessionId: url.searchParams.get("sessionId") ?? undefined,
      });
      sendJson(res, 200, { approvals });
      return;
    }
    if (method === "GET" && segments.length === 2) {
      const approval = await getApproval(segments[1]!);
      if (!approval) {
        sendJson(res, 404, { error: `no such approval request: ${segments[1]}` });
        return;
      }
      sendJson(res, 200, approval);
      return;
    }
    if (method === "POST" && segments.length === 3 && (segments[2] === "approve" || segments[2] === "reject")) {
      const body = await readRequestBody(req);
      const extra = {
        resolvedBy: typeof body.resolvedBy === "string" ? body.resolvedBy : undefined,
        note: typeof body.note === "string" ? body.note : undefined,
      };
      try {
        const resolved =
          segments[2] === "approve" ? await approveRequest(segments[1]!, extra) : await rejectRequest(segments[1]!, extra);
        sendJson(res, 200, resolved);
      } catch (err) {
        sendJson(res, 409, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
  }

  // ---- Workers ----
  if (segments[0] === "workers") {
    if (method === "GET" && segments.length === 1) {
      sendJson(res, 200, { workers: await listWorkerRecords() });
      return;
    }
    if (method === "GET" && segments.length === 2) {
      const worker = await getWorkerRecord(segments[1]!);
      if (!worker) {
        sendJson(res, 404, { error: `no such registered worker: ${segments[1]}` });
        return;
      }
      sendJson(res, 200, worker);
      return;
    }
  }

  sendJson(res, 404, { error: `no such route: ${method} ${url.pathname}` });
}

/** GET /events — Server-Sent Events, one `data:` line per event, bridging
 *  the real in-process event bus (eventbus.ts) to any connected client.
 *  Optional `?types=agent.turn.start,tool.call.start` query param
 *  restricts the stream to those event types (comma-separated); omit for
 *  every event. Note eventbus.ts's own documented limitation applies
 *  here unchanged: this is IN-PROCESS pub/sub, so this endpoint only
 *  ever sees events published by THIS gateway process — see that file's
 *  header for why a multi-process deployment needs a real broker. */
function handleEventStream(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const typesFilter = url.searchParams.get("types");
  const allowedTypes = typesFilter ? new Set(typesFilter.split(",").map((t) => t.trim())) : undefined;

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(": connected\n\n");

  const unsubscribe = subscribeToAllEvents((eventType, payload) => {
    if (allowedTypes && !allowedTypes.has(eventType)) return;
    res.write(`event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`);
  });

  // Keeps intermediary proxies/browsers from timing out an idle
  // connection — a comment line (": ping"), not a real event, so it's
  // invisible to any client only listening for named `event:` types.
  const keepalive = setInterval(() => res.write(": ping\n\n"), 15_000);
  if (typeof keepalive.unref === "function") keepalive.unref();

  req.on("close", () => {
    clearInterval(keepalive);
    unsubscribe();
  });
}
