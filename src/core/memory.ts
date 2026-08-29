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
//   - The agent gets a BOUNDED VOICE, not a bypass: it can nominate a
//     memory candidate via the `nominate-memory` tool, but the nomination
//     sits in "pending" state with ZERO effect on curated memory until a
//     human explicitly approves or rejects it (async — this scaffold has
//     no synchronous "ask the user right now" mechanism). Approval is
//     what actually adds the weight: it creates a real episodic entry via
//     the exact same writeEpisodic()/scoreEligibility()/dreaming pipeline
//     everything else uses — no separate promotion path for
//     agent-nominated content, no way for the agent to talk its way past
//     the gate on its own.
//
// See /docs/architecture.md §3 for the full design rationale.

import { project, appendEvent } from "./eventlog.js";
import { generateId } from "./id.js";
import type {
  EpisodicEntry,
  EpisodicKind,
  MemoryPromotionDecision,
  DreamingPass,
  AgentMemoryNomination,
  NominationStatus,
} from "./types.js";
import { textSimilarity, SIMILARITY_REPETITION_THRESHOLD } from "./text-similarity.js";

function episodicStream(agentId: string): string {
  return `memory:${agentId}:episodic`;
}
function curatedStream(agentId: string): string {
  return `memory:${agentId}:curated`;
}
function dreamingStream(agentId: string): string {
  return `memory:${agentId}:dreaming`;
}
function nominationsStream(agentId: string): string {
  return `memory:${agentId}:nominations`;
}

// ---- Fast path: episodic writes ----

export async function writeEpisodic(input: {
  agentId: string;
  content: string;
  kind: EpisodicKind;
  sourceSessionId: string;
  wasExplicitCorrection?: boolean;
  taskOutcome?: "success" | "failure";
  agentFlaggedImportant?: boolean;
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
    agentFlaggedImportant: input.agentFlaggedImportant ?? false,
  };
  await appendEvent(episodicStream(input.agentId), "memory.episodic.write", entry as any);
  return entry;
}

/** Token-overlap (Jaccard) similarity via text-similarity.ts — a real
 *  improvement over the previous exact-substring match: two paraphrases
 *  of the same fact ("User prefers short answers" vs "User likes brief
 *  replies") now DO count as repetitions of each other, without needing
 *  embeddings, a network call, or a model. Still not semantic
 *  understanding (see text-similarity.ts's own header for the honest
 *  limitation versus real embeddings) — a genuine, evidence-based step
 *  up, not a claim of solving repetition detection completely. */
async function countSimilar(agentId: string, content: string): Promise<number> {
  const entries = await listEpisodic(agentId);
  return entries.filter((e) => textSimilarity(e.content, content) >= SIMILARITY_REPETITION_THRESHOLD).length;
}

export async function listEpisodic(agentId: string): Promise<EpisodicEntry[]> {
  return project<EpisodicEntry[]>(episodicStream(agentId), [], (state, event) => {
    if (event.type === "memory.episodic.write") {
      state.push(event.payload as unknown as EpisodicEntry);
    }
    return state;
  });
}

// ---- Agent memory nominations: bounded voice, human-approved, async ----

export async function nominateAgentMemory(input: {
  agentId: string;
  content: string;
  kind: EpisodicKind;
  sourceSessionId: string;
}): Promise<AgentMemoryNomination> {
  const id = generateId();
  await appendEvent(nominationsStream(input.agentId), "memory.nomination.created", { nominationId: id, ...input });
  const nomination = await getAgentMemoryNomination(input.agentId, id);
  if (!nomination) throw new Error("memory.nomination.created event did not project to a nomination");
  return nomination;
}

async function projectNominations(agentId: string): Promise<Map<string, AgentMemoryNomination>> {
  return project<Map<string, AgentMemoryNomination>>(nominationsStream(agentId), new Map(), (state, event) => {
    if (event.type === "memory.nomination.created") {
      const p = event.payload as any;
      state.set(p.nominationId, {
        id: p.nominationId,
        agentId: p.agentId,
        content: p.content,
        kind: p.kind,
        sourceSessionId: p.sourceSessionId,
        status: "pending",
        nominatedAt: event.timestamp,
      });
    } else if (event.type === "memory.nomination.reviewed") {
      const p = event.payload as any;
      const existing = state.get(p.nominationId);
      if (existing) {
        state.set(p.nominationId, {
          ...existing,
          status: p.status,
          reviewedAt: event.timestamp,
          reviewNote: p.reviewNote,
          resultingEpisodicEntryId: p.resultingEpisodicEntryId,
        });
      }
    }
    return state;
  });
}

export async function getAgentMemoryNomination(agentId: string, nominationId: string): Promise<AgentMemoryNomination | undefined> {
  return (await projectNominations(agentId)).get(nominationId);
}

export async function listAgentMemoryNominations(
  agentId: string,
  filter?: { status?: NominationStatus },
): Promise<AgentMemoryNomination[]> {
  const all = [...(await projectNominations(agentId)).values()].sort((a, b) => a.nominatedAt.localeCompare(b.nominatedAt));
  return filter?.status ? all.filter((n) => n.status === filter.status) : all;
}

