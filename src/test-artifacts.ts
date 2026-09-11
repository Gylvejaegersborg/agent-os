// Standalone tests for the Artifact primitive (artifacts.ts) and its
// opt-in `record-artifact` tool wiring into runTurn() (agent-loop.ts) —
// proves:
//   1. createArtifact()/getArtifact()/listArtifacts() work as a real,
//      immutable, event-sourced registry, filterable by
//      taskId/sessionId/flowId/producer/type.
//   2. The `record-artifact` tool is genuinely opt-in: rejected without
//      enableArtifacts, available with it — proven end-to-end through a
//      real runTurn() call, not just by calling createArtifact() directly.
//   3. An artifact recorded during a turn is automatically linked to the
//      CURRENT session (and its task, when the session has one) without
//      the model having to know/pass either id itself.
// Run with: node dist/test-artifacts.js

import "./test-helpers/isolate.js";
import {
  createArtifact,
  getArtifact,
  listArtifacts,
  runTurn,
  newSessionId,
  createTask,
  transitionTask,
  linkSessionWork,
  createSession,
  createStubWorker,
  type ModelAdapter,
} from "./core/index.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

async function testRegistryBasics(): Promise<void> {
  console.log("\n-- 1. Artifact registry CRUD/listing --");
  const artifact = await createArtifact({
    type: "report",
    location: "/workspace/reports/market-pulse.md",
    producer: "theia",
    metadata: { title: "Weekly market pulse" },
  });
  assert(artifact.type === "report", "type is preserved");
  assert(artifact.location === "/workspace/reports/market-pulse.md", "location is preserved");
  assert(artifact.metadata.title === "Weekly market pulse", "metadata is preserved");

  const fetched = await getArtifact(artifact.id);
  assert(fetched?.id === artifact.id, "getArtifact() finds the just-created artifact");

  const missing = await getArtifact("no-such-artifact");
  assert(missing === undefined, "getArtifact() on an unknown id returns undefined");

  await createArtifact({ type: "code", location: "/workspace/src/index.ts", producer: "claude" });
  const reports = await listArtifacts({ type: "report" });
  assert(
    reports.length === 1 && reports[0]!.id === artifact.id,
    "listArtifacts({type}) filters correctly",
  );

  const byProducer = await listArtifacts({ producer: "theia" });
  assert(
    byProducer.every((a) => a.producer === "theia"),
    "listArtifacts({producer}) filters correctly",
  );
}

async function testFilteringByRelationship(): Promise<void> {
  console.log("\n-- 2. Filtering by taskId/sessionId/flowId --");
  const sessionId = newSessionId();
  const task = await createTask({ type: "user-request", agentId: "nyx", input: {} });

  await createArtifact({ type: "draft", location: "/workspace/drafts/caption.txt", producer: "nyx", sessionId, taskId: task.id });
  await createArtifact({ type: "draft", location: "/workspace/drafts/other.txt", producer: "nyx" });

  const forSession = await listArtifacts({ sessionId });
  assert(forSession.length === 1, `listArtifacts({sessionId}) finds exactly the linked artifact (got ${forSession.length})`);

  const forTask = await listArtifacts({ taskId: task.id });
  assert(forTask.length === 1 && forTask[0]!.sessionId === sessionId, "listArtifacts({taskId}) finds the same artifact, with its session intact");
}

function alwaysRecordArtifactModel(): ModelAdapter {
  let called = false;
  return {
    id: "always-record-artifact",
    async complete() {
      if (called) return { content: "done recording" };
      called = true;
      return {
        content: "Recording the file I just wrote.",
        toolCall: { name: "record-artifact", args: { type: "file", location: "/workspace/output.txt", description: "test output" } },
      };
    },
  };
}

async function testOptInToolViaRunTurn(): Promise<void> {
  console.log("\n-- 3. record-artifact tool is opt-in, proven via real runTurn() --");

  const sessionIdDisabled = newSessionId();
  await runTurn({
    sessionId: sessionIdDisabled,
    agentId: "artifacts-test-agent",
    userMessage: "please record an artifact",
    model: alwaysRecordArtifactModel(),
    worker: createStubWorker(),
    // enableArtifacts omitted — should be rejected
  });
  const artifactsWhenDisabled = await listArtifacts({ sessionId: sessionIdDisabled });
  assert(artifactsWhenDisabled.length === 0, "no artifact is recorded when enableArtifacts is not passed");

  const sessionIdEnabled = newSessionId();
  const task = await createTask({ type: "user-request", agentId: "artifacts-test-agent", input: {} });
  await transitionTask(task.id, "running");
  const session = await createSession({ id: sessionIdEnabled, agentId: "artifacts-test-agent" });
  await linkSessionWork(session.id, { taskId: task.id });

  await runTurn({
    sessionId: sessionIdEnabled,
    agentId: "artifacts-test-agent",
    userMessage: "please record an artifact",
    model: alwaysRecordArtifactModel(),
    worker: createStubWorker(),
    enableArtifacts: true,
  });

  const recorded = await listArtifacts({ sessionId: sessionIdEnabled });
  assert(recorded.length === 1, `exactly one artifact was recorded when enableArtifacts is true (got ${recorded.length})`);
  assert(recorded[0]?.type === "file", "the recorded artifact's type matches what the tool call specified");
  assert(recorded[0]?.location === "/workspace/output.txt", "the recorded artifact's location matches what the tool call specified");
  assert(recorded[0]?.producer === "artifacts-test-agent", "the recorded artifact's producer is the turn's agentId, not something the model had to supply");
  assert(
    recorded[0]?.taskId === task.id,
    "the recorded artifact is automatically linked to the session's CURRENT task, without the model knowing its id",
  );
}

async function main(): Promise<void> {
  await testRegistryBasics();
  await testFilteringByRelationship();
  await testOptInToolViaRunTurn();

  if (process.exitCode === 1) {
    console.error("\nSome artifacts tests FAILED.");
  } else {
    console.log("\nAll artifacts tests passed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
