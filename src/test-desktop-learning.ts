// Tests for learning from desktop activity (core/desktop-learning.ts).
// Proves:
//   1. A busy day becomes a few fixed-wording observations in the memory pipeline;
//      a quiet day writes nothing; a day with no data yet is retried, not skipped.
//   2. Each day is learned once (running again writes nothing).
//   3. Nothing reaches curated memory by itself: only dreaming promotes, and only a
//      pattern that repeated over several days. A one-day observation stays put.
//   4. The operator's correction is promoted at once (it is the heaviest signal).
//   5. Week ids are ISO weeks; the weekly observations stay quiet on thin weeks.
// Run with: node dist/test-desktop-learning.js

import "./test-helpers/isolate.js";
import {
  recordDesktopBatch,
  saveSnapshot,
  listEpisodic,
  getCuratedMemory,
  runDreamingPass,
  learnFromDesktop,
  recordDesktopCorrection,
  weekOf,
  weekObservations,
  dayObservations,
  desktopDaySummary,
  localDay,
} from "./core/index.js";

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`ok: ${msg}`);
  else {
    failed = true;
    console.log(`FAIL: ${msg}`);
  }
}

const now = new Date();
const dayAt = (back: number, hour: number, min = 0) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, hour, min);
const iso = (d: Date) => d.toISOString();
let n = 0;
const span = (kind: "active" | "idle", app: string, title: string, from: Date, minutes: number) => ({
  id: `L${++n}`,
  kind,
  app,
  title,
  start: iso(from),
  end: iso(new Date(from.getTime() + minutes * 60_000)),
});

await saveSnapshot({ schema: 1, projects: [{ id: "p1", name: "Sinnsyk", status: "active", tagline: "", progress: 0, tags: [], props: {}, nextMoves: [], recent: [] }], goals: [] });

// Four evenings of two hours in FL Studio (days 5..2 back). Only the last also has a Sinnsyk window.
for (const back of [5, 4, 3, 2]) {
  const title = back === 2 ? "Sinnsyk.flp - FL Studio" : "Track.flp - FL Studio";
  await recordDesktopBatch({ device: "server", spans: [span("active", "FL64.exe", title, dayAt(back, 19), 40), span("active", "FL64.exe", "Track.flp - FL Studio", dayAt(back, 19, 40), 40), span("active", "FL64.exe", "Track.flp - FL Studio", dayAt(back, 20, 20), 40)] });
}
// Yesterday: ten minutes of browsing, which is too little to say anything about.
await recordDesktopBatch({ device: "server", spans: [span("active", "chrome.exe", "News - Chrome", dayAt(1, 14), 10)] });

const summary = await desktopDaySummary(localDay(dayAt(5, 12)));
const obs = await dayObservations(summary);
assert(obs.includes("Most of the operator's active desktop time falls in the evening."), "the peak part of the day is named");
assert(obs.includes("Most desktop time goes to FL64."), "the main app is named (without .exe)");
assert(obs.some((o) => /^Focus blocks in FL64 last about 120 minutes\.$/.test(o)), "focus blocks are described with the length rounded to 15 minutes");
assert(obs.length === 4, `a plain day gives four observations (got ${obs.length}), including that titles matched no project`);
assert((await dayObservations(await desktopDaySummary(localDay(dayAt(1, 12))))).length === 0, "ten minutes of browsing is a quiet day: nothing to say");

// --- learning ---------------------------------------------------------------
const first = await learnFromDesktop({ now, agentId: "hemera" });
const learnedDays = [5, 4, 3, 2, 1].map((b) => localDay(dayAt(b, 12)));
assert(JSON.stringify(first.days) === JSON.stringify(learnedDays), `every day with data is learned, oldest first (${first.days.length} days)`);
assert(!first.days.includes(localDay(dayAt(6, 12))) && !first.days.includes(localDay(dayAt(7, 12))), "days with no data yet are left to try again later");
const entries = await listEpisodic("hemera");
const daily = entries.filter((e) => e.sourceSessionId === "desktop-learning");
assert(daily.length >= 13 && daily.every((e) => e.kind === "fact" && !e.wasExplicitCorrection), `the observations are plain facts (${daily.length} written, none flagged as corrections)`);
assert(daily.some((e) => e.content === 'The operator spends desktop time on the project "Sinnsyk".'), "time on a matched project is recorded");

const again = await learnFromDesktop({ now, agentId: "hemera" });
assert(again.days.length === 0 && (await listEpisodic("hemera")).length === entries.length, "running again writes nothing: each day is learned once");

// --- the memory gate --------------------------------------------------------
assert((await getCuratedMemory("hemera")).content === "", "nothing is in curated memory before dreaming runs");
await runDreamingPass("hemera");
const curated = (await getCuratedMemory("hemera")).content;
assert(curated.includes("Most desktop time goes to FL64."), "a pattern that repeated over four days is promoted by dreaming");
assert(curated.includes("Most of the operator's active desktop time falls in the evening."), "…including the time-of-day pattern");
assert(!curated.includes("Sinnsyk"), "an observation from a single day is not promoted");

await recordDesktopCorrection("that FL time was a client's session, not my own music");
await runDreamingPass("hemera");
const after = await getCuratedMemory("hemera");
assert(after.content.includes("client's session"), "the operator's correction is promoted on the next pass (it weighs 50 on its own)");
try {
  await recordDesktopCorrection("   ");
  assert(false, "an empty correction is refused");
} catch {
  assert(true, "an empty correction is refused");
}

// --- weeks ------------------------------------------------------------------
assert(weekOf("2026-01-01") === "2026-W01" && weekOf("2025-12-29") === "2026-W01", "ISO weeks: 29 Dec 2025 belongs to 2026-W01");
assert(weekOf("2021-01-03") === "2020-W53" && weekOf("2024-12-30") === "2025-W01", "ISO weeks: year boundaries (2020-W53, 2025-W01)");
assert(weekOf("2026-09-28") === "2026-W40" && weekOf("2026-10-04") === "2026-W40", "Monday and Sunday of the same week share an id");
const week = { week: "2026-W40", days: [], activeSec: 3600, activeDays: 4, daysWithFocusBlock: 0, byWork: [], goalsWithoutTime: [{ id: "g1", name: "Release Sinnsyk" }] };
const wobs = weekObservations(week);
assert(wobs.length === 2 && /Release Sinnsyk/.test(wobs[0]!) && /without a single long focus block/.test(wobs[1]!), "a full week names active goals that got no time, and a week with no focus blocks");
assert(weekObservations({ ...week, activeDays: 2 }).length === 0, "a thin week (under three active days) says nothing about what's missing");

console.log(failed ? "\nSome desktop-learning tests FAILED." : "\nAll desktop-learning tests passed.");
if (failed) process.exitCode = 1;
