// Audio editing for agents: the practical part of what Audacity does, done with
// ffmpeg (AGENT_OS_FFMPEG, default "ffmpeg" on PATH). No GUI, no app to install
// beyond ffmpeg, and nothing is sent anywhere.
//
//   info   duration, format, peak and average level, integrated loudness (LUFS)
//   edit   input → a NEW file: trim, reverse, speed, pitch, EQ filters, gain,
//          peak-normalize, limiter, fades, in one pass
//
// The original is never touched: the output must be a new path with a supported
// extension. ffmpeg is started with an argument array (no shell), so a path or a
// parameter can't become a command. Callers sandbox-check both paths first.
//
// Honest limits: pitch and speed use ffmpeg's plain resampler/atempo, which is fine
// for a rough edit or a demo but not mastering-grade. It hears numbers, not music:
// "sounds good" is the operator's call.

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

export const OUTPUT_TYPES = ["wav", "mp3", "flac", "ogg", "m4a"] as const;
const INPUT_TYPES = new Set(["wav", "mp3", "flac", "ogg", "oga", "opus", "m4a", "aac", "aif", "aiff"]);
const TIMEOUT_MS = 5 * 60_000;

export class AudioError extends Error {}

function run(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.AGENT_OS_FFMPEG ?? "ffmpeg", ["-hide_banner", "-nostdin", ...args], { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr = (stderr + d.toString()).slice(-200_000);
    });
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new AudioError(`Couldn't start ffmpeg (${(err as Error).message}). Install it or set AGENT_OS_FFMPEG.`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stderr });
    });
  });
}

const num = (v: unknown, name: string, min: number, max: number): number | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new AudioError(`${name} must be a number from ${min} to ${max}.`);
  return n;
};

async function checkInput(input: string): Promise<void> {
  const ext = path.extname(input).slice(1).toLowerCase();
  if (!INPUT_TYPES.has(ext)) throw new AudioError(`.${ext || "?"} isn't a supported audio type.`);
  const s = await stat(input).catch(() => undefined);
  if (!s?.isFile()) throw new AudioError(`No audio file at ${input}.`);
}

export interface AudioInfo {
  durationSec?: number;
  sampleRate?: number;
  channels?: string;
  meanDb?: number;
  peakDb?: number;
  loudnessLufs?: number;
  loudnessRange?: number;
  truePeakDbfs?: number;
}

const grab = (text: string, re: RegExp): number | undefined => {
  const m = re.exec(text);
  return m ? Number(m[1]) : undefined;
};

export async function audioInfo(input: string): Promise<AudioInfo> {
  await checkInput(input);
  const { code, stderr } = await run(["-i", input, "-af", "volumedetect,ebur128=peak=true", "-f", "null", "-"]);
  if (code !== 0) throw new AudioError(`ffmpeg couldn't read that file: ${stderr.trim().split("\n").slice(-2).join(" ")}`);
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const stream = /Audio:.*?,\s*(\d+) Hz,\s*([^,]+)/.exec(stderr);
  // ebur128 prints a running log and then a "Summary:" block; take the summary's numbers.
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  return {
    ...(dur ? { durationSec: Math.round((Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])) * 100) / 100 } : {}),
    ...(stream ? { sampleRate: Number(stream[1]), channels: stream[2]!.trim() } : {}),
    meanDb: grab(stderr, /mean_volume:\s*(-?[\d.]+|-inf) dB/),
    peakDb: grab(stderr, /max_volume:\s*(-?[\d.]+|-inf) dB/),
    loudnessLufs: grab(summary, /I:\s*(-?[\d.]+) LUFS/),
    loudnessRange: grab(summary, /LRA:\s*([\d.]+) LU/),
    truePeakDbfs: grab(summary, /Peak:\s*(-?[\d.]+) dBFS/),
  };
}

