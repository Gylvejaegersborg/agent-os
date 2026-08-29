// Scheduler — makes Automation (tasks.ts) actually fire, per
// docs/architecture.md §2's "two scheduling modes" note. This scaffold
// implements ONE of the two modes explicitly: precise-timing Automations
// (cron + event triggers). The second mode described in the architecture
// doc — Heartbeat (imprecise timing, full main-session context, for
// "check the inbox"-style work) — is NOT implemented here; it's a
// genuinely different mechanism (a recurring turn in an existing
// long-lived session, not a spawned isolated Task) and deserves its own
// pass rather than being half-built alongside this one. Stated explicitly,
// not hidden — same pattern as the sandbox limitation note in permissions.ts.
//
// Trigger kinds: 'cron' is fully implemented (tick loop + zero-dependency
// parser below). 'event' is implemented as a manual dispatch function
// (fireEventAutomations) rather than a tick — there's no event bus in this
// scaffold yet, so "firing" means "something in your own code calls this
// when the event happens." 'webhook' is NOT implemented — it needs an
// actual HTTP listener, out of scope for this scaffold.
//
// Every automation firing is itself just event-sourced: a Task is created
// (type: 'cron'), a real agent-loop turn runs in its own isolated session
// (never the automation's own history — each firing starts fresh, matching
// "isolated context" from the architecture doc), and an
// `automation.fired` event records when it last ran — which is also how
// dedup works (never fire the same cron minute twice), so a scheduler
// restart never double-fires or loses its place.

import { project, appendEvent } from "./eventlog.js";
import { generateId } from "./id.js";
import { createTask, transitionTask } from "./tasks.js";
import { runTurn, newSessionId } from "./agent-loop.js";
import { fireHook } from "./hooks.js";
import type { Automation } from "./types.js";
import type { ModelAdapter } from "./model.js";
import type { Worker } from "./worker.js";
import type { SkillRegistry } from "./skills.js";
import { listAutomations } from "./tasks.js";

const AUTOMATIONS_STREAM = "automations"; // same stream tasks.ts already writes to

// ---- Minimal zero-dependency 5-field cron parser (minute hour day month weekday) ----

function parseCronField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>();
  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(\*|\d+-\d+|\d+)\/(\d+)$/);
    if (stepMatch) {
      const [, range, stepStr] = stepMatch;
      const step = Number(stepStr);
      const [rangeMin, rangeMax] = range === "*" ? [min, max] : range.split("-").map(Number);
      for (let v = rangeMin; v <= rangeMax; v += step) result.add(v);
      continue;
    }
    if (part === "*") {
      for (let v = min; v <= max; v++) result.add(v);
      continue;
    }
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const [, a, b] = rangeMatch;
      for (let v = Number(a); v <= Number(b); v++) result.add(v);
      continue;
    }
    const n = Number(part);
    if (!Number.isNaN(n)) result.add(n);
  }
  return result;
}

export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  weekday: Set<number>;
}

/** Parses a standard 5-field cron expression ("minute hour day month
 *  weekday"). Throws on malformed input rather than silently matching
 *  nothing — a scheduler that silently never fires is worse than one that
 *  fails loudly at registration time. */
export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`invalid cron expression "${expr}": expected 5 fields (minute hour day month weekday), got ${fields.length}`);
  }
  const [minute, hour, day, month, weekday] = fields;
  return {
    minute: parseCronField(minute, 0, 59),
    hour: parseCronField(hour, 0, 23),
    day: parseCronField(day, 1, 31),
    month: parseCronField(month, 1, 12),
    weekday: parseCronField(weekday, 0, 6), // 0 = Sunday
  };
}

/** Checks whether a cron expression matches the given local time, to
 *  minute precision. Uses local time deliberately (matches user
 *  expectation for a personal-OS scheduler; document if you need UTC). */
export function cronMatches(expr: string, date: Date): boolean {
  const parsed = parseCron(expr);
  return (
    parsed.minute.has(date.getMinutes()) &&
    parsed.hour.has(date.getHours()) &&
    parsed.day.has(date.getDate()) &&
    parsed.month.has(date.getMonth() + 1) &&
    parsed.weekday.has(date.getDay())
  );
}

function minuteKey(date: Date): string {
  // Floors to the minute — this is the dedup granularity: an automation
  // can fire at most once per matching minute, regardless of how often
  // the tick loop itself runs.
  return date.toISOString().slice(0, 16); // "YYYY-MM-DDTHH:MM"
}

async function projectFiredMinutes(): Promise<Map<string, string>> {
  // automationId -> minuteKey of its most recent firing
  return project<Map<string, string>>(AUTOMATIONS_STREAM, new Map(), (state, event) => {
    if (event.type === "automation.fired") {
      const p = event.payload as any;
      state.set(p.automationId, p.minuteKey);
    }
    return state;
  });
}

