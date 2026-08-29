// Standalone tests proving Agent identity (identity.ts) actually affects
// behavior now, rather than being a stored-but-never-read projection:
//   1. An agent WITH a registered identity gets its persona injected into
//      the real system message sent to the model (verified via
//      model.ts's createRecordingModel() wrapper, the same technique
//      test-memory.ts already uses to prove memory injection).
//   2. An agent with NO registered identity still runs exactly as before
//      — this wiring is optional/additive, never a hard dependency.
//   3. The sibling defaultModel wiring (models/real.ts's
//      setAgentDefaultModel/getAgentDefaultModel/createModelForAgent)
//      behaves as designed: it can override which MODEL NAME is
//      requested from an already-credentialed provider, but never
//      conjures a provider that isn't already available via env vars.
// Run with: node dist/test-identity-wiring.js

import {
  registerAgentIdentity,
  getAgentIdentity,
  runTurn,
  newSessionId,
  createRecordingModel,
  createStubModel,
  createStubWorker,
  setAgentDefaultModel,
  getAgentDefaultModel,
  createModelForAgent,
  createModelFromEnv,
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
  // ---- 1. Persona genuinely reaches the model's system message ----
  const identifiedAgentId = "identity-wiring-test-agent";
  const persona = "You are an unusually blunt code reviewer who never sugarcoats feedback about semicolons.";
  const registered = await registerAgentIdentity({
    id: identifiedAgentId,
    name: "Grumpy Reviewer",
    persona,
  });
  assert(registered.persona === persona, "registerAgentIdentity() projects the persona back correctly");

  const fetchedIdentity = await getAgentIdentity(identifiedAgentId);
  assert(fetchedIdentity?.persona === persona, "getAgentIdentity() finds the just-registered identity");

  const recordingModel = createRecordingModel(createStubModel());
  const turnResult = await runTurn({
    sessionId: newSessionId(),
    agentId: identifiedAgentId,
    userMessage: "hello, please review my code",
    model: recordingModel,
    worker: createStubWorker(),
  });
  const sentMessages = recordingModel.lastMessages();
  assert(sentMessages !== undefined, "createRecordingModel captured a call to complete()");
  const systemMessage = sentMessages?.find((m) => m.role === "system");
  assert(systemMessage !== undefined, "a system message was constructed for an agent with a registered identity");
  assert(
    !!systemMessage?.content.includes(persona),
    "the agent's exact persona text appears verbatim in the system message actually sent to the model",
  );
  assert(
    !!systemMessage?.content.includes("Grumpy Reviewer"),
    "the agent's registered name also appears in the injected identity block",
  );
  assert(turnResult.finalContent.length > 0, "the turn still completes normally with identity injected");

  // ---- 2. No registered identity: regression-safe, unchanged behavior ----
  const anonymousAgentId = "no-identity-registered-test-agent";
  const anonymousIdentity = await getAgentIdentity(anonymousAgentId);
  assert(anonymousIdentity === undefined, "an agentId that was never registered has no identity (sanity check)");

  const anonRecordingModel = createRecordingModel(createStubModel());
  const anonTurnResult = await runTurn({
    sessionId: newSessionId(),
    agentId: anonymousAgentId,
    userMessage: "hello",
    model: anonRecordingModel,
    worker: createStubWorker(),
    // no skills, no memory content, no subagents/nominations -> with no
    // identity either, systemParts should end up fully empty.
    injectMemory: false,
  });
  const anonMessages = anonRecordingModel.lastMessages();
  const anonSystemMessage = anonMessages?.find((m) => m.role === "system");
  assert(
    anonSystemMessage === undefined,
    "an agent with no registered identity (and nothing else to inject) gets no system message at all — same as pre-wiring behavior",
  );
  assert(anonTurnResult.finalContent.length > 0, "a turn for an unregistered agent still completes normally (construction never breaks)");

  // Same check, but with skills/memory context present (injectMemory
  // defaults true) — proves identity injection is purely ADDITIVE and
  // doesn't disturb the existing systemParts assembly when identity is
  // absent but other parts are present.
  const anonWithMemoryModel = createRecordingModel(createStubModel());
  await runTurn({
    sessionId: newSessionId(),
    agentId: anonymousAgentId,
    userMessage: "hello again",
    model: anonWithMemoryModel,
    worker: createStubWorker(),
  });
  const anonWithMemorySystemMessage = anonWithMemoryModel.lastMessages()?.find((m) => m.role === "system");
  assert(
    anonWithMemorySystemMessage === undefined || !anonWithMemorySystemMessage.content.includes("# Agent Identity"),
    "no identity block appears for an unregistered agent even when other system-message parts might exist",
  );

  // ---- 3. defaultModel wiring: precedence rules hold ----
  const modelPrefAgentId = "default-model-wiring-test-agent";

  const noPrefYet = await getAgentDefaultModel(modelPrefAgentId);
  assert(noPrefYet === undefined, "an agent with no registered model preference returns undefined");

  await setAgentDefaultModel(modelPrefAgentId, "claude-opus-4-hypothetical-test-model");
  const storedPref = await getAgentDefaultModel(modelPrefAgentId);
  assert(
    storedPref === "claude-opus-4-hypothetical-test-model",
    `setAgentDefaultModel()/getAgentDefaultModel() round-trip correctly (got "${storedPref}")`,
  );

  // Overwriting replaces the preference (not additive/cumulative).
  await setAgentDefaultModel(modelPrefAgentId, "claude-sonnet-4-hypothetical-test-model-v2");
  const updatedPref = await getAgentDefaultModel(modelPrefAgentId);
  assert(
    updatedPref === "claude-sonnet-4-hypothetical-test-model-v2",
    `a second setAgentDefaultModel() call overwrites the preference rather than appending (got "${updatedPref}")`,
  );

  // Rule 1: a stored preference can NEVER conjure a provider that isn't
  // already credentialed via env vars. Since this test process has no
  // ANTHROPIC_TOKEN/ANTHROPIC_API_KEY/OPENAI_API_KEY set (or if it does,
  // we can't assume that in CI — so explicitly probe createModelFromEnv()
  // with no args first to establish ground truth for this run).
  const envHasProvider = createModelFromEnv() !== undefined;
  const resolvedForPreffedAgent = await createModelForAgent(modelPrefAgentId, {
    // point Ollama probing at a deliberately unreachable port so this
    // test is not flaky depending on whether the machine happens to
    // have Ollama running locally.
    baseUrl: "http://127.0.0.1:1/v1/chat/completions",
  });
  if (!envHasProvider) {
    assert(
      resolvedForPreffedAgent === undefined,
      "with no provider env vars set and Ollama unreachable, a registered model preference alone does NOT produce an adapter (preference can't conjure a provider)",
    );
  } else {
    // Rule 2: when a provider IS available, the agent's preferred model
    // name is genuinely threaded through as the adapter's model id.
    assert(
      !!resolvedForPreffedAgent?.id.includes("claude-sonnet-4-hypothetical-test-model-v2"),
      `when a provider is credentialed, the agent's registered model preference is used as the adapter's model name (got id="${resolvedForPreffedAgent?.id}")`,
    );
    console.log("(Note: this run has real provider env vars set, so rule 2 was exercised instead of rule 1's fallback branch.)");
  }

  // Rule 3: with NO registered preference, createModelForAgent() behaves
  // identically to calling createModelFromEnvOrOllama() directly.
  const noPrefAgentId = "no-default-model-preference-test-agent";
  const resolvedForUnprefferedAgent = await createModelForAgent(noPrefAgentId, {
    baseUrl: "http://127.0.0.1:1/v1/chat/completions",
  });
  if (!envHasProvider) {
    assert(
      resolvedForUnprefferedAgent === undefined,
      "an agent with no registered preference and no available provider/Ollama resolves to undefined, same as before this wiring existed",
    );
  } else {
    assert(
      resolvedForUnprefferedAgent !== undefined && !resolvedForUnprefferedAgent.id.includes("hypothetical-test-model"),
      "an agent with no registered preference gets the provider's own default model name, not another agent's preference leaking across",
    );
  }

  if (process.exitCode === 1) {
    console.error("\nSome identity-wiring tests FAILED.");
  } else {
    console.log("\nAll identity-wiring tests passed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
