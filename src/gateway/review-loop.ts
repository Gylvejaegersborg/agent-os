// Runs team reviews (core/review.ts) for every lead: on a schedule, and a
// little after work gets blocked or handed back. Each run costs a model
// turn, so a lead is only woken when its digest has something needing it
// that it hasn't already reviewed — an unchanged team costs nothing.
//
// - Every AGENT_OS_REVIEW_INTERVAL_MIN minutes (default 240).
// - AGENT_OS_REVIEW_DEBOUNCE_MIN (default 10) after a work.blocked /
//   work.reassigned, so a burst of changes becomes one review.
// - At most AGENT_OS_REVIEW_MAX_PER_DAY automatic reviews per lead
//   (default 6) — a reopen → blocked → reopen cycle can't spin. The
//   operator's "review now" isn't capped.
// - A paused or over-budget lead is skipped (controls.ts).
// - Each lead reviews in one long-lived "Team review" session, so it sees
//   what it decided last time.
//
// Disable with AGENT_OS_REVIEW=off.

import {
  agentIsBlocked,
  createModelForAgent,
  createSession,
  getReviewSessionId,
  getSession,
  listLeads,
  listReviews,
  recordReview,
  renderReviewPrompt,
  reviewDigest,
  runTurn,
  setReviewSessionId,
  subscribeToAllEvents,
  type ModelAdapter,
  type ReviewDigest,
  type ReviewRecord,
  type SandboxPolicy,
  type SkillRegistry,
  type Worker,
} from "../core/index.js";

export interface ReviewDeps {
  model: ModelAdapter;
  worker: Worker;
  skills?: SkillRegistry;
  sandboxPolicy?: SandboxPolicy;
}

export type ReviewOutcome =
  | { ran: true; digest: ReviewDigest; record: ReviewRecord; finalContent: string }
  | { ran: false; digest?: ReviewDigest; reason: string };

const running = new Set<string>();

async function reviewSession(agentId: string): Promise<string> {
  const existing = await getReviewSessionId(agentId);
  if (existing && (await getSession(existing))) return existing;
  const session = await createSession({ agentId, title: "Team review" });
  await setReviewSessionId(agentId, session.id);
  return session.id;
}

/** One review for one lead. `force` (the operator's "review now") runs even
 *  when nothing needs attention or nothing changed. */
export async function runReview(agentId: string, deps: ReviewDeps, opts: { trigger?: ReviewRecord["trigger"]; force?: boolean } = {}): Promise<ReviewOutcome> {
  const trigger = opts.trigger ?? "schedule";
  if (running.has(agentId)) return { ran: false, reason: "a review is already running" };
  if (await agentIsBlocked(agentId)) return { ran: false, reason: `${agentId} is paused or over budget` };
  running.add(agentId);
  try {
    const digest = await reviewDigest(agentId);
    if (!digest.reports.length) return { ran: false, digest, reason: `${agentId} has no reports` };
    if (!opts.force) {
      if (!digest.attention) return { ran: false, digest, reason: "nothing needs attention" };
      const last = (await listReviews(agentId, 1))[0];
      if (last && last.fingerprint === digest.fingerprint) return { ran: false, digest, reason: "nothing changed since the last review" };
      const cap = Number(process.env.AGENT_OS_REVIEW_MAX_PER_DAY ?? 6);
      const today = (await listReviews(agentId, 100)).filter((r) => r.trigger !== "operator" && Date.now() - Date.parse(r.at) < 24 * 3_600_000);
      if (today.length >= cap) return { ran: false, digest, reason: `already reviewed ${today.length} times in the last 24 hours` };
    }
    const sessionId = await reviewSession(agentId);
    const model = (await createModelForAgent(agentId)) ?? deps.model;
    const prompt = renderReviewPrompt(digest);
    const result = await runTurn({
      sessionId,
      agentId,
      userMessage: prompt,
      model,
      worker: deps.worker,
      skills: deps.skills,
      sandboxPolicy: deps.sandboxPolicy,
      enableBaseSpace: true,
      // A review has one job: act on the items. Only the tools for that,
      // and two steps per item (plus one look) — enough to act, not browse.
      onlyTools: ["work", "delegate", "basespace"],
      maxToolHops: Math.min(8, Math.max(digest.attention, 1) * 2 + 1),
    });
    const record: Omit<ReviewRecord, "at"> = {
      agentId,
      sessionId,
      fingerprint: digest.fingerprint,
      attention: digest.attention,
      tokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
      summary: result.finalContent.slice(0, 600),
      stopReason: result.stopReason,
      trigger,
    };
    await recordReview(record);
    return { ran: true, digest, record: { ...record, at: new Date().toISOString() }, finalContent: result.finalContent };
  } finally {
    running.delete(agentId);
  }
}

export interface ReviewLoopHandle {
  stop: () => void;
  /** Reviews every lead now (skips what doesn't need it) — for tests. */
  reviewAll: (trigger?: ReviewRecord["trigger"]) => Promise<ReviewOutcome[]>;
}

export function startReviewLoop(deps: ReviewDeps, opts: { intervalMs?: number; debounceMs?: number } = {}): ReviewLoopHandle {
  const intervalMs = opts.intervalMs ?? Number(process.env.AGENT_OS_REVIEW_INTERVAL_MIN ?? 240) * 60_000;
  const debounceMs = opts.debounceMs ?? Number(process.env.AGENT_OS_REVIEW_DEBOUNCE_MIN ?? 10) * 60_000;
  let stopped = false;
  let pending: ReturnType<typeof setTimeout> | undefined;

  async function reviewAll(trigger: ReviewRecord["trigger"] = "schedule"): Promise<ReviewOutcome[]> {
    const out: ReviewOutcome[] = [];
    // One lead at a time: reviews share the machine with the work runner.
    for (const lead of await listLeads()) {
      if (stopped) break;
      try {
        out.push(await runReview(lead.id, deps, { trigger }));
      } catch (err) {
        console.error(`[review] ${lead.id}:`, err instanceof Error ? err.message : err);
      }
    }
    return out;
  }

  const unsubscribe = subscribeToAllEvents((type) => {
    if (type !== "work.blocked" && type !== "work.reassigned") return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => void reviewAll("event"), debounceMs);
    if (typeof pending.unref === "function") pending.unref();
  });
  const timer = setInterval(() => void reviewAll("schedule"), intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      if (pending) clearTimeout(pending);
      unsubscribe();
    },
    reviewAll,
  };
}
