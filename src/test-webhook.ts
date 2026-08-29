// Standalone tests for the webhook listener (webhook.ts) — starts a REAL
// HTTP server on an ephemeral port and makes REAL fetch() requests
// against it, proving the whole path/matching/firing/response-code chain
// end to end rather than just unit-testing fireWebhookAutomations() in
// isolation. Run with: node dist/test-webhook.js

import {
  startWebhookServer,
  registerAutomation,
  createStubModel,
  createStubWorker,
  listTasks,
} from "./core/index.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

async function main(): Promise<void> {
  const agentId = "webhook-test-agent";
  await registerAutomation({
    trigger: { kind: "webhook", path: "/hooks/deploy" },
    agentId,
    promptTemplate: "A deploy webhook fired — summarize it.",
    enabled: true,
  });
  await registerAutomation({
    trigger: { kind: "webhook", path: "/hooks/disabled" },
    agentId,
    promptTemplate: "This automation is disabled and should never fire.",
    enabled: false,
  });

  const deps = { model: createStubModel(), worker: createStubWorker() };
  const handle = await startWebhookServer(deps, 0); // port 0 = OS picks a free ephemeral port
  console.log(`Webhook server listening on http://127.0.0.1:${handle.port}`);

  try {
    // 1. A request to a registered, enabled webhook path fires the automation.
    const tasksBefore = await listTasks({ agentId });
    const res1 = await fetch(`http://127.0.0.1:${handle.port}/hooks/deploy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commit: "abc123" }),
    });
    assert(res1.status === 200, `POST to a registered webhook path returns 200 (got ${res1.status})`);
    const body1 = (await res1.json()) as { fired: Array<{ automationId: string; taskId: string }> };
    assert(Array.isArray(body1.fired) && body1.fired.length === 1, "response body reports exactly one fired automation");
    const tasksAfter = await listTasks({ agentId });
    assert(tasksAfter.length === tasksBefore.length + 1, "a real HTTP request to the webhook path creates a real Task");

    // 2. A request to an unregistered path returns 404, not a silent success.
    const res2 = await fetch(`http://127.0.0.1:${handle.port}/hooks/does-not-exist`, { method: "POST" });
    assert(res2.status === 404, `POST to an unregistered webhook path returns 404 (got ${res2.status})`);

    // 3. A request to a DISABLED automation's path also returns 404 (no
    // enabled automation matches), not a silent 200 that does nothing.
    const res3 = await fetch(`http://127.0.0.1:${handle.port}/hooks/disabled`, { method: "POST" });
    assert(res3.status === 404, `POST to a disabled automation's path returns 404, not a silent success (got ${res3.status})`);

    // 4. Any HTTP method matches (path-only matching, per file header) —
    // a GET to the same registered path should still fire it.
    const tasksBeforeGet = await listTasks({ agentId });
    const res4 = await fetch(`http://127.0.0.1:${handle.port}/hooks/deploy`, { method: "GET" });
    assert(res4.status === 200, `GET to the same registered path also fires (path-only matching) (got ${res4.status})`);
    const tasksAfterGet = await listTasks({ agentId });
    assert(tasksAfterGet.length === tasksBeforeGet.length + 1, "the GET request created another real Task");

    // 5. Non-JSON body doesn't crash the server — it's passed through as rawBody.
    const res5 = await fetch(`http://127.0.0.1:${handle.port}/hooks/deploy`, {
      method: "POST",
      body: "not valid json {{{",
    });
    assert(res5.status === 200, `a non-JSON request body does not crash the handler (got ${res5.status})`);
  } finally {
    await handle.stop();
  }

  if (process.exitCode === 1) {
    console.error("\nSome webhook tests FAILED.");
  } else {
    console.log("\nAll webhook tests passed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
