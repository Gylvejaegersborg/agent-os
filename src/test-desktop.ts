// Standalone tests for desktop activity (core/desktop.ts): batch ingest
// with dedup and validation, the merged timeline, the day summary (apps,
// switches, focus blocks, BaseSpace project/goal matching), the live focus
// signal on the event bus, and the gateway + MCP surfaces.
// Run with: node dist/test-desktop.js

import "./test-helpers/isolate.js";
import path from "node:path";
import {
  recordDesktopBatch,
  desktopTimeline,
  desktopDaySummary,
  renderDesktopDigest,
  getDesktopFocus,
  cleanDevice,
  renderDesktopReport,
  getToolDefinition,
  changesLibraryOrAudio,
  PLAN_MODE_BLOCKED_TOOLS,
  titleMatches,
  localDay,
  saveSnapshot,
  subscribeToEvent,
  createStubModel,
  createStubWorker,
  SkillRegistry,
} from "./core/index.js";
import { startGateway } from "./gateway/server.js";

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`ok: ${msg}`);
  else {
    failed = true;
    console.log(`FAIL: ${msg}`);
  }
}

// A fixed local morning today, so every span lands on the same local day.
const base = new Date();
base.setHours(9, 0, 0, 0);
const at = (min: number) => new Date(base.getTime() + min * 60_000).toISOString();
const day = localDay(base);

let n = 0;
const span = (kind: "active" | "idle", app: string, title: string, from: number, to: number) => ({
  id: `s${++n}`, kind, app, title, start: at(from), end: at(to),
});

async function testIngest(): Promise<void> {
  const batch = [
    // 30 min in the DAW, split into 1-minute-ish chunks the way the sensor
    // splits long spans — must merge back into one.
    ...Array.from({ length: 30 }, (_, i) => span("active", "FL64.exe", "Sinnsyk.flp - FL Studio", i, i + 1)),
    span("active", "Code.exe", "desktop.ts - agent-os - Visual Studio Code", 30, 40),
    span("idle", "", "", 40, 50),
    span("active", "chrome.exe", "YouTube - Google Chrome", 50, 55),
    span("active", "Code.exe", "server.ts - agent-os - Visual Studio Code", 55, 60),
  ];
  const r = await recordDesktopBatch({ spans: batch });
  assert(r.stored === batch.length && r.skipped === 0 && r.rejected.length === 0, `a clean batch stores every span (${r.stored}/${batch.length})`);

  const again = await recordDesktopBatch({ spans: batch.slice(0, 5) });
  assert(again.stored === 0 && again.skipped === 5, "a resent batch is skipped by span id, not double-counted");

  const bad = await recordDesktopBatch({
    spans: [
      { id: "b1", kind: "active", app: "x.exe", title: "t", start: at(70), end: at(65) },
      { id: "b2", kind: "active", app: "", title: "t", start: at(70), end: at(71) },
      { id: "b3", kind: "active", app: "x.exe", title: "t", start: at(0), end: at(90) },
      { id: "b4", kind: "keystroke", app: "x.exe", start: at(0), end: at(1) },
      { id: "b5", kind: "active", app: "x.exe", title: "t", start: "yesterday", end: at(1) },
    ],
  });
  assert(bad.stored === 0 && bad.rejected.length === 5, "malformed spans (end<start, no app, >1h, unknown kind, bad time) are all rejected");
  assert(bad.rejected.some((x) => /kind/.test(x.reason)), "an unknown kind like 'keystroke' is refused — spans only");

  let tooBig = false;
  try {
    await recordDesktopBatch({ spans: Array.from({ length: 501 }, () => ({})) });
  } catch {
    tooBig = true;
  }
  assert(tooBig, "a batch over 500 spans is refused");

  const timeline = await desktopTimeline(day);
  assert(timeline.length === 5, `adjacent identical spans merge (5 entries, got ${timeline.length})`);
  assert(timeline[0]!.app === "FL64.exe" && timeline[0]!.end === at(30), "the 30 one-minute DAW spans became one 30-minute span");
}

