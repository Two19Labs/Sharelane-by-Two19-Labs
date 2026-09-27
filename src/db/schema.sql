CREATE TABLE IF NOT EXISTS schema_info (
  version INTEGER NOT NULL
);

INSERT INTO schema_info (version)
SELECT 1
WHERE NOT EXISTS (SELECT 1 FROM schema_info);

UPDATE schema_info SET version = 2;

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  read_when TEXT NOT NULL,
  covers_files TEXT NOT NULL CHECK (json_valid(covers_files)),
  updated_at TEXT NOT NULL,
  content TEXT NOT NULL,
  file_path TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL,
  note TEXT NOT NULL,
  agent TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS journal_task_created_at
ON journal (task, created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  kind UNINDEXED,
  reference UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  parent_id TEXT REFERENCES tasks(id),
  depth INTEGER NOT NULL DEFAULT 1,
  session_id TEXT,
  result TEXT,
  error TEXT,
  usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
  task_file TEXT NOT NULL,
  log_path TEXT NOT NULL,
  worker_pid INTEGER,
  agent_pid INTEGER,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS tasks_parent_created_at
ON tasks (parent_id, created_at);

CREATE INDEX IF NOT EXISTS tasks_status_updated_at
ON tasks (status, updated_at DESC);
