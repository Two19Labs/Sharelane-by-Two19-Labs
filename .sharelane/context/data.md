---
title: Data and storage
read-when: Changing stored data, schemas, search, migrations, or persistence.
covers-files: ["src/db/**","src/core/database.ts","src/core/context.ts","src/core/memory.ts","src/core/claims.ts","src/core/notices.ts","src/core/tasks.ts"]
updated-at: 2026-09-29T07:23:09.688Z
source-hash: 9ed97623d5696f442a2cc2484941318b5f6ff5d98681b4a6ec732de09655c2f7
---

# Data and storage

Curated context lives in committed Markdown files under .sharelane/context. MAP.md is generated; topic chunks have title, read-when, covers-files, updated-at, and source-hash headers. FTS5 indexes chunks and progress notes for word search.

Local runtime state lives in .sharelane/sharelane.db using SQLite WAL mode. Schema version 4 stores tasks and worktree hand-back metadata, each task's normalized `scope_json` and `scope_violations_json`, task_messages for complete conversations, task_lineage for loop-safe agent paths, expiring path claims, and deliverable notices (including `scope_violation`). Opening an older database adds missing task columns automatically. Human-readable task snapshots live under .sharelane/tasks, together with `<task>.out-of-scope.patch` files that preserve changes kept off a scoped task's branch; raw agent output lives under .sharelane/runs.

Git-backed delegated work runs in external temporary worktrees so runtime files do not nest inside the owner's checkout. Source changes are preserved on unique `sharelane/task-*` branches; the temporary checkout is removed after ShareLane commits the result. For scoped tasks, out-of-scope paths are restored to the starting commit before that commit. Branches remain until the owner reviews and merges or deletes them.

The database, WAL files, raw journal, task snapshots and patches, run logs, and legacy notes are ignored by Git. They contain local runtime history or rebuildable indexes; curated context and audit documents are committed.
