import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentRegistry } from "../adapters/adapter.js";
import { CHECKS_PATH, installDefaultChecks } from "./checks.js";
import { initializeContext, relativeContextPath } from "./context.js";
import {
  approveClaudeMcpServer,
  installAntigravityIntegration,
  installClaudeClaimHook,
  installClaudeMcpConfig,
  installClaudeUsageStatusLine,
  type McpLauncher,
} from "./hooks.js";
import { installAgentInstructions, installRuntimeIgnores } from "./instructions.js";
import { findOnPath, resolveAgentExecutable } from "./runner.js";

/** The installed ShareLane package (this repo in development). */
export const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const packageName = (
  JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { name: string }
).name;

export interface ShareLaneLauncher extends McpLauncher {
  /** True when the path is project-relative, so a committed config works on any clone. */
  portable: boolean;
  /** Absolute path of the bin script the launcher runs. */
  binPath: string;
}

/**
 * How project MCP configs start `sharelane mcp`. MCP clients spawn servers
 * without a shell, and on Windows `npx` is `npx.cmd`, which cannot start that
 * way, so configs run `node <bin script> mcp`. The path is project-relative
 * when ShareLane is installed in the project's node_modules (or is the
 * project), which keeps committed configs portable and also works inside
 * delegated worktrees, where node_modules is linked. A package installed
 * elsewhere falls back to an absolute, machine-specific path.
 */
export function shareLaneLauncher(projectRoot: string): ShareLaneLauncher {
  const installed = join(projectRoot, "node_modules", packageName, "bin", "sharelane.mjs");
  const binPath = existsSync(installed) ? installed : join(packageRoot, "bin", "sharelane.mjs");
  const projectPath = relative(projectRoot, binPath);
  const portable = Boolean(projectPath) && !projectPath.startsWith("..") && !isAbsolute(projectPath);
  return {
    command: "node",
    args: [portable ? projectPath.replaceAll("\\", "/") : binPath, "mcp"],
    portable,
    binPath,
  };
}

export type CommandRunner = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => { status: number | null; output: string };

