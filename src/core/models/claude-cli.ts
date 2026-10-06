// Claude through the official Claude Code CLI (`claude -p`), as a normal
// ModelAdapter — so any agent can run on your own Claude subscription the
// same way Orca and Paperclip do it: by starting Anthropic's own CLI and
// letting it use the login it already has, instead of sending a
// subscription token to the API from a third-party harness (which is
// what the ANTHROPIC_TOKEN path in real.ts does, and what Anthropic has
// been restricting).
//
// Agent-OS stays in charge of tools. Claude Code's own built-in tools are
// switched off (`--tools ""`), and Agent-OS's tools are described in the
// system prompt with a small text protocol:
//
//   <tool_call>{"name": "read_file", "args": {"path": "README.md"}}</tool_call>
//
// The adapter parses that block back into ModelResponse.toolCall, so the
// call goes through the exact same path every other provider's does —
// plan mode, Layer A policy, hooks, approvals, the sandbox. Letting Claude
// Code run its own shell/edit tools instead would bypass all of that.
//
// Each call is one fresh, non-persisted CLI run (`--no-session-persistence`)
// fed the whole model-facing conversation on stdin; the Agent-OS session
// log stays the only source of truth for history.
//
// Extended thinking is off by default (MAX_THINKING_TOKENS=0 in the child's
// env): measured live, a three-caption hand-off spent most of its output
// tokens thinking — 159 output tokens for a reply that needed 23. Opt back
// in per agent with a "+think" suffix on the model: `claude-cli:sonnet+think`.
//
// Env:
//   CLAUDE_CLI_PATH              path to the CLI (default: "claude" on PATH)
//   AGENT_OS_CLAUDE_CLI_TIMEOUT_MS  per-call timeout (default 180000)

import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import { connectorGrantsFor } from "../connectors.js";
import { MAX_CALLS_PER_REPLY, type ModelAdapter, type ModelCallOptions, type ModelMessage, type ModelResponse } from "../model.js";
import { registryToolSpecs, type ToolSpec } from "./real.js";

export interface ClaudeCliOptions {
  /** Passed as `--model` (an alias like "sonnet"/"opus"/"haiku" or a full
   *  model id). Omitted → the CLI's own default. */
  model?: string;
  /** Let the model think before answering (costs output tokens on every
   *  call). Also turned on by a "+think" suffix on `model`. Default off. */
  thinking?: boolean;
  command?: string;
  tools?: ToolSpec[];
  timeoutMs?: number;
  /** Working directory for the child process. Defaults to the OS temp dir
   *  so the CLI doesn't pick up whatever project it happens to start in. */
  cwd?: string;
}

export function claudeCliCommand(): string {
  return process.env.CLAUDE_CLI_PATH || "claude";
}

let availability: boolean | undefined;
/** True when the CLI can be started. Checked once per process — the
 *  answer doesn't change while the gateway runs. Says nothing about
 *  whether it's logged in; a logged-out CLI fails its first call with
 *  its own "Not logged in" message, which is surfaced as the error. */
export function claudeCliAvailable(): boolean {
  if (availability === undefined) {
    const probe = spawnSync(claudeCliCommand(), ["--version"], { encoding: "utf8", timeout: 10_000 });
    availability = probe.status === 0;
  }
  return availability;
}

/** Test hook — forget the cached availability check. */
export function resetClaudeCliAvailability(): void {
  availability = undefined;
}

const TOOL_OPEN = "<tool_call>";
const TOOL_CLOSE = "</tool_call>";

/** One line per argument: `name*` when required, then what it's for. */
function renderArgs(parameters: Record<string, unknown>): string {
  const props = (parameters.properties ?? {}) as Record<string, { type?: string; description?: string }>;
  const required = new Set((parameters.required ?? []) as string[]);
  return Object.entries(props)
    .map(([k, v]) => `    ${k}${required.has(k) ? "*" : ""}${v.type && v.type !== "string" ? ` (${v.type})` : ""}${v.description ? `: ${v.description}` : ""}`)
    .join("\n");
}

/** The tool list in plain text — a compact line per argument instead of a
 *  JSON Schema per tool: this goes out in the system prompt of every call
 *  (the CLI gives no prompt caching here), so every character is paid for
 *  again on each tool step. */
