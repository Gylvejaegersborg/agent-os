// Observability — a read-only projection over the event log, nothing
// more. Every number in MetricsSnapshot is DERIVED, on demand, by
// replaying existing streams (tasks, automations, memory:<agentId>:
// dreaming, session:<sessionId>) through project()/readStream() from
// eventlog.ts. There is no new persistent state here: no counters
// incremented on write, no cache, no database — call
// computeMetricsSnapshot() any time and it recomputes fresh from
// whatever's on disk right now, exactly like every other projection in
// this scaffold (Task status, curated memory, flow state, ...).
//
// What's aggregated, and where each number comes from:
//   - tasks.byStatus / successRate / failureRate  <- "tasks" stream
//     (task.created / task.status.changed events, via listTasks()).
//   - tasks.subagentDelegationCount                <- same stream,
//     Task.type === "subagent".
//   - automations.firesByTriggerKind                <- "automations"
//     stream's `automation.fired` events, cross-referenced against each
//     automation's registered trigger.kind (cron/event/webhook) via
//     listAutomations().
//   - dreaming.*                                    <- every
//     `memory:<agentId>:dreaming` stream's `memory.dreaming.completed`
//     events (DreamingPass.promotions[].decision: promoted/held/
//     discarded), summed across every agent that has run a pass (or
//     scoped to one agentId if given).
//   - turnLatency.*                                 <- every
//     `session:<sessionId>` stream's paired `agent.turn.start` /
//     `agent.turn.end` events; latency is the wall-clock delta between
//     an ISO timestamp pair, in milliseconds.
//
// agentId is optional throughout: omit it for a whole-system snapshot
// (every agent's tasks/dreaming passes/turns), or pass one to scope
// tasks, automations, dreaming passes, and turn latency to a single
// agent. Automation fire counts are naturally system-wide when no
// automation for that agent fired, contributing 0 rather than being
// silently skipped.

import { listStreamIds, readStream } from "./eventlog.js";
import { listTasks, listAutomations } from "./tasks.js";
import { listDreamingPasses } from "./memory.js";
import type { TaskStatus, Automation } from "./types.js";

const TERMINAL_STATUSES: TaskStatus[] = ["succeeded", "failed", "timed_out", "cancelled", "lost"];
const TRIGGER_KINDS: Automation["trigger"]["kind"][] = ["cron", "event", "webhook"];

export interface TaskMetrics {
  total: number;
  byStatus: Record<TaskStatus, number>;
  terminalTotal: number;
  /** succeeded / terminalTotal, or null if no task has reached a terminal state yet. */
  successRate: number | null;
  /** failed / terminalTotal, or null if no task has reached a terminal state yet. */
  failureRate: number | null;
  subagentDelegationCount: number;
}

export interface AutomationMetrics {
  registeredCount: number;
  totalFired: number;
  firesByTriggerKind: Record<Automation["trigger"]["kind"], number>;
}

export interface DreamingMetrics {
  totalPasses: number;
  totalEpisodicEntriesReviewed: number;
  totalPromoted: number;
  totalHeld: number;
  totalDiscarded: number;
  agentsCovered: string[];
}

export interface TurnLatencyMetrics {
  sampleCount: number;
  avgMs: number | null;
  minMs: number | null;
  maxMs: number | null;
}

export interface MetricsSnapshot {
  generatedAt: string;
  scope: { agentId?: string };
  tasks: TaskMetrics;
  automations: AutomationMetrics;
  dreaming: DreamingMetrics;
  turnLatency: TurnLatencyMetrics;
}

function emptyStatusCounts(): Record<TaskStatus, number> {
  return { queued: 0, running: 0, succeeded: 0, failed: 0, timed_out: 0, cancelled: 0, lost: 0 };
}

async function computeTaskMetrics(agentId?: string): Promise<TaskMetrics> {
  const tasks = await listTasks(agentId ? { agentId } : undefined);
  const byStatus = emptyStatusCounts();
  for (const t of tasks) byStatus[t.status]++;
  const terminalTotal = TERMINAL_STATUSES.reduce((sum, s) => sum + byStatus[s], 0);
  const successRate = terminalTotal > 0 ? byStatus.succeeded / terminalTotal : null;
  const failureRate = terminalTotal > 0 ? byStatus.failed / terminalTotal : null;
  const subagentDelegationCount = tasks.filter((t) => t.type === "subagent").length;
  return { total: tasks.length, byStatus, terminalTotal, successRate, failureRate, subagentDelegationCount };
}

