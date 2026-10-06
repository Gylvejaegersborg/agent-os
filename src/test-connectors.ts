// Tests for the connectors the agents can reach through the Claude CLI (core/connectors.ts).
// Proves:
//   1. `claude mcp list` output is parsed: account connectors vs local servers, connected / needs auth / failed.
//   2. Defaults: account connectors on, local servers (discord, telegram) off. The operator's choice is
//      remembered, and survives a refresh.
//   3. The grants handed to the CLI: enabled+connected are allowed, everything else is withheld, and a
//      connector that was never discovered is allowed nothing.
//   4. The list follows the account: a connector added later appears on the next discovery, one removed disappears.
//   5. The routes list, refresh and toggle, and refuse an unknown connector.
// Run with: node dist/test-connectors.js

import "./test-helpers/isolate.js";
import { connectorGrants, connectorGrantsFor, listConnectors, parseMcpList, refreshConnectors, setConnectorDiscovery, setConnectorEnabled, toolPrefix, createStubModel, createStubWorker } from "./core/index.js";
import { startGateway } from "./gateway/server.js";

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`ok: ${msg}`);
  else {
    failed = true;
    console.log(`FAIL: ${msg}`);
  }
}

const SAMPLE = `Checking MCP server health…

claude.ai Claude Docs: https://api.anthropic.com/v1/pages/mcp - ✔ Connected
claude.ai BeatStars: https://mcp.beatstars.com/mcp - ✔ Connected
claude.ai Anthropic Economic Index: https://econ-index.mcp.claude.com/mcp - ✔ Connected
claude.ai Gmail: https://gmail.mcp.claude.com/mcp - ⚠ Needs authentication
discord: node C:\\Users\\Gylve\\mcp-servers\\discordmcp\\build\\index.js - ✔ Connected
telegram: npx -y telegram-notifier-mcp - ✔ Connected
broken: node nope.js - ✗ Failed to connect
`;

// --- 1. parsing ----------------------------------------------------------------------------
const parsed = parseMcpList(SAMPLE);
assert(parsed.length === 7 && !parsed.some((c) => /checking/i.test(c.name)), "seven servers parsed; the health-check banner isn't one of them");
const by = new Map(parsed.map((c) => [c.name, c]));
assert(by.get("claude.ai BeatStars")!.kind === "account" && by.get("discord")!.kind === "local" && by.get("telegram")!.kind === "local", "account connectors and local servers are told apart");
assert(by.get("claude.ai Gmail")!.status === "needs-auth" && by.get("broken")!.status === "failed" && by.get("discord")!.status === "connected", "connected, needs-auth and failed are told apart");
assert(by.get("discord")!.target.startsWith("node C:") && by.get("claude.ai BeatStars")!.target === "https://mcp.beatstars.com/mcp", "the target is kept (a path with a colon doesn't confuse it)");
assert(toolPrefix("claude.ai BeatStars") === "mcp__claude_ai_BeatStars" && toolPrefix("discord") === "mcp__discord" && toolPrefix("claude.ai Anthropic Economic Index") === "mcp__claude_ai_Anthropic_Economic_Index", "tool prefixes match how the CLI names them");
assert(parseMcpList("").length === 0 && parseMcpList("garbage\nmore garbage").length === 0, "empty or unexpected output gives no connectors, not a crash");

// --- 2/3. defaults and grants ------------------------------------------------------------------
let current = SAMPLE;
setConnectorDiscovery(async () => current);
assert(connectorGrants().allow.length === 0 && connectorGrants().deny.length === 0, "before the first discovery nothing is granted (and nothing is known)");
await refreshConnectors();
const list = listConnectors().connectors;
const on = (n: string) => list.find((c) => c.name === n)?.enabled;
assert(on("claude.ai BeatStars") === true && on("claude.ai Claude Docs") === true && on("discord") === false && on("telegram") === false, "account connectors default to on, local servers (discord, telegram) to off");
let g = connectorGrants();
assert(g.allow.includes("mcp__claude_ai_BeatStars") && g.allow.includes("mcp__claude_ai_Claude_Docs") && !g.allow.includes("mcp__discord") && g.deny.includes("mcp__discord") && g.deny.includes("mcp__telegram"), "enabled connectors are granted; discord and telegram are withheld");
assert(!g.allow.includes("mcp__claude_ai_Gmail") && g.deny.includes("mcp__claude_ai_Gmail") && !g.allow.includes("mcp__broken"), "a connector that needs auth or failed is never granted, even if enabled");

