---
title: Project decisions
read-when: Understanding why a storage, context, testing, or agent-integration choice was made.
covers-files: ["docs/DECISIONS.md"]
updated-at: 2026-09-27T03:25:02.201Z
source-hash: ef109268855c5568a89480b329e59f2d64ecbc41b31f83561511a2ddfd6ec3bd
---

# Project decisions

The complete append-only record is docs/DECISIONS.md. Phase 1 decisions choose Node's built-in SQLite with FTS5, WAL, and a five-second busy timeout; small JSON-based chunk headers; a 12,000-character body cap; committed curated context with ignored runtime indexes and logs; accurate MCP safety annotations with narrow Codex trust; source-content fingerprints for reliable stale detection; and Node's built-in test runner while it meets the project's needs.

Phase 1 is complete. Its requirement-by-requirement evidence is in docs/PHASE_1_AUDIT.md.