async function computeAutomationMetrics(agentId?: string): Promise<AutomationMetrics> {
  const automations = await listAutomations();
  const relevant = agentId ? automations.filter((a) => a.agentId === agentId) : automations;
  const kindByAutomationId = new Map(relevant.map((a) => [a.id, a.trigger.kind]));

  const firesByTriggerKind = TRIGGER_KINDS.reduce(
    (acc, k) => ({ ...acc, [k]: 0 }),
    {} as Record<Automation["trigger"]["kind"], number>,
  );
  let totalFired = 0;

  // Every automation.fired event (cron ticks, event-bus matches, webhook
  // hits) lands in the same "automations" stream that registration does
  // — see scheduler.ts's AUTOMATIONS_STREAM and tasks.ts's own constant
  // of the same name/value.
  const events = await readStream("automations");
  for (const e of events) {
    if (e.type !== "automation.fired") continue;
    const p = e.payload as { automationId: string };
    const kind = kindByAutomationId.get(p.automationId);
    if (kind === undefined) continue; // scoped out (different agent) or automation no longer resolvable
    firesByTriggerKind[kind]++;
    totalFired++;
  }

  return { registeredCount: relevant.length, totalFired, firesByTriggerKind };
}

/** Finds every agentId that has a dreaming stream on disk, by scanning
 *  stream ids for the `memory_<agentId>_dreaming` filename pattern
 *  (eventlog.ts's streamPath() sanitizes ':' to '_', so
 *  `memory:<agentId>:dreaming` shows up this way in listStreamIds()). */
async function discoverDreamingAgentIds(): Promise<string[]> {
  const streams = await listStreamIds();
  const ids = new Set<string>();
  for (const s of streams) {
    const m = s.match(/^memory_(.+)_dreaming$/);
    if (m) ids.add(m[1]);
  }
  return [...ids];
}

async function computeDreamingMetrics(agentId?: string): Promise<DreamingMetrics> {
  const agentIds = agentId ? [agentId] : await discoverDreamingAgentIds();
  let totalPasses = 0;
  let totalEpisodicEntriesReviewed = 0;
  let totalPromoted = 0;
  let totalHeld = 0;
  let totalDiscarded = 0;
  const agentsCovered: string[] = [];

  for (const id of agentIds) {
    const passes = await listDreamingPasses(id);
    if (passes.length === 0) continue;
    agentsCovered.push(id);
    totalPasses += passes.length;
    for (const pass of passes) {
      totalEpisodicEntriesReviewed += pass.episodicEntriesReviewed;
      for (const promo of pass.promotions) {
        if (promo.decision === "promoted") totalPromoted++;
        else if (promo.decision === "held") totalHeld++;
        else if (promo.decision === "discarded") totalDiscarded++;
      }
    }
  }

  return { totalPasses, totalEpisodicEntriesReviewed, totalPromoted, totalHeld, totalDiscarded, agentsCovered };
}

/** Pairs up agent.turn.start / agent.turn.end events within each
 *  session:<sessionId> stream (agent-loop.ts's runTurn() appends
 *  exactly one of each, in order, per call) and returns the wall-clock
 *  delta in ms for every completed turn found. Session streams on disk
 *  are named `session_<id>` (':' sanitized to '_' by eventlog.ts), the
 *  same pattern agentfs.ts's fsList("/agent/sessions") already relies on. */
async function computeTurnLatencyMetrics(agentId?: string): Promise<TurnLatencyMetrics> {
  const streamIds = (await listStreamIds()).filter((s) => s.startsWith("session_"));
  const diffs: number[] = [];

  for (const streamId of streamIds) {
    const events = await readStream(streamId);
    let startTs: number | null = null;
    let startAgentId: string | undefined;
    for (const e of events) {
      if (e.type === "agent.turn.start") {
        startTs = new Date(e.timestamp).getTime();
        startAgentId = (e.payload as { agentId?: string }).agentId;
      } else if (e.type === "agent.turn.end" && startTs !== null) {
        const endTs = new Date(e.timestamp).getTime();
        if (!agentId || startAgentId === agentId) diffs.push(endTs - startTs);
        startTs = null;
      }
    }
  }

  if (diffs.length === 0) return { sampleCount: 0, avgMs: null, minMs: null, maxMs: null };
  const sum = diffs.reduce((a, b) => a + b, 0);
  return { sampleCount: diffs.length, avgMs: sum / diffs.length, minMs: Math.min(...diffs), maxMs: Math.max(...diffs) };
}

/** The one entry point: a fresh, purely-derived snapshot of everything
 *  this scaffold can currently say about itself, computed by replaying
 *  the same event streams every other primitive already reads/writes —
 *  no new database, no external monitoring service, no hidden mutable
 *  counters. Pass an agentId to scope tasks/automations/dreaming/turn-
 *  latency to a single agent; omit it for a whole-system view. */
export async function computeMetricsSnapshot(agentId?: string): Promise<MetricsSnapshot> {
  const [tasks, automations, dreaming, turnLatency] = await Promise.all([
    computeTaskMetrics(agentId),
    computeAutomationMetrics(agentId),
    computeDreamingMetrics(agentId),
    computeTurnLatencyMetrics(agentId),
  ]);
  return { generatedAt: new Date().toISOString(), scope: { agentId }, tasks, automations, dreaming, turnLatency };
}