export function renderToolProtocol(tools: ToolSpec[], withConnectors = true): string {
  if (!tools.length) return "";
  const list = tools
    .map((t) => {
      const args = renderArgs(t.parameters);
      return `- ${t.name}: ${t.description}${args ? `\n${args}` : ""}`;
    })
    .join("\n");
  return [
    "# Tools",
    // The exact names up front, and what kind of tool they are: without this a small model reads the list, then says a tool "isn't available".
    `Agent-OS tools you can call right now (exact names): ${tools.map((t) => t.name).join(", ")}. They are NOT native tools and not MCP: you call them only by ending your reply with the block below.`,
    "Agent-OS runs tools for you (your built-in tools are off). To use one, end your reply with exactly one block:",
    `${TOOL_OPEN}{"name": "<tool>", "args": {...}}${TOOL_CLOSE}`,
    "That format only for the Agent-OS tools below (not <function_calls> or XML) — never guess a result. " +
      `You may end a reply with up to ${MAX_CALLS_PER_REPLY} blocks in a row when the calls are independent (none needs another's result): they run in order, and each result comes back as its own [tool result]. ` +
      "If a call needs the result of another, send it alone and wait. If one fails, the ones after it are skipped. Nothing after the last block. " +
      "(Some calls wait for the operator's approval.) No tool needed → just answer.",
    ...(withConnectors
      ? [
          "You may also be offered native connector tools (names starting mcp__, e.g. a search or docs tool). Those are extras: call them natively, as usual. " +
            "They never replace the Agent-OS tools below: those are always available to you, and are used ONLY with the block above.",
        ]
      : []),
    "Tools (* = required argument):",
    list,
  ].join("\n");
}

/** The conversation as one prompt. Roles are labeled plainly so the model
 *  can tell its own earlier replies and tool output apart from the user. */
export function renderTranscript(messages: ModelMessage[]): string {
  const label: Record<string, string> = { user: "[user]", assistant: "[assistant]", tool: "[tool result]" };
  const parts = messages.filter((m) => m.role !== "system").map((m) => `${label[m.role]}\n${m.content}`);
  return `${parts.join("\n\n")}\n\nReply as the assistant to the last message above.`;
}

// Claude doesn't always use the requested <tool_call> format: with its own
// tools switched off it sometimes falls back to the shapes it was trained
// on — `<function_calls>` holding JSON (`[{"tool_name": …, "args": …}]`) or
// XML (`<invoke name="…"><parameter name="…">…</parameter></invoke>`). Seen
// live: the raw block leaked into the reply and the model went on to write
// made-up results. So all three are accepted, only the FIRST call is taken,
// and anything written after it is dropped (that's where invented results
// go) — the real result comes back on the next hop.
const OPENERS = [TOOL_OPEN, "<function_calls>", "<function_call>", "<tool_use>", "<call>", "<invoke", "[tool_call]"];
const NAME_KEYS = ["name", "tool_name", "tool", "function"];
const ARG_KEYS = ["args", "arguments", "parameters", "params", "input", "tool_input", "tool_args"];

type ParsedCall = { name: string; args: Record<string, unknown> };

function asArgs(v: unknown): Record<string, unknown> | undefined {
  if (typeof v === "string") {
    try {
      v = JSON.parse(v); // OpenAI-style: arguments as a JSON string
    } catch {
      return undefined;
    }
  }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function callFromObject(o: unknown): ParsedCall | undefined {
  const item = Array.isArray(o) ? o[0] : o;
  if (!item || typeof item !== "object") return undefined;
  const r = item as Record<string, unknown>;
  // {"function": {"name", "arguments"}} (OpenAI tool_calls shape)
  if (r.function && typeof r.function === "object") return callFromObject(r.function);
  const nameKey = NAME_KEYS.find((k) => typeof r[k] === "string");
  if (!nameKey) return undefined;
  const argKey = ARG_KEYS.find((k) => asArgs(r[k]));
  // No wrapper key: the arguments sit flat next to the name.
  const args = argKey ? asArgs(r[argKey])! : Object.fromEntries(Object.entries(r).filter(([k]) => k !== nameKey && k !== "type" && k !== "id"));
  return { name: r[nameKey] as string, args };
}

function callFromInvokeXml(xml: string): ParsedCall | undefined {
  const invoke = xml.match(/<invoke\s+name="([^"]+)"\s*>([\s\S]*?)(?:<\/invoke>|$)/);
  if (!invoke) return undefined;
  const args: Record<string, unknown> = {};
  for (const m of invoke[2]!.matchAll(/<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/g)) {
    const raw = m[2]!.trim();
    try {
      args[m[1]!] = JSON.parse(raw);
    } catch {
      args[m[1]!] = raw;
    }
  }
  return { name: invoke[1]!, args };
}

