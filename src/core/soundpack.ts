// Sound packs: the kept sounds, packaged the way a producer expects to receive them.
//
// A pack is a folder of 24-bit WAVs sorted by kind (Drums/808, Drums/Kicks, Melodic/Bells, ...),
// clean file names, a README that says only what is true, a manifest, the license text, and a
// zip. Building one is internal (it writes into the operator's own data); putting it on sale or
// posting it anywhere is not, and goes through Approvals.
//
// The license shipped in a pack is the operator's DRAFT with its [brackets] still in it, named so
// it can't be mistaken for a reviewed one. Nothing here writes legal text or invents claims
// ("mastered", "analog"): the README states formats, counts, tuning and that the sounds are
// synthesized originals, which is what they are.

import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendEvent, project } from "./eventlog.js";
import { generateId } from "./id.js";
import { SAMPLE_RATE } from "./soundgen.js";
import { SoundLabError, getCandidate, renderCandidateWav, type Candidate } from "./soundlab.js";

const STREAM = "soundlab-packs";
const DATA_DIR = process.env.AGENT_OS_DATA_DIR ?? path.join(process.cwd(), "data");
export const PACKS_DIR = path.join(DATA_DIR, "soundlab", "packs");
export const MAX_PACK_SOUNDS = 120;

const FOLDERS: Record<string, string> = {
  "808": "Drums/808s",
  kick: "Drums/Kicks",
  snare: "Drums/Snares",
  clap: "Drums/Claps",
  perc: "Drums/Percussion",
  "hat-closed": "Drums/Hats",
  "hat-open": "Drums/Hats",
  bell: "Melodic/Bells",
  pluck: "Melodic/Plucks",
  keys: "Melodic/Keys",
  pad: "Melodic/Pads",
  strings: "Melodic/Strings",
  lead: "Melodic/Leads",
};

export interface PackSound {
  file: string;
  label: string;
  kind: string;
  durationSec: number;
  channels: number;
  /** Tuned sounds are all on C (the octave is in the label); drums are unpitched. */
  tuning?: string;
}

export interface PackManifest {
  id: string;
  name: string;
  createdAt: string;
  format: string;
  counts: Record<string, number>;
  sounds: PackSound[];
  zip: string;
  zipBytes: number;
  licenseNote: string;
}

/** A name safe to use as a file or folder name: ASCII only (the artist name's stylized Λ is written as a plain A, which is what search needs),
 *  no path characters, no runs of dots (so never "..") and no leading dot. */
const safe = (s: string) => s.replace(/Λ/g, "A").replace(/λ/g, "a").replace(/[^A-Za-z0-9 ._-]/g, "").replace(/\.{2,}/g, ".").replace(/^[.\s]+/, "").trim().replace(/\s+/g, "_");

// ---- a store-only zip (WAV doesn't compress; no dependency needed) ------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf: Buffer) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

