#!/usr/bin/env node
// A runnable demo that exercises every primitive in this scaffold end to
// end, using only the deterministic stub model/worker so it needs zero
// API keys and zero external services. This is meant to be read top to
// bottom as a tour of the architecture, not just executed.

import * as readline from "node:readline";
import {
  createStubModel,
  createModelFromEnvOrOllama,
  createLocalShellWorker,
  createSandboxedWorker,
  createStubWorker,
  runTurn,
  newSessionId,
  writeEpisodic,
  runDreamingPass,
  getCuratedMemory,
  listEpisodic,
  listDreamingPasses,
  createTask,
  transitionTask,
  listTasks,
  createFlow,
  updateFlowStep,
  getFlow,
  registerAutomation,
  listAutomations,
  registerHook,
  listStreamIds,
  readStream,
  SkillRegistry,
  serializeSkillFile,
  installPermissionPolicy,
  DEFAULT_HARD_BLOCKLIST,
  type SandboxPolicy,
  fsList,
  fsRead,
  fsWrite,
  registerAgentIdentity,
  runSchedulerTick,
  runHeartbeatTick,
  getSessionHistory,
} from "./core/index.js";

const AGENT_ID = "demo-agent";

function section(title: string): void {
  console.log(`\n${"=".repeat(60)}\n${title}\n${"=".repeat(60)}`);
}

async function demoAgentLoop(): Promise<{ sessionId: string; skills: SkillRegistry }> {
  section("1. Agent Loop — a session is just an event stream");
  const sessionId = newSessionId();
  const model = createStubModel();
  const worker = createLocalShellWorker();
  const skills = await SkillRegistry.fromDirectory("skills");
  console.log(
    `Loaded ${skills.listMetadata().length} skill(s) from ./skills/ — only name+description resident until loaded:`,
  );
  for (const s of skills.listMetadata()) console.log(`  - ${s.name}: ${s.description.slice(0, 70)}...`);

  registerHook("tool.before", async (ctx) => {
    console.log(`  [hook: tool.before] about to run tool`, ctx.payload);
    return {}; // observe only, don't block
  });

  const r1 = await runTurn({
    sessionId,
    agentId: AGENT_ID,
    userMessage: "run shell: echo hello from a worker",
    model,
    worker,
    skills,
  });
  console.log("Turn 1 result:", r1.finalContent);

  const r2 = await runTurn({
    sessionId,
    agentId: AGENT_ID,
    userMessage: "what is the meaning of this scaffold?",
    model,
    worker,
    skills,
  });
  console.log("Turn 2 result:", r2.finalContent);

  console.log(`\nSession stream now has ${(await readStream(`session:${sessionId}`)).length} events on disk.`);
  return { sessionId, skills };
}

async function demoSkills(sessionId: string, skills: SkillRegistry): Promise<void> {
  section("1b. Skills — progressive disclosure (agentskills.io format)");
  const model = createStubModel();
  const worker = createLocalShellWorker();

  const r = await runTurn({
    sessionId,
    agentId: AGENT_ID,
    userMessage: "load skill: commit-message-style",
    model,
    worker,
    skills,
  });
  console.log("Skill-load turn result:", r.finalContent);

  const history = await readStream(`session:${sessionId}`);
  const loadEvent = history.find((e) => e.type === "skill.loaded");
  console.log(
    "\n'skill.loaded' event recorded:",
    loadEvent ? JSON.stringify(loadEvent.payload) : "(none — check for a bug)",
  );

  const toolResult = [...history]
    .reverse()
    .find((e) => e.type === "session.message" && (e.payload as any).role === "tool");
  const bodyPreview = String((toolResult?.payload as any)?.content ?? "").slice(0, 90);
  console.log(`Full SKILL.md body was loaded on demand (layer 2), starts with:\n  "${bodyPreview}..."`);
}


