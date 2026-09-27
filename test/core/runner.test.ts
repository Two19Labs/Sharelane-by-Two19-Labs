import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AgentRegistry } from "../../src/adapters/adapter.js";
import { runAgent } from "../../src/core/runner.js";

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "fake-agent.mjs",
);

const registry: AgentRegistry = {
  version: 1,
  agents: {
    fakecodex: {
      displayName: "Fake Codex",
      command: process.execPath,
      run: { args: [fixturePath, "codex-jsonl", "{prompt}"] },
      resume: {
        args: [fixturePath, "codex-jsonl", "{prompt}", "{session}"],
      },
      output: "codex-jsonl",
      instructionsFile: "AGENTS.md",
    },
    fakeclaude: {
      displayName: "Fake Claude",
      command: process.execPath,
      run: { args: [fixturePath, "claude-json", "{prompt}"] },
      resume: {
        args: [fixturePath, "claude-json", "{prompt}", "{session}"],
      },
      output: "claude-json",
      instructionsFile: "CLAUDE.md",
    },
  },
};

test("runs an agent without shell interpretation and saves its output", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sharelane-runner-"));
  const prompt = 'literal & ; | $(command) "quoted" text';
  try {
    const result = await runAgent({
      agent: "fakecodex",
      prompt,
      projectRoot,
      registry,
    });
    assert.equal(result.finalMessage, `Codex heard: ${prompt}`);
    assert.equal(result.sessionId, "fake-session-123");
    assert.equal(result.resumed, false);
    assert.match(await readFile(result.logPath, "utf8"), /Codex heard/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("resumes an agent session and parses Claude output", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sharelane-resume-"));
  try {
    const result = await runAgent({
      agent: "fakeclaude",
      prompt: "continue",
      sessionId: "existing-session",
      projectRoot,
      registry,
    });
    assert.equal(result.finalMessage, "Claude heard: continue");
    assert.equal(result.sessionId, "existing-session");
    assert.equal(result.resumed, true);
    assert.equal(result.usage.cachedInputTokens, 4);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
