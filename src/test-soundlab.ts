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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
  kick: [0.1, 0.8], "808": [0.5, 3.6], snare: [0.1, 1.2], clap: [0.1, 1.8], perc: [0.04, 0.9], "hat-closed": [0.02, 0.25], "hat-open": [0.2, 1.7],
  bell: [1, 6.5], pluck: [0.25, 6], keys: [1, 8], pad: [2.4, 11], strings: [0.4, 7], lead: [1, 3.6],
};
const STEREO = new Set<SoundKind>(["bell", "pluck", "keys", "pad", "strings", "lead"]);
for (const kind of SOUND_KINDS) {
  const rand = rng(7);
  let bad = "";
  const t0 = Date.now();
  // 24 fresh sounds, plus every build of the kind (including old ones that are no longer generated).
  const cases: { params: Record<string, number>; label: string }[] = Array.from({ length: 24 }, () => ({ params: randomParams(kind, rand), label: "fresh" }));
  const typeRange = RECIPES[kind].type;
  if (typeRange) for (let t = typeRange.min; t <= typeRange.max; t++) for (let k = 0; k < 2; k++) cases.push({ params: { ...randomParams(kind, rand), type: t }, label: `build ${t}` });
  for (let n = 0; n < cases.length && !bad; n++) {
    const { params, label } = cases[n]!;
    const d = renderSound(kind, params, n + 1);
    const sec = d[0]!.length / SAMPLE_RATE;
    if (!d.every((c) => c.every(Number.isFinite))) bad = `${label}: NaN or infinity`;
    else if (Math.abs(peakDb(d) + 1) > 0.05) bad = `${label}: peak ${peakDb(d).toFixed(2)} dB`;
    else if (d.some((c) => Math.abs(c[c.length - 1]!) > 1e-3)) bad = `${label}: tail not faded`;
    else if (sec < LEN[kind][0] || sec > LEN[kind][1]) bad = `${label}: length ${sec.toFixed(2)} s outside ${LEN[kind]} (${JSON.stringify(params)})`;
    else if (d.length !== (STEREO.has(kind) ? 2 : 1)) bad = `${label}: ${d.length} channels`;
    else if (renderSound(kind, params, n + 1).some((c, ch) => c.some((v, i) => v !== d[ch]![i]))) bad = `${label}: not deterministic`;
  }
  assert(!bad, `${kind}: ${cases.length} sounds (fresh and every build) are clean, in length, -1 dBFS, deterministic${bad ? ` (${bad})` : ""} (${Date.now() - t0} ms)`);
}
const noiseA = renderSound("snare", randomParams("snare", rng(1)), 1)[0]!;
const noiseB = renderSound("snare", randomParams("snare", rng(1)), 2)[0]!;
assert(noiseA.length !== noiseB.length || noiseA.some((v, i) => v !== noiseB[i]), "a different seed changes the noise (two snares of the same recipe differ)");

