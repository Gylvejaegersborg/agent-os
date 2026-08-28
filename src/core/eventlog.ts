// The Event Log — the one thing every other primitive in this OS is a
// projection over. Deliberately boring: append-only JSONL, one file per
// stream. No database, no framework — the point of this scaffold is that
// you can read every line of it in five minutes.
//
// Design note (see /docs/architecture.md §0): Hermes (SQLite), OpenClaw
// (SQLite+revision), Pi (JSONL trees) and DeepSeek Harness (JSONL/SQLite)
// all converged independently on "session/task/memory state is a
// projection over an append-only log," not separately-maintained tables.
// This file is that principle made literal and minimal.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Event } from "./types.js";
import { generateId } from "./id.js";

const DATA_DIR = process.env.AGENT_OS_DATA_DIR ?? path.join(process.cwd(), "data");
const STREAMS_DIR = path.join(DATA_DIR, "streams");

function streamPath(streamId: string): string {
  // streamId may contain ':' (e.g. "agent:hermes") — keep filenames simple.
  const safe = streamId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(STREAMS_DIR, `${safe}.jsonl`);
}

export async function appendEvent(
  streamId: string,
  type: string,
  payload: Record<string, unknown>,
  causedBy?: string,
): Promise<Event> {
  await mkdir(STREAMS_DIR, { recursive: true });
  const event: Event = {
    id: generateId(),
    streamId,
    type,
    timestamp: new Date().toISOString(),
    payload,
    ...(causedBy ? { causedBy } : {}),
  };
  await appendFile(streamPath(streamId), JSON.stringify(event) + "\n", "utf-8");
  return event;
}

export async function readStream(streamId: string): Promise<Event[]> {
  const file = streamPath(streamId);
  if (!existsSync(file)) return [];
  const raw = await readFile(file, "utf-8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Event);
}

/** The core "projection" primitive: replay a stream's events through a
 *  reducer to derive current state. Session state, Task status, memory
 *  state, skill catalogs — all of them are just this function called with
 *  a different reducer. This is what makes resume/replay/audit free
 *  instead of separately-implemented features. */
export async function project<T>(
  streamId: string,
  initial: T,
  reducer: (state: T, event: Event) => T,
): Promise<T> {
  const events = await readStream(streamId);
  return events.reduce(reducer, initial);
}

/** List every stream id currently on disk — used by the CLI's inspect
 *  commands and by cross-stream projections (e.g. "all tasks for an agent"). */
export async function listStreamIds(): Promise<string[]> {
  if (!existsSync(STREAMS_DIR)) return [];
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(STREAMS_DIR);
  return files
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.replace(/\.jsonl$/, ""));
}
