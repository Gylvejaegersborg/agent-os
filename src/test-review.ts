// Tests for team reviews: the digest (core/review.ts), the lead's `work`
// actions (reopen / reassign / escalate, with who-may rules in work.ts), and
// the review runner + routes (gateway/review-loop.ts, server.ts). A scripted
// model stands in for Hemera.
// Proves:
//   1. The digest finds blocked, handed-back and quiet work for a lead's
//      team; escalated items are shown but don't need attention again.
//   2. Only the requester, the assignee's manager or the operator may
//      reopen, reassign or escalate; an assignee still can't cancel.
//   3. A review turn runs only when something needs attention AND changed
//      since the last review; the operator can force one; automatic ones
//      are capped per day; a paused lead is skipped.
//   4. The lead acts through the `work` tool in one long-lived session.
//   5. GET /reviews, GET /reviews/:id/digest, POST /reviews/:id.
// Run with: node dist/test-review.js

import "./test-helpers/isolate.js";
process.env.CLAUDE_CLI_PATH = "/nonexistent/claude"; // no real providers in this test

import {
  OPERATOR,
  blockWork,
  cancelWork,
  claimWork,
  createStubWorker,
  createWork,
  escalateWork,
  getWork,
  handBackWork,
  listReviews,
  listWork,
  pauseAgent,
  reassignWork,
  reopenWork,
  resumeAgent,
  reviewDigest,
  seedDefaultAgents,
  type ModelAdapter,
  type ModelMessage,
  type ModelResponse,
} from "./core/index.js";
import { startGateway } from "./gateway/server.js";
import { runReview, startReviewLoop } from "./gateway/review-loop.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

async function throwsWith(p: Promise<unknown>, re: RegExp): Promise<boolean> {
  try {
    await p;
    return false;
  } catch (err) {
    return re.test(String(err));
  }
}

const prompts: string[] = [];
let act = true;
/** A review prompt: reopen the first blocked item with guidance, then sum
 *  up. With `act` off it only answers. */
const scripted: ModelAdapter = {
  id: "scripted",
  async complete(messages: ModelMessage[]): Promise<ModelResponse> {
    const usage = { inputTokens: 10, outputTokens: 5 };
    const last = messages[messages.length - 1]!;
    if (last.role === "tool") return { content: "Reopened the caption job with a brief. Nothing needs you.", usage };
    if (last.content.startsWith("[Review]")) {
      prompts.push(last.content);
      const blocked = /Blocked:\n- (\S+)/.exec(last.content)?.[1];
      if (act && blocked) return { content: "", toolCall: { name: "work", args: { action: "reopen", id: blocked, text: "Use the Switch brief in Notes." } }, usage };
      return { content: "Looked it over; nothing to change.", usage };
    }
    return { content: "ok", usage };
  },
};
const deps = { model: scripted, worker: createStubWorker() };

