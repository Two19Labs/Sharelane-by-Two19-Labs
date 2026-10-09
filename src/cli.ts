#!/usr/bin/env node

import { relativeContextPath } from "./core/context.js";
import { runAgent } from "./core/runner.js";
import { setupProject } from "./core/setup.js";
import { spawn } from "node:child_process";
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
    "",
    "Commands:",
    "  init       Set up this project for every agent CLI found on PATH. Run it in the project folder.",
    "             Also connects Codex and Antigravity in your global agent settings;",
    "             --no-global leaves those alone and prints the steps instead.",
    "  mcp        Start the ShareLane MCP server on stdio (agent CLIs launch this).",
    `  dashboard  Serve the live office dashboard on this computer (default port ${DEFAULT_DASHBOARD_PORT}).`,
    "  run        Ask one configured agent to do a task and wait for its answer.",
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
