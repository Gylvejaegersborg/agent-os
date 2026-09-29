// Desktop activity — what the operator is doing on their own machine, as
// one more stream in the event log. This is the "always watching" half of
// HUD mode that Hermes' HUD deliberately doesn't have (it only looks when
// asked). A small sensor on the operator's machine (desktop/sensor/) posts
// finished SPANS — "app X, window title Y, from t0 to t1" — and everything
// else (a day's timeline, time per app, time per BaseSpace project/goal,
// context switches, focus blocks) is a projection over those spans, same
// principle as the rest of this OS.
//
// Why spans and not raw focus events: a span is self-contained, so a lost
// or duplicated batch can't corrupt the timeline, and the sensor can split
// long spans (every minute) so a crash loses at most a minute. Adjacent
// identical spans are merged back together in the projection.
//
// Deliberately NOT collected (by the sensor, and not accepted here):
// keystrokes, typed text, clipboard, screenshots. Window titles are the
// richest thing stored, and the sensor applies the operator's privacy
// rules (skip apps, redact titles) before anything leaves it.
//
// Same trust as the rest of the gateway: localhost only, no auth.

import { appendEvent, readStream } from "./eventlog.js";
import { publishEvent } from "./eventbus.js";
import { loadSnapshot } from "./basespace.js";

export interface DesktopSpan {
  /** Sensor-assigned id, so a resent batch doesn't double-count. */
  id: string;
  kind: "active" | "idle";
  /** Process name, e.g. "Code.exe". Empty for idle spans. */
  app: string;
  /** Window title after the sensor's privacy rules. Empty for idle spans. */
  title: string;
  start: string;
  end: string;
}

export interface DesktopFocus {
  app: string;
  title: string;
  since: string;
}

const MAX_BATCH = 500;
const MAX_SPAN_MS = 60 * 60 * 1000;
const MAX_FUTURE_MS = 5 * 60 * 1000;
const MAX_APP = 120;
const MAX_TITLE = 300;
/** Adjacent spans for the same window closer than this are one span. */
const MERGE_GAP_MS = 5_000;
/** An uninterrupted stretch in one app at least this long is a focus block. */
export const FOCUS_BLOCK_MIN_SEC = 25 * 60;

let currentFocus: DesktopFocus | undefined;
/** Span ids already stored, per day — so resends are skipped without
 *  re-reading the day's stream on every batch. Filled lazily. */
const seenIds = new Map<string, Set<string>>();

/** Local calendar day (the gateway runs on the operator's machine, so the
 *  process's local time zone is theirs). */
