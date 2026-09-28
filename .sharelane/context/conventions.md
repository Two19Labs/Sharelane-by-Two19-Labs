---
title: Project conventions
read-when: Following the project's coding, testing, documentation, or collaboration rules.
covers-files: ["AGENTS.md","CLAUDE.md","package.json","tsconfig.json"]
updated-at: 2026-09-28T14:18:44.404Z
source-hash: a1a07d72d045719f8044c5dc783e04fac9476b697d30ab11961e0bf5f2663036
---

# Project conventions

Explain each small step in plain language before doing it. Preserve other work, record lasting choices in docs/DECISIONS.md, and append a concise session handoff to GLOBAL_CONTEXT.md before finishing.

Keep multi-agent overhead marginal. Handle simple work directly; delegate only for clear specialization, independent review, parallelism, or an explicit request. When measurable, target roughly 25% or less fresh-token overhead versus a direct run and report fresh input/output separately from cache reads/writes. This is a workflow target until Phase 5 adds cumulative accounting, warnings, and hard budgets.

Read only the current snapshot and newest relevant work-log entry, then use the context map to open only relevant chunks or document sections. Avoid rereading unchanged files, old logs, full transcripts, repeated status polling, and large output dumps. Reuse task sessions for follow-ups and keep prompts, progress notes, handoffs, and final answers concise.

Use npm test for protocol and core tests, npm run typecheck for TypeScript, npm audit --audit-level=high for dependency checks, and npm run sharelane -- init for local setup. Agent commands must use argument arrays with no shell.
