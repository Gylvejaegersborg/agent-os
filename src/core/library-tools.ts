// The `library` and `audio` tools (tool-registry.ts) as agents call them.
//
// Agents may add and describe songs and read their lyrics; they may not delete
// (there is no delete action here, and the DELETE route belongs to the operator's
// BaseSpace). Adding needs a file, so it's limited to agents that can touch files
// at all (the same visibility rule as read_file), and the path goes through the
// sandbox first. Uploading into the operator's own library is internal, so it is
// not approval-gated, but every song records who added it.

import { AudioError, audioEdit, audioInfo, renderInfo, type EditParams } from "./audio.js";
import { LibraryError, addSongBy, getSong, importAudioFromPath, listSongs, updateSong, type LibrarySong } from "./library.js";
import { checkPathSandbox, type SandboxPolicy } from "./permissions.js";
import { isKind, listCandidates, stats as soundStats } from "./soundlab.js";
import { listPacks } from "./soundpack.js";
import { toolVisibleTo } from "./tool-registry.js";

interface Result {
  ok: boolean;
  output: string;
  error?: string;
}

const fail = (error: string): Result => ({ ok: false, output: "", error });

function checkPath(policy: SandboxPolicy | undefined, p: string, what: string): string | undefined {
  if (!p) return `${what} is required.`;
  if (policy) {
    const check = checkPathSandbox(policy, p);
    if (!check.allowed) return `sandbox rejected ${what}: ${check.reason}`;
  }
  return undefined;
}

const line = (s: LibrarySong) =>
  `${s.id} — ${s.title} (${s.category}${s.bpm ? `, ${s.bpm} BPM` : ""}${s.musicalKey ? `, ${s.musicalKey}` : ""}${s.tags.length ? `, tags: ${s.tags.join(", ")}` : ""})${s.collaborators?.length ? ` with ${s.collaborators.map((c) => (c.role ? `${c.name} (${c.role})` : c.name)).join(", ")}` : ""}${s.lyrics ? " [has lyrics]" : " [no lyrics]"}${s.addedBy ? ` — added by ${s.addedBy}` : ""}`;

export async function dispatchLibrary(args: Record<string, unknown>, agentId: string, sandbox: SandboxPolicy | undefined): Promise<Result> {
  const action = String(args.action ?? "");
  try {
    if (action === "list") {
      const songs = await listSongs();
      return { ok: true, output: songs.length ? `${songs.length} uploaded song(s):\n${songs.map(line).join("\n")}` : "No songs have been uploaded to the library yet." };
    }
    if (action === "read") {
      const song = await getSong(String(args.id ?? ""));
      if (!song) return fail(`No song "${String(args.id ?? "")}". Use list to see the ids.`);
      return {
        ok: true,
        output:
          `${line(song)}\n${song.note ? `Note: ${song.note}\n` : ""}Added ${song.date}.\n` +
          (song.lyrics ? `Lyrics:\n${song.lyrics}` : "No lyrics have been written down for this song."),
      };
    }
    if (action === "add") {
      if (!toolVisibleTo(agentId, "read_file")) return fail("Adding a song needs an audio file from disk, and this agent has no file access. Ask an agent that does (delegate to the engineer), or the operator can use Add song in the Beat DB.");
      const source = String(args.path ?? "");
      const bad = checkPath(sandbox, source, "path");
      if (bad) return fail(bad);
      if (!String(args.title ?? "").trim()) return fail("A song needs a title.");
      const stored = await importAudioFromPath(source);
      const song = await addSongBy(
        { title: args.title, category: args.kind, bpm: args.bpm, musicalKey: args.key, tags: args.tags, note: args.note, lyrics: args.lyrics, collaborators: args.collaborators, audioFileId: stored.id },
        agentId,
      );
      return { ok: true, output: `Added to the library: ${line(song)}. It shows in the Beat DB.` };
    }
    if (action === "update") {
      const id = String(args.id ?? "");
      if (!(await getSong(id))) return fail(`No song "${id}". Use list to see the ids.`);
      // Metadata and lyrics only: never the audio or cover, and never a delete.
      const song = await updateSong(id, { title: args.title, category: args.kind, bpm: args.bpm, musicalKey: args.key, tags: args.tags, note: args.note, lyrics: args.lyrics, collaborators: args.collaborators });
      return { ok: true, output: `Updated: ${line(song)}` };
    }
    return fail(`unknown action "${action}": use list, read, add or update (there is no delete; only the operator removes songs)`);
  } catch (err) {
    if (err instanceof LibraryError) return fail(err.message);
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Read-only: what the operator kept in the Sound Lab and the packs built from it. There is no judging or building here. */
export async function dispatchSoundlab(args: Record<string, unknown>): Promise<Result> {
  const action = String(args.action ?? "");
  try {
    if (action === "kept") {
      const kind = isKind(args.kind) ? args.kind : undefined;
      const kept = await listCandidates({ verdict: "accepted", ...(kind ? { kind } : {}) });
      const st = await soundStats();
      const groups = new Map<string, string[]>();
      for (const c of kept) groups.set(c.kind, [...(groups.get(c.kind) ?? []), c.label]);
      const lines = [...groups].map(([k, labels]) => `${k} (${labels.length}): ${labels.join(", ")}`);
      const waiting = Object.entries(st).filter(([k]) => k !== "total" && (!kind || k === kind)).reduce((n, [, v]) => n + v.pending, 0);
      return { ok: true, output: kept.length ? `${kept.length} kept sound(s):\n${lines.join("\n")}\n${waiting} still waiting to be judged. You can't hear them; go by the names.` : `Nothing kept${kind ? ` for ${kind}` : ""} yet. ${waiting} waiting to be judged.` };
    }
    if (action === "packs") {
      const packs = await listPacks();
      if (!packs.length) return { ok: true, output: "No pack has been built yet. Only the operator builds one, from kept sounds." };
      return {
        ok: true,
        output: packs
          .map((p) => `${p.name} (${p.id}), built ${p.createdAt.slice(0, 10)}: ${p.sounds.length} sounds, ${(p.zipBytes / 1048576).toFixed(1)} MB. ${Object.entries(p.counts).map(([k, n]) => `${k} ${n}`).join(", ")}.\n  ${p.sounds.slice(0, 40).map((s) => s.label).join(", ")}${p.sounds.length > 40 ? ", …" : ""}\n  ${p.licenseNote}`)
          .join("\n"),
      };
    }
    return fail(`unknown action "${action}": use kept or packs (only the operator judges sounds and builds packs)`);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function dispatchAudio(args: Record<string, unknown>, sandbox: SandboxPolicy | undefined): Promise<Result> {
  const action = String(args.action ?? "");
  const input = String(args.path ?? "");
  try {
    const badIn = checkPath(sandbox, input, "path");
    if (badIn) return fail(badIn);
    if (action === "info") return { ok: true, output: renderInfo(input, await audioInfo(input)) };
    if (action === "edit") {
      const output = String(args.output ?? "");
      const badOut = checkPath(sandbox, output, "output");
      if (badOut) return fail(badOut);
      const done = await audioEdit(input, output, args as EditParams);
      return { ok: true, output: `Wrote ${done.output}\nApplied: ${done.steps.join(", ")}.\n${renderInfo(done.output, done.info)}` };
    }
    return fail(`unknown action "${action}": use info or edit`);
  } catch (err) {
    if (err instanceof AudioError) return fail(err.message);
    return fail(err instanceof Error ? err.message : String(err));
  }
}
