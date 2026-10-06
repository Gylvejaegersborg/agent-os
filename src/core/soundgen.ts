// Procedural sound design: drums and melodic one-shots made from plain DSP (oscillators,
// FM, additive and Karplus-Strong synthesis, noise, envelopes, filters, saturation,
// chorus, reverb). Nothing is sampled from anyone else's audio, so everything it makes is
// the operator's own to sell.
//
// A sound is a RECIPE (the kind) plus PARAMETERS (numbers inside the recipe's ranges).
// Rendering is deterministic: the same kind + params + seed always give the same samples,
// so a candidate only needs its params stored, and the audio is rendered when it's played.
//
// ENGINE_VERSION changes whenever a recipe changes how it sounds, so sounds judged under an
// older engine are never silently re-rendered as something else (soundlab.ts hides them).
//
// What this can't do: judge how a sound feels. It guarantees the technical basics (no NaN,
// no clicks at the tail, peak at -1 dBFS, silence trimmed, melodic sounds tuned to C), and
// the operator's ears decide what is good; their accepted sounds steer the next batch.
//
// Version 3 (after the second round) ADDS builds without changing any old sound: every new param has a
// neutral default, `type` 0 is the old behaviour, and weights keep disliked old builds from being generated
// (they still render exactly as before; test-data/soundlab-v2-golden.json guards that). New: perc and
// strings kinds; kick/snare/clap/hat builds; natural plucks; a modelled piano with Rhodes, Wurlitzer and
// felt piano; ear-safe leads; bells with echo, shimmer, swell and auto-pan; 808s with dynamics.
//
// Version 2 (after the first listening round): 808s on C with a real tail and consistent
// timbre; kicks with a soft transient; fuller snares without hiss; varied claps; hats with
// body; melodic sounds in stereo with several architectures per kind, harmonic (in-tune)
// bells with a rolled-off top, no spring-like FM keys.

export const SAMPLE_RATE = 44100;
export const ENGINE_VERSION = 2;

export type SoundKind = "kick" | "808" | "snare" | "clap" | "perc" | "hat-closed" | "hat-open" | "bell" | "pluck" | "keys" | "pad" | "strings" | "lead";
export const SOUND_KINDS: SoundKind[] = ["808", "kick", "snare", "clap", "perc", "hat-closed", "hat-open", "bell", "pluck", "keys", "pad", "strings", "lead"];
export const MELODIC_KINDS = new Set<SoundKind>(["808", "bell", "pluck", "keys", "pad", "strings", "lead"]);

type Params = Record<string, number>;
interface Range {
  min: number;
  max: number;
  /** Integer-valued (octaves, architecture choices). */
  int?: boolean;
  /** Value when a stored sound doesn't have this param (it predates it): the neutral one, so the sound renders as it always did. */
  def?: number;
  /** For integers: how likely each value is to be drawn fresh (index 0 = min). 0 keeps a build from being generated while it still renders. */
  weights?: number[];
}

const r = (min: number, max: number, int = false, extra: { def?: number; weights?: number[] } = {}): Range => ({ min, max, ...(int ? { int: true } : {}), ...extra });
/** An architecture choice: 0 is the original build. */
const T = (max: number, weights?: number[]): Range => r(0, max, true, { def: 0, ...(weights ? { weights } : {}) });
/** A param that didn't exist before: neutral (`def`) for old sounds. */
const N = (min: number, max: number, def: number): Range => r(min, max, false, { def });

export const RECIPES: Record<SoundKind, Record<string, Range>> = {
  kick: { f0: r(100, 210), f1: r(38, 58), pitchDecay: r(0.02, 0.06), decay: r(0.12, 0.34), click: r(0, 0.25), clickTone: r(1500, 4000), drive: r(1, 2.8), type: T(5, [0, 1, 1, 1, 1, 1]), shell: N(0, 0.6, 0), air: N(0, 0.35, 0), crush: N(0, 1, 0) },
  "808": { octave: r(1, 2, true, { weights: [2, 1] }), glide: r(0.2, 1.2), glideTime: r(0.012, 0.05), decay: r(1.1, 3), punch: r(0.2, 0.65), punchDecay: r(0.1, 0.35), drive: r(1, 4.5), tone: r(500, 3000), harm: r(0, 0.35), click: r(0, 0.2), type: T(4), toneStart: N(1, 4, 1), toneTime: N(0.1, 1.2, 0.3), bloom: N(0, 0.5, 0), bloomTime: N(0.15, 0.5, 0.25), slide: N(-12, 12, 0), slideTime: N(0.08, 0.5, 0.2) },
  snare: { body: r(160, 230), bodyDecay: r(0.07, 0.18), noiseDecay: r(0.1, 0.26), noiseFreq: r(1400, 3600), noiseTop: r(5000, 9500), mix: r(0.25, 0.6), crack: r(0, 0.5), thump: r(0, 0.5), drive: r(1, 2.4), type: T(5), room: N(0, 0.4, 0) },
  clap: { bursts: r(3, 6, true), spread: r(0.005, 0.02), tail: r(0.1, 0.42), freq: r(700, 2800), q: r(0.6, 3.2), bright: r(4000, 11000), second: r(0, 0.5), room: r(0, 0.3), drive: r(1, 2.4), type: T(4, [0, 1, 1, 1, 1]) },
  perc: { type: r(0, 5, true, { def: 0 }), pitch: r(0, 1), decay: r(0.6, 1.5), tone: r(0, 1), drive: r(1, 2.2), room: r(0, 0.3) },
  "hat-closed": { scale: r(0.85, 1.35), hp: r(3500, 7500), peak: r(7000, 11000), decay: r(0.035, 0.11), noise: r(0.15, 0.55), body: r(0.05, 0.5), drive: r(1, 2), type: T(4, [0, 1, 1, 1, 1]) },
  "hat-open": { scale: r(0.85, 1.35), spread: r(0, 0.12), hp: r(3000, 7000), air: r(9000, 16000), decay: r(0.25, 0.8), swell: r(0.002, 0.014), noise: r(0.35, 0.85), type: T(4, [0, 1, 1, 1, 1]), rough: N(0, 0.6, 0) },
  bell: { type: T(4, [1, 0, 1.4, 1, 1]), octave: r(4, 5, true), ratioIdx: r(0, 3, true), index: r(0.6, 3.2), indexDecay: r(0.12, 0.6), decay: r(1.2, 3.4), tone: r(3200, 7000), chorus: r(0, 0.4), wet: r(0.12, 0.6), echo: N(0, 0.5, 0), echoTime: N(0.16, 0.42, 0.3), echoFb: N(0.25, 0.55, 0.4), shimmer: N(0, 0.5, 0), bswell: N(0, 0.25, 0), autopan: N(0, 0.6, 0) },
  pluck: { type: T(8, [0, 0, 0, 0, 1, 1, 1, 1, 1]), octave: r(3, 5, true), damp: r(0.8, 0.995), spread: r(4, 22), cutoff0: r(2200, 8000), cutoff1: r(250, 1000), filterDecay: r(0.08, 0.5), decay: r(0.4, 1.4), drive: r(1, 2.5), chorus: r(0, 0.5), wet: r(0.05, 0.35), body: N(0.2, 1, 0.5), pick: N(0, 0.8, 0.3), pos: N(0.1, 0.5, 0.25) },
  keys: { type: T(11, [0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1]), octave: r(2, 5, true), index: r(0.4, 1.6), indexDecay: r(0.3, 1.1), decay: r(1.2, 2.8), bright: r(0.2, 1), chorus: r(0, 0.6), wet: r(0.05, 0.3), drive: r(1, 2.5), tremolo: N(0, 0.4, 0), hammer: N(0, 0.6, 0.3), beat: N(0.2, 1, 0.5), strike: N(0.09, 0.25, 0.125) },
  pad: { type: r(0, 2, true), octave: r(3, 4, true), spread: r(6, 24), cutoff: r(700, 3200), attack: r(0.25, 0.9), hold: r(1.2, 5), release: r(1, 2), vowel: r(0, 1), chorus: r(0.2, 0.8), wet: r(0.25, 0.5) },
  strings: { type: T(4), chord: r(0, 3, true, { def: 0 }), octave: r(2, 4, true), attack: r(0.08, 0.7), hold: r(1.2, 2.8), release: r(0.8, 1.6), bright: r(0, 1), vibrato: r(3, 10), voices: r(3, 6, true), chorus: r(0.3, 0.8), wet: r(0.2, 0.5) },
  lead: { type: T(6, [0, 0, 0, 1, 1, 1, 1]), octave: r(4, 5, true), spread: r(5, 22), vibrato: r(0, 22), cutoff: r(2200, 5800), glideSemi: r(0, 2.5), decay: r(0.2, 0.7), wet: r(0.1, 0.35), drive: r(1, 2.6), soft: N(0.01, 0.12, 0.006) },
};

/** Params that pick an architecture: nudging a sound you liked should rarely switch it to a different one. */
const STICKY = new Set(["type"]);

const TYPE_NAMES: Partial<Record<SoundKind, string[]>> = {
  "808": ["", "Slide", "Dirty", "Bloom", "Stab"],
  kick: ["", "Thud", "Boom", "Acoustic", "Knock", "Lo-fi"],
  snare: ["", "Trap", "Rim", "Clap Snare", "Wash", "Lo-fi"],
  clap: ["", "Soft", "Smack", "Room", "Stack"],
  perc: ["Rim", "Tom", "Snap", "Shaker", "Cowbell", "Block"],
  "hat-closed": ["", "Clean", "Acoustic", "Crisp", "Lo-fi"],
  "hat-open": ["", "Clean", "Sizzle", "Wash", "Dark"],
  bell: ["Glass", "Music Box", "Chime", "Tubular", "Celesta"],
  pluck: ["String", "Saw", "Marimba", "Glass", "Nylon", "Harp", "Kalimba", "Pizzicato", "Oud"],
  keys: ["E-Piano", "Piano", "Organ", "Grand", "Rhodes", "Wurly", "Felt", "Honky", "Upright", "Lo-fi", "Mute", "Ambient"],
  pad: ["Strings", "Choir", "Glass"],
  strings: ["Legato", "Staccato", "Swell", "Tremolo", "Pizzicato"],
  lead: ["Super", "PWM", "Flute", "Soft", "Sine", "Hollow", "Dark Super"],
};
const CHORD_NAMES = ["", "Octave", "Minor", "Power"];

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

/** An integer in range, every value as likely as its weight says (a plain round() would halve the ends). */
function drawInt(range: Range, rand: () => number): number {
  const n = range.max - range.min + 1;
  const w = range.weights && range.weights.length === n ? range.weights : Array.from({ length: n }, () => 1);
  const total = w.reduce((a, b) => a + b, 0);
  let x = rand() * total;
  for (let i = 0; i < n; i++) {
    x -= w[i]!;
    if (x < 0) return range.min + i;
  }
  return range.max;
}

/** A fresh sound anywhere in the recipe's ranges. */
export function randomParams(kind: SoundKind, rand: () => number): Params {
  const out: Params = {};
  for (const [k, range] of Object.entries(RECIPES[kind])) out[k] = range.int ? drawInt(range, rand) : fit(range, range.min + rand() * (range.max - range.min));
  return out;
}

