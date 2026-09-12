// Task / Flow projections — pure reducers over the event log. Nothing here
// is "state" in the traditional sense; call project() any time you need
// current status and it's derived fresh from history. This is deliberate:
// it means a Task's status can never drift out of sync with its own event
// trail, because there IS no separate copy to drift.
//
// Lifecycle enforcement (timeout / lost / notifyPolicy / mirrored Flow) —
// added on top of the original queued->running->succeeded|failed skeleton.
// All of it follows the same rule as everything else in this file: new
// behavior is new event types appended to the SAME "tasks" stream, reduced
// by projectTasks()/projectFlows(). Nothing here keeps a separate mutable
// store — see each function's comment for exactly which event(s) it adds.

import { project, appendEvent } from "./eventlog.js";
import { publishEvent } from "./eventbus.js";
import { generateId } from "./id.js";
import type { Task, TaskStatus, Flow, FlowStep, Automation } from "./types.js";

const TASKS_STREAM = "tasks"; // one shared stream; task id lives in payload
const TERMINAL_STATUSES: TaskStatus[] = ["succeeded", "failed", "timed_out", "cancelled", "lost"];

export async function createTask(input: {
  type: Task["type"];
  agentId: string;
  workerId?: string;
  parentTaskId?: string;
  flowId?: string;
  input: Record<string, unknown>;
  notifyPolicy?: Task["notifyPolicy"];
  /** Configurable per-task timeout (ms), see types.ts's Task.timeoutMs doc.
   *  Omit for "no timeout enforced for this Task" (checkTaskTimeouts()
   *  will skip it unless a sweep-wide defaultTimeoutMs is supplied). */
  timeoutMs?: number;
}): Promise<Task> {
  const id = generateId();
  await appendEvent(TASKS_STREAM, "task.created", {
    taskId: id,
    ...input,
    notifyPolicy: input.notifyPolicy ?? "immediate",
  });
  const task = await getTask(id);
  if (!task) throw new Error("task.created event did not project to a task");
  return task;
}

export async function transitionTask(
  taskId: string,
  status: TaskStatus,
  extra: { output?: Record<string, unknown>; reason?: string } = {},
): Promise<void> {
  const before = await getTask(taskId);
  await appendEvent(TASKS_STREAM, "task.status.changed", { taskId, status, ...extra });
  if (!before) return; // nothing to notify/propagate for an unknown task id

  // liveTaskIds tracks which Tasks THIS process currently considers its
  // own — used only to know what startTaskLivenessRenewer() (below)
  // should renew on a cadence. It is NOT what reconcileLostTasks() itself
  // consults anymore — see that function's header for why durable renewal
  // events are the actual liveness signal now.
  if (status === "running") {
    liveTaskIds.add(taskId);
    await renewTaskLiveness(taskId); // every transition into 'running' — including a re-registration after restart — counts as a fresh heartbeat
  } else {
    liveTaskIds.delete(taskId);
  }

  const after: Task = { ...before, status };
  await notifyTaskStatus(after, extra.reason ?? `status changed to "${status}"`);
  await propagateToMirroredFlow(after);
}

interface TaskProjectionState {
  tasks: Map<string, Task>;
  /** Most recent durable liveness signal per taskId — either an explicit
   *  task.liveness.renewed event, or (since transitionTask() renews on
   *  every transition into 'running') the timestamp of the latest such
   *  transition. See reconcileLostTasks() below for how this replaces
   *  liveTaskIds as the actual staleness signal. */
  lastRenewedAt: Map<string, string>;
}