async function testFocus(): Promise<void> {
  const seen: Record<string, unknown>[] = [];
  const off = subscribeToEvent("desktop.focus", (_t, p) => void seen.push(p));
  await recordDesktopBatch({ spans: [], focus: { app: "Code.exe", title: "a.ts" } });
  await recordDesktopBatch({ spans: [], focus: { app: "Code.exe", title: "a.ts" } });
  await recordDesktopBatch({ spans: [], focus: { app: "Code.exe", title: "b.ts" } });
  assert(seen.length === 2, `only focus CHANGES are published (2, got ${seen.length})`);
  assert(getDesktopFocus()?.title === "b.ts", "getDesktopFocus reports the latest window");
  await recordDesktopBatch({ spans: [], focus: null });
  assert(getDesktopFocus() === undefined && seen.length === 3, "focus: null (operator went idle) clears it and publishes once");
  off();
}

async function testSummary(): Promise<void> {
  assert(titleMatches("Sinnsyk.flp - FL Studio", "Sinnsyk"), "a project name matches a title containing it");
  assert(!titleMatches("release notes - Chrome", "Switch release"), "a partial match (one of two words) does not count");
  assert(!titleMatches("anything", "a b"), "a name with no significant words never matches");

  const before = await desktopDaySummary(day);
  assert(before.byWork.length === 0, "without a BaseSpace snapshot nothing is matched, and it doesn't fail");

  await saveSnapshot({
    schema: 1,
    projects: [{ id: "p1", name: "Sinnsyk", status: "active" }, { id: "p2", name: "agent-os", status: "active" }],
    goals: [{ id: "g1", title: "Release Sinnsyk single", status: "active" }],
  });
  const s = await desktopDaySummary(day);
  assert(s.activeSec === 50 * 60, `active time is 50m (got ${s.activeSec / 60}m)`);
  assert(s.idleSec === 10 * 60, "idle time is 10m");
  assert(s.switches === 3, `app switches FL→Code, Code→Chrome, Chrome→Code = 3 (got ${s.switches})`);
  assert(s.byApp[0]!.app === "FL64.exe" && s.byApp[0]!.sec === 1800, "FL Studio leads the app list with 30m");
  assert(s.focusBlocks.length === 1 && s.focusBlocks[0]!.app === "FL64.exe", "the 30m DAW stretch is a focus block; 10m of Code is not");
  const p1 = s.byWork.find((w) => w.id === "p1");
  const p2 = s.byWork.find((w) => w.id === "p2");
  assert(p1?.sec === 1800, "30m matched to project Sinnsyk");
  assert(p2?.sec === 900, "15m of VS Code on agent-os files matched to project agent-os");
  assert(!s.byWork.some((w) => w.id === "g1"), "goal 'Release Sinnsyk single' needs all its words — the DAW title doesn't qualify");
  assert(s.unmatchedSec === 5 * 60, "YouTube is the 5m left unmatched");

  const digest = renderDesktopDigest(s);
  assert(/50m active/.test(digest) && /project "Sinnsyk" 30m/.test(digest), "the digest states totals and matched work in plain text");
  assert(/No desktop activity/.test(renderDesktopDigest(await desktopDaySummary("2000-01-01"))), "an empty day says so");

  // The agent-facing tool: registered, read-only in plan mode, same text as the MCP tool.
  const def = getToolDefinition("desktop");
  assert(!!def && /Window titles only/.test(def.description) && /never recorded/.test(def.description), "the `desktop` tool is registered and states its privacy limits");
  assert(!changesLibraryOrAudio({ name: "desktop", args: {} }) && !PLAN_MODE_BLOCKED_TOOLS.has("desktop"), "it is a read: allowed in plan mode");
  const report = await renderDesktopReport(day);
  assert(report.includes(renderDesktopDigest(s)), "the tool's report contains the day's digest");
  assert(/^No desktop activity recorded for 2000-01-01/m.test(await renderDesktopReport("2000-01-01")), "a day with nothing recorded says so, so an agent can't invent one");
  assert(!/from \d{2}:\d{2}Z/.test(digest), "focus block times are local time, not UTC (no trailing Z)");
}

