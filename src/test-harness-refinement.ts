import "./test-helpers/isolate.js";
import * as fs from "node:fs/promises";
import {
  harnessIdle,
  probeAndStageCandidate,
  recordHarnessTrajectory,
  listApprovals,
  promoteHarnessCandidate,
} from "./core/index.js";

function assert(cond: boolean, message: string): void {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

async function main(): Promise<void> {
  const dataDir = process.env.AGENT_OS_DATA_DIR!;
  await recordHarnessTrajectory(dataDir, {
    at: new Date().toISOString(),
    sessionId: "harness-test-session",
    agentId: "harness-test-agent",
    friction: "tool call was blocked pending approval",
    turnStopReason: "tool-blocked",
  });
  const guard = harnessIdle({
    dataDir,
    fallbackCadenceMs: 60000,
    idleCpuLimit: 100,
    idleMemoryFreeBytes: 1024 * 1024 * 1024,
  }, 0);
  assert(guard.idle || guard.reason.includes("free-memory"), `idle guard is deterministic (${guard.reason})`);

  const candidate = await probeAndStageCandidate(dataDir, "harness-test-agent", ["tool call was blocked pending approval"]);
  assert(candidate.probe === "passed", "candidate passes deterministic staging probe");
  assert(await fs.stat(candidate.candidatePath).then(() => true).catch(() => false), "candidate is written outside the active harness");
  assert(await fs.stat(candidate.snapshotPath).then(() => true).catch(() => false), "candidate includes snapshot/rollback metadata");
  assert(candidate.approvalId !== undefined, "candidate promotion creates a durable approval");
  const pending = await listApprovals({ status: "pending", agentId: "harness-test-agent" });
  assert(pending.some((item) => item.toolName === "harness.promote"), "harness promotion approval uses the shared approval store");
  const promoted = await promoteHarnessCandidate(dataDir, candidate.id, candidate.snapshotPath, candidate.candidatePath);
  assert(promoted.promoted, "approved harness promotion verifies snapshot and promotes only the staged candidate");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
