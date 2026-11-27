import "./test-helpers/isolate.js";
import { requestUi, respondUi, listApprovals } from "./core/index.js";

function assert(cond: boolean, message: string): void {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

async function main(): Promise<void> {
  const timeout = await requestUi({
    sessionId: "ui-test-session",
    turnId: "ui-test-turn",
    operation: "query",
    timeoutMs: 1000,
    source: "agent",
    input: { text: "closed tabs" },
  });
  assert(timeout.ok === false && timeout.outcome === "timeout", "UI request timeout returns a structured outcome");
  assert(respondUi("missing-request", { ok: true, result: {} }) === false, "unknown UI response is rejected");
  assert((await listApprovals({ status: "pending" })).every((approval) => approval.toolName !== "ui.act"), "safe snapshot/query test does not create UI action approvals");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
