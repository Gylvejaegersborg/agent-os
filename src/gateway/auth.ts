// Gateway auth: one shared secret every request must carry as `Authorization: Bearer <token>`.
//
// Before this, anything that could reach 127.0.0.1:8787 could drive the whole OS — run agents, decide
// approvals, open a shell through /terminals — and the gateway answered every origin (CORS "*"), so any web
// page open in a browser on the machine could do the same. Loopback-only binding doesn't stop either.
//
// The token is AGENT_OS_GATEWAY_TOKEN when set, otherwise one generated on first start and kept in
// <data dir>/gateway-token (readable only by this user). The callers that need it read the same place:
// BaseSpace's Vite proxy adds the header (the browser never sees the token), Claude Code started from the
// Terminal gets it in its MCP config, and the desktop sensor reads the file. GET /health stays open.
// AGENT_OS_GATEWAY_AUTH=off turns the check off, loudly — for a script that hasn't been given the token yet.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { IncomingMessage } from "node:http";

export interface GatewayToken {
  token: string;
  /** Where it came from, for the startup log (never the token itself). */
  source: string;
}

/** The token the gateway requires: the env var, else the token file, else a new one written to that file.
 *  Undefined only when AGENT_OS_GATEWAY_AUTH=off. */
export function loadGatewayToken(dataDir = process.env.AGENT_OS_DATA_DIR ?? path.join(process.cwd(), "data")): GatewayToken | undefined {
  if (process.env.AGENT_OS_GATEWAY_AUTH === "off") return undefined;
  const fromEnv = process.env.AGENT_OS_GATEWAY_TOKEN?.trim();
  if (fromEnv) {
    if (fromEnv.length < 16) throw new Error("AGENT_OS_GATEWAY_TOKEN is too short (use at least 16 characters)");
    return { token: fromEnv, source: "AGENT_OS_GATEWAY_TOKEN" };
  }
  const file = path.join(dataDir, "gateway-token");
  if (existsSync(file)) {
    const saved = readFileSync(file, "utf8").trim();
    if (saved.length >= 16) return { token: saved, source: file };
  }
  const token = randomBytes(32).toString("base64url");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, token + "\n", { mode: 0o600 });
  try {
    chmodSync(file, 0o600); // the mode above only applies to a new file
  } catch {
    // Windows: the file sits in the user's own data dir; chmod is a no-op there anyway.
  }
  return { token, source: `${file} (new)` };
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/** True when the request carries the token. Compared in constant time. */
export function hasGatewayToken(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  const m = typeof header === "string" ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
  return !!m && timingSafeEqual(digest(m[1]!), digest(token));
}
