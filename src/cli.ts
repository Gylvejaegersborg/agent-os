#!/usr/bin/env node
// A runnable demo that exercises every primitive in this scaffold end to
// end, using only the deterministic stub model/worker so it needs zero
// API keys and zero external services. This is meant to be read top to
// bottom as a tour of the architecture, not just executed.

import {
  createStubModel,
  createLocalShellWorker,
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

async function demoEventLogIsTruth(): Promise<void> {
  section("5. Everything above is just an event log — proof");
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

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "demo";

  if (cmd === "demo") {
    const { sessionId, skills } = await demoAgentLoop();
    await demoSkills(sessionId, skills);
    await demoMemory(sessionId);
    await demoTasksAndFlows();
    await demoEventLogIsTruth();
    console.log("\nDone. Inspect ./data/streams/*.jsonl directly — it's all human-readable.\n");
    return;
  }

  console.log(`Unknown command: ${cmd}. Try: npm run demo`);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
