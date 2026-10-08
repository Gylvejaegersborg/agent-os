// What BaseSpace's Ops page shows, built from the real machine and the real records (nothing is made up):
//   - this gateway (pid, uptime, memory) and the machine it runs on (memory, CPU, disk, data size),
//   - the services around it (Hindsight, connectors) and the Tailscale devices that can reach it,
//   - problems: tasks, work and flows that failed or are stuck, supervisor restarts, anything in the gateway's error log,
//   - the tail of the gateway and supervisor logs (the supervisor writes them to AGENT_OS_LOG_DIR, default ~/os-server/logs).
// Anything it cannot read comes back as an `error` or is simply absent, never a placeholder.

import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { listApprovals, listConnectors, listFlows, listTasks, listWork } from "../core/index.js";

const STARTED_AT = new Date().toISOString();
const DATA_DIR = process.env.AGENT_OS_DATA_DIR ?? path.join(process.cwd(), "data");

export interface OpsProblem {
  id: string;
  kind: "task" | "work" | "flow" | "approval" | "supervisor" | "log";
  severity: "error" | "warn" | "info";
  when: string;
  source: string;
  text: string;
  flowId?: string;
}

export interface OpsReport {
  at: string;
  gateway: { pid: number; startedAt: string; uptimeSec: number; memoryMB: number; node: string; platform: string; dataDir: string; terminal: boolean };
  host: { name: string; uptimeSec: number; memTotalMB: number; memFreeMB: number; cpus: number; cpuModel: string; cpuPercent: number | null; disk?: { path: string; totalGB: number; freeGB: number }; dataMB: number | null };
  services: { id: string; name: string; state: "up" | "down" | "unconfigured"; detail?: string; ms?: number }[];
  connectors: { name: string; kind: string; status: string; enabled: boolean }[];
  tailscale: { error: string } | { backend: string; self: TailDevice; peers: TailDevice[] };
  problems: OpsProblem[];
  logs: { dir?: string; gateway: string[]; supervisor: string[]; gatewayErrors: string[] };
}

export interface TailDevice {
  name: string;
  ip: string;
  os: string;
  online: boolean;
  lastSeen?: string;
  self?: boolean;
}

// ---- small helpers -------------------------------------------------------------------------------------------

const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ttlMs: number, make: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await make();
  cache.set(key, { at: Date.now(), value });
  return value;
}

function logDir(): string | undefined {
  const dir = process.env.AGENT_OS_LOG_DIR ?? path.join(os.homedir(), "os-server", "logs");
  return existsSync(dir) ? dir : undefined;
}

/** The last `lines` lines of a text file, reading only its end. */
async function tail(file: string, lines: number, maxBytes = 96 * 1024): Promise<string[]> {
  try {
    const fh = await fs.open(file, "r");
    try {
      const { size } = await fh.stat();
      const len = Math.min(size, maxBytes);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      // eslint-disable-next-line no-control-regex
      const text = buf.toString("utf8").replace(/\u001b\[[0-9;]*m/g, "");
      const all = text.split(/\r?\n/).filter((l) => l.trim());
      return all.slice(-lines).map((l) => (l.length > 400 ? `${l.slice(0, 400)}…` : l));
    } finally {
      await fh.close();
    }
  } catch {
    return [];
  }
}

async function cpuPercent(): Promise<number | null> {
  const snap = () => os.cpus().map((c) => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a, b) => a + b, 0) }));
  const a = snap();
  await new Promise((r) => setTimeout(r, 250));
  const b = snap();
  let idle = 0;
  let total = 0;
  for (let i = 0; i < a.length; i++) {
    idle += b[i]!.idle - a[i]!.idle;
    total += b[i]!.total - a[i]!.total;
  }
  return total > 0 ? Math.round((1 - idle / total) * 100) : null;
}

