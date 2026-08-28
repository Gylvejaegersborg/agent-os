#!/usr/bin/env node
// Live smoke test for the real model adapters — actually calls the API
// (Anthropic, whichever key is present) and runs a full agent-loop turn
// through it, proving the adapter isn't just type-compatible but genuinely
// interchangeable with the stub. Not part of `npm run demo` (which stays
// zero-dependency/zero-cost) — run explicitly when you have a key handy.

import { createModelFromEnvOrOllama, createStubWorker, runTurn, newSessionId } from "./core/index.js";

async function main(): Promise<void> {
  const model = await createModelFromEnvOrOllama();
  if (!model) {
    console.error(
      "No model available. Set ANTHROPIC_TOKEN/ANTHROPIC_API_KEY/OPENAI_API_KEY, or start a local Ollama server ('ollama serve') and retry.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Using real model adapter: ${model.id}\n`);

  const sessionId = newSessionId();
  const worker = createStubWorker("stub", { ok: true, output: "42 files changed, all green." });

  const result = await runTurn({
    sessionId,
    agentId: "live-test-agent",
    userMessage:
      "In one short sentence, confirm you received this message and that you are a real model, not a stub.",
    model,
    worker,
  });

  console.log("Model response:", result.finalContent);
  console.log(`\nSession stream: data/streams/session_${sessionId}.jsonl`);
}

main().catch((err) => {
  console.error("Live model test failed:", err);
  process.exitCode = 1;
});
