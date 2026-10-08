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
    "  sharelane init [--yes]",
    "  sharelane mcp",
    "  sharelane dashboard [--port <n>] [--open]",
    "  sharelane run <agent> <prompt>",
    "",
    "Commands:",
    "  init       Set up shared context, approved checks, and every agent CLI found on PATH.",
    "             --yes also changes global agent settings (Codex, Antigravity).",
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
    console.log("Read-only and only reachable from this computer. Press Ctrl+C to stop.");
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

  const yes = extra.length === 1 && (extra[0] === "--yes" || extra[0] === "-y");
  if (command !== "init" || (extra.length > 0 && !yes)) {
    console.log(usage());
    process.exitCode = command && command !== "help" && command !== "--help" ? 1 : 0;
    return;
  }

  const report = setupProject({ projectRoot: process.cwd(), yes });
  console.log(report.lines.join("\n"));
}

try {
  await run();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ShareLane failed: ${message}`);
  process.exitCode = 1;
}
