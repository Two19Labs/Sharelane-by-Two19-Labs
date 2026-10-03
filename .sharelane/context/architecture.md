---
title: Architecture
read-when: Understanding ShareLane components and data flow.
covers-files: ["src/**"]
updated-at: 2026-10-03T05:22:14.545Z
source-hash: 70af434a0b6db5f017034b2d99898e963942ba4626ca4a36f0067777c67a16f9
---

# Architecture

ShareLane is a local MCP hub with two connected flows. Context requests go from the MCP server or CLI into the context core, which maintains small Markdown chunks, a generated map, SQLite records, FTS5 search, and a progress journal. Delegation requests go from MCP task tools into the task core, runner, and configuration-driven agent adapters (`src/adapters/agents.yaml`: Claude Code, Codex, Antigravity CLI). Adding an agent is configuration plus, if its output format is new, one parser in `src/adapters/result.ts`. Adapters name their quota reader and may add `workerNotes` to a new task's instructions.

A delegated task is persisted before a detached supervisor starts. For a Git-backed project, ShareLane creates an external temporary worktree on a unique `sharelane/task-*` branch, linking the project's `node_modules`. The supervisor:
1. checks the agent's allowance and records a run;
2. builds a focused first prompt (context map, claim, scope, usage-checkpoint, worker-note, and efficiency rules);
3. starts the CLI without a shell inside that checkout (on Windows an npm `.cmd` launcher is resolved to `node <script>`);
4. normalizes JSON output and usage, and stores the conversation and session;
5. commits remaining changes, records the result, unlinks the dependency link, and removes the checkout.

Replies recreate the same branch and resume the saved session.

Phase 5 failover (`src/core/quota.ts` and the handoff code in `src/core/tasks.ts`):
- **Quota readers** report each agent's windows: Codex from session logs; Claude from a status-line snapshot with the usage endpoint as a fallback; Antigravity unknown.
- **The rule** is the owner's: at or below 7% remaining in the lowest window, hand off; "could not tell" is never "fine".
- **Handoff:** a pre-run check, an allowance error, or a `HANDOFF:` reply makes the supervisor save the work, write a handoff note, and reassign to an eligible agent on the same branch (at most twice). Otherwise the task waits as `needs_reassignment`.
- **Budgets:** optional per-task fresh-token budgets stop further runs once used.

Collision prevention is layered:
- expiring SQLite claims with conservative overlap refusal, and advisory duplicate notices;
- one guard script blocking unclaimed or out-of-scope built-in edits for Claude and Antigravity;
- a Git watcher plus final diff for everything else.

Scopes are claimed atomically, turned into native CLI restrictions, and enforced by patch-and-restore before the commit. SQLite notices ride on every successful MCP reply, because separate stdio hubs cannot push alerts.

Phase 6 dashboard (`src/dashboard/`): a separate read-only process started by `sharelane dashboard`. It reads the same SQLite database, chunk files, and task logs, and serves a local page that polls every 2 seconds. It never writes, delivers notices, or uses Claude's token endpoint, and answers only on `127.0.0.1` for `localhost` Host headers.

The efficiency path is progressive: simple work stays with the orchestrator; delegated work begins with only the map; workers open only relevant chunks and files, check usage at checkpoints, and keep outputs concise. SQLite WAL mode and a busy timeout let the per-agent MCP servers and the dashboard share local state safely.
