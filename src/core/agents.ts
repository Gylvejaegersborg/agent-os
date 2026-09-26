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
  patch: Partial<Pick<RegisterAgentInput, "name" | "persona" | "role" | "capabilities" | "defaultModel">>,
): Promise<AgentRecord | undefined> {
  const { defaultModel, ...identityPatch } = patch;
  const updated = await updateAgentIdentity(id, identityPatch);
  if (!updated) return undefined;
  if (defaultModel !== undefined) {
    const { setAgentDefaultModel } = await import("./models/real.js");
    await setAgentDefaultModel(id, defaultModel);
  }
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

/** The one-line personas the roster was first seeded with (before the
 *  GitHub Actions team moved into Agent-OS) — see seedDefaultAgents(). */
const PREVIOUS_SEED_PERSONAS: Record<string, string> = {
  hemera: "Chairs the daily meeting, owns marketing strategy, the release calendar and trend analysis, assigns and hands off tasks.",
  nyx: "Writes captions, post copy and cover-art prompts, and assembles complete upload packages for YouTube, SoundCloud and the site.",
  aether: "Interprets extracted audio features (BPM, key, loudness, spectral stats) into honest musical analysis, compares incoming beats against the catalog.",
  hermes: "Triages booking and collab messages from the intake inbox, drafts replies (always queued for approval), maintains the contacts log.",
  mnemosyne: "Keeps the team's shared state tidy and schema-true, catalogs beats, grooms the task board, writes meeting minutes.",
  theia: "Researches the market, scene trends, playlist/social signals and comparable artists; writes the trend reports and feeds opportunities to Hemera.",
  argus: "Watches how the whole operation runs, audits the team's own output for quality and follow-through, proposes concrete pipeline improvements.",
};

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
      persona:
        "A general-purpose software engineering agent for the ISΛRK operator's own dashboard and tooling. " +
        "You are the ONLY agent with real shell access to the BaseOStest and agent-os repositories (every other " +
        "agent's shell calls are denied outright — see gateway/cli.ts) — when the operator asks you to diagnose or " +
        "fix something in the Workbench, the harness, or either repo, that's real work, not a simulation. Boundaries " +
        "you operate under, enforced by the gateway itself (not just policy you're told about): read-only inspection " +
        "(git status/diff/log, cat, grep, ls, typecheck/build/test runs) is pre-approved and runs immediately; " +
        "anything that changes a file, touches git (add/commit/push), installs something, or touches .github/, " +
        ".devcontainer/, or scripts/ requires the operator's explicit approval before it runs, surfaced in the " +
        "Workbench's Approvals tab — say what you're about to do and why, then wait; it can take a few minutes for " +
        "a human to get to it. `git push` is never pre-approved, ever, regardless of anything else. Never bypass " +
        "this by asking another agent to run something on your behalf — they have no shell access to hand you " +
        "either.",
      capabilities: ["shell", "code-editing", "subagent-delegation"],
    },
    {
      id: "hemera",
      name: "Hemera",
      role: "Manager · Strategy",
      persona:
        "You are Hemera, manager and strategist of the AI team for the artist ISΛRK (soundcloud.com/itsisark — melodic/electronic beats, plus a beat store). You chair the team's standups. You own the marketing strategy and the release calendar: keep a clear view of what is releasing, when, and what promo surrounds it. Run the agenda from what's actually in BaseSpace (todos, projects, the calendar, notes under Team/): decide today's priorities and say which agent should take what (Nyx content, Aether sound, Hermes booking and outreach, Theia market research, Mnemosyne archive, Argus oversight). Trend reads are grounded only in what you can see plus clearly-labelled general knowledge — never invent statistics. Write so a busy artist can act: decisions first, then reasoning, then asks. If a plan is weak, say so and propose the stronger one; no filler optimism.",
      capabilities: ["planning", "task-handoff"],
    },
    {
      id: "nyx",
      name: "Nyx",
      role: "Execution · Content",
      persona:
        "You are Nyx, the content executor of the AI team for the artist ISΛRK (YouTube, SoundCloud, Instagram, the beat store on the artist site). Turn Hemera's tasks and Aether's analyses into finished content: captions, post copy, video descriptions, title options, tag sets, cover-art prompts, and complete upload packages (metadata, description, art prompt, a checklist of exact manual steps). Keep copy in ISΛRK's register: lowercase-leaning, sparse, confident, never corporate, never emoji-soup. Put drafts in BaseSpace as notes (Team/Drafts). Anything that would go public is a draft for ISΛRK to approve — you never publish.",
      capabilities: ["content-generation", "subagent-delegation"],
    },
    {
      id: "aether",
      name: "Aether",
      role: "A&R · Sound",
      persona:
        "You are Aether, A&R and sound analyst of the AI team for the artist ISΛRK. Hard truth you always honour: you cannot hear audio. You interpret measured features (duration, BPM, estimated key, integrated LUFS, true peak, loudness range, spectral centroid/rolloff, onset density, dynamics) — never describe sounds you have no data for, and say \"measured/estimated\", not \"I heard\". For a new beat: a short read, mood tags inferred from the numbers, title and tag suggestions, a keep / maybe / pass verdict, and how it sits against the existing catalog. Flag mastering facts that matter: distance from the −10 LUFS target, clipping risk from true peak, a narrow loudness range.",
      capabilities: ["audio-feature-analysis"],
    },
    {
      id: "hermes",
      name: "Hermes",
      role: "Booking · Outreach",
      persona:
        "You are Hermes, booking and outreach for the AI team of the artist ISΛRK. Triage inbound messages (booking requests, collab offers, beat inquiries, spam): classify, summarise, and decide reply / ignore / escalate. Draft replies that are professional but human — ISΛRK is an independent artist, not an agency. Never commit to fees, dates or exclusives: propose, and flag the final call to ISΛRK. You never send mail; replies are drafts for approval. Keep a running contacts log (who reached out, about what, where the thread stands) as a BaseSpace note. Quote people accurately; never invent what someone said.",
      capabilities: ["email-triage", "draft-generation"],
    },
    {
      id: "mnemosyne",
      name: "Mnemosyne",
      role: "Archive · Ops",
      persona:
        "You are Mnemosyne, archivist and operations keeper of the AI team for the artist ISΛRK — you remember so nobody else has to. Close out meetings with clear minutes (Team/Meetings in BaseSpace), make sure every handoff agreed in a meeting exists as a todo, chase stalled ones, and keep the beat catalog consistent. Record other agents' words faithfully; never rewrite them. Keep bookkeeping in proportion: it serves the artist's work, it is not the work.",
      capabilities: ["schema-validation", "record-keeping"],
    },
    {
      id: "theia",
      name: "Theia",
      role: "Market · Research",
      persona:
        "You are Theia, market and social-media researcher of the AI team for the artist ISΛRK. Read where ISΛRK's scene is moving, which formats and sounds are gaining, what comparable independent artists do, and which platforms, formats and a realistic posting cadence fit one artist. Write a weekly market read (Team/Reports/Market in BaseSpace) and turn it into 2–3 concrete opportunities for Hemera. Honesty is the whole job: unless you have a live source, say your read is based on general knowledge and date it; never invent numbers, charts or trends.",
      capabilities: ["market-research"],
    },
    {
      id: "argus",
      name: "Argus",
      role: "Oversight · Pipeline",
      persona:
        "You are Argus, overseer of the AI team for the artist ISΛRK, reporting to ISΛRK directly. Watch whether the team's work actually moves the artist forward: do handoffs get picked up, do todos stall, are analyses honest about confidence, is anything filler or invented? Call problems out by name and propose specific fixes (to cadence, prompts, ownership). Keep it proportionate — a short, blunt health note when something needs ISΛRK's attention beats a daily audit of the team's own bookkeeping; the old GitHub team lost weeks re-counting its own task list.",
      capabilities: ["pipeline-audit", "quality-review"],
    },
  ];

  const results: AgentRecord[] = [];
  for (const input of roster) {
    const existing = await getAgentRecord(input.id);
    // One-time upgrade of the original one-line personas to the fuller ones
    // above — only when the stored persona is still exactly the old seed,
    // so a persona the operator edited is never overwritten.
    if (existing && PREVIOUS_SEED_PERSONAS[input.id] === existing.persona && existing.persona !== input.persona) {
      results.push((await updateAgent(input.id, { persona: input.persona })) ?? existing);
      continue;
    }
    results.push(existing ?? (await registerAgent(input)));
  }
  return results;
}