function parseBlock(block: string): ParsedCall | undefined {
  // Strip the wrapper tag (<tool_call>, <function_calls>, <call>, …) and
  // everything after its closing tag; a bare <invoke> is parsed as XML.
  const wrapper = block.match(/^<([a-z_]+)>/)?.[1];
  const inner = (wrapper ? block.slice(wrapper.length + 2).split(`</${wrapper}>`)[0]! : block).trim();
  try {
    const call = callFromObject(JSON.parse(inner));
    if (call) return call;
  } catch {
    // not plain JSON — try XML, then any JSON object inside
  }
  return callFromInvokeXml(inner) ?? firstJsonCall(inner);
}

/** The first balanced {...} in `text` that parses as a tool call — for
 *  hybrids like `<function_calls>[tool_call]{"name": …}</tool_call>` (seen
 *  live). String-aware, so braces inside argument values don't confuse it. */
function firstJsonCall(text: string): ParsedCall | undefined {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          const call = callFromObject(JSON.parse(text.slice(start, i + 1)));
          if (call) return call;
        } catch {
          // not JSON — try the next "{"
        }
        break;
      }
    }
  }
  return undefined;
}

function firstOpener(text: string): number {
  const hits = OPENERS.map((o) => text.indexOf(o)).filter((i) => i !== -1);
  return hits.length ? Math.min(...hits) : -1;
}

/** Splits a reply into its visible text and an optional tool call (the
 *  first one, in any accepted format). A block that doesn't parse is left
 *  in the text rather than guessed at. */
export function parseToolCall(text: string): { content: string; toolCall?: ParsedCall } {
  const start = firstOpener(text);
  if (start === -1) return { content: text.trim() };
  const call = parseBlock(text.slice(start));
  return call ? { content: text.slice(0, start).trim(), toolCall: call } : { content: text.trim() };
}

/** Splits a reply into its visible text and EVERY tool call it carries, in order (a model may send several independent
 *  calls at once). A block that doesn't parse is skipped, not guessed at. `content` is the text before the first block. */
export function parseToolCalls(text: string): { content: string; toolCalls: ParsedCall[] } {
  const starts: number[] = [];
  for (let from = 0; from < text.length; ) {
    const at = firstOpener(text.slice(from));
    if (at === -1) break;
    starts.push(from + at);
    from += at + 1;
  }
  if (!starts.length) return { content: text.trim(), toolCalls: [] };
  const toolCalls: ParsedCall[] = [];
  starts.forEach((start, i) => {
    const call = parseBlock(text.slice(start, starts[i + 1] ?? text.length));
    if (call) toolCalls.push(call);
  });
  return { content: toolCalls.length ? text.slice(0, starts[0]).trim() : text.trim(), toolCalls };
}

/** How much of `text` is safe to show live: everything before a tool-call
 *  block, minus any trailing characters that could be the start of one. */
function visiblePrefixLength(text: string): number {
  const start = firstOpener(text);
  if (start !== -1) return start;
  for (let n = Math.min(Math.max(...OPENERS.map((o) => o.length)) - 1, text.length); n > 0; n--) {
    const tail = text.slice(-n);
    if (OPENERS.some((o) => o.startsWith(tail))) return text.length - n;
  }
  return text.length;
}

/** How the CLI is launched. Its own built-in tools are off. The operator's MCP connectors stay loaded (they added them
 *  on purpose), but a connector tool is refused in non-interactive mode unless granted, so the ones the operator
 *  has enabled are granted here and the rest are withheld (connectors.ts). Agent-OS's own tools are described in
 *  the system prompt and used with a block, never as native calls. */
export function claudeCliArgs(systemPrompt: string, model?: string, grants: { allow: string[]; deny: string[] } = { allow: [], deny: [] }): string[] {
  return [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--tools", "",
    "--no-session-persistence",
    "--setting-sources", "",
    ...(grants.allow.length ? ["--allowedTools", grants.allow.join(",")] : []),
    ...(grants.deny.length ? ["--disallowedTools", grants.deny.join(",")] : []),
    "--system-prompt", systemPrompt,
    ...(model ? ["--model", model] : []),
  ];
}

