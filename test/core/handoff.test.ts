import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { stringify } from "yaml";
import { listActiveClaims } from "../../src/core/claims.js";
import { listTaskNotices } from "../../src/core/notices.js";
import {
  delegateTask,
  getTaskLineage,
  handoffNotePath,
  isAllowanceError,
  reassignTask,
  waitForTask,
} from "../../src/core/tasks.js";

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "fake-agent.mjs",
);

function git(projectRoot: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", projectRoot, ...args], { encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

/** A fake agent; extra run arguments switch on the QUOTA or HANDOFF behaviour. */
function fakeAgent(extra: string[] = [], quota?: "codex") {
  return {
    displayName: "Fake",
    command: process.execPath,
    run: { args: [fixturePath, "codex-jsonl", "{prompt}", "", ...extra] },
    resume: { args: [fixturePath, "codex-jsonl", "{prompt}", "{session}"] },
    ...(quota ? { quota } : {}),
    output: "codex-jsonl",
    instructionsFile: "AGENTS.md",
  };
}

async function project(agents: Record<string, object>): Promise<{ root: string; env: NodeJS.ProcessEnv }> {
  const root = await mkdtemp(join(tmpdir(), "sharelane-handoff-"));
  const configPath = join(root, "agents.yaml");
  await writeFile(configPath, stringify({ version: 1, agents }), "utf8");
  await writeFile(join(root, ".gitignore"), "agents.yaml\ncodex-home/\n.sharelane/\n", "utf8");
  await writeFile(join(root, "README.md"), "start\n", "utf8");
  git(root, "init", "-b", "main");
  git(root, "add", ".");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial");
  // An agent whose quota reader is "codex" sees this home: credits depleted just now.
  const codexHome = join(root, "codex-home");
  await mkdir(join(codexHome, "sessions", "2026", "10", "02"), { recursive: true });
  await writeFile(
    join(codexHome, "sessions", "2026", "10", "02", "rollout.jsonl"),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: { primary: null, secondary: null, rate_limit_reached_type: "workspace_member_credits_depleted" },
      },
    }),
    "utf8",
  );
  return { root, env: { SHARELANE_AGENTS_CONFIG: configPath, CODEX_HOME: codexHome } };
}