/** A neighbour of a sound the operator liked: every number nudged a little (about 12% of its range). */
export function mutateParams(kind: SoundKind, parent: Params, rand: () => number, amount = 0.12): Params {
  const gauss = () => (rand() + rand() + rand() + rand() - 2) * 1.7;
  const out: Params = {};
  for (const [k, range] of Object.entries(RECIPES[kind])) {
    // A param the parent doesn't have (it predates it) starts from its neutral value, so a nudge of an old sound stays that sound.
    const has = typeof parent[k] === "number";
    const base = has ? parent[k]! : (range.def ?? range.min + rand() * (range.max - range.min));
    if (range.int) {
      const resample = has && rand() < (STICKY.has(k) ? 0.08 : 0.35);
      out[k] = resample ? drawInt(range, rand) : fit(range, base);
    } else out[k] = has ? fit(range, base + gauss() * amount * (range.max - range.min)) : fit(range, base);
  }
  return out;
}

/** Keeps only known, numeric, in-range params (anything stored or posted is re-fitted before use). */
export function cleanParams(kind: SoundKind, raw: unknown): Params {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Params = {};
  for (const [k, range] of Object.entries(RECIPES[kind])) {
    const v = Number(src[k]);
    out[k] = Number.isFinite(v) && src[k] !== undefined && src[k] !== null ? fit(range, v) : fit(range, range.def ?? (range.min + range.max) / 2);
  }
  return out;
}

/** Everything melodic is tuned to C: only the octave varies. */
const freqC = (octave: number) => 440 * 2 ** ((12 * (octave + 1) - 69) / 12);

/** What a sound is called in the pack: "808 C1", "Slide 808 C1", "Glass Bell C5", "Cowbell", "Minor Strings C3". */
export function soundLabel(kind: SoundKind, params: Params): string {
  const title: Record<SoundKind, string> = { kick: "Kick", "808": "808", snare: "Snare", clap: "Clap", perc: "", "hat-closed": "Closed Hat", "hat-open": "Open Hat", bell: "Bell", pluck: "Pluck", keys: "Keys", pad: "Pad", strings: "Strings", lead: "Lead" };
  const type = TYPE_NAMES[kind]?.[params.type ?? 0] ?? "";
  if (kind === "808") return `${type} 808 C${params.octave}`.trim();
  if (kind === "strings") return `${type} Strings${CHORD_NAMES[params.chord ?? 0] ? " " + CHORD_NAMES[params.chord ?? 0] : ""} C${params.octave}`;
  if (!MELODIC_KINDS.has(kind)) return `${type} ${title[kind]}`.trim();
  return `${type} ${title[kind]} C${params.octave}`.trim();
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

function filterAll(type: "lp" | "hp" | "bp", freq: number, q: number, data: Float32Array): Float32Array {
  const f = new Biquad(type, freq, q);
  for (let i = 0; i < data.length; i++) data[i] = f.next(data[i]!);
  return data;
}

const sat = (x: number, drive: number) => Math.tanh(drive * x) / Math.tanh(drive);
const samples = (sec: number) => Math.max(1, Math.round(sec * SAMPLE_RATE));
/** Exponential decay that reaches -60 dB after `decay` seconds. */
const env = (t: number, decay: number) => Math.exp((-6.9 * t) / decay);
const cents = (c: number) => 2 ** (c / 1200);
const noise = (rand: () => number) => rand() * 2 - 1;

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

/** Two slightly modulated delay lines give a mono sound some width (and a little life). */
function chorus(x: Float32Array, mixAmt: number, rate = 0.6): Float32Array[] {
  if (mixAmt <= 0.001) return [x, x];
  const out = [new Float32Array(x.length), new Float32Array(x.length)];
  const base = 0.014 * SAMPLE_RATE;
  const depth = 0.0035 * SAMPLE_RATE;
  for (let ch = 0; ch < 2; ch++) {
    const phase = ch * Math.PI * 0.5;
    for (let i = 0; i < x.length; i++) {
      const d = base + depth * Math.sin((2 * Math.PI * rate * i) / SAMPLE_RATE + phase);
      const pos = i - d;
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const delayed = (x[i0] ?? 0) * (1 - frac) + (x[i0 + 1] ?? 0) * frac;
      out[ch]![i] = x[i]! * (1 - mixAmt * 0.5) + delayed * mixAmt * 0.7;
    }
  }
  return out;
}

/** A small stereo room (parallel damped combs into two allpasses). `wet` is how much of it you hear. */
function reverb(input: Float32Array[], wet: number, rt60: number): Float32Array[] {
  if (wet <= 0.001) return input.length === 2 ? input : [input[0]!, input[0]!];
  const inLen = input[0]!.length;
  const n = inLen + samples(Math.min(3.2, rt60 * 1.1));
  const mono = new Float32Array(n);
  for (let i = 0; i < inLen; i++) mono[i] = ((input[0]![i] ?? 0) + (input[1]?.[i] ?? input[0]![i] ?? 0)) / 2;
  const sets = [[29.7, 37.1, 41.1, 43.7], [30.9, 38.3, 42.7, 45.1]];
  const out: Float32Array[] = [];
  for (let ch = 0; ch < 2; ch++) {
    const combs = sets[ch]!.map((ms) => ({ buf: new Float32Array(samples(ms / 1000)), i: 0, last: 0, g: 10 ** ((-3 * (ms / 1000)) / rt60) }));
    const aps = [{ buf: new Float32Array(samples(0.005)), i: 0 }, { buf: new Float32Array(samples(0.0017)), i: 0 }];
    const o = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (const c of combs) {
        const y = c.buf[c.i]!;
        c.last = y * 0.7 + c.last * 0.3;
        c.buf[c.i] = mono[i]! + c.g * c.last;
        c.i = (c.i + 1) % c.buf.length;
        sum += y;
      }
      let v = sum * 0.25;
      for (const a of aps) {
        const bufOut = a.buf[a.i]!;
        const w = v + 0.5 * bufOut;
        a.buf[a.i] = w;
        v = bufOut - 0.5 * w;
        a.i = (a.i + 1) % a.buf.length;
      }
      o[i] = (i < inLen ? (input[ch]?.[i] ?? input[0]![i]!) : 0) + wet * 1.6 * v;
    }
    out.push(o);
  }
  return out;
}

/** The melodic finishing chain: warmth, tone, width and room. */
function space(mono: Float32Array, o: { drive?: number; tone?: number; chorus?: number; wet?: number; rt60?: number; chorusRate?: number }): Float32Array[] {
  if (o.drive && o.drive > 1) for (let i = 0; i < mono.length; i++) mono[i] = sat(mono[i]!, o.drive);
  if (o.tone) filterAll("lp", o.tone, 0.707, mono);
  return reverb(chorus(mono, o.chorus ?? 0, o.chorusRate), o.wet ?? 0, o.rt60 ?? 1.4);
}

// ---- drums --------------------------------------------------------------------------

function renderKick(p: Params, rand: () => number): Float32Array {
  const out = new Float32Array(samples(Math.min(0.6, p.decay! * 1.5)));
  const click = new Float32Array(samples(0.006));
  for (let i = 0; i < click.length; i++) click[i] = noise(rand) * (1 - i / click.length);
  filterAll("lp", p.clickTone!, 0.7, click);
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    phase += (p.f1! + (p.f0! - p.f1!) * Math.exp(-t / p.pitchDecay!)) / SAMPLE_RATE;
    out[i] = sat(Math.sin(2 * Math.PI * phase) * env(t, p.decay!) + (click[i] ?? 0) * p.click! * 2, p.drive!);
  }
  return out;
}

/** An 808: drive comes BEFORE the envelope, so the timbre stays the same as the note fades
 *  (distorting a fading signal makes the tone change over the tail), and the envelope has a
 *  punchy first stage and a long second one, so the tail is a real tail. */
function render808(p: Params, rand: () => number): Float32Array {
  const f = freqC(p.octave!);
  const out = new Float32Array(samples(p.decay! * 1.05 + 0.1));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    phase += (f * (1 + p.glide! * Math.exp(-t / p.glideTime!))) / SAMPLE_RATE;
    out[i] = sat(Math.sin(2 * Math.PI * phase) + p.harm! * Math.sin(4 * Math.PI * phase), p.drive!);
  }
  filterAll("lp", p.tone!, 0.707, out);
  const click = new Float32Array(samples(0.004));
  for (let i = 0; i < click.length; i++) click[i] = noise(rand) * (1 - i / click.length);
  filterAll("lp", 2200, 0.7, click);
  for (let i = 0; i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    const e = p.punch! * Math.exp(-t / p.punchDecay!) + (1 - p.punch!) * env(t, p.decay!);
    out[i] = out[i]! * e * Math.min(1, t / 0.003) + (click[i] ?? 0) * p.click!;
  }
  return out;
}

function renderSnare(p: Params, rand: () => number): Float32Array {
  const len = samples(Math.max(p.noiseDecay!, p.bodyDecay!) * 1.4 + 0.03);
  const n = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / SAMPLE_RATE;
    // A short crack on top of a longer rattle.
    n[i] = noise(rand) * (env(t, p.noiseDecay!) * (1 - p.crack! * 0.5) + p.crack! * env(t, 0.035));
  }
  filterAll("hp", 900, 0.707, n);
  filterAll("bp", p.noiseFreq!, 0.6, n);
  filterAll("lp", p.noiseTop!, 0.707, n);
  const out = new Float32Array(len);
  let ph1 = 0;
  let ph2 = 0;
  let ph3 = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SAMPLE_RATE;
    const drop = 1 + 0.45 * Math.exp(-t / 0.012);
    ph1 += (p.body! * drop) / SAMPLE_RATE;
    ph2 += (p.body! * 1.59 * drop) / SAMPLE_RATE;
    ph3 += (p.body! * 0.62) / SAMPLE_RATE;
    const tone = Math.sin(2 * Math.PI * ph1) * env(t, p.bodyDecay!) + 0.45 * Math.sin(2 * Math.PI * ph2) * env(t, p.bodyDecay! * 0.7) + p.thump! * Math.sin(2 * Math.PI * ph3) * env(t, 0.09);
    out[i] = sat((1 - p.mix!) * tone * 0.8 + p.mix! * n[i]! * 2.6, p.drive!);
  }
  return out;
}

function renderClap(p: Params, rand: () => number): Float32Array {
  const len = samples(p.tail! * 1.3 + p.spread! * p.bursts! + 0.04);
  const out = new Float32Array(len);
  const last = p.spread! * (p.bursts! - 1);
  const offsets = Array.from({ length: p.bursts! }, (_, b) => b * p.spread! * (0.8 + rand() * 0.4));
  for (let i = 0; i < len; i++) {
    const t = i / SAMPLE_RATE;
    let a = 0;
    for (const b of offsets) if (t >= b && t < b + 0.018) a = Math.max(a, env(t - b, 0.012));
    if (t >= last) a = Math.max(a, 0.8 * env(t - last, p.tail!));
    out[i] = noise(rand) * a;
  }
  const high = filterAll("bp", p.freq!, p.q!, out.slice());
  const second = filterAll("bp", Math.min(9000, p.freq! * 1.9), p.q! * 0.8, out.slice());
  for (let i = 0; i < len; i++) out[i] = high[i]! + p.second! * second[i]!;
  filterAll("hp", 350, 0.707, out);
  filterAll("lp", p.bright!, 0.707, out);
  for (let i = 0; i < len; i++) out[i] = sat(out[i]! * 3, p.drive!);
  return p.room! > 0.01 ? reverb([out], p.room!, 0.5)[0]! : out;
}

