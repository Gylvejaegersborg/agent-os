// Board controls — the operator's live levers over each agent, adapted from
// Paperclip's "board powers" (github.com/paperclipai/paperclip, doc/SPEC.md
// §1 and §6): pause/resume an agent, and give it a token budget per period
// with a soft warning and a hard stop. "Auto mode is allowed; hidden token
// burn is not."
//
// Event-sourced like everything else here:
//   - `agent-controls` stream: pause/resume and budget settings.
//   - `usage:<agentId>` stream: one event per finished turn with the tokens
//     the provider reported (agent-loop.ts records it), so a period's total
//     is a sum over one small stream instead of every session.
//
// A budget block is DERIVED, not stored: an agent is over budget while the
// current period's total is at or above its limit. It lifts on its own when
// the period rolls over or the limit is raised — no stuck "auto-paused"
// state to clean up. A manual pause is stored and lasts until resumed.
//
// Enforcement lives in runTurn() (agent-loop.ts), so chat, flows, crons,
// heartbeats, subagents and MCP's ask_agent are all covered by one check.
// A turn already running when the agent is paused or crosses its limit is
// allowed to finish (bounded by its tool-step limit); the next one is
// refused. Scheduled work (crons, heartbeats, automations) checks first and
// skips a blocked agent instead of piling up failed tasks.
//
// Tokens, not money: this scaffold has no reliable per-model price list,
// and a Claude subscription isn't billed per token anyway. Counts are what
// each provider reports (the Claude CLI's include cached input). Periods
// are calendar-based in UTC (day; ISO week from Monday; month).

import { appendEvent, project } from "./eventlog.js";
import { publishEvent } from "./eventbus.js";

const CONTROLS_STREAM = "agent-controls";
const usageStream = (agentId: string) => `usage:${agentId}`;

export type BudgetPeriod = "day" | "week" | "month";
export const BUDGET_PERIODS: BudgetPeriod[] = ["day", "week", "month"];
const PERIOD_ADJECTIVE: Record<BudgetPeriod, string> = { day: "daily", week: "weekly", month: "monthly" };

export interface AgentBudget {
  period: BudgetPeriod;
  /** Hard ceiling: new turns are refused at or above this many tokens. */
  limitTokens: number;
  /** Fraction of the limit that triggers a one-time warning (default 0.8). */
  warnAt: number;
}

export interface AgentPause {
  reason: string;
  by?: string;
  at: string;
}

export interface AgentControlState {
  agentId: string;
  paused?: AgentPause;
  budget?: AgentBudget;
  /** Tokens used in the budget's current period (or this month, with no budget). */
  usedTokens: number;
  period: BudgetPeriod;
  periodStart: string;
  /** Why a new turn would be refused right now, if it would be. */
  blocked?: "paused" | "budget";
}

export class AgentBlockedError extends Error {
  constructor(
    readonly agentId: string,
    readonly blocked: "paused" | "budget",
    message: string,
  ) {
    super(message);
    this.name = "AgentBlockedError";
  }
}

interface ControlsProjection {
  paused: Map<string, AgentPause>;
  budgets: Map<string, AgentBudget>;
}

async function projectControls(): Promise<ControlsProjection> {
  return project<ControlsProjection>(CONTROLS_STREAM, { paused: new Map(), budgets: new Map() }, (state, event) => {
    const p = event.payload as any;
    if (event.type === "agent.paused") state.paused.set(p.agentId, { reason: p.reason, by: p.by, at: event.timestamp });
    else if (event.type === "agent.resumed") state.paused.delete(p.agentId);
    else if (event.type === "agent.budget.set") state.budgets.set(p.agentId, { period: p.period, limitTokens: p.limitTokens, warnAt: p.warnAt });
    else if (event.type === "agent.budget.cleared") state.budgets.delete(p.agentId);
    return state;
  });
}

export function periodStart(period: BudgetPeriod, now = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === "month") d.setUTCDate(1);
  if (period === "week") d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d;
}

// ---- Board actions (operator only — deliberately no agent tool for these) ----

export async function pauseAgent(agentId: string, opts: { reason?: string; by?: string } = {}): Promise<void> {
  const reason = opts.reason?.trim() || "paused by the operator";
  await appendEvent(CONTROLS_STREAM, "agent.paused", { agentId, reason, by: opts.by });
  await publishEvent("agent.paused", { agentId, reason });
}