async function dirSize(dir: string, budget = { files: 40_000 }): Promise<number> {
  let sum = 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (budget.files-- <= 0) break;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sum += await dirSize(p, budget);
    else if (e.isFile()) sum += (await fs.stat(p).catch(() => undefined))?.size ?? 0;
  }
  return sum;
}

function tailscale(): Promise<OpsReport["tailscale"]> {
  return cached("tailscale", 10_000, () => new Promise((resolve) => {
    const cli = process.env.TAILSCALE_CLI ?? (process.platform === "win32" ? "C:\\Program Files\\Tailscale\\tailscale.exe" : "tailscale");
    execFile(cli, ["status", "--json"], { timeout: 6000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve({ error: `tailscale status failed: ${err.message.split("\n")[0]}` });
      try {
        const j = JSON.parse(stdout) as { BackendState?: string; Self?: any; Peer?: Record<string, any> };
        const dev = (d: any, self = false): TailDevice => ({
          name: String(d.HostName ?? d.DNSName ?? "?"),
          ip: String((d.TailscaleIPs ?? [])[0] ?? ""),
          os: String(d.OS ?? ""),
          online: self ? true : d.Online === true,
          ...(d.LastSeen && !String(d.LastSeen).startsWith("0001") ? { lastSeen: String(d.LastSeen) } : {}),
          ...(self ? { self: true } : {}),
        });
        resolve({ backend: String(j.BackendState ?? "?"), self: dev(j.Self, true), peers: Object.values(j.Peer ?? {}).map((p) => dev(p)).sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)) });
      } catch {
        resolve({ error: "could not read tailscale's answer" });
      }
    });
  }));
}

async function probe(url: string): Promise<{ ok: boolean; ms: number; detail?: string }> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    return { ok: res.status < 500, ms: Date.now() - t0, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, detail: err instanceof Error ? err.message : String(err) };
  }
}

const sinceMs = 48 * 3600_000;
const recent = (iso?: string) => !!iso && Date.now() - Date.parse(iso) < sinceMs;

async function problems(dir: string | undefined): Promise<OpsProblem[]> {
  const out: OpsProblem[] = [];

  for (const t of await listTasks()) {
    if (!["failed", "lost", "timed_out"].includes(t.status)) continue;
    const when = t.completedAt ?? t.startedAt ?? t.createdAt;
    if (!recent(when)) continue;
    const err = typeof t.output?.error === "string" ? (t.output.error as string) : t.status;
    out.push({ id: `task:${t.id}`, kind: "task", severity: "error", when, source: `${t.agentId} · ${t.type}`, text: err, ...(t.flowId ? { flowId: t.flowId } : {}) });
  }
  for (const w of await listWork({ status: "blocked" })) {
    out.push({ id: `work:${w.id}`, kind: "work", severity: "warn", when: (w as { updatedAt?: string }).updatedAt ?? new Date().toISOString(), source: `${w.assignee} · work`, text: `${w.title} is blocked` });
  }
  for (const f of await listFlows()) {
    if (f.status !== "failed") continue;
    out.push({ id: `flow:${f.id}`, kind: "flow", severity: "warn", when: new Date().toISOString(), source: "flow", text: `${f.title ?? f.id.slice(0, 8)} stopped with a failed step`, flowId: f.id });
  }
  for (const a of await listApprovals({ status: "pending" })) {
    out.push({ id: `approval:${a.id}`, kind: "approval", severity: "info", when: a.requestedAt, source: `${a.agentId} · approval`, text: `waiting for you: ${a.toolName}` });
  }
  if (dir) {
    for (const l of await tail(path.join(dir, "supervisor.log"), 80)) {
      // "2026-10-08T00:50:11 gateway exited (code ) - restarting": local time, as the supervisor wrote it.
      const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\s+(.*(?:exited|restarting|failed|stopped).*)$/i.exec(l);
      const when = m ? new Date(m[1]!).toISOString() : undefined;
      if (m && recent(when)) out.push({ id: `sup:${l}`, kind: "supervisor", severity: "warn", when: when!, source: "supervisor", text: m[2]! });
    }
    const errFile = path.join(dir, "gateway.err.log");
    const st = await fs.stat(errFile).catch(() => undefined);
    if (st && st.size > 0 && recent(st.mtime.toISOString())) {
      for (const l of (await tail(errFile, 6)).slice(-3)) out.push({ id: `err:${l.slice(0, 60)}`, kind: "log", severity: "error", when: st.mtime.toISOString(), source: "gateway error log", text: l });
    }
  }
  return out.sort((a, b) => Date.parse(b.when) - Date.parse(a.when) || 0).slice(0, 40);
}

