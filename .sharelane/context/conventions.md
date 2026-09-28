---
title: Project conventions
read-when: Following the project's coding, testing, documentation, or collaboration rules.
covers-files: ["AGENTS.md","CLAUDE.md","package.json","tsconfig.json"]
updated-at: 2026-09-28T13:57:00.177Z
source-hash: c89fdbd4deb1d27a642205b8cbac1835b57ff8a4c4f1afb7344a0a35bddfb002
---

# Project conventions

Explain each small step in plain language before doing it. Preserve other work, record lasting choices in docs/DECISIONS.md, and append a concise session handoff to GLOBAL_CONTEXT.md before finishing.

Use npm test for protocol and core tests, npm run typecheck for TypeScript, npm audit --audit-level=high for dependency checks, and npm run sharelane -- init for local setup. The calculator example has its own dependency-free node --test suite. Context updates must go through ShareLane so MAP.md, FTS search, and source fingerprints stay synchronized.

Agent commands must use argument arrays with no shell. Persist task state before launching work, preserve cancellation as final, keep status and orphan checks read-only, and use wait when a caller needs the readable task snapshot synchronized with a final database state.
