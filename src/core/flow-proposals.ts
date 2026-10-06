// Leaders design flows; Argus checks them; the operator approves.
//
// `propose-flow` (governance.ts gates it like `propose-plan`: always the Approvals queue,
// never always-allowed, only leads are offered it). A flow is a small graph of steps, each
// for one agent, with dependencies. Independent steps run in parallel, dependent ones wait,
// and a step is told what the steps it depends on produced.
//
// Argus's part is a check, by code, before anything reaches the operator:
//   - errors (the lead must fix them; nothing is filed): no steps, too many, duplicate or bad
//     ids, unknown agents, unknown or circular dependencies, steps that don't say what to
//     produce, agents that are paused or over budget, a goal that isn't in BaseSpace.
//   - notes (shown to the operator with the request): ways to work better. A long chain with
//     no parallelism, several endings nobody combines, one agent holding many parallel steps,
//     no review step in a bigger flow.
// The checks are code, not a model's opinion, same principle as the watchdog: Argus is named
// as the checker because it is the team's verifier, and the result is recorded as an event.
//
// Once approved the flow is stored (its definition, not just its shape), started in the
// background with every step on its own agent's model, and the result is posted back to the
// session that proposed it.

import { appendEvent, project } from "./eventlog.js";
import { publishEvent } from "./eventbus.js";
import { getAgentControlState } from "./controls.js";
import { listAgentIdentities } from "./identity.js";
import { loadSnapshot } from "./basespace.js";
import { verifierId } from "./watchdog.js";
import type { DriveFlowOptions, FlowStepDefinition } from "./flow-engine.js";
import type { SessionFocus } from "./types.js";

export const MAX_FLOW_STEPS = 10;
export const MAX_FLOW_RETRIES = 2;
const ID_RE = /^[a-z][a-z0-9-]{0,30}$/;
const DEFINITIONS_STREAM = "flow-definitions";
const GOVERNANCE_STREAM = "governance";

export interface FlowIssue {
  level: "error" | "note";
  stepId?: string;
  message: string;
}

export interface FlowCheck {
  steps: FlowStepDefinition[];
  goalId?: string;
  goalTitle?: string;
  issues: FlowIssue[];
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function parseSteps(raw: unknown): unknown[] | string {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return "steps must be a list of {id, agent, goal, dependsOn?, retries?}";
    }
  }
  return Array.isArray(v) && v.length ? v : "a flow needs at least one step";
}