export interface SchedulerDeps {
  model: ModelAdapter;
  worker: Worker;
  skills?: SkillRegistry;
}

export interface FireResult {
  automationId: string;
  taskId: string;
  sessionId: string;
  finalContent: string;
}

async function fireAutomation(automation: Automation, deps: SchedulerDeps, now: Date): Promise<FireResult> {
  const task = await createTask({
    type: "cron",
    agentId: automation.agentId,
    input: { automationId: automation.id, trigger: automation.trigger },
  });
  await fireHook("task.created", { agentId: automation.agentId, sessionId: task.id, payload: { task } });
  await transitionTask(task.id, "running");

  const sessionId = newSessionId(); // isolated context — never the automation's own history
  let result: { finalContent: string };
  try {
    result = await runTurn({
      sessionId,
      agentId: automation.agentId,
      userMessage: automation.promptTemplate,
      model: deps.model,
      worker: deps.worker,
      skills: deps.skills,
    });
    await transitionTask(task.id, "succeeded", { output: { finalContent: result.finalContent } });
    await fireHook("task.completed", { agentId: automation.agentId, sessionId: task.id, payload: { task, result } });
  } catch (err) {
    await transitionTask(task.id, "failed", { output: { error: err instanceof Error ? err.message : String(err) } });
    await fireHook("task.failed", { agentId: automation.agentId, sessionId: task.id, payload: { task, error: err } });
    throw err;
  }

  await appendEvent(AUTOMATIONS_STREAM, "automation.fired", {
    automationId: automation.id,
    taskId: task.id,
    sessionId,
    minuteKey: minuteKey(now),
    firedAt: now.toISOString(),
  });

  return { automationId: automation.id, taskId: task.id, sessionId, finalContent: result.finalContent };
}

/** Checks every enabled cron-triggered automation against `now` and fires
 *  any that are due and haven't already fired this exact minute. Call this
 *  on an interval (see startScheduler) or once for a manual/demo check —
 *  it's idempotent within a given minute either way. */
export async function runSchedulerTick(deps: SchedulerDeps, now: Date = new Date()): Promise<FireResult[]> {
  const automations = await listAutomations();
  const firedMinutes = await projectFiredMinutes();
  const results: FireResult[] = [];

  for (const automation of automations) {
    if (!automation.enabled) continue;
    if (automation.trigger.kind !== "cron") continue; // event/webhook not tick-driven
    if (!cronMatches(automation.trigger.expr, now)) continue;
    if (firedMinutes.get(automation.id) === minuteKey(now)) continue; // already fired this minute

    results.push(await fireAutomation(automation, deps, now));
  }

  return results;
}

/** Manually fires every enabled event-triggered automation matching
 *  `eventType` (and, if the automation specifies a filter, every filter
 *  key/value must match the given payload). There's no event bus in this
 *  scaffold — call this from wherever the real event actually happens
 *  (e.g. after a webhook handler, after a hook fires) rather than
 *  expecting it to be wired automatically. */
export async function fireEventAutomations(
  eventType: string,
  payload: Record<string, unknown>,
  deps: SchedulerDeps,
  now: Date = new Date(),
): Promise<FireResult[]> {
  const automations = await listAutomations();
  const results: FireResult[] = [];

  for (const automation of automations) {
    if (!automation.enabled) continue;
    if (automation.trigger.kind !== "event") continue;
    if (automation.trigger.eventType !== eventType) continue;
    const filter = automation.trigger.filter;
    if (filter && !Object.entries(filter).every(([k, v]) => payload[k] === v)) continue;

    results.push(await fireAutomation(automation, deps, now));
  }

  return results;
}

export interface SchedulerHandle {
  stop: () => void;
}

/** Starts a real background tick loop — the actual "run this as a
 *  service" scheduler, not just a proof-of-concept single check. Ticks
 *  every `intervalMs` (default 30s, comfortably under the 1-minute cron
 *  granularity so no matching minute is ever skipped) and logs any
 *  automations it fires. Returns a handle whose stop() clears the
 *  interval — always hold onto it; an orphaned setInterval is a resource
 *  leak in a long-running process. */
export function startScheduler(deps: SchedulerDeps, intervalMs = 30_000): SchedulerHandle {
  const timer = setInterval(() => {
    runSchedulerTick(deps).then((fired) => {
      for (const f of fired) {
        console.log(`[scheduler] fired automation ${f.automationId} -> task ${f.taskId}: "${f.finalContent.slice(0, 80)}"`);
      }
    }).catch((err) => {
      console.error("[scheduler] tick failed:", err instanceof Error ? err.message : err);
    });
  }, intervalMs);
  // Don't let this interval alone keep the Node process alive if
  // everything else has finished — matches how the rest of this scaffold
  // avoids surprising process-lifetime side effects.
  if (typeof timer.unref === "function") timer.unref();
  return { stop: () => clearInterval(timer) };
}
