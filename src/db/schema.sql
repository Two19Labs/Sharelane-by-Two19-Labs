CREATE TABLE IF NOT EXISTS schema_info (
  version INTEGER NOT NULL
);

INSERT INTO schema_info (version)
SELECT 1
WHERE NOT EXISTS (SELECT 1 FROM schema_info);

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
