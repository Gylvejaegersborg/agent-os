// Standalone tests for the optional embedding-based similarity upgrade
// built on top of text-similarity.ts's zero-dependency Jaccard
// baseline. Two things are proven here:
//
//   1. FALLBACK SAFETY (always run, no setup required): pointing a
//      SimilarityProvider at an Ollama server that does not exist
//      (wrong port) never throws and transparently degrades to plain
//      Jaccard textSimilarity() — the memory.ts call sites (countSimilar
//      via writeEpisodic, retrieveRelevantLinesAsync/retrieveMemoryContext)
//      keep working exactly as they do today with zero backend.
//
//   2. REAL EMBEDDINGS (best-effort, environment-dependent): if a local
//      Ollama server is ACTUALLY reachable at localhost:11434 with an
//      embeddings-capable model, this proves real embedding-based
//      cosine similarity behaves sensibly — paraphrases with very
//      little token overlap score high, unrelated sentences score low.
//      This section SKIPS itself (with a clearly logged reason, not a
//      failure) if no live Ollama embeddings endpoint is available, so
//      the test suite stays runnable with zero setup on any machine.
//
// Run with: node dist/test-memory-embeddings.js
import {
  createSimilarityProvider,
  createJaccardSimilarityProvider,
  cosineSimilarity,
  textSimilarity,
  writeEpisodic,
  retrieveRelevantLinesAsync,
  retrieveMemoryContext,
  runDreamingPass,
  getCuratedMemory,
  newSessionId,
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
  // ---- 0. cosineSimilarity is a safe, pure primitive ----
  assert(cosineSimilarity([1, 0], [1, 0]) > 0.99, "identical vectors score ~1.0");
  assert(Math.abs(cosineSimilarity([1, 0], [0, 1]) - 0.5) < 0.001, "orthogonal vectors score ~0.5 on the rescaled [0,1] range");
  assert(cosineSimilarity([], []) === 0, "empty vectors score 0, not NaN");
  assert(cosineSimilarity([1, 2], [1, 2, 3]) === 0, "mismatched-length vectors score 0, not a crash");

  // ---- 1. Explicit Jaccard provider: same numbers as textSimilarity() ----
  const jaccardProvider = createJaccardSimilarityProvider();
  const directJaccard = textSimilarity("User prefers short answers", "User likes brief replies");
  const viaProvider = await jaccardProvider.similarity("User prefers short answers", "User likes brief replies");
  assert(directJaccard === viaProvider, `createJaccardSimilarityProvider() matches textSimilarity() exactly (${directJaccard} === ${viaProvider})`);
  assert(jaccardProvider.usingEmbeddings === false, "the explicit Jaccard provider never reports usingEmbeddings");

  // ---- 2. Fallback safety: Ollama unreachable (wrong port) ----
  const deadProvider = createSimilarityProvider({ baseUrl: "http://localhost:1", timeoutMs: 800 });
  const fallbackScoreHigh = await deadProvider.similarity("User prefers short answers", "User likes brief replies");
  const fallbackScoreLow = await deadProvider.similarity("User prefers short answers", "The build script is at ./scripts/build.sh");
  assert(
    fallbackScoreHigh === textSimilarity("User prefers short answers", "User likes brief replies"),
    `an unreachable embedding backend transparently falls back to Jaccard's exact score (got ${fallbackScoreHigh.toFixed(3)})`,
  );
  assert(fallbackScoreLow < fallbackScoreHigh, "fallback path still distinguishes paraphrases from unrelated sentences");
  assert(deadProvider.usingEmbeddings === false, "usingEmbeddings correctly reports false after a failed connection");

  // Never throws even under repeated calls / different malformed configs.
  let threwOnBadHost = false;
  try {
    const alsoDeadProvider = createSimilarityProvider({ baseUrl: "http://127.0.0.1:59999", timeoutMs: 500 });
    await alsoDeadProvider.similarity("a", "b");
    await alsoDeadProvider.similarity("c", "d"); // second call should skip straight to Jaccard, no retry hang
  } catch {
    threwOnBadHost = true;
  }
  assert(!threwOnBadHost, "similarity() never throws even across repeated calls against a dead host");

  // Fallback also verified end-to-end through memory.ts's real call
  // sites (writeEpisodic -> countSimilar, retrieveMemoryContext) with a
  // provider pointed at nothing — proves the WHOLE pipeline, not just
  // the provider in isolation, degrades gracefully.
  const fallbackAgentId = "embeddings-fallback-agent";
  const fallbackSession = newSessionId();
  const deadProvider2 = createSimilarityProvider({ baseUrl: "http://localhost:1", timeoutMs: 800 });
  await writeEpisodic({
    agentId: fallbackAgentId,
    content: "User prefers concise, terse responses without preamble.",
    kind: "preference",
    sourceSessionId: fallbackSession,
    similarityProvider: deadProvider2,
  });
  const secondEntry = await writeEpisodic({
    agentId: fallbackAgentId,
    content: "User likes brief, to-the-point replies with no preamble.",
    kind: "preference",
    sourceSessionId: fallbackSession,
    similarityProvider: deadProvider2,
  });
  assert(
    secondEntry.repetitionCount >= 1,
    `writeEpisodic() with a dead embedding provider still detects the paraphrase via Jaccard fallback (repetitionCount=${secondEntry.repetitionCount})`,
  );

  const manyLines = Array.from({ length: 20 }, (_, i) => `Fact number ${i}: something about topic ${i % 5}.`).join("\n");
  const retrievalWithDeadProvider = await retrieveRelevantLinesAsync(manyLines, "Tell me about topic 2", 6, deadProvider2);
  assert(retrievalWithDeadProvider.usedRetrieval, "retrieveRelevantLinesAsync() with a dead provider still triggers retrieval on a large document");
  assert(
    retrievalWithDeadProvider.lines.some((l) => l.includes("topic 2")),
    "retrieveRelevantLinesAsync() with a dead provider still surfaces the query-relevant line via Jaccard fallback",
  );

  // ---- 3. Best-effort LIVE test: real Ollama embeddings, if reachable ----
  // Probe first so we can log a clear, honest skip reason instead of a
  // silent no-op if the environment has no usable embedding model.
  let liveProbeOk = false;
  let liveProbeReason = "";
  try {
    const res = await fetch("http://localhost:11434/api/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: process.env.OLLAMA_EMBEDDING_MODEL ?? "nomic-embed-text", prompt: "probe" }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const json: any = await res.json();
      if (Array.isArray(json?.embedding) && json.embedding.length > 0) {
        liveProbeOk = true;
      } else {
        liveProbeReason = "server reachable but response had no embedding vector";
      }
    } else {
      liveProbeReason = `server reachable but returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
    }
  } catch (err) {
    liveProbeReason = `${(err as Error)?.message ?? err}`;
  }

  if (!liveProbeOk) {
    console.log(`SKIP: live Ollama embeddings test — no reachable embeddings backend (${liveProbeReason}). This is expected on machines without Ollama running; fallback behavior above is what matters for correctness.`);
  } else {
    console.log("Live Ollama embeddings backend detected — running real semantic similarity assertions.");
    const liveProvider = createSimilarityProvider({ timeoutMs: 5000 });

    // Paraphrase pair with almost NO shared vocabulary — a case Jaccard
    // handles poorly but real embeddings should handle well.
    const paraphraseA = "The database needs a backup before the migration runs.";
    const paraphraseB = "Back up the DB prior to running the schema update.";
    const unrelatedA = "The database needs a backup before the migration runs.";
    const unrelatedB = "My favorite color is blue and I enjoy hiking on weekends.";

    const paraphraseScore = await liveProvider.similarity(paraphraseA, paraphraseB);
    const unrelatedScore = await liveProvider.similarity(unrelatedA, unrelatedB);
    const jaccardParaphraseScore = textSimilarity(paraphraseA, paraphraseB);

    assert(liveProvider.usingEmbeddings === true, "usingEmbeddings reports true once a real embedding call succeeded");
    assert(paraphraseScore > unrelatedScore, `a real semantic paraphrase scores higher than an unrelated sentence pair (${paraphraseScore.toFixed(3)} > ${unrelatedScore.toFixed(3)})`);
    assert(paraphraseScore > 0.6, `a real semantic paraphrase scores solidly high under cosine similarity (got ${paraphraseScore.toFixed(3)}, expected > 0.6)`);
    assert(
      paraphraseScore > jaccardParaphraseScore,
      `embeddings correctly recognize semantic similarity in a low-token-overlap paraphrase where Jaccard mostly fails (embeddings=${paraphraseScore.toFixed(3)} > jaccard=${jaccardParaphraseScore.toFixed(3)})`,
    );

    // Same near-zero-overlap paraphrase, but proven end-to-end through
    // writeEpisodic()'s repetitionCount, since that's the actual call
    // site this upgrade benefits in the real app.
    const liveAgentId = "embeddings-live-agent";
    const liveSession = newSessionId();
    const liveProviderForAgent = createSimilarityProvider({ timeoutMs: 5000 });
    await writeEpisodic({
      agentId: liveAgentId,
      content: paraphraseA,
      kind: "fact",
      sourceSessionId: liveSession,
      similarityProvider: liveProviderForAgent,
    });
    const liveSecondEntry = await writeEpisodic({
      agentId: liveAgentId,
      content: paraphraseB,
      kind: "fact",
      sourceSessionId: liveSession,
      similarityProvider: liveProviderForAgent,
    });
    assert(
      liveSecondEntry.repetitionCount >= 1,
      `writeEpisodic() with a LIVE embedding provider detects a low-token-overlap paraphrase as a repetition (repetitionCount=${liveSecondEntry.repetitionCount}) — Jaccard alone would likely miss this`,
    );

    // retrieveMemoryContext end-to-end with the live provider.
    const retrievalAgentId = "embeddings-live-retrieval-agent";
    const retrievalSession = newSessionId();
    const topics = ["database backups", "deployment pipeline", "authentication flow", "caching strategy", "logging setup", "error handling", "test fixtures", "build scripts", "linting rules", "release process"];
    for (const topic of topics) {
      await writeEpisodic({
        agentId: retrievalAgentId,
        content: `The ${topic} works by following a specific documented procedure unique to ${topic}.`,
        kind: "fact",
        sourceSessionId: retrievalSession,
        wasExplicitCorrection: true,
      });
    }
    await runDreamingPass(retrievalAgentId);
    const curated = await getCuratedMemory(retrievalAgentId);
    const memoryLineCount = curated.content.split("\n").filter((l) => l.trim()).length;
    assert(memoryLineCount > 8, `enough MEMORY.md lines exist to exceed the retrieval threshold for the live embeddings test (got ${memoryLineCount})`);

    const liveRetrievalProvider = createSimilarityProvider({ timeoutMs: 5000 });
    const liveRetrieval = await retrieveMemoryContext(retrievalAgentId, "Back up the DB before running a schema update", liveRetrievalProvider);
    assert(liveRetrieval.usedRetrieval, "retrieveMemoryContext with a live embedding provider triggers real retrieval");
    assert(
      liveRetrieval.memoryLines.some((l) => l.includes("database backups")),
      "retrieveMemoryContext with a live embedding provider surfaces the semantically relevant line despite low token overlap with the query",
    );
  }

  if (process.exitCode === 1) {
    console.error("\nSome memory-embeddings tests FAILED.");
  } else {
    console.log("\nAll memory-embeddings tests passed" + (liveProbeOk ? " (including LIVE Ollama embeddings)." : " (fallback-only — no live Ollama embeddings backend was reachable)."));
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
