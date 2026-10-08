import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { delimiter, dirname, extname, join, relative } from "node:path";
import { spawn } from "node:child_process";
import {
  buildAgentCommand,
  loadAgentRegistry,
  type AgentRegistry,
  type CommandScope,
} from "../adapters/adapter.js";
import {
  parseAgentOutput,
  type AgentUsage,
} from "../adapters/result.js";
import { describeModel, type ModelSelection } from "./tiers.js";

export interface RunAgentOptions {
  agent: string;
  prompt: string;
  projectRoot?: string;
  sessionId?: string;
  registry?: AgentRegistry;
  logPath?: string;
  env?: NodeJS.ProcessEnv;
  scope?: CommandScope;
  /** Model and effort for this run (from the task's tier); omitted = the agent's own default. */
  model?: ModelSelection;
  onSpawn?: (processId: number | undefined) => void;
}

export interface AgentRunResult {
  agent: string;
  finalMessage: string;
  sessionId: string;
  usage: AgentUsage;
  exitCode: number;
  signal: NodeJS.Signals | null;
  resumed: boolean;
  logPath: string;
  stdout: string;
  stderr: string;
  startedAt: string;
  finishedAt: string;
}

function defaultLogPath(projectRoot: string, agent: string): string {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  return join(
    projectRoot,
    ".sharelane",
    "runs",
    `${timestamp}-${agent}-${randomUUID().slice(0, 8)}.log`,
  );
}

/**
 * Windows npm installs CLIs as `.cmd` launchers, which Node cannot start
 * without a shell. Resolve such a launcher to "node <script>" so agent
 * prompts are still passed as plain arguments with no shell involved.
 */
/**
 * Overlay extra variables on a base environment. Windows names are
 * case-insensitive (its PATH is usually stored as "Path"), so an extra
 * variable replaces any base variable whose name differs only in case.
 */
export function mergeEnvironment(
  base: NodeJS.ProcessEnv,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const [name, value] of Object.entries(extra)) {
    if (process.platform === "win32") {
      for (const existing of Object.keys(env)) {
        if (existing !== name && existing.toUpperCase() === name.toUpperCase()) delete env[existing];
      }
    }
    env[name] = value;
  }
  return env;
}

export function resolveAgentExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; prefixArgs: string[] } {
  const unchanged = { command, prefixArgs: [] };
  if (process.platform !== "win32" || /[\\/]/.test(command) || extname(command)) {
    return unchanged;
  }
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
  const directories = (pathKey ? env[pathKey] ?? "" : "").split(";").filter(Boolean);
  for (const directory of directories) {
    // Match Windows' own lookup order within a folder: executables before .cmd.
    for (const extension of [".com", ".exe"]) {
      const candidate = join(directory, `${command}${extension}`);
      if (existsSync(candidate)) return { command: candidate, prefixArgs: [] };
    }
    const launcher = join(directory, `${command}.cmd`);
    if (existsSync(launcher)) {
      const source = readFileSync(launcher, "utf8");
      // npm's cmd-shim launchers use "%dp0%\x.js"; npm.cmd and npx.cmd themselves
      // set *_CLI_JS=%~dp0\node_modules\npm\bin\<npm|npx>-cli.js.
      const script =
        /"%dp0%\\([^"]+\.[cm]?js)"/.exec(source)?.[1] ??
        /_CLI_JS=%~dp0\\+([^"%]+\.[cm]?js)"/.exec(source)?.[1];
      if (script && existsSync(join(directory, script))) {
        return { command: process.execPath, prefixArgs: [join(directory, script)] };
      }
    }
  }
  return unchanged;
}

/** Find a command on PATH the way a shell would; undefined when it is not installed. */
export function findOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
  const directories = (pathKey ? env[pathKey] ?? "" : "").split(delimiter).filter(Boolean);
  const extensions = process.platform === "win32" ? [".com", ".exe", ".cmd", ".bat"] : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Not in this folder.
      }
    }
  }
  return undefined;
}

export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const registry = options.registry ?? loadAgentRegistry();
  const command = buildAgentCommand(
    options.agent,
    options.prompt,
    options.sessionId,
    registry,
    options.scope,
    options.model,
  );
  const logPath = options.logPath ?? defaultLogPath(projectRoot, options.agent);
  await mkdir(dirname(logPath), { recursive: true });

  const startedAt = new Date().toISOString();
  const log = createWriteStream(logPath, { encoding: "utf8", flags: "a" });
  log.write(`ShareLane run: ${options.agent}\nModel: ${describeModel(options.model)}\nStarted: ${startedAt}\n\n`);

  const env = mergeEnvironment(process.env, options.env);
  const executable = resolveAgentExecutable(command.command, env);

  return await new Promise<AgentRunResult>((resolve, reject) => {
    const child = spawn(executable.command, [...executable.prefixArgs, ...command.args], {
      cwd: projectRoot,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    options.onSpawn?.(child.pid);

    let stdout = "";
    let stderr = "";
    // A child that fails to start emits "error" and then "close": finish the
    // log exactly once, and drop output that arrives after it is closed.
    let finished = false;
    log.on("error", () => {});
    const record = (text: string) => {
      if (!log.writableEnded) log.write(text);
    };
    const finish = (text: string, then: () => void) => {
      if (finished) return;
      finished = true;
      log.end(text, then);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      record(`[stdout] ${chunk}`);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      record(`[stderr] ${chunk}`);
    });

    child.once("error", (error) => {
      finish(`\nRunner error: ${error.message}\n`, () => reject(error));
    });
    child.once("close", (exitCode, signal) => {
      const finishedAt = new Date().toISOString();
      const code = exitCode ?? 1;
      finish(`\nFinished: ${finishedAt}\nExit code: ${code}\n`, () => {
        if (code !== 0) {
          // Some CLIs (Codex) report errors such as "out of credits" in their
          // JSON output, so include the last error-looking stdout line too.
          const stdoutError = stdout
            .split(/\r?\n/)
            .filter((line) => /error|failed|limit|credit|quota/i.test(line))
            .at(-1)
            ?.trim()
            .slice(0, 400);
          reject(
            new Error(
              `${options.agent} exited with code ${code}. See ${relative(projectRoot, logPath)}.${stderr.trim() ? ` ${stderr.trim()}` : ""}${stdoutError ? ` Output: ${stdoutError}` : ""}`,
            ),
          );
          return;
        }

        try {
          const parsed = parseAgentOutput(command.output, stdout);
          resolve({
            agent: options.agent,
            ...parsed,
            exitCode: code,
            signal,
            resumed: command.resumed,
            logPath,
            stdout,
            stderr,
            startedAt,
            finishedAt,
          });
        } catch (error) {
          reject(error);
        }
      });
    });
  });
}
