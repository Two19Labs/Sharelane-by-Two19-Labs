---
title: Data and storage
read-when: Changing stored data, schemas, search, migrations, or persistence.
covers-files: ["src/db/**","src/core/database.ts","src/core/context.ts","src/core/memory.ts"]
updated-at: 2026-09-28T13:56:59.233Z
source-hash: bfef655d6c250d08a2af8a6727709326521f26d4efd66dd3474cafc5327a9026
---

# Data and storage

Curated context lives in committed Markdown files under .sharelane/context. MAP.md is generated; topic chunks have title, read-when, covers-files, updated-at, and source-hash headers. FTS5 indexes chunks and progress notes for word search.

Local runtime state lives in .sharelane/sharelane.db using SQLite WAL mode. Phase 2 adds tasks for lifecycle state, task_messages for the complete conversation, and task_lineage for loop-safe agent paths. Human-readable task snapshots live under .sharelane/tasks and raw agent output under .sharelane/runs.

The database, WAL files, raw journal, task snapshots, run logs, and legacy notes are ignored by Git. They contain local runtime history or rebuildable indexes; curated context and audit documents are committed.
