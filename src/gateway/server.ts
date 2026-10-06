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
  setSessionFocus,
  getSession,
  listSessions,
  cancelSession,
  renameSession,
  runTurn,
  createModelForAgent,
  listProviders,
  OPERATOR,
  WorkError,
  cancelWork,
  createWork,
  getWork,
  listWork,
  noteWork,
  reassignWork,
  reopenWork,
  listLeads,
  setFlowFocus,
  exportTeam,
  bundleTeam,
  unbundleTeam,
  planTeamImport,
  applyTeamImport,
  listStaleWork,
  staleRunMs,
  listWatches,
  verifierId,
  watchWork,
  listAgentRevisions,
  restoreAgentRevision,
  getAgentIdentity,
  listReviews,
  reviewDigest,
  type WorkStatus,
  AgentBlockedError,
  getAgentControlState,
  pauseAgent,
  resumeAgent,
  setAgentBudget,
  getSessionHistory,
  getSessionUsage,
  newSessionId,
  listTasks,
  getTask,
  listFlows,
  getFlow,
  createFlow,
  cancelFlow,
  resumeFlow,
  reopenFlow,
  markStepDone,
  listApprovals,
  getApproval,
  approveRequest,
  rejectRequest,
  listWorkerRecords,
  getWorkerRecord,
  listToolDefinitions,
  subscribeToAllEvents,
  listAgentRecords,
  getAgentRecord,
  registerAgent,
  updateAgent,
  listArtifacts,
  getArtifact,
  getCuratedMemory,
  listEpisodic,
  listAgentMemoryNominations,
  approveAgentMemory,
  rejectAgentMemory,
  listDreamingPasses,
  writeSkill,
  deleteSkill,
  parseSkillFile,
  listFileRevisions,
  getFileRevision,
  restoreFileRevision,
  saveSnapshot,
  loadSnapshot,
  loadOverlay,
  removeOverlayItem,
  listAllowRules,
  addAllowRule,
  removeAllowRule,
  EXACT_ONLY_TOOLS,
  executeApprovedCall,
  consumeApproval,
  recordDesktopBatch,
  getDesktopFocus,
  desktopTimeline,
  desktopDaySummary,
  renderDesktopDigest,
  weekDigest,
  recordDesktopCorrection,
  getFlowDefinition,
  buildFlowReport,
  storeFlowDefinition,
  listConnectors,
  refreshConnectors,
  setConnectorEnabled,
  localDay,
} from "../core/index.js";
import { checkPathSandbox } from "../core/permissions.js";
import { runReview } from "./review-loop.js";
import type { SessionStatus, ApprovalStatus, ApprovalRequest, TaskStatus, NominationStatus } from "../core/types.js";
import type { SandboxPolicy } from "../core/permissions.js";
import type { ConfiguredHook } from "../core/configured-hooks.js";
import { handleMcp, type McpDeps } from "./mcp.js";
import { handleLibrary } from "./library-routes.js";
import { handleSoundlab } from "./soundlab-routes.js";
import { listSongAssets } from "../core/library.js";
import type { SessionFocus } from "../core/types.js";
import { closeAllTerminals, closeTerminal, setTerminalGatewayUrl, createTerminal, listTerminals, ptyBackend, resizeTerminal, streamTerminal, terminalsEnabled, writeTerminal } from "./terminal.js";
import type { ArtifactType } from "../core/artifacts.js";
import type { FlowStepDefinition } from "../core/flow-engine.js";

export interface GatewayDeps {
  model: ModelAdapter;
  worker: Worker;
  skills?: SkillRegistry;
  /** Root directory writeSkill()/deleteSkill() persist to — separate from
   *  `skills` (the in-memory catalog) because the registry itself doesn't
   *  know where it was loaded from. Both must be set for POST/DELETE
   *  /skills to work; GET works with just `skills`. */
  skillsDir?: string;
  enableSubagents?: boolean;
  enableMemoryNominations?: boolean;
  enableArtifacts?: boolean;
  /** Tell agents about the BaseSpace bridge in their system message. */
  enableBaseSpace?: boolean;
  maxToolHops?: number;
  sandboxPolicy?: SandboxPolicy;
  /** Purely for GET /hooks's visibility — the hooks themselves are
   *  already live (loadConfiguredHooks() registered them directly with
   *  hooks.ts before the gateway even started); this is just so a
   *  settings UI can show what's configured without re-reading the file
   *  itself. */
  configuredHooks?: ConfiguredHook[];
}

export interface GatewayHandle {
  server: Server;
  port: number;
  stop: () => Promise<void>;
}

function readRequestBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      // Stop buffering past the limit and answer with an empty body (every
      // route validates its input, so this reads as a bad request).
      if (raw.length > maxBytes) {
        raw = "";
        req.removeAllListeners("data");
        req.removeAllListeners("end");
        req.resume();
        resolve({});
      }
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

/** Validates+narrows a POST body's `steps` field into a real
 *  FlowStepDefinition[], or returns undefined if it's missing/malformed
 *  — deliberately strict (every step needs at least id/agentId/goal as
 *  strings) rather than passing a loosely-typed body straight into
 *  flow-engine.ts, which assumes well-formed input. */
function parseFlowSteps(raw: unknown): FlowStepDefinition[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const steps: FlowStepDefinition[] = [];
  for (const s of raw) {
    if (typeof s !== "object" || s === null) return undefined;
    const { id, agentId, goal, dependsOn, retries } = s as Record<string, unknown>;
    if (typeof id !== "string" || typeof agentId !== "string" || typeof goal !== "string") return undefined;
    if (dependsOn !== undefined && !(Array.isArray(dependsOn) && dependsOn.every((d) => typeof d === "string"))) return undefined;
    if (retries !== undefined && typeof retries !== "number") return undefined;
    steps.push({ id, agentId, goal, dependsOn: dependsOn as string[] | undefined, retries: retries as number | undefined });
  }
  return steps;
}

/** Wide-open CORS on every response — a deliberate choice, not an
 *  oversight: this gateway's ONLY intended client today is a browser-side
 *  BaseOS instance running on an arbitrary localhost/LAN port during dev
 *  (Vite's dev server port changes across projects/machines), and there is
 *  no auth layer yet for an origin allowlist to meaningfully gate (see
 *  this file's own "HONEST LIMITATIONS" header — the whole gateway is
 *  already fully trusted-network-only). Tightening this to a specific
 *  origin is straightforward once real auth exists; doing so now would
 *  only add friction without adding real security. Handles the browser's
 *  OPTIONS preflight directly (204, no body) before any route matching. */
