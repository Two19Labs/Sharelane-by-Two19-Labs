#!/usr/bin/env node

import { relativeContextPath } from "./core/context.js";
import {
  cancelLaterEntry,
  formatLaterList,
  listLaterEntries,
  runLaterEntry,
  scheduleLater,
  waitLaterEntry,
} from "./core/later.js";
import { readClaudeQuota } from "./core/quota.js";
import { runAgent } from "./core/runner.js";
import { packageRoot, setupProject } from "./core/setup.js";
import { uninstallProject } from "./core/uninstall.js";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DASHBOARD_PORT, startDashboard } from "./dashboard/server.js";

function usage(): string {
  return [
    "ShareLane",
    "",
    "Usage:",
    "  sharelane init [--no-global]",
    "  sharelane mcp",
    "  sharelane dashboard [--port <n>] [--open]",
    "  sharelane run <agent> <prompt>",
    '  sharelane later ["prompt"] (--in 2h | --at 16:30 | --when-reset) [--background] [--session <id>]',
    "  sharelane later list | cancel <id>",
    "  sharelane uninstall [--global]",
    "  sharelane --version",
    "",
    "Commands:",
    "  init       Set up this project for every agent CLI found on PATH. Run it in the project folder.",
    "             Also connects Codex and Antigravity in your global agent settings;",
    "             --no-global leaves those alone and prints the steps instead.",
    "  mcp        Start the ShareLane MCP server on stdio (agent CLIs launch this).",
    `  dashboard  Serve the live office dashboard on this computer (default port ${DEFAULT_DASHBOARD_PORT}).`,
    "  run        Ask one configured agent to do a task and wait for its answer.",
    "  later      Continue this project's latest Claude chat at a set time, e.g. after your limit",
    "             resets. Opens a terminal window; --background runs it without one.",
    "  uninstall  Remove ShareLane from this project. --global also removes the Codex and",
    "             Antigravity settings that all your projects share.",
  ].join("\n");
}

/** Open a URL in the default browser without involving a shell. */
function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === "win32"
      ? ["explorer.exe", [url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  const child = spawn(command, args, { detached: true, stdio: "ignore", shell: false });
  child.on("error", () => console.log(`Open ${url} in your browser.`));
  child.unref();
}

/** `sharelane later …`: schedule, list or cancel a timed continuation. */
async function runLater(extra: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const [sub, id] = extra;
  // Internal: the hidden waiting process, and the command a new terminal window runs.
  if (sub === "wait" && id && extra.length === 2) return waitLaterEntry(id, { projectRoot });
  if (sub === "run" && id && extra.length === 2) return runLaterEntry(projectRoot, id);
  if (sub === "list" && extra.length === 1) {
    console.log(formatLaterList(listLaterEntries(projectRoot)).join("\n"));
    return;
  }
  if (sub === "cancel" && extra.length === 2) {
    const { cancelled } = cancelLaterEntry(projectRoot, id!);
    console.log(`Cancelled ${cancelled.id}.`);
    return;
  }

  const valueFlags = ["--in", "--at", "--session"];
  const options: { in?: string; at?: string; session?: string } = {};
  const promptParts: string[] = [];
  let whenReset = false;
  let background = false;
  for (let index = 0; index < extra.length; index += 1) {
    const part = extra[index]!;
    if (valueFlags.includes(part)) {
      const value = extra[index + 1];
      if (value === undefined) throw new Error(`${part} needs a value.`);
      options[part.slice(2) as "in" | "at" | "session"] = value;
      index += 1;
    } else if (part === "--when-reset") whenReset = true;
    else if (part === "--background") background = true;
    else if (part.startsWith("--")) throw new Error(`Unknown option ${part}.\n\n${usage()}`);
    else promptParts.push(part);
  }
  const { confirmationLines } = scheduleLater({
    projectRoot,
    prompt: promptParts.join(" "),
    ...options,
    whenReset,
    background,
    quotaReport: whenReset ? await readClaudeQuota() : undefined,
  });
  console.log(confirmationLines.join("\n"));
}

async function run(): Promise<void> {
  const [command, ...extra] = process.argv.slice(2);
  if (command === "mcp" && extra.length === 0) {
    // The server module connects to stdio when loaded; stdout belongs to MCP.
    await import("./mcp/server.js");
    return;
  }

  if (command === "dashboard") {
    const portIndex = extra.indexOf("--port");
    const port = portIndex >= 0 ? Number(extra[portIndex + 1]) : DEFAULT_DASHBOARD_PORT;
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new Error("--port needs a number between 0 and 65535.");
    }
    const dashboard = await startDashboard({ projectRoot: process.cwd(), port });
    console.log(`ShareLane dashboard: ${dashboard.url}`);
    console.log("Only reachable from this computer. Press Ctrl+C to stop.");
    if (extra.includes("--open")) openInBrowser(dashboard.url);
    await new Promise<void>((resolve) => {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    });
    await dashboard.close();
    return;
  }

  if (command === "run") {
    const [agent, ...promptParts] = extra;
    const prompt = promptParts.join(" ").trim();
    if (!agent || !prompt) {
      throw new Error("run needs an agent name and a prompt.");
    }
    const result = await runAgent({ agent, prompt });
    console.log(result.finalMessage);
    console.log(`Session: ${result.sessionId}`);
    console.log(`Log: ${relativeContextPath(result.logPath, process.cwd())}`);
    return;
  }

  if (command === "--version" || command === "-v" || command === "version") {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string };
    console.log(manifest.version);
    return;
  }

  if (command === "later") {
    await runLater(extra);
    return;
  }

  if (command === "uninstall") {
    if (extra.some((flag) => flag !== "--global")) {
      console.log(usage());
      process.exitCode = 1;
      return;
    }
    console.log(uninstallProject({ projectRoot: process.cwd(), global: extra.includes("--global") }).join("\n"));
    return;
  }

  // --yes was required before global setup became the default; still accepted.
  const initFlags = ["--no-global", "--yes", "-y"];
  if (command !== "init" || extra.some((flag) => !initFlags.includes(flag))) {
    console.log(usage());
    process.exitCode = command && command !== "help" && command !== "--help" ? 1 : 0;
    return;
  }

  const report = setupProject({ projectRoot: process.cwd(), global: !extra.includes("--no-global") });
  console.log(report.lines.join("\n"));
}

try {
  await run();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  console.error(`ShareLane failed: ${message}`);
  if (code === "EPERM" || code === "EACCES") {
    console.error(`ShareLane cannot write in ${process.cwd()}. cd into your project folder and run it again.`);
  }
  process.exitCode = 1;
}
