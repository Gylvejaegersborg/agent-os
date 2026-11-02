// Tests that cancelling a session stops the step that is running, not just the next one.
// Proves:
//   1. A model call in flight: the turn ends within a moment of the cancel, even when the
//      adapter ignores the abort signal (the turn stops waiting), and an adapter that
//      honors it really sees the signal abort (that's what cancels its fetch / CLI process).
//   2. A long shell command in flight is killed, not waited out.
//   3. Nothing new starts after the cancel (no further model call).
//   4. A cancelled turn is reported as cancelled, not as an error, and a normal turn still works.
// Run with: node dist/test-cancel-inflight.js

import "./test-helpers/isolate.js";
import { cancelSession, createLocalShellWorker, createSession, runTurn, type ModelAdapter, type ModelResponse } from "./core/index.js";

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`ok: ${msg}`);
  else {
    failed = true;
    console.log(`FAIL: ${msg}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function cancelAfter(ms: number, run: (sessionId: string) => Promise<Awaited<ReturnType<typeof runTurn>>>) {
  const session = await createSession({ agentId: "claude" });
  const started = Date.now();
  const turn = run(session.id);
  await sleep(ms);
  await cancelSession(session.id, "test cancel");
  const result = await turn;
  return { result, took: Date.now() - started, sessionId: session.id };
}

// 1a. A model that takes 8 s and ignores the signal.
let calls = 0;
const deaf: ModelAdapter = {
  id: "deaf",
  async complete(): Promise<ModelResponse> {
    calls++;
    await sleep(8000);
    return { content: "late answer" };
  },
};
const a = await cancelAfter(300, (sessionId) => runTurn({ sessionId, agentId: "claude", userMessage: "hello", model: deaf, worker: createLocalShellWorker() }));
assert(a.result.cancelled === true && a.result.stopReason === "cancelled", "a turn cancelled during a model call reports cancelled");
assert(a.took < 2500, `…and stops promptly even though the model ignores the signal (${a.took} ms, not 8000)`);
assert(!a.result.finalContent.startsWith("⚠"), "…and it isn't reported as an error");

// 1b. A model that honors the signal: it must actually see it abort.
let sawAbort = false;
const polite: ModelAdapter = {
  id: "polite",
  complete(_m, opts) {
    return new Promise<ModelResponse>((_res, rej) => {
      opts?.signal?.addEventListener("abort", () => {
        sawAbort = true;
        rej(new Error("aborted by signal"));
      });
    });
  },
};
const b = await cancelAfter(200, (sessionId) => runTurn({ sessionId, agentId: "claude", userMessage: "hello", model: polite, worker: createLocalShellWorker() }));
assert(sawAbort && b.result.cancelled === true && b.took < 2000, `an adapter that honors the signal sees it abort (${b.took} ms)`);

// 2. A shell command that would run for 30 s; the model asks for it, the operator cancels.
let shellCalls = 0;
const shellModel: ModelAdapter = {
  id: "shell-asker",
  async complete(): Promise<ModelResponse> {
    shellCalls++;
    if (shellCalls === 1) return { content: "", toolCall: { name: "shell", args: { command: 'node -e "setTimeout(()=>{},30000)"' } } };
    return { content: "should never get here after a cancel" };
  },
};
const c = await cancelAfter(800, (sessionId) => runTurn({ sessionId, agentId: "claude", userMessage: "run the long thing", model: shellModel, worker: createLocalShellWorker(), maxToolHops: 5 }));
assert(c.result.cancelled === true && c.took < 6000, `a running shell command is killed on cancel (${c.took} ms, not 30000)`);
assert(shellCalls === 1, "no further model call starts after the cancel");

// 3. An ordinary turn is unaffected.
const fine: ModelAdapter = { id: "fine", complete: async () => ({ content: "all good" }) };
const s = await createSession({ agentId: "claude" });
const ok = await runTurn({ sessionId: s.id, agentId: "claude", userMessage: "hi", model: fine, worker: createLocalShellWorker() });
assert(ok.finalContent === "all good" && !ok.cancelled, "a normal turn still completes");
assert(calls === 1, "the slow model was only called once");

console.log(failed ? "\nSome cancel-inflight tests FAILED." : "\nAll cancel-inflight tests passed.");
process.exit(failed ? 1 : 0);
