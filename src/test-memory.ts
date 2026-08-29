// Standalone tests for the memory improvements: dedup across dreaming
// passes, the MEMORY.md/USER.md split, and — the most important part —
// PROOF that curated memory is actually injected into a real agent-loop
// turn's system message, not just computed and left unread.
// Run with: node dist/test-memory.js

import {
  writeEpisodic,
  runDreamingPass,
  getCuratedMemory,
  runTurn,
  newSessionId,
  createRecordingModel,
  createStubModel,
  createStubWorker,
} from "./core/index.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

async function main(): Promise<void> {
  const agentId = "memory-test-agent";
  const sessionId = newSessionId();

  // 1. MEMORY.md / USER.md split: a "preference" entry goes to
  // userProfile, a "fact"/"correction"/etc. entry goes to content.
  await writeEpisodic({
    agentId,
    content: "User prefers dark mode UIs.",
    kind: "preference",
    sourceSessionId: sessionId,
    wasExplicitCorrection: true, // score: 50+20=70, well above threshold
  });
  await writeEpisodic({
    agentId,
    content: "The build script is at ./scripts/build.sh.",
    kind: "fact",
    sourceSessionId: sessionId,
    wasExplicitCorrection: true, // score: 50, above threshold
  });

  const pass1 = await runDreamingPass(agentId);
  const afterPass1 = await getCuratedMemory(agentId);
  assert(
    afterPass1.userProfile.includes("dark mode") && !afterPass1.content.includes("dark mode"),
    "a 'preference' entry is promoted into USER.md, not MEMORY.md",
  );
  assert(
    afterPass1.content.includes("build.sh") && !afterPass1.userProfile.includes("build.sh"),
    "a non-preference entry is promoted into MEMORY.md, not USER.md",
  );

  // 2. Dedup: running the dreaming pass AGAIN with no new episodic writes
  // must not duplicate the already-promoted content.
  const pass2 = await runDreamingPass(agentId);
  const afterPass2 = await getCuratedMemory(agentId);
  assert(pass2.episodicEntriesReviewed === pass1.episodicEntriesReviewed, "second pass reviews the same entry count (nothing new was written)");
  assert(afterPass2.content === afterPass1.content, "MEMORY.md content is IDENTICAL after a second pass with no new writes (dedup works)");
  assert(afterPass2.userProfile === afterPass1.userProfile, "USER.md content is IDENTICAL after a second pass with no new writes (dedup works)");
  const dupCount = (afterPass2.content.match(/build\.sh/g) ?? []).length;
  assert(dupCount === 1, `"build.sh" appears exactly once in MEMORY.md, not duplicated (found ${dupCount} times)`);

  // 3. A THIRD entry that becomes newly eligible after another dreaming
  // pass should be ADDED, not replace what's already there, and should
  // not re-trigger duplication of the earlier entries.
  await writeEpisodic({
    agentId,
    content: "Tests run via `npm test` from the repo root.",
    kind: "fact",
    sourceSessionId: sessionId,
    wasExplicitCorrection: true,
  });
  const pass3 = await runDreamingPass(agentId);
  const afterPass3 = await getCuratedMemory(agentId);
  assert(afterPass3.content.includes("build.sh") && afterPass3.content.includes("npm test"), "a newly-eligible entry is ADDED alongside prior promotions, not replacing them");
  const dupCountAfterNew = (afterPass3.content.match(/build\.sh/g) ?? []).length;
  assert(dupCountAfterNew === 1, "the earlier entry is still not duplicated after a new promotion");

  // 4. THE ACTUAL POINT: prove curated memory is injected into a real
  // agent-loop turn's system message, not just computed and left unread.
  const recordingModel = createRecordingModel(createStubModel());
  const newSession = newSessionId(); // a FRESH session — memory must come from curated store, not session history
  await runTurn({
    sessionId: newSession,
    agentId,
    userMessage: "Hello, what do you remember?",
    model: recordingModel,
    worker: createStubWorker(),
  });
  const sentMessages = recordingModel.lastMessages();
  const systemMessage = sentMessages?.find((m) => m.role === "system");
  assert(!!systemMessage, "a system message was sent to the model");
  assert(!!systemMessage?.content.includes("build.sh"), "the system message includes MEMORY.md content (build.sh)");
  assert(!!systemMessage?.content.includes("dark mode"), "the system message includes USER.md content (dark mode preference)");
  assert(!!systemMessage?.content.includes("MEMORY.md"), "the system message labels the MEMORY.md section");
  assert(!!systemMessage?.content.includes("USER.md"), "the system message labels the USER.md section");

  // 5. injectMemory: false opts a turn out of memory injection entirely.
  const noMemorySession = newSessionId();
  const recordingModel2 = createRecordingModel(createStubModel());
  await runTurn({
    sessionId: noMemorySession,
    agentId,
    userMessage: "Hello again.",
    model: recordingModel2,
    worker: createStubWorker(),
    injectMemory: false,
  });
  const sentMessages2 = recordingModel2.lastMessages();
  const systemMessage2 = sentMessages2?.find((m) => m.role === "system");
  assert(
    !systemMessage2 || !systemMessage2.content.includes("build.sh"),
    "injectMemory: false means curated memory is NOT injected",
  );

  if (process.exitCode === 1) {
    console.error("\nSome memory tests FAILED.");
  } else {
    console.log("\nAll memory tests passed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
