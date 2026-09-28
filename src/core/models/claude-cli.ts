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
// Env:
//   CLAUDE_CLI_PATH              path to the CLI (default: "claude" on PATH)
//   AGENT_OS_CLAUDE_CLI_TIMEOUT_MS  per-call timeout (default 180000)

import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import type { ModelAdapter, ModelMessage, ModelResponse } from "../model.js";
import { registryToolSpecs, type ToolSpec } from "./real.js";

export interface ClaudeCliOptions {
  /** Passed as `--model` (an alias like "sonnet"/"opus"/"haiku" or a full
   *  model id). Omitted → the CLI's own default. */
  model?: string;
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

export function renderToolProtocol(tools: ToolSpec[]): string {
  if (!tools.length) return "";
  const list = tools
    .map((t) => `- ${t.name}: ${t.description}\n  args schema: ${JSON.stringify(t.parameters)}`)
    .join("\n");
  return [
    "# Tools",
    "You run inside Agent-OS, which executes tools for you; your own built-in tools are disabled.",
    `To use a tool, end your reply with exactly one block: ${TOOL_OPEN}{"name": "<tool>", "args": {...}}${TOOL_CLOSE}`,
    "You may write a short sentence before it, nothing after it. One tool call per reply.",
    "Agent-OS runs it (some calls wait for the operator's approval) and sends the output back as a [tool result] message.",
    "If no tool is needed, just answer normally.",
    "",
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

/** Splits a reply into its visible text and an optional tool call. A block
 *  whose JSON doesn't parse is left in the text rather than guessed at. */
export function parseToolCall(text: string): { content: string; toolCall?: { name: string; args: Record<string, unknown> } } {
  const start = text.indexOf(TOOL_OPEN);
  if (start === -1) return { content: text.trim() };
  const end = text.indexOf(TOOL_CLOSE, start);
  const raw = text.slice(start + TOOL_OPEN.length, end === -1 ? undefined : end).trim();
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.name === "string") {
      const args = parsed.args && typeof parsed.args === "object" ? parsed.args : parsed.arguments && typeof parsed.arguments === "object" ? parsed.arguments : {};
      return { content: text.slice(0, start).trim(), toolCall: { name: parsed.name, args } };
    }
  } catch {
    // fall through
  }
  return { content: text.trim() };
}

/** How much of `text` is safe to show live: everything before a tool-call
 *  block, minus any trailing characters that could be the start of one. */
function visiblePrefixLength(text: string): number {
  const start = text.indexOf(TOOL_OPEN);
  if (start !== -1) return start;
  for (let n = Math.min(TOOL_OPEN.length - 1, text.length); n > 0; n--) {
    if (TOOL_OPEN.startsWith(text.slice(-n))) return text.length - n;
  }
  return text.length;
}

export function createClaudeCliModel(opts: ClaudeCliOptions = {}): ModelAdapter {
  const command = opts.command ?? claudeCliCommand();
  const timeoutMs = opts.timeoutMs ?? Number(process.env.AGENT_OS_CLAUDE_CLI_TIMEOUT_MS ?? 180_000);

  async function run(messages: ModelMessage[], onDelta?: (delta: string) => void): Promise<ModelResponse> {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const toolText = renderToolProtocol(opts.tools ?? registryToolSpecs());
    const systemPrompt = [system, toolText].filter(Boolean).join("\n\n") || "You are a helpful assistant.";
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--tools", "",
      "--no-session-persistence",
      "--setting-sources", "",
      "--system-prompt", systemPrompt,
      ...(opts.model ? ["--model", opts.model] : []),
    ];
    // The CLI authenticates with its own login. ANTHROPIC_TOKEN is Agent-OS's
    // own variable for the direct-API path, not something the CLI reads —
    // dropped so it can't leak into the child's environment.
    const env = { ...process.env };
    delete env.ANTHROPIC_TOKEN;

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
        const parsed = parseToolCall(finalText);
        resolve({ ...parsed, ...(usage ? { usage } : {}) });
      });

      child.stdin.on("error", () => {
        // The child exiting early (bad flag, not logged in) closes stdin;
        // the close handler above reports why.
      });
      child.stdin.end(renderTranscript(messages));
    });
  }

  return {
    id: `claude-cli:${opts.model ?? "default"}`,
    complete: (messages) => run(messages),
    completeStream: (messages, onDelta) => run(messages, onDelta),
  };
}