export function createClaudeCliModel(opts: ClaudeCliOptions = {}): ModelAdapter {
  const command = opts.command ?? claudeCliCommand();
  const thinkSuffix = /\+think$/.test(opts.model ?? "");
  const model = thinkSuffix ? opts.model!.replace(/\+think$/, "") || undefined : opts.model;
  const thinking = opts.thinking ?? thinkSuffix;
  const timeoutMs = opts.timeoutMs ?? Number(process.env.AGENT_OS_CLAUDE_CLI_TIMEOUT_MS ?? 180_000);

  async function run(messages: ModelMessage[], onDelta?: (delta: string) => void, callOpts?: ModelCallOptions): Promise<ModelResponse> {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const grants = connectorGrantsFor(model);
    const toolText = renderToolProtocol(callOpts?.tools ?? opts.tools ?? registryToolSpecs(), grants.allow.length > 0);
    // The tool protocol goes FIRST: it is the biggest block and identical on every call an agent makes, so the provider's prompt
    // cache can reuse the whole prefix (tools + persona + the other stable parts). What changes per turn (the conversation focus,
    // recalled memory) is last in `system`, so it only breaks the cache at the very end.
    const systemPrompt = [toolText, system].filter(Boolean).join("\n\n") || "You are a helpful assistant.";
    const args = claudeCliArgs(systemPrompt, model, grants);
    // The CLI authenticates with its own login. ANTHROPIC_TOKEN is Agent-OS's
    // own variable for the direct-API path, not something the CLI reads —
    // dropped so it can't leak into the child's environment.
    const env = { ...process.env };
    delete env.ANTHROPIC_TOKEN;
    if (!thinking) env.MAX_THINKING_TOKENS = "0";

    return new Promise<ModelResponse>((resolve, reject) => {
      const child = spawn(command, args, { cwd: opts.cwd ?? os.tmpdir(), env, stdio: ["pipe", "pipe", "pipe"] });
      let buffered = "";
      let stderr = "";
      let streamed = "";
      let shown = 0;
      let finalText: string | undefined;
      let errorText: string | undefined;
      let usage: ModelResponse["usage"];
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Claude CLI timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(new Error("Claude CLI call cancelled"));
      };
      if (callOpts?.signal?.aborted) onAbort();
      else callOpts?.signal?.addEventListener("abort", onAbort, { once: true });

      const handleLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event.type === "stream_event" && event.event?.type === "content_block_delta" && event.event.delta?.type === "text_delta") {
          streamed += event.event.delta.text ?? "";
          if (onDelta) {
            const upTo = visiblePrefixLength(streamed);
            if (upTo > shown) {
              onDelta(streamed.slice(shown, upTo));
              shown = upTo;
            }
          }
        } else if (event.type === "result") {
          if (event.is_error) errorText = String(event.result ?? event.subtype ?? "Claude CLI reported an error");
          else finalText = typeof event.result === "string" ? event.result : streamed;
          const u = event.usage;
          if (u) {
            usage = {
              inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
              outputTokens: u.output_tokens ?? 0,
              ...(u.cache_read_input_tokens ? { cachedInputTokens: u.cache_read_input_tokens } : {}),
            };
          }
        }
      };

      child.stdout.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        let nl: number;
        while ((nl = buffered.indexOf("\n")) !== -1) {
          handleLine(buffered.slice(0, nl));
          buffered = buffered.slice(nl + 1);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`Could not start the Claude CLI (${command}): ${err.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        handleLine(buffered);
        if (errorText !== undefined) return reject(new Error(`Claude CLI error: ${errorText}`));
        if (finalText === undefined) {
          const reason = stderr.trim().split("\n").find(Boolean) ?? `exit code ${code}`;
          return reject(new Error(`Claude CLI returned no result: ${reason}`));
        }
        const { content, toolCalls } = parseToolCalls(finalText);
        resolve({ content, ...(toolCalls.length ? { toolCall: toolCalls[0], toolCalls } : {}), ...(usage ? { usage } : {}) });
      });

      child.stdin.on("error", () => {
        // The child exiting early (bad flag, not logged in) closes stdin;
        // the close handler above reports why.
      });
      child.stdin.end(renderTranscript(messages));
    });
  }

  return {
    id: `claude-cli:${model ?? "default"}${thinking ? "+think" : ""}`,
    complete: (messages, callOpts) => run(messages, undefined, callOpts),
    completeStream: (messages, onDelta, callOpts) => run(messages, onDelta, callOpts),
  };
}
