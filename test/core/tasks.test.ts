import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { stringify } from "yaml";
import {
  cancelTask,
  delegateTask,
  getTask,
  listTaskMessages,
  replyToTask,
  waitForTask,
} from "../../src/core/tasks.js";

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "fake-agent.mjs",
);

async function waitUntilFinished(
  taskId: string,
  projectRoot: string,
): Promise<ReturnType<typeof getTask>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const task = getTask(taskId, projectRoot);
    if (["completed", "failed", "cancelled"].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for detached task.");
}

test("delegation returns a task ID while a detached worker continues", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sharelane-task-"));
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
          resume: {
            args: [fixturePath, "codex-jsonl", "{prompt}", "{session}"],
          },
          output: "codex-jsonl",
          instructionsFile: "AGENTS.md",
        },
      },
    }),
    "utf8",
  );

  try {
    const started = Date.now();
    const delegated = delegateTask({
      agent: "fake",
      prompt: "do the slow work",
      projectRoot,
      env: {
        SHARELANE_AGENTS_CONFIG: configPath,
        FAKE_AGENT_DELAY_MS: "500",
      },
    });
    assert.match(delegated.id, /^task-[0-9a-f-]+$/);
    assert.ok(Date.now() - started < 400, "delegation should return before work ends");
    assert.ok(["queued", "running"].includes(delegated.status));

    const finished = await waitUntilFinished(delegated.id, projectRoot);
    assert.equal(finished.status, "completed", finished.error ?? "task failed");
    assert.equal(finished.result, "Codex heard: do the slow work");
    assert.equal(finished.sessionId, "fake-session-123");
    assert.match(await readFile(finished.taskFile, "utf8"), /Status: completed/);
    assert.match(await readFile(finished.logPath, "utf8"), /Codex heard/);

    const followUp = replyToTask(delegated.id, "now explain it", {
      projectRoot,
      env: {
        SHARELANE_AGENTS_CONFIG: configPath,
        FAKE_AGENT_DELAY_MS: "50",
      },
    });
    assert.ok(["queued", "running"].includes(followUp.status));
    const followedUp = await waitUntilFinished(delegated.id, projectRoot);
    assert.equal(followedUp.status, "completed", followedUp.error ?? "reply failed");
    assert.equal(followedUp.result, "Codex heard: now explain it");
    assert.equal(followedUp.sessionId, "fake-session-123");
    assert.deepEqual(
      listTaskMessages(delegated.id, projectRoot).map((message) => message.role),
      ["user", "assistant", "user", "assistant"],
    );

    const waited = await waitForTask(delegated.id, 0, projectRoot);
    assert.equal(waited.timedOut, false);
    assert.equal(waited.task.status, "completed");
  } finally {
    await rm(projectRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});

test("cancellation wins over a running worker", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sharelane-cancel-"));
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
          resume: {
            args: [fixturePath, "codex-jsonl", "{prompt}", "{session}"],
          },
          output: "codex-jsonl",
          instructionsFile: "AGENTS.md",
        },
      },
    }),
    "utf8",
  );

  try {
    const delegated = delegateTask({
      agent: "fake",
      prompt: "work until cancelled",
      projectRoot,
      env: {
        SHARELANE_AGENTS_CONFIG: configPath,
        FAKE_AGENT_DELAY_MS: "5000",
      },
    });
    const deadline = Date.now() + 5_000;
    let running = getTask(delegated.id, projectRoot);
    while ((!running.agentPid || running.status !== "running") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      running = getTask(delegated.id, projectRoot);
    }
    assert.equal(running.status, "running");
    assert.ok(running.agentPid);

    const cancelled = cancelTask(delegated.id, projectRoot);
    assert.equal(cancelled.status, "cancelled");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(getTask(delegated.id, projectRoot).status, "cancelled");
  } finally {
    await rm(projectRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});
