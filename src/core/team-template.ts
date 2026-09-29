// Team templates, after Paperclip's company package (COMPANY.md / TEAM.md /
// AGENTS.md): the whole team as plain markdown files you can read, diff,
// keep in git and share.
//
//   TEAM.md               the team at a glance: reporting tree, verifier, skills
//   agents/<id>.md        one per agent: frontmatter (name, role, reportsTo,
//                         model, budget, capabilities) + the persona as the body
//   skills/<name>/SKILL.md  the agentskills.io files, as they are on disk
//
// Export strips anything that looks like a secret (API keys, tokens) from
// personas and skills. Agent config itself holds none — models are names
// like "claude-cli:sonnet", credentials live in the gateway's environment.
// Pause state and token usage are operational, not part of a template.
//
// Import makes the listed agents match the files: missing ones are created,
// existing ones updated (every change is a config revision — governance.ts —
// so an import can be undone agent by agent with "restore"). Agents not in
// the files are left alone; nothing is deleted. It checks everything first
// and changes nothing if any file has a problem. Operator-only (a gateway
// route or the CLI), never an agent tool.

import { listAgentIdentities, updateAgentIdentity } from "./identity.js";
import { getAgentDefaultModel, setAgentDefaultModel } from "./models/real.js";
import { getAgentControlState, setAgentBudget, type BudgetPeriod } from "./controls.js";
import { parseSkillFile, serializeSkillFile, writeSkill, type SkillRegistry } from "./skills.js";
import { seedAllowRules } from "./allowlist.js";
import { verifierId } from "./watchdog.js";

export type TeamFiles = Record<string, string>;

