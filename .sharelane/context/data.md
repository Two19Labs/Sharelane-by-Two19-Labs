---
title: Data and storage
read-when: Changing stored data, schemas, search, migrations, or persistence.
covers-files: ["src/db/**","src/core/database.ts","src/core/context.ts","src/core/memory.ts","src/core/claims.ts","src/core/notices.ts","src/core/tasks.ts"]
updated-at: 2026-10-01T17:23:48.757Z
source-hash: b501e7f632a16580a42c3fa97791d030552f6cea8e336d8370aa78ae9e362e5d
---

# Data and storage

Curated context lives in committed Markdown files under .sharelane/context. MAP.md is generated; topic chunks have title, read-when, covers-files, updated-at, and source-hash headers. FTS5 indexes chunks and progress notes for word search. Workers may update this context from their task worktrees; those changes are ShareLane-managed and never count as scope or claim violations.

Local runtime state lives in .sharelane/sharelane.db using SQLite WAL mode. Schema version 4 stores tasks and worktree hand-back metadata, each task's normalized `scope_json` and `scope_violations_json`, task_messages for complete conversations, task_lineage for loop-safe agent paths, expiring path claims, and deliverable notices (including `scope_violation`). A task's scope claims survive a worker's own `release` and are removed only when the task ends. Opening an older database adds missing task columns automatically. Human-readable task snapshots live under .sharelane/tasks, together with `<task>.out-of-scope.patch` files; raw agent output lives under .sharelane/runs and task logs.

Git-backed delegated work runs in external temporary worktrees so runtime files do not nest inside the owner's checkout. Each worktree gets a `node_modules` junction to the project's dependencies, which ShareLane unlinks (never deleting the target) before Git removes the checkout. Source changes are preserved on unique `sharelane/task-*` branches; for scoped tasks, out-of-scope paths are restored to the starting commit before that commit. Branches remain until the owner reviews and merges or deletes them.

The database, WAL files, raw journal, task snapshots and patches, run logs, and legacy notes are ignored by Git. They contain local runtime history or rebuildable indexes; curated context, `.claude/` and `.agents/` agent wiring, and audit documents are committed.