export function localDay(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const streamFor = (day: string) => `desktop:${day}`;

async function idsFor(day: string): Promise<Set<string>> {
  let set = seenIds.get(day);
  if (!set) {
    set = new Set((await readStream(streamFor(day))).map((e) => String(e.payload.id)));
    seenIds.set(day, set);
  }
  return set;
}

function parseSpan(raw: unknown, now: number): DesktopSpan | string {
  if (typeof raw !== "object" || raw === null) return "not an object";
  const r = raw as Record<string, unknown>;
  const kind = r.kind === "idle" ? "idle" : r.kind === "active" ? "active" : undefined;
  if (!kind) return "kind must be active or idle";
  if (typeof r.id !== "string" || !r.id || r.id.length > 80) return "missing id";
  const start = Date.parse(String(r.start));
  const end = Date.parse(String(r.end));
  if (Number.isNaN(start) || Number.isNaN(end)) return "start/end must be ISO timestamps";
  if (end < start) return "end before start";
  if (end - start > MAX_SPAN_MS) return "span longer than an hour (split it)";
  if (end > now + MAX_FUTURE_MS) return "span ends in the future";
  const app = kind === "idle" ? "" : String(r.app ?? "").slice(0, MAX_APP);
  if (kind === "active" && !app) return "active span without app";
  return {
    id: r.id,
    kind,
    app,
    title: kind === "idle" ? "" : String(r.title ?? "").slice(0, MAX_TITLE),
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
  };
}

/** Ingest one batch from the sensor. `focus` is the window in front right
 *  now (live signal for the HUD — not stored, only published). */
export async function recordDesktopBatch(body: Record<string, unknown>): Promise<{ stored: number; skipped: number; rejected: { index: number; reason: string }[] }> {
  const spans = Array.isArray(body.spans) ? body.spans : [];
  if (spans.length > MAX_BATCH) throw new Error(`batch too large (${spans.length} > ${MAX_BATCH} spans)`);
  const now = Date.now();
  let stored = 0;
  let skipped = 0;
  const rejected: { index: number; reason: string }[] = [];

  for (let i = 0; i < spans.length; i++) {
    const span = parseSpan(spans[i], now);
    if (typeof span === "string") {
      rejected.push({ index: i, reason: span });
      continue;
    }
    const day = localDay(span.start);
    const ids = await idsFor(day);
    if (ids.has(span.id)) {
      skipped++;
      continue;
    }
    await appendEvent(streamFor(day), `desktop.span.${span.kind}`, { ...span });
    ids.add(span.id);
    stored++;
  }

  const f = body.focus as Record<string, unknown> | undefined;
  if (f && typeof f.app === "string" && f.app) {
    const next: DesktopFocus = {
      app: f.app.slice(0, MAX_APP),
      title: String(f.title ?? "").slice(0, MAX_TITLE),
      since: typeof f.since === "string" && !Number.isNaN(Date.parse(f.since)) ? f.since : new Date(now).toISOString(),
    };
    const changed = !currentFocus || currentFocus.app !== next.app || currentFocus.title !== next.title;
    currentFocus = next;
    // Only a CHANGE is published — the bus event-sources every publish, and
    // a repeat of the same window every 15s would just be noise there.
    if (changed) await publishEvent("desktop.focus", { ...next });
  } else if (body.focus === null && currentFocus) {
    currentFocus = undefined;
    await publishEvent("desktop.focus", { app: "", title: "", since: new Date(now).toISOString() });
  }

  return { stored, skipped, rejected };
}

/** What's in front of the operator right now (undefined if idle, or the
 *  sensor hasn't reported since the gateway started). */
export function getDesktopFocus(): DesktopFocus | undefined {
  return currentFocus;
}

/** The day's spans in time order, adjacent identical windows merged. */
export async function desktopTimeline(day: string): Promise<DesktopSpan[]> {
  const spans = (await readStream(streamFor(day)))
    .map((e) => e.payload as unknown as DesktopSpan)
    .sort((a, b) => a.start.localeCompare(b.start));
  const out: DesktopSpan[] = [];
  for (const s of spans) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.kind === s.kind &&
      prev.app === s.app &&
      prev.title === s.title &&
      Date.parse(s.start) - Date.parse(prev.end) <= MERGE_GAP_MS
    ) {
      if (s.end > prev.end) prev.end = s.end;
      continue;
    }
    out.push({ ...s });
  }
  return out;
}

const secs = (s: DesktopSpan) => Math.max(0, (Date.parse(s.end) - Date.parse(s.start)) / 1000);

// ---- matching window titles to BaseSpace projects/goals ---------------------

const STOPWORDS = new Set(["the", "and", "for", "with", "from", "into", "og", "med", "til", "for", "som", "det", "den", "ikke"]);

export function significantTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** A title belongs to a project/goal when every significant word of its
 *  name shows up in the title. Strict on purpose: "Switch release" should
 *  not claim every window that says "release". Names with no significant
 *  words never match. */
export function titleMatches(title: string, name: string): boolean {
  const need = significantTokens(name);
  if (!need.length) return false;
  const have = new Set(significantTokens(title));
  return need.every((t) => have.has(t));
}

export interface DesktopDaySummary {
  day: string;
  activeSec: number;
  idleSec: number;
  /** Changes of foreground app between active spans (idle doesn't count). */
  switches: number;
  byApp: { app: string; sec: number }[];
  topWindows: { app: string; title: string; sec: number }[];
  focusBlocks: { app: string; start: string; end: string; sec: number }[];
  /** Time whose window title matched a BaseSpace project or goal. */
  byWork: { kind: "project" | "goal"; id: string; name: string; sec: number }[];
  unmatchedSec: number;
}

