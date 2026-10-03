import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { findOnPath } from "../../src/core/runner.js";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const tsxPath = fileURLToPath(
  new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url),
);

/**
 * Run init with a PATH holding only a stand-in `claude` (plus Git), so agent
 * detection does not depend on what this machine has installed.
 */
async function agentPath(projectRoot: string): Promise<NodeJS.ProcessEnv> {
  const bin = join(projectRoot, "..", `${basename(projectRoot)}-bin`);
  await mkdir(bin, { recursive: true });
  if (process.platform === "win32") {
    await writeFile(join(bin, "claude.cmd"), "@echo off\r\n", "utf8");
  } else {
    await writeFile(join(bin, "claude"), "#!/bin/sh\n", "utf8");
    await chmod(join(bin, "claude"), 0o755);
  }
  const git = findOnPath("git");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"),
  );
  return { ...env, PATH: [bin, ...(git ? [dirname(git)] : [])].join(delimiter) };
}

async function runInit(projectRoot: string): Promise<string> {
  const env = await agentPath(projectRoot);
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxPath, cliPath, "init"], {
      cwd: projectRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      errors += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`sharelane init exited with ${code}: ${errors}`));
      }
    });
  });
}

test("sharelane init creates the context layout without overwriting it", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sharelane-init-"));

  try {
    await writeFile(
      join(projectRoot, "package.json"),
      JSON.stringify({ name: "demo", description: "A demo project." }),
      "utf8",
    );
    await writeFile(join(projectRoot, "AGENTS.md"), "# Existing rules\n\nKeep me.\n", "utf8");

    const firstOutput = await runInit(projectRoot);
    assert.match(firstOutput, /Created chunks: architecture/);
    const map = await readFile(
      join(projectRoot, ".sharelane", "context", "MAP.md"),
      "utf8",
    );
    assert.match(map, /\*\*demo\*\* — A demo project\./);
    assert.match(map, /architecture\.md/);
    assert.match(
      await readFile(
        join(projectRoot, ".sharelane", "context", "architecture.md"),
        "utf8",
      ),
      /read-when:/,
    );

    const agents = await readFile(join(projectRoot, "AGENTS.md"), "utf8");
    const claude = await readFile(join(projectRoot, "CLAUDE.md"), "utf8");
    assert.match(agents, /Keep me\./);
    assert.match(agents, /\.sharelane\/context\/MAP\.md/);
    assert.match(claude, /\.sharelane\/context\/MAP\.md/);
    assert.match(agents, /Keep token overhead low/);
    assert.match(claude, /Keep token overhead low/);
    assert.match(
      await readFile(join(projectRoot, ".gitignore"), "utf8"),
      /\.sharelane\/sharelane\.db/,
    );
    assert.match(agents, /claim the exact files/i);
    assert.match(
      await readFile(join(projectRoot, ".claude", "settings.json"), "utf8"),
      /sharelane-claim-guard\.mjs/,
    );
    assert.match(
      await readFile(
        join(projectRoot, ".claude", "hooks", "sharelane-claim-guard.mjs"),
        "utf8",
      ),
      /blocked an unclaimed edit/,
    );

    const mcp = JSON.parse(await readFile(join(projectRoot, ".mcp.json"), "utf8"));
    assert.equal(mcp.mcpServers.sharelane.command, "node");
    assert.match(mcp.mcpServers.sharelane.args[0], /bin[\\/]sharelane\.mjs$/);
    assert.equal(mcp.mcpServers.sharelane.args[1], "mcp");
    assert.match(firstOutput, /codex: `codex` is not on PATH; skipped\./);
    assert.match(firstOutput, /antigravity: `agy` is not on PATH; skipped\./);
    assert.match(firstOutput, /Created an empty \.sharelane\/checks\.json/);

    const architecturePath = join(
      projectRoot,
      ".sharelane",
      "context",
      "architecture.md",
    );
    const originalArchitecture = await readFile(architecturePath, "utf8");
    const secondOutput = await runInit(projectRoot);
    assert.match(secondOutput, /none were overwritten/i);
    assert.equal(await readFile(architecturePath, "utf8"), originalArchitecture);
    assert.equal(
      (await readFile(join(projectRoot, "AGENTS.md"), "utf8")).match(
        /<!-- sharelane-context:start -->/g,
      )?.length,
      1,
    );
    assert.equal(
      (await readFile(join(projectRoot, ".gitignore"), "utf8")).match(
        /^\.sharelane\/sharelane\.db$/gm,
      )?.length,
      1,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(`${projectRoot}-bin`, { recursive: true, force: true });
  }
});