async function projectTasks(): Promise<TaskProjectionState> {
  return project<TaskProjectionState>(TASKS_STREAM, { tasks: new Map(), lastRenewedAt: new Map() }, (state, event) => {
    if (event.type === "task.created") {
      const p = event.payload as any;
      state.tasks.set(p.taskId, {
        id: p.taskId,
        type: p.type,
        agentId: p.agentId,
        workerId: p.workerId,
        parentTaskId: p.parentTaskId,
        flowId: p.flowId,
        status: "queued",
        createdAt: event.timestamp,
        input: p.input ?? {},
        notifyPolicy: p.notifyPolicy ?? "immediate",
        timeoutMs: p.timeoutMs,
      });
    } else if (event.type === "task.status.changed") {
      const p = event.payload as any;
      const existing = state.tasks.get(p.taskId);
      if (!existing) return state;
      const updated: Task = { ...existing, status: p.status };
      if (p.status === "running" && !updated.startedAt) updated.startedAt = event.timestamp;
      if (TERMINAL_STATUSES.includes(p.status)) {
        updated.completedAt = event.timestamp;
      }
      if (p.output) updated.output = p.output;
      state.tasks.set(p.taskId, updated);
    } else if (event.type === "task.liveness.renewed") {
      const p = event.payload as any;
      state.lastRenewedAt.set(p.taskId, event.timestamp);
    }
    // task.timeout.checked / task.notification.sent / task.notification.suppressed /
    // task.reconciliation.swept are audit-only events — they don't change a
    // Task's projected shape (the status change they *cause*, if any, is its
    // own separate task.status.changed event above), so the reducer
    // intentionally falls through and leaves state untouched for them.
    return state;
  });
}

/** Appends a durable liveness heartbeat for a Task — the actual signal
 *  reconcileLostTasks() (below) uses to decide staleness, replacing the
 *  old in-memory-only liveTaskIds check. Called automatically by
 *  transitionTask() on every transition into 'running' (so simply
 *  re-registering ownership after a restart already counts), and
 *  periodically by startTaskLivenessRenewer() for as long as a process
 *  keeps a Task in its own liveTaskIds set. Exported directly too, for a
 *  Worker/process that wants to renew mid-execution on its own cadence
 *  without going through transitionTask(). */
export async function renewTaskLiveness(taskId: string): Promise<void> {
  await appendEvent(TASKS_STREAM, "task.liveness.renewed", { taskId });
}

export async function getTask(taskId: string): Promise<Task | undefined> {
  const { tasks } = await projectTasks();
  return tasks.get(taskId);
}

