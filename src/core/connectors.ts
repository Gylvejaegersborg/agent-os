// MCP connectors the agents can reach through the Claude CLI: the ones on the operator's Claude account
// ("claude.ai Claude Docs", "claude.ai BeatStars", ...) and any local MCP servers set up for the CLI
// (discord, telegram, ...).
//
// How it works, and what it can't do:
//   - The CLI loads them itself and runs their tools inside its own process, so a connector call is NOT
//     an Agent-OS tool call: it isn't in the event log, isn't gated by Approvals, and can't be audited here.
//     That is why the choice is explicit and per connector.
//   - In the CLI's non-interactive mode a connector tool is refused unless it is granted. So the gateway
//     grants the enabled ones (--allowedTools) and withholds the disabled ones (--disallowedTools). A
//     connector it hasn't discovered yet is granted nothing, so a newly added one waits for the next
//     discovery rather than being usable unseen.
//   - Discovery is `claude mcp list`, re-run on a timer, so the list follows the account.
//   - Defaults: account connectors on (the operator added them on purpose); local servers off (they can
//     send messages as the operator, which is outward-facing, and that normally goes through Approvals,
//     which a native call can't be). The operator flips either way in BaseSpace.

import { spawn } from "node:child_process";
import { appendEvent, readStream } from "./eventlog.js";

const STREAM = "connectors";

export interface Connector {
  name: string;
  /** "account" = added to the operator's Claude account; "local" = an MCP server configured for the CLI. */
  kind: "account" | "local";
  target: string;
  /** What `claude mcp list` says: connected, needs-auth or failed. */
  status: "connected" | "needs-auth" | "failed";
  enabled: boolean;
  /** The prefix the CLI uses for this connector's tools, e.g. mcp__claude_ai_BeatStars. */
  toolPrefix: string;
}

export const toolPrefix = (name: string) => `mcp__${name.replace(/[^A-Za-z0-9_-]/g, "_")}`;

/** Parses the output of `claude mcp list`. */
export function parseMcpList(output: string): Omit<Connector, "enabled">[] {
  const out: Omit<Connector, "enabled">[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    const sep = line.lastIndexOf(" - ");
    const colon = line.indexOf(": ");
    if (sep < 0 || colon < 0 || colon > sep) continue;
    const name = line.slice(0, colon).trim();
    const target = line.slice(colon + 2, sep).trim();
    const state = line.slice(sep + 3);
    if (!name || /^checking /i.test(name)) continue;
    out.push({
      name,
      kind: /^claude\.ai /i.test(name) ? "account" : "local",
      target,
      status: /✔|connected/i.test(state) && !/not connected/i.test(state) ? "connected" : /auth/i.test(state) ? "needs-auth" : "failed",
      toolPrefix: toolPrefix(name),
    });
  }
  return out;
}

const defaultEnabled = (kind: Connector["kind"]) => kind === "account";

function runClaudeMcpList(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.CLAUDE_CLI_PATH ?? "claude", ["mcp", "list"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("`claude mcp list` took too long"));
    }, 60_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

// ---- state ---------------------------------------------------------------------------------

let discovered: Omit<Connector, "enabled">[] = [];
let refreshedAt: string | undefined;
let explicit = new Map<string, boolean>();
let refreshing: Promise<Connector[]> | undefined;
/** Swappable so tests don't need the real CLI. */
let discover: () => Promise<string> = runClaudeMcpList;
export function setConnectorDiscovery(fn: (() => Promise<string>) | undefined): void {
  discover = fn ?? runClaudeMcpList;
}

async function loadPolicy(): Promise<void> {
  const map = new Map<string, boolean>();
  for (const e of await readStream(STREAM)) if (e.type === "connector.policy") map.set(String((e.payload as any).name), (e.payload as any).enabled === true);
  explicit = map;
}

const withEnabled = (): Connector[] => discovered.map((c) => ({ ...c, enabled: explicit.get(c.name) ?? defaultEnabled(c.kind) }));

export function listConnectors(): { connectors: Connector[]; refreshedAt?: string } {
  return { connectors: withEnabled(), ...(refreshedAt ? { refreshedAt } : {}) };
}

/** Re-reads the account's connectors (`claude mcp list`). One discovery at a time. */
export function refreshConnectors(): Promise<Connector[]> {
  refreshing ??= (async () => {
    try {
      await loadPolicy();
      discovered = parseMcpList(await discover());
      refreshedAt = new Date().toISOString();
      return withEnabled();
    } finally {
      refreshing = undefined;
    }
  })();
  return refreshing;
}

export async function setConnectorEnabled(name: string, enabled: boolean): Promise<Connector> {
  if (!discovered.some((c) => c.name === name)) throw new Error(`no connector "${name}" (refresh the list first)`);
  await appendEvent(STREAM, "connector.policy", { name, enabled });
  explicit.set(name, enabled);
  return withEnabled().find((c) => c.name === name)!;
}

/** The tool grants for the CLI: enabled, connected connectors are allowed, the rest withheld. */
export function connectorGrants(): { allow: string[]; deny: string[] } {
  const all = withEnabled();
  return {
    allow: all.filter((c) => c.enabled && c.status === "connected").map((c) => c.toolPrefix),
    deny: all.filter((c) => !c.enabled || c.status !== "connected").map((c) => c.toolPrefix),
  };
}

/** Starts discovery now and every few minutes, so the list follows the account. */
export function startConnectorSync(intervalMs = 5 * 60_000): { stop: () => void } {
  const run = () =>
    refreshConnectors().then(
      (c) => console.log(`[connectors] ${c.length} found: ${c.map((x) => `${x.name} (${x.enabled ? "on" : "off"})`).join(", ") || "none"}`),
      (e) => console.error("[connectors] discovery failed:", e instanceof Error ? e.message : e),
    );
  void run();
  const timer = setInterval(() => void run(), intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return { stop: () => clearInterval(timer) };
}