async function demoMemory(sessionId: string): Promise<void> {
  section("2. Memory — fast-path episodic writes (Hermes-style immediacy)");

  await writeEpisodic({
    agentId: AGENT_ID,
    content: "User prefers terse responses, no preamble.",
    kind: "preference",
    sourceSessionId: sessionId,
    wasExplicitCorrection: true,
  });
  console.log("Wrote an explicit correction — will score high immediately.");

  for (let i = 0; i < 3; i++) {
    await writeEpisodic({
      agentId: AGENT_ID,
      content: "User works mostly in TypeScript on Windows via git-bash.",
      kind: "fact",
      sourceSessionId: sessionId,
    });
  }
  console.log("Wrote the same fact 3 times — repetition will raise its score.");

  await writeEpisodic({
    agentId: AGENT_ID,
    content: "One-off remark that will never repeat or get corrected.",
    kind: "fact",
    sourceSessionId: sessionId,
  });
  console.log("Wrote a one-off, low-signal fact — should stay below threshold.");

  const episodic = await listEpisodic(AGENT_ID);
  console.log(`\nEpisodic memory now has ${episodic.length} entries (all written directly, no gate).`);

  section("3. Dreaming — the ONLY path into curated memory, gated by code");
  const pass = await runDreamingPass(AGENT_ID);
  console.log(`Dreaming pass reviewed ${pass.episodicEntriesReviewed} entries:`);
  for (const p of pass.promotions) {
    const entry = episodic.find((e) => e.id === p.episodicEntryId);
    console.log(
      `  score=${p.eligibilityScore.toFixed(1).padStart(6)}  ${p.decision.padEnd(9)}  "${entry?.content.slice(0, 55)}..."`,
    );
  }

  const curated = await getCuratedMemory(AGENT_ID);
  console.log("\nCurated memory (what actually gets injected into future sessions):");
  console.log(curated.content || "  (nothing promoted yet)");

  const passes = await listDreamingPasses(AGENT_ID);
  console.log(`\n${passes.length} dreaming pass(es) recorded in the audit trail (memory:${AGENT_ID}:dreaming).`);
}

async function demoTasksAndFlows(): Promise<void> {
  section("4. Task / Flow / Automation — OpenClaw's four-way split");

  const task = await createTask({
    type: "subagent",
    agentId: AGENT_ID,
    input: { goal: "research something" },
  });
  console.log(`Created task ${task.id} with status "${task.status}"`);

  await transitionTask(task.id, "running");
  await transitionTask(task.id, "succeeded", { output: { result: "done" } });
  const finished = await listTasks({ agentId: AGENT_ID });
  console.log(`Task lifecycle: ${finished.map((t) => t.status).join(" -> ")}`);

  const flow = await createFlow("managed", [
    { id: "step-1", dependsOn: [] },
    { id: "step-2", dependsOn: ["step-1"] },
  ]);
  console.log(`\nCreated flow ${flow.id} with ${flow.steps.length} steps, revision ${flow.revision}`);

  const upd1 = await updateFlowStep(flow.id, "step-1", "succeeded", flow.revision);
  console.log("Step 1 update:", upd1);

  const midFlow = await getFlow(flow.id);
  const upd2 = await updateFlowStep(flow.id, "step-2", "succeeded", midFlow!.revision);
  console.log("Step 2 update:", upd2);

  const finalFlow = await getFlow(flow.id);
  console.log(`Flow status: ${finalFlow?.status}, revision: ${finalFlow?.revision}`);

  // Demonstrate the optimistic-concurrency conflict path with a stale revision.
  const staleAttempt = await updateFlowStep(flow.id, "step-1", "failed", 0);
  console.log("Stale write attempt (expected conflict):", staleAttempt);

  await registerAutomation({
    trigger: { kind: "cron", expr: "0 9 * * *" },
    agentId: AGENT_ID,
    promptTemplate: "Execute per standing orders.",
    enabled: true,
  });
  const automations = await listAutomations();
  console.log(`\n${automations.length} automation(s) registered.`);
}

async function demoScheduler(): Promise<void> {
  section("5. Scheduler — Automations actually fire, not just registered");
  console.log(
    "Implements docs/architecture.md §2's 'Automations' scheduling mode (precise\n" +
      "timing, isolated context). The OTHER mode, 'Heartbeat' (imprecise timing,\n" +
      "full main-session context), is demoed separately right after this section —\n" +
      "see src/core/heartbeat.ts for why they're genuinely different mechanisms.\n",
  );

  // A cron expression matching THIS exact minute, so the demo can prove a
  // real fire without waiting for a wall-clock cron boundary. registerAutomation()
  // takes the exact same code path a "daily at 9am" automation would.
  const now = new Date();
  const thisMinuteCron = `${now.getMinutes()} ${now.getHours()} * * *`;
  const automation = await registerAutomation({
    trigger: { kind: "cron", expr: thisMinuteCron },
    agentId: AGENT_ID,
    promptTemplate: "Scheduled check-in: summarize what happened.",
    enabled: true,
  });
  console.log(`Registered a cron automation matching THIS minute ("${thisMinuteCron}"): ${automation.id}`);

  const deps = { model: createStubModel(), worker: createStubWorker() };

  const fired1 = await runSchedulerTick(deps, now);
  console.log(`\nFirst tick at ${now.toISOString()}: fired ${fired1.length} automation(s)`);
  for (const f of fired1) {
    console.log(`  automation ${f.automationId} -> task ${f.taskId}, session ${f.sessionId}`);
    console.log(`  result: "${f.finalContent}"`);
  }

  const fired2 = await runSchedulerTick(deps, now);
  console.log(`\nSecond tick, SAME minute: fired ${fired2.length} automation(s) (expected 0 — dedup by minute)`);

  const oneMinuteLater = new Date(now.getTime() + 60_000);
  const disabledCheck = await runSchedulerTick(deps, oneMinuteLater);
  console.log(
    `Tick one minute later: fired ${disabledCheck.length} automation(s) ` +
      "(expected 0 — this automation's cron expr no longer matches)",
  );

  const relatedTasks = await listTasks({ agentId: AGENT_ID, status: "succeeded" });
  const cronTasks = relatedTasks.filter((t) => t.type === "cron");
  console.log(`\n${cronTasks.length} 'cron'-type task(s) now exist in the task ledger from this firing.`);
}

