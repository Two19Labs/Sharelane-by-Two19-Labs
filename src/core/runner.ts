import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
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

export interface RunAgentOptions {
  agent: string;
  prompt: string;
  projectRoot?: string;
  sessionId?: string;
  registry?: AgentRegistry;
  logPath?: string;
  env?: NodeJS.ProcessEnv;
  scope?: CommandScope;
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

export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const registry = options.registry ?? loadAgentRegistry();
  const command = buildAgentCommand(
    options.agent,
    options.prompt,
    options.sessionId,
    registry,
    options.scope,
  );
  const logPath = options.logPath ?? defaultLogPath(projectRoot, options.agent);
  await mkdir(dirname(logPath), { recursive: true });

  const startedAt = new Date().toISOString();
  const log = createWriteStream(logPath, { encoding: "utf8", flags: "a" });
  log.write(`ShareLane run: ${options.agent}\nStarted: ${startedAt}\n\n`);

  return await new Promise<AgentRunResult>((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      cwd: projectRoot,
      env: { ...process.env, ...options.env },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    options.onSpawn?.(child.pid);

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      log.write(`[stdout] ${chunk}`);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      log.write(`[stderr] ${chunk}`);
    });

    child.once("error", (error) => {
      log.end(`\nRunner error: ${error.message}\n`, () => reject(error));
    });
    child.once("close", (exitCode, signal) => {
      const finishedAt = new Date().toISOString();
      const code = exitCode ?? 1;
      log.end(`\nFinished: ${finishedAt}\nExit code: ${code}\n`, () => {
        if (code !== 0) {
          reject(
            new Error(
              `${options.agent} exited with code ${code}. See ${relative(projectRoot, logPath)}.${stderr.trim() ? ` ${stderr.trim()}` : ""}`,
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
