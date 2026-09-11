// The Agent Loop — deliberately thin, matching the convergent design
// across all six harnesses studied: "gather context -> take action ->
// verify," turn by turn, until the model stops requesting tool calls.
// Every turn is written to the session's event stream, so resume/replay/
// observability for free (see eventlog.ts).

import { appendEvent, project } from "./eventlog.js";
import { publishEvent } from "./eventbus.js";
import type { ModelAdapter, ModelMessage } from "./model.js";
import type { Worker } from "./worker.js";
import { fireHook } from "./hooks.js";
import { generateId } from "./id.js";
import { SkillRegistry, renderSkillCatalog } from "./skills.js";
import { retrieveMemoryContext } from "./memory.js";
import { getAgentIdentity } from "./identity.js";
import { ensureSession, isSessionCancelled, getSession } from "./session.js";
import { getToolDefinition, withTimeout } from "./tool-registry.js";
import type { ArtifactType } from "./artifacts.js";
import type { EpisodicKind } from "./types.js";

export interface AgentTurnResult {
  sessionId: string;
  finalContent: string;
  toolCalled?: string;
  /** True when this turn stopped early because the Session (session.ts)
   *  was cancelled mid-run rather than completing normally — see
   *  cancelSession()'s doc comment for how a caller triggers this. */
  cancelled?: boolean;
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
  /** When provided, the model can call the `nominate-memory` tool to
   *  propose something worth remembering (see memory.ts's
   *  nominateAgentMemory). This is a BOUNDED voice, not a bypass: the
   *  nomination sits in "pending" state with zero effect on curated
   *  memory until a human explicitly calls approveAgentMemory() or
   *  rejectAgentMemory() — async, since this scaffold has no
   *  synchronous "ask the user right now" mechanism. Omit to disable
   *  nomination for this turn, same opt-in pattern as enableSubagents. */
  enableMemoryNominations?: boolean;
  /** When provided, the model can call the `record-artifact` tool to
   *  attach a produced output (a file it wrote via the shell tool, a
   *  report, a plan, ...) to this Task/Session — see artifacts.ts. The
   *  artifact itself is just a pointer (type + location + metadata);
   *  this scaffold doesn't manage blob storage, so the model is
   *  expected to have already produced the actual content some other
   *  way (typically via the shell tool) before recording it. Omit to
   *  disable artifact recording for this turn, same opt-in pattern as
   *  enableSubagents/enableMemoryNominations. */
  enableArtifacts?: boolean;
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

/** Renders curated memory (MEMORY.md + USER.md) as system-prompt text —
 *  via RETRIEVAL (memory.ts's retrieveMemoryContext), not a full dump.
 *  Below RETRIEVAL_LINE_THRESHOLD lines, everything is still included
 *  (no point filtering a handful of lines, and this keeps a
 *  freshly-started agent's behavior unchanged); above it, only the
 *  lines most relevant to the CURRENT user message are injected. Empty
 *  documents produce empty sections rather than empty-but-labeled ones,
 *  so a fresh agent with no promoted memories yet doesn't inject a
 *  confusing "MEMORY.md: (nothing here)" block into every turn. */
async function renderMemoryContext(agentId: string, queryText: string): Promise<string> {
  const retrieved = await retrieveMemoryContext(agentId, queryText);
  const parts: string[] = [];
  if (retrieved.memoryLines.length > 0) {
    const note = retrieved.usedRetrieval
      ? ` (showing ${retrieved.memoryLines.length} of ${retrieved.memoryTotalLines} most relevant lines)`
      : "";
    parts.push(`# MEMORY.md (durable facts/procedures learned about this work)${note}\n${retrieved.memoryLines.join("\n")}`);
  }
  if (retrieved.userProfileLines.length > 0) {
    const note = retrieved.usedRetrieval
      ? ` (showing ${retrieved.userProfileLines.length} of ${retrieved.userProfileTotalLines} most relevant lines)`
      : "";
    parts.push(`# USER.md (user profile/preferences learned over time)${note}\n${retrieved.userProfileLines.join("\n")}`);
  }
  return parts.join("\n\n");
}

/** Renders the agent's registered identity (identity.ts's persona field)
 *  as system-prompt text — this is the one piece of "who is this agent"
 *  state that lives outside memory/skills/tools. Deliberately OPTIONAL
 *  and ADDITIVE: an agentId with no registered identity (identity.ts's
 *  getAgentIdentity returns undefined) just yields an empty string here,
 *  which systemParts.filter(Boolean) below drops entirely — so a turn
 *  for an unregistered agent produces byte-for-byte the same system
 *  message it did before this wiring existed. Looked up once per turn
 *  (not per hop, unlike memory/skills) since identity doesn't change
 *  mid-turn the way a dreaming pass or a skill file on disk might. */
async function renderIdentityContext(agentId: string): Promise<string> {
  const identity = await getAgentIdentity(agentId);
  if (!identity?.persona) return "";
  return `# Agent Identity\nYou are ${identity.name}. ${identity.persona}`;
}

interface ToolDispatchResult {
  ok: boolean;
  output: string;
  error?: string;
}

async function dispatchTool(
  toolCall: { name: string; args: Record<string, unknown> },
  ctx: {
    worker: Worker;
    skills?: SkillRegistry;
    agentId: string;
    sessionId: string;
    model: ModelAdapter;
    enableSubagents?: boolean;
    enableMemoryNominations?: boolean;
    enableArtifacts?: boolean;
  },
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
  if (toolCall.name === "nominate-memory") {
    if (!ctx.enableMemoryNominations) {
      return { ok: false, output: "", error: "memory nomination is not enabled for this session" };
    }
    const content = String(toolCall.args.content ?? "");
    const kind = String(toolCall.args.kind ?? "fact") as EpisodicKind;
    if (!content) return { ok: false, output: "", error: "nominate-memory tool call missing required 'content' argument" };
    // Dynamic import mirrors the subagent.js pattern above — avoids
    // pulling memory.js's full surface into this file's top-level
    // imports beyond what's already needed for retrieval.
    const { nominateAgentMemory } = await import("./memory.js");
    const nomination = await nominateAgentMemory({ agentId: ctx.agentId, content, kind, sourceSessionId: ctx.sessionId });
    return {
      ok: true,
      output: `Nomination ${nomination.id} recorded as PENDING — it has no effect on memory until a human explicitly approves it.`,
    };
  }
  if (toolCall.name === "record-artifact") {
    if (!ctx.enableArtifacts) {
      return { ok: false, output: "", error: "artifact recording is not enabled for this session" };
    }
    const type = String(toolCall.args.type ?? "other") as ArtifactType;
    const location = String(toolCall.args.location ?? "");
    if (!location) return { ok: false, output: "", error: "record-artifact tool call missing required 'location' argument" };
    const description = typeof toolCall.args.description === "string" ? toolCall.args.description : undefined;
    // Dynamic import mirrors the subagent.js/memory.js pattern above.
    const { createArtifact } = await import("./artifacts.js");
    const session = await getSession(ctx.sessionId);
    const artifact = await createArtifact({
      type,
      location,
      producer: ctx.agentId,
      sessionId: ctx.sessionId,
      taskId: session?.taskId,
      metadata: description ? { description } : {},
    });
    return { ok: true, output: `Artifact ${artifact.id} (${type}) recorded at "${location}".` };
  }
  return { ok: false, output: "", error: `unknown tool: ${toolCall.name}` };
}

export async function runTurn(opts: RunTurnOptions): Promise<AgentTurnResult> {
  const { sessionId, agentId, userMessage, model, worker, skills, enableSubagents, enableMemoryNominations, enableArtifacts } = opts;
  const injectMemory = opts.injectMemory ?? true;
  const maxHops = opts.maxToolHops ?? 3;

  // Registers (or touches) this sessionId in the Session registry
  // (session.ts) — see ensureSession()'s doc comment: existing callers
  // that never pre-created a Session keep working unchanged, and now get
  // a real, listable/cancellable registry entry for free.
  await ensureSession(sessionId, agentId);

  await appendEvent(sessionStream(sessionId), "agent.turn.start", { agentId, userMessage });
  await fireHook("agent.turn.start", { agentId, sessionId, payload: { userMessage } });
  // Published on the real event bus (eventbus.ts), NOT a second/parallel
  // event system — this is what lets an external transport (the gateway,
  // still to be built) expose live runtime activity by subscribing to
  // the SAME event types already recorded in the session stream above,
  // rather than polling the filesystem for changes.
  await publishEvent("agent.turn.start", { sessionId, agentId, userMessage });

  await appendEvent(sessionStream(sessionId), "session.message", { role: "user", content: userMessage });

  let toolCalled: string | undefined;
  let hops = 0;
  let finalContent = "";
  let cancelled = false;

  // Fetched once per turn, outside the hop loop — see renderIdentityContext's
  // own doc comment for why (unlike memory/skills, identity isn't expected
  // to change mid-turn).
  const personaText = await renderIdentityContext(agentId);

  while (hops < maxHops) {
    // Checked at the top of every hop (and again right after tool
    // dispatch below) rather than once before the loop — cancelSession()
    // (session.ts) can be called from a completely different process at
    // any point mid-turn, and this is what makes "cancel a session"
    // actually stop new model calls/tool executions instead of merely
    // being ignored until the turn would have finished anyway.
    if (await isSessionCancelled(sessionId)) {
      cancelled = true;
      break;
    }
    const history = await getSessionHistory(sessionId);
    const catalogText = skills ? renderSkillCatalog(skills.listMetadata()) : "";
    const subagentText = enableSubagents
      ? "You can delegate a focused sub-task to an isolated subagent by calling the `subagent` tool with {goal}. The subagent runs independently and only its final result returns to you — its own reasoning and tool calls stay isolated."
      : "";
    const nominationText = enableMemoryNominations
      ? "You can propose something worth remembering long-term by calling the `nominate-memory` tool with {content, kind}. This does NOT write to memory directly — it creates a pending nomination that a human must explicitly approve before it can ever influence curated memory."
      : "";
    const artifactText = enableArtifacts
      ? "When you produce a real output worth attaching to this task (a file you wrote, a report, a plan), call the `record-artifact` tool with {type, location, description?} to register it. This does not create the content itself — produce it first (e.g. via the shell tool), then record where it lives."
      : "";
    // Re-read fresh every turn (not cached) — see injectMemory's own doc
    // comment for why. Only ever populated by the dreaming pass
    // (memory.ts), never by this turn's own conversation, so a chatty
    // session cannot inject its own unvetted "memory" into itself.
    const memoryText = injectMemory ? await renderMemoryContext(agentId, userMessage) : "";
    // personaText first — "who you are" precedes "what you remember/can do"
    // in the assembled system message, matching how a human-written system
    // prompt would order identity before capability context.
    const systemParts = [personaText, memoryText, catalogText, subagentText, nominationText, artifactText].filter(Boolean);
    const messages: ModelMessage[] = systemParts.length
      ? [{ role: "system", content: systemParts.join("\n\n") }, ...history]
      : history;
    // Prefer real incremental streaming when this model adapter supports
    // it (model.ts's ModelAdapter.completeStream) — publishes each chunk
    // on the real event bus AS IT ARRIVES, not just the final assembled
    // text once the whole call finishes. A model without completeStream
    // behaves exactly as before this existed (plain model.complete()).
    // Deltas are deliberately NOT appended to the durable session stream
    // — they're ephemeral live-progress signal; the one final assembled
    // "session.message" event below remains the durable record, same as
    // always, so the event log doesn't balloon with one entry per token.
    const response = model.completeStream
      ? await model.completeStream(messages, (delta) => {
          publishEvent("agent.turn.delta", { sessionId, agentId, delta }).catch((err) => {
            console.error("[agent-loop] failed to publish turn delta:", err instanceof Error ? err.message : err);
          });
        })
      : await model.complete(messages);

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
      await publishEvent("tool.call.start", { sessionId, agentId, ...response.toolCall });
      // A registered ToolDefinition's timeoutMs (tool-registry.ts) is
      // enforced HERE, at the one call site every tool call passes
      // through — not inside dispatchTool()'s individual branches — so
      // it applies uniformly regardless of which tool ran. Every
      // built-in tool ships with no timeoutMs by default (see
      // BUILTIN_TOOL_DEFINITIONS), so withTimeout() is a true no-op for
      // existing behavior unless a caller explicitly registers one.
      const toolDef = getToolDefinition(response.toolCall.name);
      const result = await withTimeout(
        dispatchTool(response.toolCall, {
          worker,
          skills,
          agentId,
          sessionId,
          model,
          enableSubagents,
          enableMemoryNominations,
          enableArtifacts,
        }),
        toolDef?.timeoutMs,
        () => ({
          ok: false,
          output: "",
          error: `tool "${response.toolCall!.name}" timed out after ${toolDef?.timeoutMs}ms`,
        }),
      );
      await appendEvent(sessionStream(sessionId), "tool.call.end", { ...response.toolCall, result });
      await publishEvent("tool.call.end", { sessionId, agentId, ...response.toolCall, result });
      await fireHook("tool.after", { agentId, sessionId, payload: { ...response.toolCall, result } });

      await appendEvent(sessionStream(sessionId), "session.message", {
        role: "tool",
        content: result.ok ? result.output : `error: ${result.error}`,
      });
      hops++;
      // Re-checked immediately after the tool actually ran (not just at
      // the top of the next hop) so a cancellation that arrives WHILE a
      // tool call is in flight is honored before the next model call is
      // made, rather than one full extra hop later.
      if (await isSessionCancelled(sessionId)) {
        cancelled = true;
        break;
      }
      continue;
    }

    finalContent = response.content;
    await appendEvent(sessionStream(sessionId), "session.message", { role: "assistant", content: finalContent });
    break;
  }

  if (cancelled) {
    finalContent = finalContent || "Turn cancelled before completion.";
    await appendEvent(sessionStream(sessionId), "session.message", {
      role: "assistant",
      content: finalContent,
      cancelled: true,
    });
  }

  await appendEvent(sessionStream(sessionId), "agent.turn.end", { agentId, finalContent, toolCalled, cancelled });
  await fireHook("agent.turn.end", { agentId, sessionId, payload: { finalContent, toolCalled, cancelled } });
  await publishEvent("agent.turn.end", { sessionId, agentId, finalContent, toolCalled, cancelled });

  return { sessionId, finalContent, toolCalled, cancelled: cancelled || undefined };
}

export function newSessionId(): string {
  return generateId();
}
