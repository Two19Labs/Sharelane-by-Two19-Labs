---
title: Architecture
read-when: Understanding ShareLane components and data flow.
covers-files: ["src/**"]
updated-at: 2026-10-02T14:50:20.875Z
source-hash: 0744a6bdef2b8babce2f338f72a2ccf8525560c45bfe3065e517b0b4f2a99c69
---

# Architecture

ShareLane is a local MCP hub with two connected flows. Context requests go from the MCP server or CLI into the context core, which maintains small Markdown chunks, a generated map, SQLite records, FTS5 search, and a progress journal. Delegation requests go from MCP task tools into the task core, runner, and configuration-driven agent adapters (`src/adapters/agents.yaml`: Claude Code, Codex, Antigravity CLI). Adding an agent is configuration plus, if its output format is new, one parser in `src/adapters/result.ts`. Adapters name their quota reader and may add `workerNotes` to a new task's instructions.

A delegated task is persisted before a detached supervisor starts. For a Git-backed project, ShareLane creates an external temporary worktree on a unique `sharelane/task-*` branch, linking the project's `node_modules`. The supervisor checks the agent's allowance, records a run, builds a focused first prompt (context map, claim, scope, usage-checkpoint, worker-note, and efficiency rules), and starts the CLI without a shell inside that checkout; on Windows an npm `.cmd` launcher is resolved to `node <script>`. It normalizes JSON output and usage, stores the conversation and session, commits remaining changes, records the result, unlinks the dependency link, and removes the checkout. Replies recreate the same branch and resume the saved session.

Phase 5 failover (`src/core/quota.ts` and the handoff code in `src/core/tasks.ts`): quota readers report each agent's windows (Codex from session logs; Claude from a status-line snapshot with the usage endpoint as a fallback; Antigravity unknown). The rule is the owner's: at or below 7% remaining in the lowest window, hand off; "could not tell" is never "fine". A pre-run check, an allowance error (out of credits, usage or rate limit), or a `HANDOFF:` reply makes the supervisor save the work, write `.sharelane/tasks/<task>.handoff.md`, and reassign to an agent outside the delegation chain that has not tried the task and has allowance left; that agent continues on the same branch with the handoff as its prompt (at most two reassignments). Otherwise the task waits as `needs_reassignment` for the reassign tool. Optional per-task fresh-token budgets stop further runs once used.

Collision prevention is layered: expiring SQLite claims with conservative overlap refusal, advisory duplicate notices, one guard script blocking unclaimed or out-of-scope built-in edits for Claude and Antigravity, and a Git watcher plus final diff for everything else; `.sharelane/context/**` is ShareLane-managed. Scopes are claimed atomically with the task, turned into Claude `dontAsk` rules or a scope-rooted Codex sandbox, and enforced by patch-and-restore before the commit. SQLite notices ride on every successful MCP reply because separate stdio hubs cannot push alerts.

The efficiency path is progressive: simple work stays with the orchestrator; delegated work begins with only the map; workers open only relevant chunks and files, check usage at checkpoints, and keep outputs concise. SQLite WAL mode and a busy timeout let the per-agent stdio MCP servers share local state safely.