/** The human review step that actually "adds the points" — approving a
 *  nomination creates a real episodic entry weighted as an explicit
 *  correction (wasExplicitCorrection: true), which crosses the
 *  promotion threshold on its own for a fresh entry via the SAME
 *  scoreEligibility()/dreaming pipeline every other memory uses. No
 *  bypass path: this is a normal episodic write that happens to be
 *  triggered by a review action instead of writeEpisodic() being called
 *  directly. Throws if the nomination doesn't exist or was already
 *  reviewed — a double-approval or approving a rejected nomination is a
 *  caller bug, not a silently-ignored no-op. */
export async function approveAgentMemory(
  agentId: string,
  nominationId: string,
  reviewNote?: string,
): Promise<EpisodicEntry> {
  const nomination = await getAgentMemoryNomination(agentId, nominationId);
  if (!nomination) throw new Error(`no such nomination: ${nominationId}`);
  if (nomination.status !== "pending") {
    throw new Error(`nomination ${nominationId} was already reviewed (status: ${nomination.status})`);
  }

  const entry = await writeEpisodic({
    agentId,
    content: nomination.content,
    kind: nomination.kind,
    sourceSessionId: nomination.sourceSessionId,
    wasExplicitCorrection: true,
    agentFlaggedImportant: true,
  });

  await appendEvent(nominationsStream(agentId), "memory.nomination.reviewed", {
    nominationId,
    status: "approved",
    reviewNote,
    resultingEpisodicEntryId: entry.id,
  });

  return entry;
}

/** Rejects a nomination — no episodic entry is ever created, so it can
 *  never influence curated memory. The rejection itself stays in the
 *  audit trail (you can always see what the agent proposed and that you
 *  said no), it just never crosses into the memory pipeline at all. */
export async function rejectAgentMemory(agentId: string, nominationId: string, reviewNote?: string): Promise<void> {
  const nomination = await getAgentMemoryNomination(agentId, nominationId);
  if (!nomination) throw new Error(`no such nomination: ${nominationId}`);
  if (nomination.status !== "pending") {
    throw new Error(`nomination ${nominationId} was already reviewed (status: ${nomination.status})`);
  }
  await appendEvent(nominationsStream(agentId), "memory.nomination.reviewed", {
    nominationId,
    status: "rejected",
    reviewNote,
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
  // A bounded, defense-in-depth signal: an agent's own "this seems
  // important" flag, on its own, is worth less than half the threshold —
  // it can nudge a borderline entry but can never alone cross the gate.
  // The PRIMARY channel for agent-influenced memory is the nomination +
  // human-approval flow above, which earns its weight via
  // wasExplicitCorrection instead; this exists so the flag still means
  // something on any entry that carries it via a different path.
  if (entry.agentFlaggedImportant) score += 10;
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

// ---- Retrieval: inject only what's RELEVANT, not the whole document ----
//
// Below a small line-count threshold, retrieval is skipped entirely and
// everything is returned — there's no point filtering a 3-line document,
// and this keeps behavior backward-compatible with a freshly-started
// agent whose curated memory is still small. Above the threshold, lines
// are scored against the current query text via the same
// zero-dependency Jaccard similarity used for repetition detection, and
// only the most relevant subset is returned — restored to original
// document order (not sorted by score) so the injected excerpt still
// reads as coherent prose rather than a shuffled bag of lines.

export const RETRIEVAL_LINE_THRESHOLD = 8;
export const RETRIEVAL_TOP_N = 6;

export interface LineRetrievalResult {
  lines: string[];
  totalLines: number;
  usedRetrieval: boolean;
}

/** Pure, synchronous, and independently testable: given a block of text
 *  and a query, returns either everything (small corpus) or the top-N
 *  most relevant lines in original order (large corpus). */
export function retrieveRelevantLines(fullText: string, queryText: string, topN = RETRIEVAL_TOP_N): LineRetrievalResult {
  const allLines = fullText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (allLines.length <= RETRIEVAL_LINE_THRESHOLD) {
    return { lines: allLines, totalLines: allLines.length, usedRetrieval: false };
  }

  const scored = allLines.map((line, idx) => ({ line, idx, score: textSimilarity(line, queryText) }));
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, topN).sort((a, b) => a.idx - b.idx); // restore original document order
  return { lines: top.map((t) => t.line), totalLines: allLines.length, usedRetrieval: true };
}

export interface MemoryRetrievalResult {
  memoryLines: string[];
  userProfileLines: string[];
  memoryTotalLines: number;
  userProfileTotalLines: number;
  usedRetrieval: boolean;
}

/** Retrieves only the relevant subset of curated memory for a given
 *  query (typically the current turn's user message) instead of
 *  dumping the entire MEMORY.md/USER.md every time — the actual
 *  "ekte retrieval i stedet for full-dump" the user asked for. */
export async function retrieveMemoryContext(agentId: string, queryText: string): Promise<MemoryRetrievalResult> {
  const curated = await getCuratedMemory(agentId);
  const mem = retrieveRelevantLines(curated.content, queryText);
  const prof = retrieveRelevantLines(curated.userProfile, queryText);
  return {
    memoryLines: mem.lines,
    userProfileLines: prof.lines,
    memoryTotalLines: mem.totalLines,
    userProfileTotalLines: prof.totalLines,
    usedRetrieval: mem.usedRetrieval || prof.usedRetrieval,
  };
}
