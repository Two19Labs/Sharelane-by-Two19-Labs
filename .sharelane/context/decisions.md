---
title: Project decisions
read-when: Understanding why a storage, context, testing, or agent-integration choice was made.
covers-files: ["docs/DECISIONS.md"]
updated-at: 2026-09-28T14:18:45.204Z
source-hash: 83c48af41994eb5a0a908aeb981c58e7216b91429025eb1b5368bc0333d0cdf7
---

# Project decisions

The complete append-only record is docs/DECISIONS.md. Phase 1 decisions choose built-in SQLite/FTS5, small capped context chunks, committed curated context, accurate MCP annotations, content fingerprints, and Node's test runner.

Phase 2 decisions 34–42 choose validated YAML adapters; shell-free argument spawning; normalized Claude/Codex results and ignored raw logs; persistent detached tasks and conversation messages; same-session replies; guarded cancellation; complete lineage with a depth limit of three and cycle rejection; a context-rich first worker prompt; read-only orphan reporting; a Windows CIM broker; and final wait synchronization for task files.

Decision 43 makes token-efficient orchestration the default: direct execution for simple work, value-gated delegation, a roughly 25% fresh-token overhead target when measurable, separate cache reporting, progressive context loading, and automatic warnings/budgets planned for Phase 5.

Phases 1 and 2 are complete. Phase 3 starts worker isolation and collision prevention.
