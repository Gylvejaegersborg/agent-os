// Per-agent tool allowlist — the "always allow" answer to an approval.
// When an agent's PermissionPolicy (permissions.ts) says "ask", the hook
// checks this list before creating an ApprovalRequest: a matching entry
// lets the call straight through.
//
// An entry allows either every call of a tool (`args` omitted) or one
// exact call (`args` set, compared key-order-independently). Tools that
// can change files or run commands can only be allowlisted for an exact
// call — "always allow shell" would be a blank cheque — and nothing that
// pushes to git can be allowlisted at all.
//
// Event-sourced like everything else here (an `allowlist` stream reduced
// by project()), so it survives restarts and every change is auditable.

import { GATED_TOOL_NAMES } from "./tool-registry.js";
import { project, appendEvent } from "./eventlog.js";
import { publishEvent } from "./eventbus.js";
import { generateId } from "./id.js";

const STREAM = "allowlist";

/** Tools that may only be allowlisted for one exact call. */
export const EXACT_ONLY_TOOLS = ["shell", "write_file", "edit_file", "subagent"];

export interface AllowRule {
  id: string;
  agentId: string;
  toolName: string;
  /** Exact arguments this rule allows; undefined = any arguments. */
  args?: Record<string, unknown>;
  note?: string;
  createdAt: string;
  createdBy?: string;
}

export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

async function projectRules(): Promise<Map<string, AllowRule>> {
  return project<Map<string, AllowRule>>(STREAM, new Map(), (state, event) => {
    const p = event.payload as any;
    if (event.type === "allowlist.added") {
      state.set(p.id, { id: p.id, agentId: p.agentId, toolName: p.toolName, args: p.args, note: p.note, createdBy: p.createdBy, createdAt: event.timestamp });
    } else if (event.type === "allowlist.removed") {
      state.delete(p.id);
    }
    return state;
  });
}

export async function listAllowRules(agentId?: string): Promise<AllowRule[]> {
  const rules = [...(await projectRules()).values()];
  return rules.filter((r) => !agentId || r.agentId === agentId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Throws with a readable reason when a rule would be unsafe. */
export function validateAllowRule(input: { toolName: string; args?: Record<string, unknown> }): void {
  if (!input.toolName) throw new Error("a rule needs a tool name");
  if (GATED_TOOL_NAMES.includes(input.toolName)) {
    throw new Error(`"${input.toolName}" always needs your approval — hiring and goal plans can't be always-allowed`);
  }
  if (!input.args && EXACT_ONLY_TOOLS.includes(input.toolName)) {
    throw new Error(`"${input.toolName}" can only be always-allowed for one exact call, not every call`);
  }
  if (input.args && /git\s+push/i.test(JSON.stringify(input.args))) {
    throw new Error("anything that pushes to git always needs approval");
  }
}

/** Adds a rule (or returns the existing identical one). */
export async function addAllowRule(input: {
  agentId: string;
  toolName: string;
  args?: Record<string, unknown>;
  note?: string;
  createdBy?: string;
}): Promise<AllowRule> {
  validateAllowRule(input);
  const existing = (await listAllowRules(input.agentId)).find(
    (r) => r.toolName === input.toolName && stableJson(r.args ?? null) === stableJson(input.args ?? null),
  );
  if (existing) return existing;
  const id = generateId();
  await appendEvent(STREAM, "allowlist.added", { id, ...input });
  await publishEvent("allowlist.changed", { agentId: input.agentId });
  return (await projectRules()).get(id)!;
}

export async function removeAllowRule(id: string): Promise<boolean> {
  const rule = (await projectRules()).get(id);
  if (!rule) return false;
  await appendEvent(STREAM, "allowlist.removed", { id });
  await publishEvent("allowlist.changed", { agentId: rule.agentId });
  return true;
}

/** The rule that allows this call, if any. */
export async function findAllowRule(agentId: string, toolName: string, args: Record<string, unknown>): Promise<AllowRule | undefined> {
  const wanted = stableJson(args);
  return (await listAllowRules(agentId)).find(
    (r) => r.toolName === toolName && (r.args === undefined || stableJson(r.args) === wanted),
  );
}

/** Seeds default rules once per agent/tool (idempotent) — used at gateway
 *  startup so e.g. reading/writing BaseSpace never needs an approval. A
 *  seeded rule the operator later removes is not re-added: each seed is
 *  recorded, and only never-seeded ones are added. */
export async function seedAllowRules(seeds: { agentId: string; toolName: string }[]): Promise<number> {
  const seeded = await project<Set<string>>(STREAM, new Set(), (state, event) => {
    if (event.type === "allowlist.seeded") state.add((event.payload as any).key);
    return state;
  });
  let added = 0;
  for (const s of seeds) {
    const key = `${s.agentId}:${s.toolName}`;
    if (seeded.has(key)) continue;
    await addAllowRule({ ...s, note: "default", createdBy: "agent-os" });
    await appendEvent(STREAM, "allowlist.seeded", { key });
    added++;
  }
  return added;
}
