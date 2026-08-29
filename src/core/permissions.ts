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

import { registerHook, type HookContext, type HookResult } from "./hooks.js";

export type ToolDecision = "allow" | "ask" | "deny";

export interface ToolRule {
  tool: string; // exact tool name, or "*" for a default rule
  decision: ToolDecision;
  /** Optional: only apply this rule when args match (simple substring/regex
   *  test against JSON.stringify(args) — deliberately minimal, matching
   *  this scaffold's "auditable in five minutes" constraint). */
  argsPattern?: RegExp;
}

export interface PermissionPolicy {
  agentId: string;
  rules: ToolRule[];
  /** Called when a rule's decision is "ask" — return true to allow, false
   *  to deny. In a real deployment this prompts the human; the scaffold's
   *  default just denies (see denyOnAsk below) so nothing hangs waiting
   *  for input that will never come in an automated demo/test run. */
  onAsk?: (ctx: HookContext) => Promise<boolean>;
}

function matchRule(toolName: string, args: Record<string, unknown>, rule: ToolRule): boolean {
  if (rule.tool !== "*" && rule.tool !== toolName) return false;
  if (rule.argsPattern && !rule.argsPattern.test(JSON.stringify(args))) return false;
  return true;
}

/** Evaluates a policy's rules in order — first match wins. No matching
 *  rule at all defaults to "ask" (never silently allow the unspecified
 *  case), matching the safety-first posture of every harness studied. */
export function evaluatePolicy(
  policy: PermissionPolicy,
  toolName: string,
  args: Record<string, unknown>,
): ToolDecision {
  for (const rule of policy.rules) {
    if (matchRule(toolName, args, rule)) return rule.decision;
  }
  return "ask";
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
    const allowed = policy.onAsk ? await policy.onAsk(ctx) : false; // default: deny on ask, never hang
    if (!allowed) {
      return { block: true, reason: `denied: tool "${toolName}" requires approval and none was given` };
    }
  });
}

// ---- Layer B: Sandbox ----

export type FilesystemScope = "workspace-only" | "workspace-and-temp" | "unrestricted";

export interface SandboxPolicy {
  filesystemScope: FilesystemScope;
  /** Absolute path considered "the workspace" for workspace-scoped modes. */
  workspaceRoot: string;
  /** Command substrings that are always rejected regardless of anything
   *  else — the hardline blocklist pattern from Hermes' 8-layer model:
   *  a floor beneath even an otherwise-permissive policy. */
  hardBlocklist: RegExp[];
}

export interface SandboxCheckResult {
  allowed: boolean;
  reason?: string;
}

/** Checked by a sandbox-aware Worker BEFORE it ever executes a command —
 *  this is what "holds regardless of what the model chose to run" means
 *  in practice: it inspects the actual command being executed, not the
 *  model's stated intent. See worker.ts's createSandboxedShellWorker for
 *  the Worker that actually enforces this. */
export function checkSandbox(policy: SandboxPolicy, command: string): SandboxCheckResult {
  for (const pattern of policy.hardBlocklist) {
    if (pattern.test(command)) {
      return { allowed: false, reason: `blocked by hard blocklist pattern: ${pattern}` };
    }
  }

  if (policy.filesystemScope === "unrestricted") return { allowed: true };

  // Deliberately simple heuristic checks — a real sandbox enforces this at
  // the OS level (Landlock, Seatbelt, a container boundary), not by
  // pattern-matching a command string. This scaffold's point is to prove
  // the LAYER SEPARATION works, not to ship a production-grade sandbox;
  // see docs/architecture.md §6 for what a real implementation needs.
  const referencesParentDir = /\.\.[\\/]/.test(command);
  if (referencesParentDir) {
    return { allowed: false, reason: "command references a parent directory (../) outside the workspace scope" };
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
