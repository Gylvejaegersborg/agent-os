// Agent filesystem namespace — docs/architecture.md §7: "expose this
// world as an actual namespace." Deliberately NOT a new storage layer —
// every path here is a read-only VIEW over primitives that already
// exist (event log streams, skill files, memory projections). This is
// the same "everything is a projection" principle the whole scaffold is
// built on (README "Design principle"), just applied to a filesystem-
// shaped API instead of an event-log-shaped one.
//
// Layout (mirrors the architecture doc exactly):
//   /agent/skills/<name>/SKILL.md
//   /agent/memory/<agentId>/curated/MEMORY.md
//   /agent/memory/<agentId>/episodic/<entryId>.json
//   /agent/sessions/<sessionId>.jsonl
//   /agent/tasks/<taskId>/state.json
//   /agent/flows/<flowId>/state.json
//   /agent/automations/<automationId>.json
//
// Write operations are deliberately NOT implemented yet — this is a
// read-only projection for now. Writing through this namespace would
// mean deciding how a raw file write maps back onto event-log semantics
// (an appended event? a whole new event type?), which is a real design
// question left for the next pass rather than papered over here.

import { discoverSkills } from "./skills.js";
import { getCuratedMemory, listEpisodic } from "./memory.js";
import { readStream, listStreamIds } from "./eventlog.js";
import { getTask, listTasks } from "./tasks.js";
import { getFlow, listFlows } from "./tasks.js";
import { getAutomation, listAutomations } from "./tasks.js";
import { getAgentIdentity, listAgentIdentities } from "./identity.js";

export interface FsEntry {
  name: string;
  kind: "dir" | "file";
}

export class FsNotFoundError extends Error {
  constructor(path: string) {
    super(`no such agent-fs path: ${path}`);
  }
}

function segments(virtualPath: string): string[] {
  return virtualPath.split("/").filter((s) => s.length > 0 && s !== "agent");
}

/** Lists entries under a virtual /agent/... directory path. */
export async function fsList(virtualPath: string): Promise<FsEntry[]> {
  const parts = segments(virtualPath);

  if (parts.length === 0) {
    return [
      { name: "identity", kind: "dir" },
      { name: "skills", kind: "dir" },
      { name: "memory", kind: "dir" },
      { name: "sessions", kind: "dir" },
      { name: "tasks", kind: "dir" },
      { name: "flows", kind: "dir" },
      { name: "automations", kind: "dir" },
    ];
  }

  const [top, ...rest] = parts;

  if (top === "identity") {
    if (rest.length === 0) {
      const identities = await listAgentIdentities();
      return identities.map((i) => ({ name: `${i.id}.json`, kind: "file" as const }));
    }
    throw new FsNotFoundError(virtualPath);
  }

  if (top === "skills") {
    if (rest.length === 0) {
      const skills = await discoverSkills("skills");
      return skills.map((s) => ({ name: s.name, kind: "dir" as const }));
    }
    if (rest.length === 1) {
      return [{ name: "SKILL.md", kind: "file" }];
    }
    throw new FsNotFoundError(virtualPath);
  }

  if (top === "memory") {
    if (rest.length === 0) throw new FsNotFoundError(virtualPath); // needs an agentId
    if (rest.length === 1) {
      return [
        { name: "curated", kind: "dir" },
        { name: "episodic", kind: "dir" },
      ];
    }
    const [, sub] = rest;
    if (sub === "curated") return [{ name: "MEMORY.md", kind: "file" }];
    if (sub === "episodic") {
      const [agentId] = rest;
      const entries = await listEpisodic(agentId);
      return entries.map((e) => ({ name: `${e.id}.json`, kind: "file" as const }));
    }
    throw new FsNotFoundError(virtualPath);
  }

  if (top === "sessions") {
    if (rest.length === 0) {
      const streams = await listStreamIds();
      return streams.filter((s) => s.startsWith("session_")).map((s) => ({ name: `${s}.jsonl`, kind: "file" as const }));
    }
    throw new FsNotFoundError(virtualPath);
  }

  if (top === "tasks") {
    if (rest.length === 0) {
      const tasks = await listTasks();
      return tasks.map((t) => ({ name: t.id, kind: "dir" as const }));
    }
    if (rest.length === 1) return [{ name: "state.json", kind: "file" }];
    throw new FsNotFoundError(virtualPath);
  }

  if (top === "flows") {
    if (rest.length === 0) {
      const flows = await listFlows();
      return flows.map((f) => ({ name: f.id, kind: "dir" as const }));
    }
    if (rest.length === 1) return [{ name: "state.json", kind: "file" }];
    throw new FsNotFoundError(virtualPath);
  }

  if (top === "automations") {
    if (rest.length === 0) {
      const automations = await listAutomations();
      return automations.map((a) => ({ name: `${a.id}.json`, kind: "file" as const }));
    }
    throw new FsNotFoundError(virtualPath);
  }

  throw new FsNotFoundError(virtualPath);
}