/** Argus's check of a flow proposal. Never throws; everything wrong comes back as issues. */
export async function validateFlow(args: Record<string, unknown>, proposedBy: string, sessionFocus?: SessionFocus): Promise<FlowCheck> {
  const issues: FlowIssue[] = [];
  const err = (message: string, stepId?: string) => issues.push({ level: "error", message, ...(stepId ? { stepId } : {}) });
  const note = (message: string, stepId?: string) => issues.push({ level: "note", message, ...(stepId ? { stepId } : {}) });

  const raw = parseSteps(args.steps);
  if (typeof raw === "string") {
    err(raw);
    return { steps: [], issues };
  }
  if (raw.length > MAX_FLOW_STEPS) {
    err(`a flow has at most ${MAX_FLOW_STEPS} steps (this has ${raw.length}): split it`);
    return { steps: [], issues };
  }

  const known = new Map((await listAgentIdentities()).map((a) => [a.id, a]));
  const steps: FlowStepDefinition[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const o = (item ?? {}) as Record<string, unknown>;
    const id = str(o.id).toLowerCase();
    const agentId = str(o.agent) || str(o.agentId);
    const goal = str(o.goal);
    const dependsOn = Array.isArray(o.dependsOn) ? o.dependsOn.map((d) => str(d).toLowerCase()).filter(Boolean) : [];
    const retries = o.retries === undefined ? 0 : Number(o.retries);
    if (!ID_RE.test(id)) {
      err(`step id "${id}" must be lowercase letters, digits and dashes, starting with a letter`);
      continue;
    }
    if (seen.has(id)) {
      err(`two steps are called "${id}"`, id);
      continue;
    }
    seen.add(id);
    if (!known.has(agentId)) err(`no agent "${agentId}"`, id);
    if (goal.length < 20) err("say what this step should produce (a sentence or two)", id);
    if (!Number.isInteger(retries) || retries < 0 || retries > MAX_FLOW_RETRIES) err(`retries must be 0 to ${MAX_FLOW_RETRIES}`, id);
    steps.push({ id, agentId, goal, dependsOn, retries: Number.isInteger(retries) ? Math.min(Math.max(retries, 0), MAX_FLOW_RETRIES) : 0 });
  }

  for (const s of steps) {
    for (const d of s.dependsOn ?? []) {
      if (d === s.id) err("a step can't depend on itself", s.id);
      else if (!seen.has(d)) err(`depends on "${d}", which isn't a step`, s.id);
    }
  }

  // Cycles (Kahn): whatever can't be ordered is part of one.
  const indegree = new Map(steps.map((s) => [s.id, (s.dependsOn ?? []).filter((d) => seen.has(d) && d !== s.id).length]));
  const level = new Map<string, number>();
  const queue = steps.filter((s) => indegree.get(s.id) === 0);
  queue.forEach((s) => level.set(s.id, 0));
  let ordered = 0;
  while (queue.length) {
    const cur = queue.shift()!;
    ordered++;
    for (const s of steps) {
      if (!(s.dependsOn ?? []).includes(cur.id)) continue;
      level.set(s.id, Math.max(level.get(s.id) ?? 0, (level.get(cur.id) ?? 0) + 1));
      indegree.set(s.id, indegree.get(s.id)! - 1);
      if (indegree.get(s.id) === 0) queue.push(s);
    }
  }
  const cyclic = ordered < steps.length;
  if (cyclic) err(`steps ${steps.filter((s) => (indegree.get(s.id) ?? 0) > 0).map((s) => s.id).join(", ")} wait on each other in a circle, so none could ever start`);

  // Who's actually able to work right now.
  for (const id of new Set(steps.map((s) => s.agentId).filter((a) => known.has(a)))) {
    const state = await getAgentControlState(id);
    if (state.blocked === "paused") err(`${id} is paused`, steps.find((s) => s.agentId === id)?.id);
    else if (state.blocked === "budget") err(`${id} has used its token budget`, steps.find((s) => s.agentId === id)?.id);
  }

  // The goal it serves.
  const goalId = str(args.goalId) || (sessionFocus?.kind === "goal" ? sessionFocus.id : "");
  let goalTitle: string | undefined;
  if (goalId) {
    const goals: any[] = ((await loadSnapshot()) ?? {}).goals ?? [];
    const goal = goals.find((g) => g.id === goalId);
    if (goals.length && !goal) err(`no goal "${goalId}" in BaseSpace`);
    if (goal) goalTitle = String(goal.title);
  } else {
    note("it isn't tied to a goal, so nothing links its results back to what the work is for");
  }

  // Ways to make it better (only meaningful for a flow that is otherwise sound).
  if (!issues.some((i) => i.level === "error") && steps.length >= 3) {
    const depth = Math.max(...steps.map((s) => level.get(s.id) ?? 0)) + 1;
    if (depth === steps.length && steps.length >= 4) note(`all ${steps.length} steps run strictly one after another; if any don't need the previous one's result, let them run in parallel`);
    const ends = steps.filter((s) => !steps.some((t) => (t.dependsOn ?? []).includes(s.id)));
    if (ends.length > 1) note(`${ends.length} steps (${ends.map((s) => s.id).join(", ")}) have nothing after them, so nobody combines their results`);
    const byLevel = new Map<number, Map<string, number>>();
    for (const s of steps) {
      const m = byLevel.get(level.get(s.id) ?? 0) ?? new Map<string, number>();
      m.set(s.agentId, (m.get(s.agentId) ?? 0) + 1);
      byLevel.set(level.get(s.id) ?? 0, m);
    }
    for (const m of byLevel.values()) for (const [agent, n] of m) if (n >= 3) note(`${agent} has ${n} steps running at once; they'd compete for one agent`);
    if (!steps.some((s) => s.agentId === verifierId())) note(`no step for ${verifierId()}: a flow of ${steps.length} steps usually wants a review at the end`);
  }
  return { steps, ...(goalId ? { goalId } : {}), ...(goalTitle ? { goalTitle } : {}), issues: issues.filter((i) => i.message) };
}

export function renderIssues(issues: FlowIssue[]): string {
  return issues.map((i) => `${i.level === "error" ? "✗" : "•"} ${i.stepId ? `${i.stepId}: ` : ""}${i.message}`).join("; ");
}

/** The one line the operator sees with the request: Argus's verdict. */
export function argusVerdict(check: FlowCheck): string {
  const notes = check.issues.filter((i) => i.level === "note");
  return `${verifierId()} checked it: ${notes.length ? `${notes.length} note${notes.length === 1 ? "" : "s"} — ${renderIssues(notes)}` : "no problems found"}.`;
}

