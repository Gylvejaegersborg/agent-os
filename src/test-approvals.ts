// Standalone tests for durable approvals (approvals.ts) and its wiring
// into Layer A's PermissionPolicy (permissions.ts) — proves:
//   1. requestApproval()/getApproval()/listApprovals() work as a real,
//      restart-surviving projection (event-sourced, same as every other
//      registry in this codebase).
//   2. approveRequest()/rejectRequest() are terminal — a resolved request
//      cannot be resolved again.
//   3. A PermissionPolicy rule that evaluates to "ask" with NO onAsk
//      callback configured creates a durable, discoverable
//      ApprovalRequest and blocks the tool call — instead of the old
//      behavior of silently auto-denying with no record at all.
//   4. A PermissionPolicy with an onAsk callback still uses the fast,
//      synchronous, in-process path (no ApprovalRequest created) —
//      proving the two modes are genuinely distinct, not one masking the
//      other.
// Run with: node dist/test-approvals.js

import "./test-helpers/isolate.js";
import {
  requestApproval,
  getApproval,
  listApprovals,
  approveRequest,
  rejectRequest,
  installPermissionPolicy,
  runTurn,
  newSessionId,
  createStubModel,
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
  console.log("\n-- 1. Approval registry CRUD/listing --");
  const req = await requestApproval({
    agentId: "approvals-test-agent",
    sessionId: "some-session",
    toolName: "shell",
    args: { command: "rm -rf /important" },
    reason: "test-triggered request",
  });
  assert(req.status === "pending", "a newly requested approval starts 'pending'");

  const fetched = await getApproval(req.id);
  assert(fetched?.id === req.id, "getApproval() finds the just-created request");

  const pending = await listApprovals({ status: "pending", agentId: "approvals-test-agent" });
  assert(
    pending.some((a) => a.id === req.id),
    "listApprovals({status:'pending', agentId}) includes the new request",
  );

  const approved = await approveRequest(req.id, { resolvedBy: "test-human", note: "looks fine" });
  assert(approved.status === "approved", "approveRequest() transitions to 'approved'");
  assert(approved.resolvedBy === "test-human", "resolvedBy is recorded");
  assert(approved.resolutionNote === "looks fine", "resolutionNote is recorded");

  const stillPending = await listApprovals({ status: "pending", agentId: "approvals-test-agent" });
  assert(
    !stillPending.some((a) => a.id === req.id),
    "the now-approved request no longer shows up in a 'pending' filter",
  );
}

async function testTerminalStatusSticks(): Promise<void> {
  console.log("\n-- 2. Resolved approvals cannot be re-resolved --");
  const req = await requestApproval({
    agentId: "approvals-test-agent",
    sessionId: "some-session",
    toolName: "shell",
    args: {},
    reason: "test",
  });
  await rejectRequest(req.id, { resolvedBy: "test-human" });

  await assertThrows(
    () => approveRequest(req.id),
    "approving an already-rejected request throws instead of silently flipping its status",
  );
  await assertThrows(
    () => rejectRequest(req.id),
    "rejecting an already-rejected request throws too",
  );

  const unknown = await getApproval("no-such-id");
  assert(unknown === undefined, "getApproval() on an unknown id returns undefined");
  await assertThrows(() => approveRequest("no-such-id"), "approving an unknown id throws");
}

async function testAskWithoutOnAskCreatesDurableApproval(): Promise<void> {
  console.log("\n-- 3. 'ask' with no onAsk callback creates a durable ApprovalRequest --");
  const agentId = "approvals-demo-no-onask";
  installPermissionPolicy({
    agentId,
    rules: [{ tool: "shell", decision: "ask" }],
    // no onAsk — this is the durable-approval path
  });

  const sessionId = newSessionId();
  const result = await runTurn({
    sessionId,
    agentId,
    userMessage: "run shell: echo hi",
    model: createStubModel(),
    worker: createStubWorker(),
  });

  assert(
    /blocked pending approval/i.test(result.finalContent),
    `the tool call is blocked with a reference to the pending approval (got: "${result.finalContent}")`,
  );

  const pending = await listApprovals({ status: "pending", agentId, sessionId });
  assert(pending.length === 1, `exactly one durable ApprovalRequest was created (got ${pending.length})`);
  assert(pending[0]!.toolName === "shell", "the recorded request names the correct tool");
}

async function testAskWithOnAskStaysSynchronousAndDurable(): Promise<void> {
  console.log("\n-- 4. 'ask' WITH an onAsk callback stays synchronous, no ApprovalRequest created --");
  const agentId = "approvals-demo-with-onask";
  let onAskCalls = 0;
  installPermissionPolicy({
    agentId,
    rules: [{ tool: "shell", decision: "ask" }],
    onAsk: async () => {
      onAskCalls++;
      return true; // allow synchronously
    },
  });

  const sessionId = newSessionId();
  const result = await runTurn({
    sessionId,
    agentId,
    userMessage: "run shell: echo hi",
    model: createStubModel(),
    worker: createStubWorker(),
  });

  assert(onAskCalls === 1, `the synchronous onAsk callback was invoked exactly once (got ${onAskCalls})`);
  assert(!/blocked pending approval/i.test(result.finalContent), "no durable-approval block message appears");

  const anyForSession = await listApprovals({ agentId, sessionId });
  assert(anyForSession.length === 0, "no ApprovalRequest was created when a synchronous onAsk callback handled it");
}

async function main(): Promise<void> {
  await testRegistryBasics();
  await testTerminalStatusSticks();
  await testAskWithoutOnAskCreatesDurableApproval();
  await testAskWithOnAskStaysSynchronousAndDurable();

  if (process.exitCode === 1) {
    console.error("\nSome approvals tests FAILED.");
  } else {
    console.log("\nAll approvals tests passed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
