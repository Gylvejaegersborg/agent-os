// Standalone tests for the authoritative Agent registry (agents.ts) —
// proves:
//   1. registerAgent()/getAgentRecord()/listAgentRecords() compose
//      identity + defaultModel + live state + metrics into one record.
//   2. updateAgent() patches identity fields (role/capabilities/persona)
//      through to the composed record.
//   3. Live state (status/currentSessionId/currentTaskId/workerId) is
//      genuinely DERIVED — not stored — by creating a real Session/Task
//      and confirming the record reflects it, then confirming it goes
//      back to 'idle' once the session is cancelled and the task
//      completes.
//   4. seedDefaultAgents() is idempotent: calling it twice never
//      duplicates the roster, and it seeds the real ISΛRK team ids.
// Run with: node dist/test-agents.js

import "./test-helpers/isolate.js";
import {
  registerAgent,
  updateAgent,
  getAgentRecord,
  listAgentRecords,
  seedDefaultAgents,
  createSession,
  cancelSession,
  linkSessionWork,
  createTask,
  transitionTask,
} from "./core/index.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

async function testRegisterAndCompose(): Promise<void> {
  console.log("\n-- 1. registerAgent() composes a full AgentRecord --");
  const agent = await registerAgent({
    id: "agents-test-agent",
    name: "Test Agent",
    persona: "exists only for this test",
    role: "Tester · QA",
    capabilities: ["testing"],
    defaultModel: "claude-opus-4-hypothetical",
  });

  assert(agent.name === "Test Agent", "name is composed correctly");
  assert(agent.role === "Tester · QA", "role is composed correctly");
  assert(agent.capabilities.includes("testing"), "capabilities are composed correctly");
  assert(agent.defaultModel === "claude-opus-4-hypothetical", "defaultModel preference is composed correctly");
  assert(agent.status === "idle", "a freshly registered agent with no sessions/tasks starts 'idle'");
  assert(!!agent.metrics, "a metrics snapshot is included, even if empty");

  const fetched = await getAgentRecord("agents-test-agent");
  assert(fetched?.id === "agents-test-agent", "getAgentRecord() finds the just-registered agent");

  const all = await listAgentRecords();
  assert(
    all.some((a) => a.id === "agents-test-agent"),
    "listAgentRecords() includes the new agent",
  );

  const missing = await getAgentRecord("no-such-agent");
  assert(missing === undefined, "getAgentRecord() on an unknown id returns undefined");
}

async function testUpdateAgent(): Promise<void> {
  console.log("\n-- 2. updateAgent() patches through to the composed record --");
  const updated = await updateAgent("agents-test-agent", { role: "Tester · Updated", capabilities: ["testing", "updated"] });
  assert(updated?.role === "Tester · Updated", "role is updated");
  assert(updated?.capabilities.includes("updated") ?? false, "capabilities are updated");
  assert(updated?.name === "Test Agent", "fields NOT included in the patch are left unchanged");

  const unknownPatch = await updateAgent("no-such-agent", { role: "should not matter" });
  assert(unknownPatch === undefined, "updateAgent() on an unknown id returns undefined rather than creating one");
}

async function testLiveStateIsDerived(): Promise<void> {
  console.log("\n-- 3. Live state (status/currentTask/worker) is genuinely derived --");
  const agentId = "agents-test-live-agent";
  await registerAgent({ id: agentId, name: "Live Test Agent", persona: "test" });

  const idleRecord = await getAgentRecord(agentId);
  assert(idleRecord?.status === "idle", "a new agent with no work at all starts 'idle'");

  const session = await createSession({ agentId });
  const task = await createTask({ type: "user-request", agentId, workerId: "test-worker-1", input: {} });
  await transitionTask(task.id, "running");
  await linkSessionWork(session.id, { taskId: task.id });

  const activeRecord = await getAgentRecord(agentId);
  assert(activeRecord?.status === "active", "with an active Session+running Task, status becomes 'active'");
  assert(activeRecord?.currentSessionId === session.id, "currentSessionId reflects the real active session");
  assert(activeRecord?.currentTaskId === task.id, "currentTaskId reflects the session's linked task");
  assert(activeRecord?.workerId === "test-worker-1", "workerId is derived from the current task's workerId");

  await transitionTask(task.id, "succeeded");
  await cancelSession(session.id);

  const backToIdle = await getAgentRecord(agentId);
  assert(backToIdle?.status === "idle", "once the task finishes and the session is cancelled, status returns to 'idle'");
  assert(backToIdle?.currentTaskId === undefined, "currentTaskId clears once no task is running");
}

async function testSeedDefaultAgentsIdempotent(): Promise<void> {
  console.log("\n-- 4. seedDefaultAgents() seeds the real roster, idempotently --");
  const first = await seedDefaultAgents();
  assert(first.length === 8, `seedDefaultAgents() registers the full 8-agent ISΛRK roster (got ${first.length})`);
  for (const id of ["claude", "hemera", "nyx", "aether", "hermes", "mnemosyne", "theia", "argus"]) {
    assert(
      first.some((a) => a.id === id),
      `the roster includes "${id}"`,
    );
  }

  const second = await seedDefaultAgents();
  assert(second.length === 8, "calling seedDefaultAgents() again still returns exactly 8 (no duplication)");

  const all = await listAgentRecords();
  const claudeCount = all.filter((a) => a.id === "claude").length;
  assert(claudeCount === 1, "listAgentRecords() shows exactly one 'claude' entry after seeding twice");
}

async function main(): Promise<void> {
  await testRegisterAndCompose();
  await testUpdateAgent();
  await testLiveStateIsDerived();
  await testSeedDefaultAgentsIdempotent();

  if (process.exitCode === 1) {
    console.error("\nSome agents tests FAILED.");
  } else {
    console.log("\nAll agents tests passed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