const HAT_RATIOS = [205.3, 304.4, 369.6, 522.7, 540, 800];
function metallic(len: number, scale: number, spread: number, rand: () => number): Float32Array {
  const out = new Float32Array(len);
  const phases = HAT_RATIOS.map(() => rand());
  const ratios = HAT_RATIOS.map((x) => x * scale * 4 * (1 + (rand() * 2 - 1) * spread));
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (let k = 0; k < ratios.length; k++) {
      phases[k]! += ratios[k]! / SAMPLE_RATE;
      s += Math.sin(2 * Math.PI * phases[k]!) >= 0 ? 1 : -1;
    }
    out[i] = s / ratios.length;
  }
  return out;
}

function renderHatClosed(p: Params, rand: () => number): Float32Array {
  const len = samples(p.decay! * 1.3 + 0.01);
  const metal = metallic(len, p.scale!, 0, rand);
  const air = new Float32Array(len);
  const body = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    air[i] = noise(rand);
    body[i] = noise(rand);
  }
  filterAll("bp", 3200, 0.8, body);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = (metal[i]! * (1 - p.noise!) + air[i]! * p.noise!) * 0.8 + body[i]! * p.body! * 2.2;
  filterAll("hp", p.hp!, 0.8, out);
  filterAll("bp", p.peak!, 0.9, (() => { const peakBand = out.slice(); return peakBand; })());
  // A resonant lift around `peak`: the band-passed copy added back (gives the hat its pitch-ish colour).
  const lift = filterAll("bp", p.peak!, 1.2, out.slice());
  for (let i = 0; i < len; i++) {
    const t = i / SAMPLE_RATE;
    out[i] = sat((out[i]! + lift[i]! * 0.7) * env(t, p.decay!) * Math.min(1, t / 0.0006), p.drive!);
  }
  return out;
}

function renderHatOpen(p: Params, rand: () => number): Float32Array {
  const len = samples(p.decay! * 1.25 + 0.02);
  const metal = metallic(len, p.scale!, p.spread!, rand);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = metal[i]! * (1 - p.noise!) + noise(rand) * p.noise!;
  filterAll("hp", p.hp!, 0.8, out);
  filterAll("lp", p.air!, 0.707, out);
  for (let i = 0; i < len; i++) {
    const t = i / SAMPLE_RATE;
    // A sizzle that swells in, holds, then lets go in two stages (a fast drop, then a long fade).
    const swell = Math.min(1, t / p.swell!);
    out[i] = out[i]! * swell * (0.65 * env(t, p.decay!) + 0.35 * env(t, p.decay! * 0.35));
  }
  return out;
}

// ---- melodic ------------------------------------------------------------------------

function bellVoice(p: Params, f: number, rand: () => number): Float32Array {
  const out = new Float32Array(samples(p.decay! * 1.05));
  if (p.type === 0) {
    // Glass bell: gentle FM with a whole-number ratio (so it stays in tune), plus a soft octave.
    const ratio = [1, 2, 3, 4][p.ratioIdx!]!;
    for (let i = 0; i < out.length; i++) {
      const t = i / SAMPLE_RATE;
      const mod = Math.sin(2 * Math.PI * f * ratio * t) * p.index! * Math.exp(-t / p.indexDecay!);
      out[i] = (Math.sin(2 * Math.PI * f * t + mod) + 0.22 * Math.sin(4 * Math.PI * f * t) * env(t, p.decay! * 0.5)) * env(t, p.decay!) * Math.min(1, t / 0.002);
    }
  } else if (p.type === 1) {
    // Music box: a few whole harmonics, the upper ones dying faster, and a small tick.
    const parts = [[1, 1, 1], [3, 0.32, 0.45], [5, 0.16, 0.28], [6, 0.1, 0.2]] as const;
    for (let i = 0; i < out.length; i++) {
      const t = i / SAMPLE_RATE;
      let s = 0;
      for (const [k, a, d] of parts) s += a * Math.sin(2 * Math.PI * f * k * t) * env(t, p.decay! * d);
      out[i] = s * Math.min(1, t / 0.0015) + (t < 0.004 ? noise(rand) * 0.12 * (1 - t / 0.004) : 0);
    }
  } else if (p.type === 2) {
    // Chime: a soft fundamental with low harmonics and a little shimmer.
    for (let i = 0; i < out.length; i++) {
      const t = i / SAMPLE_RATE;
      const shimmer = Math.sin(2 * Math.PI * f * t * 2) * 0.25 * Math.exp(-t / 0.3);
      out[i] = (Math.sin(2 * Math.PI * f * t + shimmer) + 0.35 * Math.sin(4 * Math.PI * f * t) * env(t, p.decay! * 0.6) + 0.12 * Math.sin(6 * Math.PI * f * t) * env(t, p.decay! * 0.35)) * env(t, p.decay!) * Math.min(1, t / 0.002);
    }
  } else if (p.type === 3) {
    // Tubular bell: a strike tone and whole harmonics, the upper ones fading first, a dull knock.
    const parts = [[1, 1], [2, 0.55], [3, 0.4], [4, 0.28], [5, 0.18], [6, 0.1]] as const;
    const knock = hardClick(rand, 5, 900);
    for (let i = 0; i < out.length; i++) {
      const t = i / SAMPLE_RATE;
      let sum = 0;
      for (const [k, a] of parts) sum += a * Math.sin(2 * Math.PI * f * k * t) * env(t, p.decay! / (1 + 0.6 * (k - 1)));
      out[i] = sum * Math.min(1, t / 0.002) + (knock[i] ?? 0) * 0.15;
    }
  } else {
    // Celesta: sweet and short, a soft fundamental with a bright, quickly fading overtone.
    for (let i = 0; i < out.length; i++) {
      const t = i / SAMPLE_RATE;
      out[i] = (Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(8 * Math.PI * f * t) * env(t, p.decay! * 0.25) + 0.12 * Math.sin(12 * Math.PI * f * t) * env(t, p.decay! * 0.15)) * env(t, p.decay! * 0.7) * Math.min(1, t / 0.002);
    }
  }
  return out;
}

function renderBell(p: Params, rand: () => number): Float32Array[] {
  const f = freqC(p.octave!);
  const out = bellVoice(p, f, rand);
  // Effects that were added later: all zero for a sound that predates them, so it renders as it always did.
  if (p.bswell! > 0) for (let i = 0; i < out.length; i++) out[i]! *= Math.min(1, i / SAMPLE_RATE / p.bswell!);
  if (p.shimmer! > 0) {
    const up = bellVoice(p, f * 2, rand);
    for (let i = 0; i < out.length; i++) out[i]! += (up[i] ?? 0) * p.shimmer! * 0.6 * Math.min(1, i / SAMPLE_RATE / 0.35);
  }
  // The top is rolled off twice: bright bells are what hurts.
  filterAll("lp", p.tone!, 0.707, out);
  filterAll("lp", p.tone! * 1.6, 0.707, out);
  let ch = space(out, { chorus: p.chorus, wet: p.wet, rt60: 1.8 });
  if (p.echo! > 0) ch = pingPong(ch, p.echoTime!, p.echoFb!, p.echo!);
  if (p.autopan! > 0) autoPan(ch, p.autopan!, 0.8);
  return ch;
}

/** Karplus-Strong string, tuned exactly (the loop's own delay is accounted for). */
function karplus(f: number, seconds: number, damp: number, bright: number, rand: () => number): Float32Array {
  const out = new Float32Array(samples(seconds));
  const target = SAMPLE_RATE / f - 0.5;
  let L = Math.floor(target);
  let d = target - L;
  if (d < 0.1) {
    L -= 1;
    d += 1;
  }
  const a = (1 - d) / (1 + d);
  const line = new Float32Array(L);
  let prev = 0;
  for (let i = 0; i < L; i++) {
    prev = prev * bright + noise(rand) * (1 - bright);
    line[i] = prev;
  }
  let ptr = 0;
  let last = 0;
  let apx = 0;
  let apy = 0;
  const loss = Math.exp(-6.9 / (f * seconds * 0.9));
  for (let i = 0; i < out.length; i++) {
    const v = line[ptr]!;
    const avg = damp * 0.5 * (v + last) * loss + (1 - damp) * v * loss;
    last = v;
    const y = a * avg + apx - a * apy;
    apx = avg;
    apy = y;
    line[ptr] = y;
    ptr = (ptr + 1) % L;
    out[i] = v;
  }
  return out;
}

function renderPluck(p: Params, rand: () => number): Float32Array[] {
  const f = freqC(p.octave!);
  const len = samples(p.decay! * 1.2);
  let out: Float32Array = new Float32Array(len);
  const lpEnv = (x: Float32Array, c0: number, c1: number, fd: number, q: number) => {
    const lp = new Biquad("lp", c0, q);
    for (let i = 0; i < x.length; i++) {
      if (i % 32 === 0) lp.set(c1 + (c0 - c1) * Math.exp(-(i / SAMPLE_RATE) / fd));
      x[i] = lp.next(x[i]!);
    }
  };
  if (p.type === 0) {
    out = karplus(f, p.decay! * 1.2, p.damp!, 0.35, rand);
    for (let i = 0; i < len; i++) out[i]! *= Math.min(1, i / SAMPLE_RATE / 0.001);
  } else if (p.type === 1) {
    const tab = table(f);
    const voices = [-1, -0.55, -0.2, 0, 0.2, 0.55, 1].map((x) => f * cents(x * p.spread!));
    const ph = voices.map(() => rand());
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let v = 0; v < voices.length; v++) {
        ph[v]! += voices[v]! / SAMPLE_RATE;
        s += readTable(tab, ph[v]!);
      }
      out[i] = (s / voices.length) * env(i / SAMPLE_RATE, p.decay!) * Math.min(1, i / SAMPLE_RATE / 0.002);
    }
    lpEnv(out, p.cutoff0!, p.cutoff1!, p.filterDecay!, 1.4);
  } else if (p.type === 2) {
    // Marimba-like FM: a hollow fourth-partial ring that fades almost at once.
    for (let i = 0; i < len; i++) {
      const t = i / SAMPLE_RATE;
      const m = Math.sin(2 * Math.PI * f * 4 * t) * 1.6 * Math.exp(-t / 0.045);
      out[i] = (Math.sin(2 * Math.PI * f * t + m) + 0.25 * Math.sin(2 * Math.PI * f * 2 * t) * env(t, 0.25)) * env(t, p.decay! * 0.7) * Math.min(1, t / 0.0015);
    }
    filterAll("lp", p.cutoff0! * 0.8, 0.707, out);
  } else {
    // Glass pluck: whole harmonics whose upper partials die quickly.
    for (let i = 0; i < len; i++) {
      const t = i / SAMPLE_RATE;
      let s = 0;
      for (let k = 1; k <= 6; k++) s += (Math.sin(2 * Math.PI * f * k * t) / k ** 1.1) * env(t, p.decay! / (1 + 0.9 * (k - 1)));
      out[i] = s * Math.min(1, t / 0.0015);
    }
  }
  return space(out, { drive: p.drive, chorus: p.chorus, wet: p.wet, rt60: 1.2 });
}

