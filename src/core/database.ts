import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const schemaPath = fileURLToPath(
  new URL("../db/schema.sql", import.meta.url),
);
const schema = readFileSync(schemaPath, "utf8");

export interface ShareLanePaths {
  root: string;
  shareLaneDir: string;
  database: string;
  contextDir: string;
  map: string;
  journalDir: string;
}

export function getShareLanePaths(projectRoot = process.cwd()): ShareLanePaths {
  const shareLaneDir = join(projectRoot, ".sharelane");
  const contextDir = join(shareLaneDir, "context");

  return {
    root: projectRoot,
    shareLaneDir,
    database: join(shareLaneDir, "sharelane.db"),
    contextDir,
    map: join(contextDir, "MAP.md"),
    journalDir: join(shareLaneDir, "journal"),
  };
}

export function openDatabase(projectRoot = process.cwd()): DatabaseSync {
  const paths = getShareLanePaths(projectRoot);
  mkdirSync(paths.shareLaneDir, { recursive: true });

  const database = new DatabaseSync(paths.database);

  try {
    // busy_timeout makes a writer briefly wait when another process is writing.
    database.exec("PRAGMA busy_timeout = 5000;");
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec("PRAGMA synchronous = NORMAL;");
    database.exec("PRAGMA foreign_keys = ON;");
    database.exec(schema);
    return database;
  } catch (error: unknown) {
    database.close();
    throw error;
  }
}

export function hasFts5(database: DatabaseSync): boolean {
  const row = database
    .prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled")
    .get() as { enabled: number };

  return row.enabled === 1;
}
