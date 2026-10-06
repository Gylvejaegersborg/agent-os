// Procedural sound design: drums and melodic one-shots made from plain DSP (oscillators,
// FM, noise, envelopes, filters, saturation). Nothing is sampled from anyone else's audio,
// so everything it makes is the operator's own to sell.
//
// A sound is a RECIPE (the kind) plus PARAMETERS (numbers inside the recipe's ranges).
// Rendering is deterministic: the same kind + params always give the same samples, so a
// candidate only needs its params stored, and the audio is rendered when it's played.
//
// What this can't do: judge how a sound feels. It guarantees the technical basics (no NaN,
// no clicks at the tail, peak at -1 dBFS, silence trimmed). The operator's ears decide what
// is good, and their accepted sounds steer the next batch (mutateParams).
//
// Honest limit: classic synthesized drums are a well-trodden technique; melodic one-shots
// from plain FM/subtractive synthesis can sound thin, which is why the loop is "generate,
// listen, keep the few that work", not "trust the first render".

export const SAMPLE_RATE = 44100;

export type SoundKind = "kick" | "808" | "snare" | "clap" | "hat-closed" | "hat-open" | "bell" | "pluck" | "keys" | "pad" | "lead";
export const SOUND_KINDS: SoundKind[] = ["808", "kick", "snare", "clap", "hat-closed", "hat-open", "bell", "pluck", "keys", "pad", "lead"];
export const MELODIC_KINDS = new Set<SoundKind>(["808", "bell", "pluck", "keys", "pad", "lead"]);

type Params = Record<string, number>;
interface Range {
  min: number;
  max: number;
  /** Integer-valued (notes, octaves). */
  int?: boolean;
}

const r = (min: number, max: number, int = false): Range => ({ min, max, ...(int ? { int: true } : {}) });

const NOTE = r(0, 11, true);
export const RECIPES: Record<SoundKind, Record<string, Range>> = {
  kick: { f0: r(110, 260), f1: r(38, 62), pitchDecay: r(0.015, 0.07), decay: r(0.14, 0.5), click: r(0, 0.45), drive: r(1, 4.5) },
  "808": { note: NOTE, glide: r(0, 1.5), glideTime: r(0.01, 0.07), decay: r(0.7, 2.2), drive: r(1, 7), tone: r(350, 2600), click: r(0, 0.35) },
  snare: { body: r(150, 240), bodyDecay: r(0.05, 0.14), noiseDecay: r(0.1, 0.34), noiseFreq: r(1600, 5200), mix: r(0.25, 0.8), drive: r(1, 4) },
  clap: { spread: r(0.007, 0.016), tail: r(0.12, 0.34), freq: r(900, 2100), q: r(0.8, 2.6), drive: r(1, 3) },
  "hat-closed": { scale: r(0.85, 1.35), hp: r(5500, 9500), decay: r(0.025, 0.075), noise: r(0, 0.45) },
  "hat-open": { scale: r(0.85, 1.35), hp: r(5000, 9000), decay: r(0.22, 0.6), noise: r(0, 0.45) },
  bell: { note: NOTE, octave: r(4, 6, true), ratio: r(1.4, 4.1), index: r(1.5, 7), indexDecay: r(0.25, 1.2), decay: r(0.9, 3), partial: r(0, 0.3) },
  pluck: { note: NOTE, octave: r(3, 5, true), detune: r(3, 14), cutoff0: r(2200, 9000), cutoff1: r(200, 900), filterDecay: r(0.08, 0.5), decay: r(0.3, 1.2), sub: r(0, 0.5), q: r(0.8, 5) },
  keys: { note: NOTE, octave: r(3, 5, true), index1: r(0.4, 3), index1Decay: r(0.3, 1), index2: r(0.3, 2.2), index2Decay: r(0.04, 0.16), decay: r(1, 2.6) },
  pad: { note: NOTE, octave: r(3, 5, true), detune: r(6, 20), cutoff: r(600, 3200), attack: r(0.12, 0.6), release: r(0.8, 1.4) },
  lead: { note: NOTE, octave: r(4, 5, true), mix: r(0, 1), vibrato: r(4, 26), cutoff: r(2400, 6200), decay: r(0.25, 0.7) },
};

