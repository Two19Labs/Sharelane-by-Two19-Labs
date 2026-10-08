import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { getAgentAdapter, loadAgentRegistry } from "../adapters/adapter.js";
import type { AgentUsage } from "../adapters/result.js";
import { findSimilarActiveTasks, recordScopeViolations } from "./collisions.js";
import {
  assertPathsUnclaimed,
  claimPathsInTransaction,
  releaseClaims,
} from "./claims.js";
import type { DatabaseSync } from "node:sqlite";
import { describeScope, normalizeScope } from "./scope.js";
import { checkQuota } from "./quota.js";
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
  | "needs_reassignment"
  | "paused"
  | "orphaned";

/** Token totals across every run of a task (first run, replies, reassignments). */
export interface TaskUsageTotals {
  runs: number;
  freshInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** Runs whose CLI reported no usage (for example a run that crashed). */
  runsWithoutUsage: number;
}

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
  scope?: string[];
  scopeViolations: string[];
  totalUsage: TaskUsageTotals;
  budgetTokens?: number;
  reassignments: number;
  handoffReason?: string;
  /** You finished with it (review board "Done" or "End chat"); the office stops showing it. */
  dismissedAt?: string;
  /** You ended the conversation; no more follow-ups go to the agent. */
  conversationClosedAt?: string;
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
  scope_json: string | null;
  scope_violations_json: string | null;
  budget_tokens: number | null;
  reassignments: number | null;
  handoff_reason: string | null;
  dismissed_at: string | null;
  conversation_closed_at: string | null;
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
  /** Project-relative files, folders, or globs the worker may change. */
  scope?: string[];
  /** Optional limit on fresh tokens (new input plus output) across all runs. */
  budgetTokens?: number;
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
  "needs_reassignment",
  "paused",
  "orphaned",
]);
const persistedTerminalStatuses = new Set<TaskStatus>([
  "completed",
  "failed",
  "cancelled",
]);

/** A person stopped this run (cancel or pause), so the worker must not record a failure. */
export function isStoppedByUser(status: TaskStatus): boolean {
  return status === "cancelled" || status === "paused";
}
// Resolve tsx the way Node would from this package, so it is found whether
// ShareLane runs from its own repo or is installed (and hoisted) in a project.
const tsxPath = createRequire(import.meta.url).resolve("tsx/cli");
const workerPath = fileURLToPath(new URL("../worker.ts", import.meta.url));

