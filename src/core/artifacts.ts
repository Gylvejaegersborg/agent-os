// Artifacts — first-class, attachable outputs (code, files, reports,
// datasets, plans, drafts, ...) so a client can display/open what an
// agent actually produced without scraping arbitrary tool-call output
// for it. Same event-sourced shape as every other registry here: an
// append-only `artifacts` stream, reduced by project(). Deliberately
// IMMUTABLE once created — there is no updateArtifact(): a revised
// output is a NEW Artifact (optionally referencing the old one via
// metadata), matching the "no separate mutable copy to drift" principle
// this whole codebase follows, and matching how a real artifact (a
// specific report, a specific commit) actually works — you don't mutate
// history, you produce a new version of it.
//
// This scaffold does NOT manage blob storage — `location` is just a
// string the producer chose (a filesystem path under the agent's
// workspace, a URL, whatever makes sense for that artifact's `type`).
// No upload endpoint, no CDN, no content hashing. Proving the primitive
// (attach outputs to a Task/Session/Flow, list/query them) is the scope
// here, same as every other "scaffold, not a platform" primitive in this
// codebase.

import { project, appendEvent } from "./eventlog.js";
import { generateId } from "./id.js";

export type ArtifactType = "code" | "file" | "report" | "image" | "dataset" | "plan" | "draft" | "other";

export interface Artifact {
  id: string;
  type: ArtifactType;
  /** Where the content actually lives — see file header: a path, a URL,
   *  whatever the producer chose. Not interpreted or validated here. */
  location: string;
  /** agentId that produced this artifact. */
  producer: string;
  createdAt: string;
  taskId?: string;
  sessionId?: string;
  flowId?: string;
  metadata: Record<string, unknown>;
}

const ARTIFACTS_STREAM = "artifacts";

export interface CreateArtifactInput {
  type: ArtifactType;
  location: string;
  producer: string;
  taskId?: string;
  sessionId?: string;
  flowId?: string;
  metadata?: Record<string, unknown>;
}

export async function createArtifact(input: CreateArtifactInput): Promise<Artifact> {
  const id = generateId();
  await appendEvent(ARTIFACTS_STREAM, "artifact.created", { artifactId: id, ...input, metadata: input.metadata ?? {} });
  const artifact = await getArtifact(id);
  if (!artifact) throw new Error("artifact.created event did not project to an artifact");
  return artifact;
}

async function projectArtifacts(): Promise<Map<string, Artifact>> {
  return project<Map<string, Artifact>>(ARTIFACTS_STREAM, new Map(), (state, event) => {
    if (event.type === "artifact.created") {
      const p = event.payload as any;
      state.set(p.artifactId, {
        id: p.artifactId,
        type: p.type,
        location: p.location,
        producer: p.producer,
        createdAt: event.timestamp,
        taskId: p.taskId,
        sessionId: p.sessionId,
        flowId: p.flowId,
        metadata: p.metadata ?? {},
      });
    }
    return state;
  });
}

export async function getArtifact(id: string): Promise<Artifact | undefined> {
  return (await projectArtifacts()).get(id);
}

export async function listArtifacts(filter?: {
  taskId?: string;
  sessionId?: string;
  flowId?: string;
  producer?: string;
  type?: ArtifactType;
}): Promise<Artifact[]> {
  let list = [...(await projectArtifacts()).values()];
  if (filter?.taskId) list = list.filter((a) => a.taskId === filter.taskId);
  if (filter?.sessionId) list = list.filter((a) => a.sessionId === filter.sessionId);
  if (filter?.flowId) list = list.filter((a) => a.flowId === filter.flowId);
  if (filter?.producer) list = list.filter((a) => a.producer === filter.producer);
  if (filter?.type) list = list.filter((a) => a.type === filter.type);
  return list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