function renderKeys(p: Params, rand: () => number): Float32Array[] {
  const f = freqC(p.octave!);
  const len = samples(p.decay! * 1.1);
  const out = new Float32Array(len);
  if (p.type === 0) {
    // Electric piano: a 1:1 FM pair (soft, round), with a little bark from saturation.
    for (let i = 0; i < len; i++) {
      const t = i / SAMPLE_RATE;
      const m = Math.sin(2 * Math.PI * f * t) * p.index! * Math.exp(-t / p.indexDecay!);
      out[i] = Math.sin(2 * Math.PI * f * t + m) * env(t, p.decay!) * Math.min(1, t / 0.002);
    }
  } else if (p.type === 1) {
    // Soft piano: harmonics with their own decays (upper ones fade first), a touch of stretch, and a hammer thump.
    for (let i = 0; i < len; i++) {
      const t = i / SAMPLE_RATE;
      let s = 0;
      for (let k = 1; k <= 10; k++) {
        const stretch = k * Math.sqrt(1 + 0.0003 * k * k);
        s += (Math.sin(2 * Math.PI * f * stretch * t) / k ** (1.1 + (1 - p.bright!) * 0.8)) * env(t, p.decay! / (1 + 0.55 * (k - 1)));
      }
      out[i] = s * Math.min(1, t / 0.002) + (t < 0.008 ? noise(rand) * 0.08 * (1 - t / 0.008) : 0);
    }
    filterAll("lp", 1500 + p.bright! * 5000, 0.707, out);
  } else {
    // Organ: drawbars on whole harmonics, steady until a short release.
    const bars = [1, 2, 3, 4, 6, 8].map((k, n) => ({ k, a: (0.35 + rand() * 0.65) / (1 + n * 0.4) }));
    const total = Math.min(1.8, p.decay!);
    const o = new Float32Array(samples(total));
    for (let i = 0; i < o.length; i++) {
      const t = i / SAMPLE_RATE;
      let s = 0;
      for (const b of bars) s += b.a * Math.sin(2 * Math.PI * f * b.k * t);
      o[i] = s * Math.min(1, t / 0.006) * (t > total - 0.15 ? Math.max(0, (total - t) / 0.15) : 1);
    }
    return space(filterAll("lp", 2500 + p.bright! * 4000, 0.707, o), { drive: p.drive, chorus: Math.max(0.3, p.chorus!), chorusRate: 6, wet: p.wet, rt60: 1.2 });
  }
  return space(out, { drive: p.drive, chorus: p.chorus, wet: p.wet, rt60: 1.4 });
}

function renderPad(p: Params, rand: () => number): Float32Array[] {
  const f = freqC(p.octave!);
  const total = p.attack! + p.hold! + p.release!;
  const len = samples(total);
  const out = new Float32Array(len);
  const amp = (t: number) => Math.min(1, t / p.attack!) * (t > total - p.release! ? Math.max(0, (total - t) / p.release!) : 1);
  if (p.type === 0) {
    // Strings: a stack of detuned saws under a slowly opening filter.
    const tab = table(f);
    const detunes = [-1, -0.6, -0.25, 0, 0.25, 0.6, 1].map((x) => f * cents(x * p.spread!));
    const ph = detunes.map(() => rand());
    const lp = new Biquad("lp", p.cutoff!, 0.8);
    for (let i = 0; i < len; i++) {
      const t = i / SAMPLE_RATE;
      let s = 0;
      for (let v = 0; v < detunes.length; v++) {
        ph[v]! += detunes[v]! / SAMPLE_RATE;
        s += readTable(tab, ph[v]!);
      }
      if (i % 64 === 0) lp.set(p.cutoff! * (0.45 + 0.55 * Math.min(1, t / (p.attack! + 0.5))));
      out[i] = lp.next(s / detunes.length) * amp(t);
    }
  } else if (p.type === 1) {
    // Choir: saws through vowel formants (an "ah" to "oo" blend) with a breath of noise.
    const tab = table(f);
    const ph = [rand(), rand(), rand()];
    const dets = [-p.spread!, 0, p.spread!].map((c) => f * cents(c));
    const v = p.vowel!;
    const form = [
      [800 + (350 - 800) * v, 1],
      [1150 + (600 - 1150) * v, 0.5],
      [2900 + (2700 - 2900) * v, 0.25],
    ] as const;
    const src = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let k = 0; k < 3; k++) {
        ph[k]! += (dets[k]! * (1 + 0.0025 * Math.sin((2 * Math.PI * 5 * i) / SAMPLE_RATE))) / SAMPLE_RATE;
        s += readTable(tab, ph[k]!);
      }
      src[i] = s / 3 + noise(rand) * 0.06;
    }
    for (const [fc, g] of form) {
      const band = filterAll("bp", fc, 7, src.slice());
      for (let i = 0; i < len; i++) out[i]! += band[i]! * g * 4;
    }
    for (let i = 0; i < len; i++) out[i]! *= amp(i / SAMPLE_RATE);
  } else {
    // Glass: odd harmonics that each breathe slowly, so it shimmers without any detune.
    const rates = [0.31, 0.47, 0.62, 0.83, 1.05].map((x) => x + rand() * 0.2);
    const phases = rates.map(() => rand() * 6.28);
    for (let i = 0; i < len; i++) {
      const t = i / SAMPLE_RATE;
      let s = 0;
      for (let h = 0; h < 5; h++) {
        const k = 2 * h + 1;
        s += (Math.sin(2 * Math.PI * f * k * t) / k) * (0.6 + 0.4 * Math.sin(2 * Math.PI * rates[h]! * t + phases[h]!));
      }
      out[i] = s * amp(t);
    }
    filterAll("lp", p.cutoff! + 1500, 0.707, out);
  }
  return space(out, { chorus: p.chorus, wet: p.wet, rt60: 2.4, chorusRate: 0.35 });
}

function renderLead(p: Params, rand: () => number): Float32Array[] {
  const f = freqC(p.octave!);
  const len = samples(1.5);
  const out = new Float32Array(len);
  const rel = (t: number) => (t > 1.35 ? Math.max(0, (1.5 - t) / 0.15) : 1);
  const amp = (t: number) => (0.62 + 0.38 * Math.exp(-t / p.decay!)) * rel(t) * Math.min(1, t / 0.006);
  const pitch = (t: number) => 2 ** (-(p.glideSemi! * Math.exp(-t / 0.05)) / 12) * cents(p.vibrato! * Math.min(1, t / 0.2) * Math.sin(2 * Math.PI * 5.4 * t));
  if (p.type === 0) {
    const tab = table(f);
    const detunes = [-1, -0.55, -0.2, 0, 0.2, 0.55, 1].map((x) => cents(x * p.spread!));
    const ph = detunes.map(() => rand());
    for (let i = 0; i < len; i++) {
      const t = i / SAMPLE_RATE;
      let s = 0;
      for (let v = 0; v < detunes.length; v++) {
        ph[v]! += (f * detunes[v]! * pitch(t)) / SAMPLE_RATE;
        s += readTable(tab, ph[v]!);
      }
      out[i] = (s / detunes.length) * amp(t);
    }
    filterAll("lp", p.cutoff!, 1.1, out);
  } else if (p.type === 1) {
    const saw = table(f);
    let ph = 0;
    for (let i = 0; i < len; i++) {
      const t = i / SAMPLE_RATE;
      ph += (f * pitch(t)) / SAMPLE_RATE;
      const w = 0.5 + 0.34 * Math.sin(2 * Math.PI * 0.7 * t);
      out[i] = (readTable(saw, ph) - readTable(saw, ph + w)) * amp(t);
    }
    filterAll("lp", p.cutoff!, 1.1, out);
  } else {
    // Flute-ish: a nearly pure tone with a breath of band-passed noise riding on it.
    let ph = 0;
    const breath = new Float32Array(len);
    for (let i = 0; i < len; i++) breath[i] = noise(rand);
    filterAll("bp", f * 2, 2.5, breath);
    for (let i = 0; i < len; i++) {
      const t = i / SAMPLE_RATE;
      ph += (f * pitch(t)) / SAMPLE_RATE;
      out[i] = (Math.sin(2 * Math.PI * ph) + 0.2 * Math.sin(4 * Math.PI * ph) + 0.07 * Math.sin(6 * Math.PI * ph) + breath[i]! * 0.5 * Math.min(1, t / 0.05)) * amp(t);
    }
    filterAll("lp", p.cutoff! * 0.8, 0.707, out);
  }
  return space(out, { drive: p.drive, wet: p.wet, rt60: 1.6, chorus: p.type === 2 ? 0.1 : 0.25 });
}

// ---- v3 builds ------------------------------------------------------------------------
// New architectures added after the second listening round. The original builds above are untouched
// (and still render exactly as before); a sound only reaches these through its `type` or its new params.

const hardClick = (rand: () => number, ms: number, lowpass: number): Float32Array => {
  const c = new Float32Array(samples(ms / 1000));
  for (let i = 0; i < c.length; i++) c[i] = noise(rand) * (1 - i / c.length);
  return filterAll("lp", lowpass, 0.7, c);
};

/** Bit-depth and sample-rate reduction: the dusty, lo-fi edge. */
function crush(x: Float32Array, amount: number): void {
  if (amount <= 0.001) return;
  const levels = 2 ** (11 - Math.round(amount * 6));
  const hold = 1 + Math.round(amount * 3);
  let held = 0;
  for (let i = 0; i < x.length; i++) {
    if (i % hold === 0) held = Math.round(x[i]! * levels) / levels;
    x[i] = held;
  }
}

function addBand(x: Float32Array, freq: number, q: number, gain: number): void {
  const band = filterAll("bp", freq, q, x.slice());
  for (let i = 0; i < x.length; i++) x[i]! += band[i]! * gain;
}

/** Six squares as true sine sums: band-limited by construction, so no aliasing (the cheap-hat fix). */
function cleanMetal(len: number, scale: number, spread: number, rand: () => number, maxHz: number): Float32Array {
  const out = new Float32Array(len);
  const bases = HAT_RATIOS.map((x) => x * scale * 4 * (1 + (rand() * 2 - 1) * spread));
  for (const f of bases) {
    const ph = rand();
    for (let k = 1; k * f < maxHz; k += 2) {
      const a = 1 / k;
      const w = (2 * Math.PI * k * f) / SAMPLE_RATE;
      const p0 = 2 * Math.PI * k * ph;
      for (let i = 0; i < len; i++) out[i]! += a * Math.sin(w * i + p0);
    }
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < len; i++) out[i]! /= peak || 1;
  return out;
}

