// Works the work ledger (core/work.ts): picks up open items, runs each as a
// turn for its assignee in a fresh session, and reports the outcome back to
// whoever asked.
//
// - One item at a time by default (AGENT_OS_WORK_CONCURRENCY) — this runs
//   on modest hardware, and a queue that drains steadily beats five local
//   model calls fighting over one GPU.
// - A paused or over-budget assignee (controls.ts) is skipped; its items
//   wait and are picked up once that lifts.
// - The session inherits the item's focus, so the assignee gets the goal
//   chain; tokens it spends are recorded on the item (agent-loop.ts).
// - If the turn ends without the agent calling `work` (done/blocked/hand-
//   back), the item is completed with the agent's final reply as its result
//   — the reply is the work. A run that throws leaves it blocked with the
//   error, for the operator; a refused turn (paused mid-way) reopens it.
// - Outcomes go back into the requester's conversation as a `[Work]` note
//   (no turn is run on the requester's side — no agent ping-pong).
//
// Disable with AGENT_OS_WORK_RUNNER=off.

import {
  AgentBlockedError,
  agentIsBlocked,
  appendSessionNote,
  blockWork,
  claimWork,
  completeWork,
  createModelForAgent,
  createSession,
  getAgentIdentity,
  getWork,
  listWork,
  reopenWork,
  runTurn,
  subscribeToAllEvents,
  type ModelAdapter,
  type SandboxPolicy,
  type SkillRegistry,
  type WorkView,
  type Worker,
} from "../core/index.js";

export interface WorkRunnerDeps {
  model: ModelAdapter;
  worker: Worker;
  skills?: SkillRegistry;
  sandboxPolicy?: SandboxPolicy;
  enableSubagents?: boolean;
  enableMemoryNominations?: boolean;
  enableArtifacts?: boolean;
  enableBaseSpace?: boolean;
  maxToolHops?: number;
}

export interface WorkRunnerHandle {
  stop: () => void;
  /** Resolves once nothing is running and nothing runnable is queued — for tests. */
  idle: () => Promise<void>;
}

function workPrompt(item: WorkView, requesterName: string): string {
  // A verification's detail is the whole brief (watchdog.ts builds it).
  if (item.kind === "verification") return `[Work] ${requesterName} asked you to verify (work item ${item.id}): ${item.title}\n\n${item.detail ?? ""}`;
  return [
    `[Work] ${requesterName} handed you this (work item ${item.id}): ${item.title}`,
    item.detail ? `\n${item.detail}` : "",
    "\nDo it now. Put what you make where the operator will see it: in BaseSpace with `basespace-add` (a note, todo or project update), " +
      "or in your result itself — not in files (only the builder agent has file tools). When it's finished, call the `work` tool with " +
      "action \"done\" and a short result (what you did, where it is). If you can't: action \"blocked\" with the reason, or \"hand-back\" " +
      "with why (it goes to your manager). You can't cancel work handed to you. If part of it belongs to a teammate, `delegate` that part.",
  ].join("");
}

