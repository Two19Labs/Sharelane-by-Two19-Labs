---
title: Data and storage
read-when: Changing stored data, schemas, search, migrations, or persistence.
covers-files: ["src/db/**","src/core/database.ts","src/core/context.ts","src/core/memory.ts","src/core/claims.ts","src/core/notices.ts","src/core/tasks.ts"]
updated-at: 2026-10-03T05:24:04.111Z
source-hash: 63770ccfa0605bb25779c02e519dc03c0fc9b0f86089b3829efbf8cb11871d9c
---

# Data and storage

Curated context lives in committed Markdown files under .sharelane/context. MAP.md is generated; topic chunks have title, read-when, covers-files, updated-at, and source-hash headers. FTS5 indexes chunks and progress notes for word search. Workers may update this context from their task worktrees; those changes are ShareLane-managed and never count as scope or claim violations.

Local runtime state lives in .sharelane/sharelane.db using SQLite WAL mode. Schema version 5 stores:
- **tasks:** status including `needs_reassignment`; worktree hand-back metadata; scope and scope violations; `budget_tokens`, `reassignments`, `handoff_reason`;
- **task_runs:** one row per agent run, with outcome and usage JSON;
- **task_messages:** complete conversations;
- **task_lineage:** loop-safe agent paths (the last entry is replaced on reassignment);
- **claims:** expiring path claims;
- **notices:** deliverable notices (collision, scope, handoff, budget).

Opening a pre-v5 database adds missing columns and rebuilds the tasks table once with foreign keys off, so no linked rows cascade away; this was verified on a copy of the real database. Task usage totals come from task_runs. A task from before the run log, which only saved its last run's `usage_json`, is counted as one run, with fresh input derived by the same per-CLI rules (`freshInputOf`).

Human-readable task snapshots, `<task>.out-of-scope.patch`, `<task>.handoff.md`, and task logs live under .sharelane/tasks; raw run output lives under .sharelane/runs. The dashboard only reads these, and reads task logs by byte offset.

Outside the project, Claude's usage snapshot is `~/.sharelane/usage/claude.json` (usage numbers only, never a token), written by ShareLane's status line or its endpoint fallback. Codex usage is read, never written, from `~/.codex/sessions`.

Git-backed delegated work runs in external temporary worktrees with a `node_modules` junction that ShareLane unlinks (never deleting the target) before Git removes the checkout. Changes are preserved on unique `sharelane/task-*` branches, including work saved just before a handoff; for scoped tasks, out-of-scope paths are restored before the commit. Branches remain until the owner reviews and merges or deletes them.

The database, WAL files, raw journal, task snapshots, patches, handoff notes, run logs, and legacy notes are ignored by Git. Curated context, `.claude/` and `.agents/` agent wiring, and audit documents are committed.
