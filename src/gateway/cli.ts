// Gateway process entrypoint — `npm run gateway`. Separate from cli.ts's
// interactive REPL on purpose: this is the "run as a long-lived server"
// entrypoint the architecture audit flagged as missing ("no core feature
// depends on the CLI REPL" is a stated goal). Picks a real model the same
// way cli.ts's own bootstrapping does (env vars, falling back to a local
// Ollama instance, falling back to the deterministic stub so the gateway
// is always runnable with zero configuration), then starts listening.

import * as path from "node:path";
import {
  createModelFromEnvOrOllama,
  createStubModel,
  createLocalShellWorker,
  createSandboxedWorker,
  seedDefaultAgents,
  reconcileLostTasks,
  startTaskTimeoutSweeper,
  startTaskLivenessRenewer,
  startMemoryDreamingSweeper,
  registerHook,
  installPermissionPolicy,
  DEFAULT_HARD_BLOCKLIST,
  SkillRegistry,
  type SandboxPolicy,
} from "../core/index.js";
import { startGateway } from "./server.js";

// The one agent allowed to touch a real shell at all. Deliberately a
// single, well-known id rather than a config knob: this whole feature
// (agents fixing their own harness) is scoped to ONE agent on purpose —
// every OTHER agent in the roster (seedDefaultAgents()) stays exactly as
// sandboxed as it always was (zero shell access), no matter what a user
// asks it to do. "claude" already exists in that roster with persona
// "A general-purpose software engineering agent for the ISΛRK operator's
// own dashboard and tooling" and capabilities ["shell", "code-editing",
// "subagent-delegation"] — this is that agent made real instead of
// aspirational.
const ENGINEER_AGENT_ID = "claude";

// Every tool that can touch the filesystem or a real shell — restricted to
// ENGINEER_AGENT_ID below, same reasoning as the shell-only version this
// replaced. read_file/edit_file/write_file (agent-loop.ts) are the
// structured alternative to editing via shell redirection — same
// capability, same restriction, just a cleaner primitive for the model
// (and a diff-able one for the Approvals tab) instead of an opaque
// command string.
const FILESYSTEM_TOOLS = ["shell", "read_file", "edit_file", "write_file"];

/** Builds the Layer-A PermissionPolicy for ENGINEER_AGENT_ID. Read-only
 *  inspection (shell's own safe-command list, plus read_file uncondition-
 *  ally — a file read carries the same risk profile as `cat`) is
 *  pre-approved so diagnosing a problem doesn't require a round trip
 *  through the Approvals tab for every lookup; genuinely mutating calls
 *  (shell edits, `git add`/`commit`, installs, edit_file, write_file) fall
 *  through to the policy's default "ask" — there is no "allow" rule for
 *  writes anywhere in this list, on purpose. `git push` (or anything else
 *  that reaches GitHub) is never special-cased into "allow" either, so it
 *  always lands in the Approvals tab too, regardless of what else this
 *  policy permits. The infra-path rule uses tool:"*" so it catches
 *  edit_file/write_file touching .github/.devcontainer/scripts the same
 *  way it already caught a shell command mentioning them. */
