---
title: Data and storage
read-when: Changing stored data, schemas, search, migrations, or persistence.
covers-files: ["src/db/**","src/core/database.ts","src/core/context.ts","src/core/memory.ts","src/core/claims.ts","src/core/notices.ts","src/core/tasks.ts"]
updated-at: 2026-10-02T14:50:21.974Z
source-hash: 8fab770c174a9bf147b9d4831e7ef57cbcb62ac12885b78e1b63aded8c9ea559
---

# Data and storage

Curated context lives in committed Markdown files under .sharelane/context. MAP.md is generated; topic chunks have title, read-when, covers-files, updated-at, and source-hash headers. FTS5 indexes chunks and progress notes for word search. Workers may update this context from their task worktrees; those changes are ShareLane-managed and never count as scope or claim violations.

Local runtime state lives in .sharelane/sharelane.db using SQLite WAL mode. Schema version 5 stores tasks (status including `needs_reassignment`; worktree hand-back metadata; scope and scope violations; `budget_tokens`, `reassignments`, `handoff_reason`), task_runs (one row per agent run with outcome and usage JSON), task_messages for complete conversations, task_lineage for loop-safe agent paths (the last entry is replaced on reassignment), expiring path claims, and deliverable notices (collision, scope, handoff, budget). Opening a pre-v5 database adds missing columns and rebuilds the tasks table once with foreign keys off, so no linked rows cascade away; this was verified on a copy of the real database. Human-readable task snapshots, `<task>.out-of-scope.patch`, `<task>.handoff.md`, and task logs live under .sharelane/tasks; raw run output under .sharelane/runs.

Outside the project, Claude's usage snapshot is `~/.sharelane/usage/claude.json` (usage numbers only, never a token), written by ShareLane's status line or its endpoint fallback. Codex usage is read, never written, from `~/.codex/sessions`.

Git-backed delegated work runs in external temporary worktrees with a `node_modules` junction that ShareLane unlinks (never deleting the target) before Git removes the checkout. Changes are preserved on unique `sharelane/task-*` branches, including work saved just before a handoff; for scoped tasks, out-of-scope paths are restored before the commit. Branches remain until the owner reviews and merges or deletes them.

The database, WAL files, raw journal, task snapshots, patches, handoff notes, run logs, and legacy notes are ignored by Git. Curated context, `.claude/` and `.agents/` agent wiring, and audit documents are committed.
