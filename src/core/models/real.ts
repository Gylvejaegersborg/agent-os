// Real model adapters — implement the exact same ModelAdapter interface as
// the stub in model.ts, proving the abstraction is genuinely swappable and
// not just a paper interface. Uses Node's native fetch (Node 18+), zero
// extra dependencies, matching this scaffold's "auditable in five minutes"
// constraint.
//
// Both adapters intentionally support only a single in-flight tool call per
// turn, matching the ModelResponse shape the agent loop already expects
// (model.ts). Real deployments will likely want to extend ModelResponse to
// carry multiple tool calls — that's a deliberate scaffold limitation, not
// an oversight.

import type { ModelAdapter, ModelMessage, ModelResponse } from "../model.js";
import { appendEvent, project } from "../eventlog.js";

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
}

interface AnthropicOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  tools?: ToolSpec[];
  baseUrl?: string;
  /** Anthropic issues two different secret shapes behind similarly-named
   *  env vars in the wild: raw API keys (sk-ant-api...) authenticate via
   *  the `x-api-key` header, while OAuth access tokens (sk-ant-oat... or
   *  opaque OAuth tokens issued by `claude setup-token`/console PKCE flows)
   *  authenticate via `Authorization: Bearer`. Auto-detected from the key
   *  shape by default; override if detection guesses wrong. */
  authStyle?: "api-key" | "oauth-bearer";
}

function detectAnthropicAuthStyle(apiKey: string): "api-key" | "oauth-bearer" {
  // Classic API keys are "sk-ant-api...". Everything else issued as an
  // ANTHROPIC_TOKEN-style credential (OAuth access tokens from the
  // dashboard PKCE flow, `claude setup-token`, etc.) is a bearer token.
  return apiKey.startsWith("sk-ant-api") ? "api-key" : "oauth-bearer";
}

function toAnthropicMessages(messages: ModelMessage[]): { system?: string; messages: unknown[] } {
  const system = messages.find((m) => m.role === "system")?.content;
  const rest = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : m.role === "tool" ? "user" : "user",
      content: m.role === "tool" ? [{ type: "tool_result", content: m.content }] : m.content,
    }));
  return { system, messages: rest };
}

