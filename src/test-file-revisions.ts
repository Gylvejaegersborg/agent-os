// Standalone tests for file revision history (ROADMAP.md's "checkpoint /
// rewind" item, scoped down to per-file undo — see file-revisions.ts's
// own header for exactly what this does and doesn't cover) — proves:
//   1. edit_file records a revision with the PRE-edit content, and
//      restoring it puts the file back exactly as it was.
//   2. write_file over an EXISTING file records existedBefore: true with
//      the old content; write_file creating a BRAND-NEW file records
//      existedBefore: false, and restoring such a revision DELETES the
//      file rather than writing empty content.
//   3. Restoring is itself undoable — it records a new revision before
//      overwriting, so a restore can be reversed too.
//   4. listFileRevisions(path) filters correctly; omitting path returns
//      everything.
//   5. The gateway's GET /files/revisions and POST .../restore work end
//      to end over real HTTP, including the sandbox-containment check
//      on restore.
// Run with: node dist/test-file-revisions.js

import "./test-helpers/isolate.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  runTurn,
  newSessionId,
  createStubWorker,
  listFileRevisions,
  restoreFileRevision,
  createStubModel,
  type ModelAdapter,
  type SandboxPolicy,
} from "./core/index.js";
import { startGateway } from "./gateway/server.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

function modelThatCalls(name: string, args: Record<string, unknown>): ModelAdapter {
  let called = false;
  return {
    id: `always-call-${name}`,
    async complete() {
      if (called) return { content: "done" };
      called = true;
      return { content: `calling ${name}`, toolCall: { name, args } };
    },
  };
}

async function callFileTool(name: string, args: Record<string, unknown>, policy?: SandboxPolicy): Promise<void> {
  await runTurn({
    sessionId: newSessionId(),
    agentId: "file-revisions-test-agent",
    userMessage: `please call ${name}`,
    model: modelThatCalls(name, args),
    worker: createStubWorker(),
    sandboxPolicy: policy,
  });
}

async function testEditFileRevisionAndRestore(sandboxRoot: string): Promise<void> {
  console.log("\n-- 1. edit_file records the pre-edit content; restoring reverses exactly that edit --");
  const target = path.join(sandboxRoot, "edit-target.txt");
  await fs.writeFile(target, "original content\n", "utf8");

  await callFileTool("edit_file", { path: target, old_string: "original", new_string: "EDITED" });
  assert((await fs.readFile(target, "utf8")) === "EDITED content\n", "the edit actually happened");

  const revisions = await listFileRevisions(target);
  const editRevision = revisions.find((r) => r.tool === "edit_file");
  assert(!!editRevision, "an edit_file revision was recorded");
  assert(editRevision?.previousContent === "original content\n", "the revision captured the PRE-edit content");
  assert(editRevision?.existedBefore === true, "existedBefore is true for an edit of an existing file");

  await restoreFileRevision(editRevision!.id);
  assert((await fs.readFile(target, "utf8")) === "original content\n", "restoring puts the file back exactly as it was before the edit");
}

async function testWriteFileOverwriteVsNewFile(sandboxRoot: string): Promise<void> {
  console.log("\n-- 2. write_file over an existing file vs. creating a brand-new one --");
  const existingTarget = path.join(sandboxRoot, "overwrite-target.txt");
  await fs.writeFile(existingTarget, "old content\n", "utf8");
  await callFileTool("write_file", { path: existingTarget, content: "new content\n" });
  const overwriteRevisions = await listFileRevisions(existingTarget);
  assert(overwriteRevisions[0]?.existedBefore === true, "overwriting an existing file records existedBefore: true");
  assert(overwriteRevisions[0]?.previousContent === "old content\n", "the revision captured the old content");

  const newTarget = path.join(sandboxRoot, "brand-new-file.txt");
  await callFileTool("write_file", { path: newTarget, content: "fresh content\n" });
  const newFileRevisions = await listFileRevisions(newTarget);
  assert(newFileRevisions[0]?.existedBefore === false, "creating a brand-new file records existedBefore: false");
  assert(newFileRevisions[0]?.previousContent === undefined, "a brand-new file's revision has no previousContent");

  await restoreFileRevision(newFileRevisions[0]!.id);
  let stillExists = true;
  try {
    await fs.access(newTarget);
  } catch {
    stillExists = false;
  }
  assert(!stillExists, "restoring a brand-new-file revision DELETES the file rather than writing empty content");
}

