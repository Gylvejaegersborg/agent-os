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

interface ToolDispatchResult {
  ok: boolean;
  output: string;
  error?: string;
}

async function dispatchTool(
  toolCall: { name: string; args: Record<string, unknown> },
  ctx: { worker: Worker; skills?: SkillRegistry; agentId: string; sessionId: string },
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
  return { ok: false, output: "", error: `unknown tool: ${toolCall.name}` };
}

export async function runTurn(opts: RunTurnOptions): Promise<AgentTurnResult> {
  const { sessionId, agentId, userMessage, model, worker, skills } = opts;
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
    const messages: ModelMessage[] = catalogText
      ? [{ role: "system", content: catalogText }, ...history]
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
      const result = await dispatchTool(response.toolCall, { worker, skills, agentId, sessionId });
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
