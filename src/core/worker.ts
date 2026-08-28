// Worker: the execution environment, deliberately separate from Agent
// (identity/reasoning/memory/policy). DeepSeek Harness proves in
// production that "spawn a different harness entirely as the child" is a
// trivial extension once delegation is defined as a protocol boundary
// rather than an internal function call — this interface is written so a
// future WorkerKind can be "acp:claude-code" or "acp:codex" without
// touching anything that calls run().

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
