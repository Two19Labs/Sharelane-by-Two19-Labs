CREATE TABLE IF NOT EXISTS schema_info (
  version INTEGER NOT NULL
);

INSERT INTO schema_info (version)
SELECT 1
WHERE NOT EXISTS (SELECT 1 FROM schema_info);

UPDATE schema_info SET version = 7;

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
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'needs_reassignment', 'paused')),
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
  caller_agent TEXT,
  source_root TEXT,
  worktree_path TEXT,
  branch_name TEXT,
  base_commit TEXT,
  result_commit TEXT,
  changed_files_json TEXT CHECK (changed_files_json IS NULL OR json_valid(changed_files_json)),
  scope_json TEXT CHECK (scope_json IS NULL OR json_valid(scope_json)),
  scope_violations_json TEXT CHECK (scope_violations_json IS NULL OR json_valid(scope_violations_json)),
  budget_tokens INTEGER,
  reassignments INTEGER NOT NULL DEFAULT 0,
  handoff_reason TEXT,
  dismissed_at TEXT,
  conversation_closed_at TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS tasks_parent_created_at
ON tasks (parent_id, created_at);

CREATE INDEX IF NOT EXISTS tasks_status_updated_at
ON tasks (status, updated_at DESC);

-- One row per agent run of a task: the first run, each reply, and each reassignment.
CREATE TABLE IF NOT EXISTS task_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  resumed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS task_runs_task_id
ON task_runs (task_id, id);

CREATE TABLE IF NOT EXISTS task_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS task_messages_task_id_id
ON task_messages (task_id, id);

CREATE TABLE IF NOT EXISTS task_lineage (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  agent TEXT NOT NULL,
  PRIMARY KEY (task_id, position)
);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  agent TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  path_pattern TEXT NOT NULL,
  intent TEXT NOT NULL,
  created_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS claims_owner_expires_at
ON claims (owner_key, expires_at);

CREATE INDEX IF NOT EXISTS claims_expires_at
ON claims (expires_at);

CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_agent TEXT,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);

CREATE INDEX IF NOT EXISTS notices_pending
ON notices (delivered_at, recipient_agent, task_id, created_at);
