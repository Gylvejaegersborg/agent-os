// Permissions / Sandboxing — TWO deliberately separate layers, per
// docs/architecture.md §6 and Claude Code's own articulation of this (the
// clearest of any harness studied): "permission rules can be circumvented
// by a misleading command string, but the sandbox boundary holds
// regardless of what the model chose to run."
//
//   LAYER A — PermissionPolicy: pre-execution, model-input-based, GAMEABLE.
//   Evaluated as a `tool.before` hook (hooks.ts) — decides allow/ask/deny
//   from the tool NAME and ARGS the model requested. A model that lies
//   about what a command does (e.g. calls `shell` with a command string
//   that looks benign but isn't) can slip past this layer. That's a known,
//   accepted limitation of pre-execution policy — it is not a security
//   boundary by itself.
//
//   LAYER B — SandboxPolicy: enforced by the Worker itself at execution
//   time, independent of what the model claimed the command would do.
//   This is the layer that actually holds.
//
// Do not conflate the two. A system that only implements Layer A and
// calls it "sandboxing" has built something that looks safe and isn't.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerHook, type HookContext, type HookResult } from "./hooks.js";

export type ToolDecision = "allow" | "ask" | "deny";

export interface ToolRule {
  tool: string; // exact tool name, or "*" for a default rule
  decision: ToolDecision;
  /** Optional: only apply this rule when args match (simple substring/regex
   *  test against JSON.stringify(args) — deliberately minimal, matching
   *  this scaffold's "auditable in five minutes" constraint). */
  argsPattern?: RegExp;
  /** Optional short human-readable tag folded into the durable
   *  ApprovalRequest's reason when this rule evaluates to "ask" — lets a
   *  reviewer tell "this needs approval because it touches CI/infra" apart
   *  from the generic "this rule said ask" default, at a glance in the
   *  Approvals tab, without reading the raw args. */
  label?: string;
}

export interface PermissionPolicy {
  agentId: string;
  rules: ToolRule[];
  /** Called when a rule's decision is "ask" — return true to allow, false
   *  to deny, SYNCHRONOUSLY, in this same process, before the tool call
   *  proceeds. Meant for an in-process demo/test that wants an immediate
   *  yes/no without going through the durable approvals.ts flow at all.
   *  When omitted (the default, and what a real deployment should use),
   *  installPermissionPolicy() instead creates a durable ApprovalRequest
   *  via approvals.ts's requestApproval() and blocks the tool call — see
   *  that branch below for why this is the better default. */
  onAsk?: (ctx: HookContext) => Promise<boolean>;
}

function matchRule(toolName: string, args: Record<string, unknown>, rule: ToolRule): boolean {
  if (rule.tool !== "*" && rule.tool !== toolName) return false;
  if (rule.argsPattern && !rule.argsPattern.test(JSON.stringify(args))) return false;
  return true;
}

/** Shared by evaluatePolicy() and installPermissionPolicy() — finds the
 *  first matching rule, if any, so a caller that needs more than just the
 *  decision (e.g. a rule's `label`) doesn't have to re-walk the list. */
function findMatchingRule(policy: PermissionPolicy, toolName: string, args: Record<string, unknown>): ToolRule | undefined {
  return policy.rules.find((rule) => matchRule(toolName, args, rule));
}

/** Evaluates a policy's rules in order — first match wins. No matching
 *  rule at all defaults to "ask" (never silently allow the unspecified
 *  case), matching the safety-first posture of every harness studied. */
export function evaluatePolicy(
  policy: PermissionPolicy,
  toolName: string,
  args: Record<string, unknown>,
): ToolDecision {
  return findMatchingRule(policy, toolName, args)?.decision ?? "ask";
}

/** Wires a PermissionPolicy into the hook system as a `tool.before`
 *  handler — this is Layer A. Call this once per agent/session setup;
 *  every subsequent tool call in the agent loop is evaluated against it
 *  automatically (agent-loop.ts already fires `tool.before` and honors a
 *  `block: true` result). */
