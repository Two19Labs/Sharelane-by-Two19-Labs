import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathInScope } from "./scope.js";

export interface TaskWorkspace {
  sourceRoot: string;
  worktreePath?: string;
  branchName?: string;
  baseCommit?: string;
}

export interface FinalizedWorkspace {
  resultCommit?: string;
  changedFiles: string[];
  /** Out-of-scope paths kept off the task branch (saved to the patch file). */
  blockedFiles: string[];
  cleanedUp: boolean;
}

function git(
  cwd: string,
  args: string[],
  options: { allowFailure?: boolean } = {},
): { stdout: string; status: number } {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  const status = result.status ?? 1;
  if (status !== 0 && !options.allowFailure) {
    throw new Error(
      `Git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim() || `exit ${status}`}`,
    );
  }
  return { stdout: result.stdout, status };
}

export function isGitWorktree(projectRoot: string): boolean {
  return (
    git(projectRoot, ["rev-parse", "--is-inside-work-tree"], {
      allowFailure: true,
    }).stdout.trim() === "true" &&
    git(projectRoot, ["rev-parse", "--verify", "HEAD"], {
      allowFailure: true,
    }).status === 0
  );
}

function taskWorktreePath(projectRoot: string, taskId: string): string {
  const identity = createHash("sha256")
    .update(resolve(projectRoot))
    .digest("hex")
    .slice(0, 12);
  return join(tmpdir(), "sharelane-worktrees", identity, taskId);
}

function linkDependencies(projectRoot: string, worktreePath: string): void {
  const source = join(projectRoot, "node_modules");
  const destination = join(worktreePath, "node_modules");
  if (!existsSync(source) || existsSync(destination)) return;
  symlinkSync(
    source,
    destination,
    process.platform === "win32" ? "junction" : "dir",
  );
}

export function createTaskWorkspace(input: {
  projectRoot: string;
  sourceRoot?: string;
  taskId: string;
  existingBranch?: string;
}): TaskWorkspace {
  const sourceRoot = input.sourceRoot ?? input.projectRoot;
  if (!isGitWorktree(sourceRoot)) return { sourceRoot };
  const worktreePath = taskWorktreePath(input.projectRoot, input.taskId);
  const branchName = input.existingBranch ?? `sharelane/${input.taskId}`;
  const baseCommit = git(sourceRoot, ["rev-parse", "HEAD"]).stdout.trim();
  mkdirSync(join(worktreePath, ".."), { recursive: true });
  if (input.existingBranch) {
    git(input.projectRoot, ["worktree", "add", worktreePath, branchName]);
  } else {
    git(sourceRoot, ["worktree", "add", "-b", branchName, worktreePath, baseCommit]);
  }
  try {
    linkDependencies(input.projectRoot, worktreePath);
  } catch (error) {
    git(input.projectRoot, ["worktree", "remove", "--force", worktreePath], {
      allowFailure: true,
    });
    throw error;
  }
  return { sourceRoot, worktreePath, branchName, baseCommit };
}

function nulSeparated(output: string): string[] {
  return output
    .split("\0")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value.replaceAll("\\", "/"));
}

export function listWorkspaceChanges(
  worktreePath: string,
  baseCommit?: string,
): string[] {
  const paths = new Set<string>();
  const commands = [
    ["diff", "--name-only", "-z"],
    ["diff", "--cached", "--name-only", "-z"],
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ];
  if (baseCommit) commands.push(["diff", "--name-only", "-z", `${baseCommit}..HEAD`]);
  for (const args of commands) {
    const result = git(worktreePath, args, { allowFailure: true });
    if (result.status === 0) {
      for (const path of nulSeparated(result.stdout)) paths.add(path);
    }
  }
  return [...paths].sort();
}

/**
 * Save out-of-scope changes as a patch for review, then restore those paths to
 * the task's starting commit so the task branch holds only in-scope work.
 */
function revertOutOfScope(
  worktreePath: string,
  baseCommit: string | undefined,
  paths: string[],
  patchPath: string | undefined,
): void {
  const base = baseCommit ?? "HEAD";
  if (patchPath) {
    const patch = git(worktreePath, ["diff", "--cached", "--binary", base, "--", ...paths]);
    mkdirSync(dirname(patchPath), { recursive: true });
    writeFileSync(patchPath, patch.stdout, "utf8");
  }
  for (const path of paths) {
    const existedAtBase =
      git(worktreePath, ["cat-file", "-e", `${base}:${path}`], { allowFailure: true })
        .status === 0;
    if (existedAtBase) {
      git(worktreePath, ["checkout", base, "--", path]);
    } else {
      git(worktreePath, ["rm", "-r", "-f", "--cached", "--ignore-unmatch", "--", path]);
      rmSync(join(worktreePath, path), { recursive: true, force: true });
    }
  }
}

export function finalizeTaskWorkspace(input: {
  projectRoot: string;
  taskId: string;
  worktreePath?: string;
  baseCommit?: string;
  scope?: string[];
  patchPath?: string;
}): FinalizedWorkspace {
  if (!input.worktreePath) {
    return { changedFiles: [], blockedFiles: [], cleanedUp: false };
  }
  const worktreePath = input.worktreePath;
  const changedBeforeCommit = listWorkspaceChanges(worktreePath, input.baseCommit);
  git(worktreePath, ["add", "-A"]);
  const blockedFiles = input.scope
    ? changedBeforeCommit.filter((path) => !pathInScope(input.scope ?? [], path))
    : [];
  if (blockedFiles.length > 0) {
    revertOutOfScope(worktreePath, input.baseCommit, blockedFiles, input.patchPath);
  }
  const stagedCheck = git(worktreePath, ["diff", "--cached", "--quiet"], {
    allowFailure: true,
  });
  if (stagedCheck.status !== 0 && stagedCheck.status !== 1) {
    throw new Error("Git could not inspect the staged task changes.");
  }
  const hasStagedChanges = stagedCheck.status === 1;
  if (hasStagedChanges) {
    git(worktreePath, [
      "-c",
      "user.name=ShareLane",
      "-c",
      "user.email=sharelane@local",
      "commit",
      "-m",
      `chore(sharelane): save ${input.taskId}`,
    ]);
  }
  const resultCommit = git(worktreePath, ["rev-parse", "HEAD"]).stdout.trim();
  const changedFiles = [
    ...new Set([
      ...changedBeforeCommit,
      ...listWorkspaceChanges(worktreePath, input.baseCommit),
    ]),
  ]
    .filter((path) => !blockedFiles.includes(path))
    .sort();
  const removed = git(
    input.projectRoot,
    ["worktree", "remove", "--force", worktreePath],
    { allowFailure: true },
  );
  if (removed.status === 0) {
    git(input.projectRoot, ["worktree", "prune"], { allowFailure: true });
  }
  return {
    resultCommit,
    changedFiles,
    blockedFiles,
    cleanedUp: removed.status === 0,
  };
}

export function describeWorkspace(workspace: TaskWorkspace): string {
  if (!workspace.worktreePath) {
    return `Direct workspace (Git isolation unavailable): ${workspace.sourceRoot}`;
  }
  return `${basename(workspace.worktreePath)} on ${workspace.branchName}`;
}