// --- 2. what the operator asked for ----------------------------------------------------
let tails = 0;
let longs = 0;
for (let i = 0; i < 12; i++) {
  const d = renderSound("808", { ...randomParams("808", rng(100 + i)), type: i % 4 }, 1)[0]!;
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
assert(maxKick <= 0.8, `kicks are short (the longest of 16 is ${maxKick.toFixed(2)} s)`);
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

// --- 2b. v3: the second listening round, as checks ---------------------------------------------
const bursts = (d: Float32Array) => {
  // Peaks of a 2 ms RMS envelope in the first 80 ms (how many separate hits you can hear).
  const win = Math.round(0.002 * SAMPLE_RATE);
  const env: number[] = [];
  for (let i = 0; i + win < Math.round(0.08 * SAMPLE_RATE); i += win) {
    let e = 0;
    for (let k = 0; k < win; k++) e += d[i + k]! ** 2;
    env.push(Math.sqrt(e / win));
  }
  const max = Math.max(...env);
  let peaks = 0;
  for (let i = 1; i < env.length - 1; i++) if (env[i]! > env[i - 1]! * 1.15 && env[i]! >= env[i + 1]! && env[i]! > max * 0.3) peaks++;
  return peaks;
};
const zeroHz = (d: Float32Array, from: number, to: number) => {
  let n = 0;
  const a = Math.round(from * SAMPLE_RATE);
  const b = Math.round(to * SAMPLE_RATE);
  for (let i = a + 1; i < b; i++) if (d[i - 1]! < 0 && d[i]! >= 0) n++;
  return n / (to - from);
};
const centroid = (d: Float32Array, start: number, size = 2048) => {
  let num = 0;
  let den = 0;
  for (let k = 1; k < size / 2; k++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < size; i++) {
      const v = (d[start + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
      re += v * Math.cos((2 * Math.PI * k * i) / size);
      im -= v * Math.sin((2 * Math.PI * k * i) / size);
    }
    const e = re * re + im * im;
    num += ((k * SAMPLE_RATE) / size) * e;
    den += e;
  }
  return den ? num / den : 0;
};
const profiles = (kind: SoundKind, n: number, seed: number, over: Record<string, number> = {}) => {
  const set = new Set<string>();
  for (let i = 0; i < n; i++) {
    const d = renderSound(kind, { ...randomParams(kind, rng(seed + i)), ...over }, i + 1)[0]!;
    set.add(`${Math.round(Math.log2(centroid(d, 0) + 1) * 1.5)}-${Math.round(Math.log2(d.length))}`);
  }
  return set.size;
};

// Fresh generation never draws a build you've moved on from (they still render, see the golden test).
for (const kind of SOUND_KINDS) {
  const type = RECIPES[kind].type;
  if (!type?.weights) continue;
  const seen = new Set<number>();
  for (let i = 0; i < 400; i++) seen.add(randomParams(kind, rng(i))["type"]!);
  const zero = type.weights.map((w, i) => (w === 0 ? i : -1)).filter((i) => i >= 0);
  const live = type.weights.map((w, i) => (w > 0 ? i : -1)).filter((i) => i >= 0);
  assert(zero.every((i) => !seen.has(i)) && live.every((i) => seen.has(i)), `${kind}: fresh sounds use builds ${live.join(",")} and never ${zero.join(",") || "(none excluded)"}`);
}

// Old sounds are untouched: 66 recorded renders from the previous engine come out byte for byte the same.
const gold = JSON.parse(await readFile(path.join(process.cwd(), "src", "test-data", "soundlab-v2-golden.json"), "utf8")) as { kind: SoundKind; params: Record<string, number>; seed: number; channels: number; frames: number; sha1: string }[];
let changed = 0;
for (const g of gold) {
  const chs = renderSound(g.kind, g.params, g.seed);
  const h = createHash("sha1");
  for (const c of chs) h.update(Buffer.from(c.buffer, c.byteOffset, c.byteLength));
  if (h.digest("hex") !== g.sha1 || chs.length !== g.channels || chs[0]!.length !== g.frames) changed++;
}
assert(gold.length >= 60 && changed === 0, `old sounds render byte for byte as before (${gold.length} recorded renders, ${changed} changed)`);

// Kicks: less EDM (lower start pitch), less jumpy.
const startPitch = (legacy: boolean) => {
  let sum = 0;
  for (let i = 0; i < 20; i++) {
    const base = randomParams("kick", rng(700 + i));
    const d = renderSound("kick", legacy ? { ...base, type: 0 } : { ...base, type: 1 + (i % 5) }, 1)[0]!;
    sum += zeroHz(d, 0.003, 0.03);
  }
  return sum / 20;
};
const oldKick = startPitch(true);
const newKick = startPitch(false);
assert(newKick < oldKick * 0.85, `new kicks start lower than the old EDM-style ones (${newKick.toFixed(0)} Hz vs ${oldKick.toFixed(0)} Hz in the first 30 ms)`);
assert(profiles("kick", 15, 800, { type: 3 }) >= 2 && new Set(Array.from({ length: 30 }, (_, i) => randomParams("kick", rng(900 + i))["type"])).size === 5, "kicks come in five builds (thud, boom, acoustic, knock, lo-fi)");
let maxK = 0;
for (let i = 0; i < 25; i++) for (let t = 1; t <= 5; t++) maxK = Math.max(maxK, renderSound("kick", { ...randomParams("kick", rng(950 + i)), type: t }, 1)[0]!.length / SAMPLE_RATE);
assert(maxK <= 0.8, `every new kick build stays short (longest ${maxK.toFixed(2)} s)`);

// Snares: variety.
assert(profiles("snare", 20, 1000) >= 5, `fresh snares differ from each other (${profiles("snare", 20, 1000)} distinct profiles in 20)`);
// Claps: the ticky "jitter" is gone, and there are more kinds.
let newBursts = 0;
let oldBursts = 0;
for (let i = 0; i < 20; i++) {
  const base = randomParams("clap", rng(1100 + i));
  newBursts += bursts(renderSound("clap", { ...base, type: 1 + (i % 4) }, 1)[0]!);
  oldBursts += bursts(renderSound("clap", { ...base, type: 0 }, 1)[0]!);
}
assert(newBursts / 20 < oldBursts / 20 * 0.8, `new claps hit less like a ticking machine gun (${(newBursts / 20).toFixed(1)} separate hits on average vs ${(oldBursts / 20).toFixed(1)})`);
assert(profiles("clap", 20, 1200) >= 4, `claps vary in tone and length (${profiles("clap", 20, 1200)} profiles)`);
// Perc: six kinds of percussion.
for (let t = 0; t < 6; t++) {
  const d = renderSound("perc", { ...randomParams("perc", rng(1300 + t)), type: t }, 1);
  assert(d.length === 1 && d[0]!.length / SAMPLE_RATE >= 0.04 && d[0]!.length / SAMPLE_RATE <= 0.9 && Number.isFinite(d[0]![10]!), `perc "${soundLabel("perc", { type: t })}" renders (${(d[0]!.length / SAMPLE_RATE).toFixed(2)} s)`);
}
assert(new Set(Array.from({ length: 24 }, (_, i) => randomParams("perc", rng(1400 + i))["type"])).size === 6, "fresh perc draws all six kinds");

// Hats: clean (no aliasing), more builds, more variety.
let aliasNew = 0;
let aliasOld = 0;
for (let i = 0; i < 12; i++) {
  // The metallic part with the least noise. The old build used naive square waves (they alias, which is what made them sound cheap);
  // the new one is built from sine sums cut at 14 kHz.
  const base = { ...randomParams("hat-closed", rng(1500 + i)), noise: 0.15, body: 0.05 };
  for (const [type, kind] of [[1, "new"], [0, "old"]] as const) {
    const d = renderSound("hat-closed", { ...base, type }, 1)[0]!;
    const e = bandEnergy(d, 16500, 0, 1024);
    const share = e.high / (e.low + e.high);
    if (kind === "new") aliasNew += share / 12;
    else aliasOld += share / 12;
  }
}
assert(aliasNew < aliasOld * 0.7, `the clean closed hat has far less aliasing junk above its band than the old one (${(aliasNew * 100).toFixed(2)}% vs ${(aliasOld * 100).toFixed(2)}% above 16.5 kHz)`);
assert(profiles("hat-closed", 20, 1600) >= 3, `closed hats vary (${profiles("hat-closed", 20, 1600)} profiles)`);
assert(profiles("hat-open", 20, 1700) >= 4, `open hats vary a lot (${profiles("hat-open", 20, 1700)} profiles in 20)`);

// 808s: dynamics (the tone moves, they can slide and swell).
let moving = 0;
for (let i = 0; i < 20; i++) {
  const d = renderSound("808", { ...randomParams("808", rng(1800 + i)), type: 0 }, 1)[0]!;
  const e = bandEnergy(d, 400, Math.round(0.03 * SAMPLE_RATE), 4096);
  const l = bandEnergy(d, 400, Math.round(0.9 * SAMPLE_RATE), 4096);
  if (e.high / (e.low + e.high) > (l.high / (l.low + l.high)) * 1.1) moving++;
}
assert(moving >= 12, `808 tone moves over the note (more of the early sound is above 400 Hz than the tail's, in ${moving} of 20)`);
let slid = 0;
for (let i = 0; i < 10; i++) {
  const d = renderSound("808", { ...randomParams("808", rng(1900 + i)), type: 1, slide: i % 2 ? 7 : -7, slideTime: 0.3, glide: 0.2, toneStart: 1, bloom: 0 }, 1)[0]!;
  const early = zeroHz(d, 0.05, 0.14);
  const late = zeroHz(d, 1.0, 1.4);
  if (Math.abs(Math.log2(early / late)) > 0.12) slid++;
}
assert(slid >= 9, `a slide 808 really moves between notes (${slid} of 10)`);
assert(soundLabel("808", { type: 1, octave: 1 }) === "Slide 808 C1" && /^(Slide |Dirty |Bloom |Stab )?808 C[12]$/.test(soundLabel("808", randomParams("808", rng(5)))), "808 builds are named (\"Slide 808 C1\")");
let c1Share = 0;
for (let i = 0; i < 300; i++) if (randomParams("808", rng(2000 + i))["octave"] === 1) c1Share++;
assert(c1Share > 170 && c1Share < 230, `808s favour C1, as the kept sounds did (${c1Share} of 300 on C1)`);

// Bells: effects that make them more enticing, and they stay clean.
const bellBase = withDefaults("bell", { type: 0, octave: 5, wet: 0.2, chorus: 0 });
const plain = renderSound("bell", bellBase, 3);
const echoed = renderSound("bell", { ...bellBase, echo: 0.4, echoTime: 0.3, echoFb: 0.5 }, 3);
assert(echoed[0]!.length > plain[0]!.length * 1.1 && echoed[0]!.some((v, i) => Math.abs(v - echoed[1]![i]!) > 1e-3), "a bell with echo has a longer tail and bounces left and right");
const panned = renderSound("bell", { ...bellBase, autopan: 0.5 }, 3);
let lo = 0;
let hi = 0;
for (let i = 0; i < panned[0]!.length; i++) {
  lo += Math.abs(panned[0]![i]!);
  hi += Math.abs(panned[1]![i]!);
}
assert(Math.abs(lo - hi) / (lo + hi) > 0.005 || panned[0]!.some((v, i) => Math.abs(v - panned[1]![i]!) > 1e-3), "auto-pan moves a bell between the speakers");
const swelled = renderSound("bell", { ...bellBase, bswell: 0.2 }, 3)[0]!;
assert(Math.abs(swelled[Math.round(0.01 * SAMPLE_RATE)]!) < 0.05 * Math.max(...swelled.slice(0, 20000).map(Math.abs)), "a swelling bell starts quietly");
let bellTop = 0;
for (let i = 0; i < 30; i++) {
  const b = renderSound("bell", { ...randomParams("bell", rng(2100 + i)), echo: 0.3 }, 1)[0]!;
  const e = bandEnergy(b, 8000, 2000, 4096);
  bellTop = Math.max(bellTop, e.high / (e.low + e.high));
}
assert(bellTop < 0.02, `bells with effects are still not harsh (at most ${(bellTop * 100).toFixed(2)}% above 8 kHz)`);

// Plucks: natural instruments, in tune.
const naturalOff: string[] = [];
for (const t of [4, 5, 6, 7, 8]) {
  const params = withDefaults("pluck", { type: t, octave: 4, wet: 0, chorus: 0, decay: 1 });
  const d = renderSound("pluck", params, 3)[0]!;
  const got = pitch(d, Math.round(0.08 * SAMPLE_RATE));
  const ratio = got / C(4);
  if (![1, 2, 0.5].some((m) => Math.abs(ratio / m - 1) < 0.025)) naturalOff.push(`${soundLabel("pluck", params)} ${got.toFixed(1)} Hz`);
}
assert(naturalOff.length === 0, `nylon, harp, kalimba, pizzicato and oud plucks are tuned to C${naturalOff.length ? ` (off: ${naturalOff.join("; ")})` : ""}`);
assert(new Set(Array.from({ length: 80 }, (_, i) => randomParams("pluck", rng(i))["type"])).size === 5, "fresh plucks use the five natural builds");

// Keys: a modelled piano with a real decay, Rhodes and Wurlitzer, and no organ.
const pianoParams = withDefaults("keys", { type: 3, octave: 3, wet: 0, decay: 2 });
const piano = renderSound("keys", pianoParams, 4);
const rms = (d: Float32Array, from: number) => {
  let e = 0;
  const a = Math.round(from * SAMPLE_RATE);
  for (let i = a; i < a + 2000; i++) e += (d[i] ?? 0) ** 2;
  return Math.sqrt(e / 2000);
};
const dropDb = 20 * Math.log10(rms(piano[0]!, 1.2) / rms(piano[0]!, 0.1));
assert(piano.length === 2 && dropDb < -3 && dropDb > -40, `the piano rings and decays like a piano (${dropDb.toFixed(1)} dB from 0.1 s to 1.2 s)`);
const pitchOk = [3, 4, 5].every((t) => {
  const d = renderSound("keys", withDefaults("keys", { type: t, octave: 3, wet: 0, decay: 2, tremolo: 0 }), 4)[0]!;
  const ratio = pitch(d, Math.round(0.1 * SAMPLE_RATE)) / C(3);
  return [1, 2, 0.5].some((m) => Math.abs(ratio / m - 1) < 0.025);
});
assert(pitchOk, "piano, Rhodes and Wurlitzer are tuned to C");
assert(profiles("keys", 18, 2200) >= 4, `keys differ from each other (${profiles("keys", 18, 2200)} profiles)`);
let organ = 0;
for (let i = 0; i < 300; i++) if (randomParams("keys", rng(i))["type"] === 2) organ++;
assert(organ === 0 && new Set(Array.from({ length: 120 }, (_, i) => randomParams("keys", rng(i))["type"])).size === 4, "no organ is ever generated; keys are grand, Rhodes, Wurlitzer and felt");

// Leads: soft, and nothing piercing.
let leadTop = 0;
for (let i = 0; i < 30; i++) {
  const d = renderSound("lead", randomParams("lead", rng(2300 + i)), 1)[0]!;
  const e = bandEnergy(d, 5000, Math.round(0.1 * SAMPLE_RATE), 4096);
  leadTop = Math.max(leadTop, e.high / (e.low + e.high));
}
assert(leadTop < 0.03, `leads aren't piercing (at most ${(leadTop * 100).toFixed(2)}% of the energy above 5 kHz in 30 leads)`);
assert(new Set(Array.from({ length: 120 }, (_, i) => randomParams("lead", rng(i))["type"])).size === 4, "fresh leads use the four soft builds (soft saw, sine, hollow, dark super)");

// Strings: a section in stereo, tuned to C, in several articulations and chords.
const strLegato = renderSound("strings", withDefaults("strings", { type: 0, chord: 0, octave: 3, wet: 0.2, chorus: 0.3, attack: 0.1, vibrato: 3, voices: 4 }), 5);
const strPitch = pitch(strLegato[0]!, Math.round(0.6 * SAMPLE_RATE)) / C(3);
assert(strLegato.length === 2 && [1, 2, 0.5].some((m) => Math.abs(strPitch / m - 1) < 0.03), `the string section is stereo and tuned to C (${(strPitch * C(3)).toFixed(1)} Hz vs ${C(3).toFixed(1)})`);
const lens = [0, 1, 2, 3, 4].map((t) => renderSound("strings", { ...randomParams("strings", rng(2400)), type: t }, 1)[0]!.length / SAMPLE_RATE);
assert(lens[1]! < lens[0]! && lens[2]! > 2.5 && lens[4]! < lens[0]!, `articulations differ in length: staccato ${lens[1]!.toFixed(1)} s and pizzicato ${lens[4]!.toFixed(1)} s are shorter than legato ${lens[0]!.toFixed(1)} s`);
assert(soundLabel("strings", { type: 2, chord: 2, octave: 3 }) === "Swell Strings Minor C3" && new Set(Array.from({ length: 60 }, (_, i) => randomParams("strings", rng(i))["chord"])).size === 4, "strings come as single notes, octaves, minor chords and fifths, labeled (\"Swell Strings Minor C3\")");

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


// --- 5. the lab ---------------------------------------------------------------------------
await appendEvent("soundlab", "sound.candidate", { id: "snd-legacy", batchId: "old", kind: "808", label: "808 F1", params: { note: 5 }, seed: 1, createdAt: new Date().toISOString() });
await appendEvent("soundlab", "sound.judged", { id: "snd-legacy", verdict: "accepted" });
assert(!(await getCandidate("snd-legacy")) && (await listCandidates({ verdict: "accepted" })).length === 0 && (await stats()).total!.accepted === 0, `a sound from the older engine is hidden, not re-rendered (engine ${ENGINE_VERSION} now)`);

const first = await generateBatch("808", 12, 42);
assert(first.length === 12 && first.every((c) => c.verdict === "pending" && !c.parentId && /^(Slide |Dirty |Bloom |Stab )?808 C[12]$/.test(c.label) && c.engine === ENGINE_VERSION), "a batch of 12 fresh 808s, all pending, on C, from the current engine");
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
