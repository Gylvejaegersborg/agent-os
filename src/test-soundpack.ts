// Tests for sound packs (core/soundpack.ts) and the read-only agent view (soundlab tool).
// Proves:
//   1. Only KEPT sounds can go in a pack; names and sizes are validated.
//   2. The zip is a real zip (Python's own reader tests its integrity and CRCs), laid out as
//      producers expect (Drums/..., Melodic/...), with 24-bit WAVs that match what was judged,
//      a README that states only what is true, a manifest, and the license kept as a DRAFT.
//   3. File names are clean and unique; nothing from the name can escape the pack folder.
//   4. The HTTP routes build, list, describe and download it (the download is the zip itself).
//   5. Agents can see what was kept and the packs, and cannot accept, skip or build.
// Run with: node dist/test-soundpack.js

import "./test-helpers/isolate.js";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createPack, createStubModel, createStubWorker, generateBatch, judge, listPacks, packFile, zipStore } from "./core/index.js";
import { dispatchSoundlab } from "./core/library-tools.js";
import { startGateway } from "./gateway/server.js";

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`ok: ${msg}`);
  else {
    failed = true;
    console.log(`FAIL: ${msg}`);
  }
}
const rejects = (p: Promise<unknown>) => p.then(() => 0, (e) => e.status ?? 1);

// Sounds: some kept, one not.
const k808 = await generateBatch("808", 3, 1);
const bells = await generateBatch("bell", 2, 2);
const hats = await generateBatch("hat-closed", 2, 3);
const kept = [...k808, ...bells, hats[0]!];
for (const c of kept) await judge(c.id, "accepted");
const notKept = hats[1]!;

// --- 1. validation -----------------------------------------------------------------------
assert((await rejects(createPack("", [kept[0]!.id]))) === 400 && (await rejects(createPack("!!!", [kept[0]!.id]))) === 400, "a pack needs a name with real characters");
assert((await rejects(createPack("Test", []))) === 400 && (await rejects(createPack("Test", "nope" as any))) === 400, "a pack needs sounds");
assert((await rejects(createPack("Test", [notKept.id]))) === 409, "a sound that wasn't kept can't go in a pack");
assert((await rejects(createPack("Test", ["snd-ghost"]))) === 404, "an unknown sound is refused");
assert((await rejects(createPack("Test", Array.from({ length: 121 }, (_, i) => `snd-${i}`)))) === 400, "more than 120 sounds is refused");
assert((await listPacks()).length === 0, "refused packs leave nothing behind");

