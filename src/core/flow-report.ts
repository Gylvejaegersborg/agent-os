// One report per flow: what each step was asked, who ran it, what it produced, what it added to BaseSpace, what it
// cost and why it stopped, in one place. It is assembled from records that already exist (the flow, its stored
// definition, the step tasks, and each step's session), so the panels that used to hold a piece each don't have to.

import { getFlow, listTasks } from "./tasks.js";
import { getFlowDefinition } from "./flow-proposals.js";
import { getSessionUsage } from "./agent-loop.js";
import { readStream } from "./eventlog.js";
import { verifierId } from "./watchdog.js";
import { loadOverlay } from "./basespace.js";
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
  tokens?: { input: number; output: number; cached?: number };
  toolCalls: { name: string; summary: string; ok: boolean }[];
  /** What it added to BaseSpace (basespace-add calls that worked). */
  added: { kind: string; title: string; folder?: string }[];
  /** Notes it changed in place (edit/append), with how many changes. */
  edited: { note: string; changes: number }[];
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

/** The direct summary of a flow: what each agent did, and what is left to do. Built by code from the records (not written by a model),
 *  and checked against the live BaseSpace overlay, so a note or todo that has since been deleted is not listed. */
export interface FlowOutcome {
  headline: string;
  byAgent: {
    agentId: string;
    steps: { id: string; status: string }[];
    notes: { title: string; folder?: string; edited: boolean }[];
    todos: { id: string; title: string; open: boolean; answer?: string }[];
    /** The start of what the agent reported, in its own words (not verified). */
    said?: string;
  }[];
  /** What still needs doing: steps that stopped or never ran, a missing verification, and the open todos this flow created. */
  toDo: { kind: "step" | "review" | "todo"; text: string; detail?: string; todoId?: string }[];
}

export interface FlowReport {
  outcome: FlowOutcome;
  verdict: FlowVerdict;
  flowId: string;
  title?: string;
  status: string;
  summary?: string;
  proposedBy?: string;
  steps: FlowReportStep[];
  totals: { tokens: { input: number; output: number; cached: number }; toolCalls: number; added: number; seconds: number };
}

const short = (v: unknown, n = 90) => {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? {});
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

async function attemptOf(task: Task): Promise<FlowReportAttempt> {
  const out = (task.output ?? {}) as { finalContent?: unknown; error?: unknown; sessionId?: unknown };
  const sessionId = typeof out.sessionId === "string" ? out.sessionId : undefined;
  const attempt: FlowReportAttempt = { taskId: task.id, status: task.status, toolCalls: [], added: [], edited: [] };
  if (task.startedAt) attempt.startedAt = task.startedAt;
  if (task.completedAt) attempt.completedAt = task.completedAt;
  if (task.startedAt && task.completedAt) attempt.seconds = Math.max(0, Math.round((Date.parse(task.completedAt) - Date.parse(task.startedAt)) / 1000));
  if (typeof out.finalContent === "string" && out.finalContent.trim()) attempt.result = out.finalContent.trim();
  if (typeof out.error === "string") attempt.error = out.error;
  if (!sessionId) return attempt;
  attempt.sessionId = sessionId;
  const usage = await getSessionUsage(sessionId);
  if (usage.turnsWithUsage) attempt.tokens = { input: usage.inputTokens, output: usage.outputTokens, ...(usage.cachedInputTokens ? { cached: usage.cachedInputTokens } : {}) };
  for (const e of await readStream(`session:${sessionId}`)) {
    if (e.type !== "tool.call.end") continue;
    const p = e.payload as { name?: string; args?: Record<string, unknown>; result?: { ok?: boolean } };
    if (!p.name) continue;
    const ok = p.result?.ok !== false;
    attempt.toolCalls.push({ name: p.name, summary: short(p.args), ok });
    if (p.name === "basespace-add" && ok && (Array.isArray(p.args?.edit) || typeof p.args?.append === "string")) {
      const a = p.args ?? {};
      const changes = (Array.isArray(a.edit) ? a.edit.length : 0) + (typeof a.append === "string" && a.append.trim() ? 1 : 0);
      attempt.edited.push({ note: String(a.title ?? a.id ?? "(note)"), changes });
    } else if (p.name === "basespace-add" && ok) {
      const a = p.args ?? {};
      attempt.added.push({ kind: String(a.kind ?? "item"), title: String(a.title ?? a.text ?? "(untitled)"), ...(typeof a.folder === "string" ? { folder: a.folder } : {}) });
    }
  }
  return attempt;
}

const oneLine = (text: string, n = 260) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

