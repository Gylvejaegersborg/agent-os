// Standalone tests for images in turns (a HUD screenshot with a message):
// the limits on POST /sessions/:id/turns, what each adapter puts in its
// request body (Anthropic, OpenAI, Ollama, the Claude CLI), the note a
// text-only model gets instead, and — the point of the whole design —
// that the bytes reach the model for that turn and are never written
// anywhere: the event log, history and Hindsight hold " [screenshot]".
// Run with: node dist/test-images.js

import "./test-helpers/isolate.js";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createStubModel,
  createStubWorker,
  parseTurnImages,
  MAX_IMAGE_BYTES,
  NO_VISION_NOTE,
  SkillRegistry,
  type ModelAdapter,
  type ModelImage,
  type ModelMessage,
} from "./core/index.js";
import { createAnthropicModel, createOllamaModel, createOpenAiModel } from "./core/models/real.js";
import { claudeCliArgs, createClaudeCliModel, streamJsonInput } from "./core/models/claude-cli.js";
import { startGateway } from "./gateway/server.js";

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`ok: ${msg}`);
  else {
    failed = true;
    console.log(`FAIL: ${msg}`);
  }
}

// A real PNG header and random bytes after it, so the base64 is unique enough to grep for.
const png = (size = 2048) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(size)]).toString("base64");
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(1024)]).toString("base64");
const shot: ModelImage = { mediaType: "image/png", data: png() };

