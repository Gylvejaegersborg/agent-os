// Tests for the music library (core/library.ts + gateway/library-routes.ts).
// Proves:
//   1. An audio file uploads (streamed to disk) and downloads byte-for-byte, with
//      Range support (206, suffix ranges, 416, HEAD) so a player can seek.
//   2. Uploads are constrained: unsupported types, empty files, oversized files
//      (declared and chunked) are refused and leave nothing behind; the client's
//      filename can't choose a path; a traversal-looking id finds nothing.
//   3. Songs: created with validated fields, edited, and deleted; deleting (or
//      replacing a cover) removes the files from disk.
//   4. The overlay endpoint hands the Beat DB the uploaded songs as assets.
//   5. Agents can read the catalog (basespace section "songs") and nothing more.
// Run with: node dist/test-library.js

import "./test-helpers/isolate.js";
process.env.CLAUDE_CLI_PATH = "/nonexistent/claude";

import { readdir } from "node:fs/promises";
import { createStubModel, createStubWorker, readSnapshotSection, saveSnapshot } from "./core/index.js";
import { FILES_DIR } from "./core/library.js";
import { parseRange } from "./gateway/library-routes.js";
import { startGateway } from "./gateway/server.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

/** A real, playable 1-second mono 8 kHz WAV. */
function wav(): Buffer {
  const samples = 8000;
  const b = Buffer.alloc(44 + samples * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), 44 + i * 2);
  return b;
}
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function main(): Promise<void> {
  // 0. The range parser on its own.
  assert(JSON.stringify(parseRange("bytes=0-99", 1000)) === '{"start":0,"end":99}', "bytes=0-99");
  assert(JSON.stringify(parseRange("bytes=900-", 1000)) === '{"start":900,"end":999}', "an open-ended range runs to the end");
  assert(JSON.stringify(parseRange("bytes=-100", 1000)) === '{"start":900,"end":999}', "a suffix range is the last N bytes");
  assert(JSON.stringify(parseRange("bytes=0-99999", 1000)) === '{"start":0,"end":999}', "an end past the file is clamped");
  assert(parseRange("bytes=2000-", 1000) === "invalid" && parseRange("bytes=5-2", 1000) === "invalid", "unsatisfiable ranges are invalid");
  assert(parseRange("bytes=0-1,5-9", 1000) === undefined && parseRange(undefined, 1000) === undefined, "multi-range and no header: serve it all");

  const gateway = await startGateway({ model: createStubModel(), worker: createStubWorker() });
  const base = `http://127.0.0.1:${gateway.port}`;
  const json = async (res: Response) => (await res.json()) as any;
  const upload = (name: string, body: Buffer | Uint8Array) => fetch(`${base}/library/files?name=${encodeURIComponent(name)}`, { method: "POST", body });
  const send = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    // 1. Upload + download.
    const audio = wav();
    const up = await upload("Homerun (final mix).wav", audio);
    const file = await json(up);
    assert(up.status === 201 && file.kind === "audio" && file.size === audio.length && file.name === "Homerun (final mix).wav", "a WAV uploads and is recorded (label kept, size exact)");
    const dl = await fetch(`${base}/library/files/${file.id}`);
    const got = Buffer.from(await dl.arrayBuffer());
    assert(dl.status === 200 && got.equals(audio) && dl.headers.get("content-type") === "audio/wav" && dl.headers.get("accept-ranges") === "bytes", "it downloads byte for byte with the right type");
    assert(dl.headers.get("x-content-type-options") === "nosniff", "served with nosniff");
    const part = await fetch(`${base}/library/files/${file.id}`, { headers: { range: "bytes=100-199" } });
    assert(part.status === 206 && part.headers.get("content-range") === `bytes 100-199/${audio.length}` && Buffer.from(await part.arrayBuffer()).equals(audio.subarray(100, 200)), "Range: a 206 with exactly those bytes");
    const tail = await fetch(`${base}/library/files/${file.id}`, { headers: { range: "bytes=-50" } });
    assert(tail.status === 206 && Buffer.from(await tail.arrayBuffer()).equals(audio.subarray(audio.length - 50)), "a suffix range returns the last bytes");
    assert((await fetch(`${base}/library/files/${file.id}`, { headers: { range: `bytes=${audio.length + 10}-` } })).status === 416, "an unsatisfiable range is a 416");
    const head = await fetch(`${base}/library/files/${file.id}`, { method: "HEAD" });
    assert(head.status === 200 && head.headers.get("content-length") === String(audio.length) && (await head.arrayBuffer()).byteLength === 0, "HEAD gives the length and no body");

    // 2. Constraints.
    const bad = await upload("payload.exe", Buffer.from("MZ"));
    assert(bad.status === 415 && /supported type/.test((await json(bad)).error), "an .exe is refused (415)");
    assert((await upload("nothing.mp3", Buffer.alloc(0))).status === 400, "an empty file is refused");
    const sneaky = await json(await upload("..\\..\\..\\windows\\evil.mp3", Buffer.from("ID3-not-really")));
    assert(sneaky.name === "evil.mp3", "a path in the filename is reduced to its last part (a label only)");
    const onDisk = await readdir(FILES_DIR);
    assert(onDisk.includes(`${sneaky.id}.mp3`) && onDisk.every((f) => /^[a-z0-9]+\.(wav|mp3|png|part)$/.test(f)), "files on disk are only <server id>.<ext>");
    assert((await fetch(`${base}/library/files/..%2f..%2fpackage`)).status === 404 && (await fetch(`${base}/library/files/nope`)).status === 404, "a traversal-looking or unknown id finds nothing");

    process.env.AGENT_OS_LIBRARY_MAX_MB = "0.001"; // ~1 KB
    const before = (await readdir(FILES_DIR)).length;
    const big = await upload("huge.mp3", Buffer.alloc(5000, 1));
    assert(big.status === 413 && /limit/.test((await json(big)).error), "an oversized upload (declared) is refused with a 413");
    const chunked = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(600).fill(2));
      },
    });
    let outcome = "";
    try {
      const r = await fetch(`${base}/library/files?name=endless.mp3`, { method: "POST", body: chunked, duplex: "half" } as RequestInit);
      outcome = `status ${r.status}`;
    } catch {
      outcome = "connection cut";
    }
    await new Promise((r) => setTimeout(r, 200));
    const after = await readdir(FILES_DIR);
    assert(after.length === before && !after.some((f) => f.endsWith(".part")), `an endless chunked upload is cut off (${outcome}) and leaves no file, not even a partial one`);
    delete process.env.AGENT_OS_LIBRARY_MAX_MB;

    // 3. Songs.
    assert((await send("POST", "/library/songs", { audioFileId: file.id })).status === 400, "a song needs a title");
    assert((await send("POST", "/library/songs", { title: "No audio" })).status === 400, "a song needs an uploaded audio file");
    assert((await send("POST", "/library/songs", { title: "x", audioFileId: file.id, bpm: 9000 })).status === 400, "an absurd BPM is refused");
    const cover1 = await json(await upload("cover.png", PNG));
    assert((await send("POST", "/library/songs", { title: "x", audioFileId: cover1.id })).status === 400, "an image can't be a song's audio");
    assert((await send("POST", "/library/songs", { title: "x", audioFileId: "ghost" })).status === 400, "an unknown file id is refused");

    const created = await send("POST", "/library/songs", { title: "  Homerun  ", audioFileId: file.id, bpm: "140", musicalKey: "F# min", tags: ["trap", "dark", "trap"], note: "instrumental", durationSec: 1, coverFileId: cover1.id });
    const song = await json(created);
    assert(created.status === 201 && song.title === "Homerun" && song.bpm === 140 && song.category === "beat" && song.tags.join() === "trap,dark", "a song is created with cleaned fields (trimmed, BPM as a number, tags de-duplicated, default kind beat)");

    // 4. The Beat DB's view (the overlay endpoint).
    const overlay = await json(await fetch(`${base}/basespace/overlay`));
    const asset = overlay.library.find((a: any) => a.id === song.id);
    assert(!!asset && asset.uploaded === true && asset.audioFileId === file.id && asset.coverFileId === cover1.id && asset.fileType === "wav" && asset.bpm === 140 && asset.musicalKey === "F# min" && /KB|MB/.test(asset.fileSize), "the overlay carries the song as a Beat DB asset with its file ids");
    assert(Array.isArray(overlay.gradient ?? asset.gradient) && asset.gradient.length === 2, "…with a fallback gradient (no invented cover art)");

    // 5. Editing, replacing the cover, deleting.
    const cover2 = await json(await upload("cover2.png", PNG));
    const edited = await json(await send("PUT", `/library/songs/${song.id}`, { bpm: 142, tags: ["trap"], coverFileId: cover2.id, note: "" }));
    assert(edited.bpm === 142 && edited.tags.join() === "trap" && edited.note === undefined && edited.coverFileId === cover2.id, "an edit changes only what was sent (and can clear a note)");
    assert((await fetch(`${base}/library/files/${cover1.id}`)).status === 404, "replacing the cover removed the old file");
    assert((await send("PUT", "/library/songs/lib-ghost", { title: "y" })).status === 404, "editing an unknown song is a 404");

    // 6. What agents can see.
    await saveSnapshot({ schema: 1, songs: [{ id: song.id, title: "Homerun", kind: "beat", bpm: 142 }] });
    const seen = await readSnapshotSection("songs");
    assert(seen.ok && seen.output.includes("Homerun") && seen.output.includes("142"), "the basespace tool has a songs section");
    assert(JSON.parse((await readSnapshotSection("summary")).output.split("\n")[1]!).counts.songs === 1, "the summary counts songs");

    assert((await send("DELETE", `/library/songs/${song.id}`)).status === 200, "a song deletes");
    assert((await fetch(`${base}/library/files/${file.id}`)).status === 404 && (await fetch(`${base}/library/files/${cover2.id}`)).status === 404, "…and its audio and cover are gone from disk");
    assert(!(await json(await fetch(`${base}/library/songs`))).songs.some((s: any) => s.id === song.id), "…and from the catalog");
    assert((await send("DELETE", `/library/songs/${song.id}`)).status === 404, "deleting twice is a 404");
  } finally {
    await gateway.stop();
  }
  if (process.exitCode === 1) console.error("\nSome library tests FAILED.");
  else console.log("\nAll library tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
