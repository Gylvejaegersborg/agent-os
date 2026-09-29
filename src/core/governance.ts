// Governance gates, after Paperclip's board: the org can grow and plan, but
// the operator signs off first.
//
//   - `propose-agent`: an agent proposes hiring a new teammate.
//   - `propose-plan`: a lead proposes a plan for a goal — several work
//     items for its team.
//
// Both ALWAYS go to the Approvals queue (approvals.ts). The gate is enforced
// here, in the harness itself — runTurn() never dispatches a gated tool; it
// files an approval request instead, and only the operator's approval (the
// gateway's executeApprovedCall path) runs it. Neither can be put on an
// agent's "always allow" list (allowlist.ts). Only leads are offered them.
//
// Agent config revisions: every change to an agent's name, role, persona,
// reporting line, model and budget is already an event; listAgentRevisions()
// folds them into a history, and restoreAgentRevision() brings an agent
// back to one — as new events, so the history itself is never rewritten.
// Restoring is operator-only (a gateway route), like the budgets it covers.

import { appendEvent, readStream } from "./eventlog.js";
import { publishEvent } from "./eventbus.js";
import { getAgentIdentity, listAgentIdentities, updateAgentIdentity } from "./identity.js";
import { listApprovals, requestApproval } from "./approvals.js";
import { stableJson, seedAllowRules } from "./allowlist.js";
import { loadSnapshot } from "./basespace.js";
import { setAgentBudget, type AgentBudget } from "./controls.js";
import { createWork, OPERATOR } from "./work.js";
import { GATED_TOOL_NAMES } from "./tool-registry.js";
import type { SessionFocus } from "./types.js";

const GOVERNANCE_STREAM = "governance";

export const GATED_TOOLS = new Set(GATED_TOOL_NAMES);

interface ToolResult {
  ok: boolean;
  output: string;
  error?: string;
}

const str = (args: Record<string, unknown>, k: string) => (typeof args[k] === "string" ? (args[k] as string).trim() : "");

/** What the operator sees in the Approvals queue for a gated call. */
async function gateReason(toolName: string, args: Record<string, unknown>, agentId: string): Promise<string> {
  if (toolName === "propose-agent") {
    return `Hire: ${agentId} proposes a new agent "${str(args, "name") || str(args, "id")}" (${str(args, "role") || "no role given"}), ` +
      `reporting to ${str(args, "reportsTo") || agentId}. Why: ${str(args, "why") || "not given"}`;
  }
  const steps = Array.isArray(args.steps) ? args.steps.length : 0;
  return `Plan: ${agentId} proposes ${steps} work item${steps === 1 ? "" : "s"} for a goal — ${str(args, "summary") || "no summary"}`;
}

/** Files (or finds the already-pending) approval for a gated call and says
 *  why the turn stops here. Never lets the call through. */
export async function gateToolCall(input: { agentId: string; sessionId: string; toolName: string; args: Record<string, unknown> }): Promise<string> {
  const same = (await listApprovals({ status: "pending", agentId: input.agentId })).find(
    (a) => a.toolName === input.toolName && stableJson(a.args) === stableJson(input.args),
  );
  const request =
    same ??
    (await requestApproval({ ...input, reason: await gateReason(input.toolName, input.args, input.agentId) }));
  return (
    `waiting for approval: ${input.toolName === "propose-agent" ? "hiring an agent" : "a plan for a goal"} always needs the operator's OK ` +
    `(request ${request.id}). Nothing has been created yet; once they approve in the Approvals tab it's carried out and you'll be told.`
  );
}

// ---- propose-agent -----------------------------------------------------------

const ID_RE = /^[a-z][a-z0-9-]{1,30}$/;

/** Carries out an APPROVED propose-agent call. */
export async function hireAgent(args: Record<string, unknown>, proposedBy: string): Promise<ToolResult> {
  const id = str(args, "id").toLowerCase();
  const name = str(args, "name");
  const role = str(args, "role");
  const persona = str(args, "persona");
  const reportsTo = str(args, "reportsTo") || proposedBy;
  const model = str(args, "model");
  const fail = (error: string): ToolResult => ({ ok: false, output: "", error });
  if (!ID_RE.test(id) || id === OPERATOR) return fail(`id must be lowercase letters, digits and dashes (got "${id}")`);
  if (await getAgentIdentity(id)) return fail(`there's already an agent "${id}"`);
  if (!name || !role) return fail("a new agent needs a name and a role");
  if (persona.length < 20) return fail("a new agent needs a persona (a few sentences: who it is and what it does)");
  if (reportsTo !== OPERATOR && !(await getAgentIdentity(reportsTo))) return fail(`no agent "${reportsTo}" to report to`);
  const { registerAgent } = await import("./agents.js");
  await registerAgent({ id, name, role, persona, ...(model ? { defaultModel: model } : {}), ...(reportsTo !== OPERATOR ? { reportsTo } : {}) });
  // Same defaults the roster gets: it may read and write BaseSpace.
  await seedAllowRules(["basespace", "basespace-add"].map((toolName) => ({ agentId: id, toolName })));
  await appendEvent(GOVERNANCE_STREAM, "agent.hired", { id, proposedBy, reportsTo });
  await publishEvent("agent.hired", { id, proposedBy });
  return {
    ok: true,
    output: `Hired ${name} (${id}), ${role}, reporting to ${reportsTo}${model ? `, on ${model}` : ""}. It has no token budget yet — the operator sets that.`,
  };
}