async function testGateway(): Promise<void> {
  const skillsDir = path.join(process.env.AGENT_OS_DATA_DIR!, "skills");
  const gw = await startGateway({
    model: createStubModel(),
    worker: createStubWorker(),
    skills: await SkillRegistry.fromDirectory(skillsDir),
    skillsDir,
  });
  const url = `http://127.0.0.1:${gw.port}`;
  try {
    const post = await fetch(`${url}/desktop/spans`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spans: [span("active", "Obsidian.exe", "Daily note - Obsidian", 60, 62)], focus: { app: "Obsidian.exe", title: "Daily note - Obsidian" } }),
    }).then((r) => r.json() as Promise<any>);
    assert(post.stored === 1, "POST /desktop/spans stores a span");

    const now = await fetch(`${url}/desktop/now`).then((r) => r.json() as Promise<any>);
    assert(now.focus?.app === "Obsidian.exe", "GET /desktop/now returns the current window");

    const sum = await fetch(`${url}/desktop/summary?day=${day}`).then((r) => r.json() as Promise<any>);
    assert(sum.summary.activeSec === 52 * 60 && typeof sum.digest === "string", "GET /desktop/summary returns the projection and the digest");

    const badDay = await fetch(`${url}/desktop/summary?day=../../etc`);
    assert(badDay.status === 400, "a malformed day is refused before it reaches a stream path");

    const mcp = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "desktop_activity", arguments: { day } } }),
    }).then((r) => r.json() as Promise<any>);
    const text: string = mcp.result?.content?.[0]?.text ?? JSON.stringify(mcp);
    assert(/Right now: Obsidian\.exe/.test(text) && /Desktop activity/.test(text), "the desktop_activity MCP tool answers with focus + digest");
  } finally {
    await gw.stop();
  }
}

async function testDevices(): Promise<void> {
  // Yesterday, so it doesn't mix with the single-device day above.
  const yb = new Date(base.getTime() - 24 * 3600_000);
  const yat = (min: number) => new Date(yb.getTime() + min * 60_000).toISOString();
  const yday = localDay(yb);
  const s = (id: string, kind: "active" | "idle", app: string, from: number, to: number) => ({ id, kind, app, title: app === "" ? "" : `${app} window`, start: yat(from), end: yat(to) });

  // Same span ids from two computers must not collide; a hostile device name is reduced to plain characters.
  const a = await recordDesktopBatch({ device: "server", spans: [s("x1", "active", "Code.exe", 0, 60), s("x2", "idle", "", 90, 100)] });
  const b = await recordDesktopBatch({ device: "PC<script>-1", spans: [s("x1", "active", "FL64.exe", 30, 90), s("x2", "idle", "", 95, 110)] });
  assert(a.stored === 2 && b.stored === 2, "the same span ids from two computers are both stored (dedup is per device)");
  const again = await recordDesktopBatch({ device: "server", spans: [s("x1", "active", "Code.exe", 0, 60)] });
  assert(again.skipped === 1, "…and a resend from the same computer is still skipped");
  assert(cleanDevice("PC<script>-1") === "PCscript-1" && cleanDevice(42) === "" && cleanDevice("x".repeat(99)).length === 40, "device names are reduced to plain characters and 40 long");

  const sum = await desktopDaySummary(yday);
  assert(sum.activeSec === 90 * 60, `overlapping time on two computers is counted once (90 min, got ${sum.activeSec / 60})`);
  const server = sum.byDevice.find((d) => d.device === "server");
  const other = sum.byDevice.find((d) => d.device === "PCscript-1");
  assert(server?.sec === 30 * 60 && other?.sec === 60 * 60, "where both are active, the window that came to the front last gets the time (server 30 min, other 60 min)");
  assert(sum.idleSec === 20 * 60, `idle is only the time no computer was active (20 min, got ${sum.idleSec / 60})`);
  assert(/Computers: .*server 30m/.test(renderDesktopDigest(sum)), "the digest lists the computers when there is more than one");
  assert(!/Computers:/.test(renderDesktopDigest(await desktopDaySummary(day))), "a one-computer day has no computers line");
  const tl = await desktopTimeline(yday);
  assert(tl.every((x, i) => i === 0 || Date.parse(x.start) >= Date.parse(tl[i - 1]!.end)), "the merged timeline never overlaps itself");
}

await testIngest();
await testDevices();
await testFocus();
await testSummary();
await testGateway();

if (failed) {
  console.log("\nSome desktop tests FAILED.");
  process.exit(1);
}
console.log("\nAll desktop tests passed.");
process.exit(0);
