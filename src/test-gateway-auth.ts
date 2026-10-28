// Tests gateway auth (gateway/auth.ts):
//   1. With a token, every route but GET /health answers 401 without it or with a wrong one, and works with it.
//      The browser's CORS preflight still answers (it never carries credentials).
//   2. loadGatewayToken: makes a token file on first start and reuses it; AGENT_OS_GATEWAY_TOKEN wins; a short
//      env token is refused; AGENT_OS_GATEWAY_AUTH=off turns auth off.
// Run with: node dist/test-gateway-auth.js

import "./test-helpers/isolate.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createStubModel, createStubWorker } from "./core/index.js";
import { startGateway } from "./gateway/server.js";
import { loadGatewayToken } from "./gateway/auth.js";

let failed = false;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`ok: ${msg}`);
  else {
    failed = true;
    console.log(`FAIL: ${msg}`);
  }
}

console.log("\n-- 1. requests need the token --");
const token = "test-token-0123456789abcdef";
const gateway = await startGateway({ model: createStubModel(), worker: createStubWorker(), token });
const base = `http://127.0.0.1:${gateway.port}`;
try {
  assert((await fetch(`${base}/health`)).status === 200, "GET /health answers without a token");
  assert((await fetch(`${base}/approvals`)).status === 401, "GET /approvals without a token is refused");
  assert((await fetch(`${base}/approvals`, { headers: { authorization: "Bearer wrong-token-0123456789" } })).status === 401, "…and with a wrong one");
  assert((await fetch(`${base}/approvals`, { headers: { authorization: `Bearer ${token}` } })).status === 200, "…and works with the right one");
  assert((await fetch(`${base}/health?x=1`, { method: "POST" })).status === 401, "only GET /health is open, not other methods on it");
  const post = await fetch(`${base}/flows`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert(post.status === 401, "a POST without the token is refused before it reaches the route");
  const preflight = await fetch(`${base}/approvals`, { method: "OPTIONS" });
  assert(preflight.status === 204 && /authorization/.test(preflight.headers.get("access-control-allow-headers") ?? ""), "the CORS preflight answers and allows the authorization header");
} finally {
  await gateway.stop();
}

const open = await startGateway({ model: createStubModel(), worker: createStubWorker() });
try {
  assert((await fetch(`http://127.0.0.1:${open.port}/approvals`)).status === 200, "a gateway started without a token stays open (tests, embedding)");
} finally {
  await open.stop();
}

console.log("\n-- 2. where the token comes from --");
const dir = mkdtempSync(path.join(tmpdir(), "agent-os-auth-"));
const saved = { token: process.env.AGENT_OS_GATEWAY_TOKEN, auth: process.env.AGENT_OS_GATEWAY_AUTH };
try {
  delete process.env.AGENT_OS_GATEWAY_TOKEN;
  delete process.env.AGENT_OS_GATEWAY_AUTH;
  const first = loadGatewayToken(dir)!;
  const file = path.join(dir, "gateway-token");
  assert(first.token.length >= 32 && readFileSync(file, "utf8").trim() === first.token, "the first start writes a new token to data/gateway-token");
  assert(loadGatewayToken(dir)!.token === first.token, "the next start reuses it");
  process.env.AGENT_OS_GATEWAY_TOKEN = "from-the-environment-123";
  const env = loadGatewayToken(dir)!;
  assert(env.token === "from-the-environment-123" && env.source === "AGENT_OS_GATEWAY_TOKEN", "AGENT_OS_GATEWAY_TOKEN wins over the file");
  assert(!JSON.stringify(env.source).includes(env.token), "the source (logged at startup) never contains the token");
  process.env.AGENT_OS_GATEWAY_TOKEN = "short";
  let threw = false;
  try {
    loadGatewayToken(dir);
  } catch {
    threw = true;
  }
  assert(threw, "a token shorter than 16 characters is refused");
  process.env.AGENT_OS_GATEWAY_AUTH = "off";
  assert(loadGatewayToken(dir) === undefined, "AGENT_OS_GATEWAY_AUTH=off turns auth off");
} finally {
  if (saved.token === undefined) delete process.env.AGENT_OS_GATEWAY_TOKEN;
  else process.env.AGENT_OS_GATEWAY_TOKEN = saved.token;
  if (saved.auth === undefined) delete process.env.AGENT_OS_GATEWAY_AUTH;
  else process.env.AGENT_OS_GATEWAY_AUTH = saved.auth;
  rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? "\nSOME TESTS FAILED" : "\nall gateway-auth tests passed");
process.exit(failed ? 1 : 0);
