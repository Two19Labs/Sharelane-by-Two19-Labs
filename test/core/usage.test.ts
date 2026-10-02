import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { stringify } from "yaml";
import {
  delegateTask,
  describeUsage,
  replyToTask,
  waitForTask,
} from "../../src/core/tasks.js";

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "fake-agent.mjs",
);

async function writeConfig(projectRoot: string): Promise<string> {
  const configPath = join(projectRoot, "agents.yaml");
  await writeFile(
    configPath,
    stringify({
      version: 1,
      agents: {
        fake: {
          displayName: "Fake Agent",
          command: process.execPath,
          run: { args: [fixturePath, "codex-jsonl", "{prompt}"] },
          resume: { args: [fixturePath, "codex-jsonl", "{prompt}", "{session}"] },
          output: "codex-jsonl",
          instructionsFile: "AGENTS.md",
        },
      },
    }),
    "utf8",
  );
  return configPath;
}

test("usage is accumulated across a task's first run and its follow-ups", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sharelane-usage-"));
  try {
    const env = { SHARELANE_AGENTS_CONFIG: await writeConfig(projectRoot) };
    const delegated = delegateTask({ agent: "fake", prompt: "first", projectRoot, env });
    const first = (await waitForTask(delegated.id, 15_000, projectRoot)).task;
    assert.equal(first.status, "completed", first.error ?? "task failed");
    // The fake reports 12 input (3 cached) and 5 output per run.
    assert.deepEqual(first.totalUsage, {
      runs: 1,
      freshInputTokens: 9,
      cachedInputTokens: 3,
      outputTokens: 5,
      runsWithoutUsage: 0,
    });

    replyToTask(delegated.id, "second", { projectRoot, env });
    const second = (await waitForTask(delegated.id, 15_000, projectRoot)).task;
    assert.equal(second.status, "completed", second.error ?? "follow-up failed");
    assert.deepEqual(second.totalUsage, {
      runs: 2,
      freshInputTokens: 18,
      cachedInputTokens: 6,
      outputTokens: 10,
      runsWithoutUsage: 0,
    });
    assert.equal(
      describeUsage(second),
      "2 runs, fresh input 18, cached input 6, output 10",
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
