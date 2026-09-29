// Hindsight (github.com/vectorize-io/hindsight, MIT) as an OPTIONAL second
// memory layer next to memory.ts's own episodic → dreaming → curated
// pipeline. Hindsight runs as its own service (one Docker container with
// an embedded Postgres; it needs an LLM key of its own for fact
// extraction) and exposes retain / recall / reflect over HTTP.
//
// Opt-in and failure-tolerant by design:
//   - Nothing here does anything unless HINDSIGHT_URL is set.
//   - Every call has a short timeout and swallows errors (logged once per
//     kind), so a down or slow Hindsight never breaks or stalls a turn —
//     the built-in memory keeps working exactly as before.
//   - Plain fetch against the REST API (the same endpoints the official
//     @vectorize-io/hindsight-client wraps), keeping this scaffold free of
//     runtime dependencies.
//
// One memory bank per agent: `${HINDSIGHT_BANK_PREFIX}-${agentId}`
// (prefix defaults to "agent-os"). Each bank is created by Hindsight on
// first write.
//
// Env:
//   HINDSIGHT_URL          e.g. http://127.0.0.1:8888 — enables everything below
//   HINDSIGHT_API_KEY      optional, sent as a Bearer token
//   HINDSIGHT_BANK_PREFIX  optional bank-name prefix (default "agent-os")
//   HINDSIGHT_RECALL_TOKENS optional recall budget in tokens (default 600)

const warned = new Set<string>();
/** A bank is created by an agent's first retain, so reading an agent that
 *  hasn't remembered anything yet is a 404 — an empty memory, not a failure.
 *  It must not count as one: the warning below fires once per kind, and a
 *  harmless "new agent" 404 used it up and hid a real outage afterwards. */
function isMissingBank(err: unknown): boolean {
  // Only "Bank '…' not found": a 404 from a wrong URL ("Not Found") is a real
  // misconfiguration and still warns.
  return err instanceof Error && /^HTTP 404\b.*\bBank\b.*\bnot found\b/i.test(err.message);
}
function warnOnce(kind: string, err: unknown): void {
  if (isMissingBank(err)) return;
  if (warned.has(kind)) return;
  warned.add(kind);
  console.warn(`[hindsight] ${kind} failed (further ${kind} errors are silenced): ${err instanceof Error ? err.message : String(err)}`);
}

export function hindsightConfigured(): boolean {
  return Boolean(process.env.HINDSIGHT_URL);
}

export function hindsightBank(agentId: string): string {
  const prefix = process.env.HINDSIGHT_BANK_PREFIX ?? "agent-os";
  return `${prefix}-${agentId}`.replace(/[^a-zA-Z0-9_-]/g, "-");
}

async function call<T>(method: "POST" | "GET", pathTail: string, agentId: string, body: unknown, timeoutMs: number): Promise<T> {
  const base = process.env.HINDSIGHT_URL!.replace(/\/$/, "");
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (process.env.HINDSIGHT_API_KEY) headers.authorization = `Bearer ${process.env.HINDSIGHT_API_KEY}`;
  const res = await fetch(`${base}/v1/default/banks/${encodeURIComponent(hindsightBank(agentId))}${pathTail}`, {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

/** Stores something in the agent's bank. Asynchronous on Hindsight's side
 *  (fact extraction runs in the background), so this returns quickly.
 *  Never throws. */
export async function hindsightRetain(
  agentId: string,
  content: string,
  opts: { context?: string; tags?: string[]; timestamp?: string } = {},
): Promise<boolean> {
  if (!hindsightConfigured() || !content.trim()) return false;
  try {
    await call("POST", "/memories", agentId, {
      items: [{ content, context: opts.context, tags: opts.tags, timestamp: opts.timestamp ?? new Date().toISOString() }],
      async: true,
    }, 5000);
    return true;
  } catch (err) {
    warnOnce("retain", err);
    return false;
  }
}

/** The memories most relevant to `query`, as plain lines. Empty on any
 *  failure. */
export async function hindsightRecall(agentId: string, query: string): Promise<string[]> {
  if (!hindsightConfigured() || !query.trim()) return [];
  try {
    const maxTokens = Number(process.env.HINDSIGHT_RECALL_TOKENS ?? 600);
    const res = await call<{ results?: { text: string }[] }>("POST", "/memories/recall", agentId, { query, max_tokens: maxTokens, budget: "low" }, 4000);
    return (res.results ?? []).map((r) => r.text.trim()).filter(Boolean);
  } catch (err) {
    warnOnce("recall", err);
    return [];
  }
}

/** A reasoned answer over everything in the agent's bank (slower — uses
 *  Hindsight's own LLM). Undefined on failure. */
export async function hindsightReflect(agentId: string, query: string, context?: string): Promise<string | undefined> {
  if (!hindsightConfigured() || !query.trim()) return undefined;
  try {
    const res = await call<{ text?: string }>("POST", "/reflect", agentId, { query, context, budget: "low" }, 60_000);
    return res.text?.trim() || undefined;
  } catch (err) {
    warnOnce("reflect", err);
    return undefined;
  }
}
