// Tests for the sound engine and the Sound Lab (core/soundgen.ts, core/soundlab.ts, gateway/soundlab-routes.ts).
// Proves what code CAN prove about sounds (not how they feel; that's the operator's ears):
//   1. Every kind renders clean sounds over many random parameter sets, in every architecture:
//      no NaN, peak at -1 dBFS, no click at the tail, sensible length, deterministic.
//   2. They are what they claim, and what the operator asked for after listening:
//      808s are tuned to C and keep a real tail; kicks are short with a soft transient;
//      snares and bells have little energy up high (no "rice", no ear-scratch); hats have body;
//      every melodic sound is tuned to C; melodic sounds are stereo; open hats vary.
//   3. The WAV is a real 24-bit file (ffmpeg decodes it, length and peak match), mono or stereo.
//   4. Params from anywhere are re-fitted into range; mutation stays near its parent and rarely
//      switches architecture.
//   5. The Lab: batches, judging (and undo), stats, steering, and sounds from an older engine
//      are hidden, never re-rendered as something else.
//   6. The HTTP surface: generate, list, audio (WAV, Range), judge, stats.
// Run with: node dist/test-soundlab.js

import "./test-helpers/isolate.js";
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  ENGINE_VERSION,
  MELODIC_KINDS,
  RECIPES,
  SAMPLE_RATE,
  SOUND_KINDS,
  appendEvent,
  cleanParams,
  encodeWav24,
  generateBatch,
  getCandidate,
  judge,
  listCandidates,
  mutateParams,
  randomParams,
  renderSound,
  rng,
  soundLabel,
  stats,
  createStubModel,
  createStubWorker,
  type SoundKind,
} from "./core/index.js";
import { audioInfo } from "./core/audio.js";
import { startGateway } from "./gateway/server.js";

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`ok: ${msg}`);
  else {
    failed = true;
    console.log(`FAIL: ${msg}`);
  }
}

const peakDb = (chs: Float32Array[]) => {
  let peak = 0;
  for (const ch of chs) for (const v of ch) peak = Math.max(peak, Math.abs(v));
  return 20 * Math.log10(peak || 1e-9);
};

