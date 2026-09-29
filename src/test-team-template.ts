// Tests for team templates (core/team-template.ts).
// Proves:
//   1. Export writes TEAM.md (reporting tree), one file per agent (model,
//      budget, persona) and the skills; secret-looking strings are redacted.
//   2. A bundle round-trips; importing the export unchanged changes nothing.
//   3. An edited template creates new agents (with manager, budget, model),
//      updates existing ones as config revisions, adds skills.
//   4. A template with any problem (unknown manager, a loop, a bad budget)
//      applies nothing.
//   5. GET /team/export, POST /team/import (dry run and apply).
// Run with: node dist/test-team-template.js

import "./test-helpers/isolate.js";
process.env.CLAUDE_CLI_PATH = "/nonexistent/claude";

import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SkillRegistry,
  applyTeamImport,
  bundleTeam,
  createStubModel,
  createStubWorker,
  exportTeam,
  getAgentControlState,
  getAgentDefaultModel,
  getAgentIdentity,
  listAgentRevisions,
  planTeamImport,
  seedDefaultAgents,
  setAgentBudget,
  unbundleTeam,
  updateAgent,
  writeSkill,
} from "./core/index.js";
import { startGateway } from "./gateway/server.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

const LYRA = `---
id: lyra
name: Lyra
role: Sync licensing · Outreach
reportsTo: hemera
model: claude-cli:haiku
budget: 30000/week
---

Finds sync placements for ISΛRK's catalog and drafts pitches for the operator to send. Never sends anything herself.
`;

async function main(): Promise<void> {
  await seedDefaultAgents();
  const skillsDir = await mkdtemp(path.join(os.tmpdir(), "skills-"));
  await writeSkill(skillsDir, { name: "caption-style", description: "How ISΛRK captions read.", body: "Lowercase. Short. No hashtags." });
  const skills = await SkillRegistry.fromDirectory(skillsDir);
  await updateAgent("nyx", { defaultModel: "claude-cli:haiku", persona: "You are Nyx. Our old key was sk-ant-api03-abcdefghijklmnopqrstuvwx — never share it." });
  await setAgentBudget("hemera", { period: "week", limitTokens: 50000 });

  const files = await exportTeam({ skills });
  assert(/- You \(the operator\)\n(  - .*\n)*  - Hemera \(hemera\)[^\n]*\n    - Nyx \(nyx\)/.test(files["TEAM.md"]!), "TEAM.md shows the reporting tree");
  assert(/^model: claude-cli:haiku$/m.test(files["agents/nyx.md"]!) && /^budget: 50000\/week$/m.test(files["agents/hemera.md"]!), "agent files carry model and budget");
  assert(!files["agents/nyx.md"]!.includes("sk-ant-") && files["agents/nyx.md"]!.includes("[redacted]") && /replaced with \[redacted\] in: agents\/nyx\.md/.test(files["TEAM.md"]!), "secret-looking strings are redacted, and TEAM.md says where");
  assert(/^name: caption-style$/m.test(files["skills/caption-style/SKILL.md"]!), "skills are exported as SKILL.md files");
  const back = unbundleTeam(bundleTeam(files));
  assert(Object.keys(back).length === Object.keys(files).length && Object.entries(files).every(([k, v]) => back[k] === `${v.trimEnd()}\n`), "a bundle round-trips");

  const same = await planTeamImport(files, { skills });
  assert(!same.create.length && same.update.length === 1 && same.update[0]!.id === "nyx" && same.update[0]!.fields.join() === "persona" && !same.problems.length, "importing the export changes nothing — except the persona whose secret was redacted");

  const edited = { ...files, "agents/nyx.md": files["agents/nyx.md"]!.replace(/^role: .*$/m, "role: Content · Captions"), "agents/lyra.md": LYRA, "skills/pitch-format/SKILL.md": "---\nname: pitch-format\ndescription: How a sync pitch is laid out.\n---\n\nThree lines, then the link.\n" };
  const preview = await planTeamImport(edited, { skills });
  assert(preview.create.join() === "lyra" && preview.update.some((u) => u.id === "nyx" && u.fields.includes("role")) && preview.skills.add.join() === "pitch-format", "the plan shows what would change");
  assert(!(await getAgentIdentity("lyra")), "planning changes nothing");
  const before = (await listAgentRevisions("nyx")).length;
  const applied = await applyTeamImport(edited, { skills, skillsDir });
  const lyra = await getAgentIdentity("lyra");
  assert(applied.applied && lyra?.reportsTo === "hemera" && (await getAgentDefaultModel("lyra")) === "claude-cli:haiku" && (await getAgentControlState("lyra")).budget?.limitTokens === 30000, "applied: Lyra is created with her manager, model and budget");
  assert((await getAgentIdentity("nyx"))?.role === "Content · Captions" && (await listAgentRevisions("nyx")).length > before, "Nyx's change is a config revision (restorable)");
  assert(skills.has("pitch-format"), "the new skill is written and live");

  const broken = {
    "agents/theia.md": files["agents/theia.md"]!.replace(/^reportsTo: .*$/m, "reportsTo: nobody"),
    "agents/hemera.md": files["agents/hemera.md"]!.replace(/^---\n/, "---\nreportsTo: nyx\n").replace(/^budget: .*$/m, "budget: lots"),
  };
  const refused = await applyTeamImport(broken, { skills, skillsDir });
  assert(!refused.applied && refused.problems.some((p) => /budget must look like/.test(p)), "a bad budget is a problem");
  const loop = await applyTeamImport({ "agents/hemera.md": files["agents/hemera.md"]!.replace(/^---\n/, "---\nreportsTo: nyx\n") }, { skills, skillsDir });
  const unknown = await applyTeamImport({ "agents/theia.md": broken["agents/theia.md"]! }, { skills, skillsDir });
  assert(!loop.applied && loop.problems.some((p) => /reporting loop/.test(p)) && !unknown.applied && unknown.problems.some((p) => /isn't in the team/.test(p)), "a reporting loop or unknown manager is refused");
  assert(!(await getAgentIdentity("hemera"))?.reportsTo && (await getAgentIdentity("theia"))?.reportsTo === "hemera", "and nothing from a refused import was applied");

  const gateway = await startGateway({ model: createStubModel(), worker: createStubWorker(), skills, skillsDir });
  const base = `http://127.0.0.1:${gateway.port}`;
  try {
    const exp = (await (await fetch(`${base}/team/export`)).json()) as { files: Record<string, string>; bundle: string };
    assert(!!exp.files["agents/lyra.md"] && exp.bundle.startsWith("<!-- file: TEAM.md -->"), "GET /team/export");
    const post = (body: unknown) => fetch(`${base}/team/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const dry = (await (await post({ bundle: exp.bundle })).json()) as { applied: boolean; problems: string[] };
    assert(!dry.applied && !dry.problems.length, "POST /team/import previews without applying");
    assert((await post({ files: { "agents/x.md": "no frontmatter" }, apply: true })).status === 409, "a template with problems is a 409");
  } finally {
    await gateway.stop();
  }
  if (process.exitCode === 1) console.error("\nSome team-template tests FAILED.");
  else console.log("\nAll team-template tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
