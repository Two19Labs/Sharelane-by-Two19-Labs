import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentAdapter, loadAgentRegistry } from "../adapters/adapter.js";
import type { AgentUsage } from "../adapters/result.js";
import { getShareLanePaths, openDatabase } from "./database.js";

export type TaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface TaskMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface ShareLaneTask {
  id: string;
  agent: string;
  prompt: string;
  status: TaskStatus;
  parentId?: string;
  depth: number;
  sessionId?: string;
  result?: string;
  error?: string;
  usage?: AgentUsage;
  taskFile: string;
  logPath: string;
  workerPid?: number;
  agentPid?: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}

interface TaskRow {
  id: string;
  agent: string;
  prompt: string;
  status: TaskStatus;
  parent_id: string | null;
  depth: number;
  session_id: string | null;
  result: string | null;
  error: string | null;
  usage_json: string | null;
  task_file: string;
  log_path: string;
  worker_pid: number | null;
  agent_pid: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

interface MessageRow {
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

export interface DelegateTaskInput {
  agent: string;
  prompt: string;
  projectRoot?: string;
  parentId?: string;
  depth?: number;
  env?: NodeJS.ProcessEnv;
}

export interface TaskActionOptions {
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
}

export interface WaitTaskResult {
  task: ShareLaneTask;
  timedOut: boolean;
}

const terminalStatuses = new Set<TaskStatus>([
  "completed",
  "failed",
  "cancelled",
]);
const tsxPath = fileURLToPath(
  new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url),
);
const workerPath = fileURLToPath(new URL("../worker.ts", import.meta.url));

function fromRow(row: TaskRow): ShareLaneTask {
  return {
    id: row.id,
    agent: row.agent,
    prompt: row.prompt,
    status: row.status,
    parentId: row.parent_id ?? undefined,
    depth: row.depth,
    sessionId: row.session_id ?? undefined,
    result: row.result ?? undefined,
    error: row.error ?? undefined,
    usage: row.usage_json
      ? (JSON.parse(row.usage_json) as AgentUsage)
      : undefined,
    taskFile: row.task_file,
    logPath: row.log_path,
    workerPid: row.worker_pid ?? undefined,
    agentPid: row.agent_pid ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

export function listTaskMessages(
  taskId: string,
  projectRoot = process.cwd(),
): TaskMessage[] {
  const database = openDatabase(projectRoot);
  try {
    const rows = database
      .prepare(
        "SELECT role, content, created_at FROM task_messages WHERE task_id = ? ORDER BY id",
      )
      .all(taskId) as unknown as MessageRow[];
    return rows.map((row) => ({
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
    }));
  } finally {
    database.close();
  }
}

function taskMarkdown(task: ShareLaneTask, projectRoot: string): string {
  const lines = [
    `# Task ${task.id}`,
    "",
    `- Agent: ${task.agent}`,
    `- Status: ${task.status}`,
    `- Depth: ${task.depth}`,
    `- Created: ${task.createdAt}`,
    `- Updated: ${task.updatedAt}`,
    `- Log: ${relative(projectRoot, task.logPath).replaceAll("\\", "/")}`,
  ];
  if (task.parentId) lines.push(`- Parent: ${task.parentId}`);
  if (task.sessionId) lines.push(`- Session: ${task.sessionId}`);
  if (task.startedAt) lines.push(`- Started: ${task.startedAt}`);
  if (task.finishedAt) lines.push(`- Finished: ${task.finishedAt}`);

  const messages = listTaskMessages(task.id, projectRoot);
  lines.push("", "## Conversation");
  for (const message of messages) {
    lines.push(
      "",
      `### ${message.role === "user" ? "Request" : "Agent reply"}`,
      "",
      message.content,
    );
  }
  if (task.error) lines.push("", "## Error", "", task.error);
  return `${lines.join("\n")}\n`;
}

function writeTaskFile(task: ShareLaneTask, projectRoot: string): void {
  mkdirSync(dirname(task.taskFile), { recursive: true });
  const temporary = `${task.taskFile}.${process.pid}.tmp`;
  writeFileSync(temporary, taskMarkdown(task, projectRoot), "utf8");
  renameSync(temporary, task.taskFile);
}

export function getTask(
  taskId: string,
  projectRoot = process.cwd(),
): ShareLaneTask {
  const database = openDatabase(projectRoot);
  try {
    const row = database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | TaskRow
      | undefined;
    if (!row) throw new Error(`Unknown task "${taskId}".`);
    return fromRow(row);
  } finally {
    database.close();
  }
}

function updateTask(
  taskId: string,
  fields: Record<string, string | number | null>,
  projectRoot: string,
  onlyWhen?: TaskStatus[],
): { task: ShareLaneTask; changed: boolean } {
  const allowed = new Set([
    "status",
    "session_id",
    "result",
    "error",
    "usage_json",
    "worker_pid",
    "agent_pid",
    "started_at",
    "finished_at",
    "updated_at",
  ]);
  const entries = Object.entries(fields);
  if (entries.some(([name]) => !allowed.has(name))) {
    throw new Error("Attempted to update an unsupported task field.");
  }
  const database = openDatabase(projectRoot);
  let changed = false;
  try {
    const assignments = entries.map(([name]) => `${name} = ?`).join(", ");
    const statusClause = onlyWhen?.length
      ? ` AND status IN (${onlyWhen.map(() => "?").join(", ")})`
      : "";
    const result = database
      .prepare(`UPDATE tasks SET ${assignments} WHERE id = ?${statusClause}`)
      .run(
        ...entries.map(([, value]) => value),
        taskId,
        ...(onlyWhen ?? []),
      );
    changed = result.changes > 0;
  } finally {
    database.close();
  }
  const task = getTask(taskId, projectRoot);
  writeTaskFile(task, projectRoot);
  return { task, changed };
}

function launchTaskWorker(
  task: ShareLaneTask,
  projectRoot: string,
  env?: NodeJS.ProcessEnv,
): ShareLaneTask {
  const child = spawn(process.execPath, [tsxPath, workerPath, task.id], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...env,
      SHARELANE_PROJECT_ROOT: projectRoot,
      SHARELANE_TASK_ID: task.id,
      SHARELANE_AGENT: task.agent,
      SHARELANE_PARENT: task.parentId ?? "",
      SHARELANE_DEPTH: String(task.depth),
    },
    detached: true,
    shell: false,
    windowsHide: true,
    stdio: "ignore",
  });
  child.once("error", (error) => {
    failTask(task.id, `Could not start task worker: ${error.message}`, projectRoot);
  });
  child.unref();
  return updateTask(
    task.id,
    { worker_pid: child.pid ?? null, updated_at: new Date().toISOString() },
    projectRoot,
    ["queued"],
  ).task;
}

export function markTaskRunning(
  taskId: string,
  projectRoot: string,
): ShareLaneTask {
  const now = new Date().toISOString();
  return updateTask(
    taskId,
    {
      status: "running",
      started_at: now,
      finished_at: null,
      updated_at: now,
    },
    projectRoot,
    ["queued"],
  ).task;
}

export function setTaskAgentProcess(
  taskId: string,
  processId: number | undefined,
  projectRoot: string,
): void {
  if (processId === undefined) return;
  updateTask(
    taskId,
    { agent_pid: processId, updated_at: new Date().toISOString() },
    projectRoot,
    ["running"],
  );
}

export function completeTask(
  taskId: string,
  result: string,
  sessionId: string,
  usage: AgentUsage,
  projectRoot: string,
): ShareLaneTask {
  const now = new Date().toISOString();
  const database = openDatabase(projectRoot);
  let changed = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    const updated = database
      .prepare(
        `UPDATE tasks SET status = 'completed', result = ?, session_id = ?,
          usage_json = ?, agent_pid = NULL, worker_pid = NULL,
          finished_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(result, sessionId, JSON.stringify(usage), now, now, taskId);
    changed = updated.changes > 0;
    if (changed) {
      database
        .prepare(
          "INSERT INTO task_messages (task_id, role, content, created_at) VALUES (?, 'assistant', ?, ?)",
        )
        .run(taskId, result, now);
    }
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original database error.
    }
    throw error;
  } finally {
    database.close();
  }
  const task = getTask(taskId, projectRoot);
  if (changed) writeTaskFile(task, projectRoot);
  return task;
}

export function failTask(
  taskId: string,
  error: string,
  projectRoot: string,
): ShareLaneTask {
  const now = new Date().toISOString();
  return updateTask(
    taskId,
    {
      status: "failed",
      error,
      agent_pid: null,
      worker_pid: null,
      finished_at: now,
      updated_at: now,
    },
    projectRoot,
    ["queued", "running"],
  ).task;
}

export function delegateTask(input: DelegateTaskInput): ShareLaneTask {
  const projectRoot = input.projectRoot ?? process.cwd();
  const registry = loadAgentRegistry(
    input.env?.SHARELANE_AGENTS_CONFIG ?? process.env.SHARELANE_AGENTS_CONFIG,
  );
  getAgentAdapter(input.agent, registry);

  const id = `task-${randomUUID()}`;
  const now = new Date().toISOString();
  const paths = getShareLanePaths(projectRoot);
  const taskFile = join(paths.tasksDir, `${id}.md`);
  const logPath = join(paths.tasksDir, `${id}.log`);
  const task: ShareLaneTask = {
    id,
    agent: input.agent,
    prompt: input.prompt,
    status: "queued",
    parentId: input.parentId,
    depth: input.depth ?? 1,
    taskFile,
    logPath,
    createdAt: now,
    updatedAt: now,
  };

  mkdirSync(paths.tasksDir, { recursive: true });
  const database = openDatabase(projectRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    database
      .prepare(
        `INSERT INTO tasks (
          id, agent, prompt, status, parent_id, depth, task_file, log_path,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.agent,
        task.prompt,
        task.status,
        task.parentId ?? null,
        task.depth,
        task.taskFile,
        task.logPath,
        task.createdAt,
        task.updatedAt,
      );
    database
      .prepare(
        "INSERT INTO task_messages (task_id, role, content, created_at) VALUES (?, 'user', ?, ?)",
      )
      .run(task.id, task.prompt, now);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original database error.
    }
    throw error;
  } finally {
    database.close();
  }
  writeTaskFile(task, projectRoot);
  return launchTaskWorker(task, projectRoot, input.env);
}

