---
title: Project decisions
read-when: Understanding why a storage, context, testing, or agent-integration choice was made.
covers-files: ["docs/DECISIONS.md"]
updated-at: 2026-09-28T13:57:01.016Z
source-hash: e1d9abc912c3202c69a5fd2a41a200311c366e666de3e2bcac479550194279a1
---

# Project decisions

The complete append-only record is docs/DECISIONS.md. Phase 1 decisions choose built-in SQLite/FTS5, small capped context chunks, committed curated context, accurate MCP annotations, content fingerprints, and Node's test runner.

Phase 2 decisions 34–42 choose validated YAML adapters; shell-free argument spawning; normalized Claude/Codex results and ignored raw logs; persistent detached tasks and conversation messages; same-session replies; guarded cancellation; complete lineage with a depth limit of three and cycle rejection; a context-rich first worker prompt; read-only orphan reporting; a Windows CIM broker so workers survive caller exit; and final wait synchronization for human-readable task files.

Phases 1 and 2 are complete. Their requirement evidence is in docs/PHASE_1_AUDIT.md and docs/PHASE_2_AUDIT.md. Phase 3 starts worker isolation and collision prevention.
