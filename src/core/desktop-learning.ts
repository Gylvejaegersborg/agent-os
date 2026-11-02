// Learning from desktop activity, through the memory pipeline that already exists.
//
// There is no separate "coach" and no extra approval flow. Each finished day (and
// each finished week) is turned into a few plain observations by CODE, worded from
// fixed templates with rounded numbers, and written with writeEpisodic(). That is
// all it takes:
//   - writeEpisodic mirrors each entry into Hindsight (when configured), so the
//     agents' long-term memory gets the pattern;
//   - repetition detection counts the same wording seen on earlier days, and
//     dreaming (memory.ts scoreEligibility) only promotes an observation into curated
//     memory after it has repeated over several days, so a one-off day never sticks;
//   - nothing here writes curated memory or decides anything: dreaming does, and the
//     operator's corrections weigh most (recordDesktopCorrection).
//
// No model turn is involved. A quiet day writes nothing. What these observations can
// and can't say is limited on purpose: window titles tell where time went, not why,
// and project matching is by title, so "unmatched" may just mean titles don't carry
// project names (the wording says so).

import { appendEvent, readStream } from "./eventlog.js";
import { listEpisodic, writeEpisodic } from "./memory.js";
import { desktopDaySummary, desktopTimeline, localDay, type DesktopDaySummary } from "./desktop.js";
import { loadSnapshot } from "./basespace.js";

const STREAM = "desktop-learning";
const SOURCE = "desktop-learning";
/** A day with less active time than this says nothing about how the operator works. */
export const QUIET_SEC = 20 * 60;
const DAYS_BACK = 7;

export function learningAgentId(): string {
  return process.env.AGENT_OS_LEARNING_AGENT?.trim() || "hemera";
}

const appName = (app: string) => app.replace(/\.exe$/i, "");
const roundTo = (n: number, step: number) => Math.max(step, Math.round(n / step) * step);

type Bucket = "morning" | "afternoon" | "evening" | "night";
const bucketOf = (hour: number): Bucket => (hour >= 5 && hour < 12 ? "morning" : hour >= 12 && hour < 17 ? "afternoon" : hour >= 17 && hour < 22 ? "evening" : "night");

/** Active seconds per part of the day, local time. */
async function activeByBucket(day: string): Promise<Record<Bucket, number>> {
  const out: Record<Bucket, number> = { morning: 0, afternoon: 0, evening: 0, night: 0 };
  for (const s of await desktopTimeline(day)) {
    if (s.kind !== "active") continue;
    // Split at the hour so a long span is shared between the parts it crosses.
    let t = Date.parse(s.start);
    const end = Date.parse(s.end);
    while (t < end) {
      const next = Math.min(end, new Date(new Date(t).setMinutes(60, 0, 0)).getTime());
      out[bucketOf(new Date(t).getHours())] += (next - t) / 1000;
      t = next;
    }
  }
  return out;
}

/** The day's observations. Fixed wording: the same pattern on another day is the same sentence. */
export async function dayObservations(s: DesktopDaySummary): Promise<string[]> {
  if (s.activeSec < QUIET_SEC) return [];
  const out: string[] = [];

  const buckets = await activeByBucket(s.day);
  const [peak, peakSec] = (Object.entries(buckets) as [Bucket, number][]).sort((a, b) => b[1] - a[1])[0]!;
  if (peakSec >= s.activeSec * 0.5) out.push(`Most of the operator's active desktop time falls in the ${peak}.`);

  const top = s.byApp[0];
  if (top && top.sec >= s.activeSec * 0.4) out.push(`Most desktop time goes to ${appName(top.app)}.`);

  if (s.focusBlocks.length) {
    // The app with the most focus-block time, and how long its blocks usually last.
    const perApp = new Map<string, number[]>();
    for (const b of s.focusBlocks) perApp.set(b.app, [...(perApp.get(b.app) ?? []), b.sec]);
    const [app, secs] = [...perApp].sort((a, b) => b[1].reduce((x, y) => x + y, 0) - a[1].reduce((x, y) => x + y, 0))[0]!;
    const sorted = [...secs].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    out.push(`Focus blocks in ${appName(app)} last about ${roundTo(median / 60, 15)} minutes.`);
  } else if (s.activeSec >= 60 * 60 && s.switches / (s.activeSec / 3600) > 30) {
    out.push("Some days run fragmented: many app switches and no long focus block.");
  }

  for (const w of s.byWork) if (w.sec >= 30 * 60) out.push(`The operator spends desktop time on the ${w.kind} "${w.name}".`);

  if (s.activeSec >= 60 * 60 && s.unmatchedSec > s.activeSec * 0.7) {
    out.push("Most desktop time isn't matched to a BaseSpace project or goal by window title (titles may simply not carry their names).");
  }
  return out;
}

async function learned(type: "desktop.day.learned" | "desktop.week.learned", field: "day" | "week"): Promise<Set<string>> {
  return new Set((await readStream(STREAM)).filter((e) => e.type === type).map((e) => String(e.payload[field])));
}

const daysBack = (base: Date, back: number) => localDay(new Date(base.getFullYear(), base.getMonth(), base.getDate() - back, 12));

