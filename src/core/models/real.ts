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

import { listToolDefinitions, toToolSpec } from "../tool-registry.js";
import type { ModelAdapter, ModelCallOptions, ModelMessage, ModelResponse, ToolSpec } from "../model.js";
import { appendEvent, project } from "../eventlog.js";
import { claudeCliAvailable, createClaudeCliModel } from "./claude-cli.js";

export type { ToolSpec } from "../model.js";

/** Every tool in the registry (tool-registry.ts), as the JSON-Schema specs
 *  the provider APIs take. Used whenever an adapter isn't given an explicit
 *  `tools` list — before this, the gateway created its adapters without
 *  one, so real models were never told any tool existed and every tool
 *  call path only ran against the stub model. Read at call time, so tools
 *  registered after the adapter was created are included. */
export function registryToolSpecs(): ToolSpec[] {
  return listToolDefinitions().map(toToolSpec);
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
  // Tool results go back as plain user text: the session history doesn't
  // keep the model's tool_use blocks, and a tool_result block without its
  // matching tool_use id is rejected by the API (400). Consecutive
  // same-role messages are merged so roles always alternate.
  const rest: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    const content = m.role === "tool" ? `Tool result:\n${m.content}` : m.content;
    const last = rest[rest.length - 1];
    if (last && last.role === role) last.content += `\n\n${content}`;
    else rest.push({ role, content });
  }
  if (rest[0]?.role === "assistant") rest.unshift({ role: "user", content: "(conversation continues)" });
  return { system, messages: rest };
}

