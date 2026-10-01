#!/usr/bin/env node

import { mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { scopeDirectories } from "./core/scope.js";

import { getAgentAdapter } from "./adapters/adapter.js";
import { runAgent } from "./core/runner.js";
import { contextMap } from "./core/memory.js";
import { heartbeatClaims, releaseClaims } from "./core/claims.js";
import { createNotice } from "./core/notices.js";
import { watchTaskEdits } from "./core/collisions.js";
import { finalizeTaskWorkspace } from "./core/worktrees.js";
import {
  completeTask,
  failTask,
  getTask,
  latestTaskPrompt,
  markTaskRunning,
  outOfScopePatchPath,
  recordTaskWorkspaceResult,
  setTaskAgentProcess,
} from "./core/tasks.js";

function scopeInstructions(scope: string[] | undefined): string[] {
  if (!scope) return [];
  return [
    `- Your write scope is: ${scope.join(", ")}. ShareLane already claimed it for this task; only claim files inside it.`,
    "- Do not change files outside that scope. Your CLI permissions or ShareLane's hook block such edits, and any that slip through are removed from the task branch and reported.",
  ];
}

function delegatedPrompt(
  taskId: string,
  request: string,
  projectRoot: string,
  scope?: string[],
  workerNotes: string[] = [],
): string {
  return [
    "You are a ShareLane delegated worker.",
    `Task ID: ${taskId}`,
    "",
    "Task instructions:",
    "- Complete the request in the current project and verify your work.",
    "- Use the context map below to choose any relevant context chunks; do not read every chunk automatically.",
    "- Minimize token overhead: inspect only the context, files, and command output needed for this task; do not reread unchanged material or dump large logs.",
    "- Complete the task yourself by default; delegate again only when another agent adds clear specialist or parallel value.",
    "- Record meaningful progress with ShareLane's log_progress tool.",
    "- Before editing, call ShareLane's claim tool with the exact files or narrow path patterns you will change and a short intent. Overlapping claims are refused.",
    "- Keep claims alive with heartbeat during long work and release them when finished. ShareLane also refreshes task claims automatically.",
    "- You are working in an isolated Git worktree. ShareLane will save changes on the task branch and hand the commit back; do not merge it yourself.",
    ...scopeInstructions(scope),
    ...workerNotes.map((note) => `- ${note}`),
    "- Update relevant shared context when your work changes what future agents need to know.",
    "- Keep progress notes and the final summary concise, while still stating what changed and what checks passed.",
    "",
    "Request:",
    request,
    "",
    "Project context map:",
    contextMap(projectRoot),
  ].join("\n");
}

async function main(): Promise<void> {
  const taskId = process.argv[2] || process.env.SHARELANE_TASK_ID;
  const projectRoot =
    process.argv[3] || process.env.SHARELANE_PROJECT_ROOT || process.cwd();
  const configPath = process.argv[4];
  if (!taskId) throw new Error("The worker needs a task ID.");
  if (configPath) process.env.SHARELANE_AGENTS_CONFIG = configPath;

  const task = markTaskRunning(taskId, projectRoot);
  if (task.status !== "running") return;
  const workspaceRoot = task.worktreePath ?? projectRoot;
  process.chdir(workspaceRoot);
  process.env.SHARELANE_PROJECT_ROOT = projectRoot;
  process.env.SHARELANE_WORKSPACE_ROOT = workspaceRoot;
  process.env.SHARELANE_TASK_ID = task.id;
  process.env.SHARELANE_AGENT = task.agent;
  process.env.SHARELANE_PARENT = task.parentId ?? "";
  process.env.SHARELANE_DEPTH = String(task.depth);
  const watcher = watchTaskEdits({
    taskId: task.id,
    agent: task.agent,
    projectRoot,
    worktreePath: task.worktreePath,
    baseCommit: task.baseCommit,
    scope: task.scope,
  });
  const heartbeat = setInterval(() => {
    try {
      heartbeatClaims({
        agent: task.agent,
        taskId: task.id,
        projectRoot,
      });
    } catch {
      // A later ShareLane call or final release will report persistent failures.
    }
  }, 30_000);
  heartbeat.unref();

  const saveAndCleanWorkspace = (): void => {
    watcher.stop();
    // Windows cannot remove a worktree while this supervisor's cwd is inside it.
    process.chdir(projectRoot);
    const finalized = finalizeTaskWorkspace({
      projectRoot,
      taskId: task.id,
      worktreePath: task.worktreePath,
      baseCommit: task.baseCommit,
      scope: task.scope,
      patchPath: outOfScopePatchPath(task.id, projectRoot),
    });
    recordTaskWorkspaceResult(task.id, finalized, projectRoot);
    if (finalized.blockedFiles.length > 0) {
      createNotice({
        projectRoot,
        recipientAgent: task.callerAgent,
        taskId: task.id,
        kind: "scope_violation",
        message: `Task ${task.id} changed ${finalized.blockedFiles.join(", ")} outside its scope (${task.scope?.join(", ")}). Those changes were kept off ${task.branchName ?? "the task branch"} and saved to ${relative(projectRoot, outOfScopePatchPath(task.id, projectRoot)).replaceAll("\\", "/")}.`,
      });
    }
    if (!finalized.cleanedUp && task.worktreePath) {
      createNotice({
        projectRoot,
        recipientAgent: task.callerAgent,
        taskId: task.id,
        kind: "worktree_cleanup_failed",
        message: `Task changes were saved on ${task.branchName}, but ShareLane could not remove ${task.worktreePath}.`,
      });
    }
  };
  try {
    const latestPrompt = latestTaskPrompt(task.id, projectRoot);
    const directories = task.scope
      ? scopeDirectories(task.scope).map((directory) => join(workspaceRoot, directory))
      : [];
    // Sandboxed CLIs refuse a missing working folder, so create scope folders first.
    for (const directory of directories) mkdirSync(directory, { recursive: true });
    const result = await runAgent({
      agent: task.agent,
      prompt: task.sessionId
        ? latestPrompt
        : delegatedPrompt(
            task.id,
            latestPrompt,
            projectRoot,
            task.scope,
            getAgentAdapter(task.agent).workerNotes,
          ),
      projectRoot: workspaceRoot,
      sessionId: task.sessionId,
      scope: task.scope ? { patterns: task.scope, directories } : undefined,
      logPath: task.logPath,
      onSpawn: (processId) => setTaskAgentProcess(task.id, processId, projectRoot),
    });
    saveAndCleanWorkspace();
    clearInterval(heartbeat);
    releaseClaims({ agent: task.agent, taskId: task.id, projectRoot });
    completeTask(
      task.id,
      result.finalMessage,
      result.sessionId,
      result.usage,
      projectRoot,
    );
  } catch (error) {
    clearInterval(heartbeat);
    const message = error instanceof Error ? error.message : String(error);
    try {
      if (getTask(task.id, projectRoot).status === "running") {
        saveAndCleanWorkspace();
      }
    } catch (workspaceError) {
      createNotice({
        projectRoot,
        recipientAgent: task.agent,
        taskId: task.id,
        kind: "worktree_cleanup_failed",
        message: `ShareLane could not safely save and remove the task worktree: ${workspaceError instanceof Error ? workspaceError.message : String(workspaceError)}. The worktree was left in place for recovery.`,
      });
    }
    releaseClaims({ agent: task.agent, taskId: task.id, projectRoot });
    if (getTask(task.id, projectRoot).status !== "cancelled") {
      failTask(task.id, message, projectRoot);
    }
  }
}

main().catch((error: unknown) => {
  const taskId = process.argv[2] || process.env.SHARELANE_TASK_ID;
  const projectRoot =
    process.argv[3] || process.env.SHARELANE_PROJECT_ROOT || process.cwd();
  const message = error instanceof Error ? error.message : String(error);
  if (taskId) {
    try {
      const task = getTask(taskId, projectRoot);
      releaseClaims({ agent: task.agent, taskId, projectRoot });
      if (getTask(taskId, projectRoot).status !== "cancelled") {
        failTask(taskId, message, projectRoot);
      }
    } catch {
      // There is no task record to update, so stderr is the only fallback.
    }
  }
  console.error(`ShareLane worker failed: ${message}`);
  process.exitCode = 1;
});
