import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { resolveAgentExecutable } from "./runner.js";

/**
 * Owner-approved checks: a committed allow-list of exact commands (tests,
 * typecheck, lint) that agents may run through ShareLane's run_check tool,
 * including agents whose CLI cannot run terminal commands headlessly.
 */
export const CHECKS_PATH = join(".sharelane", "checks.json");
export const DEFAULT_CHECK_TIMEOUT_SECONDS = 600;
const OUTPUT_LIMIT_BYTES = 8 * 1024;

const checkSchema = z
  .object({
    command: z.string().trim().min(1),
    args: z.array(z.string()).default([]),
    timeoutSeconds: z.number().int().min(1).max(7_200).default(DEFAULT_CHECK_TIMEOUT_SECONDS),
    description: z.string().optional(),
  })
  .strict();

const checksSchema = z
  .object({
    version: z.literal(1),
    checks: z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/), checkSchema),
  })
  .strict();

export type CheckConfig = z.infer<typeof checkSchema>;

export interface CheckResult {
  name: string;
  commandLine: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
  truncated: boolean;
}

/**
 * Read and validate .sharelane/checks.json; a missing file means no approved checks.
 * Callers pass the owner's project root (not a delegated worker's worktree), so a
 * worker cannot approve its own commands by editing its copy of the file. Note that
 * a check such as `npm test` still runs project code the agent may have written:
 * run_check limits which command lines run, it is not a sandbox.
 */
export function loadChecks(root = process.cwd()): Record<string, CheckConfig> {
  const path = join(root, CHECKS_PATH);
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${CHECKS_PATH} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = checksSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${CHECKS_PATH} is invalid at ${issue?.path.join(".") || "(root)"}: ${issue?.message}`);
  }
  return parsed.data.checks;
}

function commandLineOf(check: CheckConfig): string {
  return [check.command, ...check.args].join(" ");
}

export function describeChecks(checks: Record<string, CheckConfig>): string {
  const names = Object.keys(checks);
  if (names.length === 0) {
    return `No approved checks. The project owner can add them to ${CHECKS_PATH.replaceAll("\\", "/")}.`;
  }
  return [
    "Approved checks (call run_check with a name):",
    ...names.map((name) => {
      const check = checks[name]!;
      return `- ${name}: ${commandLineOf(check)}${check.description ? ` (${check.description})` : ""}`;
    }),
  ].join("\n");
}

/** Stop a check and everything it started (npm runs scripts in child processes). */
function killTree(processId: number | undefined): void {
  if (processId === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(processId), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-processId, "SIGKILL");
  } catch {
    // Already gone.
  }
}

export async function runCheck(input: {
  name: string;
  workspaceRoot: string;
  checks?: Record<string, CheckConfig>;
  env?: NodeJS.ProcessEnv;
  outputLimitBytes?: number;
}): Promise<CheckResult> {
  const checks = input.checks ?? loadChecks(input.workspaceRoot);
  const check = checks[input.name];
  if (!check) {
    throw new Error(`"${input.name}" is not an approved check. ${describeChecks(checks)}`);
  }
  const limit = input.outputLimitBytes ?? OUTPUT_LIMIT_BYTES;
  const env = { ...process.env, ...input.env };
  const executable = resolveAgentExecutable(check.command, env);
  const started = Date.now();

  return await new Promise<CheckResult>((resolve, reject) => {
    const child = spawn(executable.command, [...executable.prefixArgs, ...check.args], {
      cwd: input.workspaceRoot,
      env,
      shell: false,
      windowsHide: true,
      // A separate process group lets a timeout stop the whole tree on POSIX.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = Buffer.alloc(0);
    let truncated = false;
    const collect = (chunk: Buffer): void => {
      output = Buffer.concat([output, chunk]);
      if (output.length > limit * 2) {
        output = output.subarray(output.length - limit);
        truncated = true;
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, check.timeoutSeconds * 1_000);

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not start check "${input.name}" (${commandLineOf(check)}): ${error.message}`));
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      if (output.length > limit) {
        output = output.subarray(output.length - limit);
        truncated = true;
      }
      resolve({
        name: input.name,
        commandLine: commandLineOf(check),
        exitCode: timedOut ? null : exitCode,
        timedOut,
        durationMs: Date.now() - started,
        output: output.toString("utf8"),
        truncated,
      });
    });
  });
}

export function describeCheckResult(result: CheckResult): string {
  const seconds = (result.durationMs / 1_000).toFixed(1);
  const status = result.timedOut
    ? `TIMED OUT after ${seconds}s (process tree stopped)`
    : `${result.exitCode === 0 ? "PASSED" : "FAILED"} with exit code ${result.exitCode ?? "none"} in ${seconds}s`;
  return [
    `Check ${result.name} (${result.commandLine}): ${status}`,
    result.truncated ? "Output (last 8 KB):" : "Output:",
    result.output.trimEnd() || "(no output)",
  ].join("\n");
}

const DEFAULT_SCRIPTS = ["test", "typecheck", "lint"];

/**
 * Create .sharelane/checks.json from the project's package.json scripts named
 * test, typecheck, and lint. Never overwrites an existing file. Returns the
 * created check names, or undefined when the file already existed.
 */
export function installDefaultChecks(projectRoot = process.cwd()): string[] | undefined {
  const path = join(projectRoot, CHECKS_PATH);
  if (existsSync(path)) return undefined;
  let scripts: Record<string, unknown> = {};
  try {
    const manifest = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    scripts = manifest.scripts ?? {};
  } catch {
    // No package.json: start with an empty allow-list the owner can fill.
  }
  const checks: Record<string, CheckConfig> = {};
  for (const name of DEFAULT_SCRIPTS) {
    const script = scripts[name];
    // npm init's placeholder test script always fails; it is not a real check.
    if (typeof script !== "string" || /no test specified/i.test(script)) continue;
    checks[name] = {
      command: "npm",
      args: name === "test" ? ["test"] : ["run", name],
      timeoutSeconds: DEFAULT_CHECK_TIMEOUT_SECONDS,
    };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version: 1, checks }, null, 2)}\n`, "utf8");
  return Object.keys(checks);
}
