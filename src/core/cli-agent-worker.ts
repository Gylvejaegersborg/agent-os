// Cross-harness delegation Worker — OPTIONAL, NOT the default multiagent
// mechanism in this scaffold. Read this file's header before wiring it in.
//
// The PRIMARY multiagent mechanism is `subagent.ts`: an in-process,
// same-harness delegation that calls this scaffold's own `runTurn()` again
// with a fresh session. It needs no external install, no subprocess, no
// second application, and stays the default path for "split this into
// focused sub-tasks."
//
// THIS file is a genuinely separate, opt-in capability for the specific
// case where you want a *different agent product* to do the work — e.g.
// "use the real Claude Code CLI for this because its coding tool loop is
// what you actually want," not "I need another subagent." It shells out to
// an installed CLI agent (Claude Code, OpenAI Codex, or OpenCode) as a
// child process and adapts its stdout/exit-code back into the exact same
// `WorkerResult` shape every other Worker in this scaffold produces —
// matching the `docs/architecture.md §1` sketch of a `"acp:claude-code"` /
// `"acp:codex"` WorkerKind, and the comment already at the top of
// `worker.ts`. Nothing about the rest of the scaffold (Task ledger,
// agent-loop, permissions) needs to know or care that the Worker on the
// other end of `run()` is a whole separate application instead of a local
// shell — that's the entire point of the Worker abstraction.
//
// Contract note that differs from createLocalShellWorker: for a CLI agent
// worker, the string passed to `run(command)` is a natural-language TASK
// handed to the external agent as its prompt, not a shell command to
// execute verbatim. The external CLI decides for itself what tool calls
// (if any) it needs to make to satisfy that task.
//
// Real, live-tested-or-honestly-not finding for THIS machine is recorded in
// src/test-cross-harness-worker.ts and README.md's "Cross-harness
// delegation" section — do not assume any particular CLI is installed or
// authenticated without checking those first.

import { spawn } from "node:child_process";
import type { Worker, WorkerResult } from "./worker.js";