// ---- randomness ------------------------------------------------------------------

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const fit = (range: Range, v: number) => (range.int ? Math.round(clamp(v, range.min, range.max)) : Math.round(clamp(v, range.min, range.max) * 1e4) / 1e4);

/** A fresh sound anywhere in the recipe's ranges. */
export function randomParams(kind: SoundKind, rand: () => number): Params {
  const out: Params = {};
  for (const [k, range] of Object.entries(RECIPES[kind])) out[k] = fit(range, range.min + rand() * (range.max - range.min));
  return out;
}

/** A neighbour of a sound the operator liked: every number nudged a little (about 12% of its range). */
export function mutateParams(kind: SoundKind, parent: Params, rand: () => number, amount = 0.12): Params {
  const gauss = () => (rand() + rand() + rand() + rand() - 2) * 1.7;
  const out: Params = {};
  for (const [k, range] of Object.entries(RECIPES[kind])) {
    const base = typeof parent[k] === "number" ? parent[k]! : range.min + rand() * (range.max - range.min);
    // Notes: usually keep the pitch (the operator liked how it sounds), sometimes move it to get variety in the pack.
    out[k] = range.int ? (rand() < 0.35 ? fit(range, range.min + rand() * (range.max - range.min)) : fit(range, base)) : fit(range, base + gauss() * amount * (range.max - range.min));
  }
  return out;
}

