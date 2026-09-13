// File revision history — ROADMAP.md's "checkpoint / rewind" item,
// SCOPED DOWN honestly rather than attempted in full: this is per-file
// undo for edit_file/write_file, not Claude Code's full "rewind
// conversation + files together to an earlier point." Every successful
// edit_file/write_file call (agent-loop.ts's dispatchFileTool) records
// the file's content immediately BEFORE that mutation — so "what did
// this file look like before the agent touched it" is always
// answerable, and a specific mutation can be undone. What this does
// NOT do: snapshot the conversation itself, understand multi-file
// transactions as one unit, or let you jump to an arbitrary point in a
// session's history — those are the real remaining gap if full
// checkpoint/rewind is ever built; this is the useful, honest subset.

import { appendEvent, project } from "./eventlog.js";
import { generateId } from "./id.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const FILE_REVISIONS_STREAM = "file-revisions";

export interface FileRevision {
  id: string;
  path: string;
  timestamp: string;
  /** Undefined when the file didn't exist before this mutation (a
   *  write_file call that created a brand-new file) — restoring such a
   *  revision means DELETING the file, not writing empty content. */
  previousContent?: string;
  existedBefore: boolean;
  tool: "edit_file" | "write_file" | "restore";
}

/** Records a file's content immediately BEFORE a mutation — called by
 *  dispatchFileTool() (agent-loop.ts) right before it actually writes,
 *  never after (a revision recorded after the fact would be recording
 *  the WRONG state). */
export async function recordFileRevision(input: {
  path: string;
  previousContent?: string;
  existedBefore: boolean;
  tool: FileRevision["tool"];
}): Promise<FileRevision> {
  const id = generateId();
  const timestamp = new Date().toISOString();
  await appendEvent(FILE_REVISIONS_STREAM, "file.revision.recorded", { revisionId: id, timestamp, ...input });
  return { id, timestamp, ...input };
}

async function projectRevisions(): Promise<Map<string, FileRevision>> {
  return project<Map<string, FileRevision>>(FILE_REVISIONS_STREAM, new Map(), (state, event) => {
    if (event.type === "file.revision.recorded") {
      const p = event.payload as any;
      state.set(p.revisionId, {
        id: p.revisionId,
        path: p.path,
        timestamp: p.timestamp,
        previousContent: p.previousContent,
        existedBefore: p.existedBefore,
        tool: p.tool,
      });
    }
    return state;
  });
}

/** Every recorded revision, newest first (most relevant to "what can I
 *  undo right now" first) — optionally filtered to one path. */
export async function listFileRevisions(filterPath?: string): Promise<FileRevision[]> {
  const all = [...(await projectRevisions()).values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return filterPath ? all.filter((r) => r.path === filterPath) : all;
}

export async function getFileRevision(id: string): Promise<FileRevision | undefined> {
  return (await projectRevisions()).get(id);
}

/** Restores a file to exactly what it looked like before the given
 *  revision's mutation — writes `previousContent` back, or deletes the
 *  file entirely when it didn't exist before that mutation. Itself
 *  records a NEW revision first (capturing whatever the file looks like
 *  right now, before the restore overwrites it) — restoring is itself
 *  undoable, same "append, never delete history" posture as everything
 *  else here. Throws if the revision doesn't exist; does NOT check a
 *  SandboxPolicy itself (that's the gateway route's job, same split as
 *  checkPathSandbox() vs. dispatchFileTool() — this module has no
 *  opinion on sandboxing, same as skills.ts's writeSkill()). */
export async function restoreFileRevision(id: string): Promise<FileRevision> {
  const revision = await getFileRevision(id);
  if (!revision) throw new Error(`no such file revision: ${id}`);

  const currentContent = await fs.readFile(revision.path, "utf8").catch(() => undefined);
  await recordFileRevision({
    path: revision.path,
    previousContent: currentContent,
    existedBefore: currentContent !== undefined,
    tool: "restore",
  });

  if (revision.existedBefore) {
    await fs.mkdir(path.dirname(revision.path), { recursive: true });
    await fs.writeFile(revision.path, revision.previousContent ?? "", "utf8");
  } else {
    await fs.rm(revision.path, { force: true });
  }
  return revision;
}
