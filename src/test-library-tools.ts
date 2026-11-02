// Tests for the `library` and `audio` tools (core/library-tools.ts, core/audio.ts).
// Proves:
//   1. Agents can list, read (with lyrics), add from a file, and update songs,
//      and there is no way to delete one.
//   2. Adding needs file access (an agent without it is told who to ask), the
//      path goes through the sandbox, and non-audio files are refused.
//   3. Every song records who added it; an agent can't change its audio.
//   4. Plan mode treats add/update/edit as changes and list/read/info as reads.
//   5. `audio` measures a real file and edits into a NEW file: normalize, trim,
//      fade, convert; it refuses to overwrite, to write over the input, or to
//      accept absurd values, and the sandbox can refuse either path.
// Needs ffmpeg for the audio half (prints SKIP without it).
// Run with: node dist/test-library-tools.js

import "./test-helpers/isolate.js";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { changesLibraryOrAudio, setToolVisibility } from "./core/index.js";
import { dispatchAudio, dispatchLibrary } from "./core/library-tools.js";
import { getSong, listSongAssets } from "./core/library.js";
import type { SandboxPolicy } from "./core/permissions.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else console.log(`ok: ${msg}`);
}

const work = path.join(process.cwd(), "data-test", "test-library-tools", "work");
await mkdir(work, { recursive: true });
const sandbox: SandboxPolicy = { filesystemScope: "workspace-only", workspaceRoot: work, hardBlocklist: [] };

/** 2 s mono 44.1 kHz WAV: a quiet 440 Hz sine (peak about -20 dB). */
function wav(seconds = 2, amp = 3277): Buffer {
  const n = 44100 * seconds;
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(44100, 24);
  b.writeUInt32LE(88200, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 44100) * amp), 44 + i * 2);
  return b;
}

const beat = path.join(work, "demo beat.wav");
await writeFile(beat, wav());

// --- the library tool ---------------------------------------------------------
setToolVisibility((agent, tool) => tool !== "read_file" || agent === "claude"); // only "claude" has files

let r = await dispatchLibrary({ action: "list" }, "hemera", sandbox);
assert(r.ok && /No songs/.test(r.output), "list on an empty library says so");

r = await dispatchLibrary({ action: "add", path: beat, title: "Demo Beat" }, "hemera", sandbox);
assert(!r.ok && /no file access/.test(r.error ?? "") && /delegate|Beat DB/.test(r.error ?? ""), "an agent without file access can't add, and is told who can");

r = await dispatchLibrary({ action: "add", path: path.join(work, "..", "..", "..", "package.json"), title: "x" }, "claude", sandbox);
assert(!r.ok && /sandbox/.test(r.error ?? ""), "a path outside the sandbox is refused");
await writeFile(path.join(work, "notes.txt"), "not audio");
r = await dispatchLibrary({ action: "add", path: path.join(work, "notes.txt"), title: "x" }, "claude", sandbox);
assert(!r.ok && /supported audio type/.test(r.error ?? ""), "a non-audio file is refused");
r = await dispatchLibrary({ action: "add", path: path.join(work, "missing.wav"), title: "x" }, "claude", sandbox);
assert(!r.ok && /No file/.test(r.error ?? ""), "a missing file is reported");
r = await dispatchLibrary({ action: "add", path: beat }, "claude", sandbox);
assert(!r.ok && /title/.test(r.error ?? ""), "a song needs a title");

r = await dispatchLibrary({ action: "add", path: beat, title: "Demo Beat", tags: ["trap"], note: "made by test" }, "claude", sandbox);
const id = /(lib-[a-z0-9]+)/.exec(r.output)?.[1] ?? "";
assert(r.ok && !!id && /added by claude/.test(r.output), "the engineer adds a song from a file, and it records who added it");
let song = await getSong(id);
assert(song?.bpm === undefined && song?.musicalKey === undefined && song?.addedBy === "claude" && song?.category === "beat", "BPM and key stay empty when not given (nothing invented)");

r = await dispatchLibrary({ action: "read", id }, "hemera", sandbox);
assert(r.ok && /No lyrics have been written down/.test(r.output), "read says plainly when there are no lyrics");

r = await dispatchLibrary({ action: "update", id, lyrics: "line one\r\nline two", bpm: 140 }, "hemera", sandbox);
assert(r.ok && /has lyrics/.test(r.output), "any agent can write lyrics it was given");
r = await dispatchLibrary({ action: "read", id }, "hemera", sandbox);
assert(r.ok && r.output.includes("line one\nline two") && r.output.includes("140 BPM"), "read returns the lyrics (line endings normalized) and the BPM");
r = await dispatchLibrary({ action: "update", id, lyrics: "" }, "hemera", sandbox);
assert(r.ok && /no lyrics/.test(r.output), "an empty string clears the lyrics");

r = await dispatchLibrary({ action: "update", id, collaborators: ["Gswish: melody", "  ", { name: "Nyx" }] }, "hemera", sandbox);
assert(r.ok && /with Gswish \(melody\), Nyx/.test(r.output), "collaborators are credits with an optional role (blank entries dropped)");
song = await getSong(id);
assert(song?.collaborators?.length === 2 && song.collaborators[0]!.role === "melody" && song.collaborators[1]!.role === undefined && !("split" in (song.collaborators[0] as object)), "…stored as name and role only: no splits");
r = await dispatchLibrary({ action: "update", id, collaborators: [] }, "hemera", sandbox);
assert(r.ok && !/with /.test(r.output), "an empty list clears them");

r = await dispatchLibrary({ action: "update", id, title: "Demo Beat", audioFileId: "other", coverFileId: "x" } as any, "hemera", sandbox);
song = await getSong(id);
assert(r.ok && song?.audioFileId !== "other" && song?.coverFileId === undefined, "an agent can't swap the audio or cover through update");

