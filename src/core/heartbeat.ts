// Heartbeat — the second of docs/architecture.md §2's two scheduling
// modes, and the genuinely different one from Automations
// (scheduler.ts). The distinction, stated precisely:
//
//   Automations: PRECISE timing (cron), ISOLATED context (a brand-new
//   session every firing, never sees its own history), and every firing
//   creates a real Task in the ledger (type: "cron").
//
//   Heartbeat:   IMPRECISE timing (an interval plus jitter — "roughly
//   every 30 minutes", never exactly), FULL MAIN-SESSION context (every
//   tick is just another turn appended to one long-lived session, so it
//   sees everything that happened before), and NO Task is created — this
//   mirrors types.ts's own comment on Task: "Plain chat turns do NOT
//   create a Task," and a heartbeat tick is exactly that: a turn, not
//   detached work. This is why it's implemented as a thin wrapper around
//   runTurn() targeting an EXISTING sessionId, not a fireAutomation()-style
//   task-spawning function.
//
// Use case from the architecture doc: "check the inbox"-style work,
// where the agent needs to remember what it saw last time (hence full
// session context) but doesn't need split-second timing.

import { appendEvent } from "./eventlog.js";
import { runTurn, newSessionId } from "./agent-loop.js";
import type { ModelAdapter } from "./model.js";
import type { Worker } from "./worker.js";
import type { SkillRegistry } from "./skills.js";

const HEARTBEATS_STREAM = "heartbeats";

export interface HeartbeatConfig {
  agentId: string;
  /** The long-lived session this heartbeat ticks into. Every tick is a
   *  turn in THIS session — full history is always in context, by
   *  construction (runTurn always re-reads the session's own history).
   *  Optional in startHeartbeat() (a fresh session is created if
   *  omitted); required in runHeartbeatTick() (there's no sensible
   *  default for a single one-off tick — the caller must say which
   *  session it belongs to). */
  sessionId: string;
  promptTemplate: string;
  model: ModelAdapter;
  worker: Worker;
  skills?: SkillRegistry;
  /** Base interval in ms. Actual delay between ticks is
   *  intervalMs +/- jitterMs (uniform random), which is what makes this
   *  "imprecise timing" rather than a disguised cron. */
  intervalMs: number;
  /** Jitter range in ms, applied symmetrically around intervalMs.
   *  Defaults to 20% of intervalMs — enough to make "every 30 minutes"
   *  genuinely approximate without being wildly unpredictable. */
  jitterMs?: number;
}

export interface HeartbeatTickResult {
  sessionId: string;
  finalContent: string;
  toolCalled?: string;
  tickedAt: string;
}

function randomJitter(jitterMs: number): number {
  return Math.floor((Math.random() * 2 - 1) * jitterMs); // uniform in [-jitterMs, +jitterMs]
}

/** Runs a single heartbeat tick immediately — a turn in the configured
 *  session, using its full existing history. Deliberately does NOT
 *  create a Task (see file-level comment for why). Records a
 *  `heartbeat.ticked` event in a dedicated stream (not the session's own
 *  stream, so heartbeat cadence can be audited independently of session
 *  content) for observability. */
export async function runHeartbeatTick(config: HeartbeatConfig): Promise<HeartbeatTickResult> {
  const tickedAt = new Date().toISOString();
  const result = await runTurn({
    sessionId: config.sessionId,
    agentId: config.agentId,
    userMessage: config.promptTemplate,
    model: config.model,
    worker: config.worker,
    skills: config.skills,
  });

  await appendEvent(HEARTBEATS_STREAM, "heartbeat.ticked", {
    agentId: config.agentId,
    sessionId: config.sessionId,
    tickedAt,
    finalContent: result.finalContent,
    toolCalled: result.toolCalled,
  });

  return { sessionId: config.sessionId, finalContent: result.finalContent, toolCalled: result.toolCalled, tickedAt };
}

export interface HeartbeatHandle {
  stop: () => void;
  /** The session this heartbeat is ticking into — pass to
   *  getSessionHistory() (agent-loop.ts) to inspect everything a
   *  heartbeat has seen and said so far. */
  sessionId: string;
}

/** Starts a real background heartbeat loop against a NEW session (unless
 *  an existing sessionId is passed) — ticks at intervalMs +/- jitterMs,
 *  imprecise by design. Every tick is a turn in the SAME session, so
 *  context accumulates exactly like an ongoing conversation would; this
 *  is the defining difference from scheduler.ts's startScheduler(),
 *  where every firing gets a brand-new session. Returns a handle whose
 *  stop() halts future ticks — always hold onto it, matching
 *  startScheduler()'s own contract. */
export function startHeartbeat(config: Omit<HeartbeatConfig, "sessionId"> & { sessionId?: string }): HeartbeatHandle {
  const sessionId = config.sessionId ?? newSessionId();
  const jitterMs = config.jitterMs ?? config.intervalMs * 0.2;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;

  function scheduleNext(): void {
    if (stopped) return;
    const delay = Math.max(0, config.intervalMs + randomJitter(jitterMs));
    timer = setTimeout(async () => {
      if (stopped) return;
      try {
        const result = await runHeartbeatTick({ ...config, sessionId });
        console.log(`[heartbeat] ticked session ${sessionId}: "${result.finalContent.slice(0, 80)}"`);
      } catch (err) {
        console.error("[heartbeat] tick failed:", err instanceof Error ? err.message : err);
      }
      scheduleNext();
    }, delay);
    if (typeof timer.unref === "function") timer.unref();
  }

  scheduleNext();

  return {
    sessionId,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
