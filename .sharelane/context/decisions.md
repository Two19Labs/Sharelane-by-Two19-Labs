---
title: Project decisions
read-when: Understanding why a storage, context, or agent-integration choice was made.
covers-files: ["docs/DECISIONS.md"]
updated-at: 2026-09-26T20:50:50.766Z
source-hash: 0367129e820b0427e3a14637bc5cc777c0d7a0c4f72708b720a687216d41a566
---

# Project decisions

The complete append-only record is docs/DECISIONS.md. Phase 1 decisions choose Node's built-in SQLite with FTS5, WAL, and a five-second busy timeout; small JSON-based chunk headers; a 12,000-character body cap; committed curated context with ignored runtime indexes and logs; accurate MCP safety annotations with narrow Codex trust; and source-content fingerprints for reliable stale detection.
