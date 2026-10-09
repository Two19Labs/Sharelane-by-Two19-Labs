import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
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
    Object.entries(process.env).filter(([key]) => !["PATH", "CODEX_HOME"].includes(key.toUpperCase())),
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
    const homeDir = join(scratch, "home");
    const report = setupProject({ projectRoot, env, runCommand, homeDir, global: false });
    const output = report.lines.join("\n");
    assert.deepEqual(report.detected, ["claude", "antigravity"]);
    assert.match(output, /codex: `codex` is not on PATH; skipped\./);
    assert.match(output, /mcp\(sharelane\/\*\)/);
    assert.match(output, /not a Git repository/);
    assert.equal(calls.length, 0);
    assert.equal(existsSync(homeDir), false, "with --no-global, global settings are untouched");

    // Claude's project server is pre-approved in the personal, uncommitted settings.
    const local = await readJson(join(projectRoot, ".claude", "settings.local.json"));
    assert.deepEqual(local.enabledMcpjsonServers, ["sharelane"]);
    assert.match(await readFile(join(projectRoot, ".gitignore"), "utf8"), /\.claude\/settings\.local\.json/);

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
    setupProject({ projectRoot, env, runCommand, homeDir, global: false });
    assert.equal(await readFile(join(projectRoot, ".mcp.json"), "utf8"), before);
    assert.deepEqual((await readJson(join(projectRoot, ".claude", "settings.local.json"))).enabledMcpjsonServers, [
      "sharelane",
    ]);
  });
});

test("init adds Antigravity's global allow rule once, keeping other settings", async () => {
  await withProject(async (projectRoot, scratch) => {
    const env = await fakePath(scratch, ["agy"]);
    const homeDir = join(scratch, "home");
    const settingsPath = join(homeDir, ".gemini", "antigravity-cli", "settings.json");
    await mkdir(join(homeDir, ".gemini", "antigravity-cli"), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ colorScheme: "dark", permissions: { allow: ["command(git)"] } }));

    const output = setupProject({ projectRoot, env, homeDir }).lines.join("\n");
    assert.match(output, /allowed ShareLane tools globally/);
    const settings = await readJson(settingsPath);
    assert.equal(settings.colorScheme, "dark");
    assert.deepEqual(settings.permissions.allow, ["command(git)", "mcp(sharelane/*)"]);

    const again = setupProject({ projectRoot, env, homeDir, global: false }).lines.join("\n");
    assert.match(again, /already allowed globally/);
    assert.doesNotMatch(again, /add "mcp\(sharelane/);
    assert.deepEqual((await readJson(settingsPath)).permissions.allow, ["command(git)", "mcp(sharelane/*)"]);
  });
});

test("init connects Codex once, re-adds its approval line, and only prints with --no-global", async () => {
  await withProject(async (projectRoot, scratch) => {
    const env = await fakePath(scratch, ["codex"]);
    const homeDir = join(scratch, "home");
    const configPath = join(homeDir, ".codex", "config.toml");
    const bin = resolve("bin", "sharelane.mjs");
    const written = `model = "x"\r\n\r\n[mcp_servers.sharelane]\r\ncommand = "node"\r\nargs = ['${bin}', "mcp"]\r\n\r\n[mcp_servers.sharelane.env]\r\nSHARELANE_AGENT = "codex"\r\n`;
    const calls: string[][] = [];
    // Like the real `codex mcp add`, rewrite the entry without the approval line.
    const runCommand: CommandRunner = (command, args) => {
      calls.push([command, ...args]);
      writeFileSync(configPath, written);
      return { status: 0, output: "" };
    };

    const printed = setupProject({ projectRoot, env, runCommand, homeDir, global: false }).lines.join("\n");
    assert.equal(calls.length, 0);
    assert.match(printed, /codex mcp add sharelane --env SHARELANE_AGENT=codex -- .*sharelane\.mjs.* mcp/);
    assert.match(printed, /default_tools_approval_mode = "approve"/);
    // Claude and Antigravity were not detected, so their configs were not written.
    assert.equal(existsSync(join(projectRoot, ".mcp.json")), false);
    assert.equal(existsSync(join(projectRoot, ".agents")), false);

    await mkdir(join(homeDir, ".codex"), { recursive: true });
    const applied = setupProject({ projectRoot, env, runCommand, homeDir }).lines.join("\n");
    assert.deepEqual(calls, [
      ["codex", "mcp", "add", "sharelane", "--env", "SHARELANE_AGENT=codex", "--", process.execPath, bin, "mcp"],
    ]);
    assert.match(applied, /Codex: connected the global ShareLane MCP server/);
    assert.match(applied, /without a prompt/);
    const approved = written.replace(
      "[mcp_servers.sharelane]\r\n",
      '[mcp_servers.sharelane]\r\ndefault_tools_approval_mode = "approve"\r\n',
    );
    assert.equal(await readFile(configPath, "utf8"), approved);

    // Already connected: nothing is run or rewritten, and nothing is left to do.
    for (const global of [true, false]) {
      const again = setupProject({ projectRoot, env, runCommand, homeDir, global }).lines.join("\n");
      assert.match(again, /Codex: global ShareLane MCP server already connected/);
      assert.doesNotMatch(again, /codex mcp add|default_tools_approval_mode/);
    }
    assert.equal(calls.length, 1);
    assert.equal(await readFile(configPath, "utf8"), approved);
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