export interface CliAgentWorkerOptions {
  id?: string;
  /** Max time to wait for the child process before killing it and
   *  returning a timeout WorkerResult. Cross-harness delegation to a full
   *  coding agent can legitimately take minutes, so this defaults much
   *  higher than createLocalShellWorker's 30s. */
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Override the reported `kind` (defaults to `acp:<cliCommand>`). Useful
   *  when `cliCommand` is a full off-PATH executable path (e.g. Claude
   *  Code's Windows install, which does not add itself to PATH) so
   *  `Worker.kind` stays a stable short label like "acp:claude" instead of
   *  the whole filesystem path. */
  kind?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** Generic "shell out to an external CLI agent" Worker factory. Not tied to
 *  any one product — pass whichever CLI command + non-interactive arg
 *  builder matches the agent you want to delegate to. `createClaudeCodeWorker`
 *  / `createCodexWorker` / `createOpenCodeWorker` below are just
 *  pre-filled convenience wrappers around this for the three CLIs
 *  researched for this scaffold; nothing stops you from pointing this at
 *  a fourth.
 *
 *  Handles the two failure modes that matter for graceful degradation
 *  (matching the pattern `createOllamaModel`/`createModelFromEnvOrOllama`
 *  already use in `models/real.ts`):
 *    1. The CLI binary isn't installed / not on PATH -> ENOENT from
 *       child_process -> a clear `WorkerResult.error`, never a crash.
 *    2. The CLI runs but the task doesn't finish in time -> the child is
 *       killed and a timeout `WorkerResult.error` is returned.
 *  A non-zero exit code (e.g. the CLI is installed but not logged in) is
 *  its own third case: not a crash, not "not installed" — a normal
 *  `WorkerResult.ok = false` carrying the CLI's own stderr/stdout so the
 *  caller can see exactly why. */
export function createCliAgentWorker(
  cliCommand: string,
  buildArgs: (task: string) => string[],
  opts: CliAgentWorkerOptions = {},
): Worker {
  const id = opts.id ?? `cli-agent:${cliCommand}`;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const kind = opts.kind ?? `acp:${cliCommand}`;

  return {
    id,
    kind,
    async run(command: string): Promise<WorkerResult> {
      const args = buildArgs(command);

      return new Promise<WorkerResult>((resolve) => {
        let settled = false;
        const finish = (result: WorkerResult) => {
          if (settled) return;
          settled = true;
          resolve(result);
        };

        let stdout = "";
        let stderr = "";
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn(cliCommand, args, {
            cwd: opts.cwd,
            env: opts.env ?? process.env,
            windowsHide: true,
          });
        } catch (err: unknown) {
          finish({
            ok: false,
            output: "",
            error: `Failed to spawn "${cliCommand}": ${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }

        const timer = setTimeout(() => {
          child.kill();
          finish({
            ok: false,
            output: stdout,
            error: `"${cliCommand}" did not finish within ${timeoutMs}ms — killed. Cross-harness delegation to a full coding agent can be slow; raise timeoutMs if this is expected.`,
          });
        }, timeoutMs);
        timer.unref?.();

        child.on("error", (err: NodeJS.ErrnoException) => {
          clearTimeout(timer);
          if (err.code === "ENOENT") {
            finish({
              ok: false,
              output: "",
              error:
                `"${cliCommand}" is not installed or not resolvable on PATH — cross-harness ` +
                `delegation to it is unavailable on this machine. This is expected/graceful: ` +
                `the in-process Subagent primitive (src/core/subagent.ts) remains fully usable ` +
                `without any external CLI. (${err.message})`,
            });
          } else {
            finish({ ok: false, output: "", error: `Failed to run "${cliCommand}": ${err.message}` });
          }
        });

        child.stdout?.on("data", (d: Buffer) => {
          stdout += d.toString();
        });
        child.stderr?.on("data", (d: Buffer) => {
          stderr += d.toString();
        });

        child.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) {
            finish({ ok: true, output: stdout.trim() });
          } else {
            finish({
              ok: false,
              output: stdout.trim(),
              error: stderr.trim() || `"${cliCommand}" exited with code ${code}`,
            });
          }
        });
      });
    },
  };
}

export interface ClaudeCodeWorkerOptions extends CliAgentWorkerOptions {
  /** Override the resolved binary — e.g. an absolute path, if the CLI
   *  isn't (yet) correctly registered on PATH. Defaults to the bare
   *  command "claude", i.e. normal PATH resolution. */
  cliPath?: string;
}

/** Claude Code CLI as a cross-harness Worker. Non-interactive invocation
 *  researched directly against the installed CLI's own --help output:
 *  `claude -p "<task>" --output-format text` ("-p"/"--print": print
 *  response and exit, for non-interactive/scripted use). */
export function createClaudeCodeWorker(opts: ClaudeCodeWorkerOptions = {}): Worker {
  const cli = opts.cliPath ?? "claude";
  return createCliAgentWorker(cli, (task) => ["-p", task, "--output-format", "text"], {
    id: opts.id ?? "claude-code-cli",
    timeoutMs: opts.timeoutMs,
    cwd: opts.cwd,
    env: opts.env,
    kind: "acp:claude",
  });
}

export interface CodexWorkerOptions extends CliAgentWorkerOptions {
  cliPath?: string;
  /** Codex exec defaults to a read-only sandbox; most delegated coding
   *  tasks need at least workspace writes. Defaults to true (passes
   *  `--sandbox workspace-write`). Set false to keep the CLI's own
   *  read-only default. */
  allowWorkspaceWrites?: boolean;
}

/** OpenAI Codex CLI as a cross-harness Worker. Non-interactive invocation
 *  per Codex's documented exec mode: `codex exec "<task>"` runs headless
 *  and exits, reusing whatever CLI auth is already configured. */
export function createCodexWorker(opts: CodexWorkerOptions = {}): Worker {
  const cli = opts.cliPath ?? "codex";
  const allowWrites = opts.allowWorkspaceWrites ?? true;
  return createCliAgentWorker(
    cli,
    (task) => ["exec", ...(allowWrites ? ["--sandbox", "workspace-write"] : []), task],
    { id: opts.id ?? "codex-cli", timeoutMs: opts.timeoutMs, cwd: opts.cwd, env: opts.env, kind: "acp:codex" },
  );
}

export interface OpenCodeWorkerOptions extends CliAgentWorkerOptions {
  cliPath?: string;
}

/** OpenCode CLI as a cross-harness Worker. Non-interactive invocation per
 *  OpenCode's documented run mode: `opencode run "<task>"`. */
export function createOpenCodeWorker(opts: OpenCodeWorkerOptions = {}): Worker {
  const cli = opts.cliPath ?? "opencode";
  return createCliAgentWorker(cli, (task) => ["run", task], {
    id: opts.id ?? "opencode-cli",
    timeoutMs: opts.timeoutMs,
    cwd: opts.cwd,
    env: opts.env,
    kind: "acp:opencode",
  });
}

export type KnownCliAgent = "claude" | "codex" | "opencode";

export interface CliAgentDetection {
  name: KnownCliAgent;
  command: string;
  versionOutput: string;
}

/** Probes for claude / codex / opencode on PATH, in that order, by running
 *  each with `--version` and a short timeout. Returns the first one that
 *  responds, or undefined if none are invocable — mirrors the
 *  graceful-degradation shape of `createModelFromEnvOrOllama` in
 *  `models/real.ts` (try everything available, admit clearly if nothing
 *  is, never throw just because an optional integration is absent).
 *  NOTE: this only proves the binary is installed and runs — it does NOT
 *  prove it's authenticated (a CLI can pass this probe and still fail a
 *  real task with a "not logged in" error surfaced via WorkerResult.error). */
export async function detectCliAgent(): Promise<CliAgentDetection | undefined> {
  const candidates: { name: KnownCliAgent; command: string }[] = [
    { name: "claude", command: "claude" },
    { name: "codex", command: "codex" },
    { name: "opencode", command: "opencode" },
  ];

  for (const candidate of candidates) {
    const result = await probeVersion(candidate.command);
    if (result !== undefined) {
      return { name: candidate.name, command: candidate.command, versionOutput: result };
    }
  }
  return undefined;
}

function probeVersion(command: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, ["--version"], { windowsHide: true });
    } catch {
      done(undefined);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      done(undefined);
    }, 8_000);
    timer.unref?.();
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.on("error", () => {
      clearTimeout(timer);
      done(undefined);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done(code === 0 ? out.trim() : undefined);
    });
  });
}