function renderKick3(p: Params, rand: () => number): Float32Array {
  const t = p.type!;
  const cfg =
    t === 1 ? { f0: p.f0! * 0.55, f1: p.f1! * 0.95, pd: p.pitchDecay! * 1.2, decay: p.decay! * 0.9, drive: Math.min(p.drive!, 2) }
    : t === 2 ? { f0: p.f0! * 0.4, f1: p.f1! * 0.85, pd: p.pitchDecay! * 1.5, decay: p.decay! * 1.5, drive: Math.min(p.drive!, 1.8) }
    : t === 3 ? { f0: p.f0! * 0.6, f1: p.f1! * 1.7, pd: p.pitchDecay! * 0.9, decay: p.decay! * 0.8, drive: 1 + (p.drive! - 1) * 0.4 }
    : t === 4 ? { f0: p.f0! * 0.8, f1: p.f1! * 1.2, pd: p.pitchDecay! * 0.8, decay: p.decay! * 0.75, drive: p.drive! * 2 }
    : { f0: p.f0! * 0.55, f1: p.f1! * 1.1, pd: p.pitchDecay! * 1.1, decay: p.decay! * 1.0, drive: p.drive! };
  const out = new Float32Array(samples(Math.min(0.75, cfg.decay * 1.5 + 0.02)));
  const click = hardClick(rand, 6, t === 3 ? 3500 : p.clickTone!);
  let ph = 0;
  let ph2 = 0;
  for (let i = 0; i < out.length; i++) {
    const time = i / SAMPLE_RATE;
    ph += (cfg.f1 + (cfg.f0 - cfg.f1) * Math.exp(-time / cfg.pd)) / SAMPLE_RATE;
    let s = Math.sin(2 * Math.PI * ph) * env(time, cfg.decay);
    if (t === 2) s += 0.12 * Math.sin(6 * Math.PI * ph) * env(time, cfg.decay);
    if (t === 3) {
      ph2 += (p.f0! * 1.3) / SAMPLE_RATE; // the skin
      s = s * 0.8 + Math.sin(2 * Math.PI * ph2) * env(time, 0.06) * (0.35 + p.shell!);
    } else s += Math.sin(2 * Math.PI * ph * 2) * env(time, cfg.decay * 0.4) * p.shell! * 0.6;
    out[i] = sat(s + (click[i] ?? 0) * (t === 3 ? 0.55 + p.click! : p.click! * 1.4), cfg.drive);
  }
  if (t === 3) {
    const air = new Float32Array(out.length);
    for (let i = 0; i < air.length; i++) air[i] = noise(rand) * env(i / SAMPLE_RATE, 0.12);
    filterAll("lp", 700, 0.7, air);
    for (let i = 0; i < out.length; i++) out[i]! += air[i]! * (0.15 + p.air!);
  }
  if (t === 4) filterAll("lp", 1800, 0.8, out);
  if (t === 2) filterAll("lp", 420, 0.7, out);
  if (t === 5) {
    filterAll("lp", 3200, 0.8, out);
    crush(out, 0.35 + p.crush! * 0.65);
  } else crush(out, p.crush! * 0.5);
  return out;
}

function renderSnare3(p: Params, rand: () => number): Float32Array {
  const t = p.type!;
  if (t === 2) {
    // Side stick: two short woody tones and a tick.
    const len = samples(0.16);
    const out = new Float32Array(len);
    const f1 = 420 + (p.body! - 160) * 4;
    const f2 = f1 * 3.4;
    for (let i = 0; i < len; i++) {
      const time = i / SAMPLE_RATE;
      out[i] = Math.sin(2 * Math.PI * f1 * time) * env(time, 0.035) + 0.5 * Math.sin(2 * Math.PI * f2 * time) * env(time, 0.018) + noise(rand) * 0.4 * env(time, 0.008);
    }
    filterAll("bp", 2200, 0.5, out);
    for (let i = 0; i < len; i++) out[i] = sat(out[i]! * 2, p.drive!);
    return p.room! > 0.02 ? reverb([out], p.room! * 0.8, 0.45)[0]! : out;
  }
  const trap = t === 1;
  const wash = t === 4;
  const noiseDecay = wash ? p.noiseDecay! * 2.4 : trap ? p.noiseDecay! * 0.55 : p.noiseDecay!;
  const bodyDecay = trap ? p.bodyDecay! * 0.55 : p.bodyDecay!;
  const body = trap ? p.body! * 1.35 : p.body!;
  const len = samples(Math.max(noiseDecay, bodyDecay) * 1.4 + 0.03);
  const n = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const time = i / SAMPLE_RATE;
    n[i] = noise(rand) * (env(time, noiseDecay) * (1 - p.crack! * 0.5) + p.crack! * env(time, trap ? 0.02 : 0.035));
  }
  filterAll("hp", trap ? 1500 : 900, 0.707, n);
  filterAll("bp", trap ? p.noiseFreq! * 1.25 : p.noiseFreq!, wash ? 0.4 : 0.6, n);
  filterAll("lp", t === 5 ? 4500 : p.noiseTop!, 0.707, n);
  const out = new Float32Array(len);
  let ph1 = 0;
  let ph2 = 0;
  let ph3 = 0;
  for (let i = 0; i < len; i++) {
    const time = i / SAMPLE_RATE;
    const drop = 1 + 0.45 * Math.exp(-time / 0.012);
    ph1 += (body * drop) / SAMPLE_RATE;
    ph2 += (body * 1.59 * drop) / SAMPLE_RATE;
    ph3 += (body * 0.62) / SAMPLE_RATE;
    const tone = Math.sin(2 * Math.PI * ph1) * env(time, bodyDecay) + 0.45 * Math.sin(2 * Math.PI * ph2) * env(time, bodyDecay * 0.7) + p.thump! * Math.sin(2 * Math.PI * ph3) * env(time, 0.09);
    const mix = wash ? Math.min(0.85, p.mix! + 0.2) : p.mix!;
    out[i] = sat((1 - mix) * tone * 0.8 + mix * n[i]! * 2.6, wash ? 1 + (p.drive! - 1) * 0.4 : p.drive!);
  }
  if (t === 3) {
    // Clap stacked on the snare.
    const c = renderClap({ ...cleanParams("clap", {}), bursts: 3, spread: 0.011, tail: 0.14, freq: 1500, q: 1.1, bright: 8000, second: 0.3, room: 0, drive: 1.2 }, rand);
    for (let i = 0; i < out.length && i < c.length; i++) out[i]! += c[i]! * 0.7;
  }
  if (t === 5) {
    filterAll("lp", 5200, 0.7, out);
    crush(out, 0.3 + p.room! * 0.5);
  }
  if (p.room! > 0.02 && t !== 5) {
    const wet = reverb([out], p.room! * (wash ? 1.4 : 1), wash ? 1.0 : 0.5)[0]!;
    // Gated: the room is cut off instead of fading, the old-school way.
    if (wash) {
      const gate = samples(0.34);
      for (let i = gate; i < wet.length; i++) wet[i]! *= Math.max(0, 1 - (i - gate) / samples(0.03));
    }
    return wet;
  }
  return out;
}

function renderClap3(p: Params, rand: () => number): Float32Array {
  const t = p.type!;
  const smack = t === 2 || t === 4;
  const spread = smack ? 0.004 : 0.012 + p.spread! * 1.4;
  const count = smack ? 1 : t === 3 ? 3 : 3;
  const tail = smack ? p.tail! * 0.55 + 0.05 : p.tail!;
  const len = samples(tail * 1.35 + spread * 4 + 0.05);
  const out = new Float32Array(len);
  const gains = Array.from({ length: count }, (_, i) => (i === 0 ? 1 : 0.35 + rand() * 0.45));
  for (let i = 0; i < len; i++) {
    const time = i / SAMPLE_RATE;
    let a = 0;
    for (let b = 0; b < count; b++) {
      const at = time - b * spread * (0.85 + (b % 2) * 0.3);
      // Each burst is a soft swell and decay, so the hits blur into one clap instead of ticking.
      if (at >= 0) a = Math.max(a, gains[b]! * Math.min(1, at / 0.0015) * env(at, smack ? 0.02 : 0.035));
    }
    const end = spread * (count - 1);
    if (time >= end) a = Math.max(a, (smack ? 0.45 : 0.7) * env(time - end, tail));
    out[i] = noise(rand) * a;
  }
  const mid = filterAll("bp", p.freq!, smack ? 0.9 : Math.min(1.6, p.q!), out.slice());
  const top = filterAll("bp", Math.min(9000, p.freq! * 2.1), 0.8, out.slice());
  for (let i = 0; i < len; i++) out[i] = mid[i]! + p.second! * (t === 4 ? 1.3 : 0.7) * top[i]!;
  filterAll("hp", smack ? 500 : 380, 0.707, out);
  filterAll("lp", Math.min(p.bright!, 9500), 0.707, out);
  if (smack) {
    const snap = hardClick(rand, 5, 6000);
    for (let i = 0; i < snap.length && i < len; i++) out[i]! += snap[i]! * 0.5;
  }
  for (let i = 0; i < len; i++) out[i] = sat(out[i]! * 2.4, 1 + (p.drive! - 1) * 0.6);
  const room = t === 3 ? 0.35 + p.room! : t === 4 ? 0.12 + p.room! * 0.5 : p.room!;
  return room > 0.02 ? reverb([out], room, t === 3 ? 1.1 : 0.55)[0]! : out;
}

function renderPerc(p: Params, rand: () => number): Float32Array {
  const t = p.type!;
  const d = p.decay!;
  let out: Float32Array;
  if (t === 0) {
    // Rim: two damped tones and a tick.
    out = new Float32Array(samples(0.2 * d));
    const f1 = 420 + p.pitch! * 520;
    const f2 = 1500 + p.pitch! * 900;
    for (let i = 0; i < out.length; i++) {
      const time = i / SAMPLE_RATE;
      out[i] = Math.sin(2 * Math.PI * f1 * time) * env(time, 0.03 * d) + 0.6 * Math.sin(2 * Math.PI * f2 * time) * env(time, 0.018 * d) + noise(rand) * 0.35 * env(time, 0.006);
    }
    filterAll("bp", 1800 + p.tone! * 1500, 0.6, out);
  } else if (t === 1) {
    // Tom: a sine that falls into its note, with a stick tick.
    out = new Float32Array(samples(0.55 * d));
    const f = 85 + p.pitch! * 150;
    let ph = 0;
    const tick = hardClick(rand, 5, 2400);
    for (let i = 0; i < out.length; i++) {
      const time = i / SAMPLE_RATE;
      ph += (f * (1 + 0.7 * Math.exp(-time / 0.05))) / SAMPLE_RATE;
      out[i] = Math.sin(2 * Math.PI * ph) * env(time, 0.4 * d) + (tick[i] ?? 0) * 0.5 + 0.2 * Math.sin(2 * Math.PI * ph * 1.5) * env(time, 0.12 * d);
    }
  } else if (t === 2) {
    // Finger snap: a noise burst and a short resonant ping.
    out = new Float32Array(samples(0.16 * d));
    const ping = 1100 + p.pitch! * 700;
    for (let i = 0; i < out.length; i++) {
      const time = i / SAMPLE_RATE;
      out[i] = noise(rand) * env(time, 0.02) + 0.7 * Math.sin(2 * Math.PI * ping * time) * env(time, 0.05 * d);
    }
    filterAll("bp", 2200 + p.tone! * 1300, 1.8, out);
  } else if (t === 3) {
    // Shaker: a soft rise and fall of band-passed noise.
    out = new Float32Array(samples(0.2 * d));
    for (let i = 0; i < out.length; i++) {
      const time = i / SAMPLE_RATE;
      out[i] = noise(rand) * Math.min(1, time / 0.025) * env(time, 0.13 * d);
    }
    filterAll("bp", 5200 + p.tone! * 3800, 0.7, out);
    filterAll("hp", 3000, 0.707, out);
  } else if (t === 4) {
    // Cowbell: two band-limited squares, a quick knock and a ringing body.
    out = new Float32Array(samples(0.55 * d));
    const s = 0.8 + p.pitch! * 0.6;
    for (const base of [540 * s, 800 * s]) {
      for (let k = 1; k * base < 6500; k += 2) {
        for (let i = 0; i < out.length; i++) out[i]! += (Math.sin((2 * Math.PI * k * base * i) / SAMPLE_RATE) / k) * (0.6 * env(i / SAMPLE_RATE, 0.05) + 0.4 * env(i / SAMPLE_RATE, 0.35 * d));
      }
    }
    filterAll("bp", 900 + p.tone! * 700, 0.9, out);
  } else {
    // Wood block: a hollow tone with a click.
    out = new Float32Array(samples(0.15 * d));
    const f = 800 + p.pitch! * 1200;
    for (let i = 0; i < out.length; i++) {
      const time = i / SAMPLE_RATE;
      out[i] = Math.sin(2 * Math.PI * f * time) * env(time, 0.05 * d) + 0.25 * Math.sin(2 * Math.PI * f * 2.4 * time) * env(time, 0.025) + noise(rand) * 0.2 * env(time, 0.005);
    }
    filterAll("bp", f, 1.2, out);
  }
  for (let i = 0; i < out.length; i++) out[i] = sat(out[i]! * 1.6, p.drive!);
  return p.room! > 0.03 ? reverb([out], p.room!, 0.5)[0]! : out;
}