await setConnectorEnabled("claude.ai Claude Docs", false);
await setConnectorEnabled("discord", true);
g = connectorGrants();
assert(!g.allow.includes("mcp__claude_ai_Claude_Docs") && g.deny.includes("mcp__claude_ai_Claude_Docs") && g.allow.includes("mcp__discord"), "the operator's choices apply: Docs off, Discord on");
await refreshConnectors();
assert(listConnectors().connectors.find((c) => c.name === "discord")!.enabled === true && listConnectors().connectors.find((c) => c.name === "claude.ai Claude Docs")!.enabled === false, "…and survive a refresh (they're remembered)");
assert(await setConnectorEnabled("nope", true).then(() => false, () => true), "an unknown connector can't be toggled");

// --- 3b. small models --------------------------------------------------------------------------------
const sonnet = connectorGrantsFor("sonnet");
const haiku = connectorGrantsFor("haiku");
assert(sonnet.allow.includes("mcp__claude_ai_BeatStars") === connectorGrants().allow.includes("mcp__claude_ai_BeatStars") && sonnet.allow.length === connectorGrants().allow.length, "an agent on Sonnet gets the enabled connectors");
assert(haiku.allow.length === 0 && haiku.deny.includes("mcp__claude_ai_BeatStars") && haiku.deny.includes("mcp__discord"), "an agent on Haiku gets none (measured: it can't reliably use two kinds of tools at once), and every one is withheld");
assert(connectorGrantsFor(undefined).allow.length === connectorGrants().allow.length, "no model named: the normal grants");
process.env.AGENT_OS_CONNECTORS_SMALL = "1";
assert(connectorGrantsFor("haiku").allow.length === connectorGrants().allow.length, "AGENT_OS_CONNECTORS_SMALL=1 grants them to Haiku anyway");
delete process.env.AGENT_OS_CONNECTORS_SMALL;

// --- 4. following the account --------------------------------------------------------------------
current = SAMPLE + "claude.ai Notion: https://mcp.notion.com/mcp - ✔ Connected\n";
const beforeRefresh = connectorGrants();
assert(!beforeRefresh.allow.includes("mcp__claude_ai_Notion") && !beforeRefresh.deny.includes("mcp__claude_ai_Notion"), "a connector added to the account isn't granted until it has been discovered");
await refreshConnectors();
assert(listConnectors().connectors.some((c) => c.name === "claude.ai Notion" && c.enabled) && connectorGrants().allow.includes("mcp__claude_ai_Notion"), "…then it appears with the account default (on) after the next discovery");
current = SAMPLE.replace(/claude\.ai Anthropic Economic Index.*\n/, "");
await refreshConnectors();
assert(!listConnectors().connectors.some((c) => /Economic/.test(c.name)) && !connectorGrants().allow.some((p) => /Economic/.test(p)), "a connector removed from the account disappears");

// --- 5. routes -----------------------------------------------------------------------------------------
current = SAMPLE;
const gateway = await startGateway({ model: createStubModel(), worker: createStubWorker() });
const base = `http://127.0.0.1:${gateway.port}`;
const api = (method: string, route: string, body?: unknown) => fetch(`${base}${route}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
try {
  const got = (await (await api("GET", "/connectors?refresh=1")).json()) as any;
  assert(got.connectors.length === 7 && got.refreshedAt && got.connectors.every((c: any) => "enabled" in c && c.toolPrefix), "GET /connectors?refresh=1 re-reads the account and lists them with their state");
  const put = await api("PUT", `/connectors/${encodeURIComponent("claude.ai BeatStars")}`, { enabled: false });
  assert(put.status === 200 && ((await put.json()) as any).enabled === false && connectorGrants().deny.includes("mcp__claude_ai_BeatStars"), "PUT /connectors/:name switches one off, and the grants follow");
  assert((await api("PUT", "/connectors/ghost", { enabled: true })).status === 404, "an unknown connector is a 404");
} finally {
  await gateway.stop();
  setConnectorDiscovery(undefined);
}

console.log(failed ? "\nSome connector tests FAILED." : "\nAll connector tests passed.");
process.exit(failed ? 1 : 0);