// --- 2. a real pack ----------------------------------------------------------------------
const pack = await createPack("ISΛRK Test Kit! ../../x", kept.map((c) => c.id));
assert(pack.sounds.length === 6 && pack.counts["808"] === 3 && pack.counts.bell === 2 && pack.counts["hat-closed"] === 1, `six kept sounds, counted by kind (${JSON.stringify(pack.counts)})`);
const file = await packFile(pack.id);
const zipBytes = await readFile(file!.path);
assert(!!file && zipBytes.length === pack.zipBytes && zipBytes.readUInt32LE(0) === 0x04034b50, "the zip is on disk and starts like a zip");
const py = spawnSync("python", ["-c", `
import zipfile, sys, json
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
names = z.namelist()
out = {"bad": bad, "names": names, "wavs": {}}
for n in names:
    if n.endswith(".wav"):
        d = z.read(n)
        out["wavs"][n] = [d[:4].decode(), int.from_bytes(d[22:24], "little"), int.from_bytes(d[24:28], "little"), int.from_bytes(d[34:36], "little"), len(d)]
out["readme"] = z.read([n for n in names if n.endswith("README.txt")][0]).decode()
out["license"] = [n for n in names if "LICENSE" in n][0]
out["licenseText"] = z.read(out["license"]).decode()
out["manifest"] = json.loads(z.read([n for n in names if n.endswith("manifest.json")][0]))
print(json.dumps(out))
`, file!.path], { encoding: "utf8" });
if (py.status !== 0) assert(false, `python could not read the zip: ${py.stderr}`);
else {
  const z = JSON.parse(py.stdout);
  assert(z.bad === null, "Python's zip reader finds no corrupt entry (CRCs and sizes all check out)");
  const wavs = Object.keys(z.wavs) as string[];
  assert(wavs.length === 6 && wavs.every((n) => z.wavs[n][0] === "RIFF" && z.wavs[n][2] === 44100 && z.wavs[n][3] === 24), "six 24-bit 44.1 kHz WAVs");
  assert(wavs.some((n) => /\/Drums\/808s\//.test(n)) && wavs.some((n) => /\/Melodic\/Bells\//.test(n)) && wavs.some((n) => /\/Drums\/Hats\//.test(n)), "sorted into Drums/808s, Drums/Hats, Melodic/Bells");
  assert(wavs.filter((n) => /Drums/.test(n)).every((n) => z.wavs[n][1] === 1) && wavs.filter((n) => /Bells/.test(n)).every((n) => z.wavs[n][1] === 2), "drums are mono, melodic sounds are stereo");
  assert(new Set(z.names).size === z.names.length && z.names.every((n: string) => !n.includes("..") && !n.startsWith("/") && !/[<>:"|?*\\]/.test(n)), "file names are unique and clean: nothing from the pack name can climb out of the folder");
  const root = z.names[0].split("/")[0] as string;
  assert(root.startsWith("ISARK_Test_Kit"), `the stylized Λ in the name becomes a plain A in file names, for search ("${root}")`);
  assert(z.names.every((n: string) => n.startsWith(root + "/")) && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(root) && !root.includes(".."), `everything sits under one clean folder named from the pack ("${root}")`);
  assert(/6 sounds\. 24-bit, 44\.1 kHz WAV/.test(z.readme) && /tuned to C/.test(z.readme) && /synthesized from scratch/.test(z.readme), "the README states the format, the tuning and that the sounds are synthesized");
  assert(!/mastered|analog|vintage|premium|best|world-class|studio-quality|platinum/i.test(z.readme), "the README makes no claims it can't back up");
  assert(/draft/.test(z.license) && /DRAFT/.test(z.licenseText) && /\[your legal name or company\]/.test(z.licenseText) && /3\. You may not/.test(z.licenseText) && /train an AI model/.test(z.licenseText) && !/7\. Breach/.test(z.licenseText), "the license ships as a DRAFT with its [brackets] and your chosen clauses (AI-training ban, no breach clause)");
  assert(z.manifest.sounds.length === 6 && z.manifest.sounds.every((s: any) => s.file && s.label), "the manifest lists every sound");
}
assert(pack.sounds.filter((s) => s.kind === "808" || s.kind === "bell").every((s) => s.tuning === "C") && pack.sounds.filter((s) => s.kind === "hat-closed").every((s) => !s.tuning), "tuned sounds are marked C, drums aren't");

// Two sounds with the same label get different names.
const dup = await generateBatch("808", 1, 1); // same seed → same recipe → same label as k808[0]
await judge(dup[0]!.id, "accepted");
const pack2 = await createPack("Dupes", [k808[0]!.id, dup[0]!.id]);
assert(new Set(pack2.sounds.map((s) => s.file)).size === 2, "two sounds with the same label get different file names");
assert(zipStore([{ name: "a.txt", data: Buffer.from("hello") }]).readUInt32LE(0) === 0x04034b50, "the zip writer works on its own");

// --- 4. HTTP -----------------------------------------------------------------------------
const gateway = await startGateway({ model: createStubModel(), worker: createStubWorker() });
const base = `http://127.0.0.1:${gateway.port}`;
const api = (method: string, route: string, body?: unknown) => fetch(`${base}${route}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
try {
  assert((await api("POST", "/soundlab/packs", { name: "Over HTTP", ids: [notKept.id] })).status === 409, "an unkept sound is a 409 over HTTP");
  const made = await api("POST", "/soundlab/packs", { name: "Over HTTP", ids: kept.slice(0, 2).map((c) => c.id) });
  const m = (await made.json()) as any;
  assert(made.status === 201 && m.sounds.length === 2, "POST /soundlab/packs builds a pack");
  const listed = (await (await api("GET", "/soundlab/packs")).json()) as any;
  assert(listed.packs.some((p: any) => p.id === m.id), "GET /soundlab/packs lists it");
  assert((await (await api("GET", `/soundlab/packs/${m.id}`)).json() as any).name === "Over HTTP" && (await api("GET", "/soundlab/packs/nope")).status === 404, "GET /soundlab/packs/:id describes it; an unknown id is a 404");
  const dl = await api("GET", `/soundlab/packs/${m.id}/download`);
  const bytes = Buffer.from(await dl.arrayBuffer());
  assert(dl.status === 200 && dl.headers.get("content-type") === "application/zip" && /attachment; filename="Over_HTTP\.zip"/.test(dl.headers.get("content-disposition") ?? "") && bytes.length === m.zipBytes && bytes.equals(await readFile((await packFile(m.id))!.path)), "the download is the zip, byte for byte");
  assert((await api("GET", "/soundlab/packs/..%2f..%2fx/download")).status === 404, "a path-looking pack id finds nothing");
} finally {
  await gateway.stop();
}

// --- 5. agents see, never judge or build ---------------------------------------------------
const seen = await dispatchSoundlab({ action: "kept" });
assert(seen.ok && /kept sound\(s\)/.test(seen.output) && /808 \(\d\)/.test(seen.output) && /can't hear/.test(seen.output) && !seen.output.includes(notKept.label + notKept.id), "agents can see the kept sounds by name, and are told they can't hear them");
assert((await dispatchSoundlab({ action: "kept", kind: "bell" })).output.includes("bell (2)"), "…filtered by kind");
const packsSeen = await dispatchSoundlab({ action: "packs" });
assert(packsSeen.ok && /ISΛRK|ISRK|Test_Kit|Test Kit/i.test(packsSeen.output) && /DRAFT|Draft license/.test(packsSeen.output), "agents can see the packs and are reminded the license is a draft");
const lic = await dispatchSoundlab({ action: "license" });
assert(lic.ok && /Sound Kit License/.test(lic.output) && /3\. You may not/.test(lic.output) && /Open \[brackets\]/.test(lic.output) && /\[your legal name or company\]/.test(lic.output) && /DRAFT/.test(lic.output) && /not legal advice/.test(lic.output), "agents can read the draft license and the list of open [brackets], flagged as a draft and not legal advice");
for (const action of ["accept", "judge", "build", "create", "skip"]) {
  const r = await dispatchSoundlab({ action, id: kept[0]!.id });
  assert(!r.ok && /only the operator/.test(r.error ?? ""), `"${action}" is refused: judging and building are the operator's`);
}

console.log(failed ? "\nSome soundpack tests FAILED." : "\nAll soundpack tests passed.");
process.exit(failed ? 1 : 0);