function withCors(req: IncomingMessage, res: ServerResponse): boolean {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

/** Starts the gateway's HTTP server. Every route is JSON in/out except
 *  GET /events, which upgrades to a Server-Sent Events stream. Returns a
 *  handle whose stop() closes the server, same shape as every other
 *  start*() handle in this codebase (startScheduler, startHeartbeat,
 *  startWebhookServer). */
export function startGateway(deps: GatewayDeps, port = 0): Promise<GatewayHandle> {
  return new Promise((resolve) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (withCors(req, res)) return;
      try {
        await route(req, res, deps);
      } catch (err) {
        // A paused or over-budget agent (controls.ts) is a refusal, not a crash.
        if (err instanceof AgentBlockedError) {
          sendJson(res, 409, { error: err.message, blocked: err.blocked, agentId: err.agentId });
          return;
        }
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    });

    // A music upload (a WAV can be 100+ MB) can take longer than Node's default 5 minute
    // limit to arrive over a slow link. The gateway is loopback-only (reached through
    // BaseSpace's proxy), so the slow-request guard can be generous.
    server.requestTimeout = 30 * 60_000;

    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      setTerminalGatewayUrl(`http://127.0.0.1:${actualPort}`);
      resolve({
        server,
        port: actualPort,
        stop: () => {
          closeAllTerminals();
          return new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res())));
        },
      });
    });
  });
}

/** A request body's `focus`: undefined when absent, "invalid" when malformed. */
function parseFocus(raw: unknown): SessionFocus | undefined | "invalid" {
  if (raw === undefined || raw === null) return undefined;
  const f = raw as { kind?: unknown; id?: unknown };
  if ((f.kind === "goal" || f.kind === "project") && typeof f.id === "string" && f.id) return { kind: f.kind, id: f.id };
  return "invalid";
}

/** What mcp.ts needs from the gateway: an agent turn run exactly the way
 *  POST /sessions/:id/turns runs one (same model routing, tools, sandbox
 *  and approvals), in a new session unless one is given. */
function mcpDeps(deps: GatewayDeps): McpDeps {
  return {
    async askAgent(agentId, message, sessionId, focus) {
      let session = sessionId ? await getSession(sessionId) : undefined;
      if (sessionId && (!session || session.agentId !== agentId)) {
        throw new Error(`no session ${sessionId} for agent ${agentId}`);
      }
      if (!(await getAgentRecord(agentId))) throw new Error(`no agent "${agentId}" — see list_agents`);
      session ??= await createSession({ agentId, title: "From Claude Code", ...(focus ? { focus } : {}) });
      const model = (await createModelForAgent(agentId)) ?? deps.model;
      const result = await runTurn({
        sessionId: session.id,
        agentId,
        userMessage: message,
        model,
        worker: deps.worker,
        skills: deps.skills,
        enableSubagents: deps.enableSubagents,
        enableMemoryNominations: deps.enableMemoryNominations,
        enableArtifacts: deps.enableArtifacts,
        enableBaseSpace: deps.enableBaseSpace,
        sandboxPolicy: deps.sandboxPolicy,
        maxToolHops: deps.maxToolHops,
      });
      return { sessionId: session.id, reply: result.finalContent, toolCalled: result.toolCalled };
    },
  };
}

/** Runs one follow-up turn in the session whose tool call was waiting on
 *  an approval. On approve the agent re-issues the call, which the
 *  permission hook lets through once (approvals.ts's consumeApproval); on
 *  reject it's told not to. Best effort: errors are logged, not thrown. */