async function testRestoreIsItselfUndoable(sandboxRoot: string): Promise<void> {
  console.log("\n-- 3. Restoring is itself undoable --");
  const target = path.join(sandboxRoot, "double-undo.txt");
  await fs.writeFile(target, "version A\n", "utf8");
  await callFileTool("edit_file", { path: target, old_string: "version A", new_string: "version B" });

  const afterEdit = await listFileRevisions(target);
  const editRevision = afterEdit.find((r) => r.tool === "edit_file")!;
  await restoreFileRevision(editRevision.id); // back to "version A"
  assert((await fs.readFile(target, "utf8")) === "version A\n", "first restore worked");

  const afterFirstRestore = await listFileRevisions(target);
  const restoreRevision = afterFirstRestore.find((r) => r.tool === "restore")!;
  assert(restoreRevision.previousContent === "version B\n", "the restore itself recorded a revision capturing what it overwrote");

  await restoreFileRevision(restoreRevision.id); // undo the undo -> back to "version B"
  assert((await fs.readFile(target, "utf8")) === "version B\n", "restoring the restore's own revision un-does the undo");
}

async function testListFiltering(sandboxRoot: string): Promise<void> {
  console.log("\n-- 4. listFileRevisions(path) filters correctly --");
  const all = await listFileRevisions();
  const onlyOnePath = await listFileRevisions(path.join(sandboxRoot, "edit-target.txt"));
  assert(all.length > onlyOnePath.length, `filtering by path returns fewer results than the unfiltered list (${onlyOnePath.length} vs ${all.length})`);
  assert(onlyOnePath.every((r) => r.path === path.join(sandboxRoot, "edit-target.txt")), "every filtered result actually matches the requested path");
}

async function testGatewayRoutes(sandboxRoot: string, outsideDir: string): Promise<void> {
  console.log("\n-- 5. GET /files/revisions and POST .../restore over real HTTP --");
  const policy: SandboxPolicy = { filesystemScope: "workspace-only", workspaceRoot: sandboxRoot, hardBlocklist: [] };
  const gateway = await startGateway({ model: createStubModel(), worker: createStubWorker(), sandboxPolicy: policy });
  const base = `http://127.0.0.1:${gateway.port}`;

  try {
    const target = path.join(sandboxRoot, "http-test.txt");
    await fs.writeFile(target, "http original\n", "utf8");
    await callFileTool("edit_file", { path: target, old_string: "original", new_string: "HTTP-EDITED" }, policy);

    const listRes = await fetch(`${base}/files/revisions?path=${encodeURIComponent(target)}`);
    assert(listRes.status === 200, "GET /files/revisions returns 200");
    const { revisions } = (await listRes.json()) as any;
    assert(revisions.length >= 1, "the revision recorded by the turn above shows up over HTTP");
    const revisionId = revisions[0].id;

    const restoreRes = await fetch(`${base}/files/revisions/${revisionId}/restore`, { method: "POST" });
    assert(restoreRes.status === 200, "POST /files/revisions/:id/restore returns 200");
    assert((await fs.readFile(target, "utf8")) === "http original\n", "the restore actually reversed the edit");

    const missingRes = await fetch(`${base}/files/revisions/no-such-id/restore`, { method: "POST" });
    assert(missingRes.status === 404, "restoring an unknown revision id returns 404");

    // A revision whose path is OUTSIDE the gateway's own sandboxPolicy
    // should be rejected at restore time, same as the file tools
    // themselves would reject writing there.
    const outsideTarget = path.join(outsideDir, "outside.txt");
    await fs.writeFile(outsideTarget, "outside original\n", "utf8");
    await callFileTool("edit_file", { path: outsideTarget, old_string: "original", new_string: "EDITED" }); // no policy passed here, so the edit itself succeeds
    const outsideRevisions = await listFileRevisions(outsideTarget);
    const outsideRestoreRes = await fetch(`${base}/files/revisions/${outsideRevisions[0]!.id}/restore`, { method: "POST" });
    assert(outsideRestoreRes.status === 403, "restoring a revision outside the gateway's sandboxPolicy is rejected with 403");
  } finally {
    await gateway.stop();
  }
}

async function main(): Promise<void> {
  const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-os-file-revisions-"));
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-os-file-revisions-outside-"));
  try {
    await testEditFileRevisionAndRestore(sandboxRoot);
    await testWriteFileOverwriteVsNewFile(sandboxRoot);
    await testRestoreIsItselfUndoable(sandboxRoot);
    await testListFiltering(sandboxRoot);
    await testGatewayRoutes(sandboxRoot, outsideDir);
  } finally {
    await fs.rm(sandboxRoot, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }

  if (process.exitCode === 1) {
    console.error("\nSome file-revisions tests FAILED.");
  } else {
    console.log("\nAll file-revisions tests passed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