async function testDigestAndRules(): Promise<void> {
  await seedDefaultAgents();
  const empty = await reviewDigest("hemera");
  assert(empty.reports.includes("nyx") && empty.attention === 0 && empty.fingerprint === "", "a quiet team needs no attention");

  const captions = await createWork({ title: "Captions", assignee: "nyx", requestedBy: "hemera" });
  await claimWork(captions.id, "nyx", "s-1");
  await blockWork(captions.id, "nyx", "no brief");
  const mix = await createWork({ title: "Mix notes", assignee: "aether", requestedBy: OPERATOR });
  await handBackWork(mix.id, "aether", "not my area");
  const quiet = await createWork({ title: "Press list", assignee: "hermes", requestedBy: OPERATOR });

  const later = Date.now() + 48 * 3_600_000; // two days on, the press list has gone quiet
  const d = await reviewDigest("hemera", later);
  assert(d.blocked.some((i) => i.id === captions.id && i.why === "no brief"), "blocked work of a report is listed with its reason");
  assert(d.handedBack.some((i) => i.id === mix.id && /aether: not my area/.test(i.why)), "work handed back to the lead is listed with who and why");
  assert(d.stale.some((i) => i.id === quiet.id && /not started for 2 days/.test(i.why)), "work with no movement for a day is listed");
  assert(d.attention === 3, "attention counts blocked + handed back + quiet");
  assert((await reviewDigest("nyx")).reports.length === 0, "an agent with no reports has no team to review");

  // Who may manage whose work.
  assert(await throwsWith(reopenWork(captions.id, "aether", "x"), /manager or the operator/), "a teammate who isn't the manager can't reopen");
  assert(await throwsWith(escalateWork(captions.id, "nyx", "x"), /manager or the operator/), "the assignee can't escalate its own item");
  assert(await throwsWith(reassignWork(quiet.id, "nyx", "theia", "x"), /manager or the operator/), "a peer can't reassign someone's work");
  assert(await throwsWith(cancelWork(captions.id, "nyx", "meh"), /can't cancel work handed to you/), "an assignee still can't cancel");

  const esc = await escalateWork(quiet.id, "hemera", "needs a budget decision");
  assert(esc.escalation?.by === "hemera" && esc.status === "open", "the manager escalates to the operator without changing the status");
  const d2 = await reviewDigest("hemera", later);
  assert(d2.escalated.some((i) => i.id === quiet.id) && !d2.stale.some((i) => i.id === quiet.id) && d2.attention === 2, "an escalated item waits on the operator and needs no more attention");
  await reassignWork(quiet.id, OPERATOR, "theia", "Theia has the contacts");
  assert(!(await getWork(quiet.id))!.escalation, "the operator acting on it clears the escalation");
  await cancelWork(quiet.id, OPERATOR, "tidy");
  await reassignWork(mix.id, OPERATOR, "aether", "back to Aether");
  await cancelWork(mix.id, OPERATOR, "tidy");
}

async function testRunner(): Promise<void> {
  // Only the blocked caption job is left needing attention.
  const first = await runReview("hemera", deps);
  assert(first.ran === true, "a review runs when something needs attention");
  assert(prompts.length === 1 && /Blocked:\n- \S+ "Captions" \(nyx\): no brief/.test(prompts[0]!), "the lead's prompt is the digest");
  const captions = (await listReviews("hemera"))[0]!;
  const reopened = (await listWork({ assignee: "nyx" })).find((w) => w.title === "Captions")!;
  assert(reopened.status === "open" && reopened.notes.at(-1)?.text === "reopened: Use the Switch brief in Notes.", "the lead reopened it with guidance through the work tool");
  assert(captions.tokens === 30 && captions.trigger === "schedule" && /Reopened/.test(captions.summary), "the review is recorded with its tokens and summary");

  const quiet = await runReview("hemera", deps);
  assert(!quiet.ran && quiet.reason === "nothing needs attention", "nothing needing attention → no model call");

  // Blocked again; the lead looks but changes nothing.
  act = false;
  await claimWork(reopened.id, "nyx", "s-2");
  await blockWork(reopened.id, "nyx", "brief is empty");
  assert((await runReview("hemera", deps)).ran, "new trouble → a new review");
  const same = await runReview("hemera", deps);
  assert(!same.ran && same.reason === "nothing changed since the last review", "the same state isn't reviewed twice");
  const forced = await runReview("hemera", deps, { trigger: "operator", force: true });
  assert(forced.ran && (await listReviews("hemera"))[0]!.trigger === "operator", "the operator can force a review");
  const sessions = new Set((await listReviews("hemera")).map((r) => r.sessionId));
  assert(sessions.size === 1, "every review happens in the lead's one Team review session");

  await pauseAgent("hemera", { reason: "test" });
  const paused = await runReview("hemera", deps, { force: true });
  assert(!paused.ran && /paused/.test(paused.reason), "a paused lead isn't reviewed");
  await resumeAgent("hemera");

  process.env.AGENT_OS_REVIEW_MAX_PER_DAY = "2";
  await reopenWork(reopened.id, OPERATOR, "try again");
  await claimWork(reopened.id, "nyx", "s-3");
  await blockWork(reopened.id, "nyx", "still nothing");
  const capped = await runReview("hemera", deps);
  assert(!capped.ran && /already reviewed 2 times/.test(capped.reason), "automatic reviews are capped per day");
  delete process.env.AGENT_OS_REVIEW_MAX_PER_DAY;

  const loop = startReviewLoop(deps, { intervalMs: 3_600_000, debounceMs: 3_600_000 });
  try {
    const all = await loop.reviewAll();
    assert(all.length >= 1 && all.every((o) => o.ran || typeof o.reason === "string"), "the loop reviews every lead, skipping those that don't need it");
  } finally {
    loop.stop();
  }
}

async function testRoutes(): Promise<void> {
  const gateway = await startGateway({ model: scripted, worker: createStubWorker(), enableBaseSpace: true });
  const base = `http://127.0.0.1:${gateway.port}`;
  try {
    const list = (await (await fetch(`${base}/reviews?agentId=hemera`)).json()) as { leads: string[]; reviews: unknown[] };
    assert(list.leads.includes("hemera") && list.reviews.length >= 3, "GET /reviews lists leads and past reviews");
    const digest = (await (await fetch(`${base}/reviews/hemera/digest`)).json()) as { blocked: unknown[] };
    assert(Array.isArray(digest.blocked) && digest.blocked.length === 1, "GET /reviews/:id/digest shows what a review would look at (no model call)");
    const before = prompts.length;
    const now = (await (await fetch(`${base}/reviews/hemera`, { method: "POST" })).json()) as { ran: boolean };
    assert(now.ran && prompts.length === before + 1, "POST /reviews/:id runs a review now");
    assert((await fetch(`${base}/reviews/ghost`, { method: "POST" })).status === 404, "an unknown agent is a 404");
  } finally {
    await gateway.stop();
  }
}

async function main(): Promise<void> {
  await testDigestAndRules();
  await testRunner();
  await testRoutes();
  if (process.exitCode === 1) console.error("\nSome review tests FAILED.");
  else console.log("\nAll review tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
