---
title: Project decisions
read-when: Understanding why a storage, context, testing, or agent-integration choice was made.
covers-files: ["docs/DECISIONS.md"]
updated-at: 2026-10-01T17:23:49.785Z
source-hash: ada5b5aae0b26c05a95f64c6a4c0d538209284224672f41533fd70ad3804ab6b
---

# Project decisions

The complete append-only record is docs/DECISIONS.md. Phase 1 decisions choose built-in SQLite/FTS5, small capped context chunks, committed curated context, accurate MCP annotations, content fingerprints, and Node's test runner.

Phase 2 decisions 34–42 choose validated YAML adapters; shell-free argument spawning; normalized Claude/Codex results and ignored raw logs; persistent detached tasks and conversation messages; same-session replies; guarded cancellation; complete lineage with a depth limit of three and cycle rejection; a context-rich first worker prompt; read-only orphan reporting; a Windows CIM broker; and final wait synchronization for task files.

Decision 43 makes token-efficient orchestration the default: direct execution for simple work, value-gated delegation, a roughly 25% fresh-token overhead target when measurable, separate cache reporting, progressive context loading, and automatic warnings/budgets planned for Phase 5.

Phase 3 decisions 44–48 choose external temporary worktrees and reviewable task branches without auto-merge; automatic local commits and checkout cleanup; 15-minute claims with 30-second task heartbeats; conservative file/glob overlap refusal; advisory duplicate warnings at 60% prompt word overlap; a generated Claude edit-blocking hook plus Git fallback detection; and SQLite notices delivered on normal MCP replies.

Phase 4 decisions 49–53 choose an optional, normalized, persisted delegation scope; the scope as the task's atomically created claim; an adapter `{scopeArgs}` slot giving Claude `dontAsk` plus scoped Edit/Write rules and Codex a scope-rooted sandbox without temp-folder writes, plus Codex MCP task-variable forwarding; a scope check in the edit guard with distinct `scope_violation` detection; and patch-and-restore for out-of-scope changes.

Decisions 54–57 (2026-10-01) replace Gemini CLI (retired for personal accounts) with Antigravity CLI as the third agent: a configuration adapter plus one output parser, run with accept-edits and resumed by conversation ID; `.agents/` MCP and hook files from init with the shared guard and one global `mcp(sharelane/*)` allow rule; per-agent `workerNotes`; shell-free resolution of npm `.cmd` launchers; and fixes from the first real three-agent run (scope claims survive a worker's release, in-scope edits count as claimed, `.sharelane/context/**` is ShareLane-managed, and the `node_modules` junction is unlinked before worktree removal). Decision 21 is marked replaced.

Phases 1–4 are complete and Antigravity was added early from Phase 7. Phase 5 adds usage accounting, overhead budgets, quota reading, and handoffs.