// Provider calls go to *.test hosts and are answered here; the request bodies are kept for the assertions.
// Everything else (the gateway on 127.0.0.1) goes through.
const bodies: { url: string; body: any }[] = [];
let ollamaCaps: Record<string, string[] | undefined> = {};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!/^https?:\/\/[a-z]+\.test\//.test(url)) return realFetch(input, init);
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  bodies.push({ url, body });
  const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
  if (url.endsWith("/api/show")) {
    const caps = ollamaCaps[body.model];
    return caps ? json({ capabilities: caps }) : json({});
  }
  if (url.includes("hindsight.test")) return json({ results: [] });
  if (url.includes("anthropic.test") && body?.stream) {
    const sse = [
      { type: "message_start", message: { usage: { input_tokens: 5 } } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "I see it" } },
      { type: "message_delta", usage: { output_tokens: 2 } },
    ];
    return new Response(sse.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { status: 200 });
  }
  if (url.includes("anthropic.test")) return json({ content: [{ type: "text", text: "I see it" }] });
  if (body?.stream) return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "I see it" } }] })}\n\ndata: [DONE]\n\n`, { status: 200 });
  return json({ choices: [{ message: { content: "I see it" } }] });
}) as typeof fetch;

const lastBody = (host: string) => [...bodies].reverse().find((b) => b.url.includes(host) && !b.url.endsWith("/api/show"))?.body;
const conversation = (images: ModelImage[] = [shot]): ModelMessage[] => [
  { role: "system", content: "You are Hemera." },
  { role: "user", content: "earlier question" },
  { role: "assistant", content: "earlier answer" },
  { role: "user", content: "[Work] a harness note" },
  { role: "user", content: "what is on my screen? [screenshot]", images },
];

function testLimits(): void {
  assert(Array.isArray(parseTurnImages(undefined)) && (parseTurnImages(undefined) as ModelImage[]).length === 0, "no images is fine");
  const ok = parseTurnImages([shot, { mediaType: "image/jpeg", data: jpeg() }]);
  assert(Array.isArray(ok) && ok.length === 2, "two images, a PNG and a JPEG, are accepted");
  assert(typeof parseTurnImages([shot, shot, shot]) === "string", "a third image is refused");
  assert(typeof parseTurnImages([{ mediaType: "image/gif", data: shot.data }]) === "string", "a GIF is refused (png/jpeg only)");
  assert(typeof parseTurnImages([{ mediaType: "image/jpeg", data: shot.data }]) === "string", "PNG bytes labelled image/jpeg are refused");
  assert(typeof parseTurnImages([{ mediaType: "image/png", data: `data:image/png;base64,${shot.data}` }]) === "string", "a data: URL is refused (plain base64 only)");
  assert(typeof parseTurnImages([{ mediaType: "image/png", data: png(MAX_IMAGE_BYTES) }]) === "string", "an image over 4 MB decoded is refused");
  const atLimit = parseTurnImages([{ mediaType: "image/png", data: png(MAX_IMAGE_BYTES - 8) }]);
  assert(Array.isArray(atLimit), "an image of exactly 4 MB is accepted");
  assert(typeof parseTurnImages("nope") === "string", "images that aren't an array are refused");
}

async function testAnthropic(): Promise<void> {
  const model = createAnthropicModel({ apiKey: "sk-ant-api-test", baseUrl: "https://anthropic.test/v1/messages", tools: [] });
  for (const mode of ["complete", "completeStream"] as const) {
    const r = mode === "complete" ? await model.complete(conversation()) : await model.completeStream!(conversation(), () => {});
    const msgs = lastBody("anthropic.test").messages;
    const last = msgs[msgs.length - 1];
    assert(r.content === "I see it", `Anthropic ${mode}: the reply comes back`);
    assert(Array.isArray(last.content) && last.content[0].type === "image" && last.content[0].source.type === "base64", `Anthropic ${mode}: an image block comes first`);
    assert(last.content[0].source.media_type === "image/png" && last.content[0].source.data === shot.data, `Anthropic ${mode}: the block carries the media type and the bytes`);
    assert(last.content[1].type === "text" && /harness note/.test(last.content[1].text) && /on my screen/.test(last.content[1].text), `Anthropic ${mode}: the merged user text (note + question) follows the image`);
    assert(typeof msgs[0].content === "string", `Anthropic ${mode}: messages without images stay plain strings`);
  }
}

async function testOpenAi(): Promise<void> {
  const model = createOpenAiModel({ apiKey: "sk-test", baseUrl: "https://openai.test/v1/chat/completions", tools: [] });
  await model.complete(conversation());
  const last = lastBody("openai.test").messages.at(-1);
  assert(last.content[0].type === "image_url" && last.content[0].image_url.url === `data:image/png;base64,${shot.data}`, "OpenAI: the image goes as an image_url data URL");
  assert(last.content[1].type === "text" && /on my screen/.test(last.content[1].text), "OpenAI: then the text");
}

async function testOllama(): Promise<void> {
  ollamaCaps = { "gemma3:4b": ["completion", "vision"], "llama3.2": ["completion", "tools"] };
  const baseUrl = "http://ollama.test/v1/chat/completions";
  const vision = createOllamaModel({ model: "gemma3:4b", baseUrl, tools: [] });
  await vision.complete(conversation());
  let last = lastBody("ollama.test").messages.at(-1);
  assert(last.content[0].type === "image_url" && last.content[0].image_url.url.endsWith(shot.data), "Ollama, vision model: the image goes as an image_url data URL");
  await vision.completeStream!(conversation(), () => {});
  last = lastBody("ollama.test").messages.at(-1);
  assert(last.content[0].type === "image_url", "Ollama, vision model: streaming too");

  const text = createOllamaModel({ model: "llama3.2", baseUrl, tools: [] });
  await text.complete(conversation());
  last = lastBody("ollama.test").messages.at(-1);
  assert(typeof last.content === "string" && last.content.endsWith(NO_VISION_NOTE) && !JSON.stringify(lastBody("ollama.test")).includes(shot.data), "Ollama, text model: no image, the text plus the can't-see note");
  const shows = bodies.filter((b) => b.url.endsWith("/api/show") && b.body.model === "llama3.2").length;
  await text.complete(conversation());
  assert(bodies.filter((b) => b.url.endsWith("/api/show") && b.body.model === "llama3.2").length === shows, "Ollama: capabilities are asked once per model");

  const before = bodies.length;
  await text.complete([{ role: "user", content: "no picture" }]);
  assert(!bodies.slice(before).some((b) => b.url.endsWith("/api/show")), "Ollama: a turn without images never asks");
}

async function testClaudeCli(): Promise<void> {
  const args = claudeCliArgs("sys", "sonnet", { allow: [], deny: [] }, true);
  assert(args.join(" ").includes("--output-format stream-json --input-format stream-json"), "Claude CLI: with images it reads stdin as stream-json");
  assert(!claudeCliArgs("sys").includes("--input-format"), "Claude CLI: without images the plain-text prompt is unchanged");
  const line = JSON.parse(streamJsonInput("transcript", [shot]));
  assert(
    line.type === "user" && line.message.content[0].type === "image" && line.message.content[0].source.data === shot.data && line.message.content[1].text === "transcript",
    "Claude CLI: stdin is one user message, image block then the transcript",
  );

  // The whole adapter against a fake `claude`. A shebang script can't be spawned directly on Windows, so this part
  // runs on Linux/macOS (the Codespace), and the pieces above cover what goes in on every platform.
  if (process.platform === "win32") {
    console.log("skip: Claude CLI end to end with a fake `claude` (needs a shebang script; not on Windows)");
    return;
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), "fake-claude-img-"));
  const fake = path.join(dir, "claude");
  const log = path.join(dir, "calls.jsonl");
  writeFileSync(
    fake,
    `#!/usr/bin/env node