function renderHatClosed3(p: Params, rand: () => number): Float32Array {
  const t = p.type!;
  const dec = t === 3 ? p.decay! * 0.45 : t === 4 ? p.decay! * 1.2 : p.decay!;
  const len = samples(dec * 1.3 + 0.012);
  const air = new Float32Array(len);
  for (let i = 0; i < len; i++) air[i] = noise(rand);
  let out: Float32Array;
  if (t === 2) {
    // Acoustic: filtered noise with a tiny chick at the front.
    out = air;
    filterAll("hp", 3800, 0.8, out);
    addBand(out, p.peak!, 0.9, 0.8);
    filterAll("lp", 14000, 0.707, out);
    for (let i = 0; i < Math.min(len, samples(0.0015)); i++) out[i]! *= 1.8;
  } else {
    const metal = cleanMetal(len, p.scale! * (t === 3 ? 1.15 : 1), 0.03, rand, t === 3 ? 16000 : 14000);
    const mixNoise = t === 1 ? p.noise! * 0.6 : 0.5;
    out = new Float32Array(len);
    for (let i = 0; i < len; i++) out[i] = metal[i]! * (1 - mixNoise) + air[i]! * mixNoise;
    filterAll("hp", t === 3 ? Math.max(p.hp!, 6500) : p.hp! * 0.9, 0.8, out);
    addBand(out, p.peak!, 1.2, 0.6);
    if (t === 4) {
      filterAll("lp", 7000, 0.707, out);
      crush(out, 0.2);
    }
  }
  const tick = filterAll("bp", 3200, 0.8, air.slice());
  for (let i = 0; i < len; i++) {
    const time = i / SAMPLE_RATE;
    out[i] = sat((out[i]! + tick[i]! * p.body! * 1.2) * (0.7 * env(time, dec) + 0.3 * env(time, dec * 0.35)) * Math.min(1, time / 0.0005), t === 4 ? 1 + p.drive! * 0.5 : p.drive!);
  }
  return out;
}

function renderHatOpen3(p: Params, rand: () => number): Float32Array {
  const t = p.type!;
  const dec = t === 3 ? Math.min(1.2, p.decay! * 1.5) : t === 4 ? p.decay! * 0.8 : t === 2 ? p.decay! * 1.3 : p.decay!;
  const len = samples(dec * 1.25 + 0.04);
  const air = new Float32Array(len);
  for (let i = 0; i < len; i++) air[i] = noise(rand);
  const out = new Float32Array(len);
  if (t === 2) {
    // Sizzle: noise shimmering at a cymbal-ish rate.
    const rate = 30 + p.rough! * 40;
    for (let i = 0; i < len; i++) out[i] = air[i]! * (1 - p.rough! * 0.7 + p.rough! * 0.7 * (0.5 + 0.5 * Math.sin((2 * Math.PI * rate * i) / SAMPLE_RATE)));
    filterAll("hp", 4500, 0.8, out);
    addBand(out, 9000, 0.9, 0.5);
  } else {
    const metal = cleanMetal(len, p.scale!, p.spread!, rand, 15000);
    const nz = t === 3 ? Math.max(0.65, p.noise!) : t === 4 ? 0.45 : p.noise! * 0.8;
    for (let i = 0; i < len; i++) out[i] = metal[i]! * (1 - nz) + air[i]! * nz;
    filterAll("hp", t === 4 ? 2200 : t === 3 ? 2800 : p.hp!, 0.8, out);
  }
  filterAll("lp", t === 4 ? 6500 : t === 3 ? 11000 : p.air!, 0.707, out);
  const attack = t === 3 ? 0.025 + p.swell! * 4 : p.swell!;
  for (let i = 0; i < len; i++) {
    const time = i / SAMPLE_RATE;
    out[i] = out[i]! * Math.min(1, time / attack) * (0.65 * env(time, dec) + 0.35 * env(time, dec * 0.35));
    if (t === 4) out[i] = sat(out[i]! * 2, 1.6);
  }
  return out;
}

/** An 808 with dynamics: its tone opens and closes, the body can swell back after the punch, and it can slide between notes. */
function render808v3(p: Params, rand: () => number): Float32Array {
  const t = p.type!;
  const f = freqC(p.octave!);
  const decay = t === 4 ? p.decay! * 0.45 : p.decay!;
  const punch = t === 4 ? Math.min(0.8, p.punch! + 0.2) : p.punch!;
  const bloom = t === 3 ? Math.max(0.28, p.bloom!) : t === 1 || t === 4 ? 0 : p.bloom!;
  const slide = t === 1 ? (Math.abs(p.slide!) < 4 ? (p.slide! < 0 ? -4 : 4) : p.slide!) : 0;
  const drive = t === 2 ? p.drive! * 1.7 + 1 : p.drive!;
  const out = new Float32Array(samples(decay * 1.05 + 0.1));
  const lp = new Biquad("lp", p.tone! * p.toneStart!, 0.707);
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const time = i / SAMPLE_RATE;
    const inst = f * (1 + p.glide! * Math.exp(-time / p.glideTime!)) * 2 ** ((slide * Math.exp(-time / p.slideTime!)) / 12);
    phase += inst / SAMPLE_RATE;
    let x = Math.sin(2 * Math.PI * phase) + p.harm! * Math.sin(4 * Math.PI * phase);
    if (t === 2) x += 0.22 * Math.sin(6 * Math.PI * phase);
    x = sat(x, drive);
    if (i % 32 === 0) lp.set(p.tone! * (1 + (p.toneStart! - 1) * Math.exp(-time / p.toneTime!)));
    out[i] = lp.next(x);
  }
  const click = hardClick(rand, 4, 2200);
  for (let i = 0; i < out.length; i++) {
    const time = i / SAMPLE_RATE;
    const body = env(time, decay);
    const e = punch * Math.exp(-time / p.punchDecay!) + (1 - punch) * body + bloom * Math.exp(-(((time - p.bloomTime!) / 0.1) ** 2)) * body;
    out[i] = out[i]! * e * Math.min(1, time / 0.003) + (click[i] ?? 0) * p.click!;
  }
  return out;
}

// ---- natural plucks ---------------------------------------------------------------------

/** Karplus-Strong with a pick position (a comb on the excitation) and a bright/dark choice. */
function karplus2(f: number, seconds: number, damp: number, bright: number, pos: number, rand: () => number): Float32Array {
  const out = new Float32Array(samples(seconds));
  const target = SAMPLE_RATE / f - 0.5;
  let L = Math.floor(target);
  let d = target - L;
  if (d < 0.1) {
    L -= 1;
    d += 1;
  }
  const a = (1 - d) / (1 + d);
  const n = new Float32Array(L);
  for (let i = 0; i < L; i++) n[i] = noise(rand);
  const shift = Math.max(1, Math.round(pos * L));
  const line = new Float32Array(L);
  let prev = 0;
  for (let i = 0; i < L; i++) {
    prev = prev * bright + (n[i]! - n[(i + shift) % L]!) * 0.7 * (1 - bright);
    line[i] = prev;
  }
  let ptr = 0;
  let last = 0;
  let apx = 0;
  let apy = 0;
  const loss = Math.exp(-6.9 / (f * seconds * 0.9));
  for (let i = 0; i < out.length; i++) {
    const v = line[ptr]!;
    const avg = (damp * 0.5 * (v + last) + (1 - damp) * v) * loss;
    last = v;
    const y = a * avg + apx - a * apy;
    apx = avg;
    apy = y;
    line[ptr] = y;
    ptr = (ptr + 1) % L;
    out[i] = v;
  }
  return out;
}

function renderPluckNatural(p: Params, rand: () => number): Float32Array[] {
  const t = p.type!;
  const f = freqC(p.octave!);
  let sig: Float32Array;
  if (t === 6) {
    // Kalimba: a clear tine and a quick overtone, a thumb tap, a resonant box.
    sig = new Float32Array(samples(p.decay! * 1.8));
    const thumb = hardClick(rand, 6, 1500);
    for (let i = 0; i < sig.length; i++) {
      const time = i / SAMPLE_RATE;
      sig[i] = (Math.sin(2 * Math.PI * f * time) * env(time, p.decay! * 1.5) + 0.22 * Math.sin(2 * Math.PI * f * 6 * time) * env(time, 0.09) + 0.1 * Math.sin(4 * Math.PI * f * time) * env(time, 0.4)) * Math.min(1, time / 0.001) + (thumb[i] ?? 0) * p.pick! * 0.6;
    }
    addBand(sig, 420, 3, 0.35 * p.body!);
  } else {
    const cfg =
      t === 5 ? { dur: p.decay! * 2.6, damp: 0.3, bright: 0.45, pos: 0.18, body: 0.5, pick: 0.15 }
      : t === 7 ? { dur: 0.25 + p.decay! * 0.4, damp: 0.78, bright: 0.6, pos: p.pos!, body: 1.1, pick: 0.5 }
      : t === 8 ? { dur: p.decay! * 1.6, damp: 0.45, bright: 0.7, pos: 0.12, body: 1.3, pick: 1 }
      : { dur: p.decay! * 1.8 + 0.2, damp: 0.6, bright: 0.55, pos: p.pos!, body: 1, pick: 0.7 };
    sig = karplus2(f, cfg.dur, cfg.damp, cfg.bright, cfg.pos, rand);
    const pickNoise = hardClick(rand, 3, 5000);
    for (let i = 0; i < pickNoise.length && i < sig.length; i++) sig[i]! += pickNoise[i]! * p.pick! * cfg.pick * 0.5;
    // The wooden body: low resonances that make a string sound like an instrument.
    const body = new Float32Array(sig.length);
    for (const [fc, g] of [[98, 0.5], [196, 0.38], [392, 0.26], [785, 0.15]] as const) {
      const band = filterAll("bp", fc, 5, sig.slice());
      for (let i = 0; i < sig.length; i++) body[i]! += band[i]! * g;
    }
    for (let i = 0; i < sig.length; i++) sig[i]! += body[i]! * 2.2 * p.body! * cfg.body;
  }
  filterAll("lp", 7000, 0.707, sig);
  return space(sig, { chorus: p.chorus! * 0.4, wet: p.wet!, rt60: 1.4 });
}

