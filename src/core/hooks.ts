// Deterministic, harness-run hooks — kept strictly separate from the
// model's own judgment. Anything that "must happen" belongs here, not as
// an instruction the model hopefully follows.
//
// Design rule taken from Claude Code's own docs (the clearest articulation
// of this across all six harnesses studied): "the harness runs hooks, not
// the model."

export type HookEvent =
  | "agent.turn.start"
  | "agent.turn.end"
  | "tool.before"
  | "tool.after"
  | "session.start"
  | "session.end"
  | "task.created"
  | "task.completed"
  | "task.failed"
  | "memory.dreaming.start"
  | "memory.dreaming.complete";

export interface HookContext {
  agentId: string;
  sessionId: string;
  payload: Record<string, unknown>;
}

export type HookHandler = (ctx: HookContext) => Promise<HookResult | void>;

export interface HookResult {
  /** Only meaningful for decision hooks (tool.before). Observe-only hooks
   *  (session.start, memory.dreaming.*) ignore this field entirely — an
   *  intentional blast-radius limitation mirroring OpenClaw's split. */
  block?: boolean;
  reason?: string;
}

const registry = new Map<HookEvent, HookHandler[]>();

export function registerHook(event: HookEvent, handler: HookHandler): void {
  const existing = registry.get(event) ?? [];
  existing.push(handler);
  registry.set(event, existing);
}

export async function fireHook(event: HookEvent, ctx: HookContext): Promise<HookResult> {
  const handlers = registry.get(event) ?? [];
  for (const handler of handlers) {
    const result = await handler(ctx);
    if (result?.block) return result;
  }
  return {};
}

export function clearHooks(): void {
  registry.clear();
}
