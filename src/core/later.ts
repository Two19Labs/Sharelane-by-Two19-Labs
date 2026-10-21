import { randomBytes } from "node:crypto";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { loadAgentRegistry } from "../adapters/adapter.js";
import { getShareLanePaths } from "./database.js";
import { DEFAULT_HANDOFF_THRESHOLD, readClaudeQuota, type QuotaReport } from "./quota.js";
import { findOnPath, resolveAgentExecutable } from "./runner.js";
import { shareLaneLauncher } from "./setup.js";

export interface LaterEntry {
  id: string;
  prompt: string;
  projectRoot: string;
  createdAt: string; // ISO
  fireAt: string; // ISO; may move later for --when-reset
  when: "in" | "at" | "reset";
  mode: "window" | "background";
  session?: string; // undefined => use --continue
  status: "scheduled" | "running" | "done" | "failed" | "cancelled";
  pid?: number; // the waiting process
  firedAt?: string;
  exitCode?: number;
  error?: string;
  log?: string; // background mode: path of the output log
  resetMoves?: number;
}

export interface ParseWhenOptions {
  in?: string;
  at?: string;
  whenReset?: boolean;
  now?: number | Date;
  quotaReport?: QuotaReport;
}

export interface ParseWhenResult {
  fireAt: string;
  when: "in" | "at" | "reset";
  resetsAt?: string;
}

export function parseDurationMinutes(duration: string): number {
  const trimmed = duration.trim();
  if (!trimmed || trimmed.startsWith("-")) {
    throw new Error(`Invalid duration "${duration}": duration must be positive.`);
  }
  if (/^\d+$/.test(trimmed)) {
    const mins = Number(trimmed);
    if (mins <= 0) throw new Error(`Invalid duration "${duration}": duration must be positive.`);
    if (mins > 7 * 24 * 60) throw new Error(`Invalid duration "${duration}": cannot exceed 7 days.`);
    return mins;
  }
  const match = /^(?:(\d+)h)?(?:(\d+)m)?$/i.exec(trimmed);
  if (!match || (!match[1] && !match[2])) {
    throw new Error(`Invalid duration "${duration}": format must be like 2h, 90m, or 1h30m.`);
  }
  const hours = match[1] ? parseInt(match[1], 10) : 0;
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  const total = hours * 60 + minutes;
  if (total <= 0) throw new Error(`Invalid duration "${duration}": duration must be positive.`);
  if (total > 7 * 24 * 60) throw new Error(`Invalid duration "${duration}": cannot exceed 7 days.`);
  return total;
}

export function parseWhen(options: ParseWhenOptions): ParseWhenResult {
  const count =
    (options.in !== undefined ? 1 : 0) +
    (options.at !== undefined ? 1 : 0) +
    (options.whenReset ? 1 : 0);
  if (count !== 1) {
    throw new Error("Exactly one of --in, --at or --when-reset is required.");
  }

  const nowMs =
    options.now instanceof Date
      ? options.now.getTime()
      : typeof options.now === "number"
        ? options.now
        : Date.now();

  if (options.in !== undefined) {
    const minutes = parseDurationMinutes(options.in);
    const fireAt = new Date(nowMs + minutes * 60_000).toISOString();
    return { fireAt, when: "in" };
  }

  if (options.at !== undefined) {
    const trimmed = options.at.trim();
    const hhmmMatch = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(trimmed);
    if (hhmmMatch) {
      const hours = parseInt(hhmmMatch[1], 10);
      const minutes = parseInt(hhmmMatch[2], 10);
      const target = new Date(nowMs);
      target.setHours(hours, minutes, 0, 0);
      if (target.getTime() <= nowMs) {
        target.setDate(target.getDate() + 1);
      }
      return { fireAt: target.toISOString(), when: "at" };
    }

    const parsed = Date.parse(trimmed);
    if (Number.isNaN(parsed)) {
      throw new Error(`Invalid time "${options.at}": use HH:MM or an ISO timestamp.`);
    }
    if (parsed <= nowMs) {
      throw new Error(`Time "${options.at}" is in the past.`);
    }
    return { fireAt: new Date(parsed).toISOString(), when: "at" };
  }

  // options.whenReset === true
  const report = options.quotaReport;
  const validWindows = (report?.windows ?? []).filter(
    (w) => w.resetsAt !== undefined && !Number.isNaN(Date.parse(w.resetsAt)) && Date.parse(w.resetsAt) > nowMs,
  );
  if (validWindows.length === 0) {
    throw new Error("ShareLane can't read when your Claude limit resets. Use --in or --at instead.");
  }

  const lowest = validWindows.reduce((min, cur) =>
    cur.remainingPercent < min.remainingPercent ? cur : min,
  );
  const resetMs = Date.parse(lowest.resetsAt!);
  const fireAt = new Date(resetMs + 2 * 60_000).toISOString();
  return { fireAt, when: "reset", resetsAt: lowest.resetsAt };
}

