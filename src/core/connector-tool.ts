// The `connector` tool: how an agent uses the operator's connected services (BeatStars, Claude Docs, ...).
//
// Before this, the enabled connectors were granted natively to every model call of a Sonnet agent, which put ~10k tokens of
// connector tool definitions into EVERY call (and Haiku couldn't use them at all). Now the agent's own calls carry none of
// that. When it needs a connector it calls this tool, which makes ONE short, separate Claude CLI call with only that
// connector granted and everything else withheld, and hands the answer back. So:
//   - the ~10k tokens are paid when a connector is actually used, not on every step of every run;
//   - every use is an ordinary Agent-OS tool call: it is in the event log, in the flow report, and can be refused by
//     the permission layer like any other tool (a native connector call was invisible to all of that);
//   - a Haiku agent can use connectors too.
// What it cannot do: it can't tell a read from a write inside the connector. Which connectors exist, and which are on, is
// still the operator's choice (connectors.ts).

import { createClaudeCliModel } from "./models/claude-cli.js";
import { listConnectors, toolPrefix, type Connector } from "./connectors.js";

const MAX_OUTPUT = 8000;

const RELAY_PROMPT =
  "You are a relay to ONE connected service. Use only that service's tools to do exactly what is asked, then answer with what it returned: " +
  "the facts as returned, shortened if long, nothing invented and no guesses. If the service cannot do it, or returns an error, say so plainly. " +
  "Do not do anything beyond the request.";

/** The connectors an agent may use now: enabled and connected. */
export function usableConnectors(): Connector[] {
  return listConnectors().connectors.filter((c) => c.enabled && c.status === "connected");
}

const shortName = (c: Connector) => c.name.replace(/^claude\.ai\s+/i, "");

function findConnector(name: string): Connector | undefined {
  const want = name.trim().toLowerCase();
  if (!want) return undefined;
  return usableConnectors().find((c) => c.name.toLowerCase() === want || shortName(c).toLowerCase() === want);
}

const defaultRelay: Relay = async (system, request, grants, signal) => {
  const model = createClaudeCliModel({ model: process.env.AGENT_OS_CONNECTOR_MODEL ?? "sonnet", grants, noToolProtocol: true, timeoutMs: 120_000 });
  const reply = await model.complete([{ role: "system", content: system }, { role: "user", content: request }], signal ? { signal } : undefined);
  return reply.content;
};
/** Swappable so tests don't need the real CLI. */
type Relay = (system: string, request: string, grants: { allow: string[]; deny: string[] }, signal?: AbortSignal) => Promise<string>;
let relay: Relay = defaultRelay;
export function setConnectorRelay(fn: Relay | undefined): void {
  relay = fn ?? defaultRelay;
}

export interface ConnectorToolResult {
  ok: boolean;
  output: string;
  error?: string;
}

/** What the `connector` tool does: action list | ask. */
export async function dispatchConnector(args: Record<string, unknown>, signal?: AbortSignal): Promise<ConnectorToolResult> {
  const action = String(args.action ?? "");
  const usable = usableConnectors();
  if (action === "list") {
    if (!usable.length) return { ok: true, output: "No connectors are available right now (none enabled and connected)." };
    return { ok: true, output: `Connectors you can ask:\n${usable.map((c) => `- ${shortName(c)}`).join("\n")}` };
  }
  if (action !== "ask") return { ok: false, output: "", error: 'action must be "list" or "ask"' };

  const request = typeof args.request === "string" ? args.request.trim() : "";
  if (!request) return { ok: false, output: "", error: "ask needs a request: say exactly what you want back" };
  const connector = findConnector(String(args.connector ?? ""));
  if (!connector) {
    return { ok: false, output: "", error: `no usable connector called "${String(args.connector ?? "")}". ${usable.length ? `Available: ${usable.map(shortName).join(", ")}.` : "None are enabled and connected."}` };
  }

  // Only this connector's tools are granted; every other one is withheld.
  const all = listConnectors().connectors;
  const grants = { allow: [toolPrefix(connector.name)], deny: all.filter((c) => c.name !== connector.name).map((c) => toolPrefix(c.name)) };
  try {
    const text = (await relay(RELAY_PROMPT + `\nThe service is "${shortName(connector)}".`, request, grants, signal)).trim();
    if (!text) return { ok: false, output: "", error: `${shortName(connector)} returned nothing` };
    return { ok: true, output: text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n[cut: ${text.length - MAX_OUTPUT} more characters]` : text };
  } catch (err) {
    return { ok: false, output: "", error: `${shortName(connector)}: ${err instanceof Error ? err.message : String(err)}` };
  }
}