for (const action of ["delete", "remove", "rm"]) {
  r = await dispatchLibrary({ action, id }, "claude", sandbox);
  assert(!r.ok && /no delete/.test(r.error ?? ""), `"${action}" is not a thing: there is no delete`);
}
assert(!!(await getSong(id)), "the song is still there after every delete attempt");

const assets = await listSongAssets();
const asset = assets.find((a) => a.id === id) as any;
assert(asset?.source === "Uploaded by claude" && asset?.bpm === 140, "the Beat DB sees it, labeled with who uploaded it");

// --- plan mode ----------------------------------------------------------------
assert(changesLibraryOrAudio({ name: "library", args: { action: "add" } }) && changesLibraryOrAudio({ name: "library", args: { action: "update" } }) && changesLibraryOrAudio({ name: "audio", args: { action: "edit" } }), "plan mode blocks library add/update and audio edit");
assert(!changesLibraryOrAudio({ name: "library", args: { action: "read" } }) && !changesLibraryOrAudio({ name: "library", args: { action: "list" } }) && !changesLibraryOrAudio({ name: "audio", args: { action: "info" } }), "…but allows list, read and info");

// --- the audio tool -----------------------------------------------------------
if (spawnSync(process.env.AGENT_OS_FFMPEG ?? "ffmpeg", ["-version"]).status !== 0) {
  console.log("SKIP: ffmpeg not found; the audio half was not run.");
} else {
  r = await dispatchAudio({ action: "info", path: beat }, sandbox);
  const peak = Number(/peak (-?[\d.]+) dB/.exec(r.output)?.[1]);
  assert(r.ok && /2 s/.test(r.output) && peak < -15 && peak > -25, `info measures a real file (2 s, peak ${peak} dB)`);
  assert(/harness can tell/.test(r.output), "info says it can't judge how it sounds");

  const out1 = path.join(work, "loud.wav");
  r = await dispatchAudio({ action: "edit", path: beat, output: out1, normalize_peak_db: -1 }, sandbox);
  const newPeak = Number(/peak (-?[\d.]+) dB/.exec(r.output.split("\n").slice(2).join("\n"))?.[1]);
  assert(r.ok && Math.abs(newPeak - -1) < 0.3, `normalize puts the peak at -1 dB (measured ${newPeak})`);
  assert((await readFile(beat)).equals(wav()), "the original file is untouched");

  const out2 = path.join(work, "short.mp3");
  r = await dispatchAudio({ action: "edit", path: beat, output: out2, trim_start: 0.5, trim_end: 1.5, fade_in_sec: 0.1, fade_out_sec: 0.2, gain_db: 3 }, sandbox);
  const dur = Number(/(\d+(?:\.\d+)?) s,/.exec(r.output.split("\n").slice(2).join("\n"))?.[1]);
  assert(r.ok && dur > 0.9 && dur < 1.2 && /trim/.test(r.output) && /fade out/.test(r.output), `trim + fades + gain + convert to mp3 in one pass (${dur} s long)`);

  const out3 = path.join(work, "reversed-limited.flac");
  r = await dispatchAudio({ action: "edit", path: beat, output: out3, reverse: true, limit_db: -6, high_pass_hz: 100, speed: 2, pitch_semitones: 2 }, sandbox);
  assert(r.ok && /reverse/.test(r.output) && /speed/.test(r.output), "reverse, limiter, EQ, speed and pitch run without errors");

  r = await dispatchAudio({ action: "edit", path: beat, output: out1, gain_db: 1 }, sandbox);
  assert(!r.ok && /already exists/.test(r.error ?? ""), "it never overwrites an existing file");
  r = await dispatchAudio({ action: "edit", path: beat, output: beat, gain_db: 1 }, sandbox);
  assert(!r.ok && /new file/.test(r.error ?? ""), "it never writes over the input");
  r = await dispatchAudio({ action: "edit", path: beat, output: path.join(work, "x.exe"), gain_db: 1 }, sandbox);
  assert(!r.ok && /Output must end/.test(r.error ?? ""), "the output extension is whitelisted");
  r = await dispatchAudio({ action: "edit", path: beat, output: path.join(work, "y.wav"), gain_db: 999 }, sandbox);
  assert(!r.ok && /gain_db must be/.test(r.error ?? ""), "absurd values are refused");
  r = await dispatchAudio({ action: "edit", path: beat, output: path.join(work, "z.wav"), fade_out_sec: 30 }, sandbox);
  assert(!r.ok && /longer than the audio/.test(r.error ?? ""), "a fade longer than the audio is refused");
  r = await dispatchAudio({ action: "edit", path: beat, output: path.join(work, "w.wav") }, sandbox);
  assert(!r.ok && /Nothing to do/.test(r.error ?? ""), "an edit with no edits is refused");
  r = await dispatchAudio({ action: "edit", path: beat, output: path.join(work, "..", "escaped.wav"), gain_db: 1 }, sandbox);
  assert(!r.ok && /sandbox/.test(r.error ?? ""), "the sandbox refuses an output outside the workspace");
  r = await dispatchAudio({ action: "info", path: path.join(work, "notes.txt") }, sandbox);
  assert(!r.ok && /supported audio type/.test(r.error ?? ""), "info refuses a non-audio file");
  r = await dispatchAudio({ action: "edit", path: `${beat}"; calc "`, output: path.join(work, "inj.wav"), gain_db: 1 }, sandbox);
  assert(!r.ok, "a shell-looking path is just a path that doesn't exist (no shell is involved)");
}

setToolVisibility(undefined);
console.log(process.exitCode === 1 ? "\nSome library-tools tests FAILED." : "\nAll library-tools tests passed.");