export function isValidSessionId(session: string): boolean {
  return /^[0-9a-f-]{8,}$/i.test(session);
}

export function latestClaudeSession(projectRoot: string, homeDir = homedir()): string | undefined {
  try {
    const encoded = projectRoot.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
    const projectsDir = join(homeDir, ".claude", "projects");
    if (!existsSync(projectsDir)) return undefined;
    const folders = readdirSync(projectsDir);
    const matchedFolder = folders.find((name) => name.toLowerCase() === encoded);
    if (!matchedFolder) return undefined;

    const targetDir = join(projectsDir, matchedFolder);
    const files = readdirSync(targetDir).filter((file) => file.endsWith(".jsonl"));
    if (files.length === 0) return undefined;

    let newestFile: string | undefined;
    let newestMtime = -Infinity;
    for (const file of files) {
      try {
        const mtime = statSync(join(targetDir, file)).mtimeMs;
        if (mtime > newestMtime) {
          newestMtime = mtime;
          newestFile = file;
        }
      } catch {
        // Skip unreadable files
      }
    }
    if (!newestFile) return undefined;
    return newestFile.slice(0, -6);
  } catch {
    return undefined;
  }
}

export function laterDir(projectRoot: string): string {
  return join(projectRoot, ".sharelane", "later");
}

export function entryPath(projectRoot: string, id: string): string {
  return join(laterDir(projectRoot), `${id}.json`);
}

export function saveLaterEntry(entry: LaterEntry): void {
  const dir = laterDir(entry.projectRoot);
  mkdirSync(dir, { recursive: true });
  const file = entryPath(entry.projectRoot, entry.id);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

export function loadLaterEntry(projectRoot: string, id: string): LaterEntry | undefined {
  try {
    const file = entryPath(projectRoot, id);
    if (!existsSync(file)) return undefined;
    const content = readFileSync(file, "utf8");
    return JSON.parse(content) as LaterEntry;
  } catch {
    return undefined;
  }
}

export function listLaterEntries(projectRoot: string): LaterEntry[] {
  const dir = laterDir(projectRoot);
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const entries: LaterEntry[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), "utf8");
      entries.push(JSON.parse(content) as LaterEntry);
    } catch {
      // Ignore corrupted or unreadable files
    }
  }
  entries.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return entries;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function formatRelativeTime(targetIso: string, nowMs = Date.now()): string {
  const diffMs = Date.parse(targetIso) - nowMs;
  if (diffMs >= 0) {
    const totalMins = Math.round(diffMs / 60_000);
    if (totalMins < 60) {
      return `in ${totalMins}m`;
    }
    const h = Math.floor(totalMins / 60);
    const m = totalMins % 60;
    return `in ${h}h ${m}m`;
  }
  const totalMins = Math.round(-diffMs / 60_000);
  if (totalMins < 60) {
    return `${totalMins}m ago`;
  }
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return m === 0 ? `${h}h ago` : `${h}h ${m}m ago`;
}

export function formatLaterList(
  entries: LaterEntry[],
  nowMs = Date.now(),
  pidChecker: (pid: number) => boolean = isPidAlive,
): string[] {
  if (entries.length === 0) {
    return ['Nothing scheduled. Example: sharelane later "continue" --in 2h'];
  }

  return entries.map((entry) => {
    let statusText: string = entry.status;
    if (entry.status === "scheduled" && entry.pid !== undefined && !pidChecker(entry.pid)) {
      statusText = "lost (computer restarted?)";
    }

    const fireDate = new Date(entry.fireAt);
    const hh = String(fireDate.getHours()).padStart(2, "0");
    const mm = String(fireDate.getMinutes()).padStart(2, "0");
    const timeDisplay = `${hh}:${mm} (${formatRelativeTime(entry.fireAt, nowMs)})`;
    const promptPreview = entry.prompt.replace(/\r?\n/g, " ").slice(0, 50);

    return `${entry.id}  ${statusText.padEnd(28)}  ${timeDisplay.padEnd(22)}  ${entry.mode.padEnd(10)}  ${promptPreview}`;
  });
}