function emptyTotals(): TaskUsageTotals {
  return {
    runs: 0,
    freshInputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    runsWithoutUsage: 0,
  };
}

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
    scope: row.scope_json ? (JSON.parse(row.scope_json) as string[]) : undefined,
    scopeViolations: row.scope_violations_json
      ? (JSON.parse(row.scope_violations_json) as string[])
      : [],
    totalUsage: emptyTotals(),
    budgetTokens: row.budget_tokens ?? undefined,
    reassignments: row.reassignments ?? 0,
    handoffReason: row.handoff_reason ?? undefined,
    dismissedAt: row.dismissed_at ?? undefined,
    conversationClosedAt: row.conversation_closed_at ?? undefined,
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
  lines.push(`- Scope: ${describeScope(task.scope)}`);
  lines.push(`- Usage: ${describeUsage(task)}`);
  if (task.reassignments > 0) lines.push(`- Reassignments: ${task.reassignments}`);
  if (task.handoffReason) lines.push(`- Handoff reason: ${task.handoffReason}`);
  if (task.scopeViolations.length > 0) {
    lines.push(
      `- Scope violations (kept off the task branch): ${task.scopeViolations.join(", ")}`,
      `- Out-of-scope patch: ${relative(projectRoot, outOfScopePatchPath(task.id, projectRoot)).replaceAll("\\", "/")}`,
    );
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

const transientFileErrors = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * Refresh the human-readable task file. SQLite is the source of truth, so if
 * Windows keeps the file busy (another process replacing or reading it at the
 * same moment), retry briefly and then skip this refresh instead of failing.
 */
function writeTaskFile(task: ShareLaneTask, projectRoot: string): void {
  mkdirSync(dirname(task.taskFile), { recursive: true });
  const temporary = `${task.taskFile}.${process.pid}.tmp`;
  writeFileSync(temporary, taskMarkdown(task, projectRoot), "utf8");
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(temporary, task.taskFile);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!transientFileErrors.has(code)) throw error;
      if (attempt >= 20) {
        rmSync(temporary, { force: true });
        return;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

/**
 * Fresh input for usage recorded before parsers reported it (pre-v5 tasks),
 * using the same per-CLI rules as the parsers.
 */
export function freshInputOf(agent: string, usage: AgentUsage): number {
  if (usage.freshInputTokens !== undefined) return usage.freshInputTokens;
  const input = usage.inputTokens ?? 0;
  if (agent === "claude") return input + (usage.cacheWriteInputTokens ?? 0);
  if (agent === "codex") return Math.max(0, input - (usage.cachedInputTokens ?? 0));
  return input;
}

function usageTotals(
  database: DatabaseSync,
  taskId: string,
  legacy?: { agent: string; usage?: AgentUsage },
): TaskUsageTotals {
  const totals = emptyTotals();
  const rows = database
    .prepare("SELECT usage_json FROM task_runs WHERE task_id = ? ORDER BY id")
    .all(taskId) as unknown as Array<{ usage_json: string | null }>;
  // Tasks from before the run log kept only their last run's usage; count it as one run.
  if (rows.length === 0 && legacy?.usage && Object.keys(legacy.usage).length > 0) {
    totals.runs = 1;
    totals.freshInputTokens = freshInputOf(legacy.agent, legacy.usage);
    totals.cachedInputTokens = legacy.usage.cachedInputTokens ?? 0;
    totals.outputTokens = legacy.usage.outputTokens ?? 0;
    return totals;
  }
  for (const row of rows) {
    totals.runs += 1;
    const usage = row.usage_json ? (JSON.parse(row.usage_json) as AgentUsage) : undefined;
    if (!usage || Object.keys(usage).length === 0) {
      totals.runsWithoutUsage += 1;
      continue;
    }
    totals.freshInputTokens += usage.freshInputTokens ?? 0;
    totals.cachedInputTokens += usage.cachedInputTokens ?? 0;
    totals.outputTokens += usage.outputTokens ?? 0;
  }
  return totals;
}

/** Record the start of one agent run; returns the run's id. */
export function startTaskRun(
  taskId: string,
  agent: string,
  resumed: boolean,
  projectRoot: string,
): number {
  const database = openDatabase(projectRoot);
  try {
    return Number(
      database
        .prepare(
          "INSERT INTO task_runs (task_id, agent, resumed, status, started_at) VALUES (?, ?, ?, 'running', ?)",
        )
        .run(taskId, agent, resumed ? 1 : 0, new Date().toISOString()).lastInsertRowid,
    );
  } finally {
    database.close();
  }
}

export function finishTaskRun(
  runId: number,
  status: "completed" | "failed" | "cancelled",
  projectRoot: string,
  usage?: AgentUsage,
  error?: string,
): void {
  const database = openDatabase(projectRoot);
  try {
    database
      .prepare(
        "UPDATE task_runs SET status = ?, usage_json = ?, error = ?, finished_at = ? WHERE id = ? AND status = 'running'",
      )
      .run(status, usage ? JSON.stringify(usage) : null, error ?? null, new Date().toISOString(), runId);
  } finally {
    database.close();
  }
}

/** Plain-language usage line for status replies and task files. */
export function describeUsage(task: ShareLaneTask): string {
  const total = task.totalUsage;
  if (total.runs === 0) return "no runs recorded yet";
  const parts = [
    `${total.runs} run${total.runs === 1 ? "" : "s"}`,
    `fresh input ${total.freshInputTokens}`,
    `cached input ${total.cachedInputTokens}`,
    `output ${total.outputTokens}`,
  ];
  if (total.runsWithoutUsage > 0) parts.push(`${total.runsWithoutUsage} without usage data`);
  if (task.budgetTokens) {
    parts.push(`budget ${freshTokens(task)}/${task.budgetTokens} fresh tokens`);
  }
  return parts.join(", ");
}

/** Fresh tokens spent so far: new input plus output, across all runs. */
export function freshTokens(task: ShareLaneTask): number {
  return task.totalUsage.freshInputTokens + task.totalUsage.outputTokens;
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
    const base = fromRow(row);
    const task = {
      ...base,
      totalUsage: usageTotals(database, taskId, { agent: base.agent, usage: base.usage }),
    };
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
    "scope_violations_json",
    "handoff_reason",
    "dismissed_at",
    "conversation_closed_at",
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
    ["running", "failed", "cancelled", "paused"],
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
      ...(result.blockedFiles.length > 0
        ? {
            scope_violations_json: JSON.stringify(
              mergeViolations(taskId, result.blockedFiles, projectRoot),
            ),
          }
        : {}),
      updated_at: new Date().toISOString(),
    },
    projectRoot,
    ["running"],
  ).task;
}

