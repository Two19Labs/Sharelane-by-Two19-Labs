import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { stringify } from "yaml";
import {
  buildAgentCommand,
  defaultAgentsPath,
  loadAgentRegistry,
} from "../../src/adapters/adapter.js";
import { claimPaths, listActiveClaims, releaseClaims } from "../../src/core/claims.js";
import { openDatabase } from "../../src/core/database.js";
import { installClaudeClaimHook } from "../../src/core/hooks.js";
import { listTaskNotices } from "../../src/core/notices.js";
import {
  normalizeScope,
  pathInScope,
  patternWithinScope,
  scopeDirectories,
} from "../../src/core/scope.js";
import {
  cancelTask,
  delegateTask,
  getTask,
  outOfScopePatchPath,
  replyToTask,
  waitForTask,
} from "../../src/core/tasks.js";

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
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

async function writeScopedFakeConfig(projectRoot: string): Promise<string> {
  const configPath = join(projectRoot, "agents.yaml");
  await writeFile(
    configPath,
    stringify({
      version: 1,
      agents: {
        fake: {
          displayName: "Fake Agent",
          command: process.execPath,
          run: { args: [fixturePath, "codex-jsonl", "{prompt}", "", "{scopeArgs}"] },
          resume: {
            args: [fixturePath, "codex-jsonl", "{prompt}", "{session}", "{scopeArgs}"],
          },
          scope: {
            scoped: ["--root={scopeRoot}", "--pattern={scopePattern}"],
            unscoped: ["--unscoped"],
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

async function removeProject(projectRoot: string): Promise<void> {
  await rm(projectRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

test("scope entries are validated, normalized, and matched conservatively", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sharelane-scope-"));
  try {
    await mkdir(join(projectRoot, "docs"));
    assert.equal(normalizeScope(undefined, projectRoot), undefined);
    assert.deepEqual(
      normalizeScope(["./src/ui/", "docs", "src\\ui\\**", "README.md"], projectRoot),
      ["src/ui/**", "docs/**", "README.md"],
    );
    assert.throws(() => normalizeScope([], projectRoot), /at least one/);
    assert.throws(() => normalizeScope(["../outside/**"], projectRoot), /cannot leave/);
    assert.throws(() => normalizeScope(["C:/Windows/**"], projectRoot), /project-relative/);

    const scope = ["src/ui/**", "README.md"];
    assert.equal(pathInScope(scope, "src/ui/nav/Menu.ts"), true);
    assert.equal(pathInScope(scope, "src/api/server.ts"), false);
    assert.equal(patternWithinScope(scope, "src/ui/*.ts"), true);
    assert.equal(patternWithinScope(scope, "src/**"), false);
    assert.equal(patternWithinScope(["src/*"], "src/**"), false);
    assert.deepEqual(scopeDirectories(["src/ui/**", "src/ui/nav/*.ts", "docs/a.md"]), [
      "docs",
      "src/ui",
    ]);
    assert.deepEqual(scopeDirectories(["**"]), [""]);
  } finally {
    await removeProject(projectRoot);
  }
});

test("scope becomes the strongest available Claude and Codex CLI restriction", () => {
  const registry = loadAgentRegistry(defaultAgentsPath);
  const scope = { patterns: ["src/ui/**"], directories: ["/work/src/ui", "/work/docs"] };

  const claudeUnscoped = buildAgentCommand("claude", "hi", undefined, registry);
  assert.equal(
    claudeUnscoped.args[claudeUnscoped.args.indexOf("--permission-mode") + 1],
    "acceptEdits",
  );
  const claude = buildAgentCommand("claude", "hi", undefined, registry, scope);
  assert.equal(claude.args[claude.args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.ok(!claude.args.includes("acceptEdits"));
  assert.ok(claude.args.includes("Edit(src/ui/**)"));
  assert.ok(claude.args.includes("Write(src/ui/**)"));
  const claudeResume = buildAgentCommand("claude", "more", "s-1", registry, scope);
  assert.ok(claudeResume.args.includes("dontAsk"));

  const codexUnscoped = buildAgentCommand("codex", "hi", undefined, registry);
  assert.ok(!codexUnscoped.args.includes("--cd"));
  const codex = buildAgentCommand("codex", "hi", undefined, registry, scope);
  assert.equal(codex.args[codex.args.indexOf("--cd") + 1], "/work/src/ui");
  assert.ok(codex.args.includes("--add-dir=/work/docs"));
  assert.ok(codex.args.includes("sandbox_workspace_write.exclude_tmpdir_env_var=true"));
  assert.equal(codex.args[codex.args.indexOf("--sandbox") + 1], "workspace-write");
  assert.ok(codex.args.some((arg) => arg.includes("env_vars") && arg.includes("SHARELANE_TASK_ID")));
  const codexResume = buildAgentCommand("codex", "more", "s-1", registry, scope);
  assert.ok(codexResume.args.indexOf("--cd") < codexResume.args.indexOf("resume"));
  assert.equal(codexResume.args.at(-1), "more");
});

test("a scope overlapping another owner's claim refuses the delegation", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sharelane-scope-claim-"));
  const configPath = await writeScopedFakeConfig(projectRoot);
  try {
    claimPaths({ agent: "claude", paths: ["src/**"], intent: "refactor", projectRoot });
    assert.throws(
      () =>
        delegateTask({
          agent: "fake",
          callerAgent: "test",
          prompt: "build the navbar",
          scope: ["src/ui/**"],
          projectRoot,
          env: { SHARELANE_AGENTS_CONFIG: configPath },
        }),
      /Scope refused: "src\/ui\/\*\*" overlaps "src\/\*\*", held by claude/,
    );
    const database = openDatabase(projectRoot);
    try {
      const row = database.prepare("SELECT COUNT(*) AS count FROM tasks").get() as {
        count: number;
      };
      assert.equal(row.count, 0);
    } finally {
      database.close();
    }
  } finally {
    await removeProject(projectRoot);
  }
});

test("a worker scoped to src/ui/** cannot successfully change a file outside it", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sharelane-scope-e2e-"));
  const configPath = await writeScopedFakeConfig(projectRoot);
  const env = {
    SHARELANE_AGENTS_CONFIG: configPath,
    FAKE_AGENT_DELAY_MS: "1500",
    FAKE_EDIT_PATH: "src/ui/Button.ts,README.md",
    FAKE_EDIT_CONTENT: "worker copy\n",
    FAKE_REPORT_ARGS: "1",
  };
  try {
    await writeFile(join(projectRoot, "README.md"), "main readme\n", "utf8");
    git(projectRoot, "init", "-b", "main");
    git(projectRoot, "add", "README.md");
    git(projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial");

    const delegated = delegateTask({
      agent: "fake",
      callerAgent: "test",
      prompt: "build the navbar",
      scope: ["./src/ui/"],
      projectRoot,
      env,
    });
    assert.deepEqual(delegated.scope, ["src/ui/**"]);

    // Layer 1: the scope is claimed for the task before the worker edits anything.
    assert.deepEqual(
      listActiveClaims(projectRoot).map((claim) => [claim.taskId, claim.path]),
      [[delegated.id, "src/ui/**"]],
    );
    assert.throws(
      () => claimPaths({ agent: "codex", paths: ["src/ui/Button.ts"], intent: "x", projectRoot }),
      /Claim refused/,
    );
    // Layer 2: the worker itself cannot claim its way outside the scope.
    assert.throws(
      () =>
        claimPaths({
          agent: "fake",
          taskId: delegated.id,
          paths: ["README.md"],
          intent: "sneak",
          projectRoot,
        }),
      /outside this task's delegated scope/,
    );
    // Layer 3: the Claude edit hook blocks out-of-scope built-in edits.
    installClaudeClaimHook(projectRoot);
    const runHook = (file: string) =>
      spawnSync(
        process.execPath,
        [join(projectRoot, ".claude", "hooks", "sharelane-claim-guard.mjs")],
        {
          cwd: projectRoot,
          input: JSON.stringify({
            cwd: projectRoot,
            tool_name: "Write",
            tool_input: { file_path: join(projectRoot, file), content: "x" },
          }),
          env: {
            ...process.env,
            SHARELANE_PROJECT_ROOT: projectRoot,
            SHARELANE_AGENT: "fake",
            SHARELANE_TASK_ID: delegated.id,
          },
          encoding: "utf8",
        },
      );
    const blocked = runHook("README.md");
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, /outside this task's delegated scope \(src\/ui\/\*\*\)/);
    assert.equal(runHook("src/ui/Button.ts").status, 0);

    // Layer 4: a write the CLI and hook could not stop never reaches the task branch.
    const waited = await waitForTask(delegated.id, 20_000, projectRoot);
    assert.equal(waited.timedOut, false);
    const task = waited.task;
    assert.equal(task.status, "completed", task.error ?? "task failed");
    assert.match(task.result ?? "", /Your write scope is: src\/ui\/\*\*/);
    assert.match(task.result ?? "", /"--pattern=src\/ui\/\*\*"/);
    assert.match(task.result ?? "", /"--root=[^"]+src[\\/]+ui"/);

    assert.equal(await readFile(join(projectRoot, "README.md"), "utf8"), "main readme\n");
    assert.equal(git(projectRoot, "show", `${task.branchName}:README.md`), "main readme");
    assert.equal(git(projectRoot, "show", `${task.branchName}:src/ui/Button.ts`), "worker copy");
    assert.equal(
      git(projectRoot, "diff", "--name-only", `${task.baseCommit}..${task.resultCommit}`),
      "src/ui/Button.ts",
    );
    assert.deepEqual(task.changedFiles, ["src/ui/Button.ts"]);
    assert.deepEqual(task.scopeViolations, ["README.md"]);

    const patchPath = outOfScopePatchPath(task.id, projectRoot);
    assert.match(await readFile(patchPath, "utf8"), /README\.md[\s\S]*\+worker copy/);
    const notices = listTaskNotices(task.id, projectRoot);
    assert.ok(notices.some((n) => n.kind === "scope_violation" && n.message.includes("README.md")));
    assert.ok(!notices.some((n) => n.kind === "unclaimed_edit"));
    assert.deepEqual(listActiveClaims(projectRoot), []);

    const taskFile = await readFile(task.taskFile, "utf8");
    assert.match(taskFile, /- Scope: src\/ui\/\*\*/);
    assert.match(taskFile, /- Scope violations \(kept off the task branch\): README\.md/);

    // A follow-up re-claims the same scope and keeps enforcing it.
    const replied = replyToTask(task.id, "also add docs", {
      projectRoot,
      env: { ...env, FAKE_EDIT_PATH: "docs/notes.md,src/ui/Nav.ts" },
    });
    assert.deepEqual(replied.scope, ["src/ui/**"]);
    assert.deepEqual(listActiveClaims(projectRoot).map((claim) => claim.path), ["src/ui/**"]);
    const followUp = (await waitForTask(task.id, 20_000, projectRoot)).task;
    assert.equal(followUp.status, "completed", followUp.error ?? "follow-up failed");
    assert.deepEqual(followUp.scopeViolations, ["README.md", "docs/notes.md"]);
    assert.equal(git(projectRoot, "show", `${followUp.branchName}:src/ui/Nav.ts`), "worker copy");
    assert.throws(() => git(projectRoot, "show", `${followUp.branchName}:docs/notes.md`));
    assert.deepEqual(listActiveClaims(projectRoot), []);
    assert.equal(existsSync(followUp.worktreePath ?? ""), false);
  } finally {
    await removeProject(projectRoot);
  }
});

test("cancelling a scoped task still keeps out-of-scope work off its branch", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sharelane-scope-cancel-"));
  const configPath = await writeScopedFakeConfig(projectRoot);
  try {
    await writeFile(join(projectRoot, "README.md"), "main readme\n", "utf8");
    git(projectRoot, "init", "-b", "main");
    git(projectRoot, "add", "README.md");
    git(projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial");
    const delegated = delegateTask({
      agent: "fake",
      callerAgent: "test",
      prompt: "slow scoped work",
      scope: ["src/ui/**"],
      projectRoot,
      env: {
        SHARELANE_AGENTS_CONFIG: configPath,
        FAKE_EDIT_FIRST: "1",
        FAKE_AGENT_DELAY_MS: "60000",
        FAKE_EDIT_PATH: "src/ui/Button.ts,README.md",
      },
    });
    const readme = join(delegated.worktreePath ?? "", "README.md");
    const deadline = Date.now() + 40_000;
    // Git may check the file out with CRLF, so wait for the worker's own text.
    while (!(await readFile(readme, "utf8")).includes("edited by fake agent")) {
      if (Date.now() > deadline) {
        const current = getTask(delegated.id, projectRoot);
        throw new Error(
          `fake worker never edited README.md (status ${current.status}: ${current.error ?? "no error"})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(cancelTask(delegated.id, projectRoot).status, "cancelled");
    assert.deepEqual(getTask(delegated.id, projectRoot).scopeViolations, ["README.md"]);
    assert.equal(git(projectRoot, "show", `${delegated.branchName}:README.md`), "main readme");
    assert.ok(existsSync(outOfScopePatchPath(delegated.id, projectRoot)));
    assert.deepEqual(listActiveClaims(projectRoot), []);
  } finally {
    await removeProject(projectRoot);
  }
});

test("real-agent regressions: kept scope claims, context edits, link cleanup, worker notes", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sharelane-scope-real-"));
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
          workerNotes: ["Use file tools only in this fake run."],
          output: "codex-jsonl",
          instructionsFile: "AGENTS.md",
        },
      },
    }),
    "utf8",
  );
  try {
    // Like this repository: dependencies exist, so each worktree gets a node_modules link.
    await mkdir(join(projectRoot, "node_modules", "dep"), { recursive: true });
    await writeFile(join(projectRoot, "node_modules", "dep", "index.js"), "", "utf8");
    await writeFile(join(projectRoot, ".gitignore"), "node_modules/\nagents.yaml\n.sharelane/sharelane.db*\n.sharelane/tasks/\n", "utf8");
    await mkdir(join(projectRoot, ".sharelane", "context"), { recursive: true });
    await writeFile(join(projectRoot, ".sharelane", "context", "MAP.md"), "# map\n", "utf8");
    await writeFile(join(projectRoot, "README.md"), "main readme\n", "utf8");
    git(projectRoot, "init", "-b", "main");
    git(projectRoot, "add", ".");
    git(projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial");

    const env = {
      SHARELANE_AGENTS_CONFIG: configPath,
      FAKE_AGENT_DELAY_MS: "1500",
      FAKE_EDIT_PATH: "src/ui/Button.ts,.sharelane/context/MAP.md",
    };
    const delegated = delegateTask({
      agent: "fake",
      callerAgent: "test",
      prompt: "build the button",
      scope: ["src/ui/**"],
      projectRoot,
      env,
    });
    // A worker releasing its own claims (as real agents do) keeps the scope claim.
    claimPaths({ agent: "fake", taskId: delegated.id, paths: ["src/ui/Extra.ts"], intent: "extra", projectRoot });
    assert.equal(releaseClaims({ agent: "fake", taskId: delegated.id, projectRoot, keepScope: true }), 1);
    assert.deepEqual(listActiveClaims(projectRoot).map((claim) => claim.path), ["src/ui/**"]);

    const task = (await waitForTask(delegated.id, 20_000, projectRoot)).task;
    assert.equal(task.status, "completed", task.error ?? "task failed");
    assert.match(task.result ?? "", /- Use file tools only in this fake run\./);
    assert.deepEqual(task.scopeViolations, []);
    assert.deepEqual(task.changedFiles, [".sharelane/context/MAP.md", "src/ui/Button.ts"]);
    const notices = listTaskNotices(task.id, projectRoot).map((notice) => notice.kind);
    assert.ok(!notices.includes("unclaimed_edit"), notices.join(", "));
    assert.ok(!notices.includes("scope_violation"), notices.join(", "));
    // The dependency link no longer leaves the temporary folder behind...
    assert.equal(existsSync(task.worktreePath ?? ""), false);
    assert.ok(existsSync(join(projectRoot, "node_modules", "dep", "index.js")), "link target must survive");

    // ...and a follow-up can recreate it even if an older run left one.
    await mkdir(task.worktreePath ?? "", { recursive: true });
    replyToTask(task.id, "follow up", { projectRoot, env: { ...env, FAKE_EDIT_PATH: "src/ui/Nav.ts" } });
    const followUp = (await waitForTask(task.id, 20_000, projectRoot)).task;
    assert.equal(followUp.status, "completed", followUp.error ?? "follow-up failed");
    assert.equal(existsSync(followUp.worktreePath ?? ""), false);
  } finally {
    await removeProject(projectRoot);
  }
});
