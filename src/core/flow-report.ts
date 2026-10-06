// One report per flow: what each step was asked, who ran it, what it produced, what it added to BaseSpace, what it
// cost and why it stopped, in one place. It is assembled from records that already exist (the flow, its stored
// definition, the step tasks, and each step's session), so the panels that used to hold a piece each don't have to.

import { getFlow, listTasks } from "./tasks.js";
import { getFlowDefinition } from "./flow-proposals.js";
import { getSessionUsage } from "./agent-loop.js";
import { readStream } from "./eventlog.js";
import { verifierId } from "./watchdog.js";
import type { Task } from "./types.js";

export interface FlowReportAttempt {
  taskId: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  seconds?: number;
  sessionId?: string;
  /** What the agent said at the end (or the error, when it stopped early). */
  result?: string;
  error?: string;
  tokens?: { input: number; output: number };
  toolCalls: { name: string; summary: string; ok: boolean }[];
  /** What it added to BaseSpace (basespace-add calls that worked). */
  added: { kind: string; title: string; folder?: string }[];
}

export interface FlowReportStep {
  id: string;
  agentId?: string;
  goal?: string;
  dependsOn: string[];
  status: string;
  attempts: FlowReportAttempt[];
}

/** The verifier's (Argus) say on this flow: the result of the step(s) he ran, or that he has not been asked yet. */
export interface FlowVerdict {
  agentId: string;
  stepId?: string;
  status: "not-run" | "waiting" | "running" | "done" | "failed";
  text?: string;
  error?: string;
}

export interface FlowReport {
  verdict: FlowVerdict;
  flowId: string;
  title?: string;
  status: string;
  summary?: string;
  proposedBy?: string;
  steps: FlowReportStep[];
  totals: { tokens: { input: number; output: number }; toolCalls: number; added: number; seconds: number };
}

const short = (v: unknown, n = 90) => {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? {});
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

async function attemptOf(task: Task): Promise<FlowReportAttempt> {
  const out = (task.output ?? {}) as { finalContent?: unknown; error?: unknown; sessionId?: unknown };
  const sessionId = typeof out.sessionId === "string" ? out.sessionId : undefined;
  const attempt: FlowReportAttempt = { taskId: task.id, status: task.status, toolCalls: [], added: [] };
  if (task.startedAt) attempt.startedAt = task.startedAt;
  if (task.completedAt) attempt.completedAt = task.completedAt;
  if (task.startedAt && task.completedAt) attempt.seconds = Math.max(0, Math.round((Date.parse(task.completedAt) - Date.parse(task.startedAt)) / 1000));
  if (typeof out.finalContent === "string" && out.finalContent.trim()) attempt.result = out.finalContent.trim();
  if (typeof out.error === "string") attempt.error = out.error;
  if (!sessionId) return attempt;
  attempt.sessionId = sessionId;
  const usage = await getSessionUsage(sessionId);
  if (usage.turnsWithUsage) attempt.tokens = { input: usage.inputTokens, output: usage.outputTokens };
  for (const e of await readStream(`session:${sessionId}`)) {
    if (e.type !== "tool.call.end") continue;
    const p = e.payload as { name?: string; args?: Record<string, unknown>; result?: { ok?: boolean } };
    if (!p.name) continue;
    const ok = p.result?.ok !== false;
    attempt.toolCalls.push({ name: p.name, summary: short(p.args), ok });
    if (p.name === "basespace-add" && ok) {
      const a = p.args ?? {};
      attempt.added.push({ kind: String(a.kind ?? "item"), title: String(a.title ?? a.text ?? "(untitled)"), ...(typeof a.folder === "string" ? { folder: a.folder } : {}) });
    }
  }
  return attempt;
}

export async function buildFlowReport(flowId: string): Promise<FlowReport | undefined> {
  const flow = await getFlow(flowId);
  if (!flow) return undefined;
  const definition = await getFlowDefinition(flowId);
  const tasks = (await listTasks({ flowId })).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const steps: FlowReportStep[] = [];
  for (const s of flow.steps) {
    const def = definition?.steps.find((d) => d.id === s.id);
    const mine = tasks.filter((t) => (t.input as { stepId?: string }).stepId === s.id);
    steps.push({
      id: s.id,
      ...(def?.agentId ? { agentId: def.agentId } : mine[0]?.agentId ? { agentId: mine[0].agentId } : {}),
      ...(def?.goal ? { goal: def.goal } : {}),
      dependsOn: s.dependsOn,
      status: s.status,
      attempts: await Promise.all(mine.map(attemptOf)),
    });
  }
  const totals = { tokens: { input: 0, output: 0 }, toolCalls: 0, added: 0, seconds: 0 };
  for (const st of steps)
    for (const a of st.attempts) {
      totals.tokens.input += a.tokens?.input ?? 0;
      totals.tokens.output += a.tokens?.output ?? 0;
      totals.toolCalls += a.toolCalls.length;
      totals.added += a.added.length;
      totals.seconds += a.seconds ?? 0;
    }
  const verifier = verifierId();
  const vStep = [...steps].reverse().find((st) => st.agentId === verifier);
  const vAttempt = vStep?.attempts.at(-1);
  const verdict: FlowVerdict = !vStep
    ? { agentId: verifier, status: "not-run" }
    : vStep.status === "succeeded" && vAttempt
      ? { agentId: verifier, stepId: vStep.id, status: "done", ...(vAttempt.result ? { text: vAttempt.result } : {}) }
      : vStep.status === "running"
        ? { agentId: verifier, stepId: vStep.id, status: "running" }
        : vStep.status === "queued" || vStep.status === "cancelled"
          ? { agentId: verifier, stepId: vStep.id, status: "waiting" }
          : { agentId: verifier, stepId: vStep.id, status: "failed", ...(vAttempt?.error ? { error: vAttempt.error } : {}), ...(vAttempt?.result ? { text: vAttempt.result } : {}) };
  return {
    flowId,
    verdict,
    ...(flow.title ? { title: flow.title } : {}),
    status: flow.status,
    ...(definition?.summary ? { summary: definition.summary } : {}),
    ...(definition?.proposedBy ? { proposedBy: definition.proposedBy } : {}),
    steps,
    totals,
  };
}
