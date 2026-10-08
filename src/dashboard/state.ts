import { execFileSync } from "node:child_process";
import { existsSync, openSync, readdirSync, readFileSync, readSync, closeSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { loadAgentRegistry } from "../adapters/adapter.js";
import { listActiveClaims, type ShareLaneClaim } from "../core/claims.js";
import { isChunkStale, parseChunk } from "../core/context.js";
import { getShareLanePaths, openDatabase } from "../core/database.js";
import { checkQuota, readClaudeQuota, type QuotaReport } from "../core/quota.js";
import {
  freshTokens,
  getTask,
  getTaskLineage,
  handoffNotePath,
  listTaskMessages,
  type ShareLaneTask,
  type TaskMessage,
} from "../core/tasks.js";

// The dashboard is strictly read-only: it never claims, writes notices, marks
// notices delivered, or calls Claude's token-based usage endpoint.

export interface DashboardAgent {
  name: string;
  displayName: string;
  quota: QuotaReport;
  activeTasks: number;
}

export interface DashboardTask {
  id: string;
  agent: string;
  status: string;
  title: string;
  callerAgent?: string;
  lineage: string[];
  scope?: string[];
  branchName?: string;
  changedFiles: string[];
  scopeViolations: string[];
  usage: ShareLaneTask["totalUsage"];
  freshTokens: number;
  budgetTokens?: number;
  reassignments: number;
  handoffReason?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface DashboardNotice {
  id: number;
  kind: string;
  message: string;
  taskId?: string;
  recipientAgent?: string;
  createdAt: string;
  delivered: boolean;
}

export interface DashboardChunk {
  id: string;
  title: string;
  readWhen: string;
  coversFiles: string[];
  updatedAt: string;
  stale: boolean;
}

export interface DashboardState {
  project: { name: string; root: string };
  generatedAt: string;
  totals: {
    activeTasks: number;
    waitingTasks: number;
    failedTasks: number;
    activeClaims: number;
    freshTokens: number;
    cachedTokens: number;
    outputTokens: number;
  };
  agents: DashboardAgent[];
  tasks: DashboardTask[];
  claims: ShareLaneClaim[];
  notices: DashboardNotice[];
  progress: Array<{ task: string; agent: string; note: string; createdAt: string }>;
  /** Tokens per agent from every recorded run, so handed-off work is credited correctly. */
  usageByAgent: Array<{ agent: string; runs: number; freshInputTokens: number; cachedInputTokens: number; outputTokens: number }>;
  context: DashboardChunk[];
}

export interface TaskDetail {
  task: DashboardTask;
  messages: TaskMessage[];
  handoffNote?: string;
}

const ACTIVE = new Set(["queued", "running"]);
const SLOW_CACHE_MS = 30_000;
const slowCache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, compute: () => T | Promise<T>): Promise<T> {
  const hit = slowCache.get(key);
  if (hit && Date.now() - hit.at < SLOW_CACHE_MS) return hit.value as T;
  const value = await compute();
  slowCache.set(key, { at: Date.now(), value });
  return value;
}

export function clearDashboardCache(): void {
  slowCache.clear();
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

function toDashboardTask(task: ShareLaneTask, projectRoot: string): DashboardTask {
  return {
    id: task.id,
    agent: task.agent,
    status: task.status,
    title: firstLine(task.prompt),
    callerAgent: task.callerAgent,
    lineage: getTaskLineage(task.id, projectRoot),
    scope: task.scope,
    branchName: task.branchName,
    changedFiles: task.changedFiles,
    scopeViolations: task.scopeViolations,
    usage: task.totalUsage,
    freshTokens: freshTokens(task),
    budgetTokens: task.budgetTokens,
    reassignments: task.reassignments,
    handoffReason: task.handoffReason,
    error: task.error ? firstLine(task.error) : undefined,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
  };
}

async function agentQuota(name: string, reader: "claude" | "codex" | "none" | undefined): Promise<QuotaReport> {
  // Never use the token-based fallback from a page that refreshes constantly.
  if (reader === "claude") return readClaudeQuota({ agent: name, allowEndpoint: false });
  return checkQuota(name, reader);
}

function readContext(projectRoot: string): DashboardChunk[] {
  const { contextDir } = getShareLanePaths(projectRoot);
  if (!existsSync(contextDir)) return [];
  return readdirSync(contextDir)
    .filter((name) => name.endsWith(".md") && name !== "MAP.md")
    .sort()
    .map((name) => {
      const path = join(contextDir, name);
      const chunk = parseChunk(readFileSync(path, "utf8"), basename(name, ".md"), path);
      let stale = false;
      try {
        stale = isChunkStale(chunk, projectRoot);
      } catch {
        stale = false;
      }
      return {
        id: chunk.id,
        title: chunk.title,
        readWhen: chunk.readWhen,
        coversFiles: chunk.coversFiles,
        updatedAt: chunk.updatedAt,
        stale,
      };
    });
}

export async function collectDashboardState(
  projectRoot = process.cwd(),
  options: { taskLimit?: number } = {},
): Promise<DashboardState> {
  const database = openDatabase(projectRoot);
  let taskIds: string[];
  let notices: DashboardNotice[];
  let progress: DashboardState["progress"];
  const byAgent = new Map<string, DashboardState["usageByAgent"][number]>();
  try {
    const runs = database
      .prepare("SELECT agent, usage_json FROM task_runs")
      .all() as unknown as Array<{ agent: string; usage_json: string | null }>;
    for (const run of runs) {
      const entry = byAgent.get(run.agent) ?? {
        agent: run.agent,
        runs: 0,
        freshInputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
      };
      entry.runs += 1;
      const usage = run.usage_json
        ? (JSON.parse(run.usage_json) as { freshInputTokens?: number; cachedInputTokens?: number; outputTokens?: number })
        : {};
      entry.freshInputTokens += usage.freshInputTokens ?? 0;
      entry.cachedInputTokens += usage.cachedInputTokens ?? 0;
      entry.outputTokens += usage.outputTokens ?? 0;
      byAgent.set(run.agent, entry);
    }
    taskIds = (
      database
        .prepare(
          `SELECT id FROM tasks
           ORDER BY CASE WHEN status IN ('queued', 'running', 'needs_reassignment', 'paused') THEN 0 ELSE 1 END,
                    updated_at DESC
           LIMIT ?`,
        )
        .all(options.taskLimit ?? 50) as unknown as Array<{ id: string }>
    ).map((row) => row.id);
    notices = (
      database
        .prepare(
          `SELECT id, kind, message, task_id, recipient_agent, created_at, delivered_at
           FROM notices ORDER BY id DESC LIMIT 30`,
        )
        .all() as unknown as Array<{
        id: number;
        kind: string;
        message: string;
        task_id: string | null;
        recipient_agent: string | null;
        created_at: string;
        delivered_at: string | null;
      }>
    ).map((row) => ({
      id: row.id,
      kind: row.kind,
      message: row.message,
      taskId: row.task_id ?? undefined,
      recipientAgent: row.recipient_agent ?? undefined,
      createdAt: row.created_at,
      delivered: row.delivered_at !== null,
    }));
    progress = (
      database
        .prepare("SELECT task, agent, note, created_at FROM journal ORDER BY created_at DESC, id DESC LIMIT 20")
        .all() as unknown as Array<{ task: string; agent: string; note: string; created_at: string }>
    ).map((row) => ({ task: row.task, agent: row.agent, note: row.note, createdAt: row.created_at }));
  } finally {
    database.close();
  }

  const tasks = taskIds.map((id) => toDashboardTask(getTask(id, projectRoot), projectRoot));
  // Older tasks have no run log; credit their recorded usage to the agent that ran them.
  const loggedTasks = new Set(
    (() => {
      const db = openDatabase(projectRoot);
      try {
        return (db.prepare("SELECT DISTINCT task_id FROM task_runs").all() as unknown as Array<{ task_id: string }>).map(
          (row) => row.task_id,
        );
      } finally {
        db.close();
      }
    })(),
  );
  for (const task of tasks) {
    if (loggedTasks.has(task.id) || task.usage.runs === 0) continue;
    const entry = byAgent.get(task.agent) ?? {
      agent: task.agent,
      runs: 0,
      freshInputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    };
    entry.runs += task.usage.runs;
    entry.freshInputTokens += task.usage.freshInputTokens;
    entry.cachedInputTokens += task.usage.cachedInputTokens;
    entry.outputTokens += task.usage.outputTokens;
    byAgent.set(task.agent, entry);
  }
  const claims = listActiveClaims(projectRoot);
  const registry = loadAgentRegistry();
  const agents = await Promise.all(
    Object.entries(registry.agents).map(async ([name, adapter]) => ({
      name,
      displayName: adapter.displayName,
      quota: await cached(`quota:${name}`, () => agentQuota(name, adapter.quota)),
      activeTasks: tasks.filter((task) => task.agent === name && ACTIVE.has(task.status)).length,
    })),
  );
  const context = await cached(`context:${projectRoot}`, () => readContext(projectRoot));
  const sum = (pick: (task: DashboardTask) => number) => tasks.reduce((total, task) => total + pick(task), 0);
  return {
    project: { name: basename(projectRoot), root: projectRoot },
    generatedAt: new Date().toISOString(),
    totals: {
      activeTasks: tasks.filter((task) => ACTIVE.has(task.status)).length,
      waitingTasks: tasks.filter((task) => task.status === "needs_reassignment").length,
      failedTasks: tasks.filter((task) => task.status === "failed" || task.status === "orphaned").length,
      activeClaims: claims.length,
      freshTokens: sum((task) => task.freshTokens),
      cachedTokens: sum((task) => task.usage.cachedInputTokens),
      outputTokens: sum((task) => task.usage.outputTokens),
    },
    agents,
    tasks,
    claims,
    notices,
    progress,
    usageByAgent: [...byAgent.values()].sort((a, b) => a.agent.localeCompare(b.agent)),
    context,
  };
}

export function collectTaskDetail(taskId: string, projectRoot = process.cwd()): TaskDetail {
  const task = getTask(taskId, projectRoot);
  const notePath = handoffNotePath(taskId, projectRoot);
  return {
    task: toDashboardTask(task, projectRoot),
    messages: listTaskMessages(taskId, projectRoot),
    handoffNote: existsSync(notePath) ? readFileSync(notePath, "utf8") : undefined,
  };
}

const MAX_LOG_CHUNK = 64 * 1024;

/**
 * Read a task's agent log from a byte offset, so the page can stream live
 * output in small pieces. The path comes from the task record, never the request.
 */
export function readTaskLog(
  taskId: string,
  offset: number,
  projectRoot = process.cwd(),
): { text: string; nextOffset: number; size: number } {
  const { logPath } = getTask(taskId, projectRoot);
  if (!existsSync(logPath)) return { text: "", nextOffset: 0, size: 0 };
  const size = statSync(logPath).size;
  // A first request starts near the end instead of sending a huge log.
  const start = offset < 0 ? Math.max(0, size - MAX_LOG_CHUNK) : Math.min(offset, size);
  const length = Math.min(MAX_LOG_CHUNK, size - start);
  if (length <= 0) return { text: "", nextOffset: start, size };
  const buffer = Buffer.alloc(length);
  const handle = openSync(logPath, "r");
  try {
    readSync(handle, buffer, 0, length, start);
  } finally {
    closeSync(handle);
  }
  return { text: buffer.toString("utf8"), nextOffset: start + length, size };
}

export interface TaskChangeFile {
  path: string;
  status: "added" | "modified" | "deleted" | "changed";
  additions: number | null;
  deletions: number | null;
}

export interface TaskChanges {
  available: boolean;
  reason?: string;
  branchName?: string;
  baseCommit?: string;
  files: TaskChangeFile[];
  patch: string;
  truncated: boolean;
  /** The agent's last reply: its own report of what it did. */
  report?: string;
}

const MAX_PATCH = 400 * 1024;
const branchPattern = /^sharelane\/task-[0-9a-f-]+$/;
const commitPattern = /^[0-9a-f]{7,64}$/;

function git(cwd: string, args: string[]): Buffer {
  return execFileSync("git", args, { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
}

/** Branch and base commit of a task, validated before they reach a git argument list. */
function taskBranch(task: ShareLaneTask): { branch: string; base: string } | undefined {
  if (!task.branchName || !task.baseCommit) return undefined;
  if (!branchPattern.test(task.branchName) || !commitPattern.test(task.baseCommit)) return undefined;
  return { branch: task.branchName, base: task.baseCommit };
}

/**
 * Compare a task's branch with the commit it started from. Read-only: it runs
 * `git diff` only, with fixed arguments and validated refs.
 */
export function collectTaskChanges(taskId: string, projectRoot = process.cwd()): TaskChanges {
  const task = getTask(taskId, projectRoot);
  const messages = listTaskMessages(taskId, projectRoot);
  const report = [...messages].reverse().find((message) => message.role === "assistant")?.content;
  const empty = { files: [], patch: "", truncated: false, report, branchName: task.branchName, baseCommit: task.baseCommit };
  const refs = taskBranch(task);
  if (!refs) {
    return { ...empty, available: false, reason: "This task ran directly in the project folder, so there is no task branch to compare." };
  }
  const cwd = task.sourceRoot ?? projectRoot;
  const range = [refs.base, refs.branch];
  try {
    const statuses = new Map<string, string>();
    for (const line of git(cwd, ["diff", "--no-renames", "--name-status", ...range, "--"]).toString("utf8").split("\n")) {
      const [code, path] = line.split("\t");
      if (code && path) statuses.set(path, code);
    }
    const files: TaskChangeFile[] = [];
    for (const line of git(cwd, ["diff", "--no-renames", "--numstat", ...range, "--"]).toString("utf8").split("\n")) {
      const [added, deleted, path] = line.split("\t");
      if (!path) continue;
      const code = statuses.get(path);
      files.push({
        path,
        status: code === "A" ? "added" : code === "D" ? "deleted" : code === "M" ? "modified" : "changed",
        additions: added === "-" ? null : Number(added),
        deletions: deleted === "-" ? null : Number(deleted),
      });
    }
    const patch = git(cwd, ["diff", "--no-renames", "--no-color", "--no-ext-diff", ...range, "--"]);
    return {
      ...empty,
      available: true,
      files,
      patch: patch.subarray(0, MAX_PATCH).toString("utf8"),
      truncated: patch.length > MAX_PATCH,
    };
  } catch {
    return { ...empty, available: false, reason: `The branch ${refs.branch} no longer exists here (it may have been merged and deleted).` };
  }
}

/**
 * Read one file as it is on a task's branch, for previews. The path must be a
 * plain project-relative path; anything else returns undefined.
 */
export function readTaskBranchFile(taskId: string, path: string, projectRoot = process.cwd()): Buffer | undefined {
  const parts = path.split("/");
  if (!path || path.length > 400 || parts.some((part) => !part || part === "." || part === ".." || /[\:\0]/.test(part))) {
    return undefined;
  }
  const task = getTask(taskId, projectRoot);
  const refs = taskBranch(task);
  if (!refs) return undefined;
  try {
    return git(task.sourceRoot ?? projectRoot, ["show", `${refs.branch}:${path}`]);
  } catch {
    return undefined;
  }
}