export function replyToTask(
  taskId: string,
  message: string,
  options: TaskActionOptions = {},
): ShareLaneTask {
  const projectRoot = options.projectRoot ?? process.cwd();
  const task = getTask(taskId, projectRoot);
  if (task.status !== "completed" || !task.sessionId) {
    throw new Error(
      `Task "${taskId}" must be completed with a saved session before replying. Current status: ${task.status}.`,
    );
  }

  const now = new Date().toISOString();
  const database = openDatabase(projectRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    const updated = database
      .prepare(
        `UPDATE tasks SET status = 'queued', result = NULL, error = NULL,
          worker_pid = NULL, agent_pid = NULL, finished_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'completed'`,
      )
      .run(now, taskId);
    if (updated.changes === 0) {
      throw new Error(`Task "${taskId}" changed before the reply could be queued.`);
    }
    database
      .prepare(
        "INSERT INTO task_messages (task_id, role, content, created_at) VALUES (?, 'user', ?, ?)",
      )
      .run(taskId, message, now);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original database error.
    }
    throw error;
  } finally {
    database.close();
  }
  const queued = getTask(taskId, projectRoot);
  writeTaskFile(queued, projectRoot);
  return launchTaskWorker(queued, projectRoot, options.env);
}

export async function waitForTask(
  taskId: string,
  timeoutMilliseconds = 30_000,
  projectRoot = process.cwd(),
): Promise<WaitTaskResult> {
  const deadline = Date.now() + Math.max(0, timeoutMilliseconds);
  while (true) {
    const task = getTask(taskId, projectRoot);
    if (terminalStatuses.has(task.status)) return { task, timedOut: false };
    if (Date.now() >= deadline) return { task, timedOut: true };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function stopProcess(processId: number | undefined): void {
  if (processId === undefined || processId === process.pid) return;
  try {
    process.kill(processId, "SIGTERM");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EINVAL") throw error;
  }
}

export function cancelTask(
  taskId: string,
  projectRoot = process.cwd(),
): ShareLaneTask {
  const before = getTask(taskId, projectRoot);
  if (terminalStatuses.has(before.status)) {
    throw new Error(
      `Task "${taskId}" is already ${before.status} and cannot be cancelled.`,
    );
  }
  const now = new Date().toISOString();
  const cancelled = updateTask(
    taskId,
    {
      status: "cancelled",
      agent_pid: null,
      worker_pid: null,
      finished_at: now,
      updated_at: now,
    },
    projectRoot,
    ["queued", "running"],
  );
  if (!cancelled.changed) {
    throw new Error(`Task "${taskId}" changed before it could be cancelled.`);
  }
  stopProcess(before.agentPid);
  stopProcess(before.workerPid);
  return cancelled.task;
}

export function latestTaskPrompt(
  taskId: string,
  projectRoot = process.cwd(),
): string {
  const messages = listTaskMessages(taskId, projectRoot);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message.content;
  }
  throw new Error(`Task "${taskId}" has no request message.`);
}
