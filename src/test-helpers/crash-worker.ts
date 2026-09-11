// A standalone helper process for test-task-lifecycle.ts's cross-process
// liveness test — NOT run directly via npm scripts. Creates a Task,
// transitions it to 'running' (which durably renews its liveness — see
// tasks.ts's transitionTask()), prints the Task id, then exits
// immediately WITHOUT any further transition or renewal — modeling a
// process that crashes mid-execution. Run against the SAME
// AGENT_OS_DATA_DIR as the parent test (passed via env, not derived from
// this script's own path) so the parent can prove reconcileLostTasks()
// genuinely detects this as an orphan from a DIFFERENT process, not
// merely a simulated in-memory reset within one process.

import { createTask, transitionTask } from "../core/index.js";

async function main(): Promise<void> {
  const agentId = process.argv[2] ?? "crash-worker-agent";
  const task = await createTask({ type: "cli", agentId, input: {} });
  await transitionTask(task.id, "running");
  console.log(task.id);
  process.exit(0); // no further transition, no further renewal — this Task is now orphaned
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
