// End-to-end scenario, driven the way BaseSpace drives the gateway: over HTTP and the live
// event stream only, never importing runtime code for the actions themselves.
//
//   1. connect (health + the shared event stream)
//   2. create a session, send a message
//   3. watch a tool call arrive live
//   4. the lead designs a flow; Argus checks it; an approval is requested (live)
//   5. the operator approves
//   6. the flow runs: child steps on other agents, tools, an artifact, the result
//   7. the flow and its tasks show in the task graph
//   8. the session is reopened after a full gateway restart: history, the outcome note and
//      the flow are still there, and the conversation continues
//   9. a long step is cancelled mid-run over HTTP and stops promptly
// Run with: node dist/test-e2e-scenario.js

import "./test-helpers/isolate.js";
import path from "node:path";
import { SkillRegistry, createStubWorker, createLocalShellWorker, saveSnapshot, seedDefaultAgents, type ModelAdapter, type ModelResponse } from "./core/index.js";
import { startGateway } from "./gateway/server.js";

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`ok: ${msg}`);
  else {
    failed = true;
    console.log(`FAIL: ${msg}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** "call {json}" → that tool call; otherwise echoes its input, so each step's input shows in its output. */
const scripted: ModelAdapter = {
  id: "scripted",
  async complete(messages, opts): Promise<ModelResponse> {
    const last = messages[messages.length - 1]!;
    if (opts?.signal?.aborted) throw new Error("aborted");
    if (last.role === "user" && last.content.startsWith("call ")) {
      const end = last.content.indexOf("\n");
      const call = JSON.parse(last.content.slice(5, end < 0 ? undefined : end));
      return { content: "", toolCall: { name: call.name, args: call.args } };
    }
    return { content: last.role === "tool" ? `ok (${last.content.slice(0, 60)})` : `did: ${last.content}` };
  },
};

const skillsDir = path.join(process.env.AGENT_OS_DATA_DIR!, "skills");
const start = async () =>
  startGateway({
    model: scripted,
    worker: createLocalShellWorker(),
    skills: await SkillRegistry.fromDirectory(skillsDir),
    skillsDir,
    enableBaseSpace: true,
    enableArtifacts: true,
    maxToolHops: 5,
  });

/** A client of the gateway's shared event stream, collecting named events. */
function watchEvents(base: string) {
  const seen: { type: string; data: any }[] = [];
  const ctl = new AbortController();
  void (async () => {
    const res = await fetch(`${base}/events`, { signal: ctl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const type = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (type && data) seen.push({ type, data: JSON.parse(data) });
      }
    }
  })().catch(() => {});
  return {
    seen,
    has: (type: string, pred: (d: any) => boolean = () => true) => seen.some((e) => e.type === type && pred(e.data)),
    close: () => ctl.abort(),
  };
}
async function until(cond: () => Promise<boolean> | boolean, ms = 15_000): Promise<boolean> {
  for (const t0 = Date.now(); Date.now() - t0 < ms; ) {
    if (await cond()) return true;
    await sleep(50);
  }
  return false;
}

await seedDefaultAgents();
await saveSnapshot({ schema: 1, goals: [{ id: "g-release", title: "Release the next single", status: "active" }] });

let gateway = await start();
let base = `http://127.0.0.1:${gateway.port}`;
const api = async (method: string, route: string, body?: unknown) => {
  const res = await fetch(`${base}${route}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
};
const call = (name: string, args: unknown) => `call ${JSON.stringify({ name, args })}`;

try {
  // 1. connect
  assert((await api("GET", "/health")).json.ok === true, "1. the client connects (health ok)");
  const events = watchEvents(base);
  await sleep(150);

  // 2. session + message
  const created = await api("POST", "/sessions", { agentId: "hemera", focus: { kind: "goal", id: "g-release" } });
  const sid: string = created.json.id;
  assert(created.status === 201 && !!sid, "2. a session is created for the lead");
  const hello = await api("POST", `/sessions/${sid}/turns`, { userMessage: "hi, let's plan the release" });
  assert(hello.status === 200 && /did: hi/.test(hello.json.finalContent), "2. a message gets a reply");

  // 3. a tool call, seen live
  await api("POST", `/sessions/${sid}/turns`, { userMessage: call("basespace", { section: "summary" }) });
  assert(await until(() => events.has("tool.call.start", (d) => d.name === "basespace") && events.has("tool.call.end", (d) => d.name === "basespace")), "3. the tool call is visible on the live stream (start and end)");

  // 4. the lead designs a flow; Argus checks it; approval requested
  const flowArgs = {
    summary: "Research both sides at once, then write, then review.",
    goalId: "g-release",
    steps: [
      { id: "market", agent: "nyx", goal: call("record-artifact", { type: "report", location: "notes://market-research", description: "Market notes" }) },
      { id: "audience", agent: "aether", goal: "Audience side: find out who the next single is for and write it down." },
      { id: "write", agent: "hermes", goal: "Write the one-page release plan from both research results.", dependsOn: ["market", "audience"] },
      { id: "review", agent: "argus", goal: "Review the plan against what the research actually said.", dependsOn: ["write"] },
    ],
  };
  const proposed = await api("POST", `/sessions/${sid}/turns`, { userMessage: call("propose-flow", flowArgs) });
  assert(proposed.json.stopReason === "tool-blocked", "4. the flow proposal stops the lead's turn, waiting for approval");
  assert(await until(() => events.has("approval.requested", (d) => d.toolName === "propose-flow")), "4. the approval request arrives live");
  const pending = (await api("GET", "/approvals?status=pending")).json.approvals.filter((a: any) => a.toolName === "propose-flow");
  assert(pending.length === 1 && /argus checked it: no problems found/.test(pending[0].reason), "4. the request shows Argus's verdict");
  assert((await api("GET", "/flows")).json.flows.length === 0, "4. nothing runs before approval");

  // 5. approve
  const approved = await api("POST", `/approvals/${pending[0].id}/approve`, { resolvedBy: "operator" });
  assert(approved.status === 200, "5. the operator approves");

  // 6. the flow runs
  assert(await until(async () => (await api("GET", "/flows")).json.flows.length === 1), "6. the flow starts");
  const flowId: string = (await api("GET", "/flows")).json.flows[0].id;
  assert(await until(async () => (await api("GET", `/flows/${flowId}`)).json.status === "succeeded"), "6. all steps run and the flow succeeds");
  assert(events.has("flow.completed", (d) => d.flowId === flowId && d.status === "succeeded"), "6. completion is announced on the stream");
  assert(["market", "audience", "write", "review"].every((s) => events.has("flow.step.completed", (d) => d.stepId === s && d.flowId === flowId)), "6. every step reported completing");

  // 7. task graph
  const flow = (await api("GET", `/flows/${flowId}`)).json;
  assert(flow.steps.length === 4 && flow.steps.every((s: any) => s.status === "succeeded" && s.taskId), "7. the flow's graph has four succeeded steps, each with a task");
  const tasks = (await api("GET", "/tasks")).json.tasks.filter((t: any) => t.flowId === flowId);
  assert(tasks.length === 4 && new Set(tasks.map((t: any) => t.agentId)).size === 4, "7. four flow-step tasks, each on a different agent");
  const writeTask = tasks.find((t: any) => t.input?.stepId === "write");
  assert(/Result of step "market"/.test(String(writeTask?.output?.finalContent)), "7. the writer was given the research results");
  const artifacts = (await api("GET", "/artifacts?producer=nyx")).json.artifacts;
  assert(artifacts.some((a: any) => a.location === "notes://market-research" && a.type === "report"), "7. the artifact a step produced is listed");
  assert(await until(async () => (await api("GET", `/sessions/${sid}/history`)).json.history.some((m: any) => /^\[Flow\].*finished as succeeded/.test(m.content))), "7. the outcome is posted back into the lead's session");

  // 8. reopen after a full restart
  events.close();
  await gateway.stop();
  gateway = await start();
  base = `http://127.0.0.1:${gateway.port}`;
  const reopened = await api("GET", `/sessions/${sid}`);
  assert(reopened.status === 200 && reopened.json.agentId === "hemera", "8. after a restart the session is still there");
  const history = (await api("GET", `/sessions/${sid}/history`)).json.history;
  assert(history.some((m: any) => /^\[Flow\]/.test(m.content)) && history.some((m: any) => m.role === "tool"), "8. its history, tool calls and the flow's outcome survived");
  assert((await api("GET", `/flows/${flowId}`)).json.status === "succeeded", "8. the flow's state survived");
  assert((await api("GET", "/approvals?status=approved")).json.approvals.some((a: any) => a.toolName === "propose-flow"), "8. the approval decision survived");
  const again = await api("POST", `/sessions/${sid}/turns`, { userMessage: "thanks, what happened?" });
  assert(again.status === 200 && !again.json.cancelled, "8. the conversation continues in the reopened session");

  // 9. cancel a long step mid-run, over HTTP
  const s2 = (await api("POST", "/sessions", { agentId: "claude" })).json.id;
  const started = Date.now();
  const longTurn = api("POST", `/sessions/${s2}/turns`, { userMessage: call("shell", { command: 'node -e "setTimeout(()=>{},30000)"' }) });
  await sleep(700);
  const cancelled = await api("POST", `/sessions/${s2}/cancel`, {});
  const turnResult = await longTurn;
  assert(cancelled.status === 200 && turnResult.json.cancelled === true && Date.now() - started < 8000, `9. cancelling over HTTP stops the running command (${Date.now() - started} ms, not 30000)`);
} finally {
  await gateway.stop();
}
console.log(failed ? "\nSome end-to-end scenario tests FAILED." : "\nAll end-to-end scenario tests passed.");
process.exit(failed ? 1 : 0);
