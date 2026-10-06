// Terminals inside the OS: real interactive sessions (Claude Code, a shell)
// that BaseSpace shows in its Workbench, so you can run `claude` — with your
// own subscription login — without leaving the OS.
//
// The gateway owns the processes, not the browser: closing the panel or
// reloading the page leaves Claude running, and reopening re-attaches with
// the recent scrollback. They don't survive a gateway restart.
//
// Transport is plain HTTP like the rest of the gateway (no WebSocket
// dependency): output streams over Server-Sent Events, keystrokes arrive as
// small POSTs. BaseSpace reaches it through the same /agent-os proxy.
//
// PTY: `node-pty` (an OPTIONAL dependency — it compiles a native module)
// gives a real terminal with live resizing. Without it, the util-linux
// `script` command provides the PTY instead; everything works except live
// resizing (the size is fixed when the session starts).
//
// Off unless AGENT_OS_TERMINAL=1. The gateway has no auth (see server.ts's
// header), and a terminal is a full shell as the gateway's user — only
// enable it where the gateway is reachable by you alone (a Codespace's
// forwarded ports are private to your GitHub login by default). Note it
// doesn't widen much: anyone who can reach the gateway can already approve
// the `claude` agent's shell commands.

import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { generateId } from "../core/id.js";
import { claudeCliCommand } from "../core/models/claude-cli.js";

export type TerminalProfile = "claude" | "shell";

export interface TerminalInfo {
  id: string;
  profile: TerminalProfile;
  title: string;
  cwd: string;
  createdAt: string;
  cols: number;
  rows: number;
  exitCode?: number;
}

interface PtyLike {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number) => void): void;
}

interface TerminalSession {
  info: TerminalInfo;
  pty: PtyLike;
  /** Recent output, replayed to a client that (re)attaches. */
  scrollback: string;
  listeners: Set<(event: "data" | "exit", payload: string | number) => void>;
}

const MAX_SCROLLBACK = 256 * 1024;
const MAX_TERMINALS = 8;
const sessions = new Map<string, TerminalSession>();

/** The "Shell" profile's program: PowerShell on Windows (there is usually no `bash` on a service's PATH), else $SHELL or bash.
 *  AGENT_OS_SHELL overrides it (a path, or a command name). */
export function terminalShell(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): { file: string; args: string[] } {
  if (env.AGENT_OS_SHELL) return { file: env.AGENT_OS_SHELL, args: [] };
  if (platform === "win32") return { file: "powershell.exe", args: ["-NoLogo"] };
  return { file: env.SHELL || "bash", args: [] };
}

export function terminalsEnabled(): boolean {
  return process.env.AGENT_OS_TERMINAL === "1";
}

// ---- PTY backends ----

type NodePtyModule = {
  spawn(file: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }): {
    write(d: string): void;
    resize(c: number, r: number): void;
    kill(): void;
    onData(cb: (d: string) => void): void;
    onExit(cb: (e: { exitCode: number }) => void): void;
  };
};

let nodePty: NodePtyModule | null | undefined;
async function loadNodePty(): Promise<NodePtyModule | null> {
  if (nodePty !== undefined) return nodePty;
  // AGENT_OS_TERMINAL_BACKEND=script forces the fallback (tests, or a
  // node-pty build that misbehaves).
  if (process.env.AGENT_OS_TERMINAL_BACKEND === "script") return (nodePty = null);
  try {
    // A variable specifier keeps TypeScript from requiring the optional
    // package's types at build time.
    const name = "node-pty";
    const mod = (await import(name)) as NodePtyModule & { default?: NodePtyModule };
    nodePty = typeof mod.spawn === "function" ? mod : (mod.default ?? null);
  } catch {
    nodePty = null;
  }
  return nodePty;
}

/** Test hook — re-read AGENT_OS_TERMINAL_BACKEND on the next spawn. */
export function resetPtyBackend(): void {
  nodePty = undefined;
}

export async function ptyBackend(): Promise<"node-pty" | "script"> {
  return (await loadNodePty()) ? "node-pty" : "script";
}

