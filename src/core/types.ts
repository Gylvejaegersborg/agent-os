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
