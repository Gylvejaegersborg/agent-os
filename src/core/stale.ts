// Stale-work visibility, after Paperclip's rule: surface what's stuck, don't
// quietly reassign it. One list of what needs the operator's eyes:
//
//   - Work items "in progress" whose run has gone quiet — no session activity
//     for AGENT_OS_STALE_RUN_MIN (default 20). A hung model call looks
//     exactly like this: the item says "working" forever.
//   - Runtime tasks still "running" with no activity besides liveness
//     renewals. Liveness only proves the process is up (the renewer keeps
//     every running task alive), not that the task is moving.
//   - Runs that ended lost, timed out or failed in the last day.
//
// Work items that simply haven't moved in a day are the lead's (review.ts)
// and show on the Team review card; this is about runs.

import { readStream } from "./eventlog.js";
import { listSessions } from "./session.js";
import { listTasks } from "./tasks.js";
import { listWork } from "./work.js";

export interface StaleEntry {
  kind: "work" | "run";
  id: string;
  title: string;
  agentId: string;
  status: string;
  /** Why it's listed, in words. */
  why: string;
  /** Last real activity (or when it ended). */
  since: string;
}

export function staleRunMs(): number {
  const m = Number(process.env.AGENT_OS_STALE_RUN_MIN ?? 20);
  return (Number.isFinite(m) && m > 0 ? m : 20) * 60_000;
}

const RECENT_END_MS = 24 * 3_600_000;

function ago(iso: string, now: number): string {
  const m = Math.round((now - Date.parse(iso)) / 60_000);
  return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`;
}

async function lastSessionActivity(sessionId: string): Promise<string | undefined> {
  const events = await readStream(`session:${sessionId}`);
  return events.at(-1)?.timestamp;
}

const latest = (...ts: (string | undefined)[]) => ts.filter((t): t is string => !!t).sort().at(-1);

export async function listStaleWork(opts: { now?: number; quietMs?: number } = {}): Promise<StaleEntry[]> {
  const now = opts.now ?? Date.now();
  const quietMs = opts.quietMs ?? staleRunMs();
  const out: StaleEntry[] = [];

  for (const w of await listWork({ status: "in_progress" })) {
    const last = latest(w.updatedAt, w.sessionId ? await lastSessionActivity(w.sessionId) : undefined)!;
    if (now - Date.parse(last) > quietMs) {
      out.push({ kind: "work", id: w.id, title: w.title, agentId: w.assignee, status: w.status, why: `working, but nothing has happened for ${ago(last, now)}`, since: last });
    }
  }

  const tasks = await listTasks();
  const sessions = await listSessions();
  for (const t of tasks) {
    const title = String(t.input.goal ?? t.input.prompt ?? t.input.name ?? t.type).slice(0, 120);
    if (t.status === "running") {
      const linked = sessions.filter((s) => s.taskId === t.id);
      const sessionTimes = await Promise.all(linked.map((s) => lastSessionActivity(s.id)));
      const last = latest(t.startedAt, t.createdAt, ...sessionTimes)!;
      if (now - Date.parse(last) > quietMs) {
        out.push({ kind: "run", id: t.id, title, agentId: t.agentId, status: t.status, why: `running, but nothing has happened for ${ago(last, now)} (it's only renewing liveness)`, since: last });
      }
    } else if ((t.status === "lost" || t.status === "timed_out" || t.status === "failed") && t.completedAt && now - Date.parse(t.completedAt) < RECENT_END_MS) {
      const why =
        t.status === "lost" ? "lost — the process running it went away (e.g. a gateway restart)"
        : t.status === "timed_out" ? "timed out"
        : `failed${typeof t.output?.error === "string" ? `: ${String(t.output.error).slice(0, 160)}` : ""}`;
      out.push({ kind: "run", id: t.id, title, agentId: t.agentId, status: t.status, why, since: t.completedAt });
    }
  }
  return out.sort((a, b) => a.since.localeCompare(b.since));
}
