// Core types shared across every primitive. See /docs/architecture.md for
// the design rationale behind each of these — this file is the executable
// version of that sketch, kept intentionally close to the TypeScript in it.

export interface Event {
  id: string; // ULID-ish — sortable, timestamp-prefixed (see id.ts)
  streamId: string; // which stream this belongs to (session/task/agent/flow id)
  type: string; // "agent.turn.start", "tool.call.end", "memory.episodic.write", ...
  timestamp: string; // ISO 8601
  payload: Record<string, unknown>;
  causedBy?: string; // event id that triggered this one (causal chain)
}

export type TaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "lost";

/** "What happened" — a ledger entry, created for detached work only
 *  (subagent runs, cron executions, CLI operations). Plain chat turns do
 *  NOT create a Task — see OpenClaw's design, which this mirrors. */
export interface Task {
  id: string;
  type: "subagent" | "cron" | "cli" | "user-request" | "flow-step";
  agentId: string;
  workerId?: string;
  parentTaskId?: string;
  flowId?: string;
  status: TaskStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  notifyPolicy: "immediate" | "digest" | "silent";
}

/** "How multiple steps are coordinated" — orchestration OVER several Tasks.
 *  Carries its own revision counter for optimistic concurrency, mirroring
 *  OpenClaw's flow_runs table: a stale write is rejected as a conflict
 *  instead of silently clobbering state. */
export interface Flow {
  id: string;
  kind: "managed" | "mirrored";
  status: "running" | "succeeded" | "failed" | "cancelled";
  steps: FlowStep[];
  revision: number;
}

export interface FlowStep {
  id: string;
  taskId?: string;
  dependsOn: string[];
  status: TaskStatus;
}

/** "When it fires" — the timing mechanism, distinct from the work itself. */
export interface Automation {
  id: string;
  trigger:
    | { kind: "cron"; expr: string }
    | { kind: "event"; eventType: string; filter?: Record<string, unknown> }
    | { kind: "webhook"; path: string };
  agentId: string;
  promptTemplate: string;
  enabled: boolean;
}

// Standing Order is deliberately NOT a typed data object — it lives as
// natural-language text in an always-injected document (see memory/curated.ts
// STANDING_ORDERS_FILE), interpreted by the agent at runtime. This is a
// conscious choice mirroring OpenClaw's design, not an oversight.

export interface Agent {
  id: string;
  identity: { name: string; persona: string };
  memoryNamespace: string; // -> data/memory/<namespace>/
  defaultModel: string;
}

// Worker (the execution-environment interface) lives in worker.ts, not
// here — it needs a `run()` method, which makes it a behavioral contract
// rather than a plain data shape like everything else in this file.

// ---- Memory ----

export type EpisodicKind =
  | "preference"
  | "correction"
  | "fact"
  | "outcome"
  | "skill-candidate";

/** Fast path — written directly, in real time, by the agent. This is what
 *  preserves Hermes' "the agent is learning me right now" immediacy. */
export interface EpisodicEntry {
  id: string;
  agentId: string;
  timestamp: string;
  content: string;
  kind: EpisodicKind;
  sourceSessionId: string;
  wasExplicitCorrection: boolean;
  repetitionCount: number;
  taskOutcome?: "success" | "failure";
  /** True when this entry originated from an agent-nominated memory that
   *  the USER explicitly approved (see AgentMemoryNomination below) —
   *  an audit marker, not a scoring bypass. Approval itself is recorded
   *  via wasExplicitCorrection: true (the user confirming it IS what
   *  earns the entry its promotion weight); this flag just keeps the
   *  provenance visible after promotion: "the agent proposed this, and
   *  the user later agreed." */
  agentFlaggedImportant?: boolean;
}

export type NominationStatus = "pending" | "approved" | "rejected";

/** The agent's own "draft memory" channel — a bounded voice, not a
 *  bypass. The agent can nominate something it thinks is worth
 *  remembering via the `nominate-memory` tool mid-conversation, but a
 *  nomination has ZERO effect on curated memory until a human explicitly
 *  reviews it (async — see approveAgentMemory/rejectAgentMemory in
 *  memory.ts). Approval is what actually "adds the points": it creates a
 *  real episodic entry weighted as an explicit correction, which then
 *  flows through the exact same deterministic scoreEligibility/dreaming
 *  pipeline as anything else — no separate promotion path for
 *  agent-nominated content. */
export interface AgentMemoryNomination {
  id: string;
  agentId: string;
  content: string;
  kind: EpisodicKind;
  sourceSessionId: string;
  status: NominationStatus;
  nominatedAt: string;
  reviewedAt?: string;
  reviewNote?: string;
  /** Set once approved: the id of the episodic entry approval created. */
  resultingEpisodicEntryId?: string;
}

export interface MemoryProvenance {
  curatedLineHash: string;
  sourceEpisodicIds: string[];
  promotionReason: "dreaming-consolidation" | "explicit-user-correction";
  score: number;
}

export interface MemoryPromotionDecision {
  episodicEntryId: string;
  eligibilityScore: number;
  eligible: boolean;
  decision: "promoted" | "held" | "discarded";
}

export interface DreamingPass {
  id: string;
  ranAt: string;
  episodicEntriesReviewed: number;
  promotions: MemoryPromotionDecision[];
}
