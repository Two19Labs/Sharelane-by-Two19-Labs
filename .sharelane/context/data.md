---
title: Data and storage
read-when: Changing stored data, schemas, search, migrations, or persistence.
covers-files: ["src/db/**","src/core/database.ts","src/core/context.ts","src/core/memory.ts","src/core/claims.ts","src/core/notices.ts","src/core/tasks.ts"]
updated-at: 2026-09-28T14:47:03.492Z
source-hash: 0ddbedda390eddb7841641476681315731c9e0a3a27f10000c39d8d20a9adc07
---

# Data and storage

Curated context lives in committed Markdown files under .sharelane/context. MAP.md is generated; topic chunks have title, read-when, covers-files, updated-at, and source-hash headers. FTS5 indexes chunks and progress notes for word search.

Local runtime state lives in .sharelane/sharelane.db using SQLite WAL mode. Schema version 3 stores tasks and worktree hand-back metadata, task_messages for complete conversations, task_lineage for loop-safe agent paths, expiring path claims, and deliverable notices. Human-readable task snapshots live under .sharelane/tasks and raw agent output under .sharelane/runs.

Git-backed delegated work runs in external temporary worktrees so runtime files do not nest inside the owner's checkout. Source changes are preserved on unique `sharelane/task-*` branches; the temporary checkout is removed after ShareLane commits the result. Branches remain until the owner reviews and merges or deletes them.

The database, WAL files, raw journal, task snapshots, run logs, and legacy notes are ignored by Git. They contain local runtime history or rebuildable indexes; curated context and audit documents are committed.