export function outOfScopePatchPath(
  taskId: string,
  projectRoot = process.cwd(),
): string {
  return join(getShareLanePaths(projectRoot).tasksDir, `${taskId}.out-of-scope.patch`);
}

function mergeViolations(
  taskId: string,
  paths: string[],
  projectRoot: string,
): string[] {
  const existing = getTask(taskId, projectRoot).scopeViolations;
  return [...new Set([...existing, ...paths])].sort();
}

function claimTaskScope(
  database: DatabaseSync,
  task: { id: string; agent: string; prompt: string; scope?: string[] },
): void {
  if (!task.scope) return;
  claimPathsInTransaction(database, {
    agent: task.agent,
    taskId: task.id,
    paths: task.scope,
    intent: `delegated scope for ${task.id}: ${task.prompt.slice(0, 80)}`,
  });
}

function workspaceInput(task: ShareLaneTask, projectRoot: string) {
  return {
    projectRoot,
    taskId: task.id,
    worktreePath: task.worktreePath,
    baseCommit: task.baseCommit,
    scope: task.scope,
    patchPath: outOfScopePatchPath(task.id, projectRoot),
  };
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

  const scope = normalizeScope(input.scope, projectRoot);
  if (
    input.budgetTokens !== undefined &&
    (!Number.isInteger(input.budgetTokens) || input.budgetTokens <= 0)
  ) {
    throw new Error("budgetTokens must be a positive whole number of fresh tokens.");
  }
  if (scope) assertPathsUnclaimed(scope, projectRoot);

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
    scope,
    scopeViolations: [],
    totalUsage: emptyTotals(),
    budgetTokens: input.budgetTokens,
    reassignments: 0,
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
          changed_files_json, scope_json, budget_tokens, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        task.scope ? JSON.stringify(task.scope) : null,
        task.budgetTokens ?? null,
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
    claimTaskScope(database, task);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original database error.
    }
    try {
      finalizeTaskWorkspace(workspaceInput(task, projectRoot));
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
    releaseClaims({ agent: task.agent, taskId: task.id, projectRoot });
    failTask(task.id, `Could not launch task supervisor: ${message}`, projectRoot);
    try {
      recordTaskWorkspaceResult(
        task.id,
        finalizeTaskWorkspace(workspaceInput(task, projectRoot)),
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
  if (task.conversationClosedAt) {
    throw new Error(`The conversation for task "${taskId}" was ended, so it takes no more follow-ups. Start a new task instead.`);
  }
  // A paused task may have no session yet (it was stopped mid-run); its next
  // run then starts a fresh conversation on the same branch.
  if (task.status !== "paused" && (task.status !== "completed" || !task.sessionId)) {
    throw new Error(
      `Task "${taskId}" must be completed with a saved session, or paused, before replying. Current status: ${task.status}.`,
    );
  }
  assertBudgetLeft(task);

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
        `UPDATE tasks SET status = 'queued', result = NULL, error = NULL, dismissed_at = NULL,
          worker_pid = NULL, agent_pid = NULL, finished_at = NULL,
          source_root = ?, worktree_path = ?, branch_name = ?, base_commit = ?,
          updated_at = ?
         WHERE id = ? AND status IN ('completed', 'paused')`,
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
    claimTaskScope(database, task);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original database error.
    }
    try {
      finalizeTaskWorkspace({
        ...workspaceInput(task, projectRoot),
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
    releaseClaims({ agent: task.agent, taskId: task.id, projectRoot });
    failTask(task.id, `Could not launch task supervisor: ${message}`, projectRoot);
    try {
      recordTaskWorkspaceResult(
        task.id,
        finalizeTaskWorkspace({
          ...workspaceInput(queued, projectRoot),
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

function closeRunningRuns(
  taskId: string,
  status: "failed" | "cancelled",
  projectRoot: string,
): void {
  const database = openDatabase(projectRoot);
  try {
    database
      .prepare(
        "UPDATE task_runs SET status = ?, finished_at = ? WHERE task_id = ? AND status = 'running'",
      )
      .run(status, new Date().toISOString(), taskId);
  } finally {
    database.close();
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
  if (before.status === "paused") {
    // Nothing is running and the work is already saved on the branch.
    const now = new Date().toISOString();
    const cancelled = updateTask(
      taskId,
      { status: "cancelled", finished_at: now, updated_at: now },
      projectRoot,
      ["paused"],
    );
    if (!cancelled.changed) {
      throw new Error(`Task "${taskId}" changed before it could be cancelled.`);
    }
    writeTaskFile(cancelled.task, projectRoot);
    return cancelled.task;
  }
  return stopTask(taskId, "cancelled", projectRoot);
}

/**
 * Mark a finished task as dealt with, so the office sends its employee back to
 * the lounge. With endConversation, the conversation is also closed and takes
 * no more follow-ups. The task branch is untouched either way.
 */
export function dismissTask(
  taskId: string,
  options: { endConversation?: boolean; projectRoot?: string } = {},
): ShareLaneTask {
  const projectRoot = options.projectRoot ?? process.cwd();
  const task = getTask(taskId, projectRoot);
  if (!persistedTerminalStatuses.has(task.status)) {
    throw new Error(`Only a finished task can be sent back to the lounge; this one is ${task.status}. Stop it first.`);
  }
  const now = new Date().toISOString();
  const fields: Record<string, string> = { dismissed_at: task.dismissedAt ?? now, updated_at: now };
  if (options.endConversation) fields.conversation_closed_at = task.conversationClosedAt ?? now;
  const updated = updateTask(taskId, fields, projectRoot, [...persistedTerminalStatuses]);
  if (!updated.changed) throw new Error(`Task "${taskId}" changed before it could be dismissed.`);
  writeTaskFile(updated.task, projectRoot);
  return updated.task;
}

/**
 * Pause a running task: stop the agent, save its work on the task branch, and
 * keep the task resumable. CLIs cannot freeze mid-turn, so resuming starts a
 * new run on the same branch (see resumeTask).
 */
export function pauseTask(
  taskId: string,
  projectRoot = process.cwd(),
): ShareLaneTask {
  const before = getTask(taskId, projectRoot);
  if (before.status !== "queued" && before.status !== "running") {
    throw new Error(`Only a queued or running task can be paused; this one is ${before.status}.`);
  }
  return stopTask(taskId, "paused", projectRoot);
}

const defaultResumeNote =
  "You were paused partway through this task. Any changes you had made are already in your workspace; check them, then continue.";

/** Continue a paused task on its branch, optionally with an extra instruction. */
export function resumeTask(
  taskId: string,
  note?: string,
  options: TaskActionOptions = {},
): ShareLaneTask {
  const projectRoot = options.projectRoot ?? process.cwd();
  const task = getTask(taskId, projectRoot);
  if (task.status !== "paused") {
    throw new Error(`Only a paused task can be resumed; this one is ${task.status}.`);
  }
  const extra = note?.trim();
  const resumeNote = extra ? `${defaultResumeNote}\n\n${extra}` : defaultResumeNote;
  // Without a saved session the agent starts fresh, so it needs the request again.
  const message = task.sessionId
    ? `${resumeNote}${latestInstruction(task, projectRoot)}`
    : `${resumeNote}\n\nThe task:\n${task.prompt}${latestInstruction(task, projectRoot)}`;
  return replyToTask(taskId, message, options);
}

function latestInstruction(task: ShareLaneTask, projectRoot: string): string {
  const latest = latestTaskPrompt(task.id, projectRoot);
  return latest === task.prompt || latest.startsWith(defaultResumeNote)
    ? ""
    : `\n\nYour latest instruction:\n${latest}`;
}

function stopTask(
  taskId: string,
  as: "cancelled" | "paused",
  projectRoot: string,
): ShareLaneTask {
  const before = getTask(taskId, projectRoot);
  if (persistedTerminalStatuses.has(before.status)) {
    throw new Error(
      `Task "${taskId}" is already ${before.status} and cannot be ${as}.`,
    );
  }
  const verb = as === "paused" ? "Paused" : "Cancelled";
  const now = new Date().toISOString();
  const stopped = updateTask(
    taskId,
    {
      status: as,
      agent_pid: null,
      worker_pid: null,
      finished_at: now,
      updated_at: now,
    },
    projectRoot,
    as === "paused" ? ["queued", "running"] : ["queued", "running", "needs_reassignment"],
  );
  if (!stopped.changed) {
    throw new Error(`Task "${taskId}" changed before it could be ${as}.`);
  }
  stopProcess(before.agentPid);
  stopProcess(before.workerPid);
  closeRunningRuns(taskId, "cancelled", projectRoot);
  releaseClaims({ agent: before.agent, taskId, projectRoot });
  try {
    const finalized = finalizeTaskWorkspace(workspaceInput(before, projectRoot));
    recordTaskWorkspaceResult(
      taskId,
      finalized,
      projectRoot,
    );
    if (finalized.blockedFiles.length > 0) {
      recordScopeViolations(taskId, finalized.blockedFiles, projectRoot);
      createNotice({
        projectRoot,
        recipientAgent: before.callerAgent,
        taskId,
        kind: "scope_violation",
        message: `${verb} task ${taskId} had changed ${finalized.blockedFiles.join(", ")} outside its scope; those changes were kept off ${before.branchName ?? "the task branch"} and saved to ${relative(projectRoot, outOfScopePatchPath(taskId, projectRoot)).replaceAll("\\", "/")}.`,
      });
    }
    if (!finalized.cleanedUp && before.worktreePath) {
      throw new Error(`could not remove ${before.worktreePath}`);
    }
  } catch (error) {
    createNotice({
      projectRoot,
      recipientAgent: before.callerAgent,
      taskId,
      kind: "worktree_cleanup_failed",
      message: `${verb} task ${taskId}, but its worktree was left for recovery: ${error instanceof Error ? error.message : String(error)}.`,
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

// ---------------------------------------------------------------------------
// Phase 5: handoff and reassignment when an agent runs out of allowance.
// ---------------------------------------------------------------------------

/** A task is reassigned at most this many times, so agents cannot ping-pong forever. */
export const MAX_REASSIGNMENTS = 2;

const allowanceErrorPattern =
  /out of credits|credits? (?:are |were )?depleted|usage limit|rate[- ]?limit|quota|exceeded your|limit (?:has been )?reached|resource[_ ]exhausted|\b429\b/i;

/** True when an agent's failure means it ran out of allowance rather than failed the work. */
export function isAllowanceError(message: string): boolean {
  return allowanceErrorPattern.test(message);
}

export function handoffNotePath(taskId: string, projectRoot = process.cwd()): string {
  return join(getShareLanePaths(projectRoot).tasksDir, `${taskId}.handoff.md`);
}

function journalFor(
  taskId: string,
  projectRoot: string,
): Array<{ agent: string; note: string; created_at: string }> {
  const database = openDatabase(projectRoot);
  try {
    return database
      .prepare("SELECT agent, note, created_at FROM journal WHERE task = ? ORDER BY created_at, id")
      .all(taskId) as unknown as Array<{ agent: string; note: string; created_at: string }>;
  } finally {
    database.close();
  }
}

/**
 * Write the handoff a fresh agent needs to continue without asking a question:
 * the original request, follow-ups, progress notes, saved work, and why.
 */
export function writeHandoffNote(task: ShareLaneTask, reason: string, projectRoot: string): string {
  const messages = listTaskMessages(task.id, projectRoot);
  const requests = messages.filter((message) => message.role === "user");
  const replies = messages.filter((message) => message.role === "assistant");
  const notes = journalFor(task.id, projectRoot);
  const saved = task.branchName
    ? `branch ${task.branchName}${task.resultCommit ? ` at ${task.resultCommit}` : ""}`
    : "no Git branch (direct workspace)";
  const lines = [
    `# Handoff for ${task.id}`,
    "",
    `- From: ${task.agent}`,
    `- Why: ${reason}`,
    `- Scope: ${describeScope(task.scope)}`,
    `- Saved work: ${saved}`,
    `- Changed so far: ${task.changedFiles.length ? task.changedFiles.join(", ") : "nothing recorded"}`,
    "",
    "## Original request",
    "",
    requests[0]?.content ?? task.prompt,
  ];
  if (requests.length > 1) {
    lines.push("", "## Later requests", "");
    for (const request of requests.slice(1)) lines.push(`- ${request.content.split("\n")[0]}`);
  }
  lines.push("", "## Progress notes", "");
  if (notes.length === 0) lines.push("- None were logged; inspect the saved changes before continuing.");
  for (const note of notes) lines.push(`- ${note.created_at} ${note.agent}: ${note.note}`);
  const lastReply = replies.at(-1)?.content;
  if (lastReply) lines.push("", "## Last reply from the previous agent", "", lastReply);
  const text = `${lines.join("\n")}\n`;
  const path = handoffNotePath(task.id, projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
  return text;
}

/**
 * Pick the next agent: configured, not already in the delegation chain above
 * this task, not already tried on it, and not itself out of allowance.
 * "Could not tell" does not disqualify an agent; "hand off" does.
 */
export async function chooseReassignmentAgent(
  task: ShareLaneTask,
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ agent?: string; skipped: string[] }> {
  const registry = loadAgentRegistry(
    env.SHARELANE_AGENTS_CONFIG || process.env.SHARELANE_AGENTS_CONFIG,
  );
  const callers = getTaskLineage(task.id, projectRoot).slice(0, -1);
  const database = openDatabase(projectRoot);
  let tried: Set<string>;
  try {
    const rows = database
      .prepare("SELECT DISTINCT agent FROM task_runs WHERE task_id = ?")
      .all(task.id) as unknown as Array<{ agent: string }>;
    tried = new Set(rows.map((row) => row.agent));
  } finally {
    database.close();
  }
  tried.add(task.agent);
  const skipped: string[] = [];
  for (const [name, adapter] of Object.entries(registry.agents)) {
    if (callers.includes(name) || tried.has(name)) continue;
    const quota = await checkQuota(name, adapter.quota);
    if (quota.state === "handoff") {
      skipped.push(`${name} (${quota.reason})`);
      continue;
    }
    return { agent: name, skipped };
  }
  return { skipped };
}

/**
 * Give a task to another agent, continuing on the same task branch with the
 * handoff note as its instructions. Used automatically by the worker and by
 * the reassign tool for tasks waiting in needs_reassignment (or failed ones).
 */
export async function reassignTask(
  taskId: string,
  options: {
    projectRoot?: string;
    env?: NodeJS.ProcessEnv;
    agent?: string;
    reason?: string;
    allowedFrom?: TaskStatus[];
  } = {},
): Promise<ShareLaneTask> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const allowedFrom = options.allowedFrom ?? ["needs_reassignment", "failed"];
  const task = getTask(taskId, projectRoot);
  if (!allowedFrom.includes(task.status)) {
    throw new Error(
      `Task "${taskId}" is ${task.status}; only ${allowedFrom.join(" or ")} tasks can be reassigned.`,
    );
  }
  assertBudgetLeft(task);
  const env = { ...process.env, ...options.env };
  const registry = loadAgentRegistry(env.SHARELANE_AGENTS_CONFIG);
  let agent = options.agent;
  if (agent) {
    getAgentAdapter(agent, registry);
    if (getTaskLineage(taskId, projectRoot).slice(0, -1).includes(agent)) {
      throw new Error(`Reassignment refused: ${agent} is already in this task's delegation chain.`);
    }
  } else {
    const choice = await chooseReassignmentAgent(task, projectRoot, env);
    if (!choice.agent) {
      const skipped = choice.skipped.length ? ` Skipped: ${choice.skipped.join("; ")}.` : "";
      throw new Error(`No agent is available to take over ${taskId}.${skipped}`);
    }
    agent = choice.agent;
  }
  const reason = options.reason ?? task.handoffReason ?? "manual reassignment";
  const note = writeHandoffNote(task, reason, projectRoot);
  const prompt = [
    `ShareLane handed this task to you from ${task.agent} because: ${reason}`,
    "Continue from the work already saved on this task branch (it is checked out in your workspace). Do not redo finished parts; check the saved changes first.",
    "",
    note,
  ].join("\n");

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
    const statusList = allowedFrom.map(() => "?").join(", ");
    const updated = database
      .prepare(
        `UPDATE tasks SET agent = ?, status = 'queued', session_id = NULL, result = NULL,
          error = NULL, worker_pid = NULL, agent_pid = NULL, finished_at = NULL,
          source_root = ?, worktree_path = ?, branch_name = ?, base_commit = ?,
          reassignments = reassignments + 1, handoff_reason = ?, updated_at = ?
         WHERE id = ? AND status IN (${statusList})`,
      )
      .run(
        agent,
        workspace.sourceRoot,
        workspace.worktreePath ?? null,
        workspace.branchName ?? null,
        workspace.baseCommit ?? null,
        reason,
        now,
        taskId,
        ...allowedFrom,
      );
    if (updated.changes === 0) {
      throw new Error(`Task "${taskId}" changed before it could be reassigned.`);
    }
    database
      .prepare(
        "INSERT INTO task_messages (task_id, role, content, created_at) VALUES (?, 'user', ?, ?)",
      )
      .run(taskId, prompt, now);
    database
      .prepare(
        "UPDATE task_lineage SET agent = ? WHERE task_id = ? AND position = (SELECT MAX(position) FROM task_lineage WHERE task_id = ?)",
      )
      .run(agent, taskId, taskId);
    claimTaskScope(database, { ...task, agent });
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original error.
    }
    try {
      finalizeTaskWorkspace({
        ...workspaceInput(task, projectRoot),
        worktreePath: workspace.worktreePath,
        baseCommit: workspace.baseCommit,
      });
    } catch {
      // The registered worktree remains recoverable.
    }
    throw error;
  } finally {
    database.close();
  }
  createNotice({
    projectRoot,
    recipientAgent: task.callerAgent,
    taskId,
    kind: "handoff",
    message: `Task ${taskId} was handed from ${task.agent} to ${agent}: ${reason}. Handoff note: ${relativeTaskPath(handoffNotePath(taskId, projectRoot), projectRoot)}.`,
  });
  const queued = getTask(taskId, projectRoot);
  writeTaskFile(queued, projectRoot);
  try {
    return launchTaskWorker(queued, projectRoot, options.env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    releaseClaims({ agent, taskId, projectRoot });
    failTask(taskId, `Could not launch task supervisor: ${message}`, projectRoot);
    throw error;
  }
}

function relativeTaskPath(path: string, projectRoot: string): string {
  return relative(projectRoot, path).split("\\").join("/");
}

/**
 * Called by a worker whose agent ran out of allowance, after its work was saved:
 * reassign automatically when possible, otherwise park the task as
 * needs_reassignment and tell the caller.
 */
export async function handOffTask(
  taskId: string,
  reason: string,
  projectRoot: string,
  env?: NodeJS.ProcessEnv,
): Promise<ShareLaneTask> {
  const task = getTask(taskId, projectRoot);
  writeHandoffNote(task, reason, projectRoot);
  let blocker = `it was already reassigned ${task.reassignments} times (limit ${MAX_REASSIGNMENTS})`;
  if (budgetState(task) === "exhausted") {
    blocker = `its token budget is used up (${freshTokens(task)}/${task.budgetTokens} fresh tokens)`;
  } else if (task.reassignments < MAX_REASSIGNMENTS) {
    const choice = await chooseReassignmentAgent(task, projectRoot, { ...process.env, ...env });
    if (choice.agent) {
      return reassignTask(taskId, {
        projectRoot,
        env,
        agent: choice.agent,
        reason,
        allowedFrom: ["running"],
      });
    }
    const skipped = choice.skipped.length ? ` (skipped: ${choice.skipped.join("; ")})` : "";
    blocker = `no other agent is available${skipped}`;
  }
  // Create the notice before the status change: anyone waiting on the task sees
  // needs_reassignment as final, so the explanation must already exist by then.
  const branch = task.branchName ? ` on ${task.branchName}` : "";
  createNotice({
    projectRoot,
    recipientAgent: task.callerAgent,
    taskId,
    kind: "handoff",
    message: `Task ${taskId} needs reassignment: ${reason}. ShareLane did not reassign it because ${blocker}. Its work is saved${branch}; see ${relativeTaskPath(handoffNotePath(taskId, projectRoot), projectRoot)} and use the reassign tool.`,
  });
  const now = new Date().toISOString();
  return updateTask(
    taskId,
    {
      status: "needs_reassignment",
      handoff_reason: reason,
      agent_pid: null,
      worker_pid: null,
      finished_at: now,
      updated_at: now,
    },
    projectRoot,
    ["running"],
  ).task;
}

/** Store an agent's reply that did not complete the task (for example a HANDOFF). */
export function recordAgentReply(taskId: string, content: string, projectRoot: string): void {
  const database = openDatabase(projectRoot);
  try {
    database
      .prepare(
        "INSERT INTO task_messages (task_id, role, content, created_at) VALUES (?, 'assistant', ?, ?)",
      )
      .run(taskId, content, new Date().toISOString());
  } finally {
    database.close();
  }
}

// ---------------------------------------------------------------------------
// Phase 5: optional per-task budget of fresh tokens. Usage is reported when a
// run ends, so the budget is enforced between runs, not in the middle of one.
// ---------------------------------------------------------------------------

export const BUDGET_WARNING_RATIO = 0.8;

export function budgetState(task: ShareLaneTask): "none" | "ok" | "warning" | "exhausted" {
  if (!task.budgetTokens) return "none";
  const spent = freshTokens(task);
  if (spent >= task.budgetTokens) return "exhausted";
  return spent >= task.budgetTokens * BUDGET_WARNING_RATIO ? "warning" : "ok";
}

export function assertBudgetLeft(task: ShareLaneTask): void {
  if (budgetState(task) === "exhausted") {
    throw new Error(
      `Task "${task.id}" has used its budget: ${freshTokens(task)} of ${task.budgetTokens} fresh tokens. No further runs will start.`,
    );
  }
}

/** Tell the caller when a finished run crossed the warning line or used the budget up. */
export function noticeBudget(taskId: string, projectRoot: string): void {
  const task = getTask(taskId, projectRoot);
  const state = budgetState(task);
  if (state !== "warning" && state !== "exhausted") return;
  createNotice({
    projectRoot,
    recipientAgent: task.callerAgent,
    taskId,
    kind: state === "exhausted" ? "budget_exhausted" : "budget_warning",
    message:
      state === "exhausted"
        ? `Task ${taskId} used its budget: ${freshTokens(task)} of ${task.budgetTokens} fresh tokens. ShareLane will not start further runs (replies or reassignments) for it.`
        : `Task ${taskId} has used ${freshTokens(task)} of its ${task.budgetTokens} fresh-token budget (over ${Math.round(BUDGET_WARNING_RATIO * 100)}%).`,
  });
}
