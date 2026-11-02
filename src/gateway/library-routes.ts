// HTTP routes for the music library (core/library.ts):
//
//   POST   /library/files?name=<label.ext>   raw body → stored file {id, name, size, kind, …}
//   GET    /library/files/:id                the file, with Range support so audio can seek
//   GET    /library/songs                    the catalog
//   POST   /library/songs                    {title, audioFileId, bpm?, musicalKey?, tags?, note?, …}
//   PUT    /library/songs/:id                edit; DELETE removes the song and its files
//
// Operator routes: BaseSpace uses them; agents have no tool for uploading or
// deleting. Uploads stream straight to disk with a size cap; see library.ts.

import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { LibraryError, addSong, deleteSong, getFile, listSongs, storeUpload, updateSong } from "../core/library.js";

interface Helpers {
  readJson: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
}

/** "bytes=a-b" / "bytes=a-" / "bytes=-n" → a byte range, "invalid", or undefined (no/unsupported header: send it all). */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | "invalid" | undefined {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header ?? "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return undefined; // multi-range and junk: ignore, serve whole
  let start: number;
  let end: number;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) return "invalid";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start > end || start >= size ? "invalid" : { start, end };
}

async function serveFile(req: IncomingMessage, res: ServerResponse, id: string, sendJson: Helpers["sendJson"]): Promise<void> {
  const found = await getFile(id);
  if (!found) return sendJson(res, 404, { error: "no such file" });
  const { file } = found;
  const range = parseRange(req.headers.range, file.size);
  const base = {
    "content-type": file.contentType,
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
    "cache-control": "private, max-age=3600",
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
  };
  if (range === "invalid") {
    res.writeHead(416, { ...base, "content-range": `bytes */${file.size}` });
    res.end();
    return;
  }
  const { start, end } = range ?? { start: 0, end: file.size - 1 };
  res.writeHead(range ? 206 : 200, {
    ...base,
    "content-length": end - start + 1,
    ...(range ? { "content-range": `bytes ${start}-${end}/${file.size}` } : {}),
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = createReadStream(found.path, { start, end });
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy()); // the player seeked away or closed
  stream.pipe(res);
}

/** Returns true when the request was a /library route (handled). */
export async function handleLibrary(req: IncomingMessage, res: ServerResponse, segments: string[], url: URL, h: Helpers): Promise<boolean> {
  if (segments[0] !== "library") return false;
  const method = req.method ?? "GET";
  try {
    if (segments[1] === "files") {
      if (method === "POST" && segments.length === 2) {
        const declared = Number(req.headers["content-length"]);
        try {
          h.sendJson(res, 201, await storeUpload(req, { name: url.searchParams.get("name") ?? "", ...(Number.isFinite(declared) && declared > 0 ? { declaredBytes: declared } : {}) }));
        } catch (err) {
          // Refusing before reading a big body: close the connection after the reply
          // instead of making the client finish sending it.
          if (err instanceof LibraryError && err.status !== 400) {
            res.setHeader("connection", "close");
            res.once("finish", () => req.destroy());
          }
          throw err;
        }
        return true;
      }
      if ((method === "GET" || method === "HEAD") && segments.length === 3) {
        await serveFile(req, res, segments[2]!, h.sendJson);
        return true;
      }
    }
    if (segments[1] === "songs") {
      if (method === "GET" && segments.length === 2) {
        h.sendJson(res, 200, { songs: await listSongs() });
        return true;
      }
      if (method === "POST" && segments.length === 2) {
        h.sendJson(res, 201, await addSong(await h.readJson(req)));
        return true;
      }
      if (method === "PUT" && segments.length === 3) {
        h.sendJson(res, 200, await updateSong(decodeURIComponent(segments[2]!), await h.readJson(req)));
        return true;
      }
      if (method === "DELETE" && segments.length === 3) {
        await deleteSong(decodeURIComponent(segments[2]!));
        h.sendJson(res, 200, { ok: true });
        return true;
      }
    }
  } catch (err) {
    if (err instanceof LibraryError) {
      h.sendJson(res, err.status, { error: err.message });
      return true;
    }
    throw err;
  }
  h.sendJson(res, 404, { error: "no such library route" });
  return true;
}
