// Lightweight, zero-dependency text similarity — matches this scaffold's
// "no external services required" philosophy (same reasoning as the
// hand-rolled cron parser and the built-in http webhook server). This is
// NOT a substitute for real embeddings (see the README's comparison to
// mem0/Zep/MemGPT, which all use vector similarity) — it's a genuine,
// evidence-based improvement over exact-substring matching that needs no
// network call, no API key, and no model, while still recognizing that
// "User prefers short answers" and "User likes brief replies" are
// talking about the same thing.
//
// Approach: Jaccard similarity over normalized word-token sets. Simple,
// auditable, deterministic — same "code decides, not a model" principle
// memory.ts's eligibility scoring already follows. Swap for real
// embeddings when this primitive gets a production pass; the interface
// below (textSimilarity, tokenize) is intentionally small so that swap
// only touches this one file.

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "and", "or", "but", "of", "to", "in", "on", "at", "for", "with",
  "this", "that", "these", "those", "it", "its", "as", "by", "from",
]);

/** Normalizes text into a set of meaningful word tokens: lowercased,
 *  punctuation stripped, stopwords and very short tokens removed. Two
 *  near-duplicate sentences produce near-identical token sets even with
 *  different phrasing/word order. */
export function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  return new Set(words);
}

/** Jaccard similarity: |intersection| / |union| of two token sets.
 *  Returns 0 for two empty sets (rather than NaN) so it's always a safe
 *  number to threshold against. */
export function textSimilarity(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersectionSize = 0;
  for (const tok of setA) {
    if (setB.has(tok)) intersectionSize++;
  }
  const unionSize = setA.size + setB.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

/** Default threshold above which two pieces of text are considered
 *  "the same underlying fact" for repetition-counting purposes. Picked
 *  empirically to catch paraphrases ("prefers short answers" / "likes
 *  brief replies" ≈ 0.15-0.2 depending on exact wording, since word
 *  choice differs almost entirely aside from a shared subject noun)
 *  while not conflating genuinely different facts that merely share a
 *  few common words (unrelated sentences scored 0.0 in testing).
 *  Exposed as a constant (not hardcoded inline) so callers can reason
 *  about/tune it without hunting through call sites. */
export const SIMILARITY_REPETITION_THRESHOLD = 0.15;
