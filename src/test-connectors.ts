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
import { dispatchConnector, setConnectorRelay, usableConnectors, connectorGrants, connectorGrantsFor, listConnectors, parseMcpList, refreshConnectors, setConnectorDiscovery, setConnectorEnabled, toolPrefix, createStubModel, createStubWorker } from "./core/index.js";
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

// --- 3b. what a model's own calls carry ----------------------------------------------------------------
// Connector tool definitions cost ~10k tokens on every call, so by default an agent's own calls carry none of them: it
// reaches connectors through the `connector` tool (connector-tool.ts), which pays that only when one is used.
const sonnet = connectorGrantsFor("sonnet");
const haiku = connectorGrantsFor("haiku");
assert(sonnet.allow.length === 0 && sonnet.deny.includes("mcp__claude_ai_BeatStars") && sonnet.deny.includes("mcp__discord"), "by default no connector is loaded into an agent's own calls, on Sonnet or Haiku (every one is withheld)");
assert(haiku.allow.length === 0 && connectorGrantsFor(undefined).allow.length === 0, "…and with no model named either");
process.env.AGENT_OS_CONNECTORS_NATIVE = "1";
assert(connectorGrantsFor("sonnet").allow.length === connectorGrants().allow.length && connectorGrantsFor("haiku").allow.length === 0, "AGENT_OS_CONNECTORS_NATIVE=1 brings the old behaviour back: granted natively to Sonnet, still not to Haiku");
process.env.AGENT_OS_CONNECTORS_SMALL = "1";
assert(connectorGrantsFor("haiku").allow.length === connectorGrants().allow.length, "…and AGENT_OS_CONNECTORS_SMALL=1 grants them to Haiku too");
delete process.env.AGENT_OS_CONNECTORS_SMALL;
delete process.env.AGENT_OS_CONNECTORS_NATIVE;

// --- 3c. the connector tool ------------------------------------------------------------------------------
const relayed: { system: string; request: string; grants: { allow: string[]; deny: string[] } }[] = [];
setConnectorRelay(async (system, request, grants) => {
  relayed.push({ system, request, grants });
  return request.includes("boom") ? Promise.reject(new Error("service down")) : request.includes("nothing") ? "  " : `result for: ${request}`;
});
await setConnectorEnabled("claude.ai Claude Docs", true);
await setConnectorEnabled("discord", false);
await setConnectorEnabled("claude.ai Anthropic Economic Index", false);
const listed = await dispatchConnector({ action: "list" });
assert(listed.ok && /BeatStars/.test(listed.output) && /Claude Docs/.test(listed.output) && !/discord|Gmail|broken/i.test(listed.output), "list shows the usable connectors by short name (not the off, unauthenticated or failed ones)");
const asked = await dispatchConnector({ action: "ask", connector: "BeatStars", request: "search beats: trap" });
assert(asked.ok && asked.output === "result for: search beats: trap", "ask relays the request and returns the answer");
const g0 = relayed[0]!.grants;
assert(g0.allow.length === 1 && g0.allow[0] === "mcp__claude_ai_BeatStars" && g0.deny.includes("mcp__claude_ai_Claude_Docs") && g0.deny.includes("mcp__discord") && !g0.deny.includes("mcp__claude_ai_BeatStars"), "…with ONLY that connector granted and every other one withheld");
assert(/BeatStars/.test(relayed[0]!.system) && /nothing invented/.test(relayed[0]!.system), "…and a relay prompt that says to report only what the service returned");
assert((await dispatchConnector({ action: "ask", connector: "claude.ai Claude Docs", request: "x" })).ok, "the full name works too");
const unknown = await dispatchConnector({ action: "ask", connector: "Gmail", request: "x" });
assert(!unknown.ok && /Available: (BeatStars, Claude Docs|Claude Docs, BeatStars)/.test(unknown.error ?? "") && relayed.length === 2, "an unknown or unusable connector is refused (nothing is run) and the usable ones are named");
assert(!(await dispatchConnector({ action: "ask", connector: "discord", request: "x" })).ok && relayed.length === 2, "a connector that is switched off can not be asked");
assert(!(await dispatchConnector({ action: "ask", connector: "BeatStars", request: " " })).ok && !(await dispatchConnector({ action: "x" })).ok, "an empty request or an unknown action is refused");
const down = await dispatchConnector({ action: "ask", connector: "BeatStars", request: "boom" });
assert(!down.ok && /BeatStars: service down/.test(down.error ?? ""), "a failing service is reported with its name, not swallowed");
assert(!(await dispatchConnector({ action: "ask", connector: "BeatStars", request: "nothing" })).ok, "an empty answer is an error, not a success");
assert((await dispatchConnector({ action: "ask", connector: "BeatStars", request: "z".repeat(10) })).ok && usableConnectors().length === 2, "usableConnectors is the enabled, connected ones");
setConnectorRelay(async () => "y".repeat(9000));
const long = await dispatchConnector({ action: "ask", connector: "BeatStars", request: "big" });
assert(long.ok && long.output.length < 8200 && /\[cut: 1000 more characters\]/.test(long.output), "a very long answer is cut, and says how much");
setConnectorRelay(undefined);
await setConnectorEnabled("claude.ai Claude Docs", false);

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
