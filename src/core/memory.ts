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
//   - Curated memory is split into TWO documents, mirroring Hermes' own
//     MEMORY.md / USER.md split (the user specifically likes this shape):
//     MEMORY.md holds durable facts/procedures/environment notes,
//     USER.md holds user profile/preference information. The split is
//     purely by EpisodicKind ("preference" -> USER.md, everything else
//     -> MEMORY.md) — a simple, auditable rule, not a model judgment call.
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
 *  gets its real implementation. Stated limitation, not hidden: two
 *  paraphrases of the same fact ("prefers short answers" vs "likes
 *  brief replies") are NOT recognized as repetitions of each other. */
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
  /** MEMORY.md-equivalent: durable facts, procedures, environment notes. */
  content: string;
  /** USER.md-equivalent: user profile/preference information. */
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

/** Collects every episodic entry id that has EVER been included in a past
 *  promotion, across all `memory.curated.updated` events. This is the
 *  dedup mechanism: without it, running the dreaming pass twice with no
 *  new episodic writes in between would re-append the same still-eligible
 *  entries as duplicate bullet lines every single pass. An entry's
 *  ELIGIBILITY (whether its score crosses the threshold) is still
 *  recomputed and recorded fresh every pass for audit purposes — only the
 *  CONTENT-APPENDING step skips entries already represented in the
 *  document. */
async function listAlreadyPromotedEpisodicIds(agentId: string): Promise<Set<string>> {
  const events = await project<string[]>(curatedStream(agentId), [], (state, event) => {
    if (event.type === "memory.curated.updated") {
      const p = event.payload as any;
      const ids: string[] = (p.provenance ?? []).flatMap((prov: any) => prov.sourceEpisodicIds ?? []);
      state.push(...ids);
    }
    return state;
  });
  return new Set(events);
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

/** phraseFn stands in for "call an LLM to summarize/merge the newly
 *  eligible entries into MEMORY.md/USER.md-style prose." It is
 *  intentionally injected rather than hardcoded so the dreaming pass
 *  itself has zero model dependency and can be unit-tested
 *  deterministically — only the phrasing step touches a model, never the
 *  eligibility decision or the MEMORY.md/USER.md categorization (that
 *  split happens in runDreamingPass by EpisodicKind, before phraseFn is
 *  even called). Receives only NEWLY-eligible entries (already deduped
 *  against past promotions) split into the two document buckets. */
export type PhraseFn = (input: {
  memoryEntries: EpisodicEntry[];
  userProfileEntries: EpisodicEntry[];
  previousMemory: string;
  previousUserProfile: string;
}) => Promise<{ memory: string; userProfile: string }>;

const defaultPhraseFn: PhraseFn = async ({ memoryEntries, userProfileEntries, previousMemory, previousUserProfile }) => {
  // No-model fallback used by the CLI demo: just append bullet points.
  // A real deployment passes a PhraseFn backed by an actual model call.
  const memoryLines = memoryEntries.map((e) => `- ${e.content}`);
  const profileLines = userProfileEntries.map((e) => `- ${e.content}`);
  return {
    memory: [previousMemory, ...memoryLines].filter(Boolean).join("\n"),
    userProfile: [previousUserProfile, ...profileLines].filter(Boolean).join("\n"),
  };
};

export async function runDreamingPass(
  agentId: string,
  phraseFn: PhraseFn = defaultPhraseFn,
): Promise<DreamingPass> {
  const entries = await listEpisodic(agentId);
  const current = await getCuratedMemory(agentId);
  const alreadyPromoted = await listAlreadyPromotedEpisodicIds(agentId);
  const now = new Date();

  // Eligibility is scored and recorded for EVERY entry, every pass —
  // this is the full audit trail regardless of dedup. Decision reflects
  // "does this entry qualify," not "was it newly added to the document
  // this pass" (those are different questions; dedup only affects the
  // second one).
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

  // Only NEWLY eligible entries (never previously appended to the
  // document) actually get written this pass — this is the dedup fix.
  const newlyEligibleEntries = entries.filter(
    (e) => !alreadyPromoted.has(e.id) && promotions.find((p) => p.episodicEntryId === e.id)?.eligible,
  );

  if (newlyEligibleEntries.length > 0) {
    const memoryEntries = newlyEligibleEntries.filter((e) => e.kind !== "preference");
    const userProfileEntries = newlyEligibleEntries.filter((e) => e.kind === "preference");

    const { memory, userProfile } = await phraseFn({
      memoryEntries,
      userProfileEntries,
      previousMemory: current.content,
      previousUserProfile: current.userProfile,
    });

    await appendEvent(curatedStream(agentId), "memory.curated.updated", {
      content: memory,
      userProfile,
      provenance: newlyEligibleEntries.map((e) => ({
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
