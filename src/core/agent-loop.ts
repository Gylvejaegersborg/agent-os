// The Agent Loop — deliberately thin, matching the convergent design
// across all six harnesses studied: "gather context -> take action ->
// verify," turn by turn, until the model stops requesting tool calls.
// Every turn is written to the session's event stream, so resume/replay/
// observability for free (see eventlog.ts).

import { appendEvent, project } from "./eventlog.js";
import type { ModelAdapter, ModelMessage } from "./model.js";
import type { Worker } from "./worker.js";
import { fireHook } from "./hooks.js";
import { generateId } from "./id.js";
import { SkillRegistry, renderSkillCatalog } from "./skills.js";
import { getCuratedMemory } from "./memory.js";

export interface AgentTurnResult {
  sessionId: string;
  finalContent: string;
  toolCalled?: string;
}

export interface RunTurnOptions {
  sessionId: string;
  agentId: string;
  userMessage: string;
  model: ModelAdapter;
  worker: Worker;
  maxToolHops?: number;
  /** Layer-1 progressive disclosure: when provided, every skill's
   *  name+description is injected as a system message each turn (not
   *  stored in the session log — the catalog is external state re-read
   *  fresh each time, mirroring how Claude Code re-injects CLAUDE.md from
   *  disk rather than trusting a stale in-history copy). The model can
   *  then request the `skill` tool to load a specific skill's full body
   *  (layer 2). */
  skills?: SkillRegistry;
  /** When provided, the model can call the `subagent` tool to delegate a
   *  focused sub-task to a fresh, isolated agent-loop session — same
   *  harness, same tools, own context window (see subagent.ts). Omit to
   *  disable delegation for this turn (e.g. a subagent run itself
   *  typically shouldn't recursively spawn more subagents unless you
   *  specifically want that — pass it through deliberately, not by
   *  default, to avoid uncontrolled fan-out). */
  enableSubagents?: boolean;
  /** When true (default), curated memory (MEMORY.md + USER.md,
   *  memory.ts's getCuratedMemory) is re-read from its event stream and
   *  injected as a system message every turn — the actual point of
   *  having a "dreaming"-gated permanent memory at all is that it gets
   *  used, not just computed and left unread. Re-read fresh each turn
   *  (not cached, not stored in session history) so a dreaming pass that
   *  runs mid-conversation is picked up on the very next turn, the same
   *  pattern the skill catalog already uses. Set false to run a turn
   *  with no memory context (e.g. testing eligibility scoring in
   *  isolation without it leaking into unrelated assertions). */
  injectMemory?: boolean;
}

function sessionStream(sessionId: string): string {
  return `session:${sessionId}`;
}

export async function getSessionHistory(sessionId: string): Promise<ModelMessage[]> {
  return project<ModelMessage[]>(sessionStream(sessionId), [], (state, event) => {
    if (event.type === "session.message") {
      state.push(event.payload as unknown as ModelMessage);
    }
    return state;
  });
}

/** Renders curated memory (MEMORY.md + USER.md) as system-prompt text.
 *  Empty documents produce empty sections rather than empty-but-labeled
 *  ones, so a fresh agent with no promoted memories yet doesn't inject a
 *  confusing "MEMORY.md: (nothing here)" block into every turn. */
async function renderMemoryContext(agentId: string): Promise<string> {
  const curated = await getCuratedMemory(agentId);
  const parts: string[] = [];
  if (curated.content.trim()) {
    parts.push(`# MEMORY.md (durable facts/procedures learned about this work)\n${curated.content.trim()}`);
  }
  if (curated.userProfile.trim()) {
    parts.push(`# USER.md (user profile/preferences learned over time)\n${curated.userProfile.trim()}`);
  }
  return parts.join("\n\n");
}

interface ToolDispatchResult {
  ok: boolean;
  output: string;
  error?: string;
}

