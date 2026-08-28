// Memory: the Hermes-immediacy + OpenClaw-safety hybrid.
//
//   - Episodic writes are FAST PATH: the agent writes here directly, in
//     real time, exactly like Hermes' memory tool does today. No gate, no
//     delay — this is what preserves "the agent is learning me right now."
//
//   - Curated memory (what actually gets injected into every session) can
//     ONLY be written by the deterministic dreaming pass below. No single
//     conversation, and no model judgment call, can poison it directly.
//     The model is only ever used to phrase what code already qualified —
//     never to decide what's worth remembering.
//
// See /docs/architecture.md §3 for the full design rationale.

import { project, appendEvent } from "./eventlog.js";
import { generateId } from "./id.js";
import type { EpisodicEntry, EpisodicKind, MemoryPromotionDecision, DreamingPass } from "./types.js";

function episodicStream(agentId: string): string {
  return `memory:${agentId}:episodic`;
}
function curatedStream(agentId: string): string {
  return `memory:${agentId}:curated`;
}
function dreamingStream(agentId: string): string {
  return `memory:${agentId}:dreaming`;
}

// ---- Fast path: episodic writes ----

export async function writeEpisodic(input: {
  agentId: string;
  content: string;
  kind: EpisodicKind;
  sourceSessionId: string;
  wasExplicitCorrection?: boolean;
  taskOutcome?: "success" | "failure";
}): Promise<EpisodicEntry> {
  const id = generateId();
  const entry: EpisodicEntry = {
    id,
    agentId: input.agentId,
    timestamp: new Date().toISOString(),
    content: input.content,
    kind: input.kind,
    sourceSessionId: input.sourceSessionId,
    wasExplicitCorrection: input.wasExplicitCorrection ?? false,
    repetitionCount: await countSimilar(input.agentId, input.content),
    taskOutcome: input.taskOutcome,
  };
  await appendEvent(episodicStream(input.agentId), "memory.episodic.write", entry as any);
  return entry;
}

/** Extremely naive similarity: exact-ish substring match on normalized
 *  text. Good enough for the scaffold to demonstrate that repetition
 *  affects eligibility score; swap for embeddings when this primitive
 *  gets its real implementation. */
async function countSimilar(agentId: string, content: string): Promise<number> {
  const entries = await listEpisodic(agentId);
  const normalized = content.trim().toLowerCase();
  return entries.filter((e) => e.content.trim().toLowerCase() === normalized).length;
}

export async function listEpisodic(agentId: string): Promise<EpisodicEntry[]> {
  return project<EpisodicEntry[]>(episodicStream(agentId), [], (state, event) => {
    if (event.type === "memory.episodic.write") {
      state.push(event.payload as unknown as EpisodicEntry);
    }
    return state;
  });
}

// ---- Curated memory (read-only outside the dreaming pass) ----

export interface CuratedMemoryState {
  content: string;
  userProfile: string;
  lastConsolidatedAt?: string;
}

export async function getCuratedMemory(agentId: string): Promise<CuratedMemoryState> {
  return project<CuratedMemoryState>(curatedStream(agentId), { content: "", userProfile: "" }, (state, event) => {
    if (event.type === "memory.curated.updated") {
      const p = event.payload as any;
      return { content: p.content, userProfile: p.userProfile, lastConsolidatedAt: event.timestamp };
    }
    return state;
  });
}

// ---- The deterministic eligibility score — the entire safety mechanism.
// The model NEVER sees this function; it can only phrase things that
// already scored above threshold. This is the literal implementation of
// "dreaming decides eligibility by code, not by LLM judgment." ----

export const PROMOTION_THRESHOLD = 40;

export function scoreEligibility(entry: EpisodicEntry, now: Date = new Date()): number {
  let score = 0;
  if (entry.wasExplicitCorrection) score += 50; // corrections weigh heaviest
  score += Math.min(entry.repetitionCount * 15, 45); // repeated patterns
  if (entry.taskOutcome === "failure") score += 10; // failures are instructive
  if (entry.kind === "preference") score += 20;
  const ageDays = (now.getTime() - new Date(entry.timestamp).getTime()) / (1000 * 60 * 60 * 24);
  score -= Math.min(ageDays * 0.5, 30); // uncorroborated observations fade
  return score;
}

/** phraseFn stands in for "call an LLM to summarize/merge the eligible
 *  entries into MEMORY.md-style prose." It is intentionally injected
 *  rather than hardcoded so the dreaming pass itself has zero model
 *  dependency and can be unit-tested deterministically — only the
 *  phrasing step touches a model, never the eligibility decision. */
export type PhraseFn = (eligibleEntries: EpisodicEntry[], previousContent: string) => Promise<string>;

const defaultPhraseFn: PhraseFn = async (entries, previous) => {
  // No-model fallback used by the CLI demo: just append bullet points.
  // A real deployment passes a PhraseFn backed by an actual model call.
  const lines = entries.map((e) => `- ${e.content}`);
  return [previous, ...lines].filter(Boolean).join("\n");
};

export async function runDreamingPass(
  agentId: string,
  phraseFn: PhraseFn = defaultPhraseFn,
): Promise<DreamingPass> {
  const entries = await listEpisodic(agentId);
  const current = await getCuratedMemory(agentId);
  const now = new Date();

  const promotions: MemoryPromotionDecision[] = entries.map((entry) => {
    const eligibilityScore = scoreEligibility(entry, now);
    const eligible = eligibilityScore >= PROMOTION_THRESHOLD;
    return {
      episodicEntryId: entry.id,
      eligibilityScore,
      eligible,
      decision: eligible ? "promoted" : ("held" as const),
    };
  });

  const eligibleEntries = entries.filter((e) => promotions.find((p) => p.episodicEntryId === e.id)?.eligible);

  if (eligibleEntries.length > 0) {
    const newContent = await phraseFn(eligibleEntries, current.content);
    await appendEvent(curatedStream(agentId), "memory.curated.updated", {
      content: newContent,
      userProfile: current.userProfile,
      provenance: eligibleEntries.map((e) => ({
        sourceEpisodicIds: [e.id],
        promotionReason: e.wasExplicitCorrection ? "explicit-user-correction" : "dreaming-consolidation",
        score: promotions.find((p) => p.episodicEntryId === e.id)!.eligibilityScore,
      })),
    });
  }

  const pass: DreamingPass = {
    id: generateId(),
    ranAt: now.toISOString(),
    episodicEntriesReviewed: entries.length,
    promotions,
  };
  await appendEvent(dreamingStream(agentId), "memory.dreaming.completed", pass as any);
  return pass;
}

export async function listDreamingPasses(agentId: string): Promise<DreamingPass[]> {
  return project<DreamingPass[]>(dreamingStream(agentId), [], (state, event) => {
    if (event.type === "memory.dreaming.completed") state.push(event.payload as unknown as DreamingPass);
    return state;
  });
}
