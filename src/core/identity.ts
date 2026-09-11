// Minimal Agent identity store — backs /agent/identity/<agentId>.json in
// agentfs.ts. Kept intentionally small: this scaffold's Agent type (see
// docs/architecture.md §1) is {id, identity, memory, policy, defaultModel,
// skillCatalog} — most of those fields are already separately-addressable
// primitives elsewhere in this codebase (memory.ts, permissions.ts,
// models/real.ts, skills.ts), so the identity store here only owns what's
// genuinely unique to "who is this agent": name + persona text.

import { project, appendEvent } from "./eventlog.js";

export interface AgentIdentity {
  id: string;
  name: string;
  persona: string;
  /** e.g. "Manager · Strategy" — free text, presentational/organizational,
   *  not consulted by any runtime decision (unlike defaultModel, which
   *  models/real.ts's createModelForAgent() actually reads). Added so
   *  role lives on the ONE authoritative identity record instead of only
   *  ever existing in a UI-side mock array (see agents.ts's AgentRecord,
   *  which is what a gateway client actually consumes). */
  role?: string;
  /** Free-text capability labels (e.g. "shell", "market-research") — a
   *  simple declared list, not enforced against anything (Layer A/B
   *  permissions remain the actual enforcement mechanism). Exists purely
   *  so a client can show "what is this agent for" without guessing from
   *  its persona text. */
  capabilities?: string[];
  createdAt: string;
  updatedAt: string;
}

const IDENTITY_STREAM = "agent-identities";

export async function registerAgentIdentity(input: {
  id: string;
  name: string;
  persona: string;
  role?: string;
  capabilities?: string[];
}): Promise<AgentIdentity> {
  await appendEvent(IDENTITY_STREAM, "agent.identity.registered", input);
  const identity = await getAgentIdentity(input.id);
  if (!identity) throw new Error("agent.identity.registered event did not project");
  return identity;
}

/** Patches an EXISTING identity's fields (role/capabilities/persona/name)
 *  without re-registering it from scratch. Appends `agent.identity.updated`
 *  — a reducer branch projectIdentities() already supported, but which
 *  had no producer function until now. A patch for an id with no
 *  existing identity is simply ignored (the reducer's `if (existing)`
 *  guard), same as every other "update" primitive in this codebase that
 *  refuses to conjure a record that was never created. */
export async function updateAgentIdentity(
  id: string,
  patch: Partial<Pick<AgentIdentity, "name" | "persona" | "role" | "capabilities">>,
): Promise<AgentIdentity | undefined> {
  await appendEvent(IDENTITY_STREAM, "agent.identity.updated", { id, ...patch });
  return getAgentIdentity(id);
}

async function projectIdentities(): Promise<Map<string, AgentIdentity>> {
  return project<Map<string, AgentIdentity>>(IDENTITY_STREAM, new Map(), (state, event) => {
    if (event.type === "agent.identity.registered") {
      const p = event.payload as any;
      state.set(p.id, {
        id: p.id,
        name: p.name,
        persona: p.persona,
        role: p.role,
        capabilities: p.capabilities,
        createdAt: event.timestamp,
        updatedAt: event.timestamp,
      });
    } else if (event.type === "agent.identity.updated") {
      const p = event.payload as any;
      const existing = state.get(p.id);
      if (existing) {
        state.set(p.id, { ...existing, ...p, updatedAt: event.timestamp });
      }
    }
    return state;
  });
}

export async function getAgentIdentity(id: string): Promise<AgentIdentity | undefined> {
  return (await projectIdentities()).get(id);
}

export async function listAgentIdentities(): Promise<AgentIdentity[]> {
  return [...(await projectIdentities()).values()];
}
