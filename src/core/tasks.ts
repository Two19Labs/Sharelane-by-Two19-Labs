import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentAdapter, loadAgentRegistry } from "../adapters/adapter.js";
import type { AgentUsage } from "../adapters/result.js";
import { findSimilarActiveTasks } from "./collisions.js";
import { releaseClaims } from "./claims.js";
import { getShareLanePaths, openDatabase } from "./database.js";
import { createNotice } from "./notices.js";
import {
  createTaskWorkspace,
  finalizeTaskWorkspace,
  type FinalizedWorkspace,
} from "./worktrees.js";

export type TaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "orphaned";

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
  callerAgent?: string;
  sourceRoot?: string;
  worktreePath?: string;
  branchName?: string;
  baseCommit?: string;
  resultCommit?: string;
  changedFiles: string[];
  duplicateWarnings?: string[];
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
  caller_agent: string | null;
  source_root: string | null;
  worktree_path: string | null;
  branch_name: string | null;
  base_commit: string | null;
  result_commit: string | null;
  changed_files_json: string | null;
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
  callerAgent?: string;
  sourceRoot?: string;
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
  "orphaned",
]);
const persistedTerminalStatuses = new Set<TaskStatus>([
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
    callerAgent: row.caller_agent ?? undefined,
    sourceRoot: row.source_root ?? undefined,
    worktreePath: row.worktree_path ?? undefined,
    branchName: row.branch_name ?? undefined,
    baseCommit: row.base_commit ?? undefined,
    resultCommit: row.result_commit ?? undefined,
    changedFiles: row.changed_files_json
      ? (JSON.parse(row.changed_files_json) as string[])
      : [],
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

export function getTaskLineage(
  taskId: string,
  projectRoot = process.cwd(),
): string[] {
  const database = openDatabase(projectRoot);
  try {
    const rows = database
      .prepare(
        "SELECT agent FROM task_lineage WHERE task_id = ? ORDER BY position",
      )
      .all(taskId) as unknown as Array<{ agent: string }>;
    return rows.map((row) => row.agent);
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
  if (task.branchName) lines.push(`- Task branch: ${task.branchName}`);
  if (task.baseCommit) lines.push(`- Started from: ${task.baseCommit}`);
  if (task.resultCommit) lines.push(`- Result commit: ${task.resultCommit}`);
  if (task.worktreePath) lines.push(`- Temporary worktree: ${task.worktreePath}`);
  if (task.changedFiles.length > 0) {
    lines.push(`- Changed files: ${task.changedFiles.join(", ")}`);
  }
  const lineage = getTaskLineage(task.id, projectRoot);
  if (lineage.length > 0) lines.push(`- Agent path: ${lineage.join(" -> ")}`);

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
    const task = fromRow(row);
    if (
      (task.status === "queued" || task.status === "running") &&
      task.workerPid !== undefined &&
      !isProcessAlive(task.workerPid)
    ) {
      return {
        ...task,
        status: "orphaned",
        error:
          "The detached task supervisor is no longer running. Cancel this stale task and delegate it again.",
      };
    }
    return task;
  } finally {
    database.close();
  }
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH" || code === "EINVAL") return false;
    return true;
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
    "source_root",
    "worktree_path",
    "branch_name",
    "base_commit",
    "result_commit",
    "changed_files_json",
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
  const configPath =
    env?.SHARELANE_AGENTS_CONFIG ?? process.env.SHARELANE_AGENTS_CONFIG ?? "";
  if (process.platform === "win32" && env === undefined) {
    const workerPid = launchWindowsBrokeredWorker(
      task.id,
      projectRoot,
      configPath,
    );
    return updateTask(
      task.id,
      { worker_pid: workerPid, updated_at: new Date().toISOString() },
      projectRoot,
      ["queued"],
    ).task;
  }

  const child = spawn(process.execPath, [tsxPath, workerPath, task.id], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...env,
      SHARELANE_PROJECT_ROOT: projectRoot,
      SHARELANE_WORKSPACE_ROOT: task.worktreePath ?? projectRoot,
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
  child.once("exit", (code, signal) => {
    try {
      const current = getTask(task.id, projectRoot);
      if (
        (current.status === "queued" ||
          current.status === "running" ||
          current.status === "orphaned") &&
        current.workerPid === child.pid
      ) {
        failTask(
          task.id,
          `Task supervisor exited before recording a result (code ${code ?? "none"}, signal ${signal ?? "none"}).`,
          projectRoot,
        );
      }
    } catch {
      // The project or task may have been intentionally removed after completion.
    }
  });
  child.unref();
  return updateTask(
    task.id,
    { worker_pid: child.pid ?? null, updated_at: new Date().toISOString() },
    projectRoot,
    ["queued"],
  ).task;
}

function quoteWindowsArgument(argument: string): string {
  const escaped = argument
    .replace(/(\\*)"/g, "$1$1\\\"")
    .replace(/(\\+)$/, "$1$1");
  return `"${escaped}"`;
}

function launchWindowsBrokeredWorker(
  taskId: string,
  projectRoot: string,
  configPath: string,
): number {
  const commandLine = [
    process.execPath,
    tsxPath,
    workerPath,
    taskId,
    projectRoot,
    configPath,
  ]
    .map(quoteWindowsArgument)
    .join(" ");
  const brokerScript = [
    "$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:SHARELANE_WORKER_COMMAND }",
    "$result | Select-Object ProcessId,ReturnValue | ConvertTo-Json -Compress",
    "if ($result.ReturnValue -ne 0) { exit $result.ReturnValue }",
  ].join("; ");
  const launched = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", brokerScript],
    {
      encoding: "utf8",
      env: { ...process.env, SHARELANE_WORKER_COMMAND: commandLine },
      shell: false,
      windowsHide: true,
      timeout: 10_000,
    },
  );
  if (launched.error) throw launched.error;
  if (launched.status !== 0) {
    throw new Error(
      `Windows could not broker the detached task supervisor: ${launched.stderr.trim() || `exit ${launched.status}`}`,
    );
  }
  let result: unknown;
  try {
    result = JSON.parse(launched.stdout.trim());
  } catch {
    throw new Error("Windows returned an invalid task-supervisor launch result.");
  }
  if (
    typeof result !== "object" ||
    result === null ||
    !("ProcessId" in result) ||
    typeof result.ProcessId !== "number"
  ) {
    throw new Error("Windows did not return the task supervisor's process ID.");
  }
  return result.ProcessId;
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
    ["running", "failed", "cancelled"],
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

export function recordTaskWorkspaceResult(
  taskId: string,
  result: FinalizedWorkspace,
  projectRoot: string,
): ShareLaneTask {
  return updateTask(
    taskId,
    {
      result_commit: result.resultCommit ?? null,
      changed_files_json: JSON.stringify(result.changedFiles),
      updated_at: new Date().toISOString(),
    },
    projectRoot,
    ["running"],
  ).task;
}

export function delegateTask(input: DelegateTaskInput): ShareLaneTask {
  const projectRoot = input.projectRoot ?? process.cwd();
  const inheritedEnvironment = { ...process.env, ...input.env };
  const registry = loadAgentRegistry(
    inheritedEnvironment.SHARELANE_AGENTS_CONFIG,
  );
  getAgentAdapter(input.agent, registry);

  const parentId =
    input.parentId || inheritedEnvironment.SHARELANE_TASK_ID || undefined;
  const callerAgent =
    input.callerAgent || inheritedEnvironment.SHARELANE_AGENT || "unknown";
  let depth = input.depth ?? 1;
  let lineage = callerAgent === "unknown" ? [] : [callerAgent];
  if (parentId) {
    const parent = getTask(parentId, projectRoot);
    depth = parent.depth + 1;
    lineage = getTaskLineage(parentId, projectRoot);
    if (lineage.length === 0) lineage = [parent.agent];
  }
  if (depth > 3) {
    throw new Error(
      `Delegation depth ${depth} exceeds ShareLane's maximum depth of 3.`,
    );
  }
  if (lineage.includes(input.agent)) {
    throw new Error(
      `Delegation cycle refused: ${[...lineage, input.agent].join(" -> ")}.`,
    );
  }
  lineage = [...lineage, input.agent];

  const id = `task-${randomUUID()}`;
  const duplicateWarnings = findSimilarActiveTasks(input.prompt, projectRoot).map(
    (similar) =>
      `Possible duplicate of ${similar.id} (${similar.agent}, ${Math.round(similar.similarity * 100)}% prompt overlap).`,
  );
  const sourceRoot =
    input.sourceRoot || inheritedEnvironment.SHARELANE_WORKSPACE_ROOT || projectRoot;
  const workspace = createTaskWorkspace({ projectRoot, sourceRoot, taskId: id });
  const now = new Date().toISOString();
  const paths = getShareLanePaths(projectRoot);
  const taskFile = join(paths.tasksDir, `${id}.md`);
  const logPath = join(paths.tasksDir, `${id}.log`);
  const task: ShareLaneTask = {
    id,
    agent: input.agent,
    prompt: input.prompt,
    status: "queued",
    parentId,
    depth,
    callerAgent,
    sourceRoot: workspace.sourceRoot,
    worktreePath: workspace.worktreePath,
    branchName: workspace.branchName,
    baseCommit: workspace.baseCommit,
    changedFiles: [],
    duplicateWarnings,
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
          caller_agent, source_root, worktree_path, branch_name, base_commit,
          changed_files_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        task.callerAgent ?? null,
        task.sourceRoot ?? null,
        task.worktreePath ?? null,
        task.branchName ?? null,
        task.baseCommit ?? null,
        JSON.stringify(task.changedFiles),
        task.createdAt,
        task.updatedAt,
      );
    database
      .prepare(
        "INSERT INTO task_messages (task_id, role, content, created_at) VALUES (?, 'user', ?, ?)",
      )
      .run(task.id, task.prompt, now);
    const insertLineage = database.prepare(
      "INSERT INTO task_lineage (task_id, position, agent) VALUES (?, ?, ?)",
    );
    lineage.forEach((agent, position) => {
      insertLineage.run(task.id, position, agent);
    });
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original database error.
    }
    try {
      finalizeTaskWorkspace({
        projectRoot,
        taskId: task.id,
        worktreePath: task.worktreePath,
        baseCommit: task.baseCommit,
      });
    } catch {
      // Preserve the database error; the registered worktree remains recoverable.
    }
    throw error;
  } finally {
    database.close();
  }
  for (const warning of duplicateWarnings) {
    createNotice({
      projectRoot,
      recipientAgent: callerAgent,
      taskId: task.id,
      kind: "duplicate_task",
      message: warning,
    });
  }
  writeTaskFile(task, projectRoot);
  try {
    return {
      ...launchTaskWorker(task, projectRoot, input.env),
      duplicateWarnings,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failTask(task.id, `Could not launch task supervisor: ${message}`, projectRoot);
    try {
      recordTaskWorkspaceResult(
        task.id,
        finalizeTaskWorkspace({
          projectRoot,
          taskId: task.id,
          worktreePath: task.worktreePath,
          baseCommit: task.baseCommit,
        }),
        projectRoot,
      );
    } catch {
      // The task file retains the worktree path for manual recovery.
    }
    throw error;
  }
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

  const workspace = createTaskWorkspace({
    projectRoot,
    sourceRoot: task.sourceRoot ?? projectRoot,
    taskId,
    existingBranch: task.branchName,
  });

  const now = new Date().toISOString();
  const database = openDatabase(projectRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    const updated = database
      .prepare(
        `UPDATE tasks SET status = 'queued', result = NULL, error = NULL,
          worker_pid = NULL, agent_pid = NULL, finished_at = NULL,
          source_root = ?, worktree_path = ?, branch_name = ?, base_commit = ?,
          updated_at = ?
         WHERE id = ? AND status = 'completed'`,
      )
      .run(
        workspace.sourceRoot,
        workspace.worktreePath ?? null,
        workspace.branchName ?? null,
        workspace.baseCommit ?? null,
        now,
        taskId,
      );
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
    try {
      finalizeTaskWorkspace({
        projectRoot,
        taskId,
        worktreePath: workspace.worktreePath,
        baseCommit: workspace.baseCommit,
      });
    } catch {
      // Preserve the reply error; the registered worktree remains recoverable.
    }
    throw error;
  } finally {
    database.close();
  }
  const queued = getTask(taskId, projectRoot);
  writeTaskFile(queued, projectRoot);
  try {
    return launchTaskWorker(queued, projectRoot, options.env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failTask(task.id, `Could not launch task supervisor: ${message}`, projectRoot);
    try {
      recordTaskWorkspaceResult(
        task.id,
        finalizeTaskWorkspace({
          projectRoot,
          taskId: task.id,
          worktreePath: workspace.worktreePath,
          baseCommit: workspace.baseCommit,
        }),
        projectRoot,
      );
    } catch {
      // The task file retains the worktree path for manual recovery.
    }
    throw error;
  }
}

export async function waitForTask(
  taskId: string,
  timeoutMilliseconds = 30_000,
  projectRoot = process.cwd(),
): Promise<WaitTaskResult> {
  const deadline = Date.now() + Math.max(0, timeoutMilliseconds);
  while (true) {
    const task = getTask(taskId, projectRoot);
    if (terminalStatuses.has(task.status)) {
      if (persistedTerminalStatuses.has(task.status)) {
        writeTaskFile(task, projectRoot);
      }
      return { task, timedOut: false };
    }
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
  if (persistedTerminalStatuses.has(before.status)) {
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
  releaseClaims({ agent: before.agent, taskId, projectRoot });
  try {
    const finalized = finalizeTaskWorkspace({
      projectRoot,
      taskId,
      worktreePath: before.worktreePath,
      baseCommit: before.baseCommit,
    });
    recordTaskWorkspaceResult(
      taskId,
      finalized,
      projectRoot,
    );
    if (!finalized.cleanedUp && before.worktreePath) {
      throw new Error(`could not remove ${before.worktreePath}`);
    }
  } catch (error) {
    createNotice({
      projectRoot,
      recipientAgent: before.callerAgent,
      taskId,
      kind: "worktree_cleanup_failed",
      message: `Cancelled task ${taskId}, but its worktree was left for recovery: ${error instanceof Error ? error.message : String(error)}.`,
    });
  }
  return getTask(taskId, projectRoot);
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