async function resumeAfterDecision(deps: GatewayDeps, approval: ApprovalRequest): Promise<void> {
  try {
    const session = await getSession(approval.sessionId);
    if (!session || session.status === "cancelled") return;
    const call = `${approval.toolName} ${JSON.stringify(approval.args)}`.slice(0, 400);
    const model = (await createModelForAgent(session.agentId)) ?? deps.model;
    let userMessage: string;
    if (approval.status === "approved") {
      // Run the approved call ourselves, then let the agent continue from its
      // result — relying on the model to re-issue the identical call was
      // unreliable. Marked used so it can't also be replayed by the model.
      await consumeApproval({ agentId: approval.agentId, toolName: approval.toolName, args: approval.args });
      const result = await executeApprovedCall({
        sessionId: session.id,
        agentId: session.agentId,
        toolCall: { name: approval.toolName, args: approval.args },
        model,
        worker: deps.worker,
        skills: deps.skills,
        enableSubagents: deps.enableSubagents,
        enableMemoryNominations: deps.enableMemoryNominations,
        enableArtifacts: deps.enableArtifacts,
        sandboxPolicy: deps.sandboxPolicy,
      });
      userMessage =
        `[Approvals] Approved ${approval.id}: ${call}. Go ahead and carry on — it has already been run for you ` +
        `(${result.ok ? "it succeeded" : "it failed"}; the result is the tool message just above). Don't run it again.`;
    } else {
      userMessage = `[Approvals] Rejected ${approval.id}: ${call}. Don't run it. Say what you'd do instead, or ask what the operator wants.`;
    }
    await runTurn({
      sessionId: session.id,
      agentId: session.agentId,
      userMessage,
      model,
      worker: deps.worker,
      skills: deps.skills,
      enableSubagents: deps.enableSubagents,
      enableMemoryNominations: deps.enableMemoryNominations,
      enableArtifacts: deps.enableArtifacts,
      enableBaseSpace: deps.enableBaseSpace,
      sandboxPolicy: deps.sandboxPolicy,
      maxToolHops: deps.maxToolHops,
    });
  } catch (err) {
    console.error(`[gateway] resuming session ${approval.sessionId} after approval ${approval.id} failed:`, err instanceof Error ? err.message : err);
  }
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

  // ---- Work handed between agents (core/work.ts). The operator assigns,
  // cancels, reopens and reassigns; agents do the rest through their tools. ----
  if (segments[0] === "work") {
    const send = async (fn: () => Promise<unknown>, ok = 200) => {
      try {
        sendJson(res, ok, await fn());
      } catch (err) {
        sendJson(res, err instanceof WorkError ? 409 : 500, { error: err instanceof Error ? err.message : String(err) });
      }
    };
    if (method === "GET" && segments.length === 1) {
      const q = (k: string) => url.searchParams.get(k) ?? undefined;
      await send(async () => ({ work: await listWork({ assignee: q("assignee"), requestedBy: q("requestedBy"), involving: q("involving"), team: q("team"), status: q("status") as WorkStatus | undefined }) }));
      return;
    }
    if (method === "GET" && segments.length === 2) {
      const item = await getWork(segments[1]!);
      if (item) sendJson(res, 200, item);
      else sendJson(res, 404, { error: `no work item ${segments[1]}` });
      return;
    }
    const body = method === "POST" ? await readRequestBody(req) : {};
    const text = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : "");
    if (method === "POST" && segments.length === 1) {
      const focus = parseFocus(body.focus);
      if (focus === "invalid") {
        sendJson(res, 400, { error: 'focus must be {kind: "goal" | "project", id}' });
        return;
      }
      await send(async () => {
        const item = await createWork({ title: text("title"), detail: text("detail") || undefined, assignee: text("assignee"), requestedBy: OPERATOR, ...(focus ? { focus } : {}) });
        // {verify: true}: the watchdog checks it once it's finished.
        if (body.verify === true) await watchWork({ rootIds: [item.id], createdBy: OPERATOR });
        return item;
      }, 201);
      return;
    }
    if (method === "POST" && segments.length === 3) {
      const id = segments[1]!;
      const action = segments[2];
      if (action === "cancel") await send(() => cancelWork(id, OPERATOR, text("reason")));
      else if (action === "reopen") await send(() => reopenWork(id, OPERATOR, text("reason") || "reopened by the operator"));
      else if (action === "reassign") await send(() => reassignWork(id, OPERATOR, text("to"), text("reason") || "reassigned by the operator"));
      else if (action === "note") await send(() => noteWork(id, OPERATOR, text("text")));
      else if (action === "verify") await send(() => watchWork({ rootIds: [id], createdBy: OPERATOR, label: text("label") || undefined }));
      else sendJson(res, 404, { error: `unknown work action ${action}` });
      return;
    }
  }

  // ---- Team templates (core/team-template.ts): the team as markdown files.
  // Operator-only, like everything that changes agent config. ----
  if (segments[0] === "team") {
    if (method === "GET" && segments.length === 2 && segments[1] === "export") {
      const files = await exportTeam({ skills: deps.skills });
      sendJson(res, 200, { files, bundle: bundleTeam(files) });
      return;
    }
    if (method === "POST" && segments.length === 2 && segments[1] === "import") {
      const body = await readRequestBody(req);
      const files =
        typeof body.bundle === "string" ? unbundleTeam(body.bundle)
        : body.files && typeof body.files === "object" ? (body.files as Record<string, string>)
        : undefined;
      if (!files) {
        sendJson(res, 400, { error: "send {bundle: string} or {files: {path: text}}, and apply: true to apply" });
        return;
      }
      const plan = body.apply === true
        ? await applyTeamImport(files, { skills: deps.skills, skillsDir: deps.skillsDir })
        : await planTeamImport(files, { skills: deps.skills });
      sendJson(res, plan.problems.length && body.apply === true && !plan.applied ? 409 : 200, plan);
      return;
    }
  }

  // ---- Stale work (core/stale.ts): stuck runs and runs that ended badly,
  // for the operator to look at — nothing is reassigned automatically. ----
  if (segments[0] === "stale" && method === "GET" && segments.length === 1) {
    sendJson(res, 200, { stale: await listStaleWork(), quietMinutes: staleRunMs() / 60_000 });
    return;
  }

  // ---- Watchdog (core/watchdog.ts): watches and their verdicts. ----
  if (segments[0] === "watches" && method === "GET" && segments.length === 1) {
    sendJson(res, 200, { watches: await listWatches(), verifier: verifierId() });
    return;
  }

  // ---- Music library (core/library.ts): the operator's own uploads. ----
  if (segments[0] === "library" && (await handleLibrary(req, res, segments, url, { readJson: readRequestBody, sendJson }))) return;
  // ---- Connectors (core/connectors.ts): the MCP connectors agents can reach through the Claude CLI. Operator-only. ----
  if (segments[0] === "connectors") {
    if (method === "GET" && segments.length === 1) {
      if (url.searchParams.get("refresh") === "1") await refreshConnectors().catch(() => undefined);
      sendJson(res, 200, listConnectors());
      return;
    }
    if (method === "PUT" && segments.length === 2) {
      const body = await readRequestBody(req);
      try {
        sendJson(res, 200, await setConnectorEnabled(decodeURIComponent(segments[1]!), body.enabled === true));
      } catch (err) {
        sendJson(res, 404, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
  }
  // ---- Sound Lab (core/soundlab.ts): synthesized candidates the operator listens to and judges. ----
  if (segments[0] === "soundlab" && (await handleSoundlab(req, res, segments, url, { readJson: readRequestBody, sendJson }))) return;

  // ---- Team reviews (core/review.ts, review-loop.ts): what each lead's
  // review would look at (free — no model call), past reviews, and the
  // operator's "review now". ----
  if (segments[0] === "reviews") {
    if (method === "GET" && segments.length === 1) {
      const agentId = url.searchParams.get("agentId") ?? undefined;
      const leads = await listLeads();
      sendJson(res, 200, { leads: leads.map((l) => l.id), reviews: await listReviews(agentId) });
      return;
    }
    if (method === "GET" && segments.length === 3 && segments[2] === "digest") {
      sendJson(res, 200, await reviewDigest(segments[1]!));
      return;
    }
    if (method === "POST" && segments.length === 2) {
      const agentId = segments[1]!;
      if (!(await getAgentIdentity(agentId))) {
        sendJson(res, 404, { error: `no agent "${agentId}"` });
        return;
      }
      try {
        sendJson(res, 200, await runReview(agentId, deps, { trigger: "operator", force: true }));
      } catch (err) {
        sendJson(res, err instanceof AgentBlockedError ? 409 : 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
  }

  // ---- MCP (mcp.ts) — the OS as tools for Claude Code (the Terminal
  // panel wires it in) or any other MCP client. ----
  if (segments.length === 1 && segments[0] === "mcp") {
    const body = method === "POST" ? await readRequestBody(req) : undefined;
    await handleMcp(req, res, body, mcpDeps(deps));
    return;
  }

  // ---- Terminals (terminal.ts) — interactive Claude Code / shell sessions
  // BaseSpace shows in its Workbench. Off unless AGENT_OS_TERMINAL=1. ----
  if (segments[0] === "terminals") {
    if (method === "GET" && segments.length === 1) {
      sendJson(res, 200, { enabled: terminalsEnabled(), backend: await ptyBackend(), terminals: terminalsEnabled() ? listTerminals() : [] });
      return;
    }
    if (!terminalsEnabled()) {
      sendJson(res, 403, { error: "terminals are off — start the gateway with AGENT_OS_TERMINAL=1 to enable them" });
      return;
    }
    const id = segments[1];
    if (method === "POST" && segments.length === 1) {
      const body = await readRequestBody(req);
      try {
        sendJson(res, 201, await createTerminal(body));
      } catch (err) {
        sendJson(res, 409, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    if (method === "GET" && segments.length === 3 && segments[2] === "stream") {
      if (!streamTerminal(id, req, res)) sendJson(res, 404, { error: `no terminal ${id}` });
      return;
    }
    if (method === "POST" && segments.length === 3 && segments[2] === "input") {
      const body = await readRequestBody(req, 64 * 1024);
      const data = typeof body.data === "string" ? body.data : "";
      if (writeTerminal(id, data)) sendJson(res, 200, { ok: true });
      else sendJson(res, 404, { error: `no running terminal ${id}` });
      return;
    }
    if (method === "POST" && segments.length === 3 && segments[2] === "resize") {
      const body = await readRequestBody(req);
      if (resizeTerminal(id, body.cols, body.rows)) sendJson(res, 200, { ok: true });
      else sendJson(res, 404, { error: `no running terminal ${id}` });
      return;
    }
    if (method === "DELETE" && segments.length === 2) {
      if (closeTerminal(id)) sendJson(res, 200, { ok: true });
      else sendJson(res, 404, { error: `no terminal ${id}` });
      return;
    }
  }

  // Which model providers this gateway can use, for BaseSpace's agent
  // editor. An agent's defaultModel can name any of them ("claude-cli:sonnet",
  // "ollama:llama3.2:3b", ...); see models/real.ts's provider router.
  // ---- Desktop activity (core/desktop.ts) — the operator's machine posts
  // finished app/window spans; everything else is a projection. ----
  if (segments[0] === "desktop") {
    const day = url.searchParams.get("day") ?? localDay(new Date());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      sendJson(res, 400, { error: "day must be YYYY-MM-DD" });
      return;
    }
    if (method === "POST" && segments.length === 2 && segments[1] === "spans") {
      try {
        sendJson(res, 200, await recordDesktopBatch(await readRequestBody(req)));
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    if (method === "GET" && segments.length === 2 && segments[1] === "now") {
      sendJson(res, 200, { focus: getDesktopFocus() ?? null });
      return;
    }
    if (method === "GET" && segments.length === 2 && segments[1] === "timeline") {
      sendJson(res, 200, { day, spans: await desktopTimeline(day) });
      return;
    }
    if (method === "GET" && segments.length === 2 && segments[1] === "summary") {
      const summary = await desktopDaySummary(day);
      sendJson(res, 200, { summary, digest: renderDesktopDigest(summary) });
      return;
    }
    // The Monday-to-Sunday week containing `day`: for the goal/project pages ("3 h 20 m this week").
    if (method === "GET" && segments.length === 2 && segments[1] === "week") {
      sendJson(res, 200, await weekDigest(day));
      return;
    }
    // The operator disagreeing with something learned ("no, that wasn't work"): the strongest memory signal there is.
    if (method === "POST" && segments.length === 2 && segments[1] === "correction") {
      try {
        const body = await readRequestBody(req);
        await recordDesktopCorrection(String(body.text ?? ""));
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
  }

  if (method === "GET" && segments.length === 1 && segments[0] === "providers") {
    sendJson(res, 200, { providers: await listProviders(), defaultModel: deps.model.id });
    return;
  }

  if (method === "GET" && segments.length === 1 && segments[0] === "tools") {
    sendJson(res, 200, { tools: listToolDefinitions() });
    return;
  }

  // ---- BaseSpace bridge (basespace.ts) — BaseSpace pushes a snapshot of
  // its state for the agents to read, and reads back what agents added. ----
  if (segments[0] === "basespace") {
    if (segments[1] === "snapshot" && segments.length === 2) {
      if (method === "POST") {
        try {
          sendJson(res, 200, { ok: true, ...(await saveSnapshot(await readRequestBody(req, 8 * 1024 * 1024))) });
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      if (method === "GET") {
        const snap = await loadSnapshot();
        if (!snap) sendJson(res, 404, { error: "no snapshot yet" });
        else sendJson(res, 200, snap);
        return;
      }
    }
    if (segments[1] === "overlay") {
      if (method === "GET" && segments.length === 2) {
        // What agents added, plus the songs the operator uploaded (library.ts): the Beat
        // DB already merges `library` from here.
        const overlay = await loadOverlay();
        sendJson(res, 200, { ...overlay, library: [...(Array.isArray(overlay.library) ? overlay.library : []), ...(await listSongAssets())] });
        return;
      }
      if (method === "DELETE" && segments.length === 4) {
        const removed = await removeOverlayItem(segments[2], decodeURIComponent(segments[3]));
        sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: "no such overlay item" });
        return;
      }
    }
  }

  // ---- Artifacts (artifacts.ts) — produced outputs attached to a
  // Task/Session/Flow, so a client can list/open what an agent actually
  // made without scraping raw tool-call output for it. ----
  if (segments[0] === "artifacts") {
    if (method === "GET" && segments.length === 1) {
      const artifacts = await listArtifacts({
        taskId: url.searchParams.get("taskId") ?? undefined,
        sessionId: url.searchParams.get("sessionId") ?? undefined,
        flowId: url.searchParams.get("flowId") ?? undefined,
        producer: url.searchParams.get("producer") ?? undefined,
        type: (url.searchParams.get("type") as ArtifactType | null) ?? undefined,
      });
      sendJson(res, 200, { artifacts });
      return;
    }
    if (method === "GET" && segments.length === 2) {
      const artifact = await getArtifact(segments[1]!);
      if (!artifact) {
        sendJson(res, 404, { error: `no such artifact: ${segments[1]}` });
        return;
      }
      sendJson(res, 200, artifact);
      return;
    }
  }

  // ---- Agents — the authoritative registry (agents.ts). This is what
  // lets a client (BaseOS) query identity/role/model/state/currentTask/
  // worker/metrics from Agent-OS instead of maintaining its own mock
  // roster (see Phase 4 of the architecture plan). ----
  if (segments[0] === "agents") {
    // ---- Board controls (controls.ts): pause/resume and token budgets.
    // Operator-only by design — agents get no tool for these. ----
    if (segments.length === 3 && ["pause", "resume", "budget"].includes(segments[2]!) && (method === "POST" || method === "PUT")) {
      const agentId = segments[1]!;
      if (!(await getAgentRecord(agentId))) {
        sendJson(res, 404, { error: `no such agent: ${agentId}` });
        return;
      }
      const body = await readRequestBody(req);
      try {
        if (segments[2] === "pause") await pauseAgent(agentId, { reason: typeof body.reason === "string" ? body.reason : undefined, by: "operator" });
        else if (segments[2] === "resume") await resumeAgent(agentId, { by: "operator" });
        else await setAgentBudget(agentId, body);
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        return;
      }
      sendJson(res, 200, await getAgentControlState(agentId));
      return;
    }
    // ---- Config revisions (governance.ts): an agent's name, role,
    // persona, reporting line, model and budget over time, and "restore
    // this version". Operator-only, like the budgets it covers. ----
    if (segments.length >= 3 && segments[2] === "revisions") {
      const agentId = segments[1]!;
      if (!(await getAgentRecord(agentId))) {
        sendJson(res, 404, { error: `no such agent: ${agentId}` });
        return;
      }
      if (method === "GET" && segments.length === 3) {
        sendJson(res, 200, { revisions: await listAgentRevisions(agentId) });
        return;
      }
      if (method === "POST" && segments.length === 5 && segments[4] === "restore") {
        try {
          sendJson(res, 200, { revisions: await restoreAgentRevision(agentId, Number(segments[3])) });
        } catch (err) {
          sendJson(res, 409, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
    }
    if (method === "GET" && segments.length === 1) {
      sendJson(res, 200, { agents: await listAgentRecords() });
      return;
    }
    if (method === "GET" && segments.length === 2) {
      const agent = await getAgentRecord(segments[1]!);
      if (!agent) {
        sendJson(res, 404, { error: `no such agent: ${segments[1]}` });
        return;
      }
      sendJson(res, 200, agent);
      return;
    }
    if (method === "POST" && segments.length === 1) {
      const body = await readRequestBody(req);
      if (typeof body.id !== "string" || typeof body.name !== "string" || typeof body.persona !== "string") {
        sendJson(res, 400, { error: "id, name, and persona (all strings) are required" });
        return;
      }
      const existing = await getAgentRecord(body.id);
      if (existing) {
        sendJson(res, 409, { error: `agent "${body.id}" already exists — use PATCH-equivalent PUT /agents/:id to update it` });
        return;
      }
      const agent = await registerAgent({
        id: body.id,
        name: body.name,
        persona: body.persona,
        role: typeof body.role === "string" ? body.role : undefined,
        capabilities: Array.isArray(body.capabilities) ? body.capabilities.filter((c: unknown) => typeof c === "string") : undefined,
        defaultModel: typeof body.defaultModel === "string" ? body.defaultModel : undefined,
        reportsTo: typeof body.reportsTo === "string" && body.reportsTo ? body.reportsTo : undefined,
      });
      sendJson(res, 201, agent);
      return;
    }
    if (method === "PUT" && segments.length === 2) {
      const body = await readRequestBody(req);
      const updated = await updateAgent(segments[1]!, {
        name: typeof body.name === "string" ? body.name : undefined,
        persona: typeof body.persona === "string" ? body.persona : undefined,
        role: typeof body.role === "string" ? body.role : undefined,
        capabilities: Array.isArray(body.capabilities) ? body.capabilities.filter((c: unknown) => typeof c === "string") : undefined,
        defaultModel: typeof body.defaultModel === "string" ? body.defaultModel : undefined,
        // "" or null: reports to the operator directly.
        reportsTo: body.reportsTo === null || body.reportsTo === "" ? null : typeof body.reportsTo === "string" ? body.reportsTo : undefined,
      }).catch((err: unknown) => err as Error);
      if (updated instanceof Error) {
        sendJson(res, 400, { error: updated.message });
        return;
      }
      if (!updated) {
        sendJson(res, 404, { error: `no such agent: ${segments[1]}` });
        return;
      }
      sendJson(res, 200, updated);
      return;
    }
  }

  // ---- Configured hooks — read-only visibility into what's actually
  // loaded (configured-hooks.ts). No write endpoint: hooks.ts's registry
  // has no removal-by-source mechanism, so there's nothing to safely
  // hot-swap — editing hooks.json and restarting the gateway (or asking
  // the Engineer agent to edit the file, since it already has real
  // file-tool access) is the honest contract. ----
  if (segments[0] === "hooks" && method === "GET" && segments.length === 1) {
    sendJson(res, 200, { hooks: deps.configuredHooks ?? [] });
    return;
  }

  // ---- File revisions — per-file undo for read_file/edit_file/write_file
  // mutations (file-revisions.ts). ROADMAP.md's "checkpoint / rewind"
  // item, scoped down honestly: this undoes ONE file's mutations, not a
  // full conversation+files rewind to an arbitrary point in time. A
  // restore is a human-triggered action (this is an HTTP route, not a
  // model tool call) — still checked against the gateway's own
  // sandboxPolicy when one is configured, so a restore can't write
  // outside the same workspace the file tools themselves are confined
  // to. ----
  if (segments[0] === "files" && segments[1] === "revisions") {
    if (method === "GET" && segments.length === 2) {
      const revisions = await listFileRevisions(url.searchParams.get("path") ?? undefined);
      sendJson(res, 200, { revisions });
      return;
    }
    if (method === "POST" && segments.length === 4 && segments[3] === "restore") {
      const revision = await getFileRevision(segments[2]!);
      if (!revision) {
        sendJson(res, 404, { error: `no such file revision: ${segments[2]}` });
        return;
      }
      if (deps.sandboxPolicy) {
        const check = checkPathSandbox(deps.sandboxPolicy, revision.path);
        if (!check.allowed) {
          sendJson(res, 403, { error: `sandbox rejected restore: ${check.reason}` });
          return;
        }
      }
      try {
        await restoreFileRevision(segments[2]!);
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
  }

  // ---- Skills — agentskills.io-format instructions (skills.ts), human-
  // managed: a settings UI writes these, not an agent. Every agent shares
  // the SAME catalog (unlike shell/file tools, there's no execution
  // capability in a skill itself — just more context the model can
  // choose to load — so there's no equivalent of ENGINEER_AGENT_ID-style
  // restriction here). A gateway started with no `skills`/`skillsDir`
  // configured (gateway/cli.ts always configures both today, but this
  // guards the general case) reports 501 rather than crashing. ----
  if (segments[0] === "skills") {
    if (method === "GET" && segments.length === 1) {
      if (!deps.skills) {
        sendJson(res, 200, { skills: [] });
        return;
      }
      sendJson(res, 200, { skills: deps.skills.listMetadata() });
      return;
    }
    if (method === "GET" && segments.length === 2) {
      const skill = deps.skills?.get(segments[1]!);
      if (!skill) {
        sendJson(res, 404, { error: `no such skill: ${segments[1]}` });
        return;
      }
      sendJson(res, 200, skill);
      return;
    }
    if (method === "POST" && segments.length === 1) {
      if (!deps.skills || !deps.skillsDir) {
        sendJson(res, 501, { error: "this gateway has no skills directory configured" });
        return;
      }
      const body = await readRequestBody(req);
      if (typeof body.name !== "string" || typeof body.description !== "string" || typeof body.body !== "string") {
        sendJson(res, 400, { error: "name, description, and body (all strings) are required" });
        return;
      }
      try {
        const skill = await writeSkill(deps.skillsDir, {
          name: body.name,
          description: body.description,
          body: body.body,
          license: typeof body.license === "string" ? body.license : undefined,
          compatibility: typeof body.compatibility === "string" ? body.compatibility : undefined,
          metadata: typeof body.metadata === "object" && body.metadata !== null ? (body.metadata as Record<string, string>) : undefined,
          allowedTools: Array.isArray(body.allowedTools) ? body.allowedTools.filter((t: unknown) => typeof t === "string") : undefined,
        });
        deps.skills.add(skill);
        sendJson(res, 201, skill);
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    if (method === "DELETE" && segments.length === 2) {
      if (!deps.skills || !deps.skillsDir) {
        sendJson(res, 501, { error: "this gateway has no skills directory configured" });
        return;
      }
      await deleteSkill(deps.skillsDir, segments[1]!);
      deps.skills.remove(segments[1]!);
      sendJson(res, 200, { ok: true });
      return;
    }
    // Install a skill FROM elsewhere — ROADMAP.md's "skill marketplace /
    // install-from-elsewhere" item, scoped to the smallest useful version
    // of that: fetch a raw SKILL.md-shaped document from any URL (a
    // GitHub raw link, a gist, a shared file server — no registry
    // protocol assumed, since there isn't a standard one to assume),
    // validate it with the EXACT same parseSkillFile() a hand-authored
    // one goes through, then persist + hot-register it exactly like
    // POST /skills above. A human-triggered settings action, same trust
    // level as the rest of this route — no new gating beyond what
    // POST/DELETE /skills already have none of.
    if (method === "POST" && segments.length === 2 && segments[1] === "install") {
      if (!deps.skills || !deps.skillsDir) {
        sendJson(res, 501, { error: "this gateway has no skills directory configured" });
        return;
      }
      const body = await readRequestBody(req);
      if (typeof body.url !== "string" || !body.url) {
        sendJson(res, 400, { error: "url (string) is required" });
        return;
      }
      try {
        const fetchRes = await fetch(body.url, { signal: AbortSignal.timeout(10_000) });
        if (!fetchRes.ok) {
          sendJson(res, 400, { error: `could not fetch ${body.url}: HTTP ${fetchRes.status}` });
          return;
        }
        const raw = await fetchRes.text();
        // parseSkillFile needs a dirPath only for its own error messages
        // — there's no real directory yet until writeSkill() below
        // actually creates one, so the source URL stands in for it.
        const parsed = parseSkillFile(raw, body.url);
        const skill = await writeSkill(deps.skillsDir, parsed);
        deps.skills.add(skill);
        sendJson(res, 201, skill);
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
  }

  // ---- Agent memory — "what has this agent learned" surfaced to a
  // client (see memory.ts for the full model: fast-path episodic writes,
  // a deterministic dreaming pass that's the ONLY thing allowed to write
  // curated memory, and an agent's own bounded "nominate, human approves"
  // voice). Nested under /agents/:id/memory rather than a top-level
  // /memory to keep "whose memory" unambiguous in the URL itself. ----
  if (segments[0] === "agents" && segments.length >= 3 && segments[2] === "memory") {
    const agentId = segments[1]!;
    if (method === "GET" && segments.length === 3) {
      const [curated, episodic, passes] = await Promise.all([getCuratedMemory(agentId), listEpisodic(agentId), listDreamingPasses(agentId)]);
      const lastDreamingPass = passes.length ? passes[passes.length - 1] : undefined;
      sendJson(res, 200, { curated, episodicCount: episodic.length, lastDreamingPass });
      return;
    }
    if (method === "GET" && segments.length === 4 && segments[3] === "episodic") {
      const entries = await listEpisodic(agentId);
      sendJson(res, 200, { entries });
      return;
    }
    if (method === "GET" && segments.length === 4 && segments[3] === "dreaming-passes") {
      const passes = await listDreamingPasses(agentId);
      sendJson(res, 200, { passes });
      return;
    }
    if (method === "GET" && segments.length === 4 && segments[3] === "nominations") {
      const nominations = await listAgentMemoryNominations(agentId, {
        status: (url.searchParams.get("status") as NominationStatus | null) ?? undefined,
      });
      sendJson(res, 200, { nominations });
      return;
    }
    if (method === "POST" && segments.length === 6 && segments[3] === "nominations" && segments[5] === "approve") {
      const body = await readRequestBody(req);
      try {
        const entry = await approveAgentMemory(agentId, segments[4]!, typeof body.reviewNote === "string" ? body.reviewNote : undefined);
        sendJson(res, 200, { entry });
      } catch (err) {
        sendJson(res, 409, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    if (method === "POST" && segments.length === 6 && segments[3] === "nominations" && segments[5] === "reject") {
      const body = await readRequestBody(req);
      try {
        await rejectAgentMemory(agentId, segments[4]!, typeof body.reviewNote === "string" ? body.reviewNote : undefined);
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendJson(res, 409, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
  }

  // ---- Sessions ----
  if (segments[0] === "sessions") {
    if (method === "POST" && segments.length === 1) {
      const body = await readRequestBody(req);
      if (!body.agentId || typeof body.agentId !== "string") {
        sendJson(res, 400, { error: "agentId (string) is required" });
        return;
      }
      const focus = parseFocus(body.focus);
      if (focus === "invalid") {
        sendJson(res, 400, { error: 'focus must be {kind: "goal" | "project", id}' });
        return;
      }
      const session = await createSession({
        agentId: body.agentId,
        title: typeof body.title === "string" ? body.title : undefined,
        parentSessionId: typeof body.parentSessionId === "string" ? body.parentSessionId : undefined,
        ...(focus ? { focus } : {}),
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
    if (method === "GET" && segments.length === 3 && segments[2] === "usage") {
      const session = await getSession(segments[1]!);
      if (!session) {
        sendJson(res, 404, { error: `no such session: ${segments[1]}` });
        return;
      }
      sendJson(res, 200, await getSessionUsage(segments[1]!));
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
    // What this conversation's work serves — a BaseSpace goal or project;
    // `{focus: null}` clears it. Each turn then gets the goal chain, linked
    // notes and open todos (basespace.ts's focusContext).
    if (method === "PUT" && segments.length === 3 && segments[2] === "focus") {
      const body = await readRequestBody(req);
      const focus = body.focus === null ? null : parseFocus(body.focus);
      if (focus === "invalid" || focus === undefined) {
        sendJson(res, 400, { error: 'body must be {focus: {kind: "goal" | "project", id}} or {focus: null}' });
        return;
      }
      try {
        sendJson(res, 200, await setSessionFocus(segments[1]!, focus));
      } catch (err) {
        sendJson(res, 404, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    if (method === "POST" && segments.length === 3 && segments[2] === "rename") {
      const body = await readRequestBody(req);
      if (typeof body.title !== "string") {
        sendJson(res, 400, { error: "title (string) is required" });
        return;
      }
      try {
        const session = await renameSession(segments[1]!, body.title);
        sendJson(res, 200, session);
      } catch (err) {
        sendJson(res, 404, { error: err instanceof Error ? err.message : String(err) });
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
      // Per-agent model preference (set via POST/PUT /agents) overrides
      // the gateway-wide default when one is registered and an env var
      // still resolves a real provider — falls back to deps.model (the
      // stub, when no provider is configured at all) exactly like before
      // this existed. See models/real.ts's createModelForAgent().
      const model = (await createModelForAgent(session.agentId)) ?? deps.model;
      const result = await runTurn({
        sessionId: session.id,
        agentId: session.agentId,
        userMessage: body.userMessage,
        model,
        worker: deps.worker,
        skills: deps.skills,
        enableSubagents: deps.enableSubagents,
        enableMemoryNominations: deps.enableMemoryNominations,
        enableArtifacts: deps.enableArtifacts,
        enableBaseSpace: deps.enableBaseSpace,
        sandboxPolicy: deps.sandboxPolicy,
        maxToolHops: deps.maxToolHops,
        // Per-REQUEST, not a gateway-wide deps default like the flags
        // above — plan mode is something a client toggles per message,
        // same as a Claude Code user flipping into plan mode for one
        // turn at a time.
        planMode: body.planMode === true,
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
      // With what it was made of, when known, so the flow panel can label every step.
      sendJson(res, 200, { ...flow, definition: (await getFlowDefinition(flow.id)) ?? null });
      return;
    }
    // Everything about one flow in one answer: per step the goal, agent, attempts, result, tool calls, what it added to
    // BaseSpace and its tokens (flow-report.ts).
    if (method === "GET" && segments.length === 3 && segments[2] === "report") {
      const report = await buildFlowReport(segments[1]!);
      if (!report) {
        sendJson(res, 404, { error: `no such flow: ${segments[1]}` });
        return;
      }
      sendJson(res, 200, report);
      return;
    }
    if (method === "POST" && segments.length === 1) {
      const body = await readRequestBody(req);
      const steps = parseFlowSteps(body.steps);
      if (!steps) {
        sendJson(res, 400, { error: "steps (array of {id, agentId, goal, dependsOn?, retries?}) is required" });
        return;
      }
      const focus = parseFocus(body.focus);
      if (focus === "invalid") {
        sendJson(res, 400, { error: 'focus must be {kind: "goal" | "project", id}' });
        return;
      }
      const title = typeof body.title === "string" ? body.title.trim().slice(0, 60) : "";
      const flow = await createFlow(
        "managed",
        steps.map((s) => ({ id: s.id, dependsOn: s.dependsOn ?? [] })),
        title || undefined,
      );
      await storeFlowDefinition({ flowId: flow.id, ...(title ? { title } : {}), proposedBy: "operator", summary: title, steps });
      // What the flow serves: every step's session is focused on it.
      if (focus) await setFlowFocus(flow.id, focus);
      // Fire-and-forget: a Flow can run many real model turns across many
      // steps, potentially minutes — the HTTP response returns the
      // CREATED Flow immediately (201) rather than blocking on the whole
      // DAG. A client watches progress via GET /events
      // (flow.step.started/flow.step.completed/flow.completed) or polls
      // GET /flows/:id, same pattern POST /sessions/:id/turns documents
      // for its own "live activity is a separate concern" limitation.
      resumeFlow(flow.id, steps, {
        model: deps.model,
        worker: deps.worker,
        skills: deps.skills,
        maxToolHopsPerStep: deps.maxToolHops,
        enableSubagents: deps.enableSubagents,
        enableMemoryNominations: deps.enableMemoryNominations,
        enableArtifacts: deps.enableArtifacts,
        enableBaseSpace: deps.enableBaseSpace,
        sandboxPolicy: deps.sandboxPolicy,
      }).catch((err) => {
        console.error(`[gateway] flow ${flow.id} driving failed:`, err instanceof Error ? err.message : err);
      });
      sendJson(res, 201, flow);
      return;
    }
    if (method === "POST" && segments.length === 3 && segments[2] === "resume") {
      const flow = await getFlow(segments[1]!);
      if (!flow) {
        sendJson(res, 404, { error: `no such flow: ${segments[1]}` });
        return;
      }
      const body = await readRequestBody(req);
      const steps = parseFlowSteps(body.steps);
      if (!steps) {
        sendJson(res, 400, { error: "steps (the SAME FlowStepDefinition[] originally used to create this flow) is required to resume it" });
        return;
      }
      // The operator pressed Resume: a stopped flow (failed, or cancelled) runs its unfinished steps again.
      await reopenFlow(flow.id, { includeCancelled: true });
      resumeFlow(flow.id, steps, {
        model: deps.model,
        worker: deps.worker,
        skills: deps.skills,
        maxToolHopsPerStep: deps.maxToolHops,
        enableSubagents: deps.enableSubagents,
        enableMemoryNominations: deps.enableMemoryNominations,
        enableArtifacts: deps.enableArtifacts,
        enableBaseSpace: deps.enableBaseSpace,
        sandboxPolicy: deps.sandboxPolicy,
      }).catch((err) => {
        console.error(`[gateway] flow ${flow.id} resume failed:`, err instanceof Error ? err.message : err);
      });
      sendJson(res, 202, flow);
      return;
    }
    // The operator accepts a stopped step as done and the flow carries on from there.
    if (method === "POST" && segments.length === 5 && segments[2] === "steps" && segments[4] === "done") {
      const flow = await getFlow(segments[1]!);
      if (!flow) {
        sendJson(res, 404, { error: `no such flow: ${segments[1]}` });
        return;
      }
      const body = await readRequestBody(req);
      const steps = parseFlowSteps(body.steps);
      if (!steps) {
        sendJson(res, 400, { error: "steps (the flow's step definitions) are required" });
        return;
      }
      try {
        const stepId = decodeURIComponent(segments[3]!);
        const current = flow.steps.find((s) => s.id === stepId);
        if (!current) throw new Error(`no step "${stepId}" in flow ${flow.id}`);
        if (current.status === "succeeded") throw new Error(`step "${stepId}" already succeeded`);
        if (current.status === "running") throw new Error(`step "${stepId}" is still running`);
        markStepDone(flow.id, stepId, steps, {
          model: deps.model,
          worker: deps.worker,
          skills: deps.skills,
          maxToolHopsPerStep: deps.maxToolHops,
          enableSubagents: deps.enableSubagents,
          enableMemoryNominations: deps.enableMemoryNominations,
          enableArtifacts: deps.enableArtifacts,
          enableBaseSpace: deps.enableBaseSpace,
          sandboxPolicy: deps.sandboxPolicy,
        }).catch((err) => console.error(`[gateway] flow ${flow.id} mark-done failed:`, err instanceof Error ? err.message : err));
        sendJson(res, 202, flow);
      } catch (err) {
        sendJson(res, 409, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    if (method === "POST" && segments.length === 3 && segments[2] === "cancel") {
      const body = await readRequestBody(req);
      try {
        const flow = await cancelFlow(segments[1]!, typeof body.reason === "string" ? body.reason : undefined);
        sendJson(res, 200, flow);
      } catch (err) {
        sendJson(res, 409, { error: err instanceof Error ? err.message : String(err) });
      }
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
        // {always: "tool"} also allowlists every call of this tool for the
        // agent, {always: "exact"} just this exact call — added before the
        // approval so an unsafe "always" fails without approving anything.
        if (segments[2] === "approve" && (body.always === "tool" || body.always === "exact")) {
          const pending = await getApproval(segments[1]!);
          if (!pending) throw new Error(`no such approval request: ${segments[1]}`);
          await addAllowRule({
            agentId: pending.agentId,
            toolName: pending.toolName,
            args: body.always === "exact" ? pending.args : undefined,
            note: `from approval ${pending.id}`,
            createdBy: extra.resolvedBy,
          });
        }
        const resolved =
          segments[2] === "approve" ? await approveRequest(segments[1]!, extra) : await rejectRequest(segments[1]!, extra);
        sendJson(res, 200, resolved);
        // Resume the conversation that was waiting on this — approving in
        // the Approvals tab shouldn't also require typing "go ahead".
        // Opt out per request with {"resume": false}.
        if (body.resume !== false) void resumeAfterDecision(deps, resolved);
      } catch (err) {
        sendJson(res, 409, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
  }

  // ---- Allowlist (allowlist.ts) — per-agent "always allow" rules ----
  if (segments[0] === "allowlist") {
    if (method === "GET" && segments.length === 1) {
      sendJson(res, 200, { rules: await listAllowRules(url.searchParams.get("agentId") ?? undefined), exactOnlyTools: EXACT_ONLY_TOOLS });
      return;
    }
    if (method === "POST" && segments.length === 1) {
      const body = await readRequestBody(req);
      if (typeof body.agentId !== "string" || typeof body.toolName !== "string") {
        sendJson(res, 400, { error: "agentId and toolName are required" });
        return;
      }
      try {
        const rule = await addAllowRule({
          agentId: body.agentId,
          toolName: body.toolName,
          args: body.args && typeof body.args === "object" ? (body.args as Record<string, unknown>) : undefined,
          note: typeof body.note === "string" ? body.note : undefined,
          createdBy: typeof body.createdBy === "string" ? body.createdBy : undefined,
        });
        sendJson(res, 201, rule);
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    if (method === "DELETE" && segments.length === 2) {
      const removed = await removeAllowRule(segments[1]!);
      sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: "no such rule" });
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
