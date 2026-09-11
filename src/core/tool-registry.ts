// Tool registry — declarative metadata ABOUT the tools dispatchTool()
// (agent-loop.ts) already executes through, kept deliberately separate
// from execution itself. Before this file, "shell"/"skill"/"subagent"/
// "nominate-memory" existed only as string literals matched inside
// dispatchTool()'s if-chain: nothing in the codebase could answer "what
// tools exist," "what arguments does this one take," or "how long should
// this be allowed to run" without reading that function's source. This is
// that missing catalog — the same "one central harness path, formalized
// with metadata" idea the architecture doc's tool-system section
// describes — plus a small, genuinely enforced piece of behavior: a
// registered timeoutMs is applied uniformly at the dispatchTool() call
// site in runTurn(), regardless of which tool ran or how it's implemented
// internally.
//
// Deliberately NOT a plugin system: dispatchTool() is still the one place
// that actually executes a tool call. Registering a ToolDefinition here
// does not make dispatchTool() automatically support a new tool name —
// it only makes an EXISTING tool introspectable and gives it enforceable
// metadata (timeout today; permission/schema hints a gateway can surface
// tomorrow). Wiring an actually-new tool still means adding a branch to
// dispatchTool() itself, same as before this file existed.

export interface ToolInputSchemaProperty {
  type: "string" | "number" | "boolean" | "object";
  description?: string;
  required?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, ToolInputSchemaProperty>;
  /** Maximum time (ms) this tool call is allowed to run before
   *  dispatchTool()'s call site (runTurn(), agent-loop.ts) preempts it
   *  with a timeout error result. Omit for "no timeout enforced" — the
   *  historical/default behavior for every built-in tool below, so
   *  registering a tool (or leaving the built-ins as-is) never changes
   *  existing behavior unless a caller explicitly opts a tool into a
   *  timeout via registerTool(). */
  timeoutMs?: number;
  /** Metadata hint only — NOT itself an enforcement mechanism. The real
   *  permission decision for a tool call is Layer A's PermissionPolicy
   *  (permissions.ts), evaluated independently of whatever this field
   *  says. This exists so a future gateway's tool catalog can flag
   *  "this one is typically dangerous" without duplicating policy logic
   *  here. */
  requiresApproval?: boolean;
}

const registry = new Map<string, ToolDefinition>();

export function registerTool(definition: ToolDefinition): void {
  registry.set(definition.name, definition);
}

export function getToolDefinition(name: string): ToolDefinition | undefined {
  return registry.get(name);
}

export function listToolDefinitions(): ToolDefinition[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Test/ops hook, mirroring clearHooks()/clearEventBusSubscribers() —
 *  resets to the built-in defaults registered below, not to empty, so a
 *  test that clears the registry doesn't also have to re-seed the
 *  built-ins it didn't mean to remove. */
export function resetToolRegistry(): void {
  registry.clear();
  for (const def of BUILTIN_TOOL_DEFINITIONS) registerTool(def);
}

export const BUILTIN_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "shell",
    description: "Runs a shell command through the session's configured Worker.",
    inputSchema: { command: { type: "string", required: true, description: "The shell command to execute." } },
  },
  {
    name: "skill",
    description: "Loads the full body of a named skill (agentskills.io-format, layer-2 progressive disclosure).",
    inputSchema: { name: { type: "string", required: true, description: "The skill's name, as listed in the catalog." } },
  },
  {
    name: "subagent",
    description: "Delegates a focused sub-task to a fresh, isolated agent-loop session.",
    inputSchema: { goal: { type: "string", required: true, description: "The goal for the subagent to accomplish." } },
  },
  {
    name: "nominate-memory",
    description: "Proposes something worth remembering long-term; requires explicit human approval before it affects curated memory.",
    inputSchema: {
      content: { type: "string", required: true, description: "The content being nominated for memory." },
      kind: { type: "string", description: "One of the EpisodicKind values (fact, preference, correction, outcome, skill-candidate)." },
    },
  },
  {
    name: "record-artifact",
    description: "Attaches a produced output (a file, report, plan, ...) to the current Task/Session — does not create the content itself.",
    inputSchema: {
      type: { type: "string", required: true, description: "One of the ArtifactType values (code, file, report, image, dataset, plan, draft, other)." },
      location: { type: "string", required: true, description: "Where the content lives (a path, a URL)." },
      description: { type: "string", description: "Optional human-readable description of the artifact." },
    },
  },
];

for (const def of BUILTIN_TOOL_DEFINITIONS) registerTool(def);

/** Races `promise` against a timer of `timeoutMs`, returning `onTimeout()`'s
 *  result if the timer wins. `timeoutMs` undefined (the default for every
 *  built-in tool above) means no timeout is enforced — `promise` is
 *  returned directly with no race set up at all, so this is a true no-op
 *  for every existing caller that never opted a tool into a timeout. Note:
 *  like any Promise.race-based timeout, the LOSING side (a slow tool call
 *  that got preempted) keeps running in the background — this stops the
 *  CALLER from waiting on it, it does not cancel the underlying work
 *  itself. A Worker/tool that needs genuine cancellation should use
 *  Session's cancellation primitive (session.ts) instead, which this
 *  complements rather than replaces. */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  onTimeout: () => T,
): Promise<T> {
  if (timeoutMs === undefined) return promise;
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  });
  const result = await Promise.race([promise, timeoutPromise]);
  clearTimeout(timer!);
  return result;
}