async function cleanup(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

test("allowance errors are recognised, ordinary failures are not", () => {
  assert.ok(isAllowanceError("codex exited with code 1. Output: {\"message\":\"Your workspace is out of credits.\"}"));
  assert.ok(isAllowanceError("You've hit your usage limit. Try again at 3pm."));
  assert.ok(isAllowanceError("429 Too Many Requests"));
  assert.ok(!isAllowanceError("TypeError: cannot read properties of undefined"));
});

test("an agent that runs out of credits mid-task is taken over on the same branch", async () => {
  const { root, env } = await project({ quitter: fakeAgent(["QUOTA"]), finisher: fakeAgent() });
  try {
    const delegated = delegateTask({
      agent: "quitter",
      callerAgent: "test",
      prompt: "build the widget",
      scope: ["work/**"],
      projectRoot: root,
      env: { ...env, FAKE_EDIT_PATH: "work/widget.txt" },
    });
    const task = (await waitForTask(delegated.id, 30_000, root)).task;
    assert.equal(task.status, "completed", task.error ?? "task did not complete");
    assert.equal(task.agent, "finisher");
    assert.equal(task.reassignments, 1);
    assert.match(task.handoffReason ?? "", /quitter ran out of allowance: .*out of credits/);
    // The new agent started from the handoff, which carries the original request.
    assert.match(task.result ?? "", /handed this task to you from quitter/);
    assert.match(task.result ?? "", /## Original request\n\nbuild the widget/);
    assert.deepEqual(getTaskLineage(task.id, root), ["test", "finisher"]);
    assert.equal(task.totalUsage.runs, 2);
    assert.equal(task.totalUsage.runsWithoutUsage, 1, "the run that died reported no usage");
    // The quitter's work was saved before the handoff and survives on the same branch.
    assert.match(git(root, "log", "--format=%s", task.branchName ?? ""), /save task-/);
    assert.equal(git(root, "show", `${task.branchName}:work/widget.txt`), "edited by fake agent");
    assert.ok(existsSync(handoffNotePath(task.id, root)));
    assert.ok(listTaskNotices(task.id, root).some((notice) => notice.kind === "handoff" && /quitter to finisher/.test(notice.message)));
    assert.deepEqual(listActiveClaims(root), []);
    assert.equal(existsSync(task.worktreePath ?? ""), false);
  } finally {
    await cleanup(root);
  }
});

test("with nobody available the task waits, skips agents out of allowance, and can be reassigned by hand", async () => {
  const { root, env } = await project({
    quitter: fakeAgent(["QUOTA"]),
    caller: fakeAgent(),
    spare: fakeAgent([], "codex"),
  });
  try {
    const delegated = delegateTask({
      agent: "quitter",
      callerAgent: "caller",
      prompt: "tidy the docs",
      projectRoot: root,
      env,
    });
    const waiting = (await waitForTask(delegated.id, 30_000, root)).task;
    assert.equal(waiting.status, "needs_reassignment");
    assert.match(waiting.handoffReason ?? "", /out of credits/);
    const notice = listTaskNotices(delegated.id, root).find((item) => item.kind === "handoff");
    assert.match(notice?.message ?? "", /no other agent is available \(skipped: spare \(Codex reported workspace member credits depleted\)\)/);
    const note = await readFile(handoffNotePath(delegated.id, root), "utf8");
    assert.match(note, /- From: quitter/);
    assert.match(note, /## Original request\n\ntidy the docs/);

    await assert.rejects(
      reassignTask(delegated.id, { projectRoot: root, env, agent: "caller" }),
      /already in this task's delegation chain/,
    );
    // Once spare's credits are topped up, a person can hand the task to it.
    await writeFile(
      join(env.CODEX_HOME ?? "", "sessions", "2026", "10", "02", "rollout.jsonl"),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            primary: { used_percent: 10, window_minutes: 300, resets_at: Math.round(Date.now() / 1000) + 3600 },
            secondary: { used_percent: 20, window_minutes: 10080, resets_at: Math.round(Date.now() / 1000) + 86400 },
            rate_limit_reached_type: null,
          },
        },
      }),
      "utf8",
    );
    await reassignTask(delegated.id, { projectRoot: root, env, agent: "spare" });
    const done = (await waitForTask(delegated.id, 30_000, root)).task;
    assert.equal(done.status, "completed", done.error ?? "manual reassignment failed");
    assert.equal(done.agent, "spare");
  } finally {
    await cleanup(root);
  }
});

test("a checkpoint HANDOFF reply and an already-exhausted agent both hand off cleanly", async () => {
  // finisher is listed first, so it is the automatic choice for both handoffs.
  const { root, env } = await project({
    finisher: fakeAgent(),
    checkpointer: fakeAgent(["HANDOFF"]),
    exhausted: fakeAgent([], "codex"),
  });
  try {
    const stopped = delegateTask({ agent: "checkpointer", callerAgent: "test", prompt: "first job", projectRoot: root, env });
    const exhausted = delegateTask({ agent: "exhausted", callerAgent: "test", prompt: "second job", projectRoot: root, env });
    const [first, second] = await Promise.all([
      waitForTask(stopped.id, 30_000, root),
      waitForTask(exhausted.id, 30_000, root),
    ]);
    assert.equal(first.task.status, "completed", first.task.error ?? "");
    assert.match(first.task.handoffReason ?? "", /checkpointer stopped at a checkpoint to hand off: five-hour window at 5% remaining/);
    assert.match(first.task.result ?? "", /## Last reply from the previous agent\n\nHANDOFF:/);
    assert.equal(first.task.agent, "finisher");

    assert.equal(second.task.status, "completed", second.task.error ?? "");
    assert.match(second.task.handoffReason ?? "", /exhausted was at its allowance threshold before starting/);
    assert.equal(second.task.agent, "finisher");
    assert.equal(second.task.totalUsage.runs, 1, "the exhausted agent was never started");
  } finally {
    await cleanup(root);
  }
});