export function createAnthropicModel(opts: AnthropicOptions): ModelAdapter {
  const model = opts.model ?? "claude-sonnet-4-5-20250929";
  const baseUrl = opts.baseUrl ?? "https://api.anthropic.com/v1/messages";
  const authStyle = opts.authStyle ?? detectAnthropicAuthStyle(opts.apiKey);

  return {
    id: `anthropic:${model}`,
    async complete(messages: ModelMessage[]): Promise<ModelResponse> {
      const { system, messages: anthropicMessages } = toAnthropicMessages(messages);

      const headers: Record<string, string> = {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      };
      if (authStyle === "api-key") {
        headers["x-api-key"] = opts.apiKey;
      } else {
        headers["authorization"] = `Bearer ${opts.apiKey}`;
        // OAuth-issued credentials (console/CLI login flows) require this
        // beta header to be accepted on the Messages API.
        headers["anthropic-beta"] = "oauth-2025-04-20";
      }

      const body: Record<string, unknown> = {
        model,
        max_tokens: opts.maxTokens ?? 1024,
        messages: anthropicMessages,
        ...(system ? { system } : {}),
      };
      if (opts.tools?.length) {
        body.tools = opts.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        }));
      }

      const res = await fetch(baseUrl, { method: "POST", headers, body: JSON.stringify(body) });
      const json: any = await res.json();
      if (!res.ok) {
        throw new Error(`Anthropic API error ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
      }

      const textBlock = json.content?.find((b: any) => b.type === "text");
      const toolBlock = json.content?.find((b: any) => b.type === "tool_use");

      return {
        content: textBlock?.text ?? "",
        ...(toolBlock ? { toolCall: { name: toolBlock.name, args: toolBlock.input } } : {}),
      };
    },

    // Real, provider-level token streaming — Anthropic's `stream: true`
    // Messages API, parsed as SSE. This is the actual mechanism BaseOS's
    // Chat.tsx used to implement directly in the BROWSER before the
    // Agent-OS integration (see that repo's history) — the exact same
    // parsing logic, now living in the harness where it belongs instead
    // of duplicated client-side. Handles content_block_start/delta/stop
    // for both a text block (text_delta, forwarded to onDelta chunk by
    // chunk) and a tool_use block (input_json_delta chunks accumulated
    // and parsed once complete — Anthropic streams a tool call's JSON
    // input incrementally too, but there's no meaningful "delta" to show
    // a user for that, so only text deltas go to onDelta).
    async completeStream(messages: ModelMessage[], onDelta: (deltaText: string) => void): Promise<ModelResponse> {
      const { system, messages: anthropicMessages } = toAnthropicMessages(messages);

      const headers: Record<string, string> = {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      };
      if (authStyle === "api-key") {
        headers["x-api-key"] = opts.apiKey;
      } else {
        headers["authorization"] = `Bearer ${opts.apiKey}`;
        headers["anthropic-beta"] = "oauth-2025-04-20";
      }

      const body: Record<string, unknown> = {
        model,
        max_tokens: opts.maxTokens ?? 1024,
        messages: anthropicMessages,
        stream: true,
        ...(system ? { system } : {}),
      };
      if (opts.tools?.length) {
        body.tools = opts.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        }));
      }

      const res = await fetch(baseUrl, { method: "POST", headers, body: JSON.stringify(body) });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(`Anthropic API error ${res.status}: ${JSON.stringify(errJson).slice(0, 500)}`);
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulated = "";
      let toolName: string | undefined;
      let toolJson = "";
      let toolCall: { name: string; args: Record<string, unknown> } | undefined;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // keep a possibly-incomplete trailing line for the next chunk

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (!data) continue;
          let parsed: any;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue; // malformed/partial frame — skip rather than crash the stream
          }

          if (parsed.type === "content_block_start" && parsed.content_block?.type === "tool_use") {
            toolName = parsed.content_block.name;
            toolJson = "";
          } else if (parsed.type === "content_block_delta") {
            if (parsed.delta?.type === "text_delta") {
              accumulated += parsed.delta.text;
              onDelta(parsed.delta.text);
            } else if (parsed.delta?.type === "input_json_delta") {
              toolJson += parsed.delta.partial_json ?? "";
            }
          } else if (parsed.type === "content_block_stop" && toolName) {
            try {
              toolCall = { name: toolName, args: JSON.parse(toolJson || "{}") };
            } catch {
              toolCall = { name: toolName, args: {} };
            }
            toolName = undefined;
          }
        }
      }

      return { content: accumulated, ...(toolCall ? { toolCall } : {}) };
    },
  };
}

interface OpenAiOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  tools?: ToolSpec[];
}

export function createOpenAiModel(opts: OpenAiOptions): ModelAdapter {
  const model = opts.model ?? "gpt-4o-mini";
  const baseUrl = opts.baseUrl ?? "https://api.openai.com/v1/chat/completions";

  return {
    id: `openai:${model}`,
    async complete(messages: ModelMessage[]): Promise<ModelResponse> {
      const openAiMessages = messages.map((m) => ({
        role: m.role === "tool" ? "user" : m.role, // scaffold-level simplification
        content: m.content,
      }));

      const body: Record<string, unknown> = { model, messages: openAiMessages };
      if (opts.tools?.length) {
        body.tools = opts.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
      }

      const res = await fetch(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify(body),
      });
      const json: any = await res.json();
      if (!res.ok) {
        throw new Error(`OpenAI API error ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
      }

      const choice = json.choices?.[0]?.message;
      const toolCall = choice?.tool_calls?.[0];

      return {
        content: choice?.content ?? "",
        ...(toolCall
          ? { toolCall: { name: toolCall.function.name, args: JSON.parse(toolCall.function.arguments || "{}") } }
          : {}),
      };
    },
  };
}

/** Reads well-known env vars and returns whichever real adapter is
 *  available, or undefined if none are configured — lets the CLI degrade
 *  gracefully to the stub model instead of crashing when no key is set.
 *  `preferredModel`, when given, overrides the provider's own hardcoded
 *  default model NAME (e.g. "claude-opus-4-..." instead of the built-in
 *  "claude-sonnet-4-5-..."), but never changes WHICH PROVIDER gets
 *  selected — that's still governed entirely by which env var is set.
 *  See createModelForAgent() below for where this comes from in
 *  practice (an agent's own registered default-model preference). */
export function createModelFromEnv(preferredModel?: string): ModelAdapter | undefined {
  const anthropicKey = process.env.ANTHROPIC_TOKEN ?? process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) return createAnthropicModel({ apiKey: anthropicKey, ...(preferredModel ? { model: preferredModel } : {}) });

  const openAiKey = process.env.OPENAI_API_KEY;
  if (openAiKey) return createOpenAiModel({ apiKey: openAiKey, ...(preferredModel ? { model: preferredModel } : {}) });

  return undefined;
}