// ---- propose-plan ------------------------------------------------------------

export interface PlanStep {
  to: string;
  title: string;
  detail?: string;
}

export const MAX_PLAN_STEPS = 8;

function parseSteps(raw: unknown): PlanStep[] | string {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return "steps must be a list of {to, title, detail?}";
    }
  }
  if (!Array.isArray(v) || !v.length) return "a plan needs at least one step";
  if (v.length > MAX_PLAN_STEPS) return `a plan has at most ${MAX_PLAN_STEPS} steps — split it`;
  const steps: PlanStep[] = [];
  for (const s of v) {
    const o = (s ?? {}) as Record<string, unknown>;
    const to = typeof o.to === "string" ? o.to.trim() : "";
    const title = typeof o.title === "string" ? o.title.trim() : "";
    if (!to || !title) return "every step needs `to` (an agent id) and `title`";
    steps.push({ to, title, ...(typeof o.detail === "string" && o.detail.trim() ? { detail: o.detail.trim() } : {}) });
  }
  return steps;
}

/** Carries out an APPROVED propose-plan call: one work item per step, all
 *  serving the goal, reported back to the session that proposed it. */
export async function adoptPlan(args: Record<string, unknown>, proposedBy: string, sessionId: string, sessionFocus?: SessionFocus): Promise<ToolResult> {
  const fail = (error: string): ToolResult => ({ ok: false, output: "", error });
  const goalId = str(args, "goalId") || (sessionFocus?.kind === "goal" ? sessionFocus.id : "");
  if (!goalId) return fail("which goal? pass goalId (see the basespace tool, section goals)");
  const goals: any[] = ((await loadSnapshot()) ?? {}).goals ?? [];
  const goal = goals.find((g) => g.id === goalId);
  if (goals.length && !goal) return fail(`no goal "${goalId}" in BaseSpace`);
  const steps = parseSteps(args.steps);
  if (typeof steps === "string") return fail(steps);
  // All-or-nothing: check every step before creating any.
  const known = new Set((await listAgentIdentities()).map((a) => a.id));
  const bad = steps.find((s) => !known.has(s.to) || s.to === proposedBy);
  if (bad) return fail(bad.to === proposedBy ? `"${bad.title}" is assigned to you — do it yourself rather than planning it` : `no agent "${bad.to}"`);
  const ids: string[] = [];
  for (const s of steps) {
    const item = await createWork({
      title: s.title,
      ...(s.detail ? { detail: s.detail } : {}),
      assignee: s.to,
      requestedBy: proposedBy,
      requestedFromSessionId: sessionId,
      focus: { kind: "goal", id: goalId },
    });
    ids.push(item.id);
  }
  await appendEvent(GOVERNANCE_STREAM, "plan.adopted", { goalId, proposedBy, summary: str(args, "summary"), workIds: ids });
  return {
    ok: true,
    output: `Plan adopted for ${goal ? `"${goal.title}"` : goalId}: ${steps.map((s, i) => `${s.to} — ${s.title} (${ids[i]})`).join("; ")}. ` +
      "They run in the background; results are posted back here.",
  };
}

// ---- Agent config revisions ---------------------------------------------------

export interface AgentConfig {
  name?: string;
  role?: string;
  persona?: string;
  reportsTo?: string;
  defaultModel?: string;
  budget?: AgentBudget;
}

export interface AgentRevision {
  /** 1 = how the agent was created. */
  rev: number;
  at: string;
  /** Fields this revision changed. */
  changed: (keyof AgentConfig)[];
  config: AgentConfig;
  restoredFrom?: number;
}

const RESTORE_WINDOW_MS = 2000;
const FIELDS: (keyof AgentConfig)[] = ["name", "role", "persona", "reportsTo", "defaultModel", "budget"];

