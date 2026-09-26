import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { hasFts5, openDatabase } from "../../src/core/database.js";

const tsxPath = fileURLToPath(
  new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url),
);
const writerPath = fileURLToPath(
  new URL("../fixtures/concurrent-writer.ts", import.meta.url),
);

async function waitForFiles(paths: string[]): Promise<void> {
  const deadline = Date.now() + 5_000;

  while (!paths.every((path) => existsSync(path))) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for concurrent writers to become ready");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function startWriter(projectRoot: string, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [tsxPath, writerPath, projectRoot, name],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let errors = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      errors += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Writer ${name} exited with ${code}: ${errors}`));
      }
    });
  });
}

test("built-in SQLite has FTS5 and creates the Phase 1 schema", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sharelane-db-"));

  try {
    const database = openDatabase(projectRoot);
    assert.equal(hasFts5(database), true);
    assert.equal(
      (database.prepare("PRAGMA journal_mode").get() as { journal_mode: string })
        .journal_mode,
      "wal",
    );

    database
      .prepare(
        "INSERT INTO search_index (kind, reference, title, body) VALUES (?, ?, ?, ?)",
      )
      .run("chunk", "architecture", "Architecture", "shared context works");
    const result = database
      .prepare("SELECT reference FROM search_index WHERE search_index MATCH ?")
      .get("context") as { reference: string };
    assert.equal(result.reference, "architecture");
    database.close();
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("two ShareLane processes can write concurrently", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sharelane-concurrency-"));

  try {
    openDatabase(projectRoot).close();
    const first = startWriter(projectRoot, "claude");
    const second = startWriter(projectRoot, "codex");

    await waitForFiles([
      join(projectRoot, "ready-claude"),
      join(projectRoot, "ready-codex"),
    ]);
    await writeFile(join(projectRoot, "start-writers"), "go", "utf8");
    await Promise.all([first, second]);

    const database = openDatabase(projectRoot);
    const row = database
      .prepare("SELECT COUNT(*) AS count FROM journal")
      .get() as { count: number };
    assert.equal(row.count, 100);
    database.close();
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