interface OllamaOptions {
  model?: string;
  /** Default matches Ollama's standard local install. Override for a
   *  remote Ollama server. */
  baseUrl?: string;
  tools?: ToolSpec[];
}

/** Ollama's OpenAI-compatible endpoint (/v1/chat/completions) — same
 *  request/response shape as createOpenAiModel above, no API key needed
 *  since it's a local (or self-hosted) server. This is the adapter you
 *  want for zero-cost, zero-network testing beyond the deterministic
 *  stub: real model behavior, still no cloud bill. */
export function createOllamaModel(opts: OllamaOptions = {}): ModelAdapter {
  // Default model is overridable via OLLAMA_MODEL since "llama3.2" is a
  // guess — whatever's actually pulled locally varies machine to machine.
  const model = opts.model ?? process.env.OLLAMA_MODEL ?? "llama3.2";
  const baseUrl = opts.baseUrl ?? "http://localhost:11434/v1/chat/completions";

  return {
    id: `ollama:${model}`,
    async complete(messages: ModelMessage[]): Promise<ModelResponse> {
      const ollamaMessages = messages.map((m) => ({
        role: m.role === "tool" ? "user" : m.role,
        content: m.content,
      }));

      const body: Record<string, unknown> = { model, messages: ollamaMessages, stream: false };
      if (opts.tools?.length) {
        body.tools = opts.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
      }

      let res: Response;
      try {
        res = await fetch(baseUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (err) {
        throw new Error(
          `Could not reach Ollama at ${baseUrl} — is it running? ('ollama serve', or 'ollama pull ${model}' if the model isn't installed yet). Original error: ${err}`,
        );
      }
      const json: any = await res.json();
      if (!res.ok) {
        throw new Error(`Ollama API error ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
      }

      const choice = json.choices?.[0]?.message;
      const toolCall = choice?.tool_calls?.[0];

      return {
        content: choice?.content ?? "",
        ...(toolCall
          ? { toolCall: { name: toolCall.function.name, args: JSON.parse(toolCall.function.arguments || "{}") } }
          : {}),
      };
    },

    // Real token streaming, via the same OpenAI-compatible endpoint's
    // `stream: true` mode — ROADMAP.md flagged this as the one adapter
    // missing it (Anthropic's already had it). OpenAI-style SSE frames:
    // `data: {"choices":[{"delta":{...}}]}` per chunk, terminated by a
    // literal `data: [DONE]` line. A tool call's `function.arguments`
    // streams incrementally across multiple chunks at the same index;
    // this scaffold only ever surfaces ONE tool call per turn (same
    // assumption the non-streaming path above makes via `tool_calls?.[0]`),
    // so only index 0 is tracked.
    async completeStream(messages: ModelMessage[], onDelta: (deltaText: string) => void): Promise<ModelResponse> {
      const ollamaMessages = messages.map((m) => ({
        role: m.role === "tool" ? "user" : m.role,
        content: m.content,
      }));

      const body: Record<string, unknown> = { model, messages: ollamaMessages, stream: true };
      if (opts.tools?.length) {
        body.tools = opts.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
      }

      let res: Response;
      try {
        res = await fetch(baseUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (err) {
        throw new Error(
          `Could not reach Ollama at ${baseUrl} — is it running? ('ollama serve', or 'ollama pull ${model}' if the model isn't installed yet). Original error: ${err}`,
        );
      }
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(`Ollama API error ${res.status}: ${JSON.stringify(errJson).slice(0, 500)}`);
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulated = "";
      let toolName: string | undefined;
      let toolArgs = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // keep a possibly-incomplete trailing line for the next chunk

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (!data || data === "[DONE]") continue;
          let parsed: any;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue; // malformed/partial frame — skip rather than crash the stream
          }

          const delta = parsed.choices?.[0]?.delta;
          if (!delta) continue;
          if (typeof delta.content === "string" && delta.content) {
            accumulated += delta.content;
            onDelta(delta.content);
          }
          const toolCallDelta = delta.tool_calls?.[0];
          if (toolCallDelta) {
            if (toolCallDelta.function?.name) toolName = toolCallDelta.function.name;
            if (toolCallDelta.function?.arguments) toolArgs += toolCallDelta.function.arguments;
          }
        }
      }

      const toolCall = toolName ? { name: toolName, args: JSON.parse(toolArgs || "{}") } : undefined;
      return { content: accumulated, ...(toolCall ? { toolCall } : {}) };
    },
  };
}