/** ISO week id of a local day ("2026-W40"; weeks start on Monday). */
export function weekOf(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7) + 3); // the Thursday decides the year
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
  const n = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${date.getUTCFullYear()}-W${String(n).padStart(2, "0")}`;
}

export interface WeekDigest {
  week: string;
  days: string[];
  activeSec: number;
  activeDays: number;
  daysWithFocusBlock: number;
  byWork: { kind: "project" | "goal"; id: string; name: string; sec: number }[];
  /** Active goals no window title matched all week. */
  goalsWithoutTime: { id: string; name: string }[];
}

/** The week's numbers, built by code (the Monday-to-Sunday week containing `anyDay`). */
export async function weekDigest(anyDay: string): Promise<WeekDigest> {
  const [y, m, d] = anyDay.split("-").map(Number) as [number, number, number];
  const dow = (new Date(y, m - 1, d).getDay() + 6) % 7;
  const days = Array.from({ length: 7 }, (_, i) => localDay(new Date(y, m - 1, d - dow + i, 12)));
  const sums = await Promise.all(days.map((day) => desktopDaySummary(day)));
  const work = new Map<string, WeekDigest["byWork"][number]>();
  for (const s of sums) for (const w of s.byWork) work.set(`${w.kind}:${w.id}`, { ...w, sec: (work.get(`${w.kind}:${w.id}`)?.sec ?? 0) + w.sec });
  const snap = await loadSnapshot().catch(() => undefined);
  const goals = (Array.isArray(snap?.goals) ? snap!.goals : []).filter((g: any) => g.status === "active");
  return {
    week: weekOf(anyDay),
    days,
    activeSec: sums.reduce((n, s) => n + s.activeSec, 0),
    activeDays: sums.filter((s) => s.activeSec >= QUIET_SEC).length,
    daysWithFocusBlock: sums.filter((s) => s.focusBlocks.length).length,
    byWork: [...work.values()].sort((a, b) => b.sec - a.sec),
    goalsWithoutTime: goals.filter((g: any) => !work.has(`goal:${g.id}`)).map((g: any) => ({ id: String(g.id), name: String(g.title ?? "") })),
  };
}

export function weekObservations(w: WeekDigest): string[] {
  // Fewer than three active days is too thin a week to say what's missing.
  if (w.activeDays < 3) return [];
  const out = w.goalsWithoutTime.map((g) => `No desktop time all week matched the active goal "${g.name}" by window title.`);
  if (w.daysWithFocusBlock === 0) out.push("A whole week passed without a single long focus block.");
  return out;
}

/** Writes one observation with an EXACT repeat count (how many earlier entries have this very sentence).
 *  The memory's fuzzy similarity would count "desktop time on project X" as a repeat of "desktop time in the
 *  evening", and one day's observation would look like a habit. */
async function writeFact(agentId: string, content: string): Promise<void> {
  const repetitionCount = (await listEpisodic(agentId)).filter((e) => e.content === content).length;
  await writeEpisodic({ agentId, content, kind: "fact", sourceSessionId: SOURCE, repetitionCount });
}

export interface LearnResult {
  days: string[];
  written: number;
}

/** Learns from every finished, not-yet-learned day of the last week, then from the week that
 *  just ended if not yet done. Safe to call as often as you like: each day and week counts once. */
export async function learnFromDesktop(opts: { now?: Date; agentId?: string } = {}): Promise<LearnResult> {
  const now = opts.now ?? new Date();
  const agentId = opts.agentId ?? learningAgentId();
  const done = await learned("desktop.day.learned", "day");
  const result: LearnResult = { days: [], written: 0 };
  // Oldest first, so the entries' order matches the days they came from.
  for (let back = DAYS_BACK; back >= 1; back--) {
    const day = daysBack(now, back);
    if (done.has(day)) continue;
    const summary = await desktopDaySummary(day);
    // Nothing recorded may just be a sensor that hasn't reported yet: look again next time.
    if (!summary.activeSec && !summary.idleSec) continue;
    let written = 0;
    for (const content of await dayObservations(summary)) {
      await writeFact(agentId, content);
      written++;
    }
    await appendEvent(STREAM, "desktop.day.learned", { day, written });
    result.days.push(day);
    result.written += written;
  }

  // The week that ended last Sunday (only once it is over).
  const lastSunday = daysBack(now, ((now.getDay() + 6) % 7) + 1);
  const week = weekOf(lastSunday);
  if (!(await learned("desktop.week.learned", "week")).has(week)) {
    const digest = await weekDigest(lastSunday);
    if (digest.activeSec) {
      let written = 0;
      for (const content of weekObservations(digest)) {
        await writeFact(agentId, content);
        written++;
      }
      await appendEvent(STREAM, "desktop.week.learned", { week, written });
      result.written += written;
    }
  }
  return result;
}

/** The operator's own correction ("no, that wasn't work"): the heaviest signal dreaming knows. */
export async function recordDesktopCorrection(text: string, agentId = learningAgentId()): Promise<void> {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, 500);
  if (!clean) throw new Error("a correction needs some text");
  await writeEpisodic({ agentId, content: `The operator corrected an observation about their desktop activity: ${clean}`, kind: "correction", sourceSessionId: SOURCE, wasExplicitCorrection: true });
}

export interface DesktopLearningHandle {
  stop: () => void;
}

/** Runs learnFromDesktop shortly after start and then every hour. */
export function startDesktopLearning(intervalMs = 60 * 60_000): DesktopLearningHandle {
  const run = () =>
    learnFromDesktop().then(
      (r) => {
        if (r.days.length) console.log(`[desktop] learned from ${r.days.join(", ")}: ${r.written} observation(s) into ${learningAgentId()}'s memory`);
      },
      (err) => console.error("[desktop] learning failed:", err instanceof Error ? err.message : err),
    );
  const first = setTimeout(() => void run(), 30_000);
  const timer = setInterval(() => void run(), intervalMs);
  for (const t of [first, timer]) if (typeof t.unref === "function") t.unref();
  return {
    stop: () => {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