export function cancelLaterEntry(
  projectRoot: string,
  idOrPrefix: string,
  options?: { killProcess?: (pid: number) => void },
): { cancelled: LaterEntry } {
  const prefix = idOrPrefix.trim().toLowerCase();
  if (prefix.length < 4) {
    throw new Error("Cancel requires an ID or prefix of at least 4 characters.");
  }

  const entries = listLaterEntries(projectRoot);
  const matches = entries.filter((e) => e.id.toLowerCase().startsWith(prefix));
  if (matches.length === 0) {
    throw new Error(`No scheduled entry found matching "${idOrPrefix}".`);
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous ID prefix "${idOrPrefix}" matches ${matches.length} entries.`);
  }

  const target = matches[0];
  if (target.status !== "scheduled") {
    throw new Error(`Cannot cancel entry ${target.id}: it is already ${target.status}.`);
  }

  target.status = "cancelled";
  saveLaterEntry(target);

  if (target.pid) {
    try {
      (options?.killProcess ?? process.kill)(target.pid);
    } catch {
      // Ignore errors killing the process
    }
  }

  return { cancelled: target };
}

export interface TerminalCommandSpec {
  command: string;
  args: string[];
  options: {
    cwd: string;
    detached: boolean;
    stdio: "ignore";
    windowsHide?: boolean;
    shell: false;
  };
  scriptPath?: string;
  fallbackToBackground?: boolean;
}

export function buildTerminalCommand(options: {
  platform: NodeJS.Platform;
  projectRoot: string;
  binPath: string;
  id: string;
  nodePath?: string;
  env?: NodeJS.ProcessEnv;
}): TerminalCommandSpec {
  const node = options.nodePath ?? process.execPath;
  const env = options.env ?? process.env;

  if (options.platform === "win32") {
    return {
      command: "cmd.exe",
      args: [
        "/d",
        "/c",
        "start",
        "ShareLane later",
        "/D",
        options.projectRoot,
        node,
        options.binPath,
        "later",
        "run",
        options.id,
      ],
      options: {
        cwd: options.projectRoot,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        shell: false,
      },
    };
  }

  if (options.platform === "darwin") {
    const dir = laterDir(options.projectRoot);
    const scriptPath = join(dir, `${options.id}.command`);
    return {
      command: "open",
      args: ["-a", "Terminal", scriptPath],
      scriptPath,
      options: {
        cwd: options.projectRoot,
        detached: true,
        stdio: "ignore",
        shell: false,
      },
    };
  }

  // Linux: check x-terminal-emulator then gnome-terminal
  const hasXTerm = findOnPath("x-terminal-emulator", env);
  if (hasXTerm) {
    return {
      command: "x-terminal-emulator",
      args: ["-e", node, options.binPath, "later", "run", options.id],
      options: {
        cwd: options.projectRoot,
        detached: true,
        stdio: "ignore",
        shell: false,
      },
    };
  }

  const hasGnome = findOnPath("gnome-terminal", env);
  if (hasGnome) {
    return {
      command: "gnome-terminal",
      args: ["--", node, options.binPath, "later", "run", options.id],
      options: {
        cwd: options.projectRoot,
        detached: true,
        stdio: "ignore",
        shell: false,
      },
    };
  }

  return {
    command: "",
    args: [],
    fallbackToBackground: true,
    options: {
      cwd: options.projectRoot,
      detached: true,
      stdio: "ignore",
      shell: false,
    },
  };
}

export async function executeBackgroundMode(
  entry: LaterEntry,
  options?: {
    env?: NodeJS.ProcessEnv;
    claudeCommand?: string;
  },
): Promise<void> {
  const env = options?.env ?? process.env;
  const registry = loadAgentRegistry();
  const claude = options?.claudeCommand ?? registry.agents.claude?.command ?? "claude";
  const executable = resolveAgentExecutable(claude, env);

  const dir = laterDir(entry.projectRoot);
  mkdirSync(dir, { recursive: true });
  const logFile = join(dir, `${entry.id}.log`);
  const logStream = createWriteStream(logFile, { encoding: "utf8", flags: "a" });

  const args = [
    ...executable.prefixArgs,
    "-p",
    entry.prompt,
    ...(entry.session ? ["--resume", entry.session] : ["--continue"]),
    "--permission-mode",
    "acceptEdits",
    "--output-format",
    "json",
  ];

  await new Promise<void>((resolve) => {
    const child = spawn(executable.command, args, {
      cwd: entry.projectRoot,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk: Buffer | string) => {
      if (!logStream.writableEnded) logStream.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (!logStream.writableEnded) logStream.write(chunk);
    });

    child.on("error", (err) => {
      if (!logStream.writableEnded) logStream.write(`\nError: ${err.message}\n`);
      entry.status = "failed";
      entry.error = err.message;
      entry.exitCode = 1;
      entry.log = logFile;
      logStream.end(() => {
        saveLaterEntry(entry);
        resolve();
      });
    });

    child.on("close", (code, signal) => {
      entry.exitCode = code ?? (signal ? 1 : 0);
      entry.status = entry.exitCode === 0 ? "done" : "failed";
      entry.log = logFile;
      logStream.end(() => {
        saveLaterEntry(entry);
        resolve();
      });
    });
  });
}

export async function runLaterEntry(
  projectRoot: string,
  id: string,
  options?: { env?: NodeJS.ProcessEnv; claudeCommand?: string },
): Promise<void> {
  const entry = loadLaterEntry(projectRoot, id);
  if (!entry) {
    throw new Error(`Entry ${id} not found.`);
  }

  const env = options?.env ?? process.env;
  const registry = loadAgentRegistry();
  const claude = options?.claudeCommand ?? registry.agents.claude?.command ?? "claude";
  const executable = resolveAgentExecutable(claude, env);

  const args = [
    ...executable.prefixArgs,
    ...(entry.session ? ["--resume", entry.session] : ["--continue"]),
    entry.prompt,
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable.command, args, {
      cwd: projectRoot,
      env,
      shell: false,
      stdio: "inherit",
    });

    child.on("error", (err) => {
      entry.status = "failed";
      entry.error = err.message;
      entry.exitCode = 1;
      saveLaterEntry(entry);
      reject(err);
    });

    child.on("close", (code, signal) => {
      entry.exitCode = code ?? (signal ? 1 : 0);
      entry.status = entry.exitCode === 0 ? "done" : "failed";
      saveLaterEntry(entry);
      console.log("ShareLane: this chat was resumed on a timer. You can keep working here.");
      resolve();
    });
  });
}

export async function fireLaterEntry(
  entry: LaterEntry,
  options?: {
    binPath?: string;
    env?: NodeJS.ProcessEnv;
    spawnProcess?: typeof spawn;
    claudeCommand?: string;
  },
): Promise<void> {
  if (entry.mode === "background") {
    await executeBackgroundMode(entry, options);
    return;
  }

  // Window mode
  const bin = options?.binPath ?? shareLaneLauncher(entry.projectRoot).binPath;
  const spec = buildTerminalCommand({
    platform: process.platform,
    projectRoot: entry.projectRoot,
    binPath: bin,
    id: entry.id,
    env: options?.env,
  });

  if (spec.fallbackToBackground) {
    entry.error = "no terminal found; ran in the background";
    saveLaterEntry(entry);
    await executeBackgroundMode(entry, options);
    return;
  }

  if (process.platform === "darwin" && spec.scriptPath) {
    mkdirSync(dirname(spec.scriptPath), { recursive: true });
    const escapeSingleQuotes = (s: string) => s.replace(/'/g, "'\\''");
    const content = `#!/bin/sh\ncd '${escapeSingleQuotes(entry.projectRoot)}' && exec '${escapeSingleQuotes(process.execPath)}' '${escapeSingleQuotes(bin)}' later run ${entry.id}\n`;
    writeFileSync(spec.scriptPath, content, { encoding: "utf8", mode: 0o755 });
    try {
      chmodSync(spec.scriptPath, 0o755);
    } catch {
      // Ignore chmod errors
    }
  }

  const spawner = options?.spawnProcess ?? spawn;
  const child = spawner(spec.command, spec.args, spec.options);
  child.unref?.();
}

