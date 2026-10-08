---
title: Data and storage
read-when: Changing stored data, schemas, search, migrations, or persistence.
covers-files: ["src/db/**","src/core/database.ts","src/core/context.ts","src/core/memory.ts","src/core/claims.ts","src/core/notices.ts","src/core/tasks.ts"]
updated-at: 2026-10-08T06:52:25.151Z
source-hash: f73110043bf905d4c2a2e864479f98753b26a56056c3b632231f922bfcf9ad6e
---

# Data and storage

Curated context lives in committed Markdown files under .sharelane/context. MAP.md is generated; topic chunks have title, read-when, covers-files, updated-at, and source-hash headers. FTS5 indexes chunks and progress notes for word search. Workers may update this context from their task worktrees; those changes are ShareLane-managed and never count as scope or claim violations.

`.sharelane/checks.json` (committed, `{version: 1, checks: {name: {command, args, timeoutSeconds, description?}}}`) is the owner's allow-list for `run_check`. `init` creates it from package.json `test`/`typecheck`/`lint` and never overwrites it. It is always read from the project checkout, never from a worker's worktree copy.

Local runtime state lives in .sharelane/sharelane.db using SQLite WAL mode. Schema version 6 stores:
- **tasks:** status including `needs_reassignment` and `paused`; worktree hand-back metadata; scope and scope violations; `budget_tokens`, `reassignments`, `handoff_reason`;
- **task_runs:** one row per agent run, with outcome and usage JSON;
- **task_messages:** complete conversations;
- **task_lineage:** loop-safe agent paths (the last entry is replaced on reassignment);
- **claims:** expiring path claims;
- **notices:** deliverable notices (collision, scope, handoff, budget). A handoff's notice is written before the task is marked `needs_reassignment`.

Opening an older database adds missing columns and, when the stored tasks status CHECK differs from the current schema's, rebuilds the tasks table once with foreign keys off (`allowCurrentStatuses`; v5 added `needs_reassignment`, v6 `paused`). Task usage totals come from task_runs. Pre-run-log tasks count their saved `usage_json` as one run (`freshInputOf`).

Task control (`tasks.ts`): `cancelTask` and `pauseTask` share `stopTask` (stop agent and supervisor, close runs, release claims, commit work to the branch, remove the worktree). The worker treats both as stopped by the user (`isStoppedByUser`) and records no failure. `resumeTask` goes through `replyToTask`, which accepts `completed` (with a session) or `paused`; without a session the resume message repeats the original request plus the latest instruction. Cancelling a paused task only changes its status.

Human-readable task snapshots, out-of-scope patches, handoff notes, and task logs live under .sharelane/tasks; raw run output lives under .sharelane/runs.

Outside the project, Claude's usage snapshot is `~/.sharelane/usage/claude.json` (usage numbers only, never a token). Codex usage is read, never written, from `~/.codex/sessions`.

Git-backed delegated work runs in external temporary worktrees with a `node_modules` junction that ShareLane unlinks (never deleting the target) before Git removes the checkout. Changes are preserved on unique `sharelane/task-*` branches until the owner merges or deletes them.

The database, WAL files, raw journal, task snapshots, patches, handoff notes, run logs, legacy notes, and `.claude/worktrees/` are ignored by Git. Curated context, `checks.json`, `.mcp.json`, `.claude/` and `.agents/` agent wiring, and audit documents are committed.