// ---- the report ----------------------------------------------------------------------------------------------

export function buildOps(): Promise<OpsReport> {
  return cached("ops", 4000, async () => {
    const dir = logDir();
    const hindsightUrl = process.env.HINDSIGHT_URL?.replace(/\/$/, "");
    const [cpu, ts, hs, dataBytes, probs, gw, sup, gwErr] = await Promise.all([
      cpuPercent(),
      tailscale(),
      hindsightUrl ? probe(`${hindsightUrl}/health`).then((r) => (r.detail === "HTTP 404" ? probe(hindsightUrl) : r)) : Promise.resolve(undefined),
      cached("dataBytes", 60_000, () => dirSize(DATA_DIR)),
      problems(dir),
      dir ? tail(path.join(dir, "gateway.log"), 80) : Promise.resolve([] as string[]),
      dir ? tail(path.join(dir, "supervisor.log"), 40) : Promise.resolve([] as string[]),
      dir ? tail(path.join(dir, "gateway.err.log"), 20) : Promise.resolve([] as string[]),
    ]);
    const statfs = await (fs as unknown as { statfs?: (p: string) => Promise<{ bsize: number; blocks: number; bavail: number }> }).statfs?.(DATA_DIR).catch(() => undefined);
    const mem = process.memoryUsage().rss;
    const services: OpsReport["services"] = [{ id: "gateway", name: "Agent-OS gateway", state: "up", detail: `pid ${process.pid}` }];
    services.push(
      hs
        ? { id: "hindsight", name: "Hindsight (memory)", state: hs.ok ? "up" : "down", ms: hs.ms, detail: hs.ok ? hs.detail : hs.detail }
        : { id: "hindsight", name: "Hindsight (memory)", state: "unconfigured", detail: "HINDSIGHT_URL is not set" },
    );
    return {
      at: new Date().toISOString(),
      gateway: { pid: process.pid, startedAt: STARTED_AT, uptimeSec: Math.round(process.uptime()), memoryMB: Math.round(mem / 1048576), node: process.version, platform: `${process.platform} ${process.arch}`, dataDir: DATA_DIR, terminal: process.env.AGENT_OS_TERMINAL === "1" },
      host: {
        name: os.hostname(),
        uptimeSec: Math.round(os.uptime()),
        memTotalMB: Math.round(os.totalmem() / 1048576),
        memFreeMB: Math.round(os.freemem() / 1048576),
        cpus: os.cpus().length,
        cpuModel: os.cpus()[0]?.model.trim() ?? "",
        cpuPercent: cpu,
        ...(statfs ? { disk: { path: DATA_DIR, totalGB: Math.round((statfs.blocks * statfs.bsize) / 1073741824), freeGB: Math.round((statfs.bavail * statfs.bsize) / 1073741824) } } : {}),
        dataMB: Math.round(dataBytes / 1048576),
      },
      services,
      connectors: listConnectors().connectors.map((c) => ({ name: c.name, kind: c.kind, status: c.status, enabled: c.enabled })),
      tailscale: ts,
      problems: probs,
      logs: { ...(dir ? { dir } : {}), gateway: gw, supervisor: sup, gatewayErrors: gwErr },
    } satisfies OpsReport;
  });
}
