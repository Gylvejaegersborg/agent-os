// Standalone tests for the three memory improvements built on top of the
// dedup/split/injection work: (1) similarity-based repetition detection
// replacing exact-substring matching, (2) real retrieval instead of
// full-document injection, and (3) the agent's bounded "nominate a
// memory" voice with mandatory async human approval.
// Run with: node dist/test-memory-v2.js

import "./test-helpers/isolate.js";
import {
  textSimilarity,
  tokenize,
  writeEpisodic,
  runDreamingPass,
  getCuratedMemory,
  retrieveRelevantLines,
  retrieveMemoryContext,
  nominateAgentMemory,
  listAgentMemoryNominations,
  approveAgentMemory,
  rejectAgentMemory,
  scoreEligibility,
  runTurn,
  newSessionId,
  createRecordingModel,
  createStubModel,
  createStubWorker,
} from "./core/index.js";
import type { EpisodicEntry } from "./core/types.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

async function main(): Promise<void> {
  // ---- 1. Similarity-based repetition detection ----
  const simHigh = textSimilarity("User prefers short answers", "User likes brief replies");
  const simLow = textSimilarity("User prefers short answers", "The build script is at ./scripts/build.sh");
  assert(simHigh > 0, `paraphrases share SOME token overlap or synonymy signal (got ${simHigh.toFixed(3)})`);
  assert(simLow < simHigh, `unrelated sentences score lower than paraphrases (${simLow.toFixed(3)} < ${simHigh.toFixed(3)})`);
  assert(textSimilarity("", "") === 0, "two empty strings score 0, not NaN");
  assert(tokenize("The User Prefers.").has("user"), "tokenize lowercases and strips punctuation");
  assert(!tokenize("the a an is").has("the"), "stopwords are excluded from tokens");

  const agentId = "memory-v2-test-agent";
  const sessionId = newSessionId();

  // Two DIFFERENT phrasings of the same underlying fact, back to back.
  await writeEpisodic({
    agentId,
    content: "User prefers concise, terse responses without preamble.",
    kind: "preference",
    sourceSessionId: sessionId,
  });
  const secondPhrasing: EpisodicEntry = await writeEpisodic({
    agentId,
    content: "User likes brief, to-the-point replies with no preamble.",
    kind: "preference",
    sourceSessionId: sessionId,
  });
  assert(
    secondPhrasing.repetitionCount >= 1,
    `a paraphrase of an earlier entry is counted as a repetition (repetitionCount=${secondPhrasing.repetitionCount})`,
  );

  // ---- 2. Retrieval instead of full-dump ----
  const smallText = "line one\nline two\nline three";
  const smallResult = retrieveRelevantLines(smallText, "irrelevant query");
  assert(!smallResult.usedRetrieval, "a small document (under the line threshold) returns everything, no filtering");
  assert(smallResult.lines.length === 3, "small document retrieval returns all 3 lines");

  const manyLines = Array.from({ length: 20 }, (_, i) => `Fact number ${i}: something about topic ${i % 5}.`).join("\n");
  const bigResult = retrieveRelevantLines(manyLines, "Tell me about topic 2");
  assert(bigResult.usedRetrieval, "a large document (over the line threshold) triggers retrieval");
  assert(bigResult.lines.length < bigResult.totalLines, `retrieval returns FEWER lines than the total (${bigResult.lines.length} < ${bigResult.totalLines})`);
  assert(
    bigResult.lines.some((l) => l.includes("topic 2")),
    "retrieval actually surfaces lines relevant to the query, not arbitrary ones",
  );
  // Order preservation: retrieved lines should appear in the same
  // relative order as the original document (not sorted by score).
  const indices = bigResult.lines.map((l) => manyLines.split("\n").indexOf(l));
  const sortedIndices = [...indices].sort((a, b) => a - b);
  assert(JSON.stringify(indices) === JSON.stringify(sortedIndices), "retrieved lines preserve original document order");

  // End-to-end retrieveMemoryContext against real curated memory: build
  // up MEMORY.md past the retrieval threshold with clearly distinct facts.
  const retrievalAgentId = "memory-v2-retrieval-agent";
  const retrievalSession = newSessionId();
  const topics = ["database migrations", "deployment pipeline", "authentication flow", "caching strategy", "logging setup", "error handling", "test fixtures", "build scripts", "linting rules", "release process"];
  for (const topic of topics) {
    await writeEpisodic({
      agentId: retrievalAgentId,
      content: `The ${topic} works by following a specific documented procedure unique to ${topic}.`,
      kind: "fact",
      sourceSessionId: retrievalSession,
      wasExplicitCorrection: true, // ensure every one crosses the promotion threshold
    });
  }
  await runDreamingPass(retrievalAgentId);
  const curatedForRetrieval = await getCuratedMemory(retrievalAgentId);
  const memoryLineCount = curatedForRetrieval.content.split("\n").filter((l) => l.trim()).length;
  assert(memoryLineCount > 8, `enough MEMORY.md lines exist to exceed the retrieval threshold (got ${memoryLineCount})`);

  const retrieval = await retrieveMemoryContext(retrievalAgentId, "How does the caching strategy work?");
  assert(retrieval.usedRetrieval, "retrieveMemoryContext triggers real retrieval once MEMORY.md is large enough");
  assert(
    retrieval.memoryLines.some((l) => l.includes("caching strategy")),
    "retrieveMemoryContext surfaces the line relevant to the query",
  );
  assert(retrieval.memoryLines.length < retrieval.memoryTotalLines, "retrieveMemoryContext returns fewer lines than the full document");

  // ---- 3. Bounded agent voice: nominate -> pending -> human approval ----
  const nomAgentId = "memory-v2-nomination-agent";
  const nomSession = newSessionId();

  const nomination = await nominateAgentMemory({
    agentId: nomAgentId,
    content: "The user mentioned they're allergic to shellfish.",
    kind: "fact",
    sourceSessionId: nomSession,
  });
  assert(nomination.status === "pending", `a fresh nomination starts as "pending" (got "${nomination.status}")`);

  const curatedBeforeApproval = await getCuratedMemory(nomAgentId);
  const passBeforeApproval = await runDreamingPass(nomAgentId);
  const curatedStillBeforeApproval = await getCuratedMemory(nomAgentId);
  assert(
    curatedStillBeforeApproval.content === curatedBeforeApproval.content,
    "a PENDING nomination has ZERO effect on curated memory even after a dreaming pass runs",
  );
  assert(passBeforeApproval.episodicEntriesReviewed === 0, "a pending nomination does not even create an episodic entry until approved");

  const pendingList = await listAgentMemoryNominations(nomAgentId, { status: "pending" });
  assert(pendingList.length === 1 && pendingList[0]?.id === nomination.id, "listAgentMemoryNominations({ status: 'pending' }) finds the nomination");

  // Approve it — THIS is what "adds the points."
  const approvedEntry = await approveAgentMemory(nomAgentId, nomination.id, "Confirmed, this is correct and important.");
  assert(approvedEntry.wasExplicitCorrection, "approving a nomination creates an episodic entry weighted as an explicit correction");
  assert(approvedEntry.agentFlaggedImportant === true, "the resulting episodic entry keeps the agentFlaggedImportant provenance marker");
  const scoreAfterApproval = scoreEligibility(approvedEntry);
  assert(scoreAfterApproval >= 40, `an approved nomination's episodic entry scores at/above the promotion threshold on its own (got ${scoreAfterApproval})`);

  const approvedNomination = await listAgentMemoryNominations(nomAgentId, { status: "approved" });
  assert(approvedNomination.length === 1 && approvedNomination[0]?.resultingEpisodicEntryId === approvedEntry.id, "the nomination record links to its resulting episodic entry");

  const passAfterApproval = await runDreamingPass(nomAgentId);
  const curatedAfterApproval = await getCuratedMemory(nomAgentId);
  assert(passAfterApproval.episodicEntriesReviewed === 1, "the approved nomination's episodic entry is now reviewed by dreaming");
  assert(curatedAfterApproval.content.includes("shellfish"), "the approved, dreaming-promoted content now appears in MEMORY.md");

  // Double-approval / approving-after-reject should fail loudly, not silently no-op.
  let doubleApproveThrew = false;
  try {
    await approveAgentMemory(nomAgentId, nomination.id);
  } catch {
    doubleApproveThrew = true;
  }
  assert(doubleApproveThrew, "approving an already-reviewed nomination throws rather than silently no-opping");

  // Rejection: creates NO episodic entry, ever.
  const rejectedNomination = await nominateAgentMemory({
    agentId: nomAgentId,
    content: "The user said something the agent misheard as important.",
    kind: "fact",
    sourceSessionId: nomSession,
  });
  await rejectAgentMemory(nomAgentId, rejectedNomination.id, "Not actually relevant.");
  const rejectedList = await listAgentMemoryNominations(nomAgentId, { status: "rejected" });
  assert(rejectedList.some((n) => n.id === rejectedNomination.id), "a rejected nomination is recorded with status 'rejected'");
  const finalDreamingPass = await runDreamingPass(nomAgentId);
  assert(finalDreamingPass.episodicEntriesReviewed === 1, "a REJECTED nomination never created an episodic entry — reviewed count unchanged");

  // ---- 4. End-to-end through the real agent loop: the tool itself ----
  const liveAgentId = "memory-v2-live-agent";
  const liveSessionId = newSessionId();
  const recordingModel = createRecordingModel(createStubModel());
  const turnResult = await runTurn({
    sessionId: liveSessionId,
    agentId: liveAgentId,
    userMessage: "nominate memory: The user's timezone is UTC+2.",
    model: recordingModel,
    worker: createStubWorker(),
    enableMemoryNominations: true,
  });
  assert(turnResult.toolCalled === "nominate-memory", `the model actually called the nominate-memory tool (got "${turnResult.toolCalled}")`);
  const liveNominations = await listAgentMemoryNominations(liveAgentId);
  assert(liveNominations.length === 1 && liveNominations[0]?.status === "pending", "a real agent-loop turn's nomination lands as pending, same as calling nominateAgentMemory() directly");

  // Without enableMemoryNominations, the tool call is rejected.
  const gatedSessionId = newSessionId();
  const gatedResult = await runTurn({
    sessionId: gatedSessionId,
    agentId: liveAgentId,
    userMessage: "nominate memory: this should be rejected",
    model: createStubModel(),
    worker: createStubWorker(),
    // enableMemoryNominations intentionally omitted
  });
  assert(gatedResult.finalContent.includes("not enabled"), "without enableMemoryNominations, the nomination is rejected rather than silently working");

  if (process.exitCode === 1) {
    console.error("\nSome memory-v2 tests FAILED.");
  } else {
    console.log("\nAll memory-v2 tests passed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
