// Agent registry — the ONE authoritative place a client (a gateway
// consumer like BaseOS) reads "who is this agent, what's it doing right
// now" from. This is Phase 4's core move: before this file, an agent's
// identity (identity.ts), its model preference (models/real.ts), and its
// live runtime state (session.ts/tasks.ts/observability.ts) were three
// separately-queryable primitives with no single composed view — every
// consumer would have had to know to stitch them together itself, and a
// UI-side mock array (BaseOS's data/agents.ts) was the closest thing to
// "the" agent list that existed anywhere.
//
// Deliberately a COMPOSITION layer, not new storage: every field here is
// either read from an existing primitive's own store (identity,
// defaultModel) or DERIVED fresh from the event log (status/currentTask/
// worker/metrics), the same "no separate mutable copy to drift" principle
// every other projection in this codebase follows. Presentational-only
// fields (color, icon, canned chatter lines) deliberately do NOT live
// here — see the mission's own instruction that BaseOS may retain those
// itself, layered on top of this authoritative record by id.

import { getAgentIdentity, listAgentIdentities, registerAgentIdentity, updateAgentIdentity, type AgentIdentity } from "./identity.js";
import { getAgentDefaultModel } from "./models/real.js";
import { listSessions } from "./session.js";
import { listTasks } from "./tasks.js";
import { computeMetricsSnapshot, type MetricsSnapshot } from "./observability.js";

export type AgentLiveStatus = "active" | "idle";

