import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { requestApproval } from "./approvals.js";

export interface HarnessTrajectory {
  at: string;
  sessionId: string;
  agentId: string;
  friction: string;
  turnStopReason?: string;
  toolCalled?: string;
}

export interface HarnessRefinementConfig {
  dataDir: string;
  fallbackCadenceMs: number;
  idleCpuLimit: number;
  idleMemoryFreeBytes: number;
}

export interface HarnessCandidate {
  id: string;
  createdAt: string;
  snapshotPath: string;
  candidatePath: string;
  probe: "passed";
  status?: "candidate";
  approvalId?: string;
  promotedAt?: string;
}

function candidateDir(dataDir: string): string {
  return path.join(dataDir, "harness-candidates");
}

function trajectoryPath(dataDir: string): string {
  return path.join(dataDir, "harness-trajectories.jsonl");
}

export async function recordHarnessTrajectory(dataDir: string, trajectory: HarnessTrajectory): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.appendFile(trajectoryPath(dataDir), JSON.stringify(trajectory) + "\n", "utf8");
}

export function harnessIdle(config: HarnessRefinementConfig, activeTurnCount: number): { idle: boolean; reason: string } {
  if (activeTurnCount > 0) return { idle: false, reason: "live agent turn active" };
  const rssBytes = process.memoryUsage().rss;
  if (rssBytes > config.idleMemoryFreeBytes) return { idle: false, reason: "process memory guard exceeded" };
  const freeBytes = os.freemem();
  if (freeBytes < 2 * 1024 * 1024 * 1024) return { idle: false, reason: "system free-memory guard: below 2 GB" };
  const cpus = os.loadavg();
  const load = cpus[0] ?? 0;
  if (load > config.idleCpuLimit) return { idle: false, reason: `CPU load guard: ${load.toFixed(2)} > ${config.idleCpuLimit}` };
  return { idle: true, reason: "resource guards passed" };
}

export async function probeAndStageCandidate(
  dataDir: string,
  agentId: string,
  lessons: string[],
): Promise<HarnessCandidate> {
  const dir = candidateDir(dataDir);
  await fs.mkdir(dir, { recursive: true });
  const id = `harness-${Date.now().toString(36)}`;
  const snapshotPath = path.join(dir, `${id}.active-snapshot.json`);
  const candidatePath = path.join(dir, `${id}.candidate.json`);
  const snapshot = { agentId, capturedAt: new Date().toISOString(), active: "existing harness unchanged" };
  const candidate = {
    id,
    agentId,
    createdAt: new Date().toISOString(),
    lessons: lessons.slice(0, 20).map((lesson) => lesson.trim()).filter(Boolean),
    status: "candidate",
  };
  if (!candidate.lessons.length) throw new Error("Harness candidate requires at least one lesson");
  await fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");
  await fs.writeFile(candidatePath, JSON.stringify(candidate, null, 2), "utf8");
  const parsed = JSON.parse(await fs.readFile(candidatePath, "utf8")) as { status?: string };
  if (parsed.status !== "candidate") throw new Error("candidate probe failed");
  const approval = await requestApproval({
    agentId,
    sessionId: "harness-refinement",
    toolName: "harness.promote",
    args: { candidateId: id, candidatePath, snapshotPath },
    reason: "Idle-time harness candidate passed deterministic staging validation and requires operator promotion.",
  });
  return { id, createdAt: candidate.createdAt, snapshotPath, candidatePath, probe: "passed", approvalId: approval.id };
}

export function startHarnessRefinement(
  config: HarnessRefinementConfig,
  getActiveTurnCount: () => number,
): { stop: () => void } {
  let stopped = false;
  let lastAttempt = 0;
  let timer: ReturnType<typeof setInterval>;
  timer = setInterval(() => {
    if (stopped) return;
    void (async () => {
      const now = Date.now();
      if (now - lastAttempt < config.fallbackCadenceMs) return;
      const guard = harnessIdle(config, getActiveTurnCount());
      if (!guard.idle) return;
      lastAttempt = now;
      try {
        const raw = await fs.readFile(trajectoryPath(config.dataDir), "utf8").catch(() => "");
        const trajectories = raw.split("\n").filter(Boolean).slice(-20).map((line) => JSON.parse(line) as HarnessTrajectory);
        if (!trajectories.length) return;
        const lessons = trajectories.map((item) => item.friction).filter((value, index, values) => values.indexOf(value) === index);
        await probeAndStageCandidate(config.dataDir, trajectories[0]!.agentId, lessons);
      } catch (err) {
        console.error("[harness-refinement]", err instanceof Error ? err.message : err);
      }
    })();
  }, Math.min(config.fallbackCadenceMs, 60_000));
  if (typeof timer.unref === "function") timer.unref();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}

export async function promoteHarnessCandidate(dataDir: string, candidateId: string, snapshotPath: string, candidatePath: string): Promise<{ promoted: boolean; snapshotPath: string }> {
  const resolvedCandidate = path.resolve(candidatePath);
  const resolvedSnapshot = path.resolve(snapshotPath);
  const base = path.resolve(candidateDir(dataDir));
  if (!resolvedCandidate.startsWith(base + path.sep) || !resolvedSnapshot.startsWith(base + path.sep)) {
    throw new Error("Harness promotion paths must remain inside the candidate staging directory");
  }
  await fs.stat(resolvedCandidate);
  await fs.stat(resolvedSnapshot);
  const candidate = JSON.parse(await fs.readFile(resolvedCandidate, "utf8")) as { id?: string; status?: string };
  if (candidate.id !== candidateId) throw new Error("Harness candidate id mismatch");
  candidate.status = "promoted";
  await fs.writeFile(resolvedCandidate, JSON.stringify(candidate, null, 2), "utf8");
  return { promoted: true, snapshotPath: resolvedSnapshot };
}
