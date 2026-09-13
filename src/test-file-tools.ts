// Standalone tests for the structured file-editing tools
// (read_file/edit_file/write_file — agent-loop.ts's dispatchFileTool) —
// the in-process alternative to editing via raw shell redirection. Proves:
//   1. write_file creates a new file (with parent dirs) and read_file
//      reads it back, end to end through a real runTurn() call.
//   2. edit_file's exact old_string/new_string replace: succeeds when
//      old_string occurs exactly once, refuses (no write made) when it's
//      ambiguous or absent, and replace_all handles the "every
//      occurrence" case.
//   3. checkPathSandbox() containment — from permissions.ts, shared with
//      checkSandbox()'s command-tokenizing version — actually gates these
//      tools when a sandboxPolicy is configured, and is a true no-op
//      (today's existing behavior) when one isn't.
// Run with: node dist/test-file-tools.js

import "./test-helpers/isolate.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { runTurn, newSessionId, getSessionHistory, createStubWorker, type ModelAdapter } from "./core/index.js";
import type { SandboxPolicy } from "./core/permissions.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

/** A ModelAdapter that calls ONE tool once, then reports done — the same
 *  shape test-artifacts.ts's alwaysRecordArtifactModel() uses. */
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

/** The tool-result message agent-loop.ts appends right after dispatching
 *  a tool call — role 'tool', content is either the tool's own output or
 *  "error: <message>" on failure. Last message in a single-hop turn. */
async function lastToolMessage(sessionId: string): Promise<string> {
  const history = await getSessionHistory(sessionId);
  const toolMessages = history.filter((m) => m.role === "tool");
  return toolMessages[toolMessages.length - 1]?.content ?? "";
}

async function callFileTool(sandboxRoot: string, name: string, args: Record<string, unknown>, policy?: SandboxPolicy): Promise<string> {
  const sessionId = newSessionId();
  await runTurn({
    sessionId,
    agentId: "file-tools-test-agent",
    userMessage: `please call ${name}`,
    model: modelThatCalls(name, args),
    worker: createStubWorker(),
    sandboxPolicy: policy,
  });
  return lastToolMessage(sessionId);
}

async function testWriteAndReadFile(sandboxRoot: string, policy: SandboxPolicy): Promise<void> {
  console.log("\n-- 1. write_file creates a file (with parent dirs); read_file reads it back --");
  const target = path.join(sandboxRoot, "nested", "new-file.txt");
  const writeResult = await callFileTool(sandboxRoot, "write_file", { path: target, content: "hello from write_file\n" }, policy);
  assert(!writeResult.startsWith("error:"), `write_file succeeded (got: "${writeResult}")`);
  const onDisk = await fs.readFile(target, "utf8");
  assert(onDisk === "hello from write_file\n", "the file's actual content on disk matches what write_file was asked to write");

  const readResult = await callFileTool(sandboxRoot, "read_file", { path: target }, policy);
  assert(readResult === "hello from write_file\n", `read_file returns the real file content (got: "${readResult}")`);
}

async function testEditFile(sandboxRoot: string, policy: SandboxPolicy): Promise<void> {
  console.log("\n-- 2. edit_file's exact old_string/new_string replace --");
  const target = path.join(sandboxRoot, "edit-me.txt");
  await fs.writeFile(target, "alpha\nbeta\nalpha\n", "utf8");

  const ambiguous = await callFileTool(sandboxRoot, "edit_file", { path: target, old_string: "alpha", new_string: "ALPHA" }, policy);
  assert(ambiguous.startsWith("error:") && ambiguous.includes("occurs 2 times"), `a non-unique old_string is refused (got: "${ambiguous}")`);
  assert((await fs.readFile(target, "utf8")) === "alpha\nbeta\nalpha\n", "the file is untouched after the refused ambiguous edit");

  const uniqueEdit = await callFileTool(sandboxRoot, "edit_file", { path: target, old_string: "beta", new_string: "BETA" }, policy);
  assert(!uniqueEdit.startsWith("error:"), `a unique old_string succeeds (got: "${uniqueEdit}")`);
  assert((await fs.readFile(target, "utf8")) === "alpha\nBETA\nalpha\n", "the file reflects exactly the one intended replacement");

  const replaceAll = await callFileTool(sandboxRoot, "edit_file", { path: target, old_string: "alpha", new_string: "ALPHA", replace_all: true }, policy);
  assert(!replaceAll.startsWith("error:"), `replace_all succeeds on a multi-occurrence old_string (got: "${replaceAll}")`);
  assert((await fs.readFile(target, "utf8")) === "ALPHA\nBETA\nALPHA\n", "replace_all replaced every occurrence");

  const notFound = await callFileTool(sandboxRoot, "edit_file", { path: target, old_string: "does-not-exist", new_string: "x" }, policy);
  assert(notFound.startsWith("error:") && notFound.includes("not found"), `an old_string that doesn't appear at all is refused (got: "${notFound}")`);
}

async function testSandboxContainment(sandboxRoot: string, policy: SandboxPolicy, outsideDir: string): Promise<void> {
  console.log("\n-- 3. checkPathSandbox() actually gates these tools when a sandboxPolicy is configured --");
  const outsideTarget = path.join(outsideDir, "escape.txt");

  const rejected = await callFileTool(sandboxRoot, "write_file", { path: outsideTarget, content: "should not land here" }, policy);
  assert(rejected.startsWith("error:") && rejected.includes("sandbox rejected"), `write_file outside the sandbox root is rejected (got: "${rejected}")`);
  let existsAfterRejection = true;
  try {
    await fs.access(outsideTarget);
  } catch {
    existsAfterRejection = false;
  }
  assert(!existsAfterRejection, "the rejected write_file call never actually touched the filesystem outside the sandbox");

  console.log("\n-- 4. No sandboxPolicy configured is a true no-op (today's existing behavior, unchanged) --");
  const unsandboxedResult = await callFileTool(sandboxRoot, "write_file", { path: outsideTarget, content: "allowed with no policy" }, undefined);
  assert(!unsandboxedResult.startsWith("error:"), `the SAME call succeeds when sandboxPolicy is omitted entirely (got: "${unsandboxedResult}")`);
  assert((await fs.readFile(outsideTarget, "utf8")) === "allowed with no policy", "the file was genuinely written when no policy was configured");
}

async function main(): Promise<void> {
  const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-os-file-tools-sandbox-"));
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-os-file-tools-outside-"));
  const policy: SandboxPolicy = { filesystemScope: "workspace-only", workspaceRoot: sandboxRoot, hardBlocklist: [] };

  try {
    await testWriteAndReadFile(sandboxRoot, policy);
    await testEditFile(sandboxRoot, policy);
    await testSandboxContainment(sandboxRoot, policy, outsideDir);
  } finally {
    await fs.rm(sandboxRoot, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }

  if (process.exitCode === 1) {
    console.error("\nSome file-tools tests FAILED.");
  } else {
    console.log("\nAll file-tools tests passed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
