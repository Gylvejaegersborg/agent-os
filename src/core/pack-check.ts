// A check done by code, not by a model: do the numbers an agent wrote about a sound pack match the pack?
//
// Why it exists: agents re-deriving counts from memory got them wrong ("5 x kick" when the pack has 4), and having another
// model check the first one cost a lot and did not converge. This compares every "N x kind", "kind (N)" and "| kind | N |"
// in a note to the latest built pack's manifest, plus the total ("71 sounds"), and flags the artist name written in lowercase.
// It cannot judge wording (that stays with a reviewer), only facts that can be counted.

import { listPacks } from "./soundpack.js";
import { loadOverlay } from "./basespace.js";

const KINDS = ["808", "kick", "snare", "clap", "perc", "hat-closed", "hat-open", "bell", "pluck", "keys", "pad", "strings", "lead"];
const KIND = KINDS.map((k) => k.replace("-", "\\-")).join("|");
// A plural "kicks"/"claps"/"hats" is the same kind: kinds are matched with an optional trailing s.
const K = `(${KIND})s?`;

const PATTERNS: { re: RegExp; kind: number; count: number }[] = [
  { re: new RegExp(`\\b(\\d+)\\s*[×x]\\s*${K}\\b`, "gi"), kind: 2, count: 1 }, // 6 × 808
  { re: new RegExp(`\\b${K}\\s*\\(\\s*(\\d+)\\s*\\)`, "gi"), kind: 1, count: 2 }, // keys (9)
  { re: new RegExp(`\\|\\s*${K}\\s*\\|\\s*(\\d+)\\s*\\|`, "gi"), kind: 1, count: 2 }, // | kick | 4 |
];

export interface PackFacts {
  name: string;
  counts: Record<string, number>;
  total: number;
}

/** Swappable so a test doesn't need to build a real pack. */
let factsSource: (() => Promise<PackFacts | undefined>) | undefined;
export function setPackFactsSource(fn: (() => Promise<PackFacts | undefined>) | undefined): void {
  factsSource = fn;
}

export async function latestPackFacts(): Promise<PackFacts | undefined> {
  if (factsSource) return factsSource();
  const pack = (await listPacks())[0];
  if (!pack) return undefined;
  return { name: pack.name, counts: pack.counts, total: pack.sounds.length };
}

/** What is wrong with one text, against the pack. Empty means nothing countable is wrong. */
export function checkTextAgainstPack(text: string, facts: PackFacts): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const flag = (msg: string) => {
    if (!seen.has(msg)) {
      seen.add(msg);
      problems.push(msg);
    }
  };
  for (const { re, kind, count } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const k = m[kind]!.toLowerCase();
      const said = Number(m[count]);
      const real = facts.counts[k];
      if (real === undefined) flag(`"${m[0].trim()}": the pack has no "${k}" sounds`);
      else if (said !== real) flag(`"${m[0].trim()}": the pack has ${real} ${k}, not ${said}`);
    }
  }
  for (const m of text.matchAll(/\b(\d+)[-\s]sounds?\b/gi)) {
    if (Number(m[1]) !== facts.total) flag(`"${m[0]}": the pack has ${facts.total} sounds, not ${m[1]}`);
  }
  // The artist name: the stylized lambda is only styling; searchable text uses plain ISARK.
  if (/(^|[^A-Za-z/@.])isark(?![A-Za-z]|\.[a-z])/.test(text)) flag('"isark" in lowercase: write ISARK');
  if (/\bsalient\b/.test(text) && facts.name.toLowerCase() === "salient") flag('"salient" in lowercase: the pack name is written Salient');
  return problems;
}

/** Checks the notes an agent wrote or changed since `since` (an ISO time). Returns {note, problems} for the ones with problems. */
export async function checkAgentNotesSince(agentId: string, since: string): Promise<{ note: string; problems: string[] }[]> {
  const facts = await latestPackFacts();
  if (!facts) return [];
  const overlay = await loadOverlay();
  const out: { note: string; problems: string[] }[] = [];
  for (const n of overlay.notes) {
    if (!Array.isArray(n.tags) || !(n.tags as string[]).includes(agentId)) continue;
    if (String(n.updated ?? n.created ?? "") < since) continue;
    const problems = checkTextAgainstPack(`${String(n.title ?? "")}\n${String(n.body ?? "")}`, facts);
    if (problems.length) out.push({ note: String(n.title ?? n.id), problems });
  }
  return out;
}