export function startWorkRunner(deps: WorkRunnerDeps, opts: { intervalMs?: number; concurrency?: number } = {}): WorkRunnerHandle {
  const concurrency = Math.max(1, opts.concurrency ?? Number(process.env.AGENT_OS_WORK_CONCURRENCY ?? 1));
  const active = new Set<string>();
  let stopped = false;
  let ticking = false;
  let idleWaiters: (() => void)[] = [];

  const nameOf = async (id: string) => (id === "operator" ? "The operator" : ((await getAgentIdentity(id))?.name ?? id));

  async function reportBack(id: string, event: string): Promise<void> {
    const item = await getWork(id);
    if (!item?.requestedFromSessionId) return;
    const who = await nameOf(item.assignee);
    const text =
      event === "work.completed" ? `${who} finished "${item.title}": ${item.result}`
      : event === "work.blocked" ? `${who} is blocked on "${item.title}": ${item.blockedReason}`
      : event === "work.reassigned" ? `"${item.title}" was handed to ${await nameOf(item.assignee)}: ${item.notes.at(-1)?.text.replace(/^handed to \S+: /, "") ?? ""}`
      : event === "work.cancelled" ? `"${item.title}" was cancelled.`
      : "";
    if (text) await appendSessionNote(item.requestedFromSessionId, "Work", `${text} (work item ${item.id}${item.totalTokens ? `, ${item.totalTokens} tokens` : ""})`);
  }

  async function run(item: WorkView): Promise<void> {
    active.add(item.id);
    try {
      const session = await createSession({ agentId: item.assignee, title: `Work: ${item.title}`.slice(0, 80), ...(item.focus ? { focus: item.focus } : {}) });
      try {
        await claimWork(item.id, item.assignee, session.id);
      } catch {
        return; // someone else took it, or it changed — nothing to do
      }
      try {
        const model = (await createModelForAgent(item.assignee)) ?? deps.model;
        const result = await runTurn({
          sessionId: session.id,
          agentId: item.assignee,
          userMessage: workPrompt(item, await nameOf(item.requestedBy)),
          model,
          worker: deps.worker,
          skills: deps.skills,
          sandboxPolicy: deps.sandboxPolicy,
          enableSubagents: deps.enableSubagents,
          enableMemoryNominations: deps.enableMemoryNominations,
          enableArtifacts: deps.enableArtifacts,
          enableBaseSpace: deps.enableBaseSpace,
          // A verifier reads and reports — it can't do the work it checks.
          ...(item.kind === "verification"
            ? { onlyTools: ["work", "basespace"], maxToolHops: Math.min(12, (item.verifies?.length ?? 1) + 3) }
            : { maxToolHops: deps.maxToolHops }),
        });
        const after = await getWork(item.id);
        if (after?.status === "in_progress") {
          // The agent didn't call `work` itself: a real answer is the
          // result; a turn that stopped (a refused tool, an approval still
          // pending, out of tool steps) leaves it blocked with why.
          if (result.stopReason === "answered") await completeWork(item.id, item.assignee, result.finalContent || "(finished without a written result)");
          else if (result.stopReason === "cancelled") await reopenWork(item.id, "operator", "the run was cancelled");
          else await blockWork(item.id, "operator", result.finalContent || `the run stopped (${result.stopReason})`);
        }
      } catch (err) {
        const after = await getWork(item.id);
        if (after?.status !== "in_progress") return;
        if (err instanceof AgentBlockedError) await reopenWork(item.id, "operator", `${item.assignee} was ${err.blocked === "paused" ? "paused" : "over budget"} mid-run`);
        else await blockWork(item.id, "operator", `the run failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } catch (err) {
      console.error(`[work-runner] ${item.id}:`, err instanceof Error ? err.message : err);
    } finally {
      active.delete(item.id);
      void tick();
    }
  }

  async function runnable(): Promise<WorkView[]> {
    const open = (await listWork({ status: "open" })).filter((w) => !active.has(w.id)).reverse(); // oldest first
    const out: WorkView[] = [];
    for (const w of open) if (!(await agentIsBlocked(w.assignee))) out.push(w);
    return out;
  }

  async function tick(): Promise<void> {
    if (stopped || ticking) return;
    ticking = true;
    try {
      for (const item of await runnable()) {
        if (active.size >= concurrency) break;
        // One run per assignee at a time: its work items share its model.
        if ([...active].length && (await Promise.all([...active].map((id) => getWork(id)))).some((w) => w?.assignee === item.assignee)) continue;
        void run(item);
      }
    } finally {
      ticking = false;
    }
    if (!active.size && idleWaiters.length && !(await runnable()).length) {
      idleWaiters.forEach((r) => r());
      idleWaiters = [];
    }
  }

  const unsubscribe = subscribeToAllEvents((type, payload) => {
    if (type === "work.created" || type === "work.reassigned" || type === "work.reopened" || type === "agent.resumed") void tick();
    if (type === "work.completed" || type === "work.blocked" || type === "work.reassigned" || type === "work.cancelled") {
      void reportBack(String((payload as { id?: string }).id), type).catch((err) => console.error("[work-runner] report back failed:", err));
    }
  });
  const timer = setInterval(() => void tick(), opts.intervalMs ?? 30_000);
  if (typeof timer.unref === "function") timer.unref();
  void tick();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      unsubscribe();
    },
    idle: () =>
      new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
        void tick();
      }),
  };
}