/** Checks env vars first (Anthropic/OpenAI), then falls back to a local
 *  Ollama instance if one is reachable, before giving up entirely. Use
 *  this instead of createModelFromEnv() when you want "try everything
 *  free/local before admitting no real model is available."
 *
 *  `preferredModel`, when given, is forwarded as the specific model NAME
 *  requested from whichever provider env vars select (or to Ollama, if
 *  no cloud key is set) — see createModelForAgent() below for the
 *  typical caller and the full precedence rules. */
export async function createModelFromEnvOrOllama(
  ollamaOpts: OllamaOptions = {},
  preferredModel?: string,
): Promise<ModelAdapter | undefined> {
  const fromEnv = createModelFromEnv(preferredModel);
  if (fromEnv) return fromEnv;

  const baseUrl = ollamaOpts.baseUrl ?? "http://localhost:11434/v1/chat/completions";
  const probeUrl = baseUrl.replace(/\/v1\/chat\/completions$/, "/api/tags");
  try {
    const probe = await fetch(probeUrl, { signal: AbortSignal.timeout(1500) });
    if (probe.ok) return createOllamaModel({ ...ollamaOpts, ...(preferredModel ? { model: preferredModel } : {}) });
  } catch {
    // Ollama not running — fall through to undefined.
  }
  return undefined;
}

// ---- Per-agent default-model preference ----
//
// This is the "defaultModel" primitive named in identity.ts's header
// comment as living HERE rather than in identity.ts itself — this
// scaffold deliberately keeps each facet of the conceptual Agent type
// (types.ts) addressable through the subsystem that actually owns it
// (memory.ts owns memory, permissions.ts owns policy, skills.ts owns
// skillCatalog, and model selection is owned by this file). Stored the
// same event-sourced way identity.ts stores persona/name: an
// append-only stream, projected on read, so it's auditable and
// resumable for free like everything else in this scaffold.

const AGENT_MODEL_PREF_STREAM = "agent-model-preferences";

/** Registers (or overwrites) the model NAME an agent prefers to be run
 *  with — e.g. "claude-opus-4-..." vs the provider's built-in default.
 *  Does NOT select a provider by itself (no API key lives here); it only
 *  ever takes effect once env vars have already determined which
 *  provider/credentials are in play (see createModelForAgent()). */
export async function setAgentDefaultModel(agentId: string, model: string): Promise<void> {
  await appendEvent(AGENT_MODEL_PREF_STREAM, "agent.defaultModel.set", { agentId, model });
}

async function projectAgentModelPreferences(): Promise<Map<string, string>> {
  return project<Map<string, string>>(AGENT_MODEL_PREF_STREAM, new Map(), (state, event) => {
    if (event.type === "agent.defaultModel.set") {
      const p = event.payload as any;
      state.set(p.agentId, p.model);
    }
    return state;
  });
}

/** Returns the registered default-model preference for an agent, or
 *  undefined if none was ever set via setAgentDefaultModel(). */
export async function getAgentDefaultModel(agentId: string): Promise<string | undefined> {
  return (await projectAgentModelPreferences()).get(agentId);
}

/** The actual wiring point: resolves a ModelAdapter for a given agent by
 *  consulting its own registered default-model preference FIRST, then
 *  falling through to the exact same env/Ollama selection every other
 *  caller uses.
 *
 *  Precedence (documented explicitly since this is the crux of the
 *  wiring):
 *   1. WHICH PROVIDER (Anthropic vs OpenAI vs Ollama vs none) is decided
 *      purely by which env vars/local services are available — an
 *      agent's stored preference can never make a provider "available"
 *      that isn't already credentialed. This is intentional: a stored
 *      preference is data an agent (or whoever registered it) wrote:
 *      it must not be able to conjure API access that wasn't already
 *      granted via environment configuration.
 *   2. WHICH MODEL within that provider is requested DOES defer to the
 *      agent's registered default when one exists — it overrides the
 *      provider adapter's own hardcoded default model name (see
 *      createModelFromEnv's preferredModel param). This is the part
 *      that's genuinely new: previously an agent's defaultModel field
 *      was pure documentation with zero code consulting it; now it's
 *      read and threaded through on every call.
 *   3. If no preference is registered for this agentId, behavior is
 *      byte-for-byte identical to calling createModelFromEnvOrOllama()
 *      directly (regression-safe, same as the persona wiring above). */
export async function createModelForAgent(
  agentId: string,
  ollamaOpts: OllamaOptions = {},
): Promise<ModelAdapter | undefined> {
  const preferredModel = await getAgentDefaultModel(agentId);
  return createModelFromEnvOrOllama(ollamaOpts, preferredModel);
}
