// Worker registry — observable lifecycle state ABOUT a Worker (worker.ts),
// kept deliberately separate from the Worker interface itself. worker.ts's
// Workers are plain `{id, kind, run()}` objects: nothing remembers one
// exists once it's constructed, so "list active workers" / "is this
// worker still running" had no answer anywhere in the codebase. This file
// is that missing registry, same event-sourced shape as every other
// registry here (tasks.ts, session.ts, approvals.ts): a `workers` stream,
// reduced by project().
//
// Registering a Worker here is OPT-IN, not automatic — createLocalShellWorker()
// and friends (worker.ts) still work completely unchanged with no registry
// entry at all, which matters for every existing test/demo that constructs
// a Worker inline without caring about lifecycle observability. A caller
// that DOES want a Worker to show up in "list workers" calls registerWorker()
// once, then markWorkerStarted()/markWorkerStopped()/markWorkerError() as
// its actual lifecycle unfolds.

import { project, appendEvent } from "./eventlog.js";
import type { WorkerRecord, WorkerLifecycleStatus } from "./types.js";

const WORKERS_STREAM = "workers";

export interface RegisterWorkerInput {
  /** Should match the Worker's own `.id` (worker.ts) — kept as an
   *  explicit caller-supplied value rather than generated here, so a
   *  registry lookup by the same id a Task's `workerId` field
   *  (types.ts's Task) already carries just works, with no separate
   *  id-mapping table to keep in sync. */
  id: string;
  kind: string;
  metadata?: Record<string, unknown>;
}

export async function registerWorker(input: RegisterWorkerInput): Promise<WorkerRecord> {
  await appendEvent(WORKERS_STREAM, "worker.registered", {
    workerId: input.id,
    kind: input.kind,
    metadata: input.metadata ?? {},
  });
  const record = await getWorkerRecord(input.id);
  if (!record) throw new Error("worker.registered event did not project to a worker record");
  return record;
}

interface WorkerProjectionState {
  workers: Map<string, WorkerRecord>;
}

async function projectWorkers(): Promise<WorkerProjectionState> {
  return project<WorkerProjectionState>(WORKERS_STREAM, { workers: new Map() }, (state, event) => {
    if (event.type === "worker.registered") {
      const p = event.payload as any;
      state.workers.set(p.workerId, {
        id: p.workerId,
        kind: p.kind,
        status: "starting",
        registeredAt: event.timestamp,
        metadata: p.metadata ?? {},
      });
    } else if (event.type === "worker.status.changed") {
      const p = event.payload as any;
      const existing = state.workers.get(p.workerId);
      if (!existing) return state;
      const updated: WorkerRecord = { ...existing, status: p.status };
      if (p.status === "running" && !updated.startedAt) updated.startedAt = event.timestamp;
      if (p.status === "stopped") updated.stoppedAt = event.timestamp;
      if (p.status === "error") updated.lastError = p.error;
      state.workers.set(p.workerId, updated);
    }
    return state;
  });
}

export async function getWorkerRecord(id: string): Promise<WorkerRecord | undefined> {
  return (await projectWorkers()).workers.get(id);
}

export async function listWorkerRecords(filter?: {
  status?: WorkerLifecycleStatus;
  kind?: string;
}): Promise<WorkerRecord[]> {
  const { workers } = await projectWorkers();
  let list = [...workers.values()];
  if (filter?.status) list = list.filter((w) => w.status === filter.status);
  if (filter?.kind) list = list.filter((w) => w.kind === filter.kind);
  return list.sort((a, b) => a.registeredAt.localeCompare(b.registeredAt));
}

async function setWorkerStatus(
  id: string,
  status: WorkerLifecycleStatus,
  extra: { error?: string } = {},
): Promise<WorkerRecord> {
  const existing = await getWorkerRecord(id);
  if (!existing) throw new Error(`no such registered worker: ${id}`);
  await appendEvent(WORKERS_STREAM, "worker.status.changed", { workerId: id, status, ...extra });
  const updated = await getWorkerRecord(id);
  if (!updated) throw new Error("worker.status.changed event did not project to a worker record");
  return updated;
}

export async function markWorkerStarted(id: string): Promise<WorkerRecord> {
  return setWorkerStatus(id, "running");
}

/** Stopping is NOT terminal — unlike a Session/ApprovalRequest, a stopped
 *  Worker can be started again (e.g. restarted after a crash, or
 *  deliberately paused and resumed), so this deliberately does not
 *  enforce a "cannot transition out of stopped" rule. */
export async function markWorkerStopped(id: string): Promise<WorkerRecord> {
  return setWorkerStatus(id, "stopped");
}

export async function markWorkerError(id: string, error: string): Promise<WorkerRecord> {
  return setWorkerStatus(id, "error", { error });
}
