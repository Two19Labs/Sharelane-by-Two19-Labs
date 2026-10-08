# ShareLane context map

> Generated from chunk headers. Edit a chunk through ShareLane instead of editing this index by hand.

## Project

**sharelane** — A shared project memory and delegation hub for coding agents.

## How to use this map

Read only the chunks relevant to your task. After meaningful work, update the affected chunks so the next agent receives fresh context.

## Context chunks

| Chunk | Read this when… | Covers files | Updated at | Status |
|---|---|---|---|---|
| [API and tools](./api.md) | Changing commands, MCP tools, integrations, or public interfaces. | `src/mcp/**`, `src/cli.ts` | 2026-10-03T06:05:07.386Z | current |
| [Architecture](./architecture.md) | Understanding ShareLane components and data flow. | `src/**` | 2026-10-03T06:05:33.113Z | ⚠ stale |
| [Project conventions](./conventions.md) | Following the project's coding, testing, documentation, or collaboration rules. | `AGENTS.md`, `CLAUDE.md`, `package.json`, `tsconfig.json` | 2026-10-03T06:05:19.132Z | ⚠ stale |
| [Data and storage](./data.md) | Changing stored data, schemas, search, migrations, or persistence. | `src/db/**`, `src/core/database.ts`, `src/core/context.ts`, `src/core/memory.ts`, `src/core/claims.ts`, `src/core/notices.ts`, `src/core/tasks.ts` | 2026-10-08T08:30:47.541Z | current |
| [Project decisions](./decisions.md) | Understanding why a storage, context, testing, or agent-integration choice was made. | `docs/DECISIONS.md` | 2026-10-03T06:05:45.600Z | ⚠ stale |
| [User interface](./ui.md) | Changing screens, interactions, dashboard behavior, the office view, visual design, or examples/calculator. | `examples/calculator/**`, `src/dashboard/**` | 2026-10-08T08:30:29.675Z | current |

## Context map

```mermaid
graph LR
  MAP[MAP.md]
  MAP --> api
  MAP --> architecture
  MAP --> conventions
  MAP --> data
  MAP --> decisions
  MAP --> ui
```