// ---- keys ---------------------------------------------------------------------------------

/** A piano from its physics: stretched partials, two strings per note that beat, a hammer
 *  that skips some partials, upper partials that die first, a thump at the front. */
function pianoModel(f: number, dur: number, bright: number, hammer: number, beat: number, soft: boolean, rand: () => number, strike = 0.125): Float32Array[] {
  const len = samples(dur);
  const L = new Float32Array(len);
  const R = new Float32Array(len);
  const B = 0.00006 * (f / 65) ** 1.3;
  const K = Math.min(18, Math.floor(9000 / f));
  for (let k = 1; k <= K; k++) {
    const fk = k * f * Math.sqrt(1 + B * k * k);
    const amp = Math.abs(Math.sin(Math.PI * k * strike)) / k ** (soft ? 1.7 : 1.1 + (1 - bright) * 0.9);
    const tau = dur / (1.1 + 0.55 * (k - 1));
    const b = beat * (0.25 + 0.45 * rand());
    const w1 = (2 * Math.PI * (fk - b / 2)) / SAMPLE_RATE;
    const w2 = (2 * Math.PI * (fk + b / 2)) / SAMPLE_RATE;
    const p1 = rand() * 6.28;
    const p2 = rand() * 6.28;
    for (let i = 0; i < len; i++) {
      const time = i / SAMPLE_RATE;
      const e = amp * (0.7 * Math.exp(-time / tau) + 0.3 * Math.exp(-time / (tau * 3.2)));
      const v1 = Math.sin(w1 * i + p1);
      const v2 = Math.sin(w2 * i + p2);
      L[i]! += e * (v1 * 0.68 + v2 * 0.32);
      R[i]! += e * (v1 * 0.32 + v2 * 0.68);
    }
  }
  const thump = hardClick(rand, 9, 1600);
  for (let i = 0; i < len; i++) {
    const a = Math.min(1, i / SAMPLE_RATE / 0.002);
    const th = (thump[i] ?? 0) * hammer * 0.5;
    L[i] = L[i]! * a + th;
    R[i] = R[i]! * a + th;
  }
  const cut = soft ? 1300 + bright * 1400 : 3500 + bright * 5000;
  filterAll("lp", cut, 0.707, L);
  filterAll("lp", cut, 0.707, R);
  return [L, R];
}

/** The same physics as pianoModel, with the things that make one piano sound unlike another turned into options:
 *  how many strings and how far apart they sit, where the hammer strikes, how fast the highs die, the felt, the room,
 *  tape wobble and hiss. (pianoModel itself is left alone so sounds already made don't change.) */
interface PianoOpts {
  dur: number;
  bright: number;
  exp: number;
  strike: number;
  strings: 2 | 3;
  /** Beat frequency between strings, in Hz. */
  beat: number;
  cut: number;
  attack: number;
  thump: number;
  thumpCut: number;
  /** Tape wobble depth in cents (0 = none). */
  wow: number;
  hiss: number;
  crush: number;
  decayLift: number;
  /** Share of the slow second stage of the decay (0 = it just dies away, as a muted string does). */
  slow: number;
}

function pianoModel2(f: number, o: PianoOpts, rand: () => number): Float32Array[] {
  const len = samples(o.dur);
  const L = new Float32Array(len);
  const R = new Float32Array(len);
  const B = 0.00006 * (f / 65) ** 1.3;
  const K = Math.min(18, Math.floor(9000 / f));
  const pm = new Float32Array(len).fill(1);
  if (o.wow > 0) {
    const r1 = 0.45 + rand() * 0.3;
    const r2 = 5 + rand() * 2;
    for (let i = 0; i < len; i++) pm[i] = cents(o.wow * (Math.sin((2 * Math.PI * r1 * i) / SAMPLE_RATE) + 0.25 * Math.sin((2 * Math.PI * r2 * i) / SAMPLE_RATE)));
  }
  const pans = o.strings === 3 ? [[0.8, 0.2], [0.5, 0.5], [0.2, 0.8]] : [[0.68, 0.32], [0.32, 0.68]];
  for (let k = 1; k <= K; k++) {
    const fk = k * f * Math.sqrt(1 + B * k * k);
    const amp = Math.abs(Math.sin(Math.PI * k * o.strike)) / k ** o.exp;
    const tau = o.dur / (1.1 + o.decayLift * (k - 1));
    for (let s = 0; s < o.strings; s++) {
      const off = (s - (o.strings - 1) / 2) * o.beat * (0.25 + 0.45 * rand());
      const w = (2 * Math.PI * (fk + off)) / SAMPLE_RATE;
      let ph = rand() * 6.28;
      const [pl, pr] = pans[s]!;
      for (let i = 0; i < len; i++) {
        const t = i / SAMPLE_RATE;
        ph += w * pm[i]!;
        const e = (amp / o.strings) * ((1 - o.slow) * Math.exp(-t / tau) + o.slow * Math.exp(-t / (tau * 3.2)));
        const v = Math.sin(ph) * e;
        L[i]! += v * pl! * 2;
        R[i]! += v * pr! * 2;
      }
    }
  }
  const thump = hardClick(rand, 9, o.thumpCut);
  const hiss = new Float32Array(len);
  if (o.hiss > 0) {
    for (let i = 0; i < len; i++) hiss[i] = noise(rand);
    filterAll("bp", 5200, 0.7, hiss);
  }
  for (let i = 0; i < len; i++) {
    const a = Math.min(1, i / SAMPLE_RATE / o.attack);
    const th = (thump[i] ?? 0) * o.thump * 0.5;
    const hs = hiss[i]! * o.hiss * 0.05 * Math.min(1, i / SAMPLE_RATE / 0.05);
    L[i] = L[i]! * a + th + hs;
    R[i] = R[i]! * a + th + hs;
  }
  filterAll("lp", o.cut, 0.707, L);
  filterAll("lp", o.cut, 0.707, R);
  if (o.crush > 0) {
    crush(L, o.crush);
    crush(R, o.crush);
  }
  return [L, R];
}

function renderKeys3(p: Params, rand: () => number): Float32Array[] {
  const t = p.type!;
  const f = freqC(p.octave!);
  let ch: Float32Array[];
  if (t === 3 || t === 6) {
    ch = pianoModel(f, t === 6 ? 1.6 + p.decay! * 0.8 : 2.4 + p.decay! * 1.4, p.bright!, p.hammer!, p.beat!, t === 6, rand, p.strike!);
  } else if (t >= 7) {
    // The rest of the piano family: each is a different instrument, not the same piano with other numbers.
    const base: PianoOpts = { dur: 2.4, bright: p.bright!, exp: 1.2, strike: p.strike!, strings: 2, beat: p.beat! * 1.5, cut: 3500 + p.bright! * 4500, attack: 0.002, thump: p.hammer!, thumpCut: 1600, wow: 0, hiss: 0, crush: 0, decayLift: 0.55, slow: 0.3 };
    const o: PianoOpts =
      t === 7 ? { ...base, dur: 1.6 + p.decay! * 0.5, exp: 0.9, strings: 3, beat: 2.5 + p.beat! * 3, cut: 6000 + p.bright! * 3000, strike: Math.min(p.strike!, 0.12), decayLift: 0.8 }
      : t === 8 ? { ...base, dur: 1.4 + p.decay! * 0.7, exp: 1.45, cut: 2800 + p.bright! * 1700, thump: p.hammer! * 1.6 + 0.2, thumpCut: 900, decayLift: 0.7 }
      : t === 9 ? { ...base, dur: 1.5 + p.decay! * 0.6, exp: 1.6, cut: 1500 + p.bright! * 1100, wow: 7 + p.tremolo! * 25, hiss: 0.5 + p.hammer!, crush: 0.15 + p.tremolo! * 0.4 }
      : t === 10 ? { ...base, dur: 0.6 + p.decay! * 0.18, slow: 0.03, exp: 2.1, cut: 900 + p.bright! * 700, attack: 0.004, thump: p.hammer! * 1.3 + 0.2, thumpCut: 700, decayLift: 1.4 }
      : { ...base, dur: 4.5 + p.decay! * 1.8, exp: 1.3, strings: 3, beat: p.beat! * 0.8, cut: 2500 + p.bright! * 2500, attack: 0.09 + p.hammer! * 0.4, thump: 0.05, decayLift: 0.3 };
    ch = pianoModel2(f, o, rand);
    const room = t === 11 ? Math.min(0.7, 0.4 + p.wet!) : t === 7 ? p.wet! * 0.4 : t === 10 ? p.wet! * 0.3 : t === 9 ? p.wet! * 0.6 : p.wet! * 0.8;
    return reverb(ch, room, t === 11 ? 3.0 : t === 8 ? 0.9 : 1.2);
  } else {
    // Rhodes (4) and Wurlitzer (5): a few soft partials, a short tine, a thump, some bark, a tremolo.
    const dur = p.decay! * (t === 5 ? 0.75 : 1.15);
    const len = samples(dur);
    const mono = new Float32Array(len);
    const parts = t === 5 ? [[1, 1], [2, 0.45], [3, 0.2], [4, 0.08]] : [[1, 1], [2, 0.16], [3, 0.06], [4, 0.025]];
    const thump = hardClick(rand, 12, 500);
    for (let i = 0; i < len; i++) {
      const time = i / SAMPLE_RATE;
      let s = 0;
      for (const [k, a] of parts) s += a! * Math.sin(2 * Math.PI * f * k! * time) * env(time, dur / (1 + (t === 5 ? 0.6 : 0.9) * (k! - 1)));
      if (t === 4) s += 0.18 * p.hammer! * Math.sin(2 * Math.PI * f * 6 * time) * env(time, 0.05);
      mono[i] = s * Math.min(1, time / 0.002) + (thump[i] ?? 0) * p.hammer! * 0.3;
    }
    if (t === 5) for (let i = 0; i < len; i++) mono[i] = mono[i]! + 0.4 * mono[i]! * mono[i]!;
    for (let i = 0; i < len; i++) mono[i] = sat(mono[i]! * 1.2, 1 + (p.drive! - 1) * 0.6);
    filterAll("lp", t === 5 ? 2400 + p.bright! * 1400 : 1800 + p.bright! * 3200, 0.707, mono);
    const depth = Math.max(0.08, p.tremolo!);
    ch = [new Float32Array(len), new Float32Array(len)];
    for (let i = 0; i < len; i++) {
      const lfo = Math.sin((2 * Math.PI * 5.2 * i) / SAMPLE_RATE);
      ch[0]![i] = mono[i]! * (1 + depth * lfo);
      ch[1]![i] = mono[i]! * (1 - depth * lfo);
    }
  }
  return reverb(ch, p.wet! * 0.8, 1.2);
}

