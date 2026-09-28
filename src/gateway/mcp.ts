// The OS as an MCP server (Model Context Protocol), so Claude Code — the one
// you run in BaseSpace's Terminal panel, or any other MCP client — can see
// and act in BaseSpace the way the in-OS agents do: read the dashboard,
// add notes/todos/project updates, look at the team and the approval
// queue, and hand work to an agent.
//
// Transport: MCP's "Streamable HTTP", minimal form — each JSON-RPC request
// is a POST to /mcp and gets a plain JSON response. No server-initiated
// streams (GET /mcp answers 405, which the spec allows) and no session ids,
// so there's nothing to keep in memory and no dependency to add.
//
// Deliberately NOT here: approving or rejecting approvals. That decision
// stays with the operator in the Approvals panel; a Claude session that
// could approve its own (or an agent's) outward-facing actions would make
// the queue meaningless.
//
// Same trust as the rest of the gateway (no auth, see server.ts's header):
// everything here is already reachable over its REST routes.

import type { IncomingMessage, ServerResponse } from "node:http";
import { addOverlayItem, readSnapshotSection, type OverlayKind } from "../core/basespace.js";
import { listAgentRecords } from "../core/agents.js";
import { listApprovals } from "../core/approvals.js";
import type { SessionFocus } from "../core/types.js";

/** The one thing the MCP layer needs from the gateway that isn't a plain
 *  core call: running an agent turn exactly like POST /sessions/:id/turns
 *  does (same model routing, tools, sandbox, approvals). */
export interface McpDeps {
  askAgent(agentId: string, message: string, sessionId?: string, focus?: SessionFocus): Promise<{ sessionId: string; reply: string; toolCalled?: string }>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, any>;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  run(args: Record<string, any>, deps: McpDeps): Promise<string>;
}

/** Who added an overlay item through MCP — shows in BaseSpace next to it. */
const MCP_AUTHOR = "claude-code";

