// Tests for the gateway's MCP endpoint (gateway/mcp.ts) through real HTTP,
// speaking JSON-RPC the way an MCP client (Claude Code) does. Proves:
//   1. initialize / tools/list / ping follow the protocol; notifications get
//      202 with no body; unknown methods get a JSON-RPC error; GET is 405.
//   2. basespace_read reads the synced snapshot; basespace_add lands in the
//      overlay BaseSpace reads back.
//   3. list_agents and list_approvals reflect the registry and the queue,
//      and there is no tool that decides approvals.
//   4. ask_agent runs a real agent turn, and sessionId continues it.
//   5. A tool failure comes back as an isError result, not a protocol error.
//   6. A Claude Code terminal session is started with this gateway's /mcp.
// Run with: node dist/test-mcp.js

import "./test-helpers/isolate.js";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startGateway } from "./gateway/server.js";
import { closeAllTerminals } from "./gateway/terminal.js";
import { createStubModel, createStubWorker, loadOverlay, registerAgent, requestApproval, saveSnapshot } from "./core/index.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

let nextId = 1;
async function rpc(base: string, method: string, params?: unknown): Promise<any> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, ...(params ? { params } : {}) }),
  });
  return res.json();
}
const call = async (base: string, name: string, args: Record<string, unknown> = {}) => (await rpc(base, "tools/call", { name, arguments: args })).result;
const text = (result: any): string => result?.content?.[0]?.text ?? "";

async function main(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  await saveSnapshot({
    schema: 1,
    exportedAt: new Date().toISOString(),
    notes: [{ id: "n1", title: "Mixing checklist", folder: "Music", tags: [], updated: today, body: "- gain stage" }],
    projects: [{ id: "p1", name: "Switch release", status: "active", progress: 60, tags: [], props: {}, nextMoves: [], recent: [] }],
    todos: [],
    events: [],
    crons: [],
  });
  await registerAgent({ id: "hemera", name: "Hemera", persona: "You are Hemera.", role: "Manager" });
  await requestApproval({ agentId: "hemera", sessionId: "s-x", toolName: "shell", args: { command: "rm -rf build" }, reason: "mutating shell command" });

  process.env.AGENT_OS_TERMINAL = "1";
  const gateway = await startGateway({ model: createStubModel(), worker: createStubWorker(), enableBaseSpace: true });
  const base = `http://127.0.0.1:${gateway.port}`;
  try {
    const init = await rpc(base, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert(init.result?.protocolVersion === "2025-06-18" && !!init.result?.capabilities?.tools && init.result?.serverInfo?.name === "agent-os", "initialize answers with version, tools capability and server info");

    const note = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    assert(note.status === 202 && (await note.text()) === "", "a notification gets 202 and no body");
    assert((await fetch(`${base}/mcp`)).status === 405, "GET /mcp is 405 (no server-initiated stream)");
    assert((await rpc(base, "ping")).result !== undefined, "ping answers");
    assert((await rpc(base, "no/such")).error?.code === -32601, "an unknown method is a JSON-RPC error");

    const tools = ((await rpc(base, "tools/list")).result?.tools ?? []).map((t: { name: string }) => t.name);
    assert(["basespace_read", "basespace_add", "list_agents", "ask_agent", "list_approvals"].every((n) => tools.includes(n)), `tools/list has the OS tools (${tools.join(", ")})`);
    assert(!tools.some((n: string) => /approve|reject|decide/.test(n)), "no tool can decide an approval");

    assert(text(await call(base, "basespace_read", { section: "projects" })).includes("Switch release"), "basespace_read reads the snapshot");
    const added = await call(base, "basespace_add", { kind: "todo", title: "Bounce stems", priority: "high" });
    const overlay = await loadOverlay();
    assert(!added.isError && JSON.stringify(overlay).includes("Bounce stems"), "basespace_add lands in the overlay BaseSpace reads");

    assert(text(await call(base, "list_agents")).includes("hemera — Hemera (Manager)"), "list_agents lists the team");
    assert(text(await call(base, "list_approvals")).includes("rm -rf build"), "list_approvals shows the pending queue");

    const first = await call(base, "ask_agent", { agentId: "hemera", message: "hello there" });
    const sessionId = text(first).match(/sessionId: ([^;\]]+)/)?.[1];
    assert(!first.isError && !!sessionId, `ask_agent runs a turn and returns a sessionId (${text(first).slice(0, 80)})`);
    const second = await call(base, "ask_agent", { agentId: "hemera", message: "and again", sessionId });
    assert(!second.isError && text(second).includes(`sessionId: ${sessionId}`), "passing sessionId continues the same conversation");

    const bad = await call(base, "ask_agent", { agentId: "nobody", message: "hi" });
    assert(bad.isError === true && /no agent "nobody"/.test(text(bad)), "a tool failure is an isError result the model can read");

    // A Claude Code terminal is started pointing at this gateway's /mcp.
    const dir = mkdtempSync(path.join(os.tmpdir(), "mcp-term-"));
    const argsFile = path.join(dir, "args.json");
    const fake = path.join(dir, "claude");
    writeFileSync(fake, `#!/usr/bin/env node\nrequire("fs").writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\n`);
    chmodSync(fake, 0o755);
    process.env.CLAUDE_CLI_PATH = fake;
    await fetch(`${base}/terminals`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile: "claude" }) });
    await new Promise((r) => setTimeout(r, 1500));
    const args = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
    const cfg = JSON.parse(args[args.indexOf("--mcp-config") + 1] ?? "{}");
    assert(cfg.mcpServers?.["agent-os"]?.url === `${base}/mcp`, "a Claude Code terminal gets this gateway's /mcp as an MCP server");
    assert(args.includes("--append-system-prompt"), "and a line of context saying it's inside the OS");
  } finally {
    closeAllTerminals();
    await gateway.stop();
  }
  if (process.exitCode === 1) console.error("\nSome MCP tests FAILED.");
  else console.log("\nAll MCP tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