export function renderInfo(file: string, i: AudioInfo): string {
  const f = (v: number | undefined, unit: string) => (v === undefined || Number.isNaN(v) ? "n/a" : `${v} ${unit}`);
  return [
    `${path.basename(file)}: ${f(i.durationSec, "s")}, ${f(i.sampleRate, "Hz")}, ${i.channels ?? "?"}`,
    `Level: peak ${f(i.peakDb, "dB")}, average ${f(i.meanDb, "dB")}. Loudness: ${f(i.loudnessLufs, "LUFS")} (range ${f(i.loudnessRange, "LU")}), true peak ${f(i.truePeakDbfs, "dBFS")}.`,
    "These are measurements. Whether it sounds good isn't something the harness can tell.",
  ].join("\n");
}

export interface EditParams {
  trim_start?: unknown;
  trim_end?: unknown;
  reverse?: unknown;
  speed?: unknown;
  pitch_semitones?: unknown;
  high_pass_hz?: unknown;
  low_pass_hz?: unknown;
  gain_db?: unknown;
  normalize_peak_db?: unknown;
  limit_db?: unknown;
  fade_in_sec?: unknown;
  fade_out_sec?: unknown;
  bit_depth?: unknown;
}

/** atempo only takes 0.5–2 per stage: chain stages for anything beyond. */
function tempoChain(factor: number): string[] {
  const stages: string[] = [];
  let f = factor;
  while (f > 2) {
    stages.push("atempo=2.0");
    f /= 2;
  }
  while (f < 0.5) {
    stages.push("atempo=0.5");
    f /= 0.5;
  }
  stages.push(`atempo=${f.toFixed(6)}`);
  return stages;
}

export interface EditResult {
  output: string;
  steps: string[];
  info: AudioInfo;
}