const TOOLS: McpTool[] = [
  {
    name: "basespace_read",
    description:
      "Read the operator's BaseSpace dashboard (the snapshot BaseSpace syncs to Agent-OS). section = summary | goals | notes | projects | todos | events | crons | teams. Goals are what the work is for; a goal or project read by id comes with its goal chain, linked notes and open todos. " +
      "Use query to filter by text; use id to get one item in full (notes are listed without their text until asked for by id).",
    inputSchema: {
      type: "object",
      properties: {
        section: { type: "string", enum: ["summary", "goals", "notes", "projects", "todos", "events", "crons", "teams"] },
        query: { type: "string", description: "Only items containing this text." },
        id: { type: "string", description: "Return this one item in full." },
      },
      required: ["section"],
    },
    async run(args) {
      const r = await readSnapshotSection(String(args.section ?? "summary"), {
        query: typeof args.query === "string" ? args.query : undefined,
        id: typeof args.id === "string" ? args.id : undefined,
      });
      if (!r.ok) throw new Error(r.error ?? "could not read BaseSpace");
      return r.output;
    },
  },
  {
    name: "basespace_add",
    description:
      "Add to the operator's BaseSpace: kind = note {title, body, folder?} | todo {title, due? YYYY-MM-DD, time? HH:MM, priority? high|med|low, notes?} | " +
      "project-update {projectId, text}. Internal to their own dashboard; anything outward-facing (posts, uploads, emails) goes through Agent-OS approvals instead.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["note", "todo", "project-update"] },
        title: { type: "string" },
        body: { type: "string", description: "Note text (markdown)." },
        folder: { type: "string", description: "Note folder, e.g. Team/Meetings." },
        due: { type: "string", description: "Todo due date, YYYY-MM-DD." },
        time: { type: "string", description: "Todo time, HH:MM." },
        priority: { type: "string", enum: ["high", "med", "low"] },
        notes: { type: "string", description: "Todo details." },
        projectId: { type: "string", description: "Project id (see basespace_read section=projects): required for project-update; for a note or todo, links it to that project." },
        goalId: { type: "string", description: "Links a note or todo to this goal (see basespace_read section=goals)." },
        text: { type: "string", description: "The project update." },
      },
      required: ["kind"],
    },
    async run(args) {
      // No session here, so an explicit goalId/projectId plays the part of
      // a focus: the note or todo links back to it.
      const focus = typeof args.goalId === "string" && args.goalId ? { kind: "goal" as const, id: args.goalId }
        : typeof args.projectId === "string" && args.projectId && args.kind !== "project-update" ? { kind: "project" as const, id: args.projectId }
        : undefined;
      const r = await addOverlayItem(String(args.kind) as OverlayKind, args, MCP_AUTHOR, focus);
      if (!r.ok) throw new Error(r.error ?? "could not add to BaseSpace");
      return r.output;
    },
  },
  {
    name: "list_agents",
    description: "The ISΛRK agent team in Agent-OS: id, name, role, capabilities, model and whether each is active right now.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const agents = await listAgentRecords();
      return agents
        .map((a) => `- ${a.id} — ${a.name}${a.role ? ` (${a.role})` : ""}; ${a.status}; model ${a.defaultModel ?? "gateway default"}${a.capabilities.length ? `; ${a.capabilities.join(", ")}` : ""}`)
        .join("\n") || "No agents registered.";
    },
  },
  {
    name: "ask_agent",
    description:
      "Send a message to one of the Agent-OS agents and get its reply — the same as chatting with it in BaseSpace's Workbench, so its own tools, memory and approvals apply. " +
      "Pass sessionId from an earlier reply to continue that conversation. Slow on local models.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Agent id, from list_agents." },
        message: { type: "string" },
        sessionId: { type: "string", description: "Continue this conversation instead of starting a new one." },
        goalId: { type: "string", description: "For a new conversation: the goal it serves — the agent gets the goal chain, linked notes and open todos." },
        projectId: { type: "string", description: "For a new conversation: the project it serves (same as goalId, for a project)." },
      },
      required: ["agentId", "message"],
    },
    async run(args, deps) {
      const agentId = String(args.agentId ?? "");
      const message = String(args.message ?? "");
      if (!agentId || !message) throw new Error("agentId and message are required");
      const focus = typeof args.goalId === "string" && args.goalId ? { kind: "goal" as const, id: args.goalId }
        : typeof args.projectId === "string" && args.projectId ? { kind: "project" as const, id: args.projectId }
        : undefined;
      const r = await deps.askAgent(agentId, message, typeof args.sessionId === "string" ? args.sessionId : undefined, focus);
      return `${r.reply || "(no reply)"}\n\n[sessionId: ${r.sessionId}${r.toolCalled ? `; used tool: ${r.toolCalled}` : ""}]`;
    },
  },
  {
    name: "list_approvals",
    description:
      "The approval queue: actions agents asked to take that need the operator's sign-off. Read-only — the operator approves or rejects in BaseSpace's Approvals panel.",
    inputSchema: {
      type: "object",
      properties: { status: { type: "string", enum: ["pending", "approved", "rejected"], description: "Default: pending." } },
    },
    async run(args) {
      const status = ["pending", "approved", "rejected"].includes(args.status) ? args.status : "pending";
      const list = await listApprovals({ status });
      if (!list.length) return `No ${status} approvals.`;
      return list
        .map((a) => `- ${a.id} · ${a.agentId} wants ${a.toolName} ${JSON.stringify(a.args).slice(0, 200)} — ${a.reason} (${a.requestedAt})`)
        .join("\n");
    },
  },
];

const SERVER_INFO = { name: "agent-os", version: "0.0.1" };
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

const INSTRUCTIONS =
  "Agent-OS is ISΛRK's personal OS: BaseSpace (the dashboard: notes, projects, todos, calendar, crons, teams) and an agent team. " +
  "Use basespace_read before assuming what's there, basespace_add for internal notes/todos/project updates, and ask_agent to hand work to the right agent. " +
  "Outward-facing actions go through approvals, which only the operator can decide. Agents can't hear audio; don't invent metrics.";

async function handleRpc(msg: JsonRpcRequest, deps: McpDeps): Promise<Record<string, unknown> | undefined> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });

  // Notifications (no id) get no response.
  if (msg.id === undefined || msg.id === null) return undefined;

  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return fail(-32602, `unknown tool: ${msg.params?.name}`);
      try {
        const text = await tool.run((msg.params?.arguments as Record<string, any>) ?? {}, deps);
        return reply({ content: [{ type: "text", text }] });
      } catch (err) {
        // Tool failures are results the model can read, not protocol errors.
        return reply({ content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true });
      }
    }
    default:
      return fail(-32601, `method not found: ${msg.method}`);
  }
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, body: unknown, deps: McpDeps): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" });
    res.end();
    return;
  }
  const messages = Array.isArray(body) ? body : [body];
  const valid = messages.filter((m): m is JsonRpcRequest => !!m && typeof m === "object" && typeof (m as JsonRpcRequest).method === "string");
  if (!valid.length) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid JSON-RPC request" } }));
    return;
  }
  const responses = (await Promise.all(valid.map((m) => handleRpc(m, deps)))).filter(Boolean);
  if (!responses.length) {
    res.writeHead(202);
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(Array.isArray(body) ? responses : responses[0]));
}

export function listMcpToolNames(): string[] {
  return TOOLS.map((t) => t.name);
}
