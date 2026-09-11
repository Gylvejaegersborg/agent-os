// Gateway process entrypoint — `npm run gateway`. Separate from cli.ts's
// interactive REPL on purpose: this is the "run as a long-lived server"
// entrypoint the architecture audit flagged as missing ("no core feature
// depends on the CLI REPL" is a stated goal). Picks a real model the same
// way cli.ts's own bootstrapping does (env vars, falling back to a local
// Ollama instance, falling back to the deterministic stub so the gateway
// is always runnable with zero configuration), then starts listening.

import { createModelFromEnvOrOllama, createStubModel, createLocalShellWorker, seedDefaultAgents } from "../core/index.js";
import { startGateway } from "./server.js";

async function main(): Promise<void> {
  const port = process.env.AGENT_OS_GATEWAY_PORT ? Number(process.env.AGENT_OS_GATEWAY_PORT) : 8787;

  const model = (await createModelFromEnvOrOllama()) ?? createStubModel();
  if (model.id === "stub-model") {
    console.log(
      "[gateway] no ANTHROPIC_TOKEN/ANTHROPIC_API_KEY/OPENAI_API_KEY set and Ollama not reachable — " +
        "running with the deterministic stub model. Set a provider env var for real model calls.",
    );
  } else {
    console.log(`[gateway] using model adapter: ${model.id}`);
  }

  const worker = createLocalShellWorker();

  // Seeds the authoritative ISΛRK agent roster (agents.ts) if it isn't
  // already registered — idempotent, so restarting the gateway never
  // duplicates identity-registration events. This is what makes GET
  // /agents return real data on a fresh data dir instead of an empty list.
  const roster = await seedDefaultAgents();
  console.log(`[gateway] agent registry ready: ${roster.map((a) => a.id).join(", ")}`);

  const handle = await startGateway({ model, worker }, port);
  console.log(`[gateway] listening on http://127.0.0.1:${handle.port}`);

  const shutdown = async (): Promise<void> => {
    console.log("\n[gateway] shutting down...");
    await handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[gateway] fatal:", err);
  process.exit(1);
});
