import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initializeContext, unwrittenStarterChunks, updateChunk } from "../../src/core/context.js";
import { installAgentInstructions, installRuntimeIgnores } from "../../src/core/instructions.js";
import { installOnboarding } from "../../src/core/onboarding.js";

test("a new project gets a one-time onboarding playbook until its starter chunks are written", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sharelane-onboarding-"));
  try {
    const playbook = join(projectRoot, ".sharelane", "ONBOARDING.md");
    initializeContext(projectRoot);
    assert.equal(unwrittenStarterChunks(projectRoot).length, 6);

    assert.equal(installOnboarding(projectRoot), "created");
    assert.match(readFileSync(playbook, "utf8"), /update_chunk/);
    assert.equal(installOnboarding(projectRoot), "pending");

    // Agents are told to look for it, and it is never committed.
    installAgentInstructions(projectRoot);
    installRuntimeIgnores(projectRoot);
    assert.match(readFileSync(join(projectRoot, "AGENTS.md"), "utf8"), /\.sharelane\/ONBOARDING\.md/);
    assert.match(readFileSync(join(projectRoot, "CLAUDE.md"), "utf8"), /\.sharelane\/ONBOARDING\.md/);
    assert.match(readFileSync(join(projectRoot, ".gitignore"), "utf8"), /^\.sharelane\/ONBOARDING\.md$/m);

    // The agent writes every starter chunk and deletes the playbook; init does not bring it back.
    for (const id of unwrittenStarterChunks(projectRoot)) {
      updateChunk({ id, content: `# ${id}\n\nNot applicable to this project: test fixture.` }, projectRoot);
    }
    await rm(playbook);
    assert.deepEqual(unwrittenStarterChunks(projectRoot), []);
    assert.equal(installOnboarding(projectRoot), "none");
    assert.equal(existsSync(playbook), false);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
