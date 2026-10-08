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
  tasksDir: string;
}

const taskColumns: Record<string, string> = {
  caller_agent: "TEXT",
  source_root: "TEXT",
  worktree_path: "TEXT",
  branch_name: "TEXT",
  base_commit: "TEXT",
  result_commit: "TEXT",
  changed_files_json: "TEXT CHECK (changed_files_json IS NULL OR json_valid(changed_files_json))",
  scope_json: "TEXT CHECK (scope_json IS NULL OR json_valid(scope_json))",
  scope_violations_json:
    "TEXT CHECK (scope_violations_json IS NULL OR json_valid(scope_violations_json))",
  budget_tokens: "INTEGER",
  reassignments: "INTEGER NOT NULL DEFAULT 0",
  handoff_reason: "TEXT",
};

const statusCheckPattern = /status TEXT NOT NULL CHECK \(status IN \([^)]*\)\)/;
const newStatusCheck = statusCheckPattern.exec(schema)?.[0] ?? "";

/**
 * SQLite cannot change a CHECK constraint in place, so an older tasks table is
 * rebuilt once to accept newer statuses (needs_reassignment in version 5,
 * paused in version 6). Foreign keys
 * are switched off around the copy so dropping the old table cannot cascade
 * into messages, lineage, claims, notices, or runs.
 */
function allowCurrentStatuses(database: DatabaseSync): void {
  const tableSql = (): string =>
    (
      database
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
        .get() as { sql: string }
    ).sql;
  if (!newStatusCheck || tableSql().includes(newStatusCheck)) return;
  database.exec("PRAGMA foreign_keys = OFF;");
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      // Another process may have finished the rebuild while this one waited.
      const sql = tableSql();
      if (!sql.includes(newStatusCheck)) {
        const rebuilt = sql
          .replace(statusCheckPattern, newStatusCheck)
          .replace(/^CREATE TABLE "?tasks"?/, "CREATE TABLE tasks_rebuild");
        database.exec(rebuilt);
        database.exec("INSERT INTO tasks_rebuild SELECT * FROM tasks");
        database.exec("DROP TABLE tasks");
        database.exec("ALTER TABLE tasks_rebuild RENAME TO tasks");
        database.exec(schema);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.exec("PRAGMA foreign_keys = ON;");
  }
}

function migrateExistingDatabase(database: DatabaseSync): void {
  const columns = database.prepare("PRAGMA table_info(tasks)").all() as unknown as Array<{
    name: string;
  }>;
  const existing = new Set(columns.map((column) => column.name));
  for (const [name, definition] of Object.entries(taskColumns)) {
    if (!existing.has(name)) {
      database.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
    }
  }
  allowCurrentStatuses(database);
  database.exec("UPDATE schema_info SET version = 6;");
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
    tasksDir: join(shareLaneDir, "tasks"),
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
    migrateExistingDatabase(database);
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
