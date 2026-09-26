---
title: Project conventions
read-when: Following the project's coding, testing, documentation, or collaboration rules.
covers-files: ["AGENTS.md","CLAUDE.md","package.json","tsconfig.json"]
updated-at: 2026-09-26T20:50:49.943Z
source-hash: 60373c5802fe2c35e717087374571ef1b82158df814fb817ccc986fa4e02ee05
---

# Project conventions

Explain each small step in plain language before doing it. Preserve other work, record lasting choices in docs/DECISIONS.md, and append a concise session handoff to GLOBAL_CONTEXT.md before finishing.

Use npm test for the protocol and core tests, npm run typecheck for TypeScript, and npm run sharelane -- init for local setup. Context updates must go through ShareLane so MAP.md, FTS search, and source fingerprints stay synchronized.