const SECRET = /\b(sk-ant-[\w-]{10,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[\w]{20,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,})\b/g;

function redact(text: string, found: string[], where: string): string {
  return text.replace(SECRET, () => {
    found.push(where);
    return "[redacted]";
  });
}

interface AgentSpec {
  id: string;
  name: string;
  role?: string;
  reportsTo?: string;
  model?: string;
  budget?: { period: BudgetPeriod; limitTokens: number };
  capabilities?: string[];
  persona: string;
}

// ---- files <-> specs -----------------------------------------------------------

function frontmatter(fields: Record<string, string | undefined>): string {
  const lines = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${String(v).replace(/\n/g, " ")}`);
  return `---\n${lines.join("\n")}\n---\n`;
}

function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } | undefined {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) return undefined;
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim());
    if (kv) fields[kv[1]!] = kv[2]!.trim();
  }
  return { fields, body: m[2]!.trim() };
}

function agentFile(a: AgentSpec): string {
  return (
    frontmatter({
      id: a.id,
      name: a.name,
      role: a.role,
      reportsTo: a.reportsTo,
      model: a.model,
      budget: a.budget ? `${a.budget.limitTokens}/${a.budget.period}` : undefined,
      capabilities: a.capabilities?.length ? a.capabilities.join(", ") : undefined,
    }) + `\n${a.persona}\n`
  );
}

function readAgentFile(path: string, text: string): AgentSpec | string {
  const fm = parseFrontmatter(text);
  if (!fm) return `${path}: no frontmatter (--- id: … ---)`;
  const f = fm.fields;
  const id = (f.id ?? path.replace(/^agents\//, "").replace(/\.md$/, "")).toLowerCase();
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(id)) return `${path}: bad id "${id}"`;
  if (!f.name) return `${path}: needs a name`;
  if (fm.body.length < 20) return `${path}: needs a persona (the text after the frontmatter)`;
  let budget: AgentSpec["budget"];
  if (f.budget) {
    const b = /^(\d+)\s*\/\s*(day|week|month)$/.exec(f.budget);
    if (!b) return `${path}: budget must look like 40000/week`;
    budget = { limitTokens: Number(b[1]), period: b[2] as BudgetPeriod };
  }
  return {
    id,
    name: f.name,
    ...(f.role ? { role: f.role } : {}),
    ...(f.reportsTo && f.reportsTo !== "operator" ? { reportsTo: f.reportsTo } : {}),
    ...(f.model ? { model: f.model } : {}),
    ...(budget ? { budget } : {}),
    ...(f.capabilities ? { capabilities: f.capabilities.split(",").map((c) => c.trim()).filter(Boolean) } : {}),
    persona: fm.body,
  };
}

// ---- export --------------------------------------------------------------------

export async function exportTeam(opts: { name?: string; skills?: SkillRegistry } = {}): Promise<TeamFiles> {
  const files: TeamFiles = {};
  const redacted: string[] = [];
  const agents = await listAgentIdentities();
  const specs: AgentSpec[] = [];
  for (const a of agents) {
    const control = await getAgentControlState(a.id);
    const model = await getAgentDefaultModel(a.id);
    specs.push({
      id: a.id,
      name: a.name,
      ...(a.role ? { role: a.role } : {}),
      ...(a.reportsTo ? { reportsTo: a.reportsTo } : {}),
      ...(model ? { model } : {}),
      ...(control.budget ? { budget: { period: control.budget.period, limitTokens: control.budget.limitTokens } } : {}),
      ...(a.capabilities?.length ? { capabilities: a.capabilities } : {}),
      persona: redact(a.persona, redacted, `agents/${a.id}.md`),
    });
  }
  for (const s of specs) files[`agents/${s.id}.md`] = agentFile(s);

  const skillNames: string[] = [];
  for (const meta of opts.skills?.listMetadata() ?? []) {
    const full = opts.skills!.get(meta.name);
    if (!full) continue;
    const { dirPath: _d, ...rest } = full;
    files[`skills/${meta.name}/SKILL.md`] = redact(serializeSkillFile(rest), redacted, `skills/${meta.name}/SKILL.md`);
    skillNames.push(meta.name);
  }

  const name = opts.name ?? "ISΛRK team";
  const byId = new Map(specs.map((s) => [s.id, s]));
  const tree = (manager: string | undefined, depth: number): string[] =>
    specs
      .filter((s) => (s.reportsTo ?? undefined) === manager || (!manager && s.reportsTo && !byId.has(s.reportsTo)))
      .flatMap((s) => [`${"  ".repeat(depth)}- ${s.name} (${s.id})${s.role ? ` — ${s.role}` : ""}${s.model ? ` · ${s.model}` : ""}`, ...tree(s.id, depth + 1)]);
  files["TEAM.md"] =
    frontmatter({ name, exported: new Date().toISOString(), agents: String(specs.length), verifier: verifierId() }) +
    `\n# ${name}\n\n## Reporting lines\n\n- You (the operator)\n${tree(undefined, 1).join("\n")}\n` +
    (skillNames.length ? `\n## Skills\n\n${skillNames.map((s) => `- ${s}`).join("\n")}\n` : "") +
    `\nOne file per agent in \`agents/\` (frontmatter + persona) and one per skill in \`skills/\`. ` +
    "Import with the gateway's POST /team/import or `npm run team -- import <dir>`. Credentials are never part of a template." +
    (redacted.length ? `\n\n${redacted.length} secret-looking string(s) were replaced with [redacted] in: ${[...new Set(redacted)].join(", ")}.` : "") +
    "\n";
  return files;
}

/** All files as one markdown document — for a download or a paste. */
export function bundleTeam(files: TeamFiles): string {
  const order = Object.keys(files).sort((a, b) => (a === "TEAM.md" ? -1 : b === "TEAM.md" ? 1 : a.localeCompare(b)));
  return order.map((p) => `<!-- file: ${p} -->\n${files[p]!.trimEnd()}\n`).join("\n");
}

export function unbundleTeam(bundle: string): TeamFiles {
  const files: TeamFiles = {};
  const parts = bundle.replace(/\r\n/g, "\n").split(/^<!-- file: (.+?) -->\n/m);
  for (let i = 1; i < parts.length; i += 2) files[parts[i]!.trim()] = `${parts[i + 1]!.trimEnd()}\n`;
  return files;
}

// ---- import --------------------------------------------------------------------

export interface TeamImportPlan {
  create: string[];
  update: { id: string; fields: string[] }[];
  unchanged: string[];
  skills: { add: string[]; update: string[]; unchanged: string[] };
  /** Anything wrong — nothing is applied while there are any. */
  problems: string[];
  applied: boolean;
}

interface Parsed {
  specs: AgentSpec[];
  skills: { name: string; raw: string }[];
  problems: string[];
}

function parseFiles(files: TeamFiles): Parsed {
  const specs: AgentSpec[] = [];
  const skills: { name: string; raw: string }[] = [];
  const problems: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    if (/^agents\/[^/]+\.md$/.test(path)) {
      const r = readAgentFile(path, text);
      if (typeof r === "string") problems.push(r);
      else specs.push(r);
    } else if (/^skills\/[^/]+\/SKILL\.md$/.test(path)) {
      const name = path.split("/")[1]!;
      try {
        parseSkillFile(text, name);
        skills.push({ name, raw: text });
      } catch (err) {
        problems.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  if (!specs.length && !skills.length) problems.push("no agents/*.md or skills/*/SKILL.md files found");
  const ids = new Set(specs.map((s) => s.id));
  if (ids.size !== specs.length) problems.push("the same agent id appears twice");
  return { specs, skills, problems };
}

async function plan(files: TeamFiles, registry?: SkillRegistry): Promise<{ plan: TeamImportPlan; parsed: Parsed }> {
  const parsed = parseFiles(files);
  const existing = new Map((await listAgentIdentities()).map((a) => [a.id, a]));
  const all = new Set([...existing.keys(), ...parsed.specs.map((s) => s.id)]);
  const out: TeamImportPlan = { create: [], update: [], unchanged: [], skills: { add: [], update: [], unchanged: [] }, problems: [...parsed.problems], applied: false };

  for (const s of parsed.specs) {
    if (s.reportsTo && !all.has(s.reportsTo)) out.problems.push(`agents/${s.id}.md: reports to "${s.reportsTo}", who isn't in the team or the files`);
    const cur = existing.get(s.id);
    if (!cur) {
      out.create.push(s.id);
      continue;
    }
    const control = await getAgentControlState(s.id);
    const model = (await getAgentDefaultModel(s.id)) ?? "";
    const fields: string[] = [];
    if (cur.name !== s.name) fields.push("name");
    if ((cur.role ?? "") !== (s.role ?? "")) fields.push("role");
    if (cur.persona.trim() !== s.persona.trim()) fields.push("persona");
    if ((cur.reportsTo ?? "") !== (s.reportsTo ?? "")) fields.push("reportsTo");
    if (model !== (s.model ?? "")) fields.push("model");
    const b = control.budget;
    if ((b ? `${b.limitTokens}/${b.period}` : "") !== (s.budget ? `${s.budget.limitTokens}/${s.budget.period}` : "")) fields.push("budget");
    if ((cur.capabilities ?? []).join() !== (s.capabilities ?? []).join()) fields.push("capabilities");
    if (fields.length) out.update.push({ id: s.id, fields });
    else out.unchanged.push(s.id);
  }
  // Reporting loops across the result (A → B → A).
  const manager = new Map([...existing.values()].map((a) => [a.id, a.reportsTo]));
  for (const s of parsed.specs) manager.set(s.id, s.reportsTo);
  for (const id of all) {
    const seen = new Set<string>();
    for (let cur = manager.get(id); cur; cur = manager.get(cur)) {
      if (cur === id || seen.has(cur)) {
        out.problems.push(`reporting loop through ${id}`);
        break;
      }
      seen.add(cur);
    }
  }
  for (const sk of parsed.skills) {
    const have = registry?.get(sk.name);
    if (!have) out.skills.add.push(sk.name);
    else {
      const { dirPath: _d, ...rest } = have;
      (serializeSkillFile(rest).trim() === sk.raw.trim() ? out.skills.unchanged : out.skills.update).push(sk.name);
    }
  }
  out.problems = [...new Set(out.problems)];
  return { plan: out, parsed };
}

/** What an import would do — changes nothing. */
export async function planTeamImport(files: TeamFiles, opts: { skills?: SkillRegistry } = {}): Promise<TeamImportPlan> {
  return (await plan(files, opts.skills)).plan;
}

/** Applies an import if it has no problems; otherwise returns the plan
 *  with `applied: false` and changes nothing. */
export async function applyTeamImport(files: TeamFiles, opts: { skills?: SkillRegistry; skillsDir?: string } = {}): Promise<TeamImportPlan> {
  const { plan: p, parsed } = await plan(files, opts.skills);
  if (p.problems.length) return p;
  const { registerAgent } = await import("./agents.js");
  const specs = new Map(parsed.specs.map((s) => [s.id, s]));
  // Create first (without managers), so reporting lines can point at new agents.
  for (const id of p.create) {
    const s = specs.get(id)!;
    await registerAgent({ id, name: s.name, persona: s.persona, ...(s.role ? { role: s.role } : {}), ...(s.capabilities ? { capabilities: s.capabilities } : {}), ...(s.model ? { defaultModel: s.model } : {}) });
    await seedAllowRules(["basespace", "basespace-add"].map((toolName) => ({ agentId: id, toolName })));
  }
  for (const u of [...p.update, ...p.create.map((id) => ({ id, fields: ["reportsTo", "budget"] }))]) {
    const s = specs.get(u.id)!;
    const patch: Parameters<typeof updateAgentIdentity>[1] = {};
    if (u.fields.includes("name")) patch.name = s.name;
    if (u.fields.includes("role")) patch.role = s.role ?? "";
    if (u.fields.includes("persona")) patch.persona = s.persona;
    if (u.fields.includes("capabilities")) patch.capabilities = s.capabilities ?? [];
    if (u.fields.includes("reportsTo") && (s.reportsTo || !p.create.includes(u.id))) patch.reportsTo = s.reportsTo ?? null;
    if (Object.keys(patch).length) await updateAgentIdentity(u.id, patch);
    if (u.fields.includes("model") && !p.create.includes(u.id)) await setAgentDefaultModel(u.id, s.model ?? "");
    if (u.fields.includes("budget") && (s.budget || !p.create.includes(u.id))) await setAgentBudget(u.id, s.budget ? { ...s.budget } : { limitTokens: null });
  }
  if (opts.skillsDir) {
    for (const sk of parsed.skills.filter((x) => !p.skills.unchanged.includes(x.name))) {
      const full = parseSkillFile(sk.raw, sk.name);
      const { dirPath: _d, ...rest } = full;
      const written = await writeSkill(opts.skillsDir, rest);
      opts.skills?.add(written);
    }
  } else if (p.skills.add.length || p.skills.update.length) {
    p.problems.push("skills were not written: this gateway has no skills directory");
  }
  return { ...p, applied: true };
}