export function createAnthropicModel(opts: AnthropicOptions): ModelAdapter {
  const model = opts.model ?? "claude-sonnet-4-5-20250929";
  const baseUrl = opts.baseUrl ?? "https://api.anthropic.com/v1/messages";
  const authStyle = opts.authStyle ?? detectAnthropicAuthStyle(opts.apiKey);

  return {
    id: `anthropic:${model}`,
    async complete(messages: ModelMessage[], callOpts?: ModelCallOptions): Promise<ModelResponse> {
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
      const tools = callOpts?.tools ?? opts.tools ?? registryToolSpecs();
      if (tools.length) {
        body.tools = tools.map((t) => ({
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
      const usage = json.usage
        ? { inputTokens: json.usage.input_tokens ?? 0, outputTokens: json.usage.output_tokens ?? 0 }
        : undefined;

      return {
        content: textBlock?.text ?? "",
        ...(toolBlock ? { toolCall: { name: toolBlock.name, args: toolBlock.input } } : {}),
        ...(usage ? { usage } : {}),
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
    async completeStream(messages: ModelMessage[], onDelta: (deltaText: string) => void, callOpts?: ModelCallOptions): Promise<ModelResponse> {
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
      const tools = callOpts?.tools ?? opts.tools ?? registryToolSpecs();
      if (tools.length) {
        body.tools = tools.map((t) => ({
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
      // Anthropic splits usage across two event types: input_tokens
      // arrives once, up front, on message_start; output_tokens is
      // cumulative and updates on each message_delta (the LAST one
      // received is the final total — not a delta to sum).
      let inputTokens = 0;
      let outputTokens = 0;

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

          if (parsed.type === "message_start") {
            inputTokens = parsed.message?.usage?.input_tokens ?? 0;
          } else if (parsed.type === "content_block_start" && parsed.content_block?.type === "tool_use") {
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
          } else if (parsed.type === "message_delta") {
            if (typeof parsed.usage?.output_tokens === "number") outputTokens = parsed.usage.output_tokens;
          }
        }
      }

      const usage = inputTokens || outputTokens ? { inputTokens, outputTokens } : undefined;
      return { content: accumulated, ...(toolCall ? { toolCall } : {}), ...(usage ? { usage } : {}) };
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
    async complete(messages: ModelMessage[], callOpts?: ModelCallOptions): Promise<ModelResponse> {
      const openAiMessages = messages.map((m) => ({
        role: m.role === "tool" ? "user" : m.role, // scaffold-level simplification
        content: m.content,
      }));

      const body: Record<string, unknown> = { model, messages: openAiMessages };
      const tools = callOpts?.tools ?? opts.tools ?? registryToolSpecs();
      if (tools.length) {
        body.tools = tools.map((t) => ({
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
      const usage = json.usage
        ? { inputTokens: json.usage.prompt_tokens ?? 0, outputTokens: json.usage.completion_tokens ?? 0 }
        : undefined;

      return {
        content: choice?.content ?? "",
        ...(toolCall
          ? { toolCall: { name: toolCall.function.name, args: JSON.parse(toolCall.function.arguments || "{}") } }
          : {}),
        ...(usage ? { usage } : {}),
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
  if (openAiKey) return createOpenAiModel({ apiKey: openAiKey, baseUrl: openAiBaseUrl(), ...(preferredModel ? { model: preferredModel } : {}) });

  return undefined;
}

/** OPENAI_BASE_URL points the OpenAI adapter at any OpenAI-compatible
 *  server (LM Studio, vLLM, llama.cpp's server, OpenRouter, ...). Accepts
 *  either the conventional ".../v1" form or the full chat-completions URL. */
function openAiBaseUrl(): string | undefined {
  const raw = process.env.OPENAI_BASE_URL?.trim().replace(/\/$/, "");
  if (!raw) return undefined;
  return raw.endsWith("/chat/completions") ? raw : `${raw}/chat/completions`;
}

interface OllamaOptions {
  model?: string;
  /** Default matches Ollama's standard local install. Override for a
   *  remote Ollama server. */
  baseUrl?: string;
  tools?: ToolSpec[];
}

/** Retries ONLY a connection-level failure (fetch() itself throwing —
 *  "ECONNREFUSED"/"fetch failed" — Ollama's server not accepting
 *  connections yet) a few times with a short delay, never an HTTP error
 *  RESPONSE (a real 4xx/5xx from a server that's actually up is not a
 *  "try again" situation). This exists specifically for the startup
 *  race start.sh's own readiness-polling loop doesn't fully close: that
 *  loop waits for Ollama's HTTP server to accept connections before the
 *  gateway even starts, but the model can still be mid-load into memory
 *  for a few more seconds after the server itself is already accepting
 *  connections — a turn that lands in that narrow window would
 *  otherwise surface a raw connection error to the user for something
 *  that resolves itself a couple seconds later. */
export async function fetchWithOllamaRetry(baseUrl: string, init: RequestInit, model: string, attempts = 3, delayMs = 1500): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fetch(baseUrl, init);
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(
    `Could not reach Ollama at ${baseUrl} after ${attempts} attempts — is it running? ('ollama serve', or 'ollama pull ${model}' if the model isn't installed yet). Original error: ${lastErr}`,
  );
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
    async complete(messages: ModelMessage[], callOpts?: ModelCallOptions): Promise<ModelResponse> {
      const ollamaMessages = messages.map((m) => ({
        role: m.role === "tool" ? "user" : m.role,
        content: m.content,
      }));

      const body: Record<string, unknown> = { model, messages: ollamaMessages, stream: false };
      const tools = callOpts?.tools ?? opts.tools ?? registryToolSpecs();
      if (tools.length) {
        body.tools = tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
      }

      const res = await fetchWithOllamaRetry(
        baseUrl,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
        model,
      );
      const json: any = await res.json();
      if (!res.ok) {
        throw new Error(`Ollama API error ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
      }

      const choice = json.choices?.[0]?.message;
      const toolCall = choice?.tool_calls?.[0];
      const usage = json.usage
        ? { inputTokens: json.usage.prompt_tokens ?? 0, outputTokens: json.usage.completion_tokens ?? 0 }
        : undefined;

      return {
        content: choice?.content ?? "",
        ...(toolCall
          ? { toolCall: { name: toolCall.function.name, args: JSON.parse(toolCall.function.arguments || "{}") } }
          : {}),
        ...(usage ? { usage } : {}),
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
    async completeStream(messages: ModelMessage[], onDelta: (deltaText: string) => void, callOpts?: ModelCallOptions): Promise<ModelResponse> {
      const ollamaMessages = messages.map((m) => ({
        role: m.role === "tool" ? "user" : m.role,
        content: m.content,
      }));

      const body: Record<string, unknown> = { model, messages: ollamaMessages, stream: true };
      const tools = callOpts?.tools ?? opts.tools ?? registryToolSpecs();
      if (tools.length) {
        body.tools = tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
      }

      const res = await fetchWithOllamaRetry(
        baseUrl,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
        model,
      );
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
      // Some OpenAI-compatible servers (Ollama included, when asked)
      // send a final chunk carrying ONLY `usage`, with no `delta` at
      // all — checked before the `!delta` guard below so that chunk
      // isn't skipped before its usage is read.
      let inputTokens = 0;
      let outputTokens = 0;

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

          if (parsed.usage) {
            inputTokens = parsed.usage.prompt_tokens ?? inputTokens;
            outputTokens = parsed.usage.completion_tokens ?? outputTokens;
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
      const usage = inputTokens || outputTokens ? { inputTokens, outputTokens } : undefined;
      return { content: accumulated, ...(toolCall ? { toolCall } : {}), ...(usage ? { usage } : {}) };
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
      if (p.model) state.set(p.agentId, p.model);
      else state.delete(p.agentId); // "" = back to the gateway default
    }
    return state;
  });
}

/** Returns the registered default-model preference for an agent, or
 *  undefined if none was ever set via setAgentDefaultModel(). */
export async function getAgentDefaultModel(agentId: string): Promise<string | undefined> {
  return (await projectAgentModelPreferences()).get(agentId);
}

// ---- Provider router ----
//
// An agent's model preference may name its provider: "claude-cli:sonnet",
// "ollama:llama3.2:3b", "anthropic:claude-sonnet-5", "openai:gpt-4o-mini".
// That lets agents on the same gateway run on different providers — e.g.
// Hemera on your Claude subscription through the Claude Code CLI while
// Nyx stays on a local Ollama model. A preference without a known prefix
// is a bare model NAME, handled exactly as before (Ollama names contain
// colons too, so only these four prefixes are treated as providers).
//
// The rule from before still holds: a stored preference can never make a
// provider available. Each provider is used only when the gateway process
// already has access to it (a key in its env, a reachable Ollama, an
// installed Claude CLI); otherwise the agent falls back to the default
// provider, with a one-time warning.

export const PROVIDERS = ["anthropic", "openai", "ollama", "claude-cli"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export interface ModelRef {
  provider?: ProviderName;
  model?: string;
}

export function parseModelRef(ref: string | undefined): ModelRef {
  const trimmed = ref?.trim();
  if (!trimmed) return {};
  for (const provider of PROVIDERS) {
    if (trimmed === provider) return { provider };
    if (trimmed.startsWith(`${provider}:`)) {
      const model = trimmed.slice(provider.length + 1).trim();
      return { provider, ...(model ? { model } : {}) };
    }
  }
  return { model: trimmed };
}

async function ollamaReachable(baseUrl: string): Promise<boolean> {
  const probeUrl = baseUrl.replace(/\/v1\/chat\/completions$/, "/api/tags");
  try {
    return (await fetch(probeUrl, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

/** Which providers this gateway process can actually use right now. */
export async function listProviders(ollamaOpts: OllamaOptions = {}): Promise<{ name: ProviderName; available: boolean; detail: string }[]> {
  const ollamaUrl = ollamaOpts.baseUrl ?? "http://localhost:11434/v1/chat/completions";
  return [
    {
      name: "anthropic",
      available: Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_TOKEN),
      detail: "Anthropic API — needs ANTHROPIC_API_KEY on the gateway",
    },
    {
      name: "openai",
      available: Boolean(process.env.OPENAI_API_KEY ?? process.env.OPENAI_BASE_URL),
      detail: process.env.OPENAI_BASE_URL ? `OpenAI-compatible server at ${process.env.OPENAI_BASE_URL}` : "OpenAI API — needs OPENAI_API_KEY (or OPENAI_BASE_URL for a compatible server)",
    },
    { name: "ollama", available: await ollamaReachable(ollamaUrl), detail: `Local Ollama at ${ollamaUrl.replace(/\/v1\/chat\/completions$/, "")}` },
    { name: "claude-cli", available: claudeCliAvailable(), detail: "Your Claude subscription through the installed Claude Code CLI (run `claude` once on the gateway machine and log in)" },
  ];
}

/** Builds the adapter for one explicit provider, or undefined when this
 *  gateway has no access to it. */
async function createModelForProvider(provider: ProviderName, model: string | undefined, ollamaOpts: OllamaOptions): Promise<ModelAdapter | undefined> {
  switch (provider) {
    case "anthropic": {
      const key = process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_TOKEN;
      return key ? createAnthropicModel({ apiKey: key, ...(model ? { model } : {}) }) : undefined;
    }
    case "openai": {
      const baseUrl = openAiBaseUrl();
      const key = process.env.OPENAI_API_KEY ?? (baseUrl ? "not-needed" : undefined);
      return key ? createOpenAiModel({ apiKey: key, ...(baseUrl ? { baseUrl } : {}), ...(model ? { model } : {}) }) : undefined;
    }
    case "ollama": {
      const baseUrl = ollamaOpts.baseUrl ?? "http://localhost:11434/v1/chat/completions";
      return (await ollamaReachable(baseUrl)) ? createOllamaModel({ ...ollamaOpts, ...(model ? { model } : {}) }) : undefined;
    }
    case "claude-cli":
      return claudeCliAvailable() ? createClaudeCliModel(model ? { model } : {}) : undefined;
  }
}

const warnedUnavailable = new Set<string>();

/** Resolves a model reference (see parseModelRef) to an adapter:
 *   - "provider:model" → that provider, if this gateway can use it;
 *   - a bare "claude-…" name → the Anthropic API when a key is set,
 *     otherwise the Claude CLI when it's installed — so a Claude model
 *     picked in BaseSpace's agent editor no longer gets sent to Ollama;
 *   - anything else → the default provider order (Anthropic, OpenAI,
 *     Ollama), with the name as the model, exactly as before.
 *  An unavailable explicit provider falls back to the default order
 *  WITHOUT the model name (it belongs to the other provider). */
export async function createModelFromRef(ref: string | undefined, ollamaOpts: OllamaOptions = {}): Promise<ModelAdapter | undefined> {
  const { provider, model } = parseModelRef(ref);
  if (provider) {
    const adapter = await createModelForProvider(provider, model, ollamaOpts);
    if (adapter) return adapter;
    if (!warnedUnavailable.has(provider)) {
      warnedUnavailable.add(provider);
      console.warn(`[models] "${ref}" asks for provider "${provider}", which this gateway can't use — falling back to the default provider.`);
    }
    return createModelFromEnvOrOllama(ollamaOpts);
  }
  if (model && /^claude-/.test(model) && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_TOKEN && claudeCliAvailable()) {
    return createClaudeCliModel({ model });
  }
  return createModelFromEnvOrOllama(ollamaOpts, model);
}

/** The gateway-wide default: AGENT_OS_DEFAULT_MODEL (same syntax as an
 *  agent's preference, e.g. "claude-cli:sonnet") when set, otherwise the
 *  original Anthropic → OpenAI → Ollama order. */
export async function createDefaultModel(ollamaOpts: OllamaOptions = {}): Promise<ModelAdapter | undefined> {
  const ref = process.env.AGENT_OS_DEFAULT_MODEL?.trim();
  return ref ? createModelFromRef(ref, ollamaOpts) : createModelFromEnvOrOllama(ollamaOpts);
}

/** The actual wiring point: resolves a ModelAdapter for a given agent from
 *  its own registered preference, else AGENT_OS_DEFAULT_MODEL, through the
 *  provider router above.
 *
 *  Precedence:
 *   1. A preference may pick WHICH PROVIDER, but only among providers this
 *      gateway process can already use (env keys, a reachable Ollama, an
 *      installed Claude CLI). A stored preference is data an agent (or
 *      whoever registered it) wrote; it must not be able to conjure access
 *      that wasn't granted via the environment.
 *   2. WHICH MODEL within that provider follows the preference, overriding
 *      the adapter's own default model name.
 *   3. With no preference and no AGENT_OS_DEFAULT_MODEL, behavior is
 *      byte-for-byte identical to createModelFromEnvOrOllama(). */
export async function createModelForAgent(
  agentId: string,
  ollamaOpts: OllamaOptions = {},
): Promise<ModelAdapter | undefined> {
  // An empty preference (a restore back to "no model set") means the default.
  const preferred = (await getAgentDefaultModel(agentId)) || process.env.AGENT_OS_DEFAULT_MODEL;
  return createModelFromRef(preferred, ollamaOpts);
}
