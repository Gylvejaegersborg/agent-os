// Skills — implements the open agentskills.io specification rather than a
// bespoke format, so skills written for Claude Code, Codex, or Pi are
// directly compatible (see docs/architecture.md §5 for why this matters:
// it's the most-converged primitive across every harness studied).
//
// Progressive disclosure, per spec:
//   1. Metadata (name + description, ~100 tokens) — loaded for every skill
//      at startup, always resident in context.
//   2. Instructions (the full SKILL.md body, <5000 tokens recommended) —
//      loaded only when the skill is activated.
//   3. Resources (references/, scripts/, assets/) — loaded only as needed.
// This file implements layers 1 and 2. Layer 3 (resource file loading) is
// a natural follow-up once a skill actually needs it — the directory
// convention is already respected by discoverSkills(), just not yet
// exposed as its own loader.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { appendEvent } from "./eventlog.js";

export interface SkillMetadata {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];
  dirPath: string;
}

export interface SkillFull extends SkillMetadata {
  body: string;
}

/** Deliberately minimal frontmatter parser — handles exactly the subset of
 *  YAML the agentskills.io spec's frontmatter actually needs (flat
 *  key: value pairs, one level of nested map for `metadata:`, quoted
 *  strings). This is NOT a general YAML parser; swap for a real one
 *  (e.g. js-yaml) the moment a skill in the wild needs more than this. */
function parseSimpleYaml(yaml: string): Record<string, any> {
  const lines = yaml.split("\n");
  const result: Record<string, any> = {};
  let currentMapKey: string | null = null;

  for (const rawLine of lines) {
    if (!rawLine.trim()) continue;

    const isIndented = /^\s{2,}/.test(rawLine);
    if (isIndented && currentMapKey) {
      const m = rawLine.trim().match(/^([\w.-]+):\s*(.*)$/);
      if (m) {
        const [, k, v] = m;
        if (typeof result[currentMapKey] !== "object" || result[currentMapKey] === null) {
          result[currentMapKey] = {};
        }
        result[currentMapKey][k] = stripQuotes(v);
      }
      continue;
    }

    currentMapKey = null;
    const m = rawLine.match(/^([\w-]+):\s*(.*)$/);
    if (m) {
      const [, k, v] = m;
      if (v.trim() === "") {
        currentMapKey = k; // next indented lines are this key's nested map
      } else {
        result[k] = stripQuotes(v.trim());
      }
    }
  }
  return result;
}

function stripQuotes(v: string): string {
  const trimmed = v.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseSkillFile(raw: string, dirPath: string): SkillFull {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(`SKILL.md at ${dirPath} is missing YAML frontmatter (expected --- ... --- header)`);
  }
  const [, yamlBlock, body] = match;
  const fm = parseSimpleYaml(yamlBlock);

  if (!fm.name || typeof fm.name !== "string") {
    throw new Error(`SKILL.md at ${dirPath} is missing required "name" field`);
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(fm.name)) {
    throw new Error(
      `SKILL.md at ${dirPath}: "name" must be lowercase letters/numbers/hyphens only, no leading/trailing hyphen (got "${fm.name}")`,
    );
  }
  if (fm.name.length > 64) {
    throw new Error(`SKILL.md at ${dirPath}: "name" exceeds 64 characters`);
  }
  if (!fm.description || typeof fm.description !== "string") {
    throw new Error(`SKILL.md at ${dirPath} is missing required "description" field`);
  }
  if (fm.description.length > 1024) {
    throw new Error(`SKILL.md at ${dirPath}: "description" exceeds 1024 characters`);
  }

  return {
    name: fm.name,
    description: fm.description,
    license: fm.license,
    compatibility: fm.compatibility,
    metadata: typeof fm.metadata === "object" ? fm.metadata : undefined,
    allowedTools: typeof fm["allowed-tools"] === "string" ? fm["allowed-tools"].split(/\s+/).filter(Boolean) : undefined,
    dirPath,
    body: body.trim(),
  };
}

/** Scans a directory of skill subdirectories (each containing a SKILL.md)
 *  and returns every skill found. Matches the spec's directory-structure
 *  convention: skill-name/SKILL.md (+ optional scripts/, references/,
 *  assets/, which this function doesn't need to touch). Malformed skills
 *  are skipped with a warning rather than failing discovery entirely —
 *  one broken skill shouldn't take the whole catalog down. */
export async function discoverSkills(rootDir: string): Promise<SkillFull[]> {
  const skills: SkillFull[] = [];
  let entries: string[];
  try {
    entries = await readdir(rootDir);
  } catch {
    return skills; // no skills directory yet — not an error
  }

  for (const entry of entries) {
    const dirPath = path.join(rootDir, entry);
    const stats = await stat(dirPath).catch(() => undefined);
    if (!stats?.isDirectory()) continue;

    const skillFile = path.join(dirPath, "SKILL.md");
    const raw = await readFile(skillFile, "utf-8").catch(() => undefined);
    if (raw === undefined) continue;

    try {
      skills.push(parseSkillFile(raw, dirPath));
    } catch (err) {
      console.warn(`[skills] skipping invalid skill at ${dirPath}: ${(err as Error).message}`);
    }
  }
  return skills;
}

/** The runtime catalog an Agent consults each turn. Metadata for every
 *  skill is always available (layer 1); loadBody() is the layer-2
 *  progressive-disclosure step, logged as an event so "which skill did the
 *  agent load, and when" is part of the same auditable history as
 *  everything else in this system. */
export class SkillRegistry {
  private skills = new Map<string, SkillFull>();

  static async fromDirectory(rootDir: string): Promise<SkillRegistry> {
    const registry = new SkillRegistry();
    const found = await discoverSkills(rootDir);
    for (const skill of found) registry.skills.set(skill.name, skill);
    return registry;
  }

  listMetadata(): SkillMetadata[] {
    return [...this.skills.values()].map(({ body, ...meta }) => meta);
  }

  async loadBody(name: string, ctx: { agentId: string; sessionId: string }): Promise<string | undefined> {
    const skill = this.skills.get(name);
    await appendEvent(`session:${ctx.sessionId}`, "skill.loaded", {
      agentId: ctx.agentId,
      skillName: name,
      found: !!skill,
    });
    return skill?.body;
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }
}

/** Renders the always-resident skill catalog as system-prompt text —
 *  layer 1 of progressive disclosure. Kept deliberately terse: per spec,
 *  each entry should cost roughly ~100 tokens, and there can be many
 *  skills in a real catalog. */
export function renderSkillCatalog(skills: SkillMetadata[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
  return [
    "Available skills (call the `skill` tool with {name} to load full instructions for one):",
    ...lines,
  ].join("\n");
}
