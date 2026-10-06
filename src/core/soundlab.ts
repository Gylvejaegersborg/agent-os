// The Sound Lab: candidate sounds the operator listens to and judges (accept / maybe / skip).
//
// State is an event stream ("soundlab"), like the rest of the OS: a candidate is its kind +
// params + seed (the audio is rendered from those when played, never stored), and a
// verdict is one more event. The next batch is steered by what was accepted: most of it
// is a nudge of an accepted sound (mutateParams), the rest is fresh variety, so the
// operator's taste narrows in over a few rounds without ever running out of new ideas.
//
// Only the operator judges. An agent can ask for a batch (a "brief" is just a kind and a
// count), but accepting is a human decision: there is no agent route to it.

import { appendEvent, project } from "./eventlog.js";
import { generateId } from "./id.js";
import { MELODIC_KINDS, SOUND_KINDS, cleanParams, durationSec, encodeWav24, mutateParams, randomParams, renderSound, rng, soundLabel, type SoundKind } from "./soundgen.js";

const STREAM = "soundlab";
export const MAX_BATCH = 24;

export type Verdict = "pending" | "accepted" | "maybe" | "skipped";

export interface Candidate {
  id: string;
  batchId: string;
  kind: SoundKind;
  label: string;
  params: Record<string, number>;
  seed: number;
  /** The accepted sound this one is a nudge of, if any. */
  parentId?: string;
  createdAt: string;
  verdict: Verdict;
  judgedAt?: string;
}

export class SoundLabError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const isKind = (k: unknown): k is SoundKind => typeof k === "string" && (SOUND_KINDS as string[]).includes(k);

async function candidates(): Promise<Map<string, Candidate>> {
  return project<Map<string, Candidate>>(STREAM, new Map(), (state, e) => {
    const p = e.payload as any;
    if (e.type === "sound.candidate") state.set(p.id, { ...p, verdict: "pending" });
    else if (e.type === "sound.judged") {
      const c = state.get(p.id);
      if (c) state.set(p.id, { ...c, verdict: p.verdict, judgedAt: e.timestamp });
    }
    return state;
  });
}

export async function getCandidate(id: string): Promise<Candidate | undefined> {
  return (await candidates()).get(id);
}

export async function listCandidates(filter: { verdict?: Verdict; kind?: SoundKind } = {}): Promise<Candidate[]> {
  return [...(await candidates()).values()]
    .filter((c) => (!filter.verdict || c.verdict === filter.verdict) && (!filter.kind || c.kind === filter.kind))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** New candidates for one kind. Steered by what the operator has accepted of that kind. */
export async function generateBatch(kind: SoundKind, count: number, seed = Math.floor(Math.random() * 2 ** 32)): Promise<Candidate[]> {
  if (!isKind(kind)) throw new SoundLabError(400, `kind must be one of: ${SOUND_KINDS.join(", ")}`);
  const n = Math.round(Number(count));
  if (!Number.isFinite(n) || n < 1 || n > MAX_BATCH) throw new SoundLabError(400, `count must be 1 to ${MAX_BATCH}`);
  const rand = rng(seed);
  const liked = await listCandidates({ verdict: "accepted", kind });
  const batchId = generateId().toLowerCase().replace(/[^a-z0-9]/g, "");
  const out: Candidate[] = [];
  for (let i = 0; i < n; i++) {
    const parent = liked.length && rand() < 0.6 ? liked[Math.floor(rand() * liked.length)]! : undefined;
    const params = parent ? mutateParams(kind, parent.params, rand) : randomParams(kind, rand);
    const candidate: Omit<Candidate, "verdict"> = {
      id: `snd-${generateId().toLowerCase().replace(/[^a-z0-9]/g, "")}`,
      batchId,
      kind,
      label: soundLabel(kind, params),
      params,
      seed: Math.floor(rand() * 2 ** 32),
      ...(parent ? { parentId: parent.id } : {}),
      createdAt: new Date().toISOString(),
    };
    await appendEvent(STREAM, "sound.candidate", candidate as unknown as Record<string, unknown>);
    out.push({ ...candidate, verdict: "pending" });
  }
  return out;
}

export async function judge(id: string, verdict: unknown): Promise<Candidate> {
  if (verdict !== "accepted" && verdict !== "maybe" && verdict !== "skipped" && verdict !== "pending") {
    throw new SoundLabError(400, "verdict must be accepted, maybe, skipped or pending (to undo)");
  }
  if (!(await getCandidate(id))) throw new SoundLabError(404, `No sound "${id}".`);
  await appendEvent(STREAM, "sound.judged", { id, verdict });
  return (await getCandidate(id))!;
}

export async function stats(): Promise<Record<string, Record<Verdict, number>> & { total: Record<Verdict, number> }> {
  const empty = (): Record<Verdict, number> => ({ pending: 0, accepted: 0, maybe: 0, skipped: 0 });
  const out: Record<string, Record<Verdict, number>> = { total: empty() };
  for (const k of SOUND_KINDS) out[k] = empty();
  for (const c of (await candidates()).values()) {
    out[c.kind]![c.verdict]++;
    out.total![c.verdict]++;
  }
  return out as any;
}

// A small cache: playing a card twice, or preloading the next, shouldn't re-render.
const cache = new Map<string, Buffer>();

export async function renderCandidateWav(id: string): Promise<{ wav: Buffer; candidate: Candidate; durationSec: number } | undefined> {
  const candidate = await getCandidate(id);
  if (!candidate) return undefined;
  let wav = cache.get(id);
  const data = wav ? undefined : renderSound(candidate.kind, candidate.params, candidate.seed);
  if (!wav && data) {
    wav = encodeWav24(data);
    cache.set(id, wav);
    if (cache.size > 80) cache.delete(cache.keys().next().value!);
  }
  // Duration from the WAV header math (24-bit mono): (bytes - 44) / 3 / rate.
  return { wav: wav!, candidate, durationSec: durationSec(new Float32Array((wav!.length - 44) / 3)) };
}

export { MELODIC_KINDS, cleanParams };