export interface AgentRecord {
  id: string;
  name: string;
  persona: string;
  role?: string;
  capabilities: string[];
  defaultModel?: string;
  status: AgentLiveStatus;
  /** The most recently active Session for this agent, if any exist at
   *  all — "most recently active" meaning the highest updatedAt, active
   *  status preferred over any other. Undefined only when this agent has
   *  never had a Session created for it. */
  currentSessionId?: string;
  /** The Task that Session is linked to (session.ts's taskId field), if
   *  any — falls back to the agent's own most recently created 'running'
   *  Task when the current session isn't explicitly linked to one, so
   *  this still reflects reality for callers (like subagent.ts) that
   *  create Tasks without going through linkSessionWork(). */
  currentTaskId?: string;
  /** Best-effort: the workerId recorded on currentTaskId, if that Task
   *  has one. There is no formal agent<->worker assignment anywhere in
   *  this codebase (see worker-registry.ts's own header for why Workers
   *  are deliberately not owned by a single agent) — this is simply
   *  "which worker, if any, is currently doing this agent's active work." */
  workerId?: string;
  metrics: MetricsSnapshot;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterAgentInput {
  id: string;
  name: string;
  persona: string;
  role?: string;
  capabilities?: string[];
  defaultModel?: string;
}

/** Registers a new authoritative agent — identity (identity.ts) plus, if
 *  given, a default-model preference (models/real.ts). This is the
 *  seeding entry point (see seedDefaultAgents() below); re-registering an
 *  id that already exists is NOT idempotent at the identity layer (it
 *  appends a second agent.identity.registered event) — callers that only
 *  want "create if missing" should check getAgentRecord() first, exactly
 *  as seedDefaultAgents() does. */
export async function registerAgent(input: RegisterAgentInput): Promise<AgentRecord> {
  await registerAgentIdentity({
    id: input.id,
    name: input.name,
    persona: input.persona,
    role: input.role,
    capabilities: input.capabilities,
  });
  if (input.defaultModel) {
    const { setAgentDefaultModel } = await import("./models/real.js");
    await setAgentDefaultModel(input.id, input.defaultModel);
  }
  const record = await getAgentRecord(input.id);
  if (!record) throw new Error(`registerAgent(${input.id}) did not produce a resolvable AgentRecord`);
  return record;
}

/** Patches an existing agent's identity fields — a thin pass-through to
 *  identity.ts's updateAgentIdentity(), returning the fully composed
 *  AgentRecord instead of just the raw AgentIdentity so a caller (the
 *  gateway's PATCH-equivalent route) gets back everything, not just what
 *  it patched. */
export async function updateAgent(
  id: string,
  patch: Partial<Pick<RegisterAgentInput, "name" | "persona" | "role" | "capabilities">>,
): Promise<AgentRecord | undefined> {
  const updated = await updateAgentIdentity(id, patch);
  if (!updated) return undefined;
  return getAgentRecord(id);
}

async function deriveLiveState(
  agentId: string,
): Promise<{ status: AgentLiveStatus; currentSessionId?: string; currentTaskId?: string; workerId?: string }> {
  const [sessions, tasks] = await Promise.all([listSessions({ agentId, status: "active" }), listTasks({ agentId })]);
  const currentSession = sessions[sessions.length - 1]; // listSessions() sorts by createdAt ascending

  const linkedTask = currentSession?.taskId ? tasks.find((t) => t.id === currentSession.taskId) : undefined;
  const runningTasks = tasks.filter((t) => t.status === "running");
  const task = linkedTask ?? runningTasks[runningTasks.length - 1];

  return {
    status: currentSession || task ? "active" : "idle",
    currentSessionId: currentSession?.id,
    currentTaskId: task?.id,
    workerId: task?.workerId,
  };
}

async function composeRecord(identity: AgentIdentity): Promise<AgentRecord> {
  const [defaultModel, live, metrics] = await Promise.all([
    getAgentDefaultModel(identity.id),
    deriveLiveState(identity.id),
    computeMetricsSnapshot(identity.id),
  ]);
  return {
    id: identity.id,
    name: identity.name,
    persona: identity.persona,
    role: identity.role,
    capabilities: identity.capabilities ?? [],
    defaultModel,
    ...live,
    metrics,
    createdAt: identity.createdAt,
    updatedAt: identity.updatedAt,
  };
}

export async function getAgentRecord(id: string): Promise<AgentRecord | undefined> {
  const identity = await getAgentIdentity(id);
  if (!identity) return undefined;
  return composeRecord(identity);
}

export async function listAgentRecords(): Promise<AgentRecord[]> {
  const identities = await listAgentIdentities();
  return Promise.all(identities.map(composeRecord));
}

/** The default ISΛRK team roster — the authoritative version of what was
 *  previously ONLY a presentational mock array in BaseOS's data/agents.ts.
 *  Idempotent: each entry is registered only if getAgentRecord() doesn't
 *  already resolve it, so calling this on every gateway startup (see
 *  gateway/cli.ts) never duplicates identity-registration events. Colors/
 *  icons/canned chatter stay a BaseOS-side presentational concern — see
 *  this file's header — so none of that is seeded here. */
export async function seedDefaultAgents(): Promise<AgentRecord[]> {
  const roster: RegisterAgentInput[] = [
    {
      id: "claude",
      name: "Claude",
      role: "Builder · Code",
      persona: "A general-purpose software engineering agent for the ISΛRK operator's own dashboard and tooling.",
      capabilities: ["shell", "code-editing", "subagent-delegation"],
    },
    {
      id: "hemera",
      name: "Hemera",
      role: "Manager · Strategy",
      persona: "Chairs the daily meeting, owns marketing strategy, the release calendar and trend analysis, assigns and hands off tasks.",
      capabilities: ["planning", "task-handoff"],
    },
    {
      id: "nyx",
      name: "Nyx",
      role: "Execution · Content",
      persona: "Writes captions, post copy and cover-art prompts, and assembles complete upload packages for YouTube, SoundCloud and the site.",
      capabilities: ["content-generation", "subagent-delegation"],
    },
    {
      id: "aether",
      name: "Aether",
      role: "A&R · Sound",
      persona: "Interprets extracted audio features (BPM, key, loudness, spectral stats) into honest musical analysis, compares incoming beats against the catalog.",
      capabilities: ["audio-feature-analysis"],
    },
    {
      id: "hermes",
      name: "Hermes",
      role: "Booking · Outreach",
      persona: "Triages booking and collab messages from the intake inbox, drafts replies (always queued for approval), maintains the contacts log.",
      capabilities: ["email-triage", "draft-generation"],
    },
    {
      id: "mnemosyne",
      name: "Mnemosyne",
      role: "Archive · Ops",
      persona: "Keeps the team's shared state tidy and schema-true, catalogs beats, grooms the task board, writes meeting minutes.",
      capabilities: ["schema-validation", "record-keeping"],
    },
    {
      id: "theia",
      name: "Theia",
      role: "Market · Research",
      persona: "Researches the market, scene trends, playlist/social signals and comparable artists; writes the trend reports and feeds opportunities to Hemera.",
      capabilities: ["market-research"],
    },
    {
      id: "argus",
      name: "Argus",
      role: "Oversight · Pipeline",
      persona: "Watches how the whole operation runs, audits the team's own output for quality and follow-through, proposes concrete pipeline improvements.",
      capabilities: ["pipeline-audit", "quality-review"],
    },
  ];

  const results: AgentRecord[] = [];
  for (const input of roster) {
    const existing = await getAgentRecord(input.id);
    results.push(existing ?? (await registerAgent(input)));
  }
  return results;
}
