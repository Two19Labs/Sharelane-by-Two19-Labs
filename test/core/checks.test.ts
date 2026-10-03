import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  describeCheckResult,
  installDefaultChecks,
  loadChecks,
  runCheck,
} from "../../src/core/checks.js";

async function withProject(
  checks: unknown,
  body: (projectRoot: string) => Promise<void>,
): Promise<void> {
  const projectRoot = await mkdtemp(join(tmpdir(), "sharelane-checks-"));
  try {
    if (checks !== undefined) {
      await mkdir(join(projectRoot, ".sharelane"), { recursive: true });
      await writeFile(join(projectRoot, ".sharelane", "checks.json"), JSON.stringify(checks), "utf8");
    }
    await body(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

test("run_check runs an approved command in the caller's workspace and reports the result", async () => {
  await withProject(
    {
      version: 1,
      checks: {
        marker: {
          command: "node",
          args: ["-e", "console.log(require('fs').readFileSync('marker.txt','utf8')); process.exit(3)"],
        },
        npm: { command: "npm", args: ["--version"], timeoutSeconds: 60 },
      },
    },
    async (projectRoot) => {
      // An uncommitted file in the workspace is visible to the check.
      await writeFile(join(projectRoot, "marker.txt"), "uncommitted edit", "utf8");
      const result = await runCheck({ name: "marker", workspaceRoot: projectRoot });
      assert.equal(result.exitCode, 3);
      assert.equal(result.timedOut, false);
      assert.match(result.output, /uncommitted edit/);
      assert.match(describeCheckResult(result), /FAILED with exit code 3/);

      // npm is a .cmd launcher on Windows; it must still start without a shell.
      const npm = await runCheck({ name: "npm", workspaceRoot: projectRoot });
      assert.equal(npm.exitCode, 0, npm.output);
      assert.match(npm.output, /^\d+\.\d+\.\d+/);
      assert.match(describeCheckResult(npm), /PASSED with exit code 0/);
    },
  );
});

test("run_check refuses names that are not approved and lists the approved ones", async () => {
  await withProject(
    { version: 1, checks: { test: { command: "npm", args: ["test"] } } },
    async (projectRoot) => {
      await assert.rejects(
        runCheck({ name: "rm-everything", workspaceRoot: projectRoot }),
        /"rm-everything" is not an approved check[\s\S]*- test: npm test/,
      );
      assert.equal(loadChecks(projectRoot).test?.timeoutSeconds, 600);
    },
  );
  await withProject(undefined, async (projectRoot) => {
    assert.deepEqual(loadChecks(projectRoot), {});
    await assert.rejects(runCheck({ name: "test", workspaceRoot: projectRoot }), /No approved checks/);
  });
});

test("checks.json is validated", async () => {
  await withProject(
    { version: 1, checks: { test: { command: "npm", args: "test" } } },
    async (projectRoot) => {
      assert.throws(() => loadChecks(projectRoot), /checks\.json is invalid at checks\.test\.args/);
    },
  );
  await withProject({ version: 1, checks: { test: { command: "npm", shell: true } } }, async (projectRoot) => {
    assert.throws(() => loadChecks(projectRoot), /checks\.json is invalid/);
  });
});

test("run_check stops the whole process tree on timeout", async () => {
  // The child starts a grandchild that holds the output pipes open.
  const script =
    "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});" +
    "console.log('started');setInterval(()=>{},1000)";
  await withProject(
    { version: 1, checks: { hang: { command: "node", args: ["-e", script], timeoutSeconds: 1 } } },
    async (projectRoot) => {
      const result = await runCheck({ name: "hang", workspaceRoot: projectRoot });
      assert.equal(result.timedOut, true);
      assert.equal(result.exitCode, null);
      assert(result.durationMs < 15_000, `took ${result.durationMs}ms`);
      assert.match(describeCheckResult(result), /TIMED OUT/);
    },
  );
});

test("run_check keeps only the last 8 KB of output", async () => {
  await withProject(
    {
      version: 1,
      checks: {
        noisy: { command: "node", args: ["-e", "process.stdout.write('x'.repeat(50000) + 'THE END')"] },
      },
    },
    async (projectRoot) => {
      const result = await runCheck({ name: "noisy", workspaceRoot: projectRoot });
      assert.equal(result.exitCode, 0);
      assert.equal(result.truncated, true);
      assert(Buffer.byteLength(result.output) <= 8 * 1024);
      assert(result.output.endsWith("THE END"));
      assert.match(describeCheckResult(result), /Output \(last 8 KB\)/);
    },
  );
});

test("init creates approved checks from package.json scripts and never overwrites them", async () => {
  await withProject(undefined, async (projectRoot) => {
    await writeFile(
      join(projectRoot, "package.json"),
      JSON.stringify({ scripts: { test: "node --test", lint: "eslint .", build: "tsc", typecheck: "tsc --noEmit" } }),
      "utf8",
    );
    assert.deepEqual(installDefaultChecks(projectRoot), ["test", "typecheck", "lint"]);
    const path = join(projectRoot, ".sharelane", "checks.json");
    const created = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(created, {
      version: 1,
      checks: {
        test: { command: "npm", args: ["test"], timeoutSeconds: 600 },
        typecheck: { command: "npm", args: ["run", "typecheck"], timeoutSeconds: 600 },
        lint: { command: "npm", args: ["run", "lint"], timeoutSeconds: 600 },
      },
    });

    const custom = JSON.stringify({ version: 1, checks: { unit: { command: "make", args: ["test"] } } });
    await writeFile(path, custom, "utf8");
    assert.equal(installDefaultChecks(projectRoot), undefined);
    assert.equal(await readFile(path, "utf8"), custom);
  });

  await withProject(undefined, async (projectRoot) => {
    // npm init's placeholder test script is not a real check.
    await writeFile(
      join(projectRoot, "package.json"),
      JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
      "utf8",
    );
    assert.deepEqual(installDefaultChecks(projectRoot), []);
    assert.deepEqual(loadChecks(projectRoot), {});
  });
});