const fs = require("fs");
let stdin = "";
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), stdin }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "I see it" }) + "\\n");
});
`,
  );
  chmodSync(fake, 0o755);
  const cli = createClaudeCliModel({ command: fake, tools: [] });
  const r = await cli.complete(conversation());
  const call = JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1)!);
  const sent = JSON.parse(call.stdin);
  assert(r.content === "I see it" && call.args.includes("--input-format"), "Claude CLI: the fake CLI was started with --input-format stream-json");
  assert(sent.message.content[0].source.data === shot.data && /on my screen/.test(sent.message.content[1].text), "Claude CLI: its stdin carried the image block and the transcript");
}

/** Every file under `dir`, as text. */
function allFiles(dir: string): { file: string; text: string }[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? allFiles(p) : [{ file: p, text: readFileSync(p, "latin1") }];
  });
}

async function testGatewayTurn(): Promise<void> {
  process.env.HINDSIGHT_URL = "http://hindsight.test";
  // Records every call's messages, so every hop of the turn can be checked.
  const calls: ModelMessage[][] = [];
  const stub = createStubModel();
  const model: ModelAdapter = {
    id: "recording-stub",
    complete: async (messages, callOpts) => {
      calls.push(messages);
      return stub.complete(messages, callOpts);
    },
  };
  const skillsDir = path.join(process.env.AGENT_OS_DATA_DIR!, "skills");
  const gw = await startGateway({ model, worker: createStubWorker(), skills: await SkillRegistry.fromDirectory(skillsDir), skillsDir });
  const url = `http://127.0.0.1:${gw.port}`;
  const post = (p: string, body: unknown) => fetch(`${url}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const session = (await (await post("/sessions", { agentId: "hemera" })).json()) as { id: string };
    const big = png(MAX_IMAGE_BYTES + 1);
    assert((await post(`/sessions/${session.id}/turns`, { userMessage: "x", images: [shot, shot, shot] })).status === 400, "POST turns: three images → 400");
    assert((await post(`/sessions/${session.id}/turns`, { userMessage: "x", images: [{ mediaType: "image/webp", data: shot.data }] })).status === 400, "POST turns: a webp → 400");
    assert((await post(`/sessions/${session.id}/turns`, { userMessage: "x", images: [{ mediaType: "image/png", data: big }] })).status === 400, "POST turns: over 4 MB → 400");
    assert(calls.length === 0, "a refused turn never reaches the model");

    const second: ModelImage = { mediaType: "image/jpeg", data: jpeg() };
    const res = await post(`/sessions/${session.id}/turns`, { userMessage: "what is on my screen?", images: [shot, second] });
    assert(res.status === 200, `POST turns with two images → 200 (got ${res.status})`);
    const user = calls[0]?.filter((m) => m.role === "user").at(-1);
    assert(user?.content === "what is on my screen? [screenshot]" && user.images?.length === 2 && user.images[0]!.data === shot.data, "the model got the images on this turn's user message");

    // A turn with a tool step: the stub model calls the shell tool, then answers on the next hop.
    const hopsBefore = calls.length;
    await post(`/sessions/${session.id}/turns`, { userMessage: "run shell: echo hi", images: [shot] });
    const hops = calls.slice(hopsBefore);
    assert(hops.length >= 2 && hops.every((h) => h.some((m) => m.images?.[0]?.data === shot.data)), `every hop of the turn sees the image (${hops.length} hops)`);

    await post(`/sessions/${session.id}/turns`, { userMessage: "and now?" });
    const later = calls.at(-1)!;
    assert(!later.some((m) => m.images?.length), "the next turn's model call carries no images: they were for that turn only");
    assert(later.some((m) => m.content === "what is on my screen? [screenshot]"), "…but the earlier message is in history, with the marker");

    const history = ((await (await fetch(`${url}/sessions/${session.id}/history`)).json()) as { history: ModelMessage[] }).history;
    const stored = history.find((m) => m.role === "user" && /on my screen/.test(m.content));
    assert(stored?.content === "what is on my screen? [screenshot]" && !("images" in stored), "history holds the marker, not the images");

    await new Promise((r) => setTimeout(r, 50)); // hindsightRetain is fire-and-forget
    const retained = bodies.filter((b) => b.url.includes("hindsight.test") && b.url.endsWith("/memories"));
    assert(retained.length > 0 && JSON.stringify(retained).includes("[screenshot]"), "Hindsight retained the turn with the marker");
    const hindsightAll = JSON.stringify(bodies.filter((b) => b.url.includes("hindsight.test")));
    assert(!hindsightAll.includes(shot.data.slice(100, 160)) && !hindsightAll.includes(second.data.slice(100, 160)), "nothing sent to Hindsight carries the image bytes");

    const files = allFiles(process.env.AGENT_OS_DATA_DIR!);
    const needles = [shot.data.slice(200, 260), second.data.slice(200, 260)];
    const leaks = files.filter((f) => needles.some((n) => f.text.includes(n)));
    assert(files.length > 0 && leaks.length === 0, `no file in the data dir holds the base64 (${files.length} files checked${leaks.length ? `; found in ${leaks.map((l) => l.file).join(", ")}` : ""})`);
    assert(files.some((f) => f.text.includes("[screenshot]")), "…while the event log does hold the marker");
  } finally {
    await gw.stop();
    delete process.env.HINDSIGHT_URL;
  }
}

testLimits();
await testAnthropic();
await testOpenAi();
await testOllama();
await testClaudeCli();
await testGatewayTurn();

if (failed) {
  console.log("\nSome image tests FAILED.");
  process.exit(1);
}
console.log("\nAll image tests passed.");
process.exit(0);
