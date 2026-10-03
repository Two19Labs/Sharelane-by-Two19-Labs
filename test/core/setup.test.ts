import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { findOnPath } from "../../src/core/runner.js";
import { setupProject, shareLaneLauncher, type CommandRunner } from "../../src/core/setup.js";

/** A PATH folder holding stand-ins for the named agent CLIs. */
async function fakePath(root: string, commands: string[]): Promise<NodeJS.ProcessEnv> {
  const bin = join(root, "fake-bin");
  await mkdir(bin, { recursive: true });
  for (const command of commands) {
    if (process.platform === "win32") {
      await writeFile(join(bin, `${command}.cmd`), "@echo off\r\n", "utf8");
    } else {
      await writeFile(join(bin, command), "#!/bin/sh\n", "utf8");
      await chmod(join(bin, command), 0o755);
    }
  }
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"),
  );
  return { ...env, PATH: bin };
}

async function withProject(body: (projectRoot: string, scratch: string) => Promise<void>): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "sharelane-setup-"));
  const projectRoot = join(scratch, "project");
  await mkdir(projectRoot);
  try {
    await body(projectRoot, scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));

test("findOnPath detects agent CLIs only in the given PATH", async () => {
  await withProject(async (_projectRoot, scratch) => {
    const env = await fakePath(scratch, ["claude"]);
    assert(findOnPath("claude", env));
    assert.equal(findOnPath("codex", env), undefined);
  });
});

test("init wires detected Claude and Antigravity to the installed package and skips missing agents", async () => {
  await withProject(async (projectRoot, scratch) => {
    const env = await fakePath(scratch, ["claude", "agy"]);
    await writeFile(
      join(projectRoot, ".mcp.json"),
      JSON.stringify({ mcpServers: { mine: { command: "my-server" } }, other: true }),
      "utf8",
    );
    const calls: string[][] = [];
    const runCommand: CommandRunner = (command, args) => {
      calls.push([command, ...args]);
      return { status: 0, output: "" };
    };
    const report = setupProject({ projectRoot, env, runCommand });
    const output = report.lines.join("\n");
    assert.deepEqual(report.detected, ["claude", "antigravity"]);
    assert.match(output, /codex: `codex` is not on PATH; skipped\./);
    assert.match(output, /mcp\(sharelane\/\*\)/);
    assert.equal(calls.length, 0);

    const claude = await readJson(join(projectRoot, ".mcp.json"));
    assert.equal(claude.other, true);
    assert.equal(claude.mcpServers.mine.command, "my-server");
    const server = claude.mcpServers.sharelane;
    assert.equal(server.type, "stdio");
    assert.equal(server.command, "node");
    assert.equal(server.env.SHARELANE_AGENT, "claude");
    assert.equal(server.args.at(-1), "mcp");
    // Not installed in this temp project, so it points at this package's bin.
    assert.equal(resolve(projectRoot, server.args[0]), resolve("bin", "sharelane.mjs"));
    assert.match(output, /absolute path/);

    const antigravity = await readJson(join(projectRoot, ".agents", "mcp_config.json"));
    assert.deepEqual(antigravity.mcpServers.sharelane.args, server.args);
    assert.equal(antigravity.mcpServers.sharelane.env.SHARELANE_AGENT, "antigravity");
    assert(existsSync(join(projectRoot, ".agents", "hooks.json")));
    assert(existsSync(join(projectRoot, ".claude", "hooks", "sharelane-claim-guard.mjs")));
    assert.match(await readFile(join(projectRoot, ".claude", "settings.json"), "utf8"), /sharelane-claim-guard/);

    // Running init again changes nothing.
    const before = await readFile(join(projectRoot, ".mcp.json"), "utf8");
    setupProject({ projectRoot, env, runCommand });
    assert.equal(await readFile(join(projectRoot, ".mcp.json"), "utf8"), before);
  });
});

test("init only prints the global Codex command unless --yes is given", async () => {
  await withProject(async (projectRoot, scratch) => {
    const env = await fakePath(scratch, ["codex"]);
    const calls: string[][] = [];
    const runCommand: CommandRunner = (command, args) => {
      calls.push([command, ...args]);
      return { status: 0, output: "" };
    };

    const printed = setupProject({ projectRoot, env, runCommand }).lines.join("\n");
    assert.equal(calls.length, 0);
    assert.match(printed, /codex mcp add sharelane --env SHARELANE_AGENT=codex -- .*sharelane\.mjs.* mcp/);
    assert.match(printed, /default_tools_approval_mode = "approve"/);
    // Claude and Antigravity were not detected, so their configs were not written.
    assert.equal(existsSync(join(projectRoot, ".mcp.json")), false);
    assert.equal(existsSync(join(projectRoot, ".agents")), false);

    const applied = setupProject({ projectRoot, env, runCommand, yes: true }).lines.join("\n");
    assert.deepEqual(calls, [
      [
        "codex",
        "mcp",
        "add",
        "sharelane",
        "--env",
        "SHARELANE_AGENT=codex",
        "--",
        process.execPath,
        resolve("bin", "sharelane.mjs"),
        "mcp",
      ],
    ]);
    assert.match(applied, /Codex: added the global ShareLane MCP server/);
  });
});

test("a project install gives committed configs a portable, project-relative launcher", async () => {
  await withProject(async (projectRoot) => {
    const bin = join(projectRoot, "node_modules", "sharelane", "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "sharelane.mjs"), "", "utf8");
    const launcher = shareLaneLauncher(projectRoot);
    assert.deepEqual(launcher.args, ["node_modules/sharelane/bin/sharelane.mjs", "mcp"]);
    assert.equal(launcher.command, "node");
    assert.equal(launcher.portable, true);
  });
  // In ShareLane's own repo the launcher is the repo's bin.
  assert.deepEqual(shareLaneLauncher(resolve(".")).args, ["bin/sharelane.mjs", "mcp"]);
});