function buildEngineerPolicy() {
  const SAFE_READONLY = /"command":\s*"\s*(git (status|diff|log|show|branch\b[^&|;]*--list)|ls\b|cat\b|head\b|tail\b|grep\b|rg\b|wc\b|pwd\b|npm run (typecheck|build|test[\w-]*)\b|tsc\b)/;
  const INFRA_PATHS = /\.github\/|\.devcontainer\/|(^|[\s"'/])scripts\//;
  return {
    agentId: ENGINEER_AGENT_ID,
    rules: [
      {
        tool: "*",
        decision: "ask" as const,
        argsPattern: INFRA_PATHS,
        label:
          "touches CI/infra (.github/, .devcontainer/, or scripts/) — these run with elevated trust " +
          "(Actions secrets, the devcontainer itself), so they're always reviewed regardless of what the call does.",
      },
      { tool: "shell", decision: "allow" as const, argsPattern: SAFE_READONLY },
      { tool: "read_file", decision: "allow" as const },
      // No further rules: anything else (shell edits, git add/commit/push,
      // npm/apt installs, rm, edit_file, write_file, ...) falls through to
      // the default "ask".
    ],
  };
}

async function main(): Promise<void> {
  const port = process.env.AGENT_OS_GATEWAY_PORT ? Number(process.env.AGENT_OS_GATEWAY_PORT) : 8787;

  // Reconciles BEFORE this process creates/resumes any Tasks of its own —
  // any Task the durable event log still shows as 'running' whose
  // liveness has already gone stale (e.g. the gateway itself crashed and
  // got restarted) is orphaned now, per tasks.ts's reconcileLostTasks().
  const reconciled = await reconcileLostTasks();
  if (reconciled.lost.length) {
    console.log(`[gateway] reconciliation found ${reconciled.lost.length} orphaned task(s) from a previous run: ${reconciled.lost.join(", ")}`);
  }
  // Keeps enforcing Task timeouts and renewing this process's OWN running
  // Tasks' durable liveness for as long as the gateway is up — see each
  // function's doc comment in tasks.ts for why a real deployment needs
  // both running continuously, not just reconciliation at startup.
  startTaskTimeoutSweeper();
  startTaskLivenessRenewer();
  // Same gap as the others found in this round: runDreamingPass()
  // (memory.ts) otherwise never runs outside tests/the CLI demo, so
  // episodic writes and approved memory nominations would just pile up
  // with nothing ever promoting them into curated memory. Every 5
  // minutes is arbitrary but reasonable for a dev-scale deployment —
  // dreaming itself is cheap (no model call, pure scoring) when there's
  // nothing newly eligible to phrase.
  startMemoryDreamingSweeper();

  // Skills (skills.ts) previously had ZERO wiring into the live gateway —
  // SkillRegistry.fromDirectory() existed, was tested, and had a full
  // HTTP surface (GET/POST/DELETE /skills on server.ts) as of this same
  // round of fixes, but nothing ever constructed one here, so the skill
  // catalog was never injected into any turn and the `skill` tool could
  // never find anything to load — same pattern as subagents/memory/
  // dreaming before those got turned on. Defaults to a `skills/`
  // directory next to this process's own cwd (agent-os's own tree, per
  // start.sh); override with AGENT_OS_SKILLS_DIR. Safe on a totally fresh
  // checkout: discoverSkills() treats a missing directory as "zero
  // skills," not an error.
  const skillsDir = process.env.AGENT_OS_SKILLS_DIR ?? path.join(process.cwd(), "skills");
  const skills = await SkillRegistry.fromDirectory(skillsDir);
  console.log(`[gateway] skills catalog ready: ${skills.listMetadata().length} skill(s) from ${skillsDir}`);

  const model = (await createModelFromEnvOrOllama()) ?? createStubModel();
  if (model.id === "stub-model") {
    console.log(
      "[gateway] no ANTHROPIC_TOKEN/ANTHROPIC_API_KEY/OPENAI_API_KEY set and Ollama not reachable — " +
        "running with the deterministic stub model. Set a provider env var for real model calls.",
    );
  } else {
    console.log(`[gateway] using model adapter: ${model.id}`);
  }

  // Layer B: confines EVERY shell command (whichever agent it came from)
  // to this process's own working tree (agent-os, per start.sh's `cd
  // "$AGENT_OS_DIR"`) plus BaseOStest's own checkout — passed in via
  // BASEOS_REPO_DIR since the two repos don't share a useful common
  // ancestor in a Codespace (agent-os lives under $HOME, BaseOStest under
  // /workspaces/...) for a single workspaceRoot to cover both. Applies
  // uniformly as defense in depth even though Layer A (below) is what
  // actually restricts WHO can reach the shell tool at all.
  const sandboxPolicy: SandboxPolicy = {
    filesystemScope: "workspace-and-temp",
    workspaceRoot: process.cwd(),
    additionalRoots: process.env.BASEOS_REPO_DIR ? [process.env.BASEOS_REPO_DIR] : [],
    hardBlocklist: DEFAULT_HARD_BLOCKLIST,
  };
  const worker = createSandboxedWorker(createLocalShellWorker(), sandboxPolicy);

  // Layer A, part 1: shell access is restricted to ENGINEER_AGENT_ID —
  // every other agent's tool.before hits this first (hooks.ts's fireHook
  // runs handlers in registration order and returns on the first block)
  // and is denied outright, before ever reaching a Worker. This is a
  // deliberate product choice, not just a safety one — see the design
  // discussion this came out of: one agent owns harness maintenance, not
  // "whichever agent happens to be open."
  registerHook("tool.before", async (ctx) => {
    const toolName = String(ctx.payload.name ?? "");
    if (!FILESYSTEM_TOOLS.includes(toolName)) return;
    if (ctx.agentId === ENGINEER_AGENT_ID) return;
    return {
      block: true,
      reason: `"${toolName}" is restricted to the "${ENGINEER_AGENT_ID}" agent — ask it directly if you need something inspected or fixed.`,
    };
  });
  // Layer A, part 2: ENGINEER_AGENT_ID's own rules (see buildEngineerPolicy
  // above) — safe reads pre-approved, everything else durably queued for
  // approval in the Workbench's Approvals tab.
  installPermissionPolicy(buildEngineerPolicy());

  // Seeds the authoritative ISΛRK agent roster (agents.ts) if it isn't
  // already registered — idempotent, so restarting the gateway never
  // duplicates identity-registration events. This is what makes GET
  // /agents return real data on a fresh data dir instead of an empty list.
  const roster = await seedDefaultAgents();
  console.log(`[gateway] agent registry ready: ${roster.map((a) => a.id).join(", ")}`);

  // These three are each independently tested and already safety-scoped
  // on their own terms (agent-loop.ts): subagents don't recursively spawn
  // further subagents, a memory nomination is only ever a PENDING
  // proposal until a human explicitly approves it (never writes curated
  // memory directly), and artifact recording only registers metadata
  // about something the agent already produced via another tool — it
  // can't itself create content. All three were simply never turned on
  // for the live gateway; every agent's own persona/capabilities already
  // claims some of these (e.g. "subagent-delegation"), so leaving them
  // off made that claim false in practice.
  const handle = await startGateway(
    { model, worker, skills, skillsDir, enableSubagents: true, enableMemoryNominations: true, enableArtifacts: true, sandboxPolicy },
    port,
  );
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
