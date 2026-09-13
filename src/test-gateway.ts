// Integration test for the Agent-OS Gateway (gateway/server.ts) — proves
// the full external-client path the architecture audit called out as
// missing: a real HTTP client (not an in-process function call) can
// create a session, send a message, see it run, cancel a session, list
// tasks/flows/workers/tools, and go through the request/resolve approval
// flow end to end, purely via fetch() against a real listening server.
// Also proves GET /events (SSE) actually delivers live events published
// during a real runTurn() call.
// Run with: node dist/test-gateway.js

import "./test-helpers/isolate.js";
import path from "node:path";
import { startGateway } from "./gateway/server.js";
import {
  createStubModel,
  createStubWorker,
  installPermissionPolicy,
  createArtifact,
  writeEpisodic,
  nominateAgentMemory,
  runDreamingPass,
  SkillRegistry,
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
  const skillsDir = path.join(process.env.AGENT_OS_DATA_DIR!, "skills");
  const gateway = await startGateway({
    model: createStubModel(),
    worker: createStubWorker(),
    skills: await SkillRegistry.fromDirectory(skillsDir),
    skillsDir,
  });
  const base = `http://127.0.0.1:${gateway.port}`;

  try {
    console.log("\n-- 1. Health check --");
    const health = await fetch(`${base}/health`);
    assert(health.status === 200, "GET /health returns 200");
    assert((await health.json() as any).ok === true, "GET /health body is {ok:true}");

    console.log("\n-- 2. Session lifecycle over real HTTP --");
    const createRes = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "gateway-test-agent", title: "integration test" }),
    });
    assert(createRes.status === 201, "POST /sessions returns 201");
    const session = (await createRes.json()) as any;
    assert(session.status === "active", "the created session starts 'active'");
    assert(session.title === "integration test", "title round-trips through the API");

    const getRes = await fetch(`${base}/sessions/${session.id}`);
    assert(getRes.status === 200, "GET /sessions/:id returns 200 for a real session");
    const fetched = (await getRes.json()) as any;
    assert(fetched.id === session.id, "GET /sessions/:id returns the same session");

    const missingRes = await fetch(`${base}/sessions/no-such-session`);
    assert(missingRes.status === 404, "GET /sessions/:id returns 404 for an unknown id");

    const listRes = await fetch(`${base}/sessions?agentId=gateway-test-agent`);
    const listed = (await listRes.json()) as any;
    assert(
      listed.sessions.some((s: any) => s.id === session.id),
      "GET /sessions?agentId= includes the created session",
    );

    console.log("\n-- 3. Sending a turn over real HTTP --");
    const turnRes = await fetch(`${base}/sessions/${session.id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userMessage: "hello from an HTTP client" }),
    });
    assert(turnRes.status === 200, "POST /sessions/:id/turns returns 200");
    const turnResult = (await turnRes.json()) as any;
    assert(
      /acknowledged/.test(turnResult.finalContent),
      `the turn actually ran through the real agent loop (got: "${turnResult.finalContent}")`,
    );

    const historyRes = await fetch(`${base}/sessions/${session.id}/history`);
    const history = (await historyRes.json()) as any;
    assert(
      history.history.some((m: any) => m.role === "user" && m.content === "hello from an HTTP client"),
      "GET /sessions/:id/history reflects the message that was actually sent",
    );

    const usageRes = await fetch(`${base}/sessions/${session.id}/usage`);
    assert(usageRes.status === 200, "GET /sessions/:id/usage returns 200");
    const usage = (await usageRes.json()) as any;
    assert(usage.turnsWithUsage === 0, "the stub model never reports usage, so turnsWithUsage is honestly 0, not a fabricated figure");

    const missingUsageRes = await fetch(`${base}/sessions/no-such-session/usage`);
    assert(missingUsageRes.status === 404, "GET /sessions/:id/usage returns 404 for an unknown session");

    const planModeSessionRes = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "gateway-plan-mode-agent" }),
    });
    const planModeSession = (await planModeSessionRes.json()) as any;
    const planModeTurnRes = await fetch(`${base}/sessions/${planModeSession.id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userMessage: "run shell: echo hi", planMode: true }),
    });
    const planModeResult = (await planModeTurnRes.json()) as any;
    assert(
      planModeResult.finalContent.includes("plan mode"),
      `POST /sessions/:id/turns with planMode:true blocks a mutating tool call (got: "${planModeResult.finalContent}")`,
    );

    console.log("\n-- 4. Cancelling a session over real HTTP --");
    const cancelRes = await fetch(`${base}/sessions/${session.id}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "integration test cancellation" }),
    });
    assert(cancelRes.status === 200, "POST /sessions/:id/cancel returns 200");
    assert(((await cancelRes.json()) as any).status === "cancelled", "the session's status is 'cancelled' in the response");

    const cancelAgainRes = await fetch(`${base}/sessions/${session.id}/cancel`, { method: "POST" });
    assert(cancelAgainRes.status === 409, "cancelling an already-cancelled session returns 409, not 500");

    console.log("\n-- 5. Tasks/flows/workers/tools listing endpoints --");
    const tasksRes = await fetch(`${base}/tasks`);
    assert(tasksRes.status === 200, "GET /tasks returns 200 (even with zero tasks)");
    const flowsRes = await fetch(`${base}/flows`);
    assert(flowsRes.status === 200, "GET /flows returns 200");
    const workersRes = await fetch(`${base}/workers`);
    assert(workersRes.status === 200, "GET /workers returns 200");
    const toolsRes = await fetch(`${base}/tools`);
    const tools = (await toolsRes.json()) as any;
    assert(
      tools.tools.some((t: any) => t.name === "shell"),
      "GET /tools lists the built-in 'shell' tool definition",
    );

    console.log("\n-- 6. Approval request/resolve flow over real HTTP --");
    const approvalAgentId = "gateway-approval-agent";
    installPermissionPolicy({ agentId: approvalAgentId, rules: [{ tool: "shell", decision: "ask" }] });
    const approvalSessionRes = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: approvalAgentId }),
    });
    const approvalSession = (await approvalSessionRes.json()) as any;
    await fetch(`${base}/sessions/${approvalSession.id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userMessage: "run shell: echo hi" }),
    });

    const pendingRes = await fetch(`${base}/approvals?status=pending&sessionId=${approvalSession.id}`);
    const pending = (await pendingRes.json()) as any;
    assert(pending.approvals.length === 1, `exactly one pending approval was created (got ${pending.approvals.length})`);
    const approvalId = pending.approvals[0].id;

    const approveRes = await fetch(`${base}/approvals/${approvalId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolvedBy: "integration-test-human", note: "looks fine" }),
    });
    assert(approveRes.status === 200, "POST /approvals/:id/approve returns 200");
    const approved = (await approveRes.json()) as any;
    assert(approved.status === "approved", "the approval's status is 'approved' in the response");

    const reApproveRes = await fetch(`${base}/approvals/${approvalId}/approve`, { method: "POST" });
    assert(reApproveRes.status === 409, "re-approving an already-resolved request returns 409, not 500");

    console.log("\n-- 7. Live events over SSE actually stream real activity --");
    const sseSessionRes = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "gateway-sse-agent" }),
    });
    const sseSession = (await sseSessionRes.json()) as any;

    const sseController = new AbortController();
    const sseResponse = await fetch(`${base}/events?types=agent.turn.start,agent.turn.end`, {
      signal: sseController.signal,
    });
    assert(sseResponse.status === 200, "GET /events returns 200");
    assert(
      sseResponse.headers.get("content-type")?.includes("text/event-stream") ?? false,
      "GET /events responds with text/event-stream",
    );

    const reader = sseResponse.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const collectEvents = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        received += decoder.decode(value, { stream: true });
        if (received.includes("agent.turn.end")) break;
      }
    })();

    // Give the SSE connection a moment to actually register its
    // subscription before the event that should trigger it fires.
    await new Promise((r) => setTimeout(r, 50));
    await fetch(`${base}/sessions/${sseSession.id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userMessage: "trigger some live events" }),
    });

    await Promise.race([collectEvents, new Promise((r) => setTimeout(r, 3000))]);
    sseController.abort();

    assert(received.includes("event: agent.turn.start"), "the SSE stream delivered a real 'agent.turn.start' event");
    assert(received.includes("event: agent.turn.end"), "the SSE stream delivered a real 'agent.turn.end' event");
    assert(received.includes(sseSession.id), "the delivered event payload references the actual session id");

    console.log("\n-- 8. Agent registry endpoints over real HTTP --");
    const createAgentRes = await fetch(`${base}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "gateway-test-registry-agent",
        name: "Registry Test Agent",
        persona: "exists only for this integration test",
        role: "Tester · Integration",
        capabilities: ["testing"],
      }),
    });
    assert(createAgentRes.status === 201, "POST /agents returns 201");
    const createdAgent = (await createAgentRes.json()) as any;
    assert(createdAgent.role === "Tester · Integration", "the created agent's role round-trips through the API");

    const dupeAgentRes = await fetch(`${base}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "gateway-test-registry-agent", name: "dupe", persona: "dupe" }),
    });
    assert(dupeAgentRes.status === 409, "POST /agents for an already-existing id returns 409, not a silent duplicate");

    const getAgentRes = await fetch(`${base}/agents/gateway-test-registry-agent`);
    assert(getAgentRes.status === 200, "GET /agents/:id returns 200 for a real agent");
    const fetchedAgent = (await getAgentRes.json()) as any;
    assert(fetchedAgent.status === "idle", "a freshly created agent's derived status is 'idle'");

    const missingAgentRes = await fetch(`${base}/agents/no-such-agent`);
    assert(missingAgentRes.status === 404, "GET /agents/:id returns 404 for an unknown id");

    const updateAgentRes = await fetch(`${base}/agents/gateway-test-registry-agent`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "Tester · Updated" }),
    });
    assert(updateAgentRes.status === 200, "PUT /agents/:id returns 200");
    assert(((await updateAgentRes.json()) as any).role === "Tester · Updated", "the update is reflected in the response");

    const listAgentsRes = await fetch(`${base}/agents`);
    const listedAgents = (await listAgentsRes.json()) as any;
    assert(
      listedAgents.agents.some((a: any) => a.id === "gateway-test-registry-agent"),
      "GET /agents includes the created agent",
    );

    console.log("\n-- 9. Artifact endpoints over real HTTP --");
    const artifact = await createArtifact({ type: "report", location: "/workspace/report.md", producer: "claude" });
    const getArtifactRes = await fetch(`${base}/artifacts/${artifact.id}`);
    assert(getArtifactRes.status === 200, "GET /artifacts/:id returns 200 for a real artifact");
    const fetchedArtifact = (await getArtifactRes.json()) as any;
    assert(fetchedArtifact.location === "/workspace/report.md", "the fetched artifact's location matches what was created");

    const missingArtifactRes = await fetch(`${base}/artifacts/no-such-artifact`);
    assert(missingArtifactRes.status === 404, "GET /artifacts/:id returns 404 for an unknown id");

    const listArtifactsRes = await fetch(`${base}/artifacts?type=report`);
    const listedArtifacts = (await listArtifactsRes.json()) as any;
    assert(
      listedArtifacts.artifacts.some((a: any) => a.id === artifact.id),
      "GET /artifacts?type= includes the created artifact",
    );

    console.log("\n-- 10. Flow endpoints over real HTTP — real orchestration, not just bookkeeping --");
    const createFlowRes = await fetch(`${base}/flows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        steps: [
          { id: "a", agentId: "claude", goal: "step a" },
          { id: "b", agentId: "claude", goal: "step b" },
          { id: "c", agentId: "claude", goal: "step c", dependsOn: ["a", "b"] },
        ],
      }),
    });
    assert(createFlowRes.status === 201, "POST /flows returns 201 immediately (doesn't block on the whole DAG)");
    const createdFlow = (await createFlowRes.json()) as any;

    let finishedFlow: any = createdFlow;
    for (let i = 0; i < 40 && finishedFlow.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      finishedFlow = await (await fetch(`${base}/flows/${createdFlow.id}`)).json();
    }
    assert(finishedFlow.status === "succeeded", `the Flow, driven in the background, reaches 'succeeded' (got "${finishedFlow.status}")`);
    assert(
      finishedFlow.steps.every((s: any) => s.status === "succeeded"),
      "every step in the fetched Flow shows 'succeeded'",
    );

    const cancelFlowSetupRes = await fetch(`${base}/flows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ steps: [{ id: "only", agentId: "claude", goal: "never should run" }] }),
    });
    const flowToCancel = (await cancelFlowSetupRes.json()) as any;
    const cancelFlowRes = await fetch(`${base}/flows/${flowToCancel.id}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "integration test" }),
    });
    assert(cancelFlowRes.status === 200, "POST /flows/:id/cancel returns 200");
    assert(((await cancelFlowRes.json()) as any).status === "cancelled", "the cancelled flow's status is 'cancelled' in the response");

    const cancelAgainFlowRes = await fetch(`${base}/flows/${flowToCancel.id}/cancel`, { method: "POST" });
    assert(cancelAgainFlowRes.status === 409, "cancelling an already-cancelled flow returns 409, not 500");

    const badFlowRes = await fetch(`${base}/flows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ steps: "not an array" }),
    });
    assert(badFlowRes.status === 400, "POST /flows with malformed steps returns 400");

    console.log("\n-- 11. Agent memory endpoints over real HTTP --");
    const memAgentId = "memory-test-agent";
    // An explicit correction crosses the promotion threshold on its own
    // (see memory.ts's scoreEligibility) — real fixture data, not a mock.
    await writeEpisodic({ agentId: memAgentId, content: "Prefers terse replies", kind: "preference", sourceSessionId: "test", wasExplicitCorrection: true });
    await runDreamingPass(memAgentId);

    const memRes = await fetch(`${base}/agents/${memAgentId}/memory`);
    assert(memRes.status === 200, "GET /agents/:id/memory returns 200");
    const memBody = (await memRes.json()) as any;
    assert(memBody.curated.userProfile.includes("terse"), "curated memory reflects the promoted preference");
    assert(memBody.episodicCount === 1, "episodicCount reflects the one fixture entry (got " + memBody.episodicCount + ")");
    assert(!!memBody.lastDreamingPass, "lastDreamingPass is present after runDreamingPass() ran");

    const episodicRes = await fetch(`${base}/agents/${memAgentId}/memory/episodic`);
    assert(episodicRes.status === 200, "GET /agents/:id/memory/episodic returns 200");
    assert(((await episodicRes.json()) as any).entries.length === 1, "episodic listing includes the fixture entry");

    const passesRes = await fetch(`${base}/agents/${memAgentId}/memory/dreaming-passes`);
    assert(passesRes.status === 200, "GET /agents/:id/memory/dreaming-passes returns 200");
    assert(((await passesRes.json()) as any).passes.length === 1, "dreaming-passes listing includes the one pass that ran");

    const nomination = await nominateAgentMemory({ agentId: memAgentId, content: "Build with `npm run dev`", kind: "fact", sourceSessionId: "test" });
    const nomListRes = await fetch(`${base}/agents/${memAgentId}/memory/nominations?status=pending`);
    assert(nomListRes.status === 200, "GET /agents/:id/memory/nominations returns 200");
    assert(((await nomListRes.json()) as any).nominations.some((n: any) => n.id === nomination.id), "pending nomination is listed");

    const memApproveRes = await fetch(`${base}/agents/${memAgentId}/memory/nominations/${nomination.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewNote: "looks right" }),
    });
    assert(memApproveRes.status === 200, "POST .../nominations/:id/approve returns 200");
    assert(!!((await memApproveRes.json()) as any).entry, "approving returns the resulting episodic entry");

    const memApproveAgainRes = await fetch(`${base}/agents/${memAgentId}/memory/nominations/${nomination.id}/approve`, { method: "POST" });
    assert(memApproveAgainRes.status === 409, "approving an already-reviewed nomination returns 409, not 500");

    const nomination2 = await nominateAgentMemory({ agentId: memAgentId, content: "Uses dark mode", kind: "preference", sourceSessionId: "test" });
    const memRejectRes = await fetch(`${base}/agents/${memAgentId}/memory/nominations/${nomination2.id}/reject`, { method: "POST" });
    assert(memRejectRes.status === 200, "POST .../nominations/:id/reject returns 200");

    console.log("\n-- 12. Skill endpoints over real HTTP --");
    const emptySkillsRes = await fetch(`${base}/skills`);
    assert(emptySkillsRes.status === 200, "GET /skills returns 200 before any skill exists");
    assert(((await emptySkillsRes.json()) as any).skills.length === 0, "the catalog starts empty");

    const createSkillRes = await fetch(`${base}/skills`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "test-skill", description: "A skill created over HTTP for integration testing.", body: "Do the thing." }),
    });
    assert(createSkillRes.status === 201, "POST /skills returns 201");
    const createdSkill = (await createSkillRes.json()) as any;
    assert(createdSkill.name === "test-skill", "the created skill's name round-trips through the API");

    const listAfterCreateRes = await fetch(`${base}/skills`);
    const listAfterCreate = (await listAfterCreateRes.json()) as any;
    assert(
      listAfterCreate.skills.some((s: any) => s.name === "test-skill"),
      "the new skill shows up in the catalog immediately — no gateway restart needed",
    );

    const getSkillRes = await fetch(`${base}/skills/test-skill`);
    assert(getSkillRes.status === 200, "GET /skills/:name returns 200 for a real skill");
    assert(((await getSkillRes.json()) as any).body === "Do the thing.", "GET /skills/:name includes the full body, not just metadata");

    const getMissingSkillRes = await fetch(`${base}/skills/no-such-skill`);
    assert(getMissingSkillRes.status === 404, "GET /skills/:name returns 404 for an unknown skill");

    const badSkillRes = await fetch(`${base}/skills`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Not A Valid Name!", description: "x", body: "y" }),
    });
    assert(badSkillRes.status === 400, "POST /skills with an invalid name returns 400, not 500");

    const deleteSkillRes = await fetch(`${base}/skills/test-skill`, { method: "DELETE" });
    assert(deleteSkillRes.status === 200, "DELETE /skills/:name returns 200");
    const listAfterDeleteRes = await fetch(`${base}/skills`);
    const listAfterDelete = (await listAfterDeleteRes.json()) as any;
    assert(!listAfterDelete.skills.some((s: any) => s.name === "test-skill"), "the deleted skill no longer shows up in the catalog");

    console.log("\n-- 13. Unknown routes return 404, not a crash --");
    const notFoundRes = await fetch(`${base}/no-such-route`);
    assert(notFoundRes.status === 404, "an unknown route returns 404");
  } finally {
    await gateway.stop();
  }

  if (process.exitCode === 1) {
    console.error("\nSome gateway tests FAILED.");
  } else {
    console.log("\nAll gateway tests passed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
