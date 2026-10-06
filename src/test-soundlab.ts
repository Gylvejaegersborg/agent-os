// Tests for the sound engine and the Sound Lab (core/soundgen.ts, core/soundlab.ts, gateway/soundlab-routes.ts).
// Proves what code CAN prove about sounds (not how they feel; that's the operator's ears):
//   1. Every kind renders clean sounds over many random parameter sets: no NaN, peak at -1 dBFS,
//      no click at the tail, sensible length, deterministic for the same kind + params + seed.
//   2. They are what they claim: an 808 on F1 is a ~43.65 Hz tone, a kick keeps its energy low,
//      a hat keeps it high.
//   3. The WAV is a real 24-bit file (ffmpeg decodes it, length and peak match).
//   4. Params from anywhere are re-fitted into range; mutation stays near its parent.
//   5. The Lab: batches, judging (and undo), stats, and steering: after accepting sounds, a
//      new batch is mostly nudges of them.
//   6. The HTTP surface: generate, list, audio (WAV, Range), judge, stats.
// Run with: node dist/test-soundlab.js

import "./test-helpers/isolate.js";
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  RECIPES,
  SAMPLE_RATE,
  SOUND_KINDS,
  cleanParams,
  encodeWav24,
  generateBatch,
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

const peakDb = (d: Float32Array) => {
  let peak = 0;
  for (const v of d) peak = Math.max(peak, Math.abs(v));
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

// --- 1. clean, deterministic, sensible -----------------------------------------------
const LEN: Record<SoundKind, [number, number]> = {
  kick: [0.1, 1], "808": [0.7, 2.7], snare: [0.1, 0.5], clap: [0.15, 0.5], "hat-closed": [0.02, 0.15], "hat-open": [0.2, 0.8],
  bell: [0.9, 3.5], pluck: [0.25, 1.6], keys: [1, 3], pad: [2, 3.8], lead: [1, 1.6],
};
for (const kind of SOUND_KINDS) {
  const rand = rng(7);
  let bad = "";
  const t0 = Date.now();
  for (let n = 0; n < 12 && !bad; n++) {
    const params = randomParams(kind, rand);
    const d = renderSound(kind, params, n + 1);
    const sec = d.length / SAMPLE_RATE;
    if (!d.every(Number.isFinite)) bad = "NaN or infinity";
    else if (Math.abs(peakDb(d) + 1) > 0.05) bad = `peak ${peakDb(d).toFixed(2)} dB`;
    else if (Math.abs(d[d.length - 1]!) > 1e-3) bad = `tail not faded (${d[d.length - 1]})`;
    else if (sec < LEN[kind][0] || sec > LEN[kind][1]) bad = `length ${sec.toFixed(2)} s outside ${LEN[kind]}`;
    else if (renderSound(kind, params, n + 1).some((v, i) => v !== d[i])) bad = "not deterministic";
  }
  assert(!bad, `${kind}: 12 random sounds are clean, in length, -1 dBFS and deterministic${bad ? ` (${bad})` : ""} (${Date.now() - t0} ms)`);
}
const noiseA = renderSound("snare", randomParams("snare", rng(1)), 1);
const noiseB = renderSound("snare", randomParams("snare", rng(1)), 2);
assert(noiseA.length !== noiseB.length || noiseA.some((v, i) => v !== noiseB[i]), "a different seed changes the noise (two snares of the same recipe differ)");

// --- 2. what they claim to be ----------------------------------------------------------
const f1 = { ...cleanParams("808", {}), note: 5, glide: 0, drive: 1, tone: 2600, click: 0, decay: 1.5 };
const sub = renderSound("808", f1, 1);
let crossings = 0;
const from = Math.round(0.3 * SAMPLE_RATE);
const to = Math.round(0.8 * SAMPLE_RATE);
for (let i = from + 1; i < to; i++) if (sub[i - 1]! < 0 && sub[i]! >= 0) crossings++;
const hz = crossings / ((to - from) / SAMPLE_RATE);
assert(Math.abs(hz - 43.65) < 2.5 && soundLabel("808", f1) === "808 F1", `an 808 on F1 is labeled "808 F1" and measures ${hz.toFixed(1)} Hz (F1 = 43.65 Hz)`);
const kickE = bandEnergy(renderSound("kick", randomParams("kick", rng(3)), 1), 400, 0, 4096);
assert(kickE.low > kickE.high * 20, "a kick keeps nearly all its energy below 400 Hz");
const hatE = bandEnergy(renderSound("hat-closed", randomParams("hat-closed", rng(3)), 1), 4000, 0, 2048);
assert(hatE.high > hatE.low * 20, "a closed hat keeps nearly all its energy above 4 kHz");
const bellP = { ...cleanParams("bell", {}), note: 9, octave: 4 };
assert(soundLabel("bell", bellP) === "Bell A4", "a bell on A4 is labeled \"Bell A4\"");

// --- 3. the WAV is real -----------------------------------------------------------------
const dir = path.join(process.cwd(), "data-test", "test-soundlab");
await mkdir(dir, { recursive: true });
const wavPath = path.join(dir, "check.wav");
const bell = renderSound("bell", bellP, 1);
await writeFile(wavPath, encodeWav24(bell));
if (spawnSync(process.env.AGENT_OS_FFMPEG ?? "ffmpeg", ["-version"]).status !== 0) console.log("SKIP: ffmpeg not found");
else {
  const info = await audioInfo(wavPath);
  assert(Math.abs((info.durationSec ?? 0) - bell.length / SAMPLE_RATE) < 0.02 && info.sampleRate === SAMPLE_RATE, `ffmpeg decodes the 24-bit WAV: ${info.durationSec} s at ${info.sampleRate} Hz`);
  assert(Math.abs((info.peakDb ?? 0) + 1) < 0.15, `…and measures the peak at ${info.peakDb} dB (target -1)`);
}

// --- 4. params ----------------------------------------------------------------------------
const wild = cleanParams("kick", { f0: 99999, f1: -5, pitchDecay: "x", bogus: 1 });
assert(wild.f0 === RECIPES.kick.f0!.max && wild.f1 === RECIPES.kick.f1!.min && Number.isFinite(wild.pitchDecay!) && !("bogus" in wild), "out-of-range, junk and unknown params are re-fitted into the recipe");
const parent = randomParams("pluck", rng(5));
let near = true;
for (let i = 0; i < 50; i++) {
  const child = mutateParams("pluck", parent, rng(i));
  for (const [k, range] of Object.entries(RECIPES.pluck)) {
    if (child[k]! < range.min || child[k]! > range.max) near = false;
    if (!range.int && Math.abs(child[k]! - parent[k]!) > 0.7 * (range.max - range.min)) near = false;
  }
}
assert(near, "mutations stay inside the ranges and close to their parent");

// --- 5. the lab ---------------------------------------------------------------------------
const first = await generateBatch("808", 12, 42);
assert(first.length === 12 && first.every((c) => c.verdict === "pending" && !c.parentId && /^808 [A-G]#?1$/.test(c.label)), "a batch of 12 fresh 808s, all pending and labeled with their note");
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
let s = await stats();
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
const api = async (method: string, route: string, body?: unknown) => {
  const res = await fetch(`${base}${route}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res;
};
try {
  const made = await (await api("POST", "/soundlab/batches", { kind: "snare", count: 6 })).json() as any;
  assert(made.candidates.length === 6 && made.candidates.every((c: any) => c.kind === "snare"), "POST /soundlab/batches creates candidates");
  assert((await api("POST", "/soundlab/batches", { kind: "tuba" })).status === 400, "an unknown kind is a 400");
  const listed = await (await api("GET", "/soundlab/candidates?verdict=pending&kind=snare")).json() as any;
  assert(listed.candidates.length === 6, "GET /soundlab/candidates filters by verdict and kind");
  const id = made.candidates[0].id;
  const audio = await api("GET", `/soundlab/candidates/${id}/audio`);
  const bytes = Buffer.from(await audio.arrayBuffer());
  assert(audio.status === 200 && audio.headers.get("content-type") === "audio/wav" && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.readUInt16LE(34) === 24, "the audio route serves a 24-bit WAV");
  const part = await api("GET", `/soundlab/candidates/${id}/audio`, undefined);
  assert(part.headers.get("accept-ranges") === "bytes", "…with Range support for the player");
  const ranged = await fetch(`${base}/soundlab/candidates/${id}/audio`, { headers: { range: "bytes=0-43" } });
  assert(ranged.status === 206 && (await ranged.arrayBuffer()).byteLength === 44, "…a ranged request gets exactly those bytes");
  assert((await api("GET", "/soundlab/candidates/snd-nope/audio")).status === 404, "an unknown sound is a 404");
  const judged = await (await api("POST", `/soundlab/candidates/${id}/judge`, { verdict: "accepted" })).json() as any;
  assert(judged.verdict === "accepted", "POST …/judge records the verdict");
  assert((await api("POST", `/soundlab/candidates/${id}/judge`, { verdict: "meh" })).status === 400, "a bad verdict is a 400");
  const st = await (await api("GET", "/soundlab/stats")).json() as any;
  assert(st.snare.accepted === 1 && st.snare.pending === 5, "GET /soundlab/stats counts them");
} finally {
  await gateway.stop();
}

console.log(failed ? "\nSome soundlab tests FAILED." : "\nAll soundlab tests passed.");
process.exit(failed ? 1 : 0);
