// Webhook listener — a real HTTP server that makes 'webhook'-triggered
// Automations actually fire, per docs/architecture.md §2's Automation
// trigger union: { kind: 'webhook'; path: string }. Uses Node's built-in
// http module deliberately — no Express, no framework — matching this
// scaffold's zero-external-dependency philosophy (same reasoning as the
// hand-rolled cron parser in scheduler.ts).
//
// Deliberately minimal, stated explicitly: no auth/signature verification
// (a real deployment MUST add HMAC signature checking or similar before
// exposing this publicly — this scaffold proves the primitive, not a
// production webhook receiver), no HTTPS (terminate TLS in front of this
// in any real deployment), and every registered path accepts any HTTP
// method (path-only matching, since Automation.trigger.path doesn't carry
// a method). These are scope boundaries, not oversights.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { fireWebhookAutomations, type SchedulerDeps, type FireResult } from "./scheduler.js";

export interface WebhookServerHandle {
  server: Server;
  port: number;
  stop: () => Promise<void>;
}

function readRequestBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        resolve(typeof parsed === "object" && parsed !== null ? parsed : { body: parsed });
      } catch {
        resolve({ rawBody: raw }); // non-JSON body — pass through as-is rather than failing the request
      }
    });
  });
}

/** Starts a real HTTP server that fires every enabled webhook-triggered
 *  Automation whose `path` matches the request URL. Any request method
 *  is accepted (path-only matching — see file header). Responds 200 with
 *  a small JSON summary of what fired, 404 if no automation is
 *  registered for that path (so a caller can tell "wrong path" from
 *  "automation ran but produced nothing"), or 500 with the error message
 *  if firing itself threw. Returns a handle whose stop() closes the
 *  server — always hold onto it, matching every other start*() handle
 *  in this codebase (startScheduler, startHeartbeat). */
export function startWebhookServer(deps: SchedulerDeps, port = 0): Promise<WebhookServerHandle> {
  return new Promise((resolve) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const payload = await readRequestBody(req);

      let fired: FireResult[];
      try {
        fired = await fireWebhookAutomations(url.pathname, payload, deps);
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        return;
      }

      if (fired.length === 0) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `no enabled webhook automation registered for path "${url.pathname}"` }));
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ fired: fired.map((f) => ({ automationId: f.automationId, taskId: f.taskId })) }));
    });

    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolve({
        server,
        port: actualPort,
        stop: () => new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}
