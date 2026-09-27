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

export interface DelegateTaskInput {
  agent: string;
  prompt: string;
  projectRoot?: string;
  parentId?: string;
  depth?: number;
  env?: NodeJS.ProcessEnv;
}

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
  lines.push("", "## Request", "", task.prompt);
  if (task.result) lines.push("", "## Result", "", task.result);
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
): ShareLaneTask {
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
  try {
    const assignments = entries.map(([name]) => `${name} = ?`).join(", ");
    database
      .prepare(`UPDATE tasks SET ${assignments} WHERE id = ?`)
      .run(...entries.map(([, value]) => value), taskId);
  } finally {
    database.close();
  }
  const task = getTask(taskId, projectRoot);
  writeTaskFile(task, projectRoot);
  return task;
}

export function markTaskRunning(
  taskId: string,
  projectRoot: string,
): ShareLaneTask {
  const now = new Date().toISOString();
  return updateTask(
    taskId,
    { status: "running", started_at: now, updated_at: now },
    projectRoot,
  );
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
  return updateTask(
    taskId,
    {
      status: "completed",
      result,
      session_id: sessionId,
      usage_json: JSON.stringify(usage),
      agent_pid: null,
      finished_at: now,
      updated_at: now,
    },
    projectRoot,
  );
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
      finished_at: now,
      updated_at: now,
    },
    projectRoot,
  );
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
  } finally {
    database.close();
  }
  writeTaskFile(task, projectRoot);

  const child = spawn(process.execPath, [tsxPath, workerPath, task.id], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...input.env,
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
  );
}