// ---- leads: soft and ear-safe --------------------------------------------------------------

function renderLead3(p: Params, rand: () => number): Float32Array[] {
  const t = p.type!;
  const f = freqC(p.octave!);
  const len = samples(1.5);
  const out = new Float32Array(len);
  const rel = (time: number) => (time > 1.35 ? Math.max(0, (1.5 - time) / 0.15) : 1);
  const amp = (time: number) => Math.min(1, time / p.soft!) * (0.72 + 0.28 * Math.exp(-time / p.decay!)) * rel(time);
  const pitch = (time: number) => cents(p.vibrato! * 0.6 * Math.min(1, time / 0.3) * Math.sin(2 * Math.PI * 5.2 * time)) * 2 ** (-(p.glideSemi! * 0.5 * Math.exp(-time / 0.06)) / 12);
  const cut = p.cutoff! * 0.38;
  if (t === 4) {
    let ph = 0;
    for (let i = 0; i < len; i++) {
      const time = i / SAMPLE_RATE;
      ph += (f * pitch(time)) / SAMPLE_RATE;
      out[i] = (Math.sin(2 * Math.PI * ph) + 0.12 * Math.sin(4 * Math.PI * ph) + 0.05 * Math.sin(6 * Math.PI * ph)) * amp(time);
    }
  } else if (t === 5) {
    const sq = table(f, true);
    let ph = 0;
    for (let i = 0; i < len; i++) {
      const time = i / SAMPLE_RATE;
      ph += (f * pitch(time)) / SAMPLE_RATE;
      out[i] = readTable(sq, ph) * amp(time);
    }
    filterAll("lp", cut * 1.2, 0.6, out);
  } else {
    const saw = table(f);
    const voices = t === 6 ? [-1, -0.55, -0.2, 0, 0.2, 0.55, 1] : [-0.3, 0.3];
    const dets = voices.map((x) => cents(x * p.spread!));
    const ph = dets.map(() => rand());
    let sub = 0;
    for (let i = 0; i < len; i++) {
      const time = i / SAMPLE_RATE;
      let s = 0;
      for (let v = 0; v < dets.length; v++) {
        ph[v]! += (f * dets[v]! * pitch(time)) / SAMPLE_RATE;
        s += readTable(saw, ph[v]!);
      }
      sub += (f / 2) / SAMPLE_RATE;
      out[i] = (s / dets.length + (t === 3 ? 0.35 * Math.sin(2 * Math.PI * sub) : 0)) * amp(time);
    }
    filterAll("lp", t === 6 ? cut * 0.9 : cut, 0.6, out);
  }
  // Nothing piercing: a final roll-off no matter what the knobs say.
  filterAll("lp", 5200, 0.6, out);
  return space(out, { drive: Math.min(p.drive!, 1.4), wet: p.wet!, rt60: 1.6, chorus: t === 4 ? 0.12 : 0.25 });
}

// ---- strings ------------------------------------------------------------------------------

const CHORDS = [[0], [0, 12], [0, 3, 7], [0, 7]];

function renderStrings(p: Params, rand: () => number): Float32Array[] {
  const t = p.type!;
  const base = freqC(p.octave!);
  const attack = t === 1 ? 0.03 : t === 2 ? 0.9 + p.attack! : t === 4 ? 0.002 : p.attack!;
  const hold = t === 1 ? 0.12 : t === 2 ? 0.7 : t === 4 ? 0.1 : p.hold!;
  const release = t === 1 ? 0.35 : t === 4 ? 0.7 : p.release!;
  const total = attack + hold + release;
  const len = samples(total);
  const out = new Float32Array(len);
  const amp = (time: number) => {
    if (t === 4) return env(time, 0.55);
    return Math.min(1, time / attack) * (time > total - release ? Math.max(0, (total - time) / release) : 1);
  };
  const cut = 1200 + p.bright! * 3300;
  for (const semis of CHORDS[p.chord!]!) {
    const f = base * 2 ** (semis / 12);
    if (t === 4) {
      // Pizzicato section: plucked strings, three to a note.
      for (let v = 0; v < 3; v++) {
        const s = karplus2(f * cents((rand() * 2 - 1) * 6), total, 0.7, 0.55, 0.15, rand);
        for (let i = 0; i < len; i++) out[i]! += (s[i] ?? 0) * 0.5;
      }
      continue;
    }
    const tab = table(f);
    const voices = Array.from({ length: p.voices! }, () => ({ det: cents((rand() * 2 - 1) * 12), ph: rand(), vr: 4.6 + rand() * 1.4, vp: rand() * 6.28, vd: p.vibrato! * (0.5 + rand() * 0.8) }));
    const lp = new Biquad("lp", cut, 0.6);
    const lfo = 9 + rand() * 3;
    for (let i = 0; i < len; i++) {
      const time = i / SAMPLE_RATE;
      let s = 0;
      for (const v of voices) {
        v.ph += (f * v.det * cents(v.vd * Math.min(1, Math.max(0, (time - 0.2) / 0.5)) * Math.sin(2 * Math.PI * v.vr * time + v.vp))) / SAMPLE_RATE;
        s += readTable(tab, v.ph);
      }
      out[i]! += lp.next(s / voices.length) * (t === 3 ? 0.55 + 0.45 * Math.sin(2 * Math.PI * lfo * time) ** 2 : 1);
    }
  }
  // A body: the wooden resonances that make a bowed section sound like strings and not a synth.
  const body = new Float32Array(len);
  for (const [fc, g] of [[300, 0.35], [520, 0.3], [1250, 0.2]] as const) {
    const band = filterAll("bp", fc, 2.5, out.slice());
    for (let i = 0; i < len; i++) body[i]! += band[i]! * g;
  }
  // Bow noise at the start of each note.
  const bow = new Float32Array(len);
  for (let i = 0; i < len; i++) bow[i] = noise(rand);
  filterAll("bp", 3000, 1.2, bow);
  for (let i = 0; i < len; i++) {
    const time = i / SAMPLE_RATE;
    out[i] = (out[i]! + body[i]! + bow[i]! * 0.025 * Math.min(1, time / attack) * (t === 4 ? 0 : 1)) * amp(time);
  }
  filterAll("lp", 6000, 0.6, out);
  return space(out, { chorus: p.chorus!, wet: p.wet!, rt60: 2.2, chorusRate: 0.4 });
}

// ---- bell effects ---------------------------------------------------------------------------

/** Echoes that bounce left and right: the first on the left, the next on the right, and so on. */
function pingPong(ch: Float32Array[], time: number, feedback: number, amount: number): Float32Array[] {
  const d = samples(time);
  const n = ch[0]!.length + Math.min(samples(2.2), d * 5);
  const tapL = new Float32Array(n);
  const tapR = new Float32Array(n);
  const inL = (i: number) => ch[0]![i] ?? 0;
  const inR = (i: number) => ch[1]![i] ?? 0;
  for (let i = d; i < n; i++) {
    tapL[i] = amount * 0.9 * inL(i - d) + feedback * tapR[i - d]!;
    tapR[i] = amount * 0.6 * inR(i - d) + feedback * tapL[i - d]!;
  }
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = inL(i) + tapL[i]!;
    R[i] = inR(i) + tapR[i]!;
  }
  return [L, R];
}

function autoPan(ch: Float32Array[], depth: number, rate: number): void {
  for (let i = 0; i < ch[0]!.length; i++) {
    const lfo = Math.sin((2 * Math.PI * rate * i) / SAMPLE_RATE);
    ch[0]![i]! *= 1 - depth * (0.5 + 0.5 * lfo);
    ch[1]![i]! *= 1 - depth * (0.5 - 0.5 * lfo);
  }
}

// ---- finishing + encoding ---------------------------------------------------------------

/** Technical clean-up every sound gets: no DC, no click at the end, trailing silence trimmed, peak at -1 dBFS. */
function finish(channels: Float32Array[]): Float32Array[] {
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) if (!Number.isFinite(ch[i])) ch[i] = 0;
    filterAll("hp", 12, 0.707, ch);
  }
  const floor = 10 ** (-70 / 20);
  const len = Math.min(...channels.map((c) => c.length));
  let end = len;
  while (end > samples(0.1) && channels.every((c) => Math.abs(c[end - 1]!) < floor)) end--;
  const out = channels.map((c) => c.slice(0, end));
  const fade = Math.min(end, samples(0.008));
  for (const ch of out) for (let i = 0; i < fade; i++) ch[end - 1 - i]! *= i / fade;
  let peak = 0;
  for (const ch of out) for (const v of ch) peak = Math.max(peak, Math.abs(v));
  const gain = peak > 0 ? 10 ** (-1 / 20) / peak : 1;
  for (const ch of out) for (let i = 0; i < end; i++) ch[i]! *= gain;
  return out;
}

/** The sound as 1 (drums, 808) or 2 (melodic) channels. */
export function renderSound(kind: SoundKind, rawParams: unknown, seed = 1): Float32Array[] {
  const p = cleanParams(kind, rawParams);
  const rand = rng(seed);
  const t = p.type ?? 0;
  const made: Float32Array | Float32Array[] =
    kind === "kick" ? (t === 0 ? renderKick(p, rand) : renderKick3(p, rand))
    : kind === "808" ? (t === 0 && p.toneStart === 1 && p.bloom === 0 ? render808(p, rand) : render808v3(p, rand))
    : kind === "snare" ? (t === 0 ? renderSnare(p, rand) : renderSnare3(p, rand))
    : kind === "clap" ? (t === 0 ? renderClap(p, rand) : renderClap3(p, rand))
    : kind === "perc" ? renderPerc(p, rand)
    : kind === "hat-closed" ? (t === 0 ? renderHatClosed(p, rand) : renderHatClosed3(p, rand))
    : kind === "hat-open" ? (t === 0 ? renderHatOpen(p, rand) : renderHatOpen3(p, rand))
    : kind === "bell" ? renderBell(p, rand)
    : kind === "pluck" ? (t >= 4 ? renderPluckNatural(p, rand) : renderPluck(p, rand))
    : kind === "keys" ? (t >= 3 ? renderKeys3(p, rand) : renderKeys(p, rand))
    : kind === "pad" ? renderPad(p, rand)
    : kind === "strings" ? renderStrings(p, rand)
    : t >= 3 ? renderLead3(p, rand)
    : renderLead(p, rand);
  return finish(Array.isArray(made) ? made : [made]);
}

/** 24-bit PCM WAV at 44.1 kHz, mono or stereo (what a producer expects from a sound kit). */
export function encodeWav24(channels: Float32Array[]): Buffer {
  const n = channels.length;
  const frames = channels[0]!.length;
  const bytes = frames * n * 3;
  const buf = Buffer.alloc(44 + bytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + bytes, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(n, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 3 * n, 28);
  buf.writeUInt16LE(3 * n, 32);
  buf.writeUInt16LE(24, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(bytes, 40);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < n; c++) buf.writeIntLE(Math.round(clamp(channels[c]![i]!, -1, 1) * 8388607), 44 + (i * n + c) * 3, 3);
  }
  return buf;
}

export function durationSec(channels: Float32Array[]): number {
  return Math.round((channels[0]!.length / SAMPLE_RATE) * 1000) / 1000;
}