const runWithoutShell: CommandRunner = (command, args, env) => {
  const executable = resolveAgentExecutable(command, env);
  const result = spawnSync(executable.command, [...executable.prefixArgs, ...args], {
    env,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 60_000,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? result.error.message : ""}`.trim(),
  };
};

function displayCommand(command: string, args: string[]): string {
  return [command, ...args]
    .map((part) => (/[\s"]/.test(part) ? `"${part.replaceAll('"', '\\"')}"` : part))
    .join(" ");
}

const ANTIGRAVITY_RULE = "mcp(sharelane/*)";
const CODEX_APPROVE = 'default_tools_approval_mode = "approve"';

/**
 * Ensure Antigravity's global ShareLane allow rule. With `write` false it only
 * reports. "present" when it was already there.
 */
function allowAntigravityMcp(homeDir: string, write: boolean): "added" | "present" | "missing" {
  const path = join(homeDir, ".gemini", "antigravity-cli", "settings.json");
  const settings = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  settings.permissions ??= {};
  const allow: string[] = (settings.permissions.allow ??= []);
  if (allow.includes(ANTIGRAVITY_RULE)) return "present";
  if (!write) return "missing";
  allow.push(ANTIGRAVITY_RULE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return "added";
}

/** The `[mcp_servers.sharelane]` section of Codex's config, if registered. */
function readCodexEntry(codexHome: string) {
  const path = join(codexHome, "config.toml");
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "[mcp_servers.sharelane]");
  if (start === -1) return undefined;
  const next = lines.findIndex((line, index) => index > start && line.trim().startsWith("["));
  const section = lines.slice(start + 1, next === -1 ? undefined : next);
  return {
    path,
    lines,
    start,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
    approved: section.some((line) => /^\s*default_tools_approval_mode\s*=/.test(line)),
    /** Whether the entry starts this ShareLane install (paths compared loosely). */
    runs: (binPath: string) => {
      const loose = (value: string) => value.replaceAll("\\\\", "\\").replaceAll("/", "\\").toLowerCase();
      return loose(section.join("\n")).includes(loose(binPath));
    },
  };
}

/**
 * Let headless Codex workers call ShareLane tools without a prompt. `codex mcp
 * add` rewrites the server entry and drops this line, so it is re-added after.
 */
function approveCodexTools(codexHome: string): "added" | "present" | "missing" {
  const entry = readCodexEntry(codexHome);
  if (!entry) return "missing";
  if (entry.approved) return "present";
  entry.lines.splice(entry.start + 1, 0, CODEX_APPROVE);
  writeFileSync(entry.path, entry.lines.join(entry.eol), "utf8");
  return "added";
}

/** Why delegation cannot work here yet, or undefined when the repo is ready. */
function gitProblem(projectRoot: string): string | undefined {
  const git = (...args: string[]) =>
    spawnSync("git", args, { cwd: projectRoot, encoding: "utf8", windowsHide: true, shell: false });
  const inside = git("rev-parse", "--is-inside-work-tree");
  if (inside.error) return "Git is not installed or not on PATH. Install Git; delegated tasks run on Git branches.";
  if (inside.status !== 0) {
    return 'This folder is not a Git repository, so agents cannot delegate yet. Run: git init, git add -A, git commit -m "initial commit".';
  }
  if (git("rev-parse", "--verify", "HEAD").status !== 0) {
    return 'This repository has no commits yet, so delegated tasks have nothing to branch from. Run: git add -A, git commit -m "initial commit".';
  }
  return undefined;
}

export interface SetupOptions {
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Also set up the per-computer agent settings ShareLane needs (Codex's MCP
   * entry, Antigravity's allow rule). On by default; false only reports them.
   */
  global?: boolean;
  runCommand?: CommandRunner;
  /** Where global agent settings live; tests point this at a scratch folder. */
  homeDir?: string;
}

export interface SetupReport {
  detected: string[];
  lines: string[];
}

/** `sharelane init`: shared context, approved checks, and every detected agent. */
export function setupProject(options: SetupOptions): SetupReport {
  const { projectRoot } = options;
  const env = options.env ?? process.env;
  const runCommand = options.runCommand ?? runWithoutShell;
  const homeDir = options.homeDir ?? homedir();
  const applyGlobal = options.global ?? true;
  const done: string[] = [];
  const skipped: string[] = [];
  const todo: string[] = [];

  const problem = gitProblem(projectRoot);
  if (problem) todo.push(problem);

  const context = initializeContext(projectRoot);
  installAgentInstructions(projectRoot);
  installRuntimeIgnores(projectRoot);
  done.push(`Context map: ${relativeContextPath(context.mapPath, projectRoot)}`);
  done.push(`Database: ${relativeContextPath(context.databasePath, projectRoot)}`);
  done.push(
    context.createdChunks.length > 0
      ? `Created chunks: ${context.createdChunks.join(", ")}`
      : "Starter chunks already existed; none were overwritten.",
  );
  done.push("Agent instructions (AGENTS.md, CLAUDE.md) and local-runtime Git ignores.");

  const checksPath = CHECKS_PATH.replaceAll("\\", "/");
  const createdChecks = installDefaultChecks(projectRoot);
  if (createdChecks === undefined) {
    done.push(`Approved checks: kept your existing ${checksPath}.`);
  } else {
    done.push(
      createdChecks.length > 0
        ? `Approved checks from package.json: ${createdChecks.join(", ")} (${checksPath})`
        : `Created an empty ${checksPath}; add the commands agents may run.`,
    );
  }

  const launcher = shareLaneLauncher(projectRoot);
  const registry = loadAgentRegistry();
  const detected: string[] = [];
  const found = (agent: string): boolean => {
    const command = registry.agents[agent]?.command;
    const present = Boolean(command && findOnPath(command, env));
    if (present) detected.push(agent);
    else skipped.push(`${agent}: \`${command ?? agent}\` is not on PATH; skipped.`);
    return present;
  };

  if (found("claude")) {
    installClaudeMcpConfig(projectRoot, launcher);
    approveClaudeMcpServer(projectRoot);
    installClaudeClaimHook(projectRoot);
    const statusLine = installClaudeUsageStatusLine(projectRoot);
    done.push("Claude Code: MCP server in .mcp.json (pre-approved for you) and edit guard in .claude/settings.json.");
    done.push(
      statusLine
        ? "Claude Code: usage status line (chains to your own) in .claude/settings.json."
        : "Claude Code: left your project status line alone; quota checks use the usage-endpoint fallback.",
    );
  }

  if (found("antigravity")) {
    installAntigravityIntegration(projectRoot, launcher);
    done.push("Antigravity CLI: MCP server and edit guard in .agents/mcp_config.json and .agents/hooks.json.");
    const manual = `Antigravity CLI: add "${ANTIGRAVITY_RULE}" to permissions.allow in ~/.gemini/antigravity-cli/settings.json (its permission rules are global-only)`;
    try {
      const rule = allowAntigravityMcp(homeDir, applyGlobal);
      if (rule === "added") done.push(`Antigravity CLI: allowed ShareLane tools globally ("${ANTIGRAVITY_RULE}").`);
      else if (rule === "present") done.push("Antigravity CLI: ShareLane tools already allowed globally.");
      else todo.push(`${manual}, or run init without --no-global.`);
    } catch (error) {
      todo.push(`${manual}; ShareLane could not edit it (${(error as Error).message}).`);
    }
  }

  if (found("codex")) {
    // Codex reads MCP servers only from its global config, so it needs an absolute path.
    const args = [
      "mcp",
      "add",
      "sharelane",
      "--env",
      "SHARELANE_AGENT=codex",
      "--",
      process.execPath,
      launcher.binPath,
      "mcp",
    ];
    const codexCommand = registry.agents.codex!.command;
    const shown = displayCommand(codexCommand, args);
    const approveStep = `Codex: so headless workers can call ShareLane, add ${CODEX_APPROVE} under [mcp_servers.sharelane] in ~/.codex/config.toml`;
    const codexHome = env.CODEX_HOME || join(homeDir, ".codex");
    const entry = readCodexEntry(codexHome);
    let registered = Boolean(entry?.runs(launcher.binPath));
    if (registered) {
      done.push("Codex: global ShareLane MCP server already connected.");
    } else if (applyGlobal) {
      const result = runCommand(codexCommand, args, env);
      registered = result.status === 0;
      if (registered) done.push(`Codex: connected the global ShareLane MCP server (${shown}).`);
      else todo.push(`Codex: \`${shown}\` failed (${result.output || `exit ${result.status}`}); run it yourself.`);
    } else {
      todo.push(`Codex uses a global MCP entry. Run it yourself, or run init without --no-global:\n    ${shown}`);
    }
    // Re-read after `codex mcp add`, which drops the approval line.
    const approval = !registered
      ? "missing"
      : applyGlobal
        ? approveCodexTools(codexHome)
        : readCodexEntry(codexHome)?.approved
          ? "present"
          : "missing";
    if (approval === "added") done.push("Codex: headless workers may call ShareLane tools without a prompt.");
    else if (approval === "missing") todo.push(`${approveStep}.`);
  }

  if (detected.length === 0) {
    todo.push("No agent CLI (claude, codex, agy) was found on PATH. Install one and run init again.");
  }
  const sharing: string[] = [];
  if (!launcher.portable) {
    sharing.push(
      `The agent configs use this computer's ShareLane (absolute path ${launcher.binPath}), which is fine on your own. For teammates, run npm install --save-dev sharelane and init again.`,
    );
  }
  sharing.push(
    `Commit .sharelane/context/, ${checksPath}, AGENTS.md, CLAUDE.md, and the generated agent configs so every clone and delegated worktree sees them.`,
  );

  // Rebuild once more in case an existing chunk covers a file written above.
  initializeContext(projectRoot);

  const lines = [
    "ShareLane is set up.",
    "",
    "Done:",
    ...done.map((line) => `- ${line}`),
  ];
  if (skipped.length > 0) lines.push("", "Skipped:", ...skipped.map((line) => `- ${line}`));
  lines.push("", "Still to do:", ...(todo.length > 0 ? todo.map((line) => `- ${line}`) : ["- Nothing."]));
  lines.push("", "When you share this repo:", ...sharing.map((line) => `- ${line}`));
  return { detected, lines };
}
