// Standalone test for POST /skills/install (ROADMAP.md's "skill
// marketplace / install-from-elsewhere" item, scoped to its smallest
// useful version: fetch a raw SKILL.md from any URL). Mocks global.fetch
// but ONLY for requests to the fake "remote skill source" URL used
// below — every other fetch (this test's own calls to the real local
// gateway it starts) passes straight through unmocked, so this exercises
// a genuinely real gateway end to end, just with one external dependency
// (the remote skill host) faked out.
// Run with: node dist/test-skill-install.js

import "./test-helpers/isolate.js";
import path from "node:path";
import { startGateway } from "./gateway/server.js";
import { createStubModel, createStubWorker, SkillRegistry } from "./core/index.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

const FAKE_REMOTE_URL = "http://fake-skill-source.test/SKILL.md";
const FAKE_REMOTE_CONTENT = `---
name: remote-skill
description: A skill fetched from elsewhere, for integration testing.
---

Do the remote thing.
`;

function installMockFetch(): () => void {
  const real = global.fetch;
  global.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url === FAKE_REMOTE_URL) {
      return new Response(FAKE_REMOTE_CONTENT, { status: 200 });
    }
    if (url === `${FAKE_REMOTE_URL}-404`) {
      return new Response("not found", { status: 404 });
    }
    if (url === `${FAKE_REMOTE_URL}-malformed`) {
      return new Response("not a valid SKILL.md at all, no frontmatter", { status: 200 });
    }
    return real(input, init);
  }) as typeof fetch;
  return () => {
    global.fetch = real;
  };
}

async function main(): Promise<void> {
  const restoreFetch = installMockFetch();
  const skillsDir = path.join(process.env.AGENT_OS_DATA_DIR!, "skills");
  const gateway = await startGateway({
    model: createStubModel(),
    worker: createStubWorker(),
    skills: await SkillRegistry.fromDirectory(skillsDir),
    skillsDir,
  });
  const base = `http://127.0.0.1:${gateway.port}`;

  try {
    console.log("\n-- 1. Installing a skill from a URL --");
    const installRes = await fetch(`${base}/skills/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: FAKE_REMOTE_URL }),
    });
    assert(installRes.status === 201, "POST /skills/install returns 201");
    const installed = (await installRes.json()) as any;
    assert(installed.name === "remote-skill", `the installed skill's name comes from the fetched SKILL.md's frontmatter (got "${installed.name}")`);
    assert(installed.body.includes("Do the remote thing"), "the installed skill's body is the fetched content");

    const listRes = await fetch(`${base}/skills`);
    const list = (await listRes.json()) as any;
    assert(
      list.skills.some((s: any) => s.name === "remote-skill"),
      "the installed skill shows up in the catalog immediately, same as a hand-authored one",
    );

    console.log("\n-- 2. A 404 from the remote source is reported, not a silent no-op --");
    const notFoundRes = await fetch(`${base}/skills/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `${FAKE_REMOTE_URL}-404` }),
    });
    assert(notFoundRes.status === 400, "a 404 from the remote source is reported as 400, not 500 or a silent success");

    console.log("\n-- 3. Malformed remote content is rejected via the SAME validation a hand-authored skill goes through --");
    const malformedRes = await fetch(`${base}/skills/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `${FAKE_REMOTE_URL}-malformed` }),
    });
    assert(malformedRes.status === 400, "malformed remote content is rejected with 400");
    const malformedBody = (await malformedRes.json()) as any;
    assert(malformedBody.error.includes("frontmatter"), `the error names the real problem (got: "${malformedBody.error}")`);

    console.log("\n-- 4. Missing url is a 400, not a crash --");
    const missingUrlRes = await fetch(`${base}/skills/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert(missingUrlRes.status === 400, "a missing url returns 400");
  } finally {
    await gateway.stop();
    restoreFetch();
  }

  if (process.exitCode === 1) {
    console.error("\nSome skill-install tests FAILED.");
  } else {
    console.log("\nAll skill-install tests passed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
