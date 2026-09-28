# ShareLane context map

> Generated from chunk headers. Edit a chunk through ShareLane instead of editing this index by hand.

## Project

**sharelane** — A shared project memory and delegation hub for coding agents.

## How to use this map

Read only the chunks relevant to your task. After meaningful work, update the affected chunks so the next agent receives fresh context.

## Context chunks

| Chunk | Read this when… | Covers files | Updated at | Status |
|---|---|---|---|---|
| [API and tools](./api.md) | Changing commands, MCP tools, integrations, or public interfaces. | `src/mcp/**`, `src/cli.ts` | 2026-09-28T13:56:58.270Z | current |
| [Architecture](./architecture.md) | Understanding ShareLane components and data flow. | `src/**` | 2026-09-28T13:56:57.411Z | current |
| [Project conventions](./conventions.md) | Following the project's coding, testing, documentation, or collaboration rules. | `AGENTS.md`, `CLAUDE.md`, `package.json`, `tsconfig.json` | 2026-09-28T13:57:00.177Z | current |
| [Data and storage](./data.md) | Changing stored data, schemas, search, migrations, or persistence. | `src/db/**`, `src/core/database.ts`, `src/core/context.ts`, `src/core/memory.ts` | 2026-09-28T13:56:59.233Z | current |
| [Project decisions](./decisions.md) | Understanding why a storage, context, testing, or agent-integration choice was made. | `docs/DECISIONS.md` | 2026-09-28T13:57:01.016Z | current |
| [User interface](./ui.md) | Changing screens, interactions, dashboard behavior, visual design, or examples/calculator. | `examples/calculator/**` | 2026-09-27T04:17:25.488Z | current |

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
