import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { stringify } from "yaml";
import { getShareLanePaths, openDatabase } from "../../src/core/database.js";
import {
  cancelTask,
  delegateTask,
  getTask,
  getTaskLineage,
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
  const waited = await waitForTask(taskId, 10_000, projectRoot);
  if (waited.timedOut) throw new Error("Timed out waiting for detached task.");
  return waited.task;
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
        FAKE_REPORT_SHARELANE_ENV: "1",
      },
    });
    assert.match(delegated.id, /^task-[0-9a-f-]+$/);
    assert.ok(Date.now() - started < 400, "delegation should return before work ends");
    assert.ok(["queued", "running"].includes(delegated.status));

    const finished = await waitUntilFinished(delegated.id, projectRoot);
    assert.equal(finished.status, "completed", finished.error ?? "task failed");
    assert.match(finished.result ?? "", /You are a ShareLane delegated worker/);
    assert.match(finished.result ?? "", /Minimize token overhead/);
    assert.match(finished.result ?? "", /delegate again only when another agent adds clear/);
    assert.match(finished.result ?? "", /Request:\ndo the slow work/);
    assert.match(finished.result ?? "", /Project context map:\n# ShareLane context map/);
    assert.match(
      finished.result ?? "",
      new RegExp(`"taskId":"${delegated.id}"`),
    );
    assert.match(finished.result ?? "", /"parent":""/);
    assert.match(finished.result ?? "", /"depth":"1"/);
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

test("task lineage rejects cycles and delegation deeper than three levels", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sharelane-lineage-"));
  const configPath = join(projectRoot, "agents.yaml");
  const fakeAdapter = {
    displayName: "Fake Agent",
    command: process.execPath,
    run: { args: [fixturePath, "codex-jsonl", "{prompt}"] },
    resume: {
      args: [fixturePath, "codex-jsonl", "{prompt}", "{session}"],
    },
    output: "codex-jsonl",
    instructionsFile: "AGENTS.md",
  };
  await writeFile(
    configPath,
    stringify({
      version: 1,
      agents: { claude: fakeAdapter, codex: fakeAdapter },
    }),
    "utf8",
  );

  try {
    const delegated = delegateTask({
      agent: "codex",
      callerAgent: "claude",
      prompt: "child work",
      projectRoot,
      env: { SHARELANE_AGENTS_CONFIG: configPath },
    });
    assert.deepEqual(getTaskLineage(delegated.id, projectRoot), [
      "claude",
      "codex",
    ]);
    assert.throws(
      () =>
        delegateTask({
          agent: "claude",
          callerAgent: "codex",
          parentId: delegated.id,
          prompt: "loop back",
          projectRoot,
          env: { SHARELANE_AGENTS_CONFIG: configPath },
        }),
      /Delegation cycle refused: claude -> codex -> claude/,
    );
    assert.throws(
      () =>
        delegateTask({
          agent: "codex",
          callerAgent: "claude",
          depth: 4,
          prompt: "too deep",
          projectRoot,
          env: { SHARELANE_AGENTS_CONFIG: configPath },
        }),
      /maximum depth of 3/,
    );
    await waitUntilFinished(delegated.id, projectRoot);
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

test("reports a missing task supervisor as orphaned without changing the database", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sharelane-orphan-"));
  try {
    const now = new Date().toISOString();
    const paths = getShareLanePaths(projectRoot);
    const database = openDatabase(projectRoot);
    database
      .prepare(
        `INSERT INTO tasks (
          id, agent, prompt, status, depth, task_file, log_path, worker_pid,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "task-orphan-test",
        "fake",
        "stale work",
        "running",
        1,
        join(paths.tasksDir, "task-orphan-test.md"),
        join(paths.tasksDir, "task-orphan-test.log"),
        2_147_483_647,
        now,
        now,
      );
    database.close();

    const observed = getTask("task-orphan-test", projectRoot);
    assert.equal(observed.status, "orphaned");
    assert.match(observed.error ?? "", /supervisor is no longer running/);

    const unchanged = openDatabase(projectRoot);
    const row = unchanged
      .prepare("SELECT status FROM tasks WHERE id = ?")
      .get("task-orphan-test") as { status: string };
    unchanged.close();
    assert.equal(row.status, "running");

    assert.equal(cancelTask("task-orphan-test", projectRoot).status, "cancelled");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test(
  "Windows broker launches a worker outside the caller's process tree",
  { skip: process.platform !== "win32" },
  async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "sharelane-broker-"));
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
    const previousConfig = process.env.SHARELANE_AGENTS_CONFIG;
    process.env.SHARELANE_AGENTS_CONFIG = configPath;

    try {
      const delegated = delegateTask({
        agent: "fake",
        callerAgent: "test",
        prompt: "brokered work",
        projectRoot,
      });
      assert.ok(delegated.workerPid);
      const finished = await waitUntilFinished(delegated.id, projectRoot);
      assert.equal(finished.status, "completed", finished.error ?? "broker failed");
      assert.match(finished.result ?? "", /Request:\nbrokered work/);
    } finally {
      if (previousConfig === undefined) {
        delete process.env.SHARELANE_AGENTS_CONFIG;
      } else {
        process.env.SHARELANE_AGENTS_CONFIG = previousConfig;
      }
      await rm(projectRoot, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  },
);
