// Standalone tests for the Worker registry (worker-registry.ts) — proves:
//   1. registerWorker()/getWorkerRecord()/listWorkerRecords() work as a
//      real projection, filterable by status/kind.
//   2. A freshly registered worker starts 'starting', and
//      markWorkerStarted()/markWorkerStopped()/markWorkerError() drive it
//      through real, observable status transitions.
//   3. Unlike Session/ApprovalRequest, 'stopped' is NOT terminal — a
//      worker can be started again after being stopped.
//   4. This registry is genuinely OPT-IN: constructing a plain worker.ts
//      Worker (createStubWorker/createLocalShellWorker) never creates a
//      registry entry on its own.
// Run with: node dist/test-worker-registry.js

import "./test-helpers/isolate.js";
import {
  registerWorker,
  getWorkerRecord,
  listWorkerRecords,
  markWorkerStarted,
  markWorkerStopped,
  markWorkerError,
  createStubWorker,
} from "./core/index.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

async function assertThrows(fn: () => Promise<unknown>, msg: string): Promise<void> {
  try {
    await fn();
    assert(false, msg);
  } catch {
    assert(true, msg);
  }
}

async function testRegistryBasics(): Promise<void> {
  console.log("\n-- 1. Worker registry CRUD/listing --");
  const record = await registerWorker({ id: "worker-1", kind: "local-shell", metadata: { host: "localhost" } });
  assert(record.status === "starting", "a freshly registered worker starts 'starting'");
  assert(record.kind === "local-shell", "kind is preserved");

  const fetched = await getWorkerRecord("worker-1");
  assert(fetched?.id === "worker-1", "getWorkerRecord() finds the just-registered worker");

  await registerWorker({ id: "worker-2", kind: "docker" });
  const shellWorkers = await listWorkerRecords({ kind: "local-shell" });
  assert(
    shellWorkers.length === 1 && shellWorkers[0]!.id === "worker-1",
    "listWorkerRecords({kind}) filters correctly",
  );

  const missing = await getWorkerRecord("no-such-worker");
  assert(missing === undefined, "getWorkerRecord() on an unknown id returns undefined");
}

async function testLifecycleTransitions(): Promise<void> {
  console.log("\n-- 2. Real lifecycle transitions --");
  await registerWorker({ id: "worker-lifecycle", kind: "local-shell" });

  const started = await markWorkerStarted("worker-lifecycle");
  assert(started.status === "running", "markWorkerStarted() transitions to 'running'");
  assert(!!started.startedAt, "startedAt is stamped once running");

  const running = await listWorkerRecords({ status: "running" });
  assert(
    running.some((w) => w.id === "worker-lifecycle"),
    "listWorkerRecords({status:'running'}) finds it",
  );

  const stopped = await markWorkerStopped("worker-lifecycle");
  assert(stopped.status === "stopped", "markWorkerStopped() transitions to 'stopped'");
  assert(!!stopped.stoppedAt, "stoppedAt is stamped once stopped");

  // --- 3. 'stopped' is NOT terminal: it can be started again. ---
  const restarted = await markWorkerStarted("worker-lifecycle");
  assert(restarted.status === "running", "a stopped worker CAN be started again (not a terminal status)");

  const erroring = await markWorkerError("worker-lifecycle", "connection refused");
  assert(erroring.status === "error", "markWorkerError() transitions to 'error'");
  assert(erroring.lastError === "connection refused", "lastError is recorded");

  await assertThrows(
    () => markWorkerStarted("no-such-worker"),
    "transitioning an unregistered worker id throws",
  );
}

async function testRegistrationIsOptIn(): Promise<void> {
  console.log("\n-- 4. Registration is opt-in — plain Worker construction never auto-registers --");
  createStubWorker("unregistered-stub");
  const found = await getWorkerRecord("unregistered-stub");
  assert(found === undefined, "constructing a plain worker.ts Worker creates no registry entry on its own");
}

async function main(): Promise<void> {
  await testRegistryBasics();
  await testLifecycleTransitions();
  await testRegistrationIsOptIn();

  if (process.exitCode === 1) {
    console.error("\nSome worker-registry tests FAILED.");
  } else {
    console.log("\nAll worker-registry tests passed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
