---
title: Architecture
read-when: Understanding ShareLane components and data flow.
covers-files: ["src/**"]
updated-at: 2026-10-03T06:05:33.113Z
source-hash: d3695b4f9d2aaa6375ec2315f3a9b34636422398810cc19a3c3c3b6d1b4b0fca
---

# Architecture

ShareLane is a local MCP hub with two connected flows. Context requests go from the MCP server or CLI into the context core, which maintains small Markdown chunks, a generated map, SQLite records, FTS5 search, and a progress journal. Delegation requests go from MCP task tools into the task core, runner, and configuration-driven agent adapters (`src/adapters/agents.yaml`: Claude Code, Codex, Antigravity CLI). Adding an agent is configuration plus, if its output format is new, one parser in `src/adapters/result.ts`. Adapters name their quota reader and may add `workerNotes` to a new task's instructions.

Packaging (Phase 7): the npm package ships TypeScript source run by tsx at runtime. `bin/sharelane.mjs` registers tsx in-process and imports `src/cli.ts` (commands init, mcp, dashboard, run). The worker's tsx is resolved with `createRequire(...).resolve("tsx/cli")`, and the schema, adapters, and dashboard assets resolve from `import.meta.url`, so an installed copy works from any project. `src/core/setup.ts` (`setupProject`) is `init`: it detects agent CLIs with `findOnPath`, writes project configs that launch `node <project-relative bin> mcp`, and never edits a global config unless given `--yes`.

A delegated task is persisted before a detached supervisor starts. For a Git-backed project, ShareLane creates an external temporary worktree on a unique `sharelane/task-*` branch, linking the project's `node_modules`. The supervisor:
1. checks the agent's allowance and records a run;
2. builds a focused first prompt (context map, claim, scope, usage-checkpoint, run_check, worker-note, and efficiency rules);
3. starts the CLI without a shell inside that checkout (npm `.cmd` launchers, including `npm.cmd`/`npx.cmd`, are resolved to `node <script>`);
4. normalizes JSON output and usage, and stores the conversation and session;
5. commits remaining changes, records the result, unlinks the dependency link, and removes the checkout.

Replies recreate the same branch and resume the saved session.

Approved checks (`src/core/checks.ts`): the owner's allow-list in `.sharelane/checks.json` is read from the project checkout. A check runs without a shell inside the caller's workspace, with a process-tree timeout and an 8 KB output tail. It is not a sandbox.

Phase 5 failover (`src/core/quota.ts` and the handoff code in `src/core/tasks.ts`): quota readers (Codex from its logs, Claude from a status-line snapshot with an endpoint fallback, Antigravity unknown); the owner's 7% lowest-window rule; save-first handoff with reassignment on the same branch (at most twice); otherwise `needs_reassignment`, with the notice created before the status changes; and per-task budgets.

Collision prevention is layered: expiring claims with overlap refusal, duplicate notices, one guard script for Claude and Antigravity built-in edits, and Git watching plus a final diff. Scopes are claimed atomically, mapped to native CLI restrictions, and enforced by patch-and-restore. Notices ride on every successful MCP reply.

Phase 6 dashboard (`src/dashboard/`): a separate read-only process on `127.0.0.1`, answering only `localhost` Host headers. It polls the same database, chunks, and logs, and never writes or uses Claude's token endpoint.

SQLite WAL mode and a busy timeout let the per-agent MCP servers and the dashboard share local state safely.