export function installPermissionPolicy(policy: PermissionPolicy): void {
  registerHook("tool.before", async (ctx: HookContext): Promise<HookResult | void> => {
    if (ctx.agentId !== policy.agentId) return; // not this agent's policy
    const toolName = String(ctx.payload.name ?? "");
    const args = (ctx.payload.args as Record<string, unknown>) ?? {};
    const decision = evaluatePolicy(policy, toolName, args);

    if (decision === "allow") return;
    if (decision === "deny") {
      return { block: true, reason: `denied by permission policy: tool "${toolName}" is not allowed` };
    }

    // decision === "ask"
    if (policy.onAsk) {
      const allowed = await policy.onAsk(ctx);
      if (!allowed) {
        return { block: true, reason: `denied: tool "${toolName}" requires approval and none was given` };
      }
      return;
    }

    // No synchronous onAsk callback — this is the real path a deployed
    // runtime should use. Rather than auto-denying and losing all record
    // of the request (the old behavior — nothing hangs, but nothing is
    // ever recoverable either), persist a durable ApprovalRequest
    // (approvals.ts) and block THIS call with its id in the reason. The
    // tool call itself is never resumed automatically once approved —
    // that would require pausing this in-process turn indefinitely,
    // which this scaffold deliberately does not do (see session.ts's
    // cancellation model for the primitive that DOES span processes). A
    // caller that wants "retry once approved" issues a new turn/tool call
    // after checking the request's status via getApproval()/listApprovals().
    // Dynamic import avoids a module-init-time circular dependency the
    // same way agent-loop.ts's dispatchTool() does for subagent.js/
    // memory.js — approvals.ts has no need to import permissions.ts, but
    // keeping this edge lazy means adding one never risks a cycle.
    const { requestApproval } = await import("./approvals.js");
    const label = findMatchingRule(policy, toolName, args)?.label;
    const request = await requestApproval({
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      toolName,
      args,
      reason: label ?? `permission policy rule for tool "${toolName}" evaluated to "ask"`,
    });
    return {
      block: true,
      reason:
        `blocked pending approval: tool "${toolName}" requires approval — request ${request.id} has been ` +
        `recorded (status: pending). Call approveRequest()/rejectRequest() (approvals.ts) to resolve it, then ` +
        `issue a new turn/tool call.`,
    };
  });
}

// ---- Layer B: Sandbox ----

export type FilesystemScope = "workspace-only" | "workspace-and-temp" | "unrestricted";

export interface SandboxPolicy {
  filesystemScope: FilesystemScope;
  /** Absolute path considered "the workspace" for workspace-scoped modes. */
  workspaceRoot: string;
  /** Additional absolute paths treated exactly like `workspaceRoot` for
   *  containment purposes — e.g. a second, sibling repo checkout that
   *  doesn't share a useful common ancestor with workspaceRoot (picking
   *  their common ancestor, like "/", would defeat the whole check).
   *  Optional and defaults to none, so every existing single-root caller
   *  is unaffected. */
  additionalRoots?: string[];
  /** Command substrings that are always rejected regardless of anything
   *  else — the hardline blocklist pattern from Hermes' 8-layer model:
   *  a floor beneath even an otherwise-permissive policy. */
  hardBlocklist: RegExp[];
}

export interface SandboxCheckResult {
  allowed: boolean;
  reason?: string;
}

// ---- Path-containment machinery ----
//
// The previous version of this check was `/\.\.[\\/]/.test(command)` — it
// caught "../../../etc/passwd" but completely missed an absolute path with
// no ".." in it at all, e.g. `type C:\Windows\System32\config\SAM` or
// `cat /etc/passwd`. Any absolute-path escape sailed straight through.
// What follows is a real containment check: resolve every path-like token
// in the command to an absolute path (path.resolve), resolve symlinks
// where the target exists (fs.realpathSync) so a symlink planted inside
// the workspace that points outside it doesn't fool the check, and then
// verify the result is actually a descendant of an allowed root rather
// than merely *starting with the right string* (a bare string-prefix
// check would wrongly allow "D:\workspace-evil" against root
// "D:\workspace" — path.relative + a proper ".." test avoids that).
//
// IMPORTANT — HONEST LIMITATIONS, read before trusting this as a security
// boundary:
//   1. This is STILL an in-process string/path check running in the same
//      Node process as the thing it's checking, not OS-level enforcement.
//      It is not Landlock, not Seatbelt, not a container/namespace
//      boundary, not a chroot. Nothing here prevents code with a
//      different execution path (a spawned child process reading its own
//      argv, a script interpreter invoked with `-c`, a compiled binary,
//      raw syscalls) from touching the filesystem directly without ever
//      passing through checkSandbox() at all. A determined attacker with
//      arbitrary code execution *inside* the sandboxed Worker can very
//      plausibly find a gap this does not cover.
//   2. It tokenizes the command with a simple whitespace/quote-aware
//      splitter, not a real shell parser. It does NOT resolve shell
//      variable expansion ($VAR, %VAR%), tilde expansion (~/.ssh/...),
//      command substitution ($(...) or `...`), or redirections built from
//      concatenated fragments. Any of those can smuggle a path past this
//      check's static view of the command string.
//   3. realpathSync-based symlink resolution only covers paths that exist
//      at check time. A TOCTOU race (create/replace a symlink between the
//      check and the actual filesystem operation) is not defended against
//      — there is no atomicity between "we checked" and "the command ran".
//   4. It has no visibility into what a command *actually does* once
//      allowed — e.g. an allowed `node` invocation could itself open
//      arbitrary paths at runtime that were never mentioned in the
//      original command string.
// A real filesystem sandbox needs OS-level enforcement (Landlock on
// Linux, Seatbelt on macOS, a container/namespace boundary, or a
// restricted-token/AppContainer approach on Windows) underneath checks
// like this one. See docs/architecture.md §6. This scaffold's point is to
// prove the LAYER SEPARATION (Layer A vs Layer B) works and to make the
// in-process check meaningfully more correct than a naive "../" grep —
// not to claim it's a production-grade sandbox.

