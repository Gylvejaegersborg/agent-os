// Subagents — a NEW isolated agent-loop run inside THIS SAME process,
// using this same harness's own tools/model/skills/permissions. This is
// deliberately the Claude Code model, not the DeepSeek Harness model:
// spawning a subagent means calling our own runTurn() again with a fresh
// session, NOT shelling out to a different CLI product. No second
// application, no external process, no extra install — see
// docs/architecture.md and the harness.ts header comment for the
// (separate, optional) cross-harness delegation primitive that DOES shell
// out, once that gets built.
//
// The defining property, matching Claude Code's own description of this
// primitive (docs/architecture.md's "context isolation" note): the
// PARENT never sees the subagent's full session history — grep output,
// intermediate reasoning, tool call noise all stay inside the child's own
// isolated session stream. Only the final result crosses back to the
// parent. This is why a subagent run is deliberately NOT a call to
// runTurn() reusing the parent's sessionId — it gets its own newSessionId()
// (exactly like scheduler.ts's fireAutomation() and heartbeat.ts's
// startHeartbeat() already do for their own, different reasons).
//
// Every subagent run is a real Task (type: "subagent", parentTaskId set)
// in the same ledger everything else in this scaffold uses — so
// "what did my subagents do, and when" is answered by the same
// listTasks({ parentTaskId }) query as any other Task relationship, not a
// bespoke subagent-tracking structure.

import { createTask, transitionTask } from "./tasks.js";
import { runTurn, newSessionId } from "./agent-loop.js";
import { fireHook } from "./hooks.js";
import type { ModelAdapter } from "./model.js";
import type { Worker } from "./worker.js";
import type { SkillRegistry } from "./skills.js";

export interface SpawnSubagentOptions {
  /** The agent identity the subagent runs as. Usually the SAME agentId as
   *  the parent (it's the same harness instance doing focused work on the
   *  side), but kept as an explicit param rather than implicitly copied
   *  from context — a future multi-agent-identity setup may want a
   *  subagent to run under a different agentId (e.g. a specialized
   *  persona), and this keeps that door open without a breaking change. */
  agentId: string;
  /** The task for the subagent to complete — becomes its first (and,
   *  since maxToolHops bounds it, effectively only meaningfully "seeded")
   *  user message. */
  goal: string;
  model: ModelAdapter;
  worker: Worker;
  skills?: SkillRegistry;
  maxToolHops?: number;
  /** The Task this subagent run is being spawned on behalf of, if any —
   *  becomes the child Task's parentTaskId. Omit for a top-level subagent
   *  spawn (e.g. directly from a chat session, not from within another
   *  Task's execution). */
  parentTaskId?: string;
}

export interface SubagentResult {
  taskId: string;
  sessionId: string;
  finalContent: string;
  toolCalled?: string;
}

/** Spawns and runs a subagent to completion, returning ONLY its final
 *  result — never the child's full session history. Call
 *  getSessionHistory(result.sessionId) yourself (agent-loop.ts) if you
 *  specifically need to inspect the child's full transcript for
 *  debugging; the return value here deliberately mirrors what a parent
 *  agent-loop turn would actually want to consume; dumping the whole
 *  child transcript back into the parent's context defeats the entire
 *  point of context isolation.
 *
 *  Uses the exact same Task lifecycle every other Task-creating primitive
 *  in this codebase uses (queued -> running -> succeeded/failed), so a
 *  subagent run shows up in the ledger identically to a cron firing or a
 *  CLI operation — same audit trail, same listTasks() query surface. */
export async function spawnSubagentTask(opts: SpawnSubagentOptions): Promise<SubagentResult> {
  const task = await createTask({
    type: "subagent",
    agentId: opts.agentId,
    parentTaskId: opts.parentTaskId,
    input: { goal: opts.goal },
  });
  await fireHook("task.created", { agentId: opts.agentId, sessionId: task.id, payload: { task } });
  await transitionTask(task.id, "running");

  const sessionId = newSessionId(); // isolated context — the defining property, see file header
  try {
    const result = await runTurn({
      sessionId,
      agentId: opts.agentId,
      userMessage: opts.goal,
      model: opts.model,
      worker: opts.worker,
      skills: opts.skills,
      maxToolHops: opts.maxToolHops,
    });
    await transitionTask(task.id, "succeeded", { output: { finalContent: result.finalContent } });
    await fireHook("task.completed", { agentId: opts.agentId, sessionId: task.id, payload: { task, result } });
    return { taskId: task.id, sessionId, finalContent: result.finalContent, toolCalled: result.toolCalled };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await transitionTask(task.id, "failed", { output: { error: errorMessage } });
    await fireHook("task.failed", { agentId: opts.agentId, sessionId: task.id, payload: { task, error: err } });
    throw err;
  }
}