/** Keeps only known, numeric, in-range params (anything stored or posted is re-fitted before use). */
export function cleanParams(kind: SoundKind, raw: unknown): Params {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Params = {};
  for (const [k, range] of Object.entries(RECIPES[kind])) {
    const v = Number(src[k]);
    out[k] = Number.isFinite(v) ? fit(range, v) : fit(range, (range.min + range.max) / 2);
  }
  return out;
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const midiOf = (p: Params, kind: SoundKind) => 12 * (((kind === "808" ? 1 : p.octave) ?? 4) + 1) + (p.note ?? 0);
const freqOf = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/** What a sound is called in the pack: "808 F1", "Bell A4", "Kick". */
export function soundLabel(kind: SoundKind, params: Params): string {
  const title: Record<SoundKind, string> = { kick: "Kick", "808": "808", snare: "Snare", clap: "Clap", "hat-closed": "Closed Hat", "hat-open": "Open Hat", bell: "Bell", pluck: "Pluck", keys: "Keys", pad: "Pad", lead: "Lead" };
  if (!MELODIC_KINDS.has(kind)) return title[kind];
  const midi = midiOf(params, kind);
  return `${title[kind]} ${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

// ---- DSP building blocks ------------------------------------------------------------

class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  constructor(
    private type: "lp" | "hp" | "bp",
    freq: number,
    private q = 0.707,
  ) {
    this.set(freq);
  }
  set(freq: number): void {
    const f = clamp(freq, 10, SAMPLE_RATE * 0.45);
    const w0 = (2 * Math.PI * f) / SAMPLE_RATE;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * this.q);
    const a0 = 1 + alpha;
    if (this.type === "lp") [this.b0, this.b1, this.b2] = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2];
    else if (this.type === "hp") [this.b0, this.b1, this.b2] = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
    else [this.b0, this.b1, this.b2] = [alpha, 0, -alpha];
    this.b0 /= a0;
    this.b1 /= a0;
    this.b2 /= a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }
  next(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

function filterAll(type: "lp" | "hp" | "bp", freq: number, q: number, data: Float32Array): void {
  const f = new Biquad(type, freq, q);
  for (let i = 0; i < data.length; i++) data[i] = f.next(data[i]!);
}

const sat = (x: number, drive: number) => Math.tanh(drive * x) / Math.tanh(drive);
const samples = (sec: number) => Math.max(1, Math.round(sec * SAMPLE_RATE));
/** Exponential decay that reaches -60 dB after `decay` seconds. */
const env = (t: number, decay: number) => Math.exp((-6.9 * t) / decay);

/** One cycle of a band-limited saw (or square) for the given pitch: oscillators read it by phase. */
function table(freq: number, square = false): Float32Array {
  const size = 2048;
  const t = new Float32Array(size);
  const top = Math.max(1, Math.floor((SAMPLE_RATE * 0.45) / freq));
  for (let k = 1; k <= top; k += square ? 2 : 1) {
    const amp = 1 / k;
    for (let i = 0; i < size; i++) t[i]! += amp * Math.sin((2 * Math.PI * k * i) / size);
  }
  let peak = 0;
  for (const v of t) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < size; i++) t[i]! /= peak || 1;
  return t;
}
const readTable = (t: Float32Array, phase: number) => {
  const pos = (phase - Math.floor(phase)) * t.length;
  const i = Math.floor(pos);
  const frac = pos - i;
  return t[i]! * (1 - frac) + t[(i + 1) % t.length]! * frac;
};

// ---- recipes ------------------------------------------------------------------------

function renderKick(p: Params, rand: () => number): Float32Array {
  const out = new Float32Array(samples(Math.min(0.9, p.decay! * 1.4)));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    phase += (p.f1! + (p.f0! - p.f1!) * Math.exp(-t / p.pitchDecay!)) / SAMPLE_RATE;
    const click = t < 0.004 ? (rand() * 2 - 1) * p.click! * (1 - t / 0.004) : 0;
    out[i] = sat(Math.sin(2 * Math.PI * phase) * env(t, p.decay!) + click, p.drive!);
  }
  return out;
}

function render808(p: Params, rand: () => number): Float32Array {
  const f = freqOf(midiOf(p, "808"));
  const out = new Float32Array(samples(p.decay! * 1.15));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    phase += (f * (1 + p.glide! * Math.exp(-t / p.glideTime!))) / SAMPLE_RATE;
    const attack = Math.min(1, t / 0.002);
    const click = t < 0.003 ? (rand() * 2 - 1) * p.click! * (1 - t / 0.003) : 0;
    out[i] = sat(Math.sin(2 * Math.PI * phase) * env(t, p.decay!) * attack + click, p.drive!);
  }
  filterAll("lp", p.tone!, 0.707, out);
  return out;
}

function renderSnare(p: Params, rand: () => number): Float32Array {
  const len = samples(Math.max(p.noiseDecay!, p.bodyDecay!) * 1.3);
  const noise = new Float32Array(len);
  for (let i = 0; i < len; i++) noise[i] = (rand() * 2 - 1) * env(i / SAMPLE_RATE, p.noiseDecay!);
  filterAll("bp", p.noiseFreq!, 0.7, noise);
  const out = new Float32Array(len);
  let phase = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SAMPLE_RATE;
    phase += (p.body! * (1 + 0.5 * Math.exp(-t / 0.012))) / SAMPLE_RATE;
    out[i] = sat((1 - p.mix!) * Math.sin(2 * Math.PI * phase) * env(t, p.bodyDecay!) + p.mix! * noise[i]! * 2.2, p.drive!);
  }
  return out;
}

function renderClap(p: Params, rand: () => number): Float32Array {
  const len = samples(p.tail! * 1.25 + 0.05);
  const out = new Float32Array(len);
  const bursts = [0, p.spread!, p.spread! * 2, p.spread! * 3];
  for (let i = 0; i < len; i++) {
    const t = i / SAMPLE_RATE;
    let a = 0;
    for (const b of bursts) if (t >= b && t < b + 0.012) a = Math.max(a, env(t - b, 0.014));
    if (t >= bursts[3]!) a = Math.max(a, 0.85 * env(t - bursts[3]!, p.tail!));
    out[i] = (rand() * 2 - 1) * a;
  }
  filterAll("bp", p.freq!, p.q!, out);
  for (let i = 0; i < len; i++) out[i] = sat(out[i]! * 3, p.drive!);
  return out;
}

const HAT_RATIOS = [205.3, 304.4, 369.6, 522.7, 540, 800];
function renderHat(p: Params, rand: () => number): Float32Array {
  const out = new Float32Array(samples(p.decay! * 1.2 + 0.01));
  const phases = HAT_RATIOS.map(() => rand());
  for (let i = 0; i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    let s = 0;
    for (let k = 0; k < HAT_RATIOS.length; k++) {
      phases[k]! += (HAT_RATIOS[k]! * p.scale! * 4) / SAMPLE_RATE;
      s += Math.sin(2 * Math.PI * phases[k]!) >= 0 ? 1 : -1;
    }
    out[i] = (s / 6 * (1 - p.noise!) + (rand() * 2 - 1) * p.noise!) * env(t, p.decay!) * Math.min(1, t / 0.0005);
  }
  filterAll("hp", p.hp!, 0.9, out);
  filterAll("hp", p.hp!, 0.9, out);
  return out;
}

function renderBell(p: Params): Float32Array {
  const f = freqOf(midiOf(p, "bell"));
  const out = new Float32Array(samples(p.decay! * 1.1));
  for (let i = 0; i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    const mod = Math.sin(2 * Math.PI * f * p.ratio! * t) * p.index! * Math.exp(-t / p.indexDecay!);
    const main = Math.sin(2 * Math.PI * f * t + mod);
    const part = Math.sin(2 * Math.PI * f * 2.76 * t) * p.partial! * env(t, p.decay! * 0.5);
    out[i] = (main + part) * env(t, p.decay!) * Math.min(1, t / 0.001);
  }
  filterAll("lp", 9000, 0.707, out);
  return out;
}

function renderPluck(p: Params): Float32Array {
  const f = freqOf(midiOf(p, "pluck"));
  const cents = (c: number) => 2 ** (c / 1200);
  const tab = table(f);
  const out = new Float32Array(samples(p.decay! * 1.2));
  const lp = new Biquad("lp", p.cutoff0!, p.q!);
  let ph1 = 0;
  let ph2 = 0.37;
  let sub = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    ph1 += (f * cents(p.detune!)) / SAMPLE_RATE;
    ph2 += (f * cents(-p.detune!)) / SAMPLE_RATE;
    sub += f / 2 / SAMPLE_RATE;
    if (i % 32 === 0) lp.set(p.cutoff1! + (p.cutoff0! - p.cutoff1!) * Math.exp(-t / p.filterDecay!));
    const osc = (readTable(tab, ph1) + readTable(tab, ph2)) * 0.5 + Math.sin(2 * Math.PI * sub) * p.sub!;
    out[i] = lp.next(osc) * env(t, p.decay!) * Math.min(1, t / 0.002);
  }
  return out;
}

function renderKeys(p: Params): Float32Array {
  const f = freqOf(midiOf(p, "keys"));
  const out = new Float32Array(samples(p.decay! * 1.1));
  for (let i = 0; i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    const m1 = Math.sin(2 * Math.PI * f * t) * p.index1! * Math.exp(-t / p.index1Decay!);
    const m2 = Math.sin(2 * Math.PI * f * 14 * t) * p.index2! * Math.exp(-t / p.index2Decay!);
    out[i] = Math.sin(2 * Math.PI * f * t + m1 + m2) * env(t, p.decay!) * Math.min(1, t / 0.002);
  }
  filterAll("lp", 7500, 0.707, out);
  return out;
}

function renderPad(p: Params): Float32Array {
  const f = freqOf(midiOf(p, "pad"));
  const tab = table(f);
  const total = p.attack! + 1.6 + p.release!;
  const out = new Float32Array(samples(total));
  const voices = [-p.detune!, 0, p.detune!].map((c) => f * 2 ** (c / 1200));
  const phases = [0, 0.31, 0.67];
  const lp = new Biquad("lp", p.cutoff!, 0.9);
  for (let i = 0; i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    let s = 0;
    for (let v = 0; v < 3; v++) {
      phases[v]! += voices[v]! / SAMPLE_RATE;
      s += readTable(tab, phases[v]!);
    }
    const a = Math.min(1, t / p.attack!);
    const rel = t > total - p.release! ? Math.max(0, (total - t) / p.release!) : 1;
    if (i % 64 === 0) lp.set(p.cutoff! * (0.5 + 0.5 * a));
    out[i] = lp.next(s / 3) * a * rel;
  }
  return out;
}

function renderLead(p: Params): Float32Array {
  const f = freqOf(midiOf(p, "lead"));
  const saw = table(f);
  const sq = table(f, true);
  const out = new Float32Array(samples(1.5));
  const lp = new Biquad("lp", p.cutoff!, 1.2);
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    const vib = 1 + (2 ** ((p.vibrato! * Math.min(1, t / 0.15) * Math.sin(2 * Math.PI * 5.5 * t)) / 1200) - 1);
    phase += (f * vib) / SAMPLE_RATE;
    const osc = readTable(saw, phase) * (1 - p.mix!) + readTable(sq, phase) * p.mix!;
    const amp = 0.6 + 0.4 * Math.exp(-t / p.decay!);
    const rel = t > 1.35 ? Math.max(0, (1.5 - t) / 0.15) : 1;
    out[i] = lp.next(osc) * amp * rel * Math.min(1, t / 0.005);
  }
  return out;
}

// ---- finishing + encoding ---------------------------------------------------------------

/** Technical clean-up every sound gets: no DC, no click at the end, trailing silence trimmed, peak at -1 dBFS. */
function finish(data: Float32Array): Float32Array {
  for (let i = 0; i < data.length; i++) if (!Number.isFinite(data[i])) data[i] = 0;
  filterAll("hp", 12, 0.707, data);
  let end = data.length;
  const floor = 10 ** (-70 / 20);
  while (end > samples(0.1) && Math.abs(data[end - 1]!) < floor) end--;
  const out = data.slice(0, end);
  const fade = Math.min(out.length, samples(0.008));
  for (let i = 0; i < fade; i++) out[out.length - 1 - i]! *= i / fade;
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const gain = peak > 0 ? 10 ** (-1 / 20) / peak : 1;
  for (let i = 0; i < out.length; i++) out[i]! *= gain;
  return out;
}

export function renderSound(kind: SoundKind, rawParams: unknown, seed = 1): Float32Array {
  const p = cleanParams(kind, rawParams);
  const rand = rng(seed);
  const data =
    kind === "kick" ? renderKick(p, rand)
    : kind === "808" ? render808(p, rand)
    : kind === "snare" ? renderSnare(p, rand)
    : kind === "clap" ? renderClap(p, rand)
    : kind === "hat-closed" || kind === "hat-open" ? renderHat(p, rand)
    : kind === "bell" ? renderBell(p)
    : kind === "pluck" ? renderPluck(p)
    : kind === "keys" ? renderKeys(p)
    : kind === "pad" ? renderPad(p)
    : renderLead(p);
  return finish(data);
}

/** Mono WAV, 24-bit PCM at 44.1 kHz (what a producer expects from a sound kit). */
export function encodeWav24(data: Float32Array): Buffer {
  const bytes = data.length * 3;
  const buf = Buffer.alloc(44 + bytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + bytes, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 3, 28);
  buf.writeUInt16LE(3, 32);
  buf.writeUInt16LE(24, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(bytes, 40);
  for (let i = 0; i < data.length; i++) {
    const v = Math.round(clamp(data[i]!, -1, 1) * 8388607);
    buf.writeIntLE(v, 44 + i * 3, 3);
  }
  return buf;
}

export function durationSec(data: Float32Array): number {
  return Math.round((data.length / SAMPLE_RATE) * 1000) / 1000;
}
