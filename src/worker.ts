#!/usr/bin/env node

import { runAgent } from "./core/runner.js";
import {
  completeTask,
  failTask,
  getTask,
  latestTaskPrompt,
  markTaskRunning,
  setTaskAgentProcess,
} from "./core/tasks.js";

async function main(): Promise<void> {
  const taskId = process.argv[2] || process.env.SHARELANE_TASK_ID;
  const projectRoot = process.env.SHARELANE_PROJECT_ROOT || process.cwd();
  if (!taskId) throw new Error("The worker needs a task ID.");

  const task = markTaskRunning(taskId, projectRoot);
  if (task.status !== "running") return;
  try {
    const result = await runAgent({
      agent: task.agent,
      prompt: latestTaskPrompt(task.id, projectRoot),
      projectRoot,
      sessionId: task.sessionId,
      logPath: task.logPath,
      onSpawn: (processId) => setTaskAgentProcess(task.id, processId, projectRoot),
    });
    completeTask(
      task.id,
      result.finalMessage,
      result.sessionId,
      result.usage,
      projectRoot,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (getTask(task.id, projectRoot).status !== "cancelled") {
      failTask(task.id, message, projectRoot);
    }
  }
}

main().catch((error: unknown) => {
  const taskId = process.argv[2] || process.env.SHARELANE_TASK_ID;
  const projectRoot = process.env.SHARELANE_PROJECT_ROOT || process.cwd();
  const message = error instanceof Error ? error.message : String(error);
  if (taskId) {
    try {
      getTask(taskId, projectRoot);
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