/** Energy below / above a split frequency, from a plain DFT of a window (tests only). */
function bandEnergy(d: Float32Array, split: number, start = 0, size = 4096): { low: number; high: number } {
  let low = 0;
  let high = 0;
  for (let k = 1; k < size / 2; k++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < size; i++) {
      const v = (d[start + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
      re += v * Math.cos((2 * Math.PI * k * i) / size);
      im -= v * Math.sin((2 * Math.PI * k * i) / size);
    }
    const e = re * re + im * im;
    if ((k * SAMPLE_RATE) / size < split) low += e;
    else high += e;
  }
  return { low, high };
}

/** Fundamental by autocorrelation over a window (tests only). */
function pitch(d: Float32Array, start: number, size = 8192): number {
  let best = 0;
  let bestLag = 1;
  for (let lag = Math.floor(SAMPLE_RATE / 1200); lag < Math.floor(SAMPLE_RATE / 55); lag++) {
    let sum = 0;
    for (let i = 0; i < size; i++) sum += (d[start + i] ?? 0) * (d[start + i + lag] ?? 0);
    if (sum > best) {
      best = sum;
      bestLag = lag;
    }
  }
  return SAMPLE_RATE / bestLag;
}
const C = (octave: number) => 440 * 2 ** ((12 * (octave + 1) - 69) / 12);
const withDefaults = (kind: SoundKind, over: Record<string, number>) => ({ ...cleanParams(kind, {}), ...over });

// --- 1. clean, deterministic, sensible -----------------------------------------------
const LEN: Record<SoundKind, [number, number]> = {
  kick: [0.1, 0.65], "808": [1, 3.6], snare: [0.1, 0.8], clap: [0.12, 1], "hat-closed": [0.02, 0.2], "hat-open": [0.2, 1.3],
  bell: [1, 5], pluck: [0.3, 4], keys: [1, 4.5], pad: [2.2, 5.8], lead: [1, 3.6],
};
for (const kind of SOUND_KINDS) {
  const rand = rng(7);
  let bad = "";
  const t0 = Date.now();
  for (let n = 0; n < 24 && !bad; n++) {
    const params = randomParams(kind, rand);
    const d = renderSound(kind, params, n + 1);
    const sec = d[0]!.length / SAMPLE_RATE;
    if (!d.every((c) => c.every(Number.isFinite))) bad = "NaN or infinity";
    else if (Math.abs(peakDb(d) + 1) > 0.05) bad = `peak ${peakDb(d).toFixed(2)} dB`;
    else if (d.some((c) => Math.abs(c[c.length - 1]!) > 1e-3)) bad = "tail not faded";
    else if (sec < LEN[kind][0] || sec > LEN[kind][1]) bad = `length ${sec.toFixed(2)} s outside ${LEN[kind]} (${JSON.stringify(params)})`;
    else if (d.length !== (MELODIC_KINDS.has(kind) && kind !== "808" ? 2 : 1)) bad = `${d.length} channels`;
    else if (renderSound(kind, params, n + 1).some((c, ch) => c.some((v, i) => v !== d[ch]![i]))) bad = "not deterministic";
  }
  assert(!bad, `${kind}: 24 random sounds (all architectures) are clean, in length, -1 dBFS, deterministic${bad ? ` (${bad})` : ""} (${Date.now() - t0} ms)`);
}
const noiseA = renderSound("snare", randomParams("snare", rng(1)), 1)[0]!;
const noiseB = renderSound("snare", randomParams("snare", rng(1)), 2)[0]!;
assert(noiseA.length !== noiseB.length || noiseA.some((v, i) => v !== noiseB[i]), "a different seed changes the noise (two snares of the same recipe differ)");

// --- 2. what the operator asked for ----------------------------------------------------
let tails = 0;
let longs = 0;
for (let i = 0; i < 12; i++) {
  const d = renderSound("808", randomParams("808", rng(100 + i)), 1)[0]!;
  const win = (from: number) => {
    let e = 0;
    for (let k = Math.round(from * SAMPLE_RATE); k < Math.round((from + 0.1) * SAMPLE_RATE); k++) e += (d[k] ?? 0) ** 2;
    return Math.sqrt(e / (0.1 * SAMPLE_RATE));
  };
  if (20 * Math.log10(win(0.7) / (win(0.02) || 1)) > -30) tails++;
  if (d.length / SAMPLE_RATE >= 1.1) longs++;
}
assert(tails === 12 && longs === 12, `808s keep a real tail: at 0.7 s every one is within 30 dB of its start (${tails}/12), and every one lasts over a second (${longs}/12)`);
const c1 = withDefaults("808", { octave: 1, glide: 0.3, drive: 1, tone: 3000, click: 0, decay: 1.8, harm: 0 });
const sub = renderSound("808", c1, 1)[0]!;
let crossings = 0;
const from = Math.round(0.3 * SAMPLE_RATE);
const to = Math.round(1.1 * SAMPLE_RATE);
for (let i = from + 1; i < to; i++) if (sub[i - 1]! < 0 && sub[i]! >= 0) crossings++;
const hz = crossings / ((to - from) / SAMPLE_RATE);
assert(Math.abs(hz - 32.7) < 2 && soundLabel("808", c1) === "808 C1", `an 808 is on C: labeled "808 C1", measures ${hz.toFixed(1)} Hz (C1 = 32.7 Hz)`);

let maxKick = 0;
let kickHigh = 0;
for (let i = 0; i < 16; i++) {
  const k = renderSound("kick", randomParams("kick", rng(200 + i)), 1)[0]!;
  maxKick = Math.max(maxKick, k.length / SAMPLE_RATE);
  const e = bandEnergy(k, 3000, 0, 2048);
  kickHigh = Math.max(kickHigh, e.high / (e.low + e.high));
}
assert(maxKick <= 0.65, `kicks are short (the longest of 16 is ${maxKick.toFixed(2)} s)`);
assert(kickHigh < 0.01, `a kick's transient has almost no high end (at most ${(kickHigh * 100).toFixed(2)}% of its energy above 3 kHz)`);

let snareHigh = 0;
for (let i = 0; i < 12; i++) {
  const s = renderSound("snare", randomParams("snare", rng(300 + i)), 1)[0]!;
  const e = bandEnergy(s, 8000, 0, 2048);
  snareHigh = Math.max(snareHigh, e.high / (e.low + e.high));
}
assert(snareHigh < 0.12, `snares have little hiss up high (at most ${(snareHigh * 100).toFixed(1)}% above 8 kHz)`);

let closedBody = 0;
for (let i = 0; i < 12; i++) {
  const h = renderSound("hat-closed", randomParams("hat-closed", rng(400 + i)), 1)[0]!;
  const e = bandEnergy(h, 3000, 0, 2048);
  if (e.high > e.low * 3) closedBody++;
}
assert(closedBody === 12, `closed hats still live up high (above 3 kHz) even with the added body (${closedBody}/12)`);

const openSigs = new Set<string>();
for (let i = 0; i < 10; i++) {
  const h = renderSound("hat-open", randomParams("hat-open", rng(500 + i)), i + 1)[0]!;
  const e = bandEnergy(h, 8000, 0, 4096);
  openSigs.add(`${Math.round((e.high / (e.low + e.high)) * 10)}-${Math.round(h.length / 8000)}`);
}
assert(openSigs.size >= 4, `open hats vary (${openSigs.size} distinct brightness/length profiles in 10)`);

// Every melodic sound is tuned to C, and stereo.
const tunings: [SoundKind, Record<string, number>][] = [
  ["bell", { type: 0, octave: 5, ratioIdx: 0, index: 1, chorus: 0, wet: 0 }],
  ["bell", { type: 2, octave: 4, chorus: 0, wet: 0 }],
  ["pluck", { type: 0, octave: 4, wet: 0, chorus: 0, damp: 0.9 }],
  ["pluck", { type: 3, octave: 4, wet: 0, chorus: 0 }],
  ["keys", { type: 0, octave: 4, chorus: 0, wet: 0, drive: 1, index: 0.5 }],
  ["keys", { type: 1, octave: 3, chorus: 0, wet: 0, drive: 1 }],
  ["lead", { type: 0, octave: 4, wet: 0, vibrato: 0, glideSemi: 0, drive: 1, spread: 5 }],
  ["lead", { type: 2, octave: 5, wet: 0, vibrato: 0, glideSemi: 0, drive: 1 }],
];
const off: string[] = [];
for (const [kind, over] of tunings) {
  const d = renderSound(kind, withDefaults(kind, over), 3)[0]!;
  const want = C(over.octave!);
  const got = pitch(d, Math.round(0.12 * SAMPLE_RATE));
  const ratio = got / want;
  // An octave error from autocorrelation is possible; a wrong NOTE is not: allow x1, x2, x0.5 within 2%.
  if (![1, 2, 0.5].some((m) => Math.abs(ratio / m - 1) < 0.02)) off.push(`${kind}/type ${over.type} C${over.octave}: ${got.toFixed(1)} Hz vs ${want.toFixed(1)}`);
}
assert(off.length === 0, `melodic sounds are tuned to C${off.length ? ` (off: ${off.join("; ")})` : ""}`);
assert(soundLabel("bell", withDefaults("bell", { type: 0, octave: 5 })) === "Glass Bell C5" && soundLabel("pad", withDefaults("pad", { type: 1, octave: 3 })) === "Choir Pad C3", "labels name the architecture and the note: \"Glass Bell C5\", \"Choir Pad C3\"");
const stereo = renderSound("pad", randomParams("pad", rng(9)), 1);
let diff = 0;
for (let i = 0; i < stereo[0]!.length; i++) diff += Math.abs(stereo[0]![i]! - stereo[1]![i]!);
assert(stereo.length === 2 && diff / stereo[0]!.length > 1e-4, "melodic sounds are real stereo (the two channels differ), not a doubled mono");

let bellHigh = 0;
for (let i = 0; i < 24; i++) {
  const b = renderSound("bell", randomParams("bell", rng(600 + i)), 1)[0]!;
  const e = bandEnergy(b, 8000, 2000, 4096);
  bellHigh = Math.max(bellHigh, e.high / (e.low + e.high));
}
assert(bellHigh < 0.02, `bells don't scratch: at most ${(bellHigh * 100).toFixed(2)}% of the energy above 8 kHz in 24 bells`);

// --- 3. the WAV is real -----------------------------------------------------------------
const dir = path.join(process.cwd(), "data-test", "test-soundlab");
await mkdir(dir, { recursive: true });
if (spawnSync(process.env.AGENT_OS_FFMPEG ?? "ffmpeg", ["-version"]).status !== 0) console.log("SKIP: ffmpeg not found");
else {
  for (const [kind, label] of [["bell", "stereo"], ["808", "mono"]] as const) {
    const d = renderSound(kind, randomParams(kind, rng(11)), 1);
    const wavPath = path.join(dir, `check-${label}.wav`);
    await writeFile(wavPath, encodeWav24(d));
    const info = await audioInfo(wavPath);
    assert(Math.abs((info.durationSec ?? 0) - d[0]!.length / SAMPLE_RATE) < 0.02 && info.sampleRate === SAMPLE_RATE && (label === "stereo" ? /stereo/.test(info.channels ?? "") : /mono/.test(info.channels ?? "")), `ffmpeg decodes the ${label} 24-bit WAV: ${info.durationSec} s, ${info.channels}`);
    assert(Math.abs((info.peakDb ?? 0) + 1) < 0.2, `…and measures the peak at ${info.peakDb} dB (target -1)`);
  }
}

// --- 4. params ----------------------------------------------------------------------------
const wild = cleanParams("kick", { f0: 99999, f1: -5, pitchDecay: "x", bogus: 1 });
assert(wild.f0 === RECIPES.kick.f0!.max && wild.f1 === RECIPES.kick.f1!.min && Number.isFinite(wild.pitchDecay!) && !("bogus" in wild), "out-of-range, junk and unknown params are re-fitted into the recipe");
const parent = randomParams("pluck", rng(5));
let near = true;
let switched = 0;
for (let i = 0; i < 100; i++) {
  const child = mutateParams("pluck", parent, rng(i));
  if (child.type !== parent.type) switched++;
  for (const [k, range] of Object.entries(RECIPES.pluck)) {
    if (child[k]! < range.min || child[k]! > range.max) near = false;
    if (!range.int && Math.abs(child[k]! - parent[k]!) > 0.7 * (range.max - range.min)) near = false;
  }
}
assert(near, "mutations stay inside the ranges and close to their parent");
assert(switched <= 25, `a nudge of a sound you liked rarely switches its architecture (${switched} of 100)`);
const types = new Set(Array.from({ length: 80 }, (_, i) => randomParams("pluck", rng(i)).type));
assert(types.size === 4, "fresh plucks use all four architectures");

// --- 5. the lab ---------------------------------------------------------------------------
await appendEvent("soundlab", "sound.candidate", { id: "snd-legacy", batchId: "old", kind: "808", label: "808 F1", params: { note: 5 }, seed: 1, createdAt: new Date().toISOString() });
await appendEvent("soundlab", "sound.judged", { id: "snd-legacy", verdict: "accepted" });
assert(!(await getCandidate("snd-legacy")) && (await listCandidates({ verdict: "accepted" })).length === 0 && (await stats()).total!.accepted === 0, `a sound from the older engine is hidden, not re-rendered (engine ${ENGINE_VERSION} now)`);

const first = await generateBatch("808", 12, 42);
assert(first.length === 12 && first.every((c) => c.verdict === "pending" && !c.parentId && /^808 C[12]$/.test(c.label) && c.engine === ENGINE_VERSION), "a batch of 12 fresh 808s, all pending, on C, from the current engine");
assert((await generateBatch("808", 12, 42)).every((c, i) => JSON.stringify(c.params) === JSON.stringify(first[i]!.params)), "the same seed gives the same batch (reproducible)");
let threw = 0;
for (const bad of [0, 25, 1.5e9]) await generateBatch("808", bad).catch(() => threw++);
assert(threw === 3, "batch sizes outside 1–24 are refused");
assert(await generateBatch("nonsense" as SoundKind, 3).then(() => false, () => true), "an unknown kind is refused");

await judge(first[0]!.id, "accepted");
await judge(first[1]!.id, "accepted");
await judge(first[2]!.id, "accepted");
await judge(first[3]!.id, "skipped");
await judge(first[4]!.id, "maybe");
await judge(first[3]!.id, "pending");
const s = await stats();
assert(s["808"]!.accepted === 3 && s["808"]!.maybe === 1 && s["808"]!.skipped === 0 && s.total!.accepted === 3, "verdicts count per kind, and a skip can be undone");
assert(await judge("snd-nope", "accepted").then(() => false, (e) => e.status === 404) && await judge(first[5]!.id, "love").then(() => false, (e) => e.status === 400), "an unknown sound or verdict is refused");

const steered = await generateBatch("808", 24, 99);
const children = steered.filter((c) => c.parentId);
const liked = new Set([first[0]!.id, first[1]!.id, first[2]!.id]);
assert(children.length >= 8 && children.length <= 21 && children.every((c) => liked.has(c.parentId!)), `after accepting sounds a new batch is mostly nudges of them (${children.length} of 24), and only of accepted ones`);
assert((await generateBatch("kick", 5, 1)).every((c) => !c.parentId), "accepting 808s doesn't steer kicks");
assert((await listCandidates({ verdict: "pending", kind: "808" })).length === 44, "pending 808s are listed: 8 left of the first batch, the 12 reproduced batch, the 24 steered ones");

// --- 6. HTTP ------------------------------------------------------------------------------
const gateway = await startGateway({ model: createStubModel(), worker: createStubWorker() });
const base = `http://127.0.0.1:${gateway.port}`;
const api = async (method: string, route: string, body?: unknown) => fetch(`${base}${route}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
try {
  const made = await (await api("POST", "/soundlab/batches", { kind: "pad", count: 6 })).json() as any;
  assert(made.candidates.length === 6 && made.candidates.every((c: any) => c.kind === "pad"), "POST /soundlab/batches creates candidates");
  assert((await api("POST", "/soundlab/batches", { kind: "tuba" })).status === 400, "an unknown kind is a 400");
  const listed = await (await api("GET", "/soundlab/candidates?verdict=pending&kind=pad")).json() as any;
  assert(listed.candidates.length === 6, "GET /soundlab/candidates filters by verdict and kind");
  const id = made.candidates[0].id;
  const audio = await api("GET", `/soundlab/candidates/${id}/audio`);
  const bytes = Buffer.from(await audio.arrayBuffer());
  assert(audio.status === 200 && audio.headers.get("content-type") === "audio/wav" && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.readUInt16LE(34) === 24 && bytes.readUInt16LE(22) === 2, "the audio route serves a 24-bit stereo WAV for a pad");
  assert(audio.headers.get("accept-ranges") === "bytes", "…with Range support for the player");
  const ranged = await fetch(`${base}/soundlab/candidates/${id}/audio`, { headers: { range: "bytes=0-43" } });
  assert(ranged.status === 206 && (await ranged.arrayBuffer()).byteLength === 44, "…a ranged request gets exactly those bytes");
  assert((await api("GET", "/soundlab/candidates/snd-nope/audio")).status === 404 && (await api("GET", "/soundlab/candidates/snd-legacy/audio")).status === 404, "an unknown or archived sound is a 404");
  const judged = await (await api("POST", `/soundlab/candidates/${id}/judge`, { verdict: "accepted" })).json() as any;
  assert(judged.verdict === "accepted", "POST …/judge records the verdict");
  assert((await api("POST", `/soundlab/candidates/${id}/judge`, { verdict: "meh" })).status === 400, "a bad verdict is a 400");
  const st = await (await api("GET", "/soundlab/stats")).json() as any;
  assert(st.pad.accepted === 1 && st.pad.pending === 5, "GET /soundlab/stats counts them");
} finally {
  await gateway.stop();
}

console.log(failed ? "\nSome soundlab tests FAILED." : "\nAll soundlab tests passed.");
process.exit(failed ? 1 : 0);
