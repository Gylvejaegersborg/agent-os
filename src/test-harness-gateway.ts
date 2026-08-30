// Standalone test for Phase 2-3 of the Harness build (see
// AGENT-HARNESS-IMPLEMENTATION-PLAN.md §83-84): proves the literal "done
// when" criteria for both phases against a REAL WebSocket server on an
// ephemeral port and a REAL client socket — no mocking of the transport
// layer, matching this codebase's existing test-webhook.ts pattern (real
// HTTP server, real fetch calls).
//
// Phase 2 "done when": "A little Node test can connect -> create session
// -> send message -> receive stream."
// Phase 3 "done when": "CLI/WebSocket-client can send hello and get real
// model response back."
//
// Uses the deterministic stub model (createStubModel) — this proves the
// WIRING is correct end-to-end (gateway -> runTurn -> model.complete ->
// event broadcast -> client), independent of whether a real API key is
// configured anywhere, exactly the same "prove the primitive with zero
// external dependencies" posture as the rest of this scaffold's test
// suites.

import "./test-helpers/isolate.js";
import { WebSocket } from "ws";
import { startHarnessGateway } from "./harness/gateway.js";
import { createStubModel } from "./core/model.js";
import { createStubWorker } from "./core/worker.js";
import { listTasks, registerAutomation } from "./core/tasks.js";
import type { HarnessServerEvent, HarnessClientEvent } from "./harness/protocol.js";

let passed = 0;
let failed = 0;
function ok(label: string, cond: boolean): void {
  if (cond) {
    passed++;
    console.log(`ok: ${label}`);
  } else {
    failed++;
    console.log(`FAIL: ${label}`);
  }
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function send(ws: WebSocket, cmd: HarnessClientEvent): void {
  ws.send(JSON.stringify(cmd));
}

/** Collects server events on a socket into an array, and resolves a
 *  promise the first time a predicate matches — used to wait for a
 *  specific event type without a fixed sleep. */
function waitFor(ws: WebSocket, predicate: (e: HarnessServerEvent) => boolean, timeoutMs = 5000): Promise<HarnessServerEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`waitFor timed out after ${timeoutMs}ms`)), timeoutMs);
    const handler = (raw: Buffer) => {
      const evt = JSON.parse(raw.toString()) as HarnessServerEvent;
      if (predicate(evt)) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(evt);
      }
    };
    ws.on("message", handler);
  });
}