export async function listTasks(filter?: { agentId?: string; status?: TaskStatus; parentTaskId?: string; flowId?: string }): Promise<Task[]> {
  const { tasks } = await projectTasks();
  let list = [...tasks.values()];
  if (filter?.agentId) list = list.filter((t) => t.agentId === filter.agentId);
  if (filter?.status) list = list.filter((t) => t.status === filter.status);
  if (filter?.parentTaskId) list = list.filter((t) => t.parentTaskId === filter.parentTaskId);
  if (filter?.flowId) list = list.filter((t) => t.flowId === filter.flowId);
  return list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ---- Timeout enforcement ----
//
// A Task that stays 'running' longer than its configured timeoutMs (per-task,
// see types.ts) — or, if it has none, longer than an optional sweep-wide
// defaultTimeoutMs — is transitioned to 'timed_out'. Nothing runs a hidden
// per-task setTimeout: this is a deliberate SWEEP (checkTaskTimeouts, plus
// startTaskTimeoutSweeper for a real interval loop), same shape as
// scheduler.ts's runSchedulerTick/startScheduler. A sweep is what makes this
// safe across process restarts — a setTimeout armed in a process that then
// crashes silently never fires; a sweep re-derived from `startedAt` in the
// event log fires correctly no matter which process runs it or when.

export interface TimeoutSweepResult {
  checked: number;
  timedOut: string[];
}

/** Checks every currently-'running' Task against its timeout budget and
 *  transitions any that have exceeded it to 'timed_out'. Always appends a
 *  `task.timeout.checked` audit event first (which Tasks were even eligible
 *  and which were found over budget), THEN drives the actual
 *  status-change via transitionTask() for each offender — so timeout,
 *  notification, and mirrored-Flow propagation all go through the exact
 *  same single code path every other status change does. Safe to call
 *  repeatedly/concurrently: a Task that already left 'running' (e.g. it
 *  finished between two sweeps) simply won't appear in the next sweep's
 *  candidate list. */
export async function checkTaskTimeouts(
  opts: { now?: Date; defaultTimeoutMs?: number } = {},
): Promise<TimeoutSweepResult> {
  const now = opts.now ?? new Date();
  const { tasks } = await projectTasks();
  const running = [...tasks.values()].filter((t) => t.status === "running" && t.startedAt);

  const checked: Task[] = [];
  const timedOut: string[] = [];
  for (const t of running) {
    const limitMs = t.timeoutMs ?? opts.defaultTimeoutMs;
    if (limitMs === undefined) continue; // no timeout configured anywhere for this Task — sweep skips it
    checked.push(t);
    const elapsedMs = now.getTime() - new Date(t.startedAt as string).getTime();
    if (elapsedMs >= limitMs) timedOut.push(t.id);
  }

  await appendEvent(TASKS_STREAM, "task.timeout.checked", {
    checkedAt: now.toISOString(),
    checkedTaskIds: checked.map((t) => t.id),
    timedOutTaskIds: timedOut,
  });

  for (const id of timedOut) {
    await transitionTask(id, "timed_out", { reason: "exceeded configured timeoutMs while status was running" });
  }

  return { checked: checked.length, timedOut };
}

export interface TimeoutSweeperHandle {
  stop: () => void;
}

/** Starts a real interval loop calling checkTaskTimeouts() — mirrors
 *  scheduler.ts's startScheduler()/heartbeat.ts's startHeartbeat() in
 *  shape (unref'd timer, returns a stop() handle). Not started
 *  automatically by anything in this scaffold; a real deployment calls
 *  this once at process startup alongside startScheduler()/startHeartbeat(). */
export function startTaskTimeoutSweeper(intervalMs = 30_000, defaultTimeoutMs?: number): TimeoutSweeperHandle {
  const timer = setInterval(() => {
    checkTaskTimeouts({ defaultTimeoutMs }).catch((err) => {
      console.error("[tasks] timeout sweep failed:", err instanceof Error ? err.message : err);
    });
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return { stop: () => clearInterval(timer) };
}

// ---- 'lost' detection ----
//
// DURABLE, multi-process-safe version — this replaced an earlier
// in-memory-only `liveTaskIds`-membership check (see git history/README
// for that version's own honest-limitations writeup, which named this
// exact mechanism as the needed upgrade: "a shared lease/heartbeat
// registry... a `task.liveness.renewed` event type with a TTL, written
// periodically by whichever process owns the Task, and
// reconcileLostTasks() checking 'renewed within the last N seconds'
// instead of local Set membership").
//
// How it works now: transitionTask() appends a `task.liveness.renewed`
// event every time a Task transitions into 'running' (including a FRESH
// process re-registering ownership after a restart — see
// testLostDetection's "stillAlive" case), and a process that owns a
// long-running Task can keep renewing it on a cadence via
// startTaskLivenessRenewer() (below) or renewTaskLiveness() directly.
// reconcileLostTasks() — callable from ANY process, including one that
// has never touched this Task before — reads the MOST RECENT renewal per
// taskId straight from the durable event log (projectTasks()'s
// lastRenewedAt map) and compares it against `staleAfterMs`: a 'running'
// Task with no renewal inside that window (falling back to its
// `startedAt` if it was never explicitly renewed) is orphaned. This is a
// genuine cross-process signal — two separate Node processes sharing the
// same AGENT_OS_DATA_DIR each see the same renewal history — unlike the
// old per-process Set, which by construction could never be seen by
// anyone but the process that owned it.
//
// Still-honest remaining limitation: this is a POLLING lease over a flat
// file, not a real distributed lock — two processes racing to both
// "claim" the same orphaned Task after reconciliation could both start
// executing it (no fencing token). A production deployment with genuine
// concurrent workers needs an actual lease/lock primitive (e.g. a
// database row lock, or a proper distributed lock service) on top of
// this; what's here is what makes "is this task's owner even still
// alive" answerable across processes at all, which the old mechanism
// could not do.

const liveTaskIds = new Set<string>();

/** How long a 'running' Task may go without a liveness renewal before
 *  reconcileLostTasks() considers it orphaned. Should comfortably exceed
 *  whatever interval a real deployment's startTaskLivenessRenewer() (or
 *  equivalent) renews on — this scaffold's own renewer defaults to a
 *  10s cadence, so 45s tolerates a couple of missed ticks before
 *  declaring a Task lost. */
const DEFAULT_STALE_AFTER_MS = 45_000;

export interface ReconciliationResult {
  checked: number;
  lost: string[];
}

/** Sweeps every currently-'running' Task and marks any whose most recent
 *  durable liveness renewal (see the strategy writeup above) is older
 *  than `staleAfterMs` as 'lost'. Always appends a
 *  `task.reconciliation.swept` audit event first, recording exactly what
 *  was running and what was found orphaned, then drives each orphan
 *  through the same transitionTask() path as any other status change (so
 *  notifyPolicy and mirrored-Flow propagation both still apply to a
 *  'lost' transition, not just to normal completions). Safe to call from
 *  a brand-new process that has never seen these Tasks before — that's
 *  the whole point. */
export async function reconcileLostTasks(opts: { staleAfterMs?: number; now?: Date } = {}): Promise<ReconciliationResult> {
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const now = (opts.now ?? new Date()).getTime();
  const { tasks, lastRenewedAt } = await projectTasks();
  const running = [...tasks.values()].filter((t) => t.status === "running");
  const lost = running.filter((t) => {
    const last = lastRenewedAt.get(t.id) ?? t.startedAt;
    if (!last) return true; // 'running' with no startedAt at all shouldn't happen, but treat defensively as orphaned rather than trusting it
    return now - new Date(last).getTime() > staleAfterMs;
  });

  await appendEvent(TASKS_STREAM, "task.reconciliation.swept", {
    sweptAt: new Date(now).toISOString(),
    staleAfterMs,
    runningTaskIds: running.map((t) => t.id),
    lostTaskIds: lost.map((t) => t.id),
  });

  for (const t of lost) {
    await transitionTask(t.id, "lost", { reason: `no liveness renewal within the last ${staleAfterMs}ms` });
  }

  return { checked: running.length, lost: lost.map((t) => t.id) };
}

export interface LivenessRenewerHandle {
  stop: () => void;
}

/** Starts a real interval loop renewing liveness (renewTaskLiveness())
 *  for every Task currently in THIS process's `liveTaskIds` — i.e. every
 *  Task this process has itself transitioned into 'running' and not yet
 *  out of. Mirrors startTaskTimeoutSweeper()'s shape (unref'd timer,
 *  stop() handle). A real deployment that keeps long-running Tasks alive
 *  for longer than DEFAULT_STALE_AFTER_MS should start this once at
 *  startup, alongside the timeout sweeper — otherwise a Task that's
 *  genuinely still executing but simply outlives the staleness window
 *  (because nothing ever renews it) would be wrongly reconciled as
 *  'lost' by another process. */
export function startTaskLivenessRenewer(intervalMs = 10_000): LivenessRenewerHandle {
  const timer = setInterval(() => {
    for (const taskId of liveTaskIds) {
      renewTaskLiveness(taskId).catch((err) => {
        console.error(`[tasks] liveness renewal failed for ${taskId}:`, err instanceof Error ? err.message : err);
      });
    }
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return { stop: () => clearInterval(timer) };
}

/** Test/ops hook: clears this process's own-Task-ownership registry
 *  (`liveTaskIds`) WITHOUT touching the event log — simulates exactly
 *  what a real process crash does: it simply stops renewing (via
 *  startTaskLivenessRenewer()) whatever Tasks it used to own, so their
 *  durable liveness signal goes stale on its own, at whatever
 *  `staleAfterMs` a later reconcileLostTasks() call uses — no special
 *  "am I still tracked" check needed anymore, which is the whole point
 *  of the durable-renewal mechanism over the old Set-membership one.
 *  Mirrors the existing clearHooks()/clearEventBusSubscribers()
 *  reset-for-tests pattern used elsewhere in this codebase. */
export function simulateProcessRestart(): void {
  liveTaskIds.clear();
}

// ---- notifyPolicy wiring ----
//
// Every transitionTask() call routes through notifyTaskStatus() below, so
// notifyPolicy is enforced for every status change ANY primitive in this
// codebase produces (subagent.ts, scheduler.ts's fireAutomation, the
// timeout sweep, and reconcileLostTasks all just call transitionTask —
// none of them need to know notifyPolicy exists). Three policies, three
// real, differently-shaped effects — none of them a no-op:
//
//   'immediate' — appends a `task.notification.sent` audit event AND
//                 publishes a `task.notification` event on the real
//                 in-process event bus (eventbus.ts) right away, one per
//                 status change. Anything that called
//                 subscribeToEvent("task.notification", ...) hears it
//                 synchronously within the same publishEvent() call.
//   'digest'    — queued into an in-memory batch (`digestQueue`), NOT
//                 published yet. flushDigest() (called manually, or on an
//                 interval via startNotificationDigestFlusher(), mirroring
//                 startTaskTimeoutSweeper()'s shape) drains the whole
//                 queue into ONE `task.notification.sent` audit event
//                 (batched: true) and ONE `task.notification.digest` bus
//                 publish carrying every queued item — genuinely batched,
//                 not fired per task.
//   'silent'    — appends a `task.notification.suppressed` audit event
//                 (so silence is itself auditable — you can prove nothing
//                 was ever "lost", it was deliberately never sent) and
//                 publishes NOTHING on the event bus. No subscriber ever
//                 sees it.

export interface DigestQueueItem {
  taskId: string;
  agentId: string;
  status: TaskStatus;
  reason: string;
  queuedAt: string;
}

const digestQueue: DigestQueueItem[] = [];

async function notifyTaskStatus(task: Task, reason: string): Promise<void> {
  if (task.notifyPolicy === "silent") {
    await appendEvent(TASKS_STREAM, "task.notification.suppressed", {
      taskId: task.id,
      agentId: task.agentId,
      status: task.status,
      reason,
      policy: "silent",
    });
    return;
  }

  if (task.notifyPolicy === "immediate") {
    await appendEvent(TASKS_STREAM, "task.notification.sent", {
      taskId: task.id,
      agentId: task.agentId,
      status: task.status,
      reason,
      policy: "immediate",
      batched: false,
    });
    await publishEvent("task.notification", {
      taskId: task.id,
      agentId: task.agentId,
      status: task.status,
      reason,
      policy: "immediate",
    });
    return;
  }

  // 'digest' — queue only; flushDigest() is what actually sends.
  digestQueue.push({
    taskId: task.id,
    agentId: task.agentId,
    status: task.status,
    reason,
    queuedAt: new Date().toISOString(),
  });
}

export interface DigestFlushResult {
  count: number;
  agentIds: string[];
  items: DigestQueueItem[];
}

/** Drains the entire digest queue into a single batched notification —
 *  one `task.notification.sent` audit event (batched: true, carrying
 *  every queued item) and one `task.notification.digest` publish on the
 *  event bus. Returns null (and appends/publishes nothing) if the queue
 *  is currently empty, so callers/timers can call this unconditionally
 *  without spamming empty digests. */
export async function flushDigest(): Promise<DigestFlushResult | null> {
  if (digestQueue.length === 0) return null;
  const items = digestQueue.splice(0, digestQueue.length);
  const agentIds = [...new Set(items.map((i) => i.agentId))];

  await appendEvent(TASKS_STREAM, "task.notification.sent", {
    policy: "digest",
    batched: true,
    count: items.length,
    items,
  });
  await publishEvent("task.notification.digest", { count: items.length, items, agentIds });

  return { count: items.length, agentIds, items };
}

/** Peek at what's currently queued for the next digest flush, without
 *  draining it — used by tests/observability, never mutates the queue. */
export function peekDigestQueue(): DigestQueueItem[] {
  return [...digestQueue];
}

export interface DigestFlusherHandle {
  stop: () => void;
}

/** Starts a real interval loop calling flushDigest() — same shape as
 *  startTaskTimeoutSweeper()/startScheduler()/startHeartbeat() (unref'd
 *  timer, stop() handle). Not started automatically; a real deployment
 *  calls this once at startup if it wants digest-policy Tasks to actually
 *  get flushed on a cadence rather than only via manual flushDigest(). */
export function startNotificationDigestFlusher(intervalMs = 60_000): DigestFlusherHandle {
  const timer = setInterval(() => {
    flushDigest().catch((err) => {
      console.error("[tasks] digest flush failed:", err instanceof Error ? err.message : err);
    });
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return { stop: () => clearInterval(timer) };
}

// ---- Flow ----

const FLOWS_STREAM = "flows";

/** Creates a 'managed' Flow: explicit, caller-driven step control. The
 *  caller owns advancing every step via updateFlowStep() — nothing here
 *  auto-derives step status from anything. This is the ONLY behavior this
 *  function ever had; kept unchanged as the contrast case for
 *  createMirroredFlow() below (see that function's header for the
 *  difference). */
export async function createFlow(kind: Flow["kind"], stepIds: { id: string; dependsOn: string[] }[]): Promise<Flow> {
  const id = generateId();
  await appendEvent(FLOWS_STREAM, "flow.created", { flowId: id, kind, steps: stepIds });
  const flow = await getFlow(id);
  if (!flow) throw new Error("flow.created event did not project to a flow");
  return flow;
}

/** Creates a 'mirrored' Flow: a 1:1 wrapper around a SINGLE Task, with
 *  exactly one FlowStep. Unlike 'managed' Flows, the caller never calls
 *  updateFlowStep() directly for a mirrored Flow — instead,
 *  transitionTask() (see propagateToMirroredFlow() below) automatically
 *  mirrors every status change the wrapped Task goes through onto that
 *  one step, and the Flow's own overall status (running/succeeded/
 *  failed/cancelled) falls out of the SAME generic step-aggregation logic
 *  projectFlows() already used for 'managed' flows — no separate status
 *  machine for 'mirrored'. The only genuinely different thing is WHO
 *  drives the step transitions: the Task's own lifecycle, not a caller. */
export async function createMirroredFlow(taskInput: {
  type: Task["type"];
  agentId: string;
  workerId?: string;
  parentTaskId?: string;
  input: Record<string, unknown>;
  notifyPolicy?: Task["notifyPolicy"];
  timeoutMs?: number;
}): Promise<{ flow: Flow; task: Task }> {
  const flowId = generateId();
  await appendEvent(FLOWS_STREAM, "flow.created", { flowId, kind: "mirrored", steps: [{ id: "task", dependsOn: [] }] });

  const task = await createTask({ ...taskInput, flowId });

  // Bind the step to the Task immediately (taskId + its starting status),
  // rather than waiting for the first transitionTask() call, so
  // getFlow(flowId).steps[0].taskId is populated from the moment the Flow
  // exists — a caller inspecting the Flow right after creation shouldn't
  // see an unbound step.
  const created = await getFlow(flowId);
  if (!created) throw new Error("mirrored flow.created event did not project to a flow");
  await appendEvent(FLOWS_STREAM, "flow.step.updated", {
    flowId,
    stepId: created.steps[0]!.id,
    status: task.status,
    taskId: task.id,
  });

  const flow = await getFlow(flowId);
  if (!flow) throw new Error("mirrored flow.step.updated event did not project to a flow");
  return { flow, task };
}

/** Auto-propagation for 'mirrored' Flows — called from transitionTask()
 *  after every status change, for every Task (cheap no-op for the common
 *  case of a Task with no flowId, or a flowId pointing at a 'managed'
 *  Flow). If the Task belongs to a 'mirrored' Flow, its single FlowStep is
 *  updated to match via the SAME updateFlowStep() a 'managed' Flow's
 *  caller would use — so a mirrored Flow's status is always exactly the
 *  wrapped Task's status, with zero extra calls required from whoever is
 *  driving the Task. */
async function propagateToMirroredFlow(task: Task): Promise<void> {
  if (!task.flowId) return;
  const flow = await getFlow(task.flowId);
  if (!flow || flow.kind !== "mirrored") return;
  const step = flow.steps[0];
  if (!step) return;

  const result = await updateFlowStep(flow.id, step.id, task.status, flow.revision, task.id);
  if (!result.ok) {
    // In this single-process scaffold nothing else writes to a mirrored
    // Flow's one step, so a revision conflict here would mean something
    // unexpected raced this update. Logged rather than thrown — a
    // Flow-mirroring hiccup should never take down the Task transition
    // that triggered it (same "one broken thing shouldn't cascade"
    // principle eventbus.ts's publishEvent() documents for subscribers).
    console.error(
      `[tasks] mirrored flow ${flow.id} step update lost a revision race (expected ${flow.revision}, now ${result.currentRevision})`,
    );
  }
}

export async function updateFlowStep(
  flowId: string,
  stepId: string,
  status: TaskStatus,
  expectedRevision: number,
  taskId?: string,
): Promise<{ ok: true } | { ok: false; conflict: true; currentRevision: number }> {
  // Optimistic concurrency, mirroring OpenClaw's flow_runs revision counter:
  // a stale write is rejected rather than silently clobbering state.
  const current = await getFlow(flowId);
  if (!current) throw new Error(`no such flow: ${flowId}`);
  if (current.revision !== expectedRevision) {
    return { ok: false, conflict: true, currentRevision: current.revision };
  }
  await appendEvent(FLOWS_STREAM, "flow.step.updated", { flowId, stepId, status, taskId });
  return { ok: true };
}

interface FlowProjectionState {
  flows: Map<string, Flow>;
}

// Step statuses that count as "this step is finished" for Flow-level
// aggregation. Broadened beyond the original succeeded/failed/cancelled
// set to include timed_out/lost (both TaskStatus values a mirrored Flow's
// step can now legitimately land on via propagateToMirroredFlow) — Flow
// itself has no timed_out/lost status of its own, so either one is
// treated as a failure at the Flow level, same as "failed".
const STEP_DONE_STATUSES: TaskStatus[] = ["succeeded", "failed", "cancelled", "timed_out", "lost"];
const STEP_FAILURE_STATUSES: TaskStatus[] = ["failed", "timed_out", "lost"];

async function projectFlows(): Promise<FlowProjectionState> {
  return project<FlowProjectionState>(FLOWS_STREAM, { flows: new Map() }, (state, event) => {
    if (event.type === "flow.created") {
      const p = event.payload as any;
      state.flows.set(p.flowId, {
        id: p.flowId,
        kind: p.kind,
        status: "running",
        steps: p.steps.map((s: any) => ({ id: s.id, dependsOn: s.dependsOn, status: "queued" as TaskStatus })),
        revision: 0,
      });
    } else if (event.type === "flow.step.updated") {
      const p = event.payload as any;
      const flow = state.flows.get(p.flowId);
      if (!flow) return state;
      const steps: FlowStep[] = flow.steps.map((s) =>
        s.id === p.stepId ? { ...s, status: p.status as TaskStatus, taskId: p.taskId ?? s.taskId } : s,
      );
      if (flow.status === "cancelled") {
        // Terminal override: a cancelled Flow's OVERALL status never
        // reverts to running/succeeded/failed just because a step that
        // was already in flight happens to report in afterward — but the
        // step's own status is still recorded, for audit/visibility.
        state.flows.set(p.flowId, { ...flow, steps, revision: flow.revision + 1 });
        return state;
      }
      const allDone = steps.every((s) => STEP_DONE_STATUSES.includes(s.status));
      const anyFailed = steps.some((s) => STEP_FAILURE_STATUSES.includes(s.status));
      const flowStatus: Flow["status"] = allDone ? (anyFailed ? "failed" : "succeeded") : "running";
      state.flows.set(p.flowId, { ...flow, steps, revision: flow.revision + 1, status: flowStatus });
    } else if (event.type === "flow.cancelled") {
      const p = event.payload as any;
      const flow = state.flows.get(p.flowId);
      if (!flow) return state;
      state.flows.set(p.flowId, { ...flow, status: "cancelled", revision: flow.revision + 1 });
    }
    return state;
  });
}

export async function getFlow(flowId: string): Promise<Flow | undefined> {
  const { flows } = await projectFlows();
  return flows.get(flowId);
}

export async function listFlows(): Promise<Flow[]> {
  const { flows } = await projectFlows();
  return [...flows.values()];
}

/** Cancels a running Flow — a terminal override on top of the normal
 *  step-aggregation-derived status (see projectFlows()'s
 *  `flow.cancelled` handling above), plus best-effort propagation into
 *  every still-non-terminal Task linked to this flow (mirroring
 *  session.ts's cancelSession() for the same "stop real in-flight work,
 *  not just the bookkeeping" reason). flow-engine.ts's driveFlow() checks
 *  this status on every iteration and stops scheduling new steps once
 *  it's set — already-running steps are cancelled via their Task, not
 *  forcibly killed (same honest limitation as Session cancellation: this
 *  stops NEW work, it doesn't preempt a model call already in flight). */
export async function cancelFlow(flowId: string, reason?: string): Promise<Flow> {
  const existing = await getFlow(flowId);
  if (!existing) throw new Error(`no such flow: ${flowId}`);
  if (existing.status !== "running") {
    throw new Error(`flow ${flowId} is already terminal ("${existing.status}") and cannot be cancelled`);
  }
  await appendEvent(FLOWS_STREAM, "flow.cancelled", { flowId, reason });

  // Durable bookkeeping (appendEvent, above/below) is necessary but not
  // sufficient — unlike the normal step-completion path in
  // flow-engine.ts, nothing here was publishing to the live eventbus, so
  // cancelling a Flow updated its stored status but never told any open
  // SSE subscriber (FlowTab, the Events tab) to refresh. That's why
  // cancelling could leave a step showing "running" indefinitely in the
  // UI even though the Task itself was already marked cancelled
  // server-side. Mirror flow-engine.ts's own publishEvent shapes so the
  // same handlers pick these up.
  const linkedTasks = await listTasks({ flowId });
  for (const t of linkedTasks) {
    if (!TERMINAL_STATUSES.includes(t.status)) {
      await transitionTask(t.id, "cancelled", { reason: `flow ${flowId} was cancelled` });
      const step = existing.steps.find((s) => s.taskId === t.id);
      await publishEvent("flow.step.completed", { flowId, stepId: step?.id ?? t.id, agentId: t.agentId, taskId: t.id, status: "cancelled" });
    }
  }

  const updated = await getFlow(flowId);
  if (!updated) throw new Error("flow.cancelled event did not project to a flow");
  await publishEvent("flow.completed", { flowId, status: updated.status });
  return updated;
}

// ---- Automation (registry only in this scaffold — no real scheduler yet;
// see /docs/architecture.md for the two-mode Automations/Heartbeat design
// this will grow into). ----

const AUTOMATIONS_STREAM = "automations";

export async function registerAutomation(input: Omit<Automation, "id">): Promise<Automation> {
  const id = generateId();
  await appendEvent(AUTOMATIONS_STREAM, "automation.registered", { automationId: id, ...input });
  const automation = await getAutomation(id);
  if (!automation) throw new Error("automation.registered event did not project");
  return automation;
}

async function projectAutomations(): Promise<Map<string, Automation>> {
  return project<Map<string, Automation>>(AUTOMATIONS_STREAM, new Map(), (state, event) => {
    if (event.type === "automation.registered") {
      const p = event.payload as any;
      state.set(p.automationId, {
        id: p.automationId,
        trigger: p.trigger,
        agentId: p.agentId,
        promptTemplate: p.promptTemplate,
        enabled: p.enabled ?? true,
      });
    } else if (event.type === "automation.toggled") {
      const p = event.payload as any;
      const existing = state.get(p.automationId);
      if (existing) state.set(p.automationId, { ...existing, enabled: p.enabled });
    }
    return state;
  });
}

export async function getAutomation(id: string): Promise<Automation | undefined> {
  return (await projectAutomations()).get(id);
}

export async function listAutomations(): Promise<Automation[]> {
  return [...(await projectAutomations()).values()];
}