/** Reads the content of a virtual /agent/... file path as text. */
export async function fsRead(virtualPath: string): Promise<string> {
  const parts = segments(virtualPath);
  const [top, ...rest] = parts;

  if (top === "identity" && rest.length === 1) {
    const agentId = rest[0].replace(/\.json$/, "");
    const identity = await getAgentIdentity(agentId);
    if (!identity) throw new FsNotFoundError(virtualPath);
    return JSON.stringify(identity, null, 2);
  }

  if (top === "skills" && rest.length === 2 && rest[1] === "SKILL.md") {
    const [name] = rest;
    const skills = await discoverSkills("skills");
    const skill = skills.find((s) => s.name === name);
    if (!skill) throw new FsNotFoundError(virtualPath);
    return skill.body;
  }

  if (top === "memory" && rest.length === 2 && rest[0] && rest[1] === "curated") {
    throw new FsNotFoundError(virtualPath); // caller should request curated/MEMORY.md specifically
  }
  if (top === "memory" && rest.length === 3 && rest[1] === "curated" && rest[2] === "MEMORY.md") {
    const [agentId] = rest;
    const curated = await getCuratedMemory(agentId);
    return curated.content || "(no curated memory yet — nothing has crossed the promotion threshold)";
  }
  if (top === "memory" && rest.length === 3 && rest[1] === "episodic") {
    const [agentId, , fileName] = rest;
    const entryId = fileName.replace(/\.json$/, "");
    const entries = await listEpisodic(agentId);
    const entry = entries.find((e) => e.id === entryId);
    if (!entry) throw new FsNotFoundError(virtualPath);
    return JSON.stringify(entry, null, 2);
  }

  if (top === "sessions" && rest.length === 1) {
    const streamId = rest[0].replace(/\.jsonl$/, "");
    const events = await readStream(streamId);
    return events.map((e) => JSON.stringify(e)).join("\n");
  }

  if (top === "tasks" && rest.length === 2 && rest[1] === "state.json") {
    const [taskId] = rest;
    const task = await getTask(taskId);
    if (!task) throw new FsNotFoundError(virtualPath);
    return JSON.stringify(task, null, 2);
  }

  if (top === "flows" && rest.length === 2 && rest[1] === "state.json") {
    const [flowId] = rest;
    const flow = await getFlow(flowId);
    if (!flow) throw new FsNotFoundError(virtualPath);
    return JSON.stringify(flow, null, 2);
  }

  if (top === "automations" && rest.length === 1) {
    const automationId = rest[0].replace(/\.json$/, "");
    const automation = await getAutomation(automationId);
    if (!automation) throw new FsNotFoundError(virtualPath);
    return JSON.stringify(automation, null, 2);
  }

  throw new FsNotFoundError(virtualPath);
}
