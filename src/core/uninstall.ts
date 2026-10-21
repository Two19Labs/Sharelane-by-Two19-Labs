import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { getShareLanePaths, openDatabase } from "./database.js";
import { removeAgentIntegrations } from "./hooks.js";
import { removeAgentInstructions, removeRuntimeIgnores } from "./instructions.js";
import { removeGlobalSettings, type CommandRunner } from "./setup.js";

export interface UninstallOptions {
  projectRoot: string;
  /** Also remove the per-computer settings every project shares. */
  global?: boolean;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  runCommand?: CommandRunner;
}

/** `sharelane uninstall`: remove everything `init` added to this project. */
export function uninstallProject(options: UninstallOptions): string[] {
  const { projectRoot } = options;
  const paths = getShareLanePaths(projectRoot);

  if (existsSync(paths.database)) {
    const database = openDatabase(projectRoot);
    try {
      const active = database
        .prepare("SELECT count(*) AS count FROM tasks WHERE status IN ('queued', 'running')")
        .get() as { count: number };
      if (active.count > 0) {
        throw new Error(
          `${active.count} delegated task(s) are still running here. Stop them first (sharelane dashboard, then Stop), then run uninstall again.`,
        );
      }
    } finally {
      database.close();
    }
  }

  const lines: string[] = [];
  for (const file of removeAgentIntegrations(projectRoot)) lines.push(`Removed ShareLane from ${file.replaceAll("\\", "/")}.`);
  for (const file of removeAgentInstructions(projectRoot)) lines.push(`Removed the ShareLane block from ${file}.`);
  if (removeRuntimeIgnores(projectRoot)) lines.push("Removed ShareLane's lines from .gitignore.");

  if (existsSync(paths.shareLaneDir)) {
    try {
      rmSync(paths.shareLaneDir, { recursive: true, force: true, maxRetries: 3 });
      lines.push("Deleted .sharelane/ (context, database, logs and timers). Context you committed is still in Git history.");
    } catch (error) {
      lines.push(
        `Could not delete .sharelane/ (${(error as Error).message}). Close any agent or dashboard using this project and delete it yourself.`,
      );
    }
  }

  const removedFromProject = lines.length > 0;
  if (options.global) {
    lines.push(...removeGlobalSettings({ env: options.env, homeDir: options.homeDir, runCommand: options.runCommand }));
  } else {
    lines.push(
      "Kept the global Codex and Antigravity settings, which your other projects use. To remove those too: sharelane uninstall --global",
    );
  }

  const branches = spawnSync("git", ["branch", "--list", "sharelane/*", "--format=%(refname:short)"], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  const taskBranches = (branches.stdout ?? "").split(/\r?\n/).filter(Boolean);
  if (taskBranches.length > 0) {
    lines.push(
      `Kept ${taskBranches.length} task branch(es) (sharelane/…), which may hold work you haven't merged. Merge what you want, then delete each with: git branch -D <name>`,
    );
  }
  const heading = removedFromProject ? "ShareLane was removed from this project." : "ShareLane was not set up in this project.";
  return [heading, "", ...lines.map((line) => `- ${line}`)];
}
