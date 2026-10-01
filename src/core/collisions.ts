import { openDatabase } from "./database.js";
import { isPathClaimedBy } from "./claims.js";
import { createNotice } from "./notices.js";
import { listWorkspaceChanges } from "./worktrees.js";
import { isShareLaneContextPath, pathInScope } from "./scope.js";

const ignoredPromptWords = new Set([
  "a",
  "an",
  "and",
  "for",
  "in",
  "of",
  "on",
  "the",
  "to",
  "with",
]);

function promptWords(prompt: string): Set<string> {
  return new Set(
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9/_.-]+/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 1 && !ignoredPromptWords.has(word)),
  );
}

export function promptSimilarity(left: string, right: string): number {
  const first = promptWords(left);
  const second = promptWords(right);
  if (first.size === 0 || second.size === 0) return 0;
  let intersection = 0;
  for (const word of first) {
    if (second.has(word)) intersection += 1;
  }
  return intersection / (first.size + second.size - intersection);
}

export function findSimilarActiveTasks(
  prompt: string,
  projectRoot = process.cwd(),
): Array<{ id: string; agent: string; prompt: string; similarity: number }> {
  const database = openDatabase(projectRoot);
  try {
    const rows = database
      .prepare(
        `SELECT id, agent, prompt FROM tasks
         WHERE status IN ('queued', 'running') ORDER BY created_at`,
      )
      .all() as unknown as Array<{ id: string; agent: string; prompt: string }>;
    return rows
      .map((row) => ({ ...row, similarity: promptSimilarity(prompt, row.prompt) }))
      .filter((row) => row.similarity >= 0.6)
      .sort((left, right) => right.similarity - left.similarity);
  } finally {
    database.close();
  }
}

/** Durably add out-of-scope paths to the task record. */
export function recordScopeViolations(
  taskId: string,
  paths: string[],
  projectRoot: string,
): void {
  if (paths.length === 0) return;
  const database = openDatabase(projectRoot);
  try {
    database.exec("BEGIN IMMEDIATE");
    const row = database
      .prepare("SELECT scope_violations_json FROM tasks WHERE id = ?")
      .get(taskId) as { scope_violations_json: string | null } | undefined;
    const existing = row?.scope_violations_json
      ? (JSON.parse(row.scope_violations_json) as string[])
      : [];
    const merged = [...new Set([...existing, ...paths])].sort();
    database
      .prepare(
        "UPDATE tasks SET scope_violations_json = ?, updated_at = ? WHERE id = ?",
      )
      .run(JSON.stringify(merged), new Date().toISOString(), taskId);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original error.
    }
    throw error;
  } finally {
    database.close();
  }
}

export function detectUnclaimedTaskEdits(input: {
  taskId: string;
  agent: string;
  projectRoot: string;
  worktreePath?: string;
  baseCommit?: string;
  scope?: string[];
  alreadyFlagged?: Set<string>;
}): string[] {
  if (!input.worktreePath) return [];
  const flagged = input.alreadyFlagged ?? new Set<string>();
  const fresh = listWorkspaceChanges(input.worktreePath, input.baseCommit).filter(
    (path) => !flagged.has(path) && !isShareLaneContextPath(path),
  );
  const outOfScope = input.scope
    ? fresh.filter((path) => !pathInScope(input.scope ?? [], path))
    : [];
  for (const path of outOfScope) {
    flagged.add(path);
    createNotice({
      projectRoot: input.projectRoot,
      recipientAgent: input.agent,
      taskId: input.taskId,
      kind: "scope_violation",
      message: `Out-of-scope edit detected in ${path} (allowed scope: ${input.scope?.join(", ")}). ShareLane will keep it off the task branch and save it as a patch for review.`,
    });
  }
  recordScopeViolations(input.taskId, outOfScope, input.projectRoot);
  const unclaimed = fresh.filter(
    (path) =>
      !flagged.has(path) &&
      // A delegated scope is the task's claim, even if a worker released it early.
      !(input.scope && pathInScope(input.scope, path)) &&
      !isPathClaimedBy({
        agent: input.agent,
        taskId: input.taskId,
        path,
        projectRoot: input.projectRoot,
      }),
  );
  for (const path of unclaimed) {
    flagged.add(path);
    createNotice({
      projectRoot: input.projectRoot,
      recipientAgent: input.agent,
      taskId: input.taskId,
      kind: "unclaimed_edit",
      message: `Unclaimed edit detected in ${path}. Claim the file before further edits; ShareLane preserved the change on the task branch.`,
    });
  }
  return [...outOfScope, ...unclaimed];
}

export function watchTaskEdits(input: {
  taskId: string;
  agent: string;
  projectRoot: string;
  worktreePath?: string;
  baseCommit?: string;
  scope?: string[];
  intervalMilliseconds?: number;
}): { stop: () => string[] } {
  const flagged = new Set<string>();
  if (!input.worktreePath) return { stop: () => [] };
  const scan = (): string[] =>
    detectUnclaimedTaskEdits({ ...input, alreadyFlagged: flagged });
  const timer = setInterval(() => {
    try {
      scan();
    } catch {
      // The final scan reports durable errors; polling should not crash the worker.
    }
  }, input.intervalMilliseconds ?? 500);
  timer.unref();
  return {
    stop: () => {
      clearInterval(timer);
      return scan();
    },
  };
}