async function main() {
  const model = createStubModel();
  const worker = createStubWorker();
  const gateway = startHarnessGateway({ model, worker }, { port: 0 });
  await gateway.ready;

  // port: 0 asks the OS for an ephemeral free port (same pattern
  // test-webhook.ts already uses) — read the actual assigned port back
  // off the underlying http server.
  const address = gateway.wss.address();
  const port = typeof address === "object" && address ? address.port : 0;
  ok("gateway bound to a real ephemeral port", port > 0);

  const ws = await connect(port);
  ok("client socket connected", ws.readyState === ws.OPEN);

  // ---- hello -> harness.ready ----
  send(ws, { type: "hello", client: "test-client", version: 1 });
  const ready = await waitFor(ws, (e) => e.type === "harness.ready");
  ok("hello command receives harness.ready", ready.type === "harness.ready");
  if (ready.type === "harness.ready") {
    ok("harness.ready reports the sessions capability", ready.payload.capabilities.includes("sessions"));
  }

  // ---- session.create -> session.created ----
  send(ws, { type: "session.create", agentId: "claude" });
  const created = await waitFor(ws, (e) => e.type === "session.created");
  ok("session.create receives session.created", created.type === "session.created");
  const sessionId = created.type === "session.created" ? created.sessionId! : "";
  ok("session.created carries a real sessionId", sessionId.length > 0);

  // ---- send.message -> message.start -> message.delta* -> message.end
  // (Phase 2's literal "connect -> create session -> send message ->
  // receive stream" criterion, now proving REAL multi-chunk streaming
  // per Phase 4 rather than one big delta) ----
  const startEventP = waitFor(ws, (e) => e.type === "agent.message.start");
  send(ws, { type: "send.message", sessionId, agentId: "claude", text: "Hello" });

  const startEvent = await startEventP;
  ok("send.message triggers agent.message.start", startEvent.type === "agent.message.start");

  // Collect every delta AND the end event on the same listener so no
  // delta arriving between separate waitFor() calls is ever missed —
  // this is exactly the multi-chunk case Phase 4 introduced (the stub
  // model's response now arrives as several word-chunked deltas via
  // model.ts's streamFromComplete(), not a single big one).
  const deltas: string[] = [];
  const endEvent = await new Promise<HarnessServerEvent>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for message.end")), 5000);
    const handler = (raw: Buffer) => {
      const evt = JSON.parse(raw.toString()) as HarnessServerEvent;
      if (evt.type === "agent.message.delta") deltas.push(evt.payload.delta);
      if (evt.type === "agent.message.end") {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(evt);
      }
    };
    ws.on("message", handler);
  });

  ok("send.message triggers at least one agent.message.delta", deltas.length > 0);
  ok(
    "the deltas concatenate into the stub model's real response content",
    deltas.join("").includes("Hello"),
  );
  ok(
    "streaming produced MORE THAN ONE delta chunk (real multi-chunk streaming, not one big blob)",
    deltas.length > 1,
  );

  ok("send.message triggers agent.message.end", endEvent.type === "agent.message.end");
  ok(
    "message.start and message.end share the same messageId",
    startEvent.type === "agent.message.start" &&
      endEvent.type === "agent.message.end" &&
      startEvent.payload.messageId === endEvent.payload.messageId,
  );
  ok(
    "message.end's finalContent matches the concatenated deltas",
    endEvent.type === "agent.message.end" && endEvent.payload.finalContent === deltas.join(""),
  );

  // ---- session.sync round-trip: proves the message we just sent is
  // recoverable from the event log, not just visible on the live stream
  // (this is what makes reload/reconnect work, per plan §73) ----
  send(ws, { type: "session.sync", sessionId });
  const state = await waitFor(ws, (e) => e.type === "session.state");
  ok("session.sync receives session.state", state.type === "session.state");
  if (state.type === "session.state") {
    const hasUserMessage = state.payload.messages.some((m) => m.kind === "user-message" && m.text === "Hello");
    const hasAgentMessage = state.payload.messages.some((m) => m.kind === "agent-message");
    ok("session.state's message history includes the user's message", hasUserMessage);
    ok("session.state's message history includes the agent's reply", hasAgentMessage);
  }

  // ---- session.sync on an UNKNOWN session id -> harness.error, not a
  // silent empty success (proves the "reject bogus session ids" path) ----
  const errorP = waitFor(ws, (e) => e.type === "harness.error");
  send(ws, { type: "session.sync", sessionId: "does-not-exist" });
  const errorEvent = await errorP;
  ok("session.sync on an unknown session id returns harness.error", errorEvent.type === "harness.error");
  if (errorEvent.type === "harness.error") {
    ok("the error is marked recoverable", errorEvent.payload.recoverable === true);
  }

  // ---- task.create -> task.created, and a real Task actually lands in
  // the ledger (not just an event with no backing Task) ----
  const taskCreatedP = waitFor(ws, (e) => e.type === "task.created");
  send(ws, { type: "task.create", agentId: "claude", input: { goal: "investigate structure" } });
  const taskCreated = await taskCreatedP;
  ok("task.create receives task.created", taskCreated.type === "task.created");
  if (taskCreated.type === "task.created") {
    const tasks = await listTasks({ agentId: "claude" });
    ok("the created task is really in the ledger", tasks.some((t) => t.id === taskCreated.taskId));
  }

  // ---- automations.list -> automations.snapshot, reflecting a real
  // registered automation ----
  const automation = await registerAutomation({
    trigger: { kind: "cron", expr: "0 8 * * *" },
    agentId: "claude",
    promptTemplate: "Morning brief",
    enabled: true,
  });
  send(ws, { type: "automations.list" });
  const snapshot = await waitFor(ws, (e) => e.type === "automations.snapshot");
  ok("automations.list receives automations.snapshot", snapshot.type === "automations.snapshot");
  if (snapshot.type === "automations.snapshot") {
    ok("the snapshot includes the automation just registered", snapshot.payload.automations.some((a) => a.id === automation.id));
  }

  // ---- Not-yet-implemented commands report an honest harness.error
  // rather than pretending to work (Phase 9/10/14 aren't built yet) ----
  const terminalErrorP = waitFor(ws, (e) => e.type === "harness.error");
  send(ws, { type: "terminal.create", cols: 80, rows: 24 });
  const terminalError = await terminalErrorP;
  ok(
    "an unimplemented command (terminal.create) returns harness.error, not a fake success",
    terminalError.type === "harness.error" && terminalError.payload.code === "NOT_IMPLEMENTED",
  );

  // ---- Multi-client broadcast: a SECOND socket subscribed to the same
  // session sees the same live event a first socket triggers — proves
  // this isn't just point-to-point, matching plan §21's "Right Rail
  // updates live" requirement for any connected client. ----
  const ws2 = await connect(port);
  send(ws2, { type: "session.subscribe", sessionId });
  const secondClientSeesIt = waitFor(ws2, (e) => e.type === "agent.message.end");
  send(ws, { type: "send.message", sessionId, agentId: "claude", text: "Second message" });
  const seenByOther = await secondClientSeesIt;
  ok("a second subscribed socket receives events for the same session", seenByOther.type === "agent.message.end");

  ws.close();
  ws2.close();
  await gateway.stop();
  ok("gateway.stop() resolves cleanly", true);

  console.log("");
  if (failed === 0) {
    console.log(`All harness gateway tests passed (${passed}/${passed}).`);
  } else {
    console.log(`${failed} harness gateway test(s) FAILED (${passed} passed).`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("test-harness-gateway crashed:", err);
  process.exit(1);
});
