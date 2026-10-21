import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setupProject, type CommandRunner } from "../../src/core/setup.js";
import { uninstallProject } from "../../src/core/uninstall.js";

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

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

test("uninstall removes only what init added, and --global undoes the shared settings", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "sharelane-uninstall-"));
  try {
    const projectRoot = join(scratch, "project");
    const homeDir = join(scratch, "home");
    await mkdir(join(projectRoot, ".claude"), { recursive: true });
    const env = await fakePath(scratch, ["claude", "agy", "codex"]);

    // The user's own settings, which must survive.
    await writeFile(join(projectRoot, ".mcp.json"), JSON.stringify({ mcpServers: { mine: { command: "x" } } }));
    await writeFile(join(projectRoot, ".claude", "settings.json"), JSON.stringify({ model: "opus" }));
    await writeFile(join(projectRoot, "AGENTS.md"), "# My rules\n\nBe nice.\n");
    await writeFile(join(projectRoot, ".gitignore"), "dist/\n");

    const calls: string[][] = [];
    const runCommand: CommandRunner = (command, args) => {
      calls.push([command, ...args]);
      return { status: 0, output: "" };
    };
    await mkdir(join(homeDir, ".codex"), { recursive: true });
    await writeFile(join(homeDir, ".codex", "config.toml"), '[mcp_servers.sharelane]\ncommand = "node"\n');
    setupProject({ projectRoot, env, homeDir, runCommand });
    assert(existsSync(join(projectRoot, ".sharelane")));

    const output = uninstallProject({ projectRoot, env, homeDir, runCommand, global: true }).join("\n");
    assert.match(output, /ShareLane was removed from this project/);

    assert.deepEqual(readJson(join(projectRoot, ".mcp.json")), { mcpServers: { mine: { command: "x" } } });
    assert.deepEqual(readJson(join(projectRoot, ".claude", "settings.json")), { model: "opus" });
    assert.equal(readFileSync(join(projectRoot, "AGENTS.md"), "utf8"), "# My rules\n\nBe nice.\n");
    assert.equal(existsSync(join(projectRoot, "CLAUDE.md")), false, "CLAUDE.md held only ShareLane's block");
    assert.equal(readFileSync(join(projectRoot, ".gitignore"), "utf8"), "dist/\n");
    for (const gone of [".sharelane", ".agents", ".claude/hooks", ".claude/settings.local.json"]) {
      assert.equal(existsSync(join(projectRoot, gone)), false, `${gone} should be removed`);
    }

    // --global: Codex's entry is removed through its CLI, Antigravity's rule from its settings.
    assert.deepEqual(calls.at(-1), ["codex", "mcp", "remove", "sharelane"]);
    const antigravity = readJson(join(homeDir, ".gemini", "antigravity-cli", "settings.json"));
    assert.deepEqual(antigravity.permissions.allow, []);

    assert.match(uninstallProject({ projectRoot, env, homeDir, runCommand }).join("\n"), /was not set up/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