export interface WaitLaterOptions {
  projectRoot: string;
  pollMs?: number;
  now?: () => number;
  readQuota?: () => Promise<QuotaReport>;
  runMode?: (entry: LaterEntry) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  binPath?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export async function waitLaterEntry(
  id: string,
  options: WaitLaterOptions,
): Promise<void> {
  const pollMs =
    options.pollMs ??
    (process.env.SHARELANE_LATER_POLL_MS ? Number(process.env.SHARELANE_LATER_POLL_MS) : 30_000);
  const now = options.now ?? Date.now;
  const sleepFn =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        options.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      }));

  while (!options.signal?.aborted) {
    const entry = loadLaterEntry(options.projectRoot, id);
    if (!entry || entry.status !== "scheduled") {
      return;
    }

    const currentNow = now();
    if (currentNow >= Date.parse(entry.fireAt)) {
      if (entry.when === "reset") {
        const reader = options.readQuota ?? readClaudeQuota;
        let quota: QuotaReport | undefined;
        try {
          quota = await reader();
        } catch {
          quota = undefined;
        }

        if (quota && quota.state !== "unknown") {
          const validWindows = (quota.windows ?? []).filter(
            (w) => w.resetsAt && Date.parse(w.resetsAt) > currentNow,
          );
          if (validWindows.length > 0) {
            const lowest = validWindows.reduce((min, cur) =>
              cur.remainingPercent < min.remainingPercent ? cur : min,
            );
            if (lowest.remainingPercent <= DEFAULT_HANDOFF_THRESHOLD) {
              const moves = entry.resetMoves ?? 0;
              if (moves < 3) {
                entry.resetMoves = moves + 1;
                entry.fireAt = new Date(Date.parse(lowest.resetsAt!) + 2 * 60_000).toISOString();
                saveLaterEntry(entry);
                await sleepFn(pollMs);
                continue;
              }
            }
          }
        }
      }

      entry.status = "running";
      entry.firedAt = new Date(currentNow).toISOString();
      saveLaterEntry(entry);

      if (options.runMode) {
        await options.runMode(entry);
      } else {
        await fireLaterEntry(entry, options);
      }
      return;
    }

    await sleepFn(pollMs);
  }
}

