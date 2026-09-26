// Runs BaseSpace's TEAM cron jobs — the standups and other meetings the
// operator schedules for a team in BaseSpace (Workbench → Teams → Schedule
// standup). BaseSpace owns the schedule (it's in the snapshot); this is
// what actually holds the meeting.
//
// Deliberately narrow: only jobs with a `team` set are run here. BaseSpace's
// other cron jobs are descriptive (what an agent does on a schedule) and
// firing a model call for every 15-minute job would be expensive noise.
//
// Each run: the team's lead (first member) chairs, reads BaseSpace with the
// basespace tool and writes the minutes back as a note (Team/Meetings) plus
// any todos for the operator. Runs are recorded as Tasks (type "cron") in
// the normal ledger. A slot is only run if it fell within the last
// CATCH_UP_MS — after downtime the gateway doesn't replay a week of
// missed standups.
//
// Disable with AGENT_OS_BASESPACE_CRONS=off.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  loadSnapshot,
  createTask,
  transitionTask,
  runTurn,
  newSessionId,
  createModelForAgent,
  publishEvent,
  type ModelAdapter,
  type Worker,
  type SkillRegistry,
} from "../core/index.js";

const DATA_DIR = process.env.AGENT_OS_DATA_DIR ?? path.join(process.cwd(), "data");
const RUNS_FILE = path.join(DATA_DIR, "basespace", "cron-runs.json");
const CATCH_UP_MS = 15 * 60_000;
const TICK_MS = 60_000;

type Schedule = { type: "daily"; hour: number } | { type: "everyHours"; n: number } | { type: "everyMinutes"; n: number };

interface SnapshotCron {
  id: string;
  name: string;
  owner: string;
  team?: string;
  schedule: Schedule;
}

interface SnapshotTeam {
  id: string;
  name: string;
  members: string[];
  description?: string;
}

/** The most recent scheduled slot at or before `now` (same slot maths as
 *  BaseSpace's cronNextRunMs: daily at a local hour, intervals anchored to
 *  local midnight). */
export function previousSlotMs(s: Schedule, now = Date.now()): number | undefined {
  const d = new Date(now);
  if (s.type === "daily") {
    if (typeof s.hour !== "number") return undefined;
    d.setHours(Math.floor(s.hour), Math.round((s.hour % 1) * 60), 0, 0);
    if (d.getTime() > now) d.setDate(d.getDate() - 1);
    return d.getTime();
  }
  const step = s.type === "everyHours" ? s.n * 3_600_000 : s.n * 60_000;
  if (!(step > 0)) return undefined;
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return midnight.getTime() + Math.floor((now - midnight.getTime()) / step) * step;
}

async function readRuns(): Promise<Record<string, number>> {
  try {
    return JSON.parse(await fs.readFile(RUNS_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function writeRuns(runs: Record<string, number>): Promise<void> {
  await fs.mkdir(path.dirname(RUNS_FILE), { recursive: true });
  await fs.writeFile(RUNS_FILE, JSON.stringify(runs, null, 1), "utf8");
}

export function standupPrompt(cron: SnapshotCron, team: SnapshotTeam, slot: Date): string {
  const date = slot.toISOString().slice(0, 10);
  const others = team.members.slice(1);
  return [
    `It's time for "${cron.name}" — you chair it for the team "${team.name}"${team.description ? ` (${team.description})` : ""}.`,
    `Members: ${team.members.join(", ")}.`,
    "",
    "1. Read the operator's BaseSpace with the `basespace` tool: start with section summary, then todos, projects or notes as needed.",
    `2. Decide today's priorities for the team and what each member should focus on${others.length ? ` (${others.join(", ")})` : ""}, given their roles.`,
    `3. Write the minutes with \`basespace-add\`: kind "note", folder "Team/Meetings", title "${cron.name} — ${date}". Decisions first, then each member's focus, then open questions for ISΛRK.`,
    "4. If ISΛRK needs to decide or do something, add it with `basespace-add` kind \"todo\" (with a due date when there is one).",
    "",
    "Be honest and concrete: you can't hear audio, don't invent numbers, and say what you're assuming. Keep the minutes short enough to read in two minutes.",
  ].join("\n");
}

export interface BaseSpaceCronDeps {
  model: ModelAdapter;
  worker: Worker;
  skills?: SkillRegistry;
}

export function startBaseSpaceCronRunner(deps: BaseSpaceCronDeps): { stop: () => void } {
  if (process.env.AGENT_OS_BASESPACE_CRONS === "off") return { stop: () => {} };
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const snap = await loadSnapshot();
      if (!snap) return;
      const crons: SnapshotCron[] = (Array.isArray(snap.crons) ? snap.crons : []).filter((c: SnapshotCron) => c.team);
      if (!crons.length) return;
      const teams: SnapshotTeam[] = Array.isArray(snap.teams) ? snap.teams : [];
      const runs = await readRuns();
      const now = Date.now();
      for (const cron of crons) {
        const slot = previousSlotMs(cron.schedule, now);
        if (slot == null || now - slot > CATCH_UP_MS || (runs[cron.id] ?? 0) >= slot) continue;
        const team = teams.find((t) => t.id === cron.team);
        const lead = team?.members[0] ?? cron.owner.toLowerCase();
        if (!team) continue;
        runs[cron.id] = slot; // mark first, so a slow run is never started twice
        await writeRuns(runs);
        await runStandup(deps, cron, team, lead, new Date(slot)).catch((err) =>
          console.error(`[basespace-crons] "${cron.name}" failed:`, err instanceof Error ? err.message : err),
        );
      }
    } finally {
      busy = false;
    }
  };

  const id = setInterval(() => void tick(), TICK_MS);
  void tick();
  return { stop: () => clearInterval(id) };
}

async function runStandup(deps: BaseSpaceCronDeps, cron: SnapshotCron, team: SnapshotTeam, lead: string, slot: Date): Promise<void> {
  const goal = standupPrompt(cron, team, slot);
  const task = await createTask({ type: "cron", agentId: lead, input: { source: "basespace", cronId: cron.id, team: team.id, goal } });
  await transitionTask(task.id, "running");
  await publishEvent("basespace.cron.started", { cronId: cron.id, name: cron.name, team: team.id, agentId: lead, taskId: task.id });
  console.log(`[basespace-crons] running "${cron.name}" for ${team.name} (chair: ${lead})`);
  try {
    const model = (await createModelForAgent(lead)) ?? deps.model;
    const result = await runTurn({
      sessionId: newSessionId(),
      agentId: lead,
      userMessage: goal,
      model,
      worker: deps.worker,
      skills: deps.skills,
      maxToolHops: 10,
      enableBaseSpace: true,
    });
    await transitionTask(task.id, "succeeded", { output: { finalContent: result.finalContent, sessionId: result.sessionId } });
    await publishEvent("basespace.cron.finished", { cronId: cron.id, taskId: task.id, sessionId: result.sessionId });
  } catch (err) {
    await transitionTask(task.id, "failed", { output: { error: err instanceof Error ? err.message : String(err) } });
    throw err;
  }
}