/** What's wrong with a flow proposal, checked BEFORE it's filed. Undefined = fine to file. */
export async function checkFlowProposal(args: Record<string, unknown>, agentId: string, sessionFocus?: SessionFocus): Promise<string | undefined> {
  const check = await validateFlow(args, agentId, sessionFocus);
  const errors = check.issues.filter((i) => i.level === "error");
  if (!errors.length) return undefined;
  await appendEvent(GOVERNANCE_STREAM, "flow.validated", { proposedBy: agentId, validator: verifierId(), ok: false, errors: errors.length });
  return `${verifierId()} found problems: ${renderIssues(errors)}`;
}

/** The operator-facing reason line for the Approvals queue. */
export async function flowGateReason(args: Record<string, unknown>, agentId: string, sessionFocus?: SessionFocus): Promise<string> {
  const check = await validateFlow(args, agentId, sessionFocus);
  const steps = check.steps;
  const agents = [...new Set(steps.map((s) => s.agentId))];
  return (
    `Flow: ${agentId} proposes ${steps.length} step${steps.length === 1 ? "" : "s"} across ${agents.join(", ")}` +
    `${check.goalTitle ? ` for "${check.goalTitle}"` : ""} — ${str(args.summary) || "no summary"}. ${argusVerdict(check)}`
  );
}

export interface StoredFlowDefinition {
  flowId: string;
  proposedBy: string;
  summary: string;
  goalId?: string;
  steps: FlowStepDefinition[];
}

export async function getFlowDefinition(flowId: string): Promise<StoredFlowDefinition | undefined> {
  return project<StoredFlowDefinition | undefined>(DEFINITIONS_STREAM, undefined, (state, e) =>
    e.type === "flow.defined" && (e.payload as { flowId?: string }).flowId === flowId ? (e.payload as unknown as StoredFlowDefinition) : state,
  );
}

interface ToolResult {
  ok: boolean;
  output: string;
  error?: string;
}

/** Carries out an APPROVED propose-flow call: stores the definition, starts the flow in the
 *  background, and posts the outcome back to the session that proposed it. */
export async function adoptFlow(
  args: Record<string, unknown>,
  proposedBy: string,
  sessionId: string,
  sessionFocus: SessionFocus | undefined,
  drive: DriveFlowOptions,
): Promise<ToolResult> {
  const check = await validateFlow(args, proposedBy, sessionFocus);
  const errors = check.issues.filter((i) => i.level === "error");
  if (errors.length) return { ok: false, output: "", error: `${verifierId()} found problems: ${renderIssues(errors)}` };

  const { createFlow } = await import("./tasks.js");
  const { resumeFlow, setFlowFocus } = await import("./flow-engine.js");
  const { appendSessionNote } = await import("./agent-loop.js");
  const focus: SessionFocus | undefined = check.goalId ? { kind: "goal", id: check.goalId } : undefined;

  const flow = await createFlow("managed", check.steps.map((s) => ({ id: s.id, dependsOn: s.dependsOn ?? [] })));
  if (focus) await setFlowFocus(flow.id, focus);
  const summary = str(args.summary);
  await appendEvent(DEFINITIONS_STREAM, "flow.defined", { flowId: flow.id, proposedBy, summary, ...(check.goalId ? { goalId: check.goalId } : {}), steps: check.steps });
  await appendEvent(GOVERNANCE_STREAM, "flow.adopted", { flowId: flow.id, proposedBy, validator: verifierId(), steps: check.steps.length });
  await publishEvent("flow.adopted", { flowId: flow.id, proposedBy });

  // A flow step does real work (read notes, write notes), so it gets more tool steps than a chat message does.
  const stepHops = Number(process.env.AGENT_OS_FLOW_STEP_HOPS ?? 10);
  void resumeFlow(flow.id, check.steps, { ...drive, enableBaseSpace: true, maxToolHopsPerStep: Number.isFinite(stepHops) && stepHops > 0 ? stepHops : 10, ...(focus ? { focus } : {}) }).then(
    async (result) => {
      const lines = result.steps.map((s) => `${s.stepId}: ${s.status}`).join(", ");
      await appendSessionNote(sessionId, "Flow", `The flow "${summary || flow.id}" finished as ${result.status}. Steps: ${lines}.`).catch(() => {});
    },
    async (e) => {
      await appendSessionNote(sessionId, "Flow", `The flow "${summary || flow.id}" stopped with an error: ${e instanceof Error ? e.message : String(e)}`).catch(() => {});
    },
  );

  return {
    ok: true,
    output:
      `Flow started (${flow.id}): ${check.steps.map((s) => `${s.id} → ${s.agentId}`).join(", ")}. It runs in the background; ` +
      `each step sees what the steps it depends on produced, and the outcome is posted back here. ${argusVerdict(check)}`,
  };
}
