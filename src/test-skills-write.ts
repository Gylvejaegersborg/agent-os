// Standalone tests for skills write support (skills.ts writeSkill/
// serializeSkillFile, agentfs.ts fsWrite) — no disk fixtures needed
// beyond a throwaway temp directory. Run with: node dist/test-skills-write.js
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseSkillFile, serializeSkillFile, writeSkill, discoverSkills } from "./core/skills.js";
import { fsWrite, fsRead, FsWriteNotSupportedError } from "./core/agentfs.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "agent-os-skills-test-"));

  try {
    // 1. Round-trip: parse -> serialize -> parse produces the same skill.
    const original = `---
name: test-skill
description: A test skill with "quotes" and a colon: like this.
license: MIT
metadata:
  author: test-suite
  version: "1.0"
allowed-tools: shell skill
---

# Test Skill

This is the body. It has **markdown** in it.
`;
    const parsed1 = parseSkillFile(original, "irrelevant");
    const serialized = serializeSkillFile(parsed1);
    const parsed2 = parseSkillFile(serialized, "irrelevant");

    assert(parsed2.name === parsed1.name, "round-trip preserves name");
    assert(parsed2.description === parsed1.description, "round-trip preserves description (with colon/quotes)");
    assert(parsed2.license === parsed1.license, "round-trip preserves license");
    assert(JSON.stringify(parsed2.metadata) === JSON.stringify(parsed1.metadata), "round-trip preserves metadata map");
    assert(JSON.stringify(parsed2.allowedTools) === JSON.stringify(parsed1.allowedTools), "round-trip preserves allowed-tools");
    assert(parsed2.body === parsed1.body, "round-trip preserves body");

    // 2. writeSkill() actually writes to disk and discoverSkills() finds it.
    await writeSkill(tmpRoot, {
      name: "written-skill",
      description: "Written by writeSkill() directly.",
      body: "# Written Skill\n\nBody text.",
    });
    const found = await discoverSkills(tmpRoot);
    assert(found.some((s) => s.name === "written-skill"), "writeSkill() output is discoverable by discoverSkills()");

    // 3. writeSkill() validates BEFORE writing — an invalid skill never touches disk.
    let threw = false;
    try {
      await writeSkill(tmpRoot, { name: "Bad_Name", description: "x", body: "y" });
    } catch {
      threw = true;
    }
    assert(threw, "writeSkill() rejects an invalid skill name");
    const foundAfterReject = await discoverSkills(tmpRoot);
    assert(!foundAfterReject.some((s) => s.name === "Bad_Name"), "rejected writeSkill() call did not touch disk");

    // 4. fsWrite() end-to-end through the agent-fs namespace. NOTE: fsWrite
    // hardcodes rootDir="skills" relative to cwd, so this writes into the
    // REAL ./skills/ directory when run from the repo root — clean it up
    // immediately after asserting, so this test never pollutes the actual
    // skill catalog the demo/chat commands load.
    const skillMd = serializeSkillFile({
      name: "fs-written-skill-test",
      description: "Written via fsWrite() — deleted immediately after this test.",
      body: "# FS Written Skill\n\nBody text unique to fsWrite test.",
    });
    await fsWrite("/agent/skills/fs-written-skill-test/SKILL.md", skillMd);
    const readBack = await fsRead("/agent/skills/fs-written-skill-test/SKILL.md");
    // fsRead on a skill path returns skill.body specifically (not the raw
    // file with frontmatter) — assert against body content, not description.
    assert(readBack.includes("Body text unique to fsWrite test"), "fsWrite() then fsRead() round-trips through the real skills/ dir");
    const writtenSkills = await discoverSkills(path.join(process.cwd(), "skills"));
    const writtenSkill = writtenSkills.find((s) => s.name === "fs-written-skill-test");
    assert(
      writtenSkill?.description === "Written via fsWrite() — deleted immediately after this test.",
      "fsWrite()'s frontmatter (description) is discoverable via discoverSkills()",
    );
    await rm(path.join(process.cwd(), "skills", "fs-written-skill-test"), { recursive: true, force: true });

    // 5. fsWrite() name-mismatch rejection.
    let mismatchThrew = false;
    try {
      const mismatched = serializeSkillFile({ name: "actual-name", description: "x", body: "y" });
      await fsWrite("/agent/skills/different-path-name/SKILL.md", mismatched);
    } catch (err) {
      mismatchThrew = err instanceof FsWriteNotSupportedError;
    }
    assert(mismatchThrew, "fsWrite() rejects a name/path mismatch with FsWriteNotSupportedError");

    // 6. fsWrite() to an unsupported path kind throws FsWriteNotSupportedError.
    let memoryWriteThrew = false;
    try {
      await fsWrite("/agent/memory/some-agent/curated/MEMORY.md", "new content");
    } catch (err) {
      memoryWriteThrew = err instanceof FsWriteNotSupportedError;
    }
    assert(memoryWriteThrew, "fsWrite() to /agent/memory/... throws FsWriteNotSupportedError, not a silent no-op");
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }

  if (process.exitCode === 1) {
    console.error("\nSome skills-write tests FAILED.");
  } else {
    console.log("\nAll skills-write tests passed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