async function demoHeartbeat(): Promise<void> {
  section("5b. Heartbeat — the OTHER scheduling mode: imprecise timing, full context");
  console.log(
    "Genuinely different from Automations above, not a renamed copy — see\n" +
      "src/core/heartbeat.ts for the precise distinction: imprecise timing\n" +
      "(interval +/- jitter, never exact) and every tick is a turn in the SAME\n" +
      "long-lived session (full context), with NO Task ever created.\n",
  );

  const sessionId = newSessionId();
  const deps = { model: createStubModel(), worker: createStubWorker() };
  const tasksBefore = (await listTasks({ agentId: AGENT_ID })).length;

  const tick1 = await runHeartbeatTick({
    agentId: AGENT_ID,
    sessionId,
    promptTemplate: "Heartbeat check-in #1: anything new?",
    intervalMs: 1800_000, // 30 min, matching the architecture doc's example
    ...deps,
  });
  console.log(`Tick 1 (session ${sessionId}): "${tick1.finalContent}"`);

  const tick2 = await runHeartbeatTick({
    agentId: AGENT_ID,
    sessionId,
    promptTemplate: "Heartbeat check-in #2: anything new?",
    intervalMs: 1800_000,
    ...deps,
  });
  console.log(`Tick 2 (same session): "${tick2.finalContent}"`);

  const history = await getSessionHistory(sessionId);
  const userTurns = history.filter((m) => m.role === "user").map((m) => m.content);
  console.log(
    `\nBoth tick prompts present in this ONE session's accumulated history? ` +
      `${userTurns.includes("Heartbeat check-in #1: anything new?") && userTurns.includes("Heartbeat check-in #2: anything new?")}`,
  );
  console.log("(Compare to Automations above: each firing got its OWN brand-new session, never shared context.)");

  const tasksAfter = (await listTasks({ agentId: AGENT_ID })).length;
  console.log(`\nTask ledger count before heartbeat ticks: ${tasksBefore}, after: ${tasksAfter} (expected equal — no Task created).`);
}

async function demoEventLogIsTruth(): Promise<void> {
  section("8. Everything above is just an event log — proof");
  const streams = await listStreamIds();
  console.log(`${streams.length} streams on disk under data/streams/:`);
  for (const s of streams) {
    const events = await readStream(s);
    console.log(`  ${s.padEnd(35)} ${events.length} events`);
  }
  console.log(
    "\nNo separate database, no ORM — every projection above (session history,\n" +
      "task status, flow state, curated memory) was reconstructed by replaying\n" +
      "these exact files. Delete a projection cache and nothing is lost.",
  );
}

