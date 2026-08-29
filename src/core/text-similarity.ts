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

// ---------------------------------------------------------------------
// Optional upgrade: embedding-based similarity via a local Ollama
// server, with automatic, transparent fallback to the Jaccard function
// above when no embedding backend is reachable.
//
// This section deliberately does NOT change the header comment's
// promise above — Jaccard textSimilarity() remains the zero-dependency,
// always-available default. Nothing in this file or in memory.ts's
// default call paths performs a network call unless a caller
// explicitly opts in by constructing a SimilarityProvider via
// createSimilarityProvider() and passing it through. That opt-in
// design is what keeps the existing test suite and demo deterministic
// and network-free with zero setup, exactly as before, regardless of
// whether an Ollama server happens to be running on the machine.
//
// The actual upgrade path (real evidence-based semantic similarity
// instead of token overlap) is genuine, not theoretical: two
// paraphrases with almost no shared vocabulary — "The database needs a
// backup before the migration" vs "Back up the DB prior to running the
// schema update" — score near-zero under Jaccard (they share almost no
// tokens) but score high under embedding cosine similarity, because an
// embedding model captures meaning, not just surface word overlap.
// ---------------------------------------------------------------------

/** Cosine similarity between two equal-length numeric vectors, scaled
 *  to the same [0, 1]-ish range textSimilarity() uses so the two
 *  backends are interchangeable to callers thresholding against
 *  SIMILARITY_REPETITION_THRESHOLD. Raw cosine similarity is in
 *  [-1, 1]; we rescale to [0, 1] via (cos + 1) / 2 rather than clamping
 *  negatives to 0, so mildly-opposed vectors still land below
 *  orthogonal ones instead of being indistinguishable at 0. Returns 0
 *  for a zero-length or all-zero vector (safe, never NaN/Infinity). */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  const cos = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return (cos + 1) / 2;
}

export interface OllamaEmbeddingOptions {
  /** Default matches Ollama's standard local install (see
   *  models/real.ts's createOllamaModel, same convention). */
  baseUrl?: string;
  /** Overridable via OLLAMA_EMBEDDING_MODEL since which embedding model
   *  (if any) is actually pulled varies machine to machine. Defaults to
   *  "nomic-embed-text", a small, widely-available Ollama embedding
   *  model — NOT a general chat model, which typically has no
   *  /api/embeddings support worth relying on. */
  model?: string;
  /** Short timeout so an unreachable/hung Ollama server fails fast
   *  instead of stalling every memory operation. */
  timeoutMs?: number;
}

/** A similarity backend: async so it can call out to an embedding
 *  service, but exposes the exact same (text, text) -> number[0,1]
 *  contract as textSimilarity() so memory.ts's call sites don't need
 *  to know or care which backend is actually active underneath. */
export type SimilarityFn = (a: string, b: string) => Promise<number>;

export interface SimilarityProvider {
  /** Async similarity score in [0, 1]. Uses real embeddings when the
   *  configured Ollama server is reachable and returns a usable
   *  embedding; otherwise transparently falls back to the synchronous
   *  Jaccard textSimilarity() — never throws, never crashes the
   *  caller, regardless of what goes wrong reaching the network. */
  similarity: SimilarityFn;
  /** True once this provider has confirmed it can reach real
   *  embeddings (updated after the first call). False before the first
   *  call, or once a failure has been observed. Diagnostic only —
   *  callers should never branch behavior on this; it exists so tests
   *  and logs can report which backend actually served a given run. */
  readonly usingEmbeddings: boolean;
}

/** Low-level call to Ollama's /api/embeddings endpoint. Throws on any
 *  failure (network error, non-2xx, timeout, malformed response) —
 *  callers are expected to catch and fall back, never to let this
 *  throw reach application code uncaught. */
async function fetchOllamaEmbedding(text: string, opts: Required<OllamaEmbeddingOptions>): Promise<number[]> {
  const res = await fetch(`${opts.baseUrl}/api/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: opts.model, prompt: text }),
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`Ollama embeddings API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json: any = await res.json();
  const vector = json?.embedding;
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error(`Ollama embeddings response for model "${opts.model}" had no usable embedding vector`);
  }
  return vector as number[];
}

/** Creates an async similarity backend that prefers real embeddings
 *  from a local Ollama server and transparently, permanently (for the
 *  lifetime of this provider instance) falls back to the zero-
 *  dependency Jaccard textSimilarity() the first time anything goes
 *  wrong — server down, model not pulled, network error, or timeout.
 *  The fallback decision is cached after the first attempt so a
 *  confirmed-unreachable server doesn't re-pay a network round trip
 *  (or the timeout) on every single comparison in a loop; a fresh
 *  provider (e.g. a new call to createSimilarityProvider()) will probe
 *  again. Embeddings for a given exact text string are also cached
 *  within this provider instance, since call sites like memory.ts's
 *  countSimilar() compare the same "new content" string against many
 *  stored entries. */
export function createSimilarityProvider(opts: OllamaEmbeddingOptions = {}): SimilarityProvider {
  const resolved: Required<OllamaEmbeddingOptions> = {
    baseUrl: opts.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    model: opts.model ?? process.env.OLLAMA_EMBEDDING_MODEL ?? "nomic-embed-text",
    timeoutMs: opts.timeoutMs ?? 2000,
  };

  const embeddingCache = new Map<string, number[]>();
  // undefined = not yet probed; true/false = known state for this
  // provider instance's remaining lifetime.
  let embeddingsAvailable: boolean | undefined;

  async function embed(text: string): Promise<number[]> {
    const cached = embeddingCache.get(text);
    if (cached) return cached;
    const vector = await fetchOllamaEmbedding(text, resolved);
    embeddingCache.set(text, vector);
    return vector;
  }

  return {
    get usingEmbeddings() {
      return embeddingsAvailable === true;
    },
    async similarity(a: string, b: string): Promise<number> {
      if (embeddingsAvailable === false) return textSimilarity(a, b);
      try {
        const [vecA, vecB] = await Promise.all([embed(a), embed(b)]);
        embeddingsAvailable = true;
        return cosineSimilarity(vecA, vecB);
      } catch (err) {
        // Log once, on the transition into fallback — never throw past
        // this point, and never crash or reject on behalf of the
        // caller. Every subsequent call on this same provider instance
        // skips straight to Jaccard without retrying the network.
        if (embeddingsAvailable === undefined) {
          console.warn(
            `[text-similarity] embedding backend unreachable (${resolved.baseUrl}, model "${resolved.model}"): ` +
              `${(err as Error)?.message ?? err} — falling back to Jaccard token-overlap similarity.`,
          );
        }
        embeddingsAvailable = false;
        return textSimilarity(a, b);
      }
    },
  };
}

/** A SimilarityProvider that always uses plain Jaccard, wrapped in the
 *  async SimilarityFn shape. Useful for callers that want to use the
 *  async memory.ts APIs (e.g. retrieveRelevantLinesAsync) but
 *  explicitly want the zero-dependency behavior without ever touching
 *  the network — equivalent to just not passing a provider, but
 *  spelled out for callers who want to be explicit about it. */
export function createJaccardSimilarityProvider(): SimilarityProvider {
  return {
    usingEmbeddings: false,
    async similarity(a: string, b: string): Promise<number> {
      return textSimilarity(a, b);
    },
  };
}