export async function desktopDaySummary(day: string): Promise<DesktopDaySummary> {
  const timeline = await desktopTimeline(day);
  const active = timeline.filter((s) => s.kind === "active");

  const byApp = new Map<string, number>();
  const byWindow = new Map<string, { app: string; title: string; sec: number }>();
  let switches = 0;
  for (let i = 0; i < active.length; i++) {
    const s = active[i]!;
    byApp.set(s.app, (byApp.get(s.app) ?? 0) + secs(s));
    const k = `${s.app}\u0000${s.title}`;
    const w = byWindow.get(k) ?? { app: s.app, title: s.title, sec: 0 };
    w.sec += secs(s);
    byWindow.set(k, w);
    if (i > 0 && active[i - 1]!.app !== s.app) switches++;
  }

  // Focus blocks: consecutive active spans in the same app, not broken by
  // idle or another app (title changes inside the app are fine — that's
  // switching files, not switching tasks).
  const focusBlocks: DesktopDaySummary["focusBlocks"] = [];
  let run: { app: string; start: string; end: string; sec: number } | undefined;
  const flush = () => {
    if (run && run.sec >= FOCUS_BLOCK_MIN_SEC) focusBlocks.push(run);
    run = undefined;
  };
  for (const s of timeline) {
    if (s.kind === "idle" || (run && run.app !== s.app)) flush();
    if (s.kind === "idle") continue;
    if (!run) run = { app: s.app, start: s.start, end: s.end, sec: 0 };
    run.end = s.end;
    run.sec += secs(s);
  }
  flush();

  const snap = await loadSnapshot().catch(() => undefined);
  const candidates: { kind: "project" | "goal"; id: string; name: string }[] = [
    ...(Array.isArray(snap?.projects) ? snap!.projects : []).map((p: any) => ({ kind: "project" as const, id: String(p.id), name: String(p.name ?? "") })),
    ...(Array.isArray(snap?.goals) ? snap!.goals : []).map((g: any) => ({ kind: "goal" as const, id: String(g.id), name: String(g.title ?? "") })),
  ];
  const byWork = new Map<string, { kind: "project" | "goal"; id: string; name: string; sec: number }>();
  let unmatchedSec = 0;
  for (const s of active) {
    const hits = candidates.filter((c) => titleMatches(s.title, c.name));
    if (!hits.length) unmatchedSec += secs(s);
    for (const h of hits) {
      const k = `${h.kind}:${h.id}`;
      const w = byWork.get(k) ?? { ...h, sec: 0 };
      w.sec += secs(s);
      byWork.set(k, w);
    }
  }

  const round = (n: number) => Math.round(n);
  return {
    day,
    activeSec: round(active.reduce((n, s) => n + secs(s), 0)),
    idleSec: round(timeline.filter((s) => s.kind === "idle").reduce((n, s) => n + secs(s), 0)),
    switches,
    byApp: [...byApp].map(([app, sec]) => ({ app, sec: round(sec) })).sort((a, b) => b.sec - a.sec),
    topWindows: [...byWindow.values()].map((w) => ({ ...w, sec: round(w.sec) })).sort((a, b) => b.sec - a.sec).slice(0, 10),
    focusBlocks: focusBlocks.map((b) => ({ ...b, sec: round(b.sec) })),
    byWork: [...byWork.values()].map((w) => ({ ...w, sec: round(w.sec) })).sort((a, b) => b.sec - a.sec),
    unmatchedSec: round(unmatchedSec),
  };
}

const hm = (sec: number) => {
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};

/** HH:MM in the machine's local time (spans are stored as UTC ISO strings). */
function localHm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Plain-text digest an agent (or the MCP tool) can read. Code-built, no
 *  model involved — interpreting it is the agent's job. */
export function renderDesktopDigest(s: DesktopDaySummary): string {
  if (!s.activeSec && !s.idleSec) return `No desktop activity recorded for ${s.day}.`;
  const lines = [
    `Desktop activity ${s.day}: ${hm(s.activeSec)} active, ${hm(s.idleSec)} idle, ${s.switches} app switches.`,
    `Apps: ${s.byApp.slice(0, 6).map((a) => `${a.app} ${hm(a.sec)}`).join(", ")}.`,
  ];
  if (s.byWork.length) lines.push(`BaseSpace work: ${s.byWork.map((w) => `${w.kind} "${w.name}" ${hm(w.sec)}`).join(", ")}; ${hm(s.unmatchedSec)} not matched to any project or goal.`);
  else lines.push(`No window matched a BaseSpace project or goal (${hm(s.unmatchedSec)} unmatched).`);
  lines.push(
    s.focusBlocks.length
      ? `Focus blocks (≥${FOCUS_BLOCK_MIN_SEC / 60}m in one app): ${s.focusBlocks.map((b) => `${b.app} ${hm(b.sec)} from ${localHm(b.start)}`).join(", ")}.`
      : `No focus blocks of ${FOCUS_BLOCK_MIN_SEC / 60}m or more.`,
  );
  lines.push(`Top windows: ${s.topWindows.slice(0, 5).map((w) => `${w.app} "${w.title}" ${hm(w.sec)}`).join("; ")}.`);
  return lines.join("\n");
}

/** What the `desktop` tool and the MCP `desktop_activity` tool both return: the window in front now, then the day's digest. */
export async function renderDesktopReport(day?: string): Promise<string> {
  const d = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : localDay(new Date());
  const now = getDesktopFocus();
  const head = now ? `Right now: ${now.app} "${now.title}" (since ${now.since}).\n` : "";
  return head + renderDesktopDigest(await desktopDaySummary(d));
}