const IS_WIN32 = process.platform === "win32";

/** Matches a git-bash/MSYS-style absolute path such as "/c/Windows/System32"
 *  — a single letter standing in for a drive letter — so it can be
 *  normalized to the native "C:/Windows/System32" form before resolution.
 *  This only applies on win32: on POSIX platforms "/c/..." is just an
 *  ordinary path under a directory literally named "c", and must NOT be
 *  rewritten. Handling this is required because this scaffold runs on
 *  Windows via git-bash, where commands routinely use this path style. */
const MSYS_DRIVE_PATH = /^\/([A-Za-z])(\/.*)?$/;

function normalizeMsysPath(candidate: string): string {
  if (!IS_WIN32) return candidate;
  const m = MSYS_DRIVE_PATH.exec(candidate);
  if (!m) return candidate;
  const drive = m[1].toUpperCase();
  const rest = m[2] ?? "/";
  return `${drive}:${rest}`;
}

/** A very small, deliberately non-exhaustive command tokenizer: splits on
 *  whitespace and common shell metacharacters, honoring single/double
 *  quotes. This is NOT a shell parser (see limitation #2 above) — it's
 *  just enough to pull individual path-looking arguments out of a command
 *  string so each one can be resolved and checked independently. */
function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch) || ch === "|" || ch === "&" || ch === ";" || ch === ">" || ch === "<") {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** A token is worth resolving as a filesystem path if it contains a path
 *  separator or looks like a Windows drive reference ("C:", "C:\", "C:/")
 *  — bare words like "hello" or flags like "-rf" can't escape a root via
 *  path resolution and aren't worth the (harmless but noisy) check. */
function looksLikePath(token: string): boolean {
  return /[\\/]/.test(token) || /^[A-Za-z]:/.test(token);
}

/** Matches a Windows drive-absolute path ("C:\...", "C:/...") regardless
 *  of the HOST platform this check itself is running on. This is
 *  deliberately NOT gated on IS_WIN32: a sandboxed Worker enforcing a
 *  Linux-hosted deployment can still receive a command string containing
 *  a Windows-style path (a model can emit any string it likes), and
 *  Node's path.resolve() only treats "C:\..." as absolute when the
 *  PROCESS itself is running on win32 — on POSIX it silently treats the
 *  drive letter as an ordinary relative path segment, which resolves
 *  *inside* `root` instead of being rejected. That was a live bypass:
 *  see the regression tests in test-sandbox-hardening.ts for (b)/(d).
 */
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;

/** Resolves a path-like token to an absolute path, first normalizing any
 *  MSYS-style drive prefix. Relative tokens resolve against `root`;
 *  absolute tokens (Windows drive paths, UNC paths, POSIX-rooted paths)
 *  resolve to themselves regardless of `root` — which is exactly the case
 *  the old "../"-only check missed entirely. Windows drive-absolute paths
 *  are resolved via posix rules on purpose (see WINDOWS_DRIVE_PATH) so the
 *  check is host-platform-independent instead of only correct when this
 *  process itself happens to run on win32. */
function resolveCandidate(root: string, token: string): string {
  const normalized = normalizeMsysPath(token);
  if (WINDOWS_DRIVE_PATH.test(normalized)) {
    return path.posix.resolve("/" + normalized.replace(/\\/g, "/"));
  }
  return path.resolve(root, normalized);
}

/** Resolves symlinks via fs.realpathSync where the path (or the nearest
 *  existing ancestor of it) actually exists on disk, so a symlink planted
 *  inside the workspace pointing outside it is caught. For paths that
 *  don't exist yet (e.g. a file a command is about to create), walks up
 *  to the nearest existing ancestor, realpath's that, and rejoins the
 *  not-yet-existing suffix — this still correctly resolves symlinks in
 *  the part of the path that does exist. */
function realpathOrNearestExisting(p: string): string {
  const suffix: string[] = [];
  let current = p;
  // Bounded by path depth; a malformed path can't loop forever because
  // path.dirname(current) === current signals we've hit the filesystem
  // root and we bail out below.
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return suffix.length > 0 ? path.join(real, ...suffix.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        // Hit the root without finding anything that exists — fall back
        // to the plain resolved (non-realpath'd) path.
        return p;
      }
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

/** The actual containment test: is `candidate` equal to, or a genuine
 *  descendant of, `root`? Uses path.relative rather than a string-prefix
 *  check specifically to avoid the classic bug where root "D:\workspace"
 *  would wrongly "contain" a sibling directory "D:\workspace-evil" just
 *  because the string happens to start the same way. On Windows, NTFS is
 *  case-insensitive/case-preserving, so the comparison folds case there
 *  (POSIX filesystems are typically case-sensitive and are left as-is). */
function isContained(root: string, candidate: string): boolean {
  const rootReal = realpathOrNearestExisting(path.resolve(root));
  const candReal = realpathOrNearestExisting(candidate);
  const a = IS_WIN32 ? rootReal.toLowerCase() : rootReal;
  const b = IS_WIN32 ? candReal.toLowerCase() : candReal;
  if (a === b) return true;
  const rel = path.relative(a, b);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Checked by a sandbox-aware Worker BEFORE it ever executes a command —
 *  this is what "holds regardless of what the model chose to run" means
 *  in practice: it inspects the actual command being executed, not the
 *  model's stated intent. See worker.ts's createSandboxedShellWorker for
 *  the Worker that actually enforces this.
 *
 *  See the block comment above ("HONEST LIMITATIONS") for exactly what
 *  this check does and does not guarantee — read it before treating this
 *  function as a real security boundary. */
function allowedRootsFor(policy: SandboxPolicy): string[] {
  const allowedRoots = [path.resolve(policy.workspaceRoot), ...(policy.additionalRoots ?? []).map((r) => path.resolve(r))];
  if (policy.filesystemScope === "workspace-and-temp") {
    allowedRoots.push(path.resolve(os.tmpdir()));
  }
  return allowedRoots;
}

export function checkSandbox(policy: SandboxPolicy, command: string): SandboxCheckResult {
  for (const pattern of policy.hardBlocklist) {
    if (pattern.test(command)) {
      return { allowed: false, reason: `blocked by hard blocklist pattern: ${pattern}` };
    }
  }

  if (policy.filesystemScope === "unrestricted") return { allowed: true };

  const allowedRoots = allowedRootsFor(policy);

  for (const token of tokenizeCommand(command)) {
    if (!looksLikePath(token)) continue;
    const resolved = resolveCandidate(policy.workspaceRoot, token);
    const withinAnyRoot = allowedRoots.some((root) => isContained(root, resolved));
    if (!withinAnyRoot) {
      return {
        allowed: false,
        reason:
          `command references a path outside the sandbox's filesystem scope: "${token}" ` +
          `resolves to "${resolved}", which is not inside ${allowedRoots.join(" or ")}`,
      };
    }
  }

  return { allowed: true };
}

/** Same containment check as checkSandbox(), but for a tool that already
 *  hands over a single, explicit target path (read_file/edit_file/
 *  write_file — agent-loop.ts) instead of a raw shell command string to
 *  tokenize. No hardBlocklist check here: those patterns are shaped
 *  around shell syntax (`rm -rf /`, a fork bomb, ...), not meaningful
 *  against a bare path. Everything else — workspaceRoot/additionalRoots/
 *  tmpdir, symlink resolution, case-folding on Windows — is identical. */
export function checkPathSandbox(policy: SandboxPolicy, targetPath: string): SandboxCheckResult {
  if (policy.filesystemScope === "unrestricted") return { allowed: true };
  const allowedRoots = allowedRootsFor(policy);
  const resolved = resolveCandidate(policy.workspaceRoot, targetPath);
  const withinAnyRoot = allowedRoots.some((root) => isContained(root, resolved));
  if (!withinAnyRoot) {
    return {
      allowed: false,
      reason: `path "${targetPath}" resolves to "${resolved}", which is not inside ${allowedRoots.join(" or ")}`,
    };
  }
  return { allowed: true };
}

/** A small set of always-on hardline patterns, mirroring Hermes' non-
 *  overridable blocklist beneath even its most permissive approval mode.
 *  Intentionally short and illustrative, not exhaustive. */
export const DEFAULT_HARD_BLOCKLIST: RegExp[] = [
  /rm\s+-rf\s+\/(?!\S)/, // rm -rf / (root wipe)
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, // fork bomb
  />\s*\/dev\/sd[a-z]/, // writing directly to a raw block device
];