async function demoPermissions(): Promise<void> {
  section("6. Permissions / Sandbox — two separate layers, proven separately");

  // --- Layer A: PermissionPolicy — pre-execution, model-input-based ---
  console.log("Layer A (PermissionPolicy): a policy that denies 'forbidden-tool' but allows 'shell'.\n");
  const policyAgentId = "permissions-demo-agent";
  installPermissionPolicy({
    agentId: policyAgentId,
    rules: [
      { tool: "forbidden-tool", decision: "deny" },
      { tool: "shell", decision: "allow" },
      { tool: "skill", decision: "allow" },
    ],
  });

  const sessionA = newSessionId();
  const rA = await runTurn({
    sessionId: sessionA,
    agentId: policyAgentId,
    userMessage: "use forbidden-tool",
    model: createStubModel(),
    worker: createStubWorker(),
  });
  console.log(`Attempted a denied tool -> result: "${rA.finalContent}"`);
  console.log("(The model's request never reached the Worker at all — blocked at the hook layer.)");

  // --- Layer B: SandboxPolicy — enforced by the Worker itself ---
  console.log(
    "\nLayer B (SandboxPolicy): a hard blocklist that holds regardless of what the\n" +
      "model claims — even if a permission policy would have allowed it.",
  );
  const sandboxPolicy: SandboxPolicy = {
    filesystemScope: "workspace-only",
    workspaceRoot: process.cwd(),
    hardBlocklist: DEFAULT_HARD_BLOCKLIST,
  };
  const dangerousWorker = createSandboxedWorker(createLocalShellWorker(), sandboxPolicy);

  const dangerousResult = await dangerousWorker.run("rm -rf /");
  console.log(`Attempted 'rm -rf /' directly against the sandboxed worker:`);
  console.log(`  ok=${dangerousResult.ok}  error="${dangerousResult.error}"`);

  const safeResult = await dangerousWorker.run("echo this command is fine");
  console.log(`\nA harmless command through the same sandboxed worker still works:`);
  console.log(`  ok=${safeResult.ok}  output="${safeResult.output.trim()}"`);

  console.log(
    "\nNote the distinction: Layer A stopped a NAMED tool the model asked for.\n" +
      "Layer B stopped a DANGEROUS COMMAND regardless of which tool or policy\n" +
      "was involved — this is what 'holds regardless of what the model chose\n" +
      "to run' means in practice (see docs/architecture.md §6).",
  );
}

async function demoAgentFilesystem(sessionId: string): Promise<void> {
  section("7. Agent filesystem — the same primitives, addressed as paths");
  console.log(
    "Projection over everything above, per docs/architecture.md §7 — not a\n" +
      "new storage layer, just a filesystem-shaped VIEW of the same event\n" +
      "streams and skill files. Read-only for most paths; write support is\n" +
      "limited to skills (see below).\n",
  );

  const root = await fsList("/agent");
  console.log(`ls /agent -> ${root.map((e) => e.name + (e.kind === "dir" ? "/" : "")).join("  ")}`);

  await registerAgentIdentity({ id: AGENT_ID, name: "Demo Agent", persona: "A minimal demo agent for agent-os." });
  const identityFiles = await fsList("/agent/identity");
  console.log(`ls /agent/identity -> ${identityFiles.map((e) => e.name).join(", ")}`);
  const identityJson = await fsRead(`/agent/identity/${AGENT_ID}.json`);
  console.log(`cat /agent/identity/${AGENT_ID}.json -> ${identityJson.replace(/\s+/g, " ").slice(0, 100)}...`);

  const skillDirs = await fsList("/agent/skills");
  console.log(`ls /agent/skills -> ${skillDirs.map((e) => e.name).join(", ")}`);

  const skillBody = await fsRead("/agent/skills/commit-message-style/SKILL.md");
  console.log(`cat /agent/skills/commit-message-style/SKILL.md -> starts with: "${skillBody.slice(0, 60)}..."`);

  const curated = await fsRead(`/agent/memory/${AGENT_ID}/curated/MEMORY.md`);
  console.log(`\ncat /agent/memory/${AGENT_ID}/curated/MEMORY.md ->\n${curated.split("\n").slice(0, 4).join("\n")}`);

  const episodicFiles = await fsList(`/agent/memory/${AGENT_ID}/episodic`);
  console.log(`\nls /agent/memory/${AGENT_ID}/episodic -> ${episodicFiles.length} entries`);
  if (episodicFiles[0]) {
    const entry = await fsRead(`/agent/memory/${AGENT_ID}/episodic/${episodicFiles[0].name}`);
    console.log(`cat .../episodic/${episodicFiles[0].name} -> ${entry.slice(0, 80)}...`);
  }

  const sessionFiles = await fsList("/agent/sessions");
  console.log(`\nls /agent/sessions -> ${sessionFiles.length} session stream(s) on disk`);
  const thisSessionFile = `session_${sessionId}.jsonl`;
  const hasThisSession = sessionFiles.some((f) => f.name === thisSessionFile);
  console.log(`  contains this run's session (${thisSessionFile})? ${hasThisSession}`);

  const taskDirs = await fsList("/agent/tasks");
  console.log(`\nls /agent/tasks -> ${taskDirs.length} task(s)`);
  if (taskDirs[0]) {
    const state = await fsRead(`/agent/tasks/${taskDirs[0].name}/state.json`);
    console.log(`cat /agent/tasks/${taskDirs[0].name}/state.json -> ${state.replace(/\s+/g, " ").slice(0, 100)}...`);
  }

  try {
    await fsRead("/agent/skills/does-not-exist/SKILL.md");
  } catch (err) {
    console.log(`\nReading a nonexistent path correctly throws: ${(err as Error).message}`);
  }

  console.log("\nWrite support: exactly one path kind — skills — since a skill is just a file.");
  const demoSkillMd = serializeSkillFile({
    name: "demo-fs-written-skill",
    description: "Written live by demoAgentFilesystem() via fsWrite() — removed at the end of this demo.",
    body: "# Demo FS-Written Skill\n\nThis skill was created through the /agent/skills/... namespace, not by hand.",
  });
  await fsWrite("/agent/skills/demo-fs-written-skill/SKILL.md", demoSkillMd);
  console.log("fsWrite(\"/agent/skills/demo-fs-written-skill/SKILL.md\", ...) succeeded.");
  const writtenBody = await fsRead("/agent/skills/demo-fs-written-skill/SKILL.md");
  console.log(`Read it back via fsRead() -> starts with: "${writtenBody.slice(0, 55)}..."`);

  try {
    await fsWrite(`/agent/memory/${AGENT_ID}/curated/MEMORY.md`, "malicious override attempt");
  } catch (err) {
    console.log(`\nWriting to /agent/memory/... correctly throws: ${(err as Error).message}`);
  }

  // Clean up the demo-written skill so repeated `npm run demo` runs stay
  // idempotent and this never pollutes the real ./skills/ catalog that
  // `npm run chat` loads.
  const { rm } = await import("node:fs/promises");
  await rm("skills/demo-fs-written-skill", { recursive: true, force: true });
  console.log("\n(Cleaned up the demo-written skill so it doesn't pollute the real skill catalog.)");
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "demo";

  if (cmd === "demo") {
    const { sessionId, skills } = await demoAgentLoop();
    await demoSkills(sessionId, skills);
    await demoMemory(sessionId);
    await demoTasksAndFlows();
    await demoScheduler();
    await demoHeartbeat();
    await demoPermissions();
    await demoAgentFilesystem(sessionId);
    await demoEventLogIsTruth();
    console.log("\nDone. Inspect ./data/streams/*.jsonl directly — it's all human-readable.\n");
    return;
  }

  if (cmd === "chat") {
    await runChat();
    return;
  }

  console.log(`Unknown command: ${cmd}. Try: npm run demo, npm run chat`);
  process.exitCode = 1;
}

