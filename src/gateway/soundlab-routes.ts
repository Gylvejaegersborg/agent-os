// HTTP routes for the Sound Lab (core/soundlab.ts). Operator routes: BaseSpace's Sound Lab
// page uses them; judging has no agent equivalent.
//
//   POST /soundlab/batches                 {kind, count}   new candidates (steered by what was accepted)
//   GET  /soundlab/candidates?verdict=&kind=               the list (verdict: pending|accepted|maybe|skipped)
//   GET  /soundlab/candidates/:id/audio                    the sound as a 24-bit WAV (Range supported)
//   POST /soundlab/candidates/:id/judge    {verdict}       accept / maybe / skip (or pending, to undo)
//   GET  /soundlab/stats                                    counts per kind and verdict
//   POST /soundlab/packs {name, ids}        build a pack (a zip of 24-bit WAVs, README, license draft, manifest) from KEPT sounds
//   GET  /soundlab/packs, /soundlab/packs/:id, /soundlab/packs/:id/download

import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { createPack, getPack, listPacks, packFile } from "../core/soundpack.js";
import { SoundLabError, generateBatch, isKind, judge, listCandidates, renderCandidateWav, stats, type Verdict } from "../core/soundlab.js";
import { parseRange } from "./library-routes.js";

interface Helpers {
  readJson: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
}

/** Returns true when the request was a /soundlab route (handled). */
export async function handleSoundlab(req: IncomingMessage, res: ServerResponse, segments: string[], url: URL, h: Helpers): Promise<boolean> {
  if (segments[0] !== "soundlab") return false;
  const method = req.method ?? "GET";
  try {
    if (method === "POST" && segments[1] === "batches" && segments.length === 2) {
      const body = await h.readJson(req);
      if (!isKind(body.kind)) throw new SoundLabError(400, "kind is required (808, kick, snare, clap, hat-closed, hat-open, bell, pluck, keys, pad, lead)");
      h.sendJson(res, 201, { candidates: await generateBatch(body.kind, Number(body.count ?? 12)) });
      return true;
    }
    if (method === "GET" && segments[1] === "candidates" && segments.length === 2) {
      const verdict = url.searchParams.get("verdict") as Verdict | null;
      const kind = url.searchParams.get("kind");
      h.sendJson(res, 200, { candidates: await listCandidates({ ...(verdict ? { verdict } : {}), ...(isKind(kind) ? { kind } : {}) }) });
      return true;
    }
    if (segments[1] === "packs") {
      if (method === "POST" && segments.length === 2) {
        const body = await h.readJson(req);
        h.sendJson(res, 201, await createPack(body.name, body.ids));
        return true;
      }
      if (method === "GET" && segments.length === 2) {
        h.sendJson(res, 200, { packs: await listPacks() });
        return true;
      }
      if (method === "GET" && segments.length === 3) {
        const pack = await getPack(segments[2]!);
        if (!pack) throw new SoundLabError(404, "no such pack");
        h.sendJson(res, 200, pack);
        return true;
      }
      if (method === "GET" && segments.length === 4 && segments[3] === "download") {
        const file = await packFile(segments[2]!);
        if (!file) throw new SoundLabError(404, "no such pack");
        res.writeHead(200, { "content-type": "application/zip", "content-disposition": `attachment; filename="${file.name}"`, "x-content-type-options": "nosniff" });
        createReadStream(file.path).on("error", () => res.destroy()).pipe(res);
        return true;
      }
    }
    if (method === "GET" && segments[1] === "stats" && segments.length === 2) {
      h.sendJson(res, 200, await stats());
      return true;
    }
    if (segments[1] === "candidates" && segments.length === 4 && segments[3] === "audio" && (method === "GET" || method === "HEAD")) {
      const made = await renderCandidateWav(segments[2]!);
      if (!made) throw new SoundLabError(404, "no such sound");
      const range = parseRange(req.headers.range, made.wav.length);
      const base = { "content-type": "audio/wav", "accept-ranges": "bytes", "cache-control": "private, max-age=86400, immutable", "x-content-type-options": "nosniff" };
      if (range === "invalid") {
        res.writeHead(416, { ...base, "content-range": `bytes */${made.wav.length}` });
        res.end();
        return true;
      }
      const { start, end } = range ?? { start: 0, end: made.wav.length - 1 };
      res.writeHead(range ? 206 : 200, { ...base, "content-length": end - start + 1, ...(range ? { "content-range": `bytes ${start}-${end}/${made.wav.length}` } : {}) });
      res.end(method === "HEAD" ? undefined : made.wav.subarray(start, end + 1));
      return true;
    }
    if (method === "POST" && segments[1] === "candidates" && segments.length === 4 && segments[3] === "judge") {
      const body = await h.readJson(req);
      h.sendJson(res, 200, await judge(decodeURIComponent(segments[2]!), body.verdict));
      return true;
    }
  } catch (err) {
    if (err instanceof SoundLabError) {
      h.sendJson(res, err.status, { error: err.message });
      return true;
    }
    throw err;
  }
  h.sendJson(res, 404, { error: "no such soundlab route" });
  return true;
}
