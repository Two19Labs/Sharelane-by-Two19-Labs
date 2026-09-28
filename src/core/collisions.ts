import { openDatabase } from "./database.js";
import { isPathClaimedBy } from "./claims.js";
import { createNotice } from "./notices.js";
import { listWorkspaceChanges } from "./worktrees.js";

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

export function detectUnclaimedTaskEdits(input: {
  taskId: string;
  agent: string;
  projectRoot: string;
  worktreePath?: string;
  baseCommit?: string;
  alreadyFlagged?: Set<string>;
}): string[] {
  if (!input.worktreePath) return [];
  const flagged = input.alreadyFlagged ?? new Set<string>();
  const unclaimed = listWorkspaceChanges(input.worktreePath, input.baseCommit).filter(
    (path) =>
      !flagged.has(path) &&
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
  return unclaimed;
}

export function watchTaskEdits(input: {
  taskId: string;
  agent: string;
  projectRoot: string;
  worktreePath?: string;
  baseCommit?: string;
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
