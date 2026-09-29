// The team as files, from a terminal (core/team-template.ts):
//   npm run team -- export <dir>          write TEAM.md, agents/*.md, skills/*/SKILL.md
//   npm run team -- import <dir|file.md>  show what an import would change
//   npm run team -- import <dir|file.md> --apply
// Works on the gateway's data directory (AGENT_OS_DATA_DIR), so run it
// with the same env the gateway uses. Skills come from AGENT_OS_SKILLS_DIR
// (default ./skills).

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { SkillRegistry, applyTeamImport, bundleTeam, exportTeam, planTeamImport, unbundleTeam, type TeamFiles } from "./core/index.js";

async function readDir(root: string, rel = ""): Promise<TeamFiles> {
  const out: TeamFiles = {};
  for (const entry of await readdir(path.join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, await readDir(root, p));
    else if (entry.name.endsWith(".md")) out[p] = await readFile(path.join(root, p), "utf-8");
  }
  return out;
}

async function main(): Promise<void> {
  const [cmd, target, flag] = process.argv.slice(2);
  const skillsDir = process.env.AGENT_OS_SKILLS_DIR ?? path.join(process.cwd(), "skills");
  const skills = await SkillRegistry.fromDirectory(skillsDir);
  if (cmd === "export" && target) {
    const files = await exportTeam({ skills });
    if (target.endsWith(".md")) await writeFile(target, bundleTeam(files), "utf-8");
    else
      for (const [p, text] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(target, p)), { recursive: true });
        await writeFile(path.join(target, p), text, "utf-8");
      }
    console.log(`Exported ${Object.keys(files).length} files to ${target}`);
    return;
  }
  if (cmd === "import" && target) {
    const files = (await stat(target)).isDirectory() ? await readDir(target) : unbundleTeam(await readFile(target, "utf-8"));
    const plan = flag === "--apply" ? await applyTeamImport(files, { skills, skillsDir }) : await planTeamImport(files, { skills });
    console.log(JSON.stringify(plan, null, 2));
    if (plan.problems.length) process.exitCode = 1;
    else if (!plan.applied) console.log("\nNothing changed. Run again with --apply to apply.");
    return;
  }
  console.log("usage: npm run team -- export <dir|file.md> | import <dir|file.md> [--apply]");
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
