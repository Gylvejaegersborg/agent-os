// Worker: the execution environment, deliberately separate from Agent
// (identity/reasoning/memory/policy). DeepSeek Harness proves in
// production that "spawn a different harness entirely as the child" is a
// trivial extension once delegation is defined as a protocol boundary
// rather than an internal function call — this interface is written so a
// future WorkerKind can be "acp:claude-code" or "acp:codex" without
// touching anything that calls run().

import { checkSandbox, type SandboxPolicy } from "./permissions.js";

export interface WorkerResult {
  ok: boolean;
  output: string;
  error?: string;
}

export interface Worker {
  id: string;
  kind: string;
  run(command: string): Promise<WorkerResult>;
}

/** The only Worker implementation this scaffold ships: a local shell.
 *  Real Workers (docker, ssh, acp:claude-code, acp:codex, browser) plug in
 *  behind the exact same interface. */
export function createLocalShellWorker(id = "local-shell"): Worker {
  return {
    id,
    kind: "local-shell",
    async run(command: string): Promise<WorkerResult> {
      const { exec } = await import("node:child_process");
      return new Promise((resolve) => {
        exec(command, { timeout: 30_000 }, (error, stdout, stderr) => {
          if (error) {
            resolve({ ok: false, output: stdout, error: stderr || error.message });
          } else {
            resolve({ ok: true, output: stdout });
          }
        });
      });
    },
  };
}

/** A stub worker for tests/demos that never touches the real shell. */
export function createStubWorker(id = "stub", canned: WorkerResult = { ok: true, output: "(stub output)" }): Worker {
  return {
    id,
    kind: "stub",
    async run(_command: string): Promise<WorkerResult> {
      return canned;
    },
  };
}

/** The Layer-B enforcement point: wraps a real (or stub) Worker so every
 *  command is checked against a SandboxPolicy BEFORE execution, regardless
 *  of what any upstream permission policy (Layer A, permissions.ts)
 *  already decided. This is deliberately a separate wrapper rather than
 *  logic baked into createLocalShellWorker — sandboxing should hold no
 *  matter which underlying Worker kind you're wrapping (local shell,
 *  docker, ssh, ...), and wrapping makes that composability explicit
 *  instead of duplicating the check into every Worker implementation. */
export function createSandboxedWorker(inner: Worker, policy: SandboxPolicy): Worker {
  return {
    id: `sandboxed:${inner.id}`,
    kind: `sandboxed:${inner.kind}`,
    async run(command: string): Promise<WorkerResult> {
      const check = checkSandbox(policy, command);
      if (!check.allowed) {
        return { ok: false, output: "", error: `sandbox rejected command: ${check.reason}` };
      }
      return inner.run(command);
    },
  };
}
