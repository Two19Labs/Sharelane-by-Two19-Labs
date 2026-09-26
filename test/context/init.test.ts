import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const tsxPath = fileURLToPath(
  new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url),
);

function runInit(projectRoot: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxPath, cliPath, "init"], {
      cwd: projectRoot,
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
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