export async function audioEdit(input: string, output: string, p: EditParams): Promise<EditResult> {
  await checkInput(input);
  const outExt = path.extname(output).slice(1).toLowerCase();
  if (!(OUTPUT_TYPES as readonly string[]).includes(outExt)) throw new AudioError(`Output must end in ${OUTPUT_TYPES.map((t) => "." + t).join(", ")}.`);
  if (path.resolve(output).toLowerCase() === path.resolve(input).toLowerCase()) throw new AudioError("The output has to be a new file: the original is never overwritten.");
  if (await stat(output).then(() => true, () => false)) throw new AudioError(`${output} already exists; pick a new name (nothing is overwritten).`);

  const original = await audioInfo(input);
  const dur = original.durationSec ?? 0;
  const trimStart = num(p.trim_start, "trim_start", 0, 86_400) ?? 0;
  const trimEnd = num(p.trim_end, "trim_end", 0, 86_400);
  if (trimEnd !== undefined && trimEnd <= trimStart) throw new AudioError("trim_end has to be after trim_start.");
  if (dur && trimStart >= dur) throw new AudioError(`trim_start (${trimStart}s) is past the end of the file (${dur}s).`);
  const speed = num(p.speed, "speed", 0.25, 4);
  const semis = num(p.pitch_semitones, "pitch_semitones", -12, 12);
  const hp = num(p.high_pass_hz, "high_pass_hz", 10, 20_000);
  const lp = num(p.low_pass_hz, "low_pass_hz", 100, 22_000);
  const gain = num(p.gain_db, "gain_db", -60, 24);
  const normalize = num(p.normalize_peak_db, "normalize_peak_db", -30, 0);
  const limit = num(p.limit_db, "limit_db", -30, 0);
  const fadeIn = num(p.fade_in_sec, "fade_in_sec", 0.01, 600);
  const fadeOut = num(p.fade_out_sec, "fade_out_sec", 0.01, 600);
  const depth = num(p.bit_depth, "bit_depth", 16, 24);
  if (depth !== undefined && depth !== 16 && depth !== 24) throw new AudioError("bit_depth must be 16 or 24.");

  const steps: string[] = [];
  const chain: string[] = [];
  let length = dur;
  if (trimStart > 0 || trimEnd !== undefined) {
    chain.push(`atrim=start=${trimStart}${trimEnd !== undefined ? `:end=${trimEnd}` : ""}`, "asetpts=PTS-STARTPTS");
    length = Math.max(0, Math.min(trimEnd ?? dur, dur || Infinity) - trimStart);
    steps.push(`trim ${trimStart}s–${trimEnd ?? "end"}${trimEnd === undefined ? "" : "s"}`);
  }
  if (p.reverse === true || p.reverse === "true") {
    chain.push("areverse");
    steps.push("reverse");
  }
  if (semis !== undefined && semis !== 0) {
    const ratio = 2 ** (semis / 12);
    const rate = original.sampleRate ?? 44100;
    // Shift the pitch by resampling, then undo the speed change so the length stays the same.
    chain.push(`asetrate=${Math.round(rate * ratio)}`, `aresample=${rate}`, ...tempoChain(1 / ratio));
    steps.push(`pitch ${semis > 0 ? "+" : ""}${semis} semitones`);
  }
  if (speed !== undefined && speed !== 1) {
    chain.push(...tempoChain(speed));
    length /= speed;
    steps.push(`speed ×${speed}`);
  }
  if (hp !== undefined) {
    chain.push(`highpass=f=${hp}`);
    steps.push(`high-pass ${hp} Hz`);
  }
  if (lp !== undefined) {
    chain.push(`lowpass=f=${lp}`);
    steps.push(`low-pass ${lp} Hz`);
  }
  if (gain !== undefined && gain !== 0) {
    chain.push(`volume=${gain}dB`);
    steps.push(`gain ${gain > 0 ? "+" : ""}${gain} dB`);
  }
  if (normalize !== undefined) {
    // Peak-normalize like Audacity: measure the chain so far, then apply the gain that puts its peak at the target.
    const measured = await run(["-i", input, "-af", [...chain, "volumedetect"].join(","), "-f", "null", "-"]);
    const peak = grab(measured.stderr, /max_volume:\s*(-?[\d.]+) dB/);
    if (measured.code !== 0 || peak === undefined) throw new AudioError("Couldn't measure the peak level to normalize (is the file silent?).");
    const g = Math.round((normalize - peak) * 100) / 100;
    chain.push(`volume=${g}dB`);
    steps.push(`normalize peak to ${normalize} dB (${g >= 0 ? "+" : ""}${g} dB)`);
  }
  if (limit !== undefined) {
    chain.push(`alimiter=limit=${(10 ** (limit / 20)).toFixed(6)}:level=0`);
    steps.push(`limit at ${limit} dB`);
  }
  if (fadeIn !== undefined) {
    chain.push(`afade=t=in:st=0:d=${fadeIn}`);
    steps.push(`fade in ${fadeIn}s`);
  }
  if (fadeOut !== undefined) {
    if (length && fadeOut > length) throw new AudioError(`fade_out_sec (${fadeOut}s) is longer than the audio (${Math.round(length * 100) / 100}s).`);
    chain.push(`afade=t=out:st=${Math.max(0, length - fadeOut).toFixed(3)}:d=${fadeOut}`);
    steps.push(`fade out ${fadeOut}s`);
  }
  if (!steps.length && outExt === path.extname(input).slice(1).toLowerCase()) throw new AudioError("Nothing to do: give at least one edit, or a different output format to convert.");
  if (!steps.length) steps.push(`convert to ${outExt}`);

  const codec: string[] = outExt === "wav" ? ["-c:a", depth === 24 ? "pcm_s24le" : "pcm_s16le"] : outExt === "mp3" ? ["-c:a", "libmp3lame", "-q:a", "0"] : [];
  const { code, stderr } = await run(["-i", input, ...(chain.length ? ["-af", chain.join(",")] : []), "-vn", ...codec, output]);
  if (code !== 0) throw new AudioError(`ffmpeg failed: ${stderr.trim().split("\n").slice(-2).join(" ")}`);
  return { output, steps, info: await audioInfo(output) };
}