async function dispatchTool(
  toolCall: { name: string; args: Record<string, unknown> },
  ctx: { worker: Worker; skills?: SkillRegistry; agentId: string; sessionId: string; model: ModelAdapter; enableSubagents?: boolean },
): Promise<ToolDispatchResult> {
  if (toolCall.name === "shell") {
    return ctx.worker.run(String(toolCall.args.command));
  }
  if (toolCall.name === "skill") {
    if (!ctx.skills) return { ok: false, output: "", error: "no skill registry configured for this session" };
    const skillName = String(toolCall.args.name);
    const body = await ctx.skills.loadBody(skillName, { agentId: ctx.agentId, sessionId: ctx.sessionId });
    return body !== undefined
      ? { ok: true, output: body }
      : { ok: false, output: "", error: `no such skill: ${skillName}` };
  }
  if (toolCall.name === "subagent") {
    if (!ctx.enableSubagents) {
      return { ok: false, output: "", error: "subagent delegation is not enabled for this session" };
    }
    // Dynamic import avoids a circular top-level import: subagent.ts
    // itself imports runTurn from this file. Since this is only resolved
    // at call time (not module-init time), the cycle never actually
    // matters at runtime.
    const { spawnSubagentTask } = await import("./subagent.js");
    const goal = String(toolCall.args.goal ?? "");
    if (!goal) return { ok: false, output: "", error: "subagent tool call missing required 'goal' argument" };
    const result = await spawnSubagentTask({
      agentId: ctx.agentId,
      goal,
      model: ctx.model,
      worker: ctx.worker,
      skills: ctx.skills,
      // Subagents don't recursively spawn further subagents by default —
      // see enableSubagents's own doc comment for why.
    });
    return { ok: true, output: result.finalContent };
  }
  return { ok: false, output: "", error: `unknown tool: ${toolCall.name}` };
}

export async function runTurn(opts: RunTurnOptions): Promise<AgentTurnResult> {
  const { sessionId, agentId, userMessage, model, worker, skills, enableSubagents } = opts;
  const injectMemory = opts.injectMemory ?? true;
  const maxHops = opts.maxToolHops ?? 3;

  await appendEvent(sessionStream(sessionId), "agent.turn.start", { agentId, userMessage });
  await fireHook("agent.turn.start", { agentId, sessionId, payload: { userMessage } });

  await appendEvent(sessionStream(sessionId), "session.message", { role: "user", content: userMessage });

  let toolCalled: string | undefined;
  let hops = 0;
  let finalContent = "";

  while (hops < maxHops) {
    const history = await getSessionHistory(sessionId);
    const catalogText = skills ? renderSkillCatalog(skills.listMetadata()) : "";
    const subagentText = enableSubagents
      ? "You can delegate a focused sub-task to an isolated subagent by calling the `subagent` tool with {goal}. The subagent runs independently and only its final result returns to you — its own reasoning and tool calls stay isolated."
      : "";
    // Re-read fresh every turn (not cached) — see injectMemory's own doc
    // comment for why. Only ever populated by the dreaming pass
    // (memory.ts), never by this turn's own conversation, so a chatty
    // session cannot inject its own unvetted "memory" into itself.
    const memoryText = injectMemory ? await renderMemoryContext(agentId) : "";
    const systemParts = [memoryText, catalogText, subagentText].filter(Boolean);
    const messages: ModelMessage[] = systemParts.length
      ? [{ role: "system", content: systemParts.join("\n\n") }, ...history]
      : history;
    const response = await model.complete(messages);

    if (response.toolCall) {
      toolCalled = response.toolCall.name;
      const blockDecision = await fireHook("tool.before", {
        agentId,
        sessionId,
        payload: response.toolCall,
      });
      if (blockDecision.block) {
        finalContent = `Tool call blocked: ${blockDecision.reason ?? "no reason given"}`;
        await appendEvent(sessionStream(sessionId), "session.message", {
          role: "assistant",
          content: finalContent,
        });
        break;
      }

      await appendEvent(sessionStream(sessionId), "tool.call.start", response.toolCall);
      const result = await dispatchTool(response.toolCall, { worker, skills, agentId, sessionId, model, enableSubagents });
      await appendEvent(sessionStream(sessionId), "tool.call.end", { ...response.toolCall, result });
      await fireHook("tool.after", { agentId, sessionId, payload: { ...response.toolCall, result } });

      await appendEvent(sessionStream(sessionId), "session.message", {
        role: "tool",
        content: result.ok ? result.output : `error: ${result.error}`,
      });
      hops++;
      continue;
    }

    finalContent = response.content;
    await appendEvent(sessionStream(sessionId), "session.message", { role: "assistant", content: finalContent });
    break;
  }

  await appendEvent(sessionStream(sessionId), "agent.turn.end", { agentId, finalContent, toolCalled });
  await fireHook("agent.turn.end", { agentId, sessionId, payload: { finalContent, toolCalled } });

  return { sessionId, finalContent, toolCalled };
}

export function newSessionId(): string {
  return generateId();
}