export async function listAgentRevisions(agentId: string): Promise<AgentRevision[]> {
  const pick = async (stream: string, match: (p: any) => boolean) => (await readStream(stream)).filter((e) => match(e.payload as any));
  const events = [
    ...(await pick("agent-identities", (p) => p.id === agentId)),
    ...(await pick("agent-model-preferences", (p) => p.agentId === agentId)),
    ...(await pick("agent-controls", (p) => p.agentId === agentId)).filter((e) => e.type === "agent.budget.set" || e.type === "agent.budget.cleared"),
    ...(await pick(GOVERNANCE_STREAM, (p) => p.agentId === agentId)).filter((e) => e.type === "agent.restored"),
  ].sort(
    // A restore writes its marker first; on a same-millisecond tie it must
    // still sort before the changes it made.
    (a, b) => a.timestamp.localeCompare(b.timestamp) || Number(b.type === "agent.restored") - Number(a.type === "agent.restored"),
  );

  const out: AgentRevision[] = [];
  let config: AgentConfig = {};
  let restoredFrom: number | undefined;
  let restoreAt: string | undefined;
  for (const e of events) {
    const p = e.payload as any;
    if (e.type === "agent.restored") {
      // The events a restore writes land together; fold them into one revision.
      restoredFrom = p.rev;
      restoreAt = e.timestamp;
      continue;
    }
    const next: AgentConfig = { ...config };
    if (e.type === "agent.identity.registered" || e.type === "agent.identity.updated") {
      for (const k of ["name", "role", "persona"] as const) if (typeof p[k] === "string") next[k] = p[k];
      if (p.reportsTo === null) delete next.reportsTo;
      else if (typeof p.reportsTo === "string") next.reportsTo = p.reportsTo;
    } else if (e.type === "agent.defaultModel.set") {
      if (p.model) next.defaultModel = p.model;
      else delete next.defaultModel;
    } else if (e.type === "agent.budget.set") {
      next.budget = { period: p.period, limitTokens: p.limitTokens, warnAt: p.warnAt };
    } else if (e.type === "agent.budget.cleared") {
      delete next.budget;
    }
    const changed = FIELDS.filter((f) => JSON.stringify(next[f]) !== JSON.stringify(config[f]));
    config = next;
    if (!changed.length) continue;
    // A restore writes its events right after its agent.restored marker;
    // those (and only those) fold into one revision marked restoredFrom.
    const partOfRestore = restoredFrom !== undefined && restoreAt !== undefined && Date.parse(e.timestamp) - Date.parse(restoreAt) < RESTORE_WINDOW_MS;
    if (!partOfRestore) restoredFrom = restoreAt = undefined;
    const last = out.at(-1);
    if (partOfRestore && last && last.restoredFrom === restoredFrom && last.at >= restoreAt!) {
      last.changed = [...new Set([...last.changed, ...changed])];
      last.config = { ...config };
      continue;
    }
    out.push({ rev: out.length + 1, at: e.timestamp, changed, config: { ...config }, ...(partOfRestore ? { restoredFrom } : {}) });
  }
  return out;
}

/** Brings an agent's config back to an earlier revision, as new events. */
export async function restoreAgentRevision(agentId: string, rev: number): Promise<AgentRevision[]> {
  const revisions = await listAgentRevisions(agentId);
  const target = revisions.find((r) => r.rev === rev);
  if (!target) throw new Error(`no revision ${rev} for ${agentId}`);
  const current = revisions.at(-1)!.config;
  const want = target.config;
  const differs = (k: keyof AgentConfig) => JSON.stringify(want[k]) !== JSON.stringify(current[k]);
  if (!FIELDS.some(differs)) throw new Error(`${agentId} is already at revision ${rev}'s config`);
  await appendEvent(GOVERNANCE_STREAM, "agent.restored", { agentId, rev });
  const patch: Parameters<typeof updateAgentIdentity>[1] = {};
  for (const k of ["name", "role", "persona"] as const) if (differs(k) && want[k] !== undefined) patch[k] = want[k];
  if (differs("reportsTo")) patch.reportsTo = want.reportsTo ?? null;
  if (Object.keys(patch).length) await updateAgentIdentity(agentId, patch);
  if (differs("defaultModel")) {
    const { setAgentDefaultModel } = await import("./models/real.js");
    await setAgentDefaultModel(agentId, want.defaultModel ?? "");
  }
  if (differs("budget")) await setAgentBudget(agentId, want.budget ? { ...want.budget } : { limitTokens: null });
  await publishEvent("agent.restored", { agentId, rev });
  return listAgentRevisions(agentId);
}
