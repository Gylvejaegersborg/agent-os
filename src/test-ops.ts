// Tests the Ops report (gateway/ops.ts): real data only.
// Proves: the report has the real process and machine facts; a failed task, a blocked work item and a failed flow show up as problems
// (and an old failure does not); logs and Tailscale are read when present and are an error/absent (never a placeholder) when not;
// the route answers.
// Run with: node dist/test-ops.js

import "./test-helpers/isolate.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// a log dir with a supervisor log (one fresh restart, one old) and an error log, set before the module reads it
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-ops-"));
const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
fs.writeFileSync(path.join(dir, "supervisor.log"), `${fmt(new Date(Date.now() - 5 * 86_400_000))} gateway exited (code ) - restarting\n${fmt(new Date(Date.now() - 3600_000))} gateway exited (code ) - restarting\n`);
fs.writeFileSync(path.join(dir, "gateway.log"), "[gateway] listening\n\u001b[32mgreen line\u001b[0m\n");
fs.writeFileSync(path.join(dir, "gateway.err.log"), "Error: something broke\n");
process.env.AGENT_OS_LOG_DIR = dir;
process.env.TAILSCALE_CLI = path.join(dir, "no-such-tailscale");

const { buildOps } = await import("./gateway/ops.js");
const { createTask, transitionTask, createFlow, createStubModel, createStubWorker, createWork } = await import("./core/index.js");
const { startGateway } = await import("./gateway/server.js");

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`ok: ${msg}`);
  else {
    failed = true;
    console.log(`FAIL: ${msg}`);
  }
}

// things that went wrong
const bad = await createTask({ type: "flow-step", agentId: "nyx", input: {} });
await transitionTask(bad.id, "running");
await transitionTask(bad.id, "failed", { output: { error: "the agent ran out of tool steps" } });
const fine = await createTask({ type: "flow-step", agentId: "aether", input: {} });
await transitionTask(fine.id, "running");
await transitionTask(fine.id, "succeeded", { output: {} });
await createWork({ title: "Fix the FAQ", assignee: "nyx", requestedBy: "operator" }).catch(() => undefined);

const r = await buildOps();
assert(r.gateway.pid === process.pid && r.gateway.node === process.version && r.gateway.uptimeSec >= 0 && r.gateway.memoryMB > 0, "the gateway section is this process");
assert(r.host.name === os.hostname() && r.host.memTotalMB > 0 && r.host.cpus === os.cpus().length && (r.host.cpuPercent === null || (r.host.cpuPercent >= 0 && r.host.cpuPercent <= 100)), "the host section is this machine (memory, cpus, a CPU percent that is a real percentage)");
assert(r.host.dataMB !== null && r.host.dataMB >= 0, "the data size is measured");
assert(r.services[0]!.id === "gateway" && r.services[0]!.state === "up" && r.services.some((s) => s.id === "hindsight" && s.state === "unconfigured"), "services: the gateway is up; Hindsight says it is not configured (no HINDSIGHT_URL), not 'up'");
assert("error" in r.tailscale && /tailscale/.test(r.tailscale.error), "an unavailable Tailscale CLI is an error message, not a made-up device list");
const task = r.problems.find((p) => p.kind === "task");
assert(!!task && task.severity === "error" && /out of tool steps/.test(task.text) && task.source.startsWith("nyx") && !r.problems.some((p) => p.id === `task:${fine.id}`), "a failed task is a problem with its reason; a successful one is not");
assert(r.problems.filter((p) => p.kind === "supervisor").length === 1 && /restarting/.test(r.problems.find((p) => p.kind === "supervisor")!.text), "a supervisor restart in the last two days is a problem; one from five days ago is not");
assert(r.problems.some((p) => p.kind === "log" && /something broke/.test(p.text)), "a line in the gateway's error log is a problem");
assert(r.logs.dir === dir && r.logs.gateway.includes("green line") && !r.logs.gateway.some((l) => l.includes("\u001b")) && r.logs.supervisor.length === 2 && r.logs.gatewayErrors.length === 1, "the logs are the tails of the real files, with colour codes stripped");

// no log dir: absent, not invented
process.env.AGENT_OS_LOG_DIR = path.join(dir, "missing");
await new Promise((res) => setTimeout(res, 4200)); // the report is cached for 4 s
const r2 = await buildOps();
assert(r2.logs.dir === undefined && r2.logs.gateway.length === 0 && !r2.problems.some((p) => p.kind === "supervisor" || p.kind === "log"), "with no log directory there are no log lines and no log problems (nothing is invented)");

// the route
const gateway = await startGateway({ model: createStubModel(), worker: createStubWorker() });
try {
  const res = await fetch(`http://127.0.0.1:${gateway.port}/ops`);
  const body = (await res.json()) as { gateway?: { pid?: number }; problems?: unknown[] };
  assert(res.status === 200 && body.gateway?.pid === process.pid && Array.isArray(body.problems), "GET /ops answers with the report");
} finally {
  await gateway.stop();
}
void createFlow;

console.log(failed ? "\nSome ops tests FAILED." : "\nAll ops tests passed.");
process.exit(failed ? 1 : 0);
