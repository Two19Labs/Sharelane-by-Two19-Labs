import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../../src/core/database.js";

const [projectRoot, workerName] = process.argv.slice(2);

if (!projectRoot || !workerName) {
  throw new Error("Expected project root and worker name");
}

const database = openDatabase(projectRoot);
const readyPath = join(projectRoot, `ready-${workerName}`);
const startPath = join(projectRoot, "start-writers");
writeFileSync(readyPath, "ready", "utf8");

while (!existsSync(startPath)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}

try {
  database.exec("BEGIN IMMEDIATE;");
  const insert = database.prepare(
    "INSERT INTO journal (task, note, agent, created_at) VALUES (?, ?, ?, ?)",
  );

  for (let index = 0; index < 50; index += 1) {
    insert.run(
      "concurrency-test",
      `${workerName}-${index}`,
      workerName,
      new Date().toISOString(),
    );
  }

  // Hold the write lock briefly so the other process must use busy_timeout.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  database.exec("COMMIT;");
} catch (error: unknown) {
  try {
    database.exec("ROLLBACK;");
  } catch {
    // There is nothing to roll back if BEGIN itself failed.
  }
  throw error;
} finally {
  database.close();
}