function shellQuote(parts: string[]): string {
  return parts.map((p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`)).join(" ");
}

/** The `script` fallback: util-linux's `script` allocates the PTY and runs
 *  the command in it; its stdin/stdout are ordinary pipes to us. */
function spawnWithScript(file: string, args: string[], cols: number, rows: number, cwd: string, env: NodeJS.ProcessEnv): PtyLike {
  const inner = `stty cols ${cols} rows ${rows} 2>/dev/null; exec ${shellQuote([file, ...args])}`;
  const child = spawn("script", ["-qfec", inner, "/dev/null"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const dataCbs: ((d: string) => void)[] = [];
  const exitCbs: ((c: number) => void)[] = [];
  const emit = (chunk: Buffer) => dataCbs.forEach((cb) => cb(chunk.toString("utf8")));
  child.stdout.on("data", emit);
  child.stderr.on("data", emit);
  child.on("error", (err) => dataCbs.forEach((cb) => cb(`\r\n[could not start: ${err.message}]\r\n`)));
  child.on("close", (code) => exitCbs.forEach((cb) => cb(code ?? 1)));
  child.stdin.on("error", () => {});
  return {
    write: (d) => child.stdin.write(d),
    resize: () => {},
    kill: () => child.kill("SIGHUP"),
    onData: (cb) => dataCbs.push(cb),
    onExit: (cb) => exitCbs.push(cb),
  };
}

async function spawnPty(file: string, args: string[], cols: number, rows: number, cwd: string, env: NodeJS.ProcessEnv): Promise<PtyLike> {
  const pty = await loadNodePty();
  if (!pty) return spawnWithScript(file, args, cols, rows, cwd, env);
  const p = pty.spawn(file, args, { name: "xterm-256color", cols, rows, cwd, env });
  return {
    write: (d) => p.write(d),
    resize: (c, r) => p.resize(c, r),
    kill: () => p.kill(),
    onData: (cb) => p.onData(cb),
    onExit: (cb) => p.onExit((e) => cb(e.exitCode)),
  };
}

// ---- Claude Code wired into the OS ----

let gatewayUrl: string | undefined;
/** Set by startGateway() once it's listening, so Claude Code sessions can
 *  reach this gateway's /mcp (mcp.ts). */
export function setTerminalGatewayUrl(url: string): void {
  gatewayUrl = url;
}

/** Claude Code started from the OS gets the OS as MCP tools (BaseSpace,
 *  the agent team, the approval queue) and a line of context saying where
 *  it is. Its own tools, permissions and login are untouched: this is your
 *  normal Claude Code, plus the OS. */
function claudeArgs(): string[] {
  if (!gatewayUrl) return [];
  const mcpConfig = { mcpServers: { "agent-os": { type: "http", url: `${gatewayUrl}/mcp` } } };
  return [
    "--mcp-config", JSON.stringify(mcpConfig),
    "--append-system-prompt",
    "You're running inside ISΛRK's personal OS (BaseSpace + Agent-OS). The agent-os MCP tools read and add to BaseSpace " +
      "(notes, projects, todos, calendar), list the agent team and approval queue, and hand work to an agent (ask_agent). " +
      "Anything outward-facing (posts, uploads, emails) goes through Agent-OS approvals, which only the operator decides.",
  ];
}

// ---- Sessions ----

function clampSize(n: unknown, fallback: number, min: number, max: number): number {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

/** Where terminals start: BaseOStest's checkout when the gateway knows it
 *  (so Claude Code works on the OS itself), else the gateway's own dir. */
function defaultCwd(): string {
  return process.env.BASEOS_REPO_DIR || process.cwd();
}

export async function createTerminal(input: { profile?: unknown; cols?: unknown; rows?: unknown }): Promise<TerminalInfo> {
  if (sessions.size >= MAX_TERMINALS) {
    throw new Error(`at most ${MAX_TERMINALS} terminals at once — close one first`);
  }
  const profile: TerminalProfile = input.profile === "shell" ? "shell" : "claude";
  const cols = clampSize(input.cols, 100, 20, 400);
  const rows = clampSize(input.rows, 30, 5, 200);
  const cwd = defaultCwd();
  const env: NodeJS.ProcessEnv = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" };
  // ANTHROPIC_TOKEN is the gateway's own direct-API credential, not
  // something a terminal session should inherit.
  delete env.ANTHROPIC_TOKEN;

  const [file, args, title] =
    profile === "claude"
      ? [claudeCliCommand(), claudeArgs(), "Claude Code"]
      : [terminalShell().file, terminalShell().args, "Shell"];

  const info: TerminalInfo = { id: generateId(), profile, title, cwd, createdAt: new Date().toISOString(), cols, rows };
  const pty = await spawnPty(file, args, cols, rows, cwd, env);
  const session: TerminalSession = { info, pty, scrollback: "", listeners: new Set() };
  pty.onData((data) => {
    session.scrollback = (session.scrollback + data).slice(-MAX_SCROLLBACK);
    session.listeners.forEach((l) => l("data", data));
  });
  pty.onExit((code) => {
    info.exitCode = code;
    session.listeners.forEach((l) => l("exit", code));
  });
  sessions.set(info.id, session);
  return info;
}

export function listTerminals(): TerminalInfo[] {
  return [...sessions.values()].map((s) => s.info);
}

export function writeTerminal(id: string, data: string): boolean {
  const s = sessions.get(id);
  if (!s || s.info.exitCode !== undefined) return false;
  s.pty.write(data);
  return true;
}

export function resizeTerminal(id: string, cols: unknown, rows: unknown): boolean {
  const s = sessions.get(id);
  if (!s || s.info.exitCode !== undefined) return false;
  s.info.cols = clampSize(cols, s.info.cols, 20, 400);
  s.info.rows = clampSize(rows, s.info.rows, 5, 200);
  s.pty.resize(s.info.cols, s.info.rows);
  return true;
}

export function closeTerminal(id: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  if (s.info.exitCode === undefined) s.pty.kill();
  sessions.delete(id);
  return true;
}

/** Kills every terminal — for gateway shutdown and tests. */
export function closeAllTerminals(): void {
  for (const id of [...sessions.keys()]) closeTerminal(id);
}

/** SSE: `output` events carry {data} (the scrollback first, then live
 *  output); `exit` carries {code}. JSON-encoded so control characters and
 *  newlines survive the event-stream framing. */
export function streamTerminal(id: string, req: IncomingMessage, res: ServerResponse): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(": connected\n\n");
  if (s.scrollback) res.write(`event: output\ndata: ${JSON.stringify({ data: s.scrollback })}\n\n`);
  if (s.info.exitCode !== undefined) res.write(`event: exit\ndata: ${JSON.stringify({ code: s.info.exitCode })}\n\n`);
  const listener = (event: "data" | "exit", payload: string | number) => {
    if (event === "data") res.write(`event: output\ndata: ${JSON.stringify({ data: payload })}\n\n`);
    else res.write(`event: exit\ndata: ${JSON.stringify({ code: payload })}\n\n`);
  };
  s.listeners.add(listener);
  const keepalive = setInterval(() => res.write(": ping\n\n"), 15_000);
  if (typeof keepalive.unref === "function") keepalive.unref();
  req.on("close", () => {
    clearInterval(keepalive);
    s.listeners.delete(listener);
  });
  return true;
}