async function buildOutcome(steps: FlowReportStep[], verdict: FlowVerdict): Promise<FlowOutcome> {
  const overlay = await loadOverlay();
  const liveNotes = new Map(overlay.notes.map((n) => [String(n.title ?? ""), n]));
  const liveTodos = new Map(overlay.tasks.map((t) => [String(t.title ?? ""), t]));
  const agents = new Map<string, FlowOutcome["byAgent"][number]>();
  const toDo: FlowOutcome["toDo"] = [];

  for (const st of steps) {
    const agentId = st.agentId ?? "?";
    const entry = agents.get(agentId) ?? { agentId, steps: [], notes: [], todos: [] };
    agents.set(agentId, entry);
    entry.steps.push({ id: st.id, status: st.status });
    for (const a of st.attempts) {
      for (const x of a.added) {
        if (x.kind === "note" && liveNotes.has(x.title) && !entry.notes.some((n) => n.title === x.title)) entry.notes.push({ title: x.title, ...(x.folder ? { folder: x.folder } : {}), edited: false });
        if (x.kind === "todo" && liveTodos.has(x.title) && !entry.todos.some((t) => t.title === x.title)) { const lt = liveTodos.get(x.title)!; entry.todos.push({ id: String(lt.id), title: x.title, open: String(lt.status) !== "done", ...(typeof lt.answer === "string" && lt.answer ? { answer: lt.answer } : {}) }); }
      }
      for (const e of a.edited) {
        const existing = entry.notes.find((n) => n.title === e.note);
        if (existing) existing.edited = true;
        else if (liveNotes.has(e.note)) entry.notes.push({ title: e.note, edited: true });
      }
    }
    const last = [...st.attempts].reverse().find((a) => a.status === "succeeded") ?? st.attempts.at(-1);
    if (last?.result && st.status === "succeeded") entry.said = [entry.said, `${st.id}: ${oneLine(last.result)}`].filter(Boolean).join("  ·  ");

    const err = st.attempts.at(-1)?.error;
    if (["failed", "timed_out", "lost"].includes(st.status)) toDo.push({ kind: "step", text: `Step "${st.id}" (${agentId}) stopped before it finished`, ...(err ? { detail: err } : {}) });
    else if (st.status === "cancelled") toDo.push({ kind: "step", text: `Step "${st.id}" (${agentId}) did not run`, detail: "a step it depends on did not finish, or the flow was cancelled" });
    else if (st.status === "queued") toDo.push({ kind: "step", text: `Step "${st.id}" (${agentId}) has not started` });
    else if (st.status === "running") toDo.push({ kind: "step", text: `Step "${st.id}" (${agentId}) is still running` });
  }

  if (verdict.status === "not-run") toDo.push({ kind: "review", text: "Nobody has verified this flow", detail: `it has no step for ${verdict.agentId}` });
  else if (verdict.status === "waiting") toDo.push({ kind: "review", text: `${verdict.agentId}'s check is waiting for the steps before it` });
  else if (verdict.status === "running") toDo.push({ kind: "review", text: `${verdict.agentId} is checking now` });
  else if (verdict.status === "failed") toDo.push({ kind: "review", text: `${verdict.agentId}'s check stopped before it finished`, ...(verdict.error ? { detail: verdict.error } : {}) });

  const all = [...agents.values()];
  for (const a of all) for (const t of a.todos) if (t.open) toDo.push({ kind: "todo", text: t.title, detail: `added by ${a.agentId}`, todoId: t.id });

  const done = steps.filter((x) => x.status === "succeeded").length;
  const notes = all.reduce((n, a) => n + a.notes.length, 0);
  const todos = all.reduce((n, a) => n + a.todos.length, 0);
  const open = all.reduce((n, a) => n + a.todos.filter((t) => t.open).length, 0);
  return {
    headline: `${done} of ${steps.length} steps done · ${notes} note${notes === 1 ? "" : "s"} written or changed · ${todos} todo${todos === 1 ? "" : "s"} created (${open} still open)`,
    byAgent: all,
    toDo,
  };
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
  const totals = { tokens: { input: 0, output: 0, cached: 0 }, toolCalls: 0, added: 0, seconds: 0 };
  for (const st of steps)
    for (const a of st.attempts) {
      totals.tokens.input += a.tokens?.input ?? 0;
      totals.tokens.output += a.tokens?.output ?? 0;
      totals.tokens.cached += a.tokens?.cached ?? 0;
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
    outcome: await buildOutcome(steps, verdict),
    verdict,
    ...(flow.title ? { title: flow.title } : {}),
    status: flow.status,
    ...(definition?.summary ? { summary: definition.summary } : {}),
    ...(definition?.proposedBy ? { proposedBy: definition.proposedBy } : {}),
    steps,
    totals,
  };
}