export function zipStore(files: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, f.data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(dosTime, 12);
    c.writeUInt16LE(dosDate, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(f.data.length, 20);
    c.writeUInt32LE(f.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + f.data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

// ---- the pack -------------------------------------------------------------------------------

const LICENSE_DRAFT = `DRAFT: fill in the [brackets] and have this reviewed before you sell the pack. It is not legal advice.

Sound Kit License: [Pack Name]
Licensor: [your legal name or company], "Licensor". This license applies to the sounds in the pack and the person who purchases it, "Licensee".

1. Grant. On payment, Licensor grants Licensee a non-exclusive, worldwide, perpetual, royalty-free license to use the sounds in new, original musical works, and to reproduce, distribute, stream, perform and monetize those works commercially, with no further payment and no credit required.

2. You may use the sounds in songs, beats, videos, ads and live sets that contain them as part of a larger original work, and register and release those finished works, including through distributors and streaming services.

3. You may not (a) sell, share, give away or upload the sounds on their own, in whole or in part, or in another sample pack, loop or sound library; (b) register the sounds themselves, or a track that is only the unaltered sounds, with any content-identification or rights system; (c) claim you created the sounds or this pack; (d) use the sounds to train an AI model.

4. Ownership. Licensor keeps all rights in the sounds. This license is not a transfer of ownership.

5. Transfer. The license is personal to Licensee and can't be resold or transferred. Each user in a team or studio needs their own license.

6. No warranty. The sounds are provided "as is". To the extent the law allows, Licensor's liability is limited to the price paid.

7. Law. [governing law and country]. Contact: [email].
`;

/** The draft license a pack ships with, and the [brackets] still open in it. Read-only for agents (so they can explain it, not change it). */
export function licenseDraft(packName = "[Pack Name]"): { text: string; brackets: string[] } {
  const text = LICENSE_DRAFT.replace("[Pack Name]", packName);
  return { text, brackets: [...new Set(text.match(/\[[^\]]+\]/g) ?? [])] };
}

async function packs(): Promise<Map<string, PackManifest>> {
  return project<Map<string, PackManifest>>(STREAM, new Map(), (state, e) => {
    if (e.type === "pack.built") state.set((e.payload as any).id, e.payload as unknown as PackManifest);
    return state;
  });
}

export const listPacks = async () => [...(await packs()).values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
export const getPack = async (id: string) => (await packs()).get(id);

export async function packFile(id: string): Promise<{ path: string; name: string } | undefined> {
  const pack = await getPack(id);
  if (!pack || !/^[a-z0-9]+$/.test(id)) return undefined;
  const p = path.join(PACKS_DIR, id, pack.zip);
  try {
    await stat(p);
  } catch {
    return undefined;
  }
  return { path: p, name: pack.zip };
}

/** Builds a pack from kept sounds. Only sounds the operator accepted can go in, and each renders from its stored recipe. */
export async function createPack(rawName: unknown, rawIds: unknown): Promise<PackManifest> {
  const name = typeof rawName === "string" ? rawName.trim().slice(0, 60) : "";
  if (!safe(name)) throw new SoundLabError(400, "Give the pack a name (letters, numbers, spaces).");
  if (!Array.isArray(rawIds) || !rawIds.length) throw new SoundLabError(400, "Pick at least one sound.");
  const ids = [...new Set(rawIds.map(String))];
  if (ids.length > MAX_PACK_SOUNDS) throw new SoundLabError(400, `A pack holds at most ${MAX_PACK_SOUNDS} sounds.`);
  const chosen: Candidate[] = [];
  for (const id of ids) {
    const c = await getCandidate(id);
    if (!c) throw new SoundLabError(404, `No sound "${id}".`);
    if (c.verdict !== "accepted") throw new SoundLabError(409, `"${c.label}" isn't kept: only kept sounds go in a pack.`);
    chosen.push(c);
  }

  const id = generateId().toLowerCase().replace(/[^a-z0-9]/g, "");
  const root = safe(name);
  const dir = path.join(PACKS_DIR, id);
  const files: { name: string; data: Buffer }[] = [];
  const sounds: PackSound[] = [];
  const perFolder = new Map<string, number>();
  for (const c of chosen) {
    const made = await renderCandidateWav(c.id);
    if (!made) continue;
    const folder = FOLDERS[c.kind] ?? "Other";
    const n = (perFolder.get(`${folder}/${c.label}`) ?? 0) + 1;
    perFolder.set(`${folder}/${c.label}`, n);
    const file = `${root}/${folder}/${root}_${safe(c.label)}${n > 1 ? `_${n}` : ""}.wav`;
    files.push({ name: file, data: made.wav });
    sounds.push({ file, label: c.label, kind: c.kind, durationSec: made.durationSec, channels: made.wav.readUInt16LE(22), ...(/ C\d$/.test(c.label) ? { tuning: "C" } : {}) });
  }
  const counts: Record<string, number> = {};
  for (const s of sounds) counts[s.kind] = (counts[s.kind] ?? 0) + 1;

  const readme =
    `${name}\n${"=".repeat(name.length)}\n\n` +
    `${sounds.length} sounds. 24-bit, ${SAMPLE_RATE / 1000} kHz WAV (mono for drums, stereo for melodic sounds), peak-normalized to -1 dBFS.\n` +
    `Melodic sounds are all tuned to C; the octave is in the file name (e.g. Glass_Bell_C5). Drums are unpitched.\n` +
    `Every sound is synthesized from scratch: original, no samples from anyone else's recordings.\n\n` +
    `Contents:\n${Object.entries(counts).map(([k, n]) => `  ${FOLDERS[k] ?? k}: ${n}`).join("\n")}\n\n` +
    `See the license file before using the sounds.\n`;
  const manifestNoZip = { id, name, createdAt: new Date().toISOString(), format: "WAV 24-bit 44.1 kHz", counts, sounds, licenseNote: "Draft license included: fill in the [brackets] and have it reviewed before selling." };
  files.push({ name: `${root}/README.txt`, data: Buffer.from(readme, "utf8") });
  files.push({ name: `${root}/LICENSE (draft - fill in the brackets before selling).txt`, data: Buffer.from(LICENSE_DRAFT.replace("[Pack Name]", name), "utf8") });
  files.push({ name: `${root}/manifest.json`, data: Buffer.from(JSON.stringify(manifestNoZip, null, 2), "utf8") });

  const zip = zipStore(files);
  const zipName = `${root}.zip`;
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, zipName), zip);
  const manifest: PackManifest = { ...manifestNoZip, zip: zipName, zipBytes: zip.length };
  await appendEvent(STREAM, "pack.built", manifest as unknown as Record<string, unknown>);
  return manifest;
}

