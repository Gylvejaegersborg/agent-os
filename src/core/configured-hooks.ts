// User-configurable hooks — ROADMAP.md's "user-configurable hooks" item.
// hooks.ts's own hook points (tool.before, session.start, ...) are real
// but only addressable from code you write and redeploy; Claude Code's
// own hooks are a settings file ANY operator can edit without a rebuild.
// This is that settings-file layer: a plain JSON array, each entry
// shelling out to a command when its event fires — no new concept in
// hooks.ts itself, just a loader that turns config into real
// registerHook() calls, the same way gateway/cli.ts's own
// buildEngineerPolicy() turns code into a PermissionPolicy.
//
// Deliberately file-based and restart-required rather than hot-reloadable
// — hooks.ts's registry has no removal-by-source mechanism (clearHooks()
// wipes EVERYTHING, including the gateway's own filesystem-restriction
// and PermissionPolicy hooks, so it's the wrong tool for "just reload my
// configured hooks"). Editing hooks.json and restarting the gateway is
// the honest contract today; the file can be edited directly, or by
// asking the one agent with real file-tool access (gateway/cli.ts's
// ENGINEER_AGENT_ID) to do it.

import { readFile } from "node:fs/promises";
import { exec } from "node:child_process";
import { registerHook, type HookEvent, type HookContext, type HookResult } from "./hooks.js";

export interface ConfiguredHook {
  event: HookEvent;
  /** Shell command to run when this hook fires. Receives the hook's
   *  HookContext as JSON on stdin. Run with a 10s timeout — a hook that
   *  never exits would otherwise hang every matching turn forever. */
  command: string;
  /** Only for tool.before/tool.after: only run this hook when the tool
   *  call's name matches exactly. Omit to run for every tool. Ignored
   *  for every other event (they have no "tool" to match against). */
  matchTool?: string;
  /** Human-readable label for a settings UI — purely cosmetic, never
   *  read by the hook-running logic itself. */
  label?: string;
}

function isHookEvent(value: unknown): value is HookEvent {
  return (
    typeof value === "string" &&
    [
      "agent.turn.start",
      "agent.turn.end",
      "tool.before",
      "tool.after",
      "session.start",
      "session.end",
      "task.created",
      "task.completed",
      "task.failed",
      "memory.dreaming.start",
      "memory.dreaming.complete",
    ].includes(value)
  );
}

/** Parses and validates raw JSON into ConfiguredHook[] — throws with a
 *  specific, actionable message on the first invalid entry rather than
 *  silently dropping it (a silently-dropped hook is a security-relevant
 *  bug waiting to happen: an operator who thinks a tool.before hook is
 *  blocking something, when it was actually never registered at all). */
export function parseConfiguredHooks(raw: string): ConfiguredHook[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`hooks config is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) throw new Error("hooks config must be a JSON array");

  return parsed.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) throw new Error(`hooks config entry ${i} is not an object`);
    const e = entry as Record<string, unknown>;
    if (!isHookEvent(e.event)) throw new Error(`hooks config entry ${i} has an invalid or missing "event"`);
    if (typeof e.command !== "string" || !e.command) throw new Error(`hooks config entry ${i} has an invalid or missing "command"`);
    if (e.matchTool !== undefined && typeof e.matchTool !== "string") throw new Error(`hooks config entry ${i}'s "matchTool" must be a string`);
    if (e.label !== undefined && typeof e.label !== "string") throw new Error(`hooks config entry ${i}'s "label" must be a string`);
    return { event: e.event, command: e.command, matchTool: e.matchTool as string | undefined, label: e.label as string | undefined };
  });
}

const HOOK_TIMEOUT_MS = 10_000;

/** Runs one configured hook's command, feeding it the HookContext as JSON
 *  on stdin. Exit code 0 means "allow" (returns undefined — same as a
 *  hook that has nothing to say); nonzero means "block," with stdout
 *  (trimmed) as the reason shown to the model/operator, falling back to
 *  a generic message if the command printed nothing. A command that
 *  fails to even start (not found, not executable) is treated as a
 *  block too — a hook the operator configured but that's broken should
 *  fail LOUD, not silently behave as if it weren't there. Exit code and
 *  stdout are meaningless for non-decision events (session.start etc.,
 *  whose callers ignore the block field entirely per hooks.ts's own
 *  doc comment) — the command still runs, for whatever side effect it
 *  has, just with nothing paid attention to afterward. */
function runConfiguredHook(hook: ConfiguredHook, ctx: HookContext): Promise<HookResult | void> {
  return new Promise((resolve) => {
    // exec() (not execFile()) deliberately — runs via a real shell
    // (/bin/sh -c), so a configured command can use pipes/args/env the
    // same way worker.ts's createLocalShellWorker() does, rather than
    // being limited to a single bare executable path with no shell
    // features at all.
    const child = exec(hook.command, { timeout: HOOK_TIMEOUT_MS }, (err, stdout) => {
      if (!err) {
        resolve(undefined);
        return;
      }
      const reason = stdout.trim() || `configured hook "${hook.label ?? hook.command}" ${err.killed ? "timed out" : `exited nonzero (${err.code})`}`;
      resolve({ block: true, reason });
    });
    child.stdin?.write(JSON.stringify(ctx));
    child.stdin?.end();
  });
}

/** Reads a hooks.json-shaped file and registers one real hook per entry
 *  — returns the parsed list (for a caller that wants to log/display
 *  what loaded), or an empty array (not an error) when the file doesn't
 *  exist at all, matching skills.ts's discoverSkills()/SkillRegistry's
 *  own "missing config is zero, not a crash" posture. Throws if the file
 *  EXISTS but is malformed — a typo in hooks.json should fail the
 *  gateway's startup loudly, not silently run with zero of the operator's
 *  intended hooks. */
export async function loadConfiguredHooks(configPath: string): Promise<ConfiguredHook[]> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch {
    return [];
  }
  const hooks = parseConfiguredHooks(raw);
  for (const hook of hooks) {
    registerHook(hook.event, async (ctx) => {
      if (hook.matchTool && String(ctx.payload.name ?? "") !== hook.matchTool) return;
      return runConfiguredHook(hook, ctx);
    });
  }
  return hooks;
}