export interface ScheduleLaterOptions {
  projectRoot: string;
  prompt?: string;
  in?: string;
  at?: string;
  whenReset?: boolean;
  background?: boolean;
  session?: string;
  binPath?: string;
  homeDir?: string;
  now?: number | Date;
  quotaReport?: QuotaReport;
  spawnProcess?: typeof spawn;
}

export interface ScheduleLaterResult {
  entry: LaterEntry;
  confirmationLines: string[];
}

export function scheduleLater(options: ScheduleLaterOptions): ScheduleLaterResult {
  let prompt = options.prompt?.trim();
  if (!prompt) {
    if (options.whenReset) {
      prompt = "Continue where you left off.";
    } else {
      throw new Error('A prompt is required. Example: sharelane later "continue" --in 2h');
    }
  }

  const whenResult = parseWhen({
    in: options.in,
    at: options.at,
    whenReset: options.whenReset,
    now: options.now,
    quotaReport: options.quotaReport,
  });

  let session: string | undefined;
  if (options.session) {
    if (!isValidSessionId(options.session)) {
      throw new Error(
        `Invalid session ID "${options.session}". Must be hex characters and hyphens (at least 8 chars).`,
      );
    }
    session = options.session;
  } else {
    session = latestClaudeSession(options.projectRoot, options.homeDir);
  }

  const id = randomBytes(4).toString("hex");
  const mode: "window" | "background" = options.background ? "background" : "window";
  const nowMs =
    options.now instanceof Date
      ? options.now.getTime()
      : typeof options.now === "number"
        ? options.now
        : Date.now();

  const entry: LaterEntry = {
    id,
    prompt,
    projectRoot: options.projectRoot,
    createdAt: new Date(nowMs).toISOString(),
    fireAt: whenResult.fireAt,
    when: whenResult.when,
    mode,
    session,
    status: "scheduled",
  };

  const bin = options.binPath ?? shareLaneLauncher(options.projectRoot).binPath;
  const spawner = options.spawnProcess ?? spawn;

  // Save before starting the waiter: it exits at once if it can't find its entry.
  saveLaterEntry(entry);
  const child = spawner(process.execPath, [bin, "later", "wait", id], {
    cwd: options.projectRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    shell: false,
  });
  child.unref?.();
  // The waiter only reads the entry, so recording its pid now cannot race it.
  const saved = loadLaterEntry(options.projectRoot, id) ?? entry;
  if (saved.status === "scheduled") {
    saved.pid = child.pid;
    saveLaterEntry(saved);
  }
  entry.pid = child.pid;

  const fireDate = new Date(entry.fireAt);
  const hh = String(fireDate.getHours()).padStart(2, "0");
  const mm = String(fireDate.getMinutes()).padStart(2, "0");
  const timeDesc = `${hh}:${mm} (${formatRelativeTime(entry.fireAt, nowMs)})`;
  const sessionDesc = entry.session ? `session ${entry.session.slice(0, 8)}…` : "newest session";
  const modeDesc = entry.mode === "window" ? "in a new terminal window" : "in the background";

  const lines: string[] = [];
  if (whenResult.when === "reset" && whenResult.resetsAt) {
    lines.push(`Found Claude limit reset at ${whenResult.resetsAt}.`);
  }
  lines.push(
    `Scheduled ${entry.id}: continue your Claude chat (${sessionDesc}) at ${timeDesc}, ${modeDesc}.`,
  );
  lines.push("Keep this computer on (sleep is fine; a restart cancels it). See it with: sharelane later list");

  return { entry, confirmationLines: lines };
}

