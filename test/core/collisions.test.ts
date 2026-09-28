import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { stringify } from "yaml";
import {
  claimPaths,
  heartbeatClaims,
  listActiveClaims,
  releaseClaims,
} from "../../src/core/claims.js";
import { installClaudeClaimHook } from "../../src/core/hooks.js";
import { listTaskNotices } from "../../src/core/notices.js";
import { delegateTask, waitForTask } from "../../src/core/tasks.js";

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "fake-agent.mjs",
);

function git(projectRoot: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", projectRoot, ...args], {
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return result.stdout.trim();
}

async function writeFakeConfig(projectRoot: string): Promise<string> {
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
  return configPath;
}

test("overlapping claims are stopped and heartbeat/release manage ownership", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sharelane-claims-"));
  try {
    const first = claimPaths({
      agent: "claude",
      paths: ["src/ui/**"],
      intent: "build navigation",
      projectRoot,
      ttlSeconds: 30,
    });
    assert.equal(first.length, 1);
    assert.throws(
      () =>
        claimPaths({
          agent: "codex",
          paths: ["src/ui/Button.ts"],
          intent: "change button",
          projectRoot,
        }),
      /Claim refused.*held by claude.*build navigation/,
    );
    const separate = claimPaths({
      agent: "codex",
      paths: ["src/api/**"],
      intent: "add endpoint",
      projectRoot,
    });
    assert.equal(separate.length, 1);
    assert.equal(
      heartbeatClaims({ agent: "claude", projectRoot, ttlSeconds: 120 }),
      1,
    );
    assert.equal(releaseClaims({ agent: "claude", projectRoot }), 1);
    assert.deepEqual(
      listActiveClaims(projectRoot).map((claim) => claim.agent),
      ["codex"],
    );
  } finally {
    await rm(projectRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});

test("Claude edit hook blocks an unclaimed file and allows a claimed file", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sharelane-hook-"));
  try {
    installClaudeClaimHook(projectRoot);
    const hookPath = join(
      projectRoot,
      ".claude",
      "hooks",
      "sharelane-claim-guard.mjs",
    );
    const filePath = join(projectRoot, "src", "guarded.ts");
    const event = JSON.stringify({
      cwd: projectRoot,
      tool_name: "Write",
      tool_input: { file_path: filePath, content: "value" },
    });
    const environment = {
      ...process.env,
      SHARELANE_PROJECT_ROOT: projectRoot,
      SHARELANE_AGENT: "claude",
    };
    // Create the database before the hook opens it read-only.
    claimPaths({
      agent: "setup",
      paths: ["README.md"],
      intent: "initialize database",
      projectRoot,
    });
    const blocked = spawnSync(process.execPath, [hookPath], {
      cwd: projectRoot,
      env: environment,
      input: event,
      encoding: "utf8",
    });
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, /blocked an unclaimed edit/);

    claimPaths({
      agent: "claude",
      paths: ["src/guarded.ts"],
      intent: "test guarded edit",
      projectRoot,
    });
    const allowed = spawnSync(process.execPath, [hookPath], {
      cwd: projectRoot,
      env: environment,
      input: event,
      encoding: "utf8",
    });
    assert.equal(allowed.status, 0, allowed.stderr);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("delegated Git work is isolated, committed, cleaned up, and unclaimed edits are flagged", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sharelane-worktree-"));
  const configPath = await writeFakeConfig(projectRoot);
  try {
    await writeFile(join(projectRoot, "value.txt"), "main copy\n", "utf8");
    git(projectRoot, "init", "-b", "main");
    git(projectRoot, "add", ".");
    git(
      projectRoot,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "initial",
    );

    const delegated = delegateTask({
      agent: "fake",
      callerAgent: "test",
      prompt: "change the value file",
      projectRoot,
      env: {
        SHARELANE_AGENTS_CONFIG: configPath,
        FAKE_AGENT_DELAY_MS: "700",
        FAKE_EDIT_PATH: "value.txt",
        FAKE_EDIT_CONTENT: "worker copy\n",
      },
    });
    assert.ok(delegated.worktreePath);
    assert.ok(existsSync(delegated.worktreePath));
    assert.match(delegated.branchName ?? "", /^sharelane\/task-/);

    const waited = await waitForTask(delegated.id, 15_000, projectRoot);
    assert.equal(waited.timedOut, false);
    assert.equal(waited.task.status, "completed", waited.task.error ?? "task failed");
    assert.equal(await readFile(join(projectRoot, "value.txt"), "utf8"), "main copy\n");
    assert.equal(existsSync(delegated.worktreePath), false);
    assert.deepEqual(waited.task.changedFiles, ["value.txt"]);
    assert.ok(waited.task.resultCommit);
    assert.equal(
      git(projectRoot, "show", `${waited.task.branchName}:value.txt`),
      "worker copy",
    );
    assert.match(
      listTaskNotices(delegated.id, projectRoot)
        .map((notice) => notice.message)
        .join("\n"),
      /Unclaimed edit detected in value\.txt/,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("similar active delegations return a duplicate-task warning", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sharelane-duplicate-"));
  const configPath = await writeFakeConfig(projectRoot);
  try {
    const first = delegateTask({
      agent: "fake",
      callerAgent: "test",
      prompt: "implement the account settings page",
      projectRoot,
      env: {
        SHARELANE_AGENTS_CONFIG: configPath,
        FAKE_AGENT_DELAY_MS: "700",
      },
    });
    const second = delegateTask({
      agent: "fake",
      callerAgent: "test",
      prompt: "implement the account settings page",
      projectRoot,
      env: { SHARELANE_AGENTS_CONFIG: configPath },
    });
    assert.match(second.duplicateWarnings?.[0] ?? "", /Possible duplicate/);
    await Promise.all([
      waitForTask(first.id, 10_000, projectRoot),
      waitForTask(second.id, 10_000, projectRoot),
    ]);
  } finally {
    await rm(projectRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});