async function runChat(): Promise<void> {
  const model = (await createModelFromEnvOrOllama()) ?? createStubModel();
  console.log(`Using model: ${model.id}`);
  if (model.id === "stub-model") {
    console.log(
      "(No ANTHROPIC_TOKEN/ANTHROPIC_API_KEY/OPENAI_API_KEY set and Ollama not reachable —\n" +
        " falling back to the deterministic stub model. Try phrases like:\n" +
        "   run shell: echo hello\n" +
        "   load skill: commit-message-style\n" +
        " Set an API key or run `ollama serve` for a real model.)",
    );
  }

  const skills = await SkillRegistry.fromDirectory("skills");
  const rawWorker = createLocalShellWorker();
  const sandboxPolicy: SandboxPolicy = {
    filesystemScope: "workspace-only",
    workspaceRoot: process.cwd(),
    hardBlocklist: DEFAULT_HARD_BLOCKLIST,
  };
  const worker = createSandboxedWorker(rawWorker, sandboxPolicy);

  const sessionId = newSessionId();
  console.log(`Session: ${sessionId}`);
  console.log(`Skills loaded: ${skills.listMetadata().map((s) => s.name).join(", ") || "(none)"}`);
  console.log("Type a message and press Enter. Type 'exit' or Ctrl+C to quit.\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });
  rl.prompt();

  rl.on("line", async (line) => {
    const text = line.trim();
    if (text === "exit" || text === "quit") {
      rl.close();
      return;
    }
    if (text.length === 0) {
      rl.prompt();
      return;
    }
    try {
      const result = await runTurn({
        sessionId,
        agentId: AGENT_ID,
        userMessage: text,
        model,
        worker,
        skills,
      });
      console.log(`agent> ${result.finalContent}`);
      if (result.toolCalled) console.log(`  (used tool: ${result.toolCalled})`);
    } catch (err) {
      console.error("error:", err instanceof Error ? err.message : err);
    }
    rl.prompt();
  });

  rl.on("close", () => {
    console.log(`\nSession ended. Inspect ./data/streams/session_${sessionId}.jsonl for the full transcript.`);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
