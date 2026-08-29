// Standalone tests for the hardened checkSandbox() path-containment check
// (permissions.ts) — proves the fix actually fixes the bug class it was
// written for (absolute-path escapes with no "../" in them) without
// regressing the case the old "../"-substring check already caught.
// Run with: node dist/test-sandbox-hardening.js
//
// NOTE: this only tests the in-process check itself. It says nothing
// about OS-level enforcement — see the "HONEST LIMITATIONS" comment block
// in permissions.ts for what this check does and does not guarantee.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkSandbox, type SandboxPolicy } from "./core/index.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

// A real temp workspace on disk so realpathSync-based symlink resolution
// has something genuine to resolve (this is what "correctly handling
// symlinks" actually requires testing against, not a paper path).
const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-hardening-test-"));
const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-hardening-outside-"));

const policy: SandboxPolicy = {
  filesystemScope: "workspace-only",
  workspaceRoot,
  hardBlocklist: [],
};

async function main(): Promise<void> {
  // --- (a) REGRESSION: classic "../../../etc/passwd"-style traversal is
  // still blocked. This is the case the OLD check already caught — must
  // not regress it. ---
  const traversal = checkSandbox(policy, "cat ../../../etc/passwd");
  assert(!traversal.allowed, "(a) '../../../etc/passwd' traversal is still blocked (regression check)");

  const traversalWin = checkSandbox(policy, "type ..\\..\\..\\Windows\\System32\\config\\SAM");
  assert(!traversalWin.allowed, "(a) Windows-style '..\\..\\' traversal is still blocked (regression check)");

  // --- (b) THE ACTUAL BUG BEING FIXED: an absolute path outside
  // workspaceRoot with NO ".." anywhere in it. The old regex-only check
  // (/\.\.[\\/]/) had nothing to catch this — it would have returned
  // allowed:true. This must now be correctly blocked. ---
  const absoluteEscapeWin = checkSandbox(policy, "type C:\\Windows\\System32\\drivers\\etc\\hosts");
  assert(
    !absoluteEscapeWin.allowed,
    "(b) absolute Windows path outside workspaceRoot with NO '../' is now blocked (the actual bug fixed)",
  );

  const absoluteEscapePosix = checkSandbox(policy, "cat /etc/passwd");
  assert(
    !absoluteEscapePosix.allowed,
    "(b) absolute POSIX-style path outside workspaceRoot with NO '../' is now blocked",
  );

  // MSYS/git-bash style: "/c/Windows/System32" — this scaffold runs on
  // Windows via git-bash, where this is the normal way to spell an
  // absolute path, and it contains no ".." at all.
  const absoluteEscapeMsys = checkSandbox(policy, "cat /c/Windows/System32/config/SAM");
  assert(
    !absoluteEscapeMsys.allowed,
    "(b) MSYS-style absolute path 'C:/Windows/System32' with NO '../' is now blocked",
  );

  // The "sibling directory string-prefix" trap: a naive `.startsWith(root)`
  // check would wrongly ALLOW this, because the string "<root>-evil"
  // starts with "<root>". path.relative-based containment must reject it.
  const siblingEscape = checkSandbox(policy, `cat ${workspaceRoot}-evil/secret.txt`);
  assert(
    !siblingEscape.allowed,
    "(b) sibling dir sharing a string prefix with workspaceRoot (not a real descendant) is blocked",
  );

  // --- (c) A path genuinely inside workspaceRoot is still allowed. ---
  const insideFile = path.join(workspaceRoot, "notes.txt");
  fs.writeFileSync(insideFile, "hello");
  const inside = checkSandbox(policy, `cat ${insideFile}`);
  assert(inside.allowed, "(c) a path genuinely inside workspaceRoot is still allowed");

  const insideRelative = checkSandbox(policy, "cat ./notes.txt");
  // Relative paths resolve against workspaceRoot (see resolveCandidate),
  // so a bare relative reference inside the workspace is also allowed.
  assert(insideRelative.allowed, "(c) a relative path (resolved against workspaceRoot) is still allowed");

  const insideSubdir = path.join(workspaceRoot, "sub", "dir");
  fs.mkdirSync(insideSubdir, { recursive: true });
  const insideNested = checkSandbox(policy, `ls ${path.join(insideSubdir, "file.txt")}`);
  assert(insideNested.allowed, "(c) a nested path inside a workspace subdirectory is still allowed");

  // A command with no path-looking tokens at all (e.g. plain "echo") must
  // not be spuriously blocked.
  const noPaths = checkSandbox(policy, "echo this command is fine");
  assert(noPaths.allowed, "(c) a command with no path-like tokens is allowed (no false positive)");

  // --- (d) Windows-style paths, since this runs on Windows via git-bash. ---
  const winInside = checkSandbox(policy, `type ${workspaceRoot.replace(/\//g, "\\")}\\notes.txt`);
  assert(winInside.allowed, "(d) a Windows backslash-style path genuinely inside workspaceRoot is allowed");

  const winOutside = checkSandbox(policy, "type C:\\Windows\\win.ini");
  assert(!winOutside.allowed, "(d) a Windows backslash-style path outside workspaceRoot is blocked");

  // Case-insensitivity: NTFS is case-insensitive/case-preserving, so a
  // differently-cased-but-identical path inside the workspace must still
  // be recognized as inside on win32.
  if (process.platform === "win32") {
    const upperCased = insideFile.toUpperCase();
    const winCaseInsensitive = checkSandbox(policy, `type ${upperCased}`);
    assert(
      winCaseInsensitive.allowed,
      "(d) a differently-cased path that's still genuinely inside workspaceRoot is allowed (Windows case-insensitivity)",
    );
  } else {
    assert(true, "(d) case-insensitivity check skipped (not running on win32)");
  }

  // --- SYMLINK HANDLING: a symlink planted INSIDE the workspace but
  // pointing OUTSIDE it must be caught via realpathSync, not treated as
  // "inside" just because its own path string is under workspaceRoot. ---
  const symlinkPath = path.join(workspaceRoot, "escape-link");
  let symlinkCreated = false;
  try {
    fs.symlinkSync(outsideDir, symlinkPath, "dir");
    symlinkCreated = true;
  } catch (err) {
    // Creating symlinks on Windows can require elevated privileges/dev
    // mode; if we can't create one in this environment, skip rather than
    // fail the whole suite for an environment limitation unrelated to the
    // logic under test.
    console.log(`ok: symlink escape test skipped (could not create symlink in this environment: ${(err as Error).message})`);
  }
  if (symlinkCreated) {
    const symlinkEscape = checkSandbox(policy, `cat ${path.join(symlinkPath, "outside-file.txt")}`);
    assert(
      !symlinkEscape.allowed,
      "symlink inside workspaceRoot pointing OUTSIDE it is caught via realpathSync (not naively 'inside')",
    );
  }

  // --- workspace-and-temp scope: os.tmpdir() should be allowed in
  // addition to workspaceRoot, but arbitrary other absolute paths still
  // should not be. ---
  const tempScopePolicy: SandboxPolicy = {
    filesystemScope: "workspace-and-temp",
    workspaceRoot,
    hardBlocklist: [],
  };
  const tempFile = path.join(os.tmpdir(), "sandbox-hardening-temp-scope-check.txt");
  const tempAllowed = checkSandbox(tempScopePolicy, `cat ${tempFile}`);
  assert(tempAllowed.allowed, "workspace-and-temp scope allows a path under os.tmpdir()");
  const tempScopeStillBlocksOutside = checkSandbox(tempScopePolicy, "cat C:\\Windows\\System32\\cmd.exe");
  assert(
    !tempScopeStillBlocksOutside.allowed,
    "workspace-and-temp scope still blocks a path outside both workspaceRoot and tmpdir",
  );

  // Cleanup.
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });

  if (process.exitCode === 1) {
    console.error("\nSome sandbox-hardening tests FAILED.");
  } else {
    console.log("\nAll sandbox-hardening tests passed.");
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