export async function resumeAgent(agentId: string, opts: { by?: string } = {}): Promise<void> {
  await appendEvent(CONTROLS_STREAM, "agent.resumed", { agentId, by: opts.by });
  await publishEvent("agent.resumed", { agentId });
}

/** Sets an agent's budget, or clears it (unlimited) with `limitTokens: null`. */
export async function setAgentBudget(
  agentId: string,
  input: { period?: unknown; limitTokens?: unknown; warnAt?: unknown },
): Promise<AgentBudget | undefined> {
  if (input.limitTokens === null) {
    await appendEvent(CONTROLS_STREAM, "agent.budget.cleared", { agentId });
    return undefined;
  }
  const limitTokens = Math.floor(Number(input.limitTokens));
  if (!Number.isFinite(limitTokens) || limitTokens <= 0) throw new Error("limitTokens must be a positive number, or null for no budget");
  const period = BUDGET_PERIODS.includes(input.period as BudgetPeriod) ? (input.period as BudgetPeriod) : "month";
  const warn = Number(input.warnAt);
  const warnAt = Number.isFinite(warn) && warn > 0 && warn < 1 ? warn : 0.8;
  const budget = { period, limitTokens, warnAt };
  await appendEvent(CONTROLS_STREAM, "agent.budget.set", { agentId, ...budget });
  return budget;
}

// ---- Usage ----

async function usedSince(agentId: string, since: Date): Promise<number> {
  const sinceIso = since.toISOString();
  return project<number>(usageStream(agentId), 0, (sum, event) =>
    event.type === "usage.turn" && event.timestamp >= sinceIso ? sum + ((event.payload as any).tokens ?? 0) : sum,
  );
}

export async function getAgentControlState(agentId: string, now = new Date()): Promise<AgentControlState> {
  const { paused, budgets } = await projectControls();
  const budget = budgets.get(agentId);
  const period = budget?.period ?? "month";
  const start = periodStart(period, now);
  const usedTokens = await usedSince(agentId, start);
  const pause = paused.get(agentId);
  const blocked = pause ? "paused" : budget && usedTokens >= budget.limitTokens ? "budget" : undefined;
  return { agentId, paused: pause, budget, usedTokens, period, periodStart: start.toISOString(), ...(blocked ? { blocked } : {}) };
}

/** For schedulers: true when this agent's scheduled work should be skipped
 *  (paused or over budget) instead of run and recorded as a failure. */
export async function agentIsBlocked(agentId: string): Promise<boolean> {
  return (await getAgentControlState(agentId)).blocked !== undefined;
}

/** Throws AgentBlockedError if a new turn for this agent must be refused. */
export async function assertAgentMayRun(agentId: string): Promise<void> {
  const s = await getAgentControlState(agentId);
  if (s.blocked === "paused") {
    throw new AgentBlockedError(agentId, "paused", `${agentId} is paused (${s.paused!.reason}). Resume it in BaseSpace to continue.`);
  }
  if (s.blocked === "budget") {
    throw new AgentBlockedError(
      agentId,
      "budget",
      `${agentId} has used its ${PERIOD_ADJECTIVE[s.budget!.period]} budget (${s.usedTokens} of ${s.budget!.limitTokens} tokens). ` +
        `It resumes when the ${s.budget!.period} rolls over, or raise the budget in BaseSpace.`,
    );
  }
}

/** Records one finished turn's tokens and fires the warning/limit events
 *  when this turn is the one that crossed them. Called by runTurn(). */
export async function recordAgentUsage(agentId: string, usage: { inputTokens: number; outputTokens: number }, sessionId: string): Promise<void> {
  const tokens = usage.inputTokens + usage.outputTokens;
  if (tokens <= 0) return;
  const before = await getAgentControlState(agentId);
  await appendEvent(usageStream(agentId), "usage.turn", { agentId, sessionId, tokens, ...usage });
  const budget = before.budget;
  if (!budget) return;
  const after = before.usedTokens + tokens;
  const warnLine = budget.limitTokens * budget.warnAt;
  if (before.usedTokens < budget.limitTokens && after >= budget.limitTokens) {
    await publishEvent("agent.budget.exceeded", { agentId, usedTokens: after, limitTokens: budget.limitTokens, period: budget.period });
  } else if (before.usedTokens < warnLine && after >= warnLine) {
    await publishEvent("agent.budget.warning", { agentId, usedTokens: after, limitTokens: budget.limitTokens, period: budget.period });
  }
}

export async function listAgentControlStates(agentIds: string[]): Promise<AgentControlState[]> {
  return Promise.all(agentIds.map((id) => getAgentControlState(id)));
}
