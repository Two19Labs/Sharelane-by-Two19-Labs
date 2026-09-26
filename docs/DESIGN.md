# ShareLane — Design

> Status: **draft; Phase 0 implemented**. This file is the source of truth for what we're building and why; update it when a decision changes.

## 1. What ShareLane is

A local, open-source hub that lets coding agents (Claude Code, Codex, Gemini CLI, and any other agentic CLI) **share one project memory** and **delegate work to each other**, with no human relaying messages.

- **Agent-neutral.** Any supported agent can be the orchestrator; any can be a worker. Adding an agent is a config entry, not new code.
- **Subscription-only.** Agents run through their official CLIs, logged in with the user's own subscription. ShareLane never touches API keys or auth tokens.
- **Per-project.** All state lives in the project (`.sharelane/`), so each repo has its own memory.

## 2. Primer: the two mechanisms everything is built on

ShareLane relies on two different things every mainstream agent CLI supports. They point in opposite directions.

### 2.1 MCP: the agent calls out to tools

MCP (Model Context Protocol) is a standard way for an agent to use external tools. The agent is the **client**; the tool provider is the **server**.

An MCP server is just a program. The agent launches it and they exchange JSON messages over stdin/stdout:

```text
agent  → server: {"method": "tools/list"}
server → agent : {"tools": [{"name": "recall", "description": "Search project memory", "inputSchema": {...}}]}

agent  → server: {"method": "tools/call", "params": {"name": "recall", "arguments": {"query": "auth flow"}}}
server → agent : {"content": [{"type": "text", "text": "Auth uses JWT, see context/api.md"}]}
```

The model reads each tool's name and description and decides for itself when to call it. With the official SDK a server is a few lines:

```ts
const server = new McpServer({ name: "sharelane", version: "0.1.0" });
server.tool("recall", { query: z.string() }, async ({ query }) => ({
  content: [{ type: "text", text: searchMemory(query) }],
}));
await server.connect(new StdioServerTransport());
```

Each agent is told about the server once, in its own config:

| Agent | Where MCP servers are configured |
|---|---|
| Claude Code (CLI + VS Code extension) | `.mcp.json` in the project, or `claude mcp add` |
| Codex (CLI + VS Code extension) | `~/.codex/config.toml` → `[mcp_servers.*]` |
| Gemini CLI | `.gemini/settings.json` → `mcpServers` |

Other agents with MCP client support include Cursor, Cline, GitHub Copilot agent mode, OpenCode and Goose. Not every agent has it, so ShareLane also ships a plain **CLI** (`sharelane recall "auth flow"`) that does the same things. Any agent that can run shell commands can use it. MCP is the preferred interface; the CLI is the universal fallback.

### 2.2 Headless mode: a program runs the agent

Headless mode means running an agent as a one-shot command: prompt in, result out, no chat window.

```text
claude -p "fix the failing test" --output-format json
codex exec --json "build the navbar in src/ui"
gemini -p "write docs for api.ts" --output-format json
```

Here the **script is in charge and the agent is the worker**. Most support resuming a session (`codex exec resume <id>`, `claude --resume <id>`) and machine-readable output.

### 2.3 How ShareLane combines them

```text
            you chat here (any agent)
                     │
                     ▼
   ┌────────── Orchestrator agent ──────────┐
   │ calls ShareLane tools over MCP          │
   └────────────────┬───────────────────────┘
                    ▼
              ShareLane hub ──────────► .sharelane/  (memory, tasks, claims, usage)
                    │
     launches workers in headless mode, in the background
          ┌─────────┼──────────┐
          ▼         ▼          ▼
       codex     claude     gemini     ← each worker is also connected to ShareLane
       exec       -p          -p          over MCP, so it sees the same memory
```

- **MCP** is how any agent *talks to* ShareLane.
- **Headless** is how ShareLane *starts* another agent.

Because every agent gets both, the setup is symmetric: whichever agent you're chatting with is the orchestrator for that task.

## 3. Requirements

| # | Requirement | Notes |
|---|---|---|
| R1 | Any agent can orchestrate; any can be a worker | Chosen per task: whoever you're chatting with orchestrates |
| R2 | Workers run in the background | You keep chatting with the orchestrator only |
| R3 | Structured shared context, not one giant file | Map + chunks, loaded on demand (§5) |
| R4 | Delegation returns a task ID immediately | Async; tool calls time out on long tasks |
| R5 | Detect and stop two agents working on the same files or task | Claims + worktrees + detection (§6.3) |
| R6 | Loop-safe delegation | Depth limit + cycle detection |
| R7 | Permissions scoped per delegation | e.g. "Codex may only touch `src/ui/**`" |
| R8 | Usage logging per agent/run | |
| R9 | Agents check their own quota and hand off before running out | Handoff files (§6.6) |
| R10 | Dashboard to watch all agents' activity and chats | Web first, VS Code extension later |
| R11 | Adding a new agent = config, not code | Adapters (§6.1) |
| R12 | Where the orchestrator runs doesn't matter | Terminal or VS Code panel, as long as it has MCP or a shell |

## 4. Where it runs

- **The orchestrator** is whatever chat you're already using: the Claude Code or Codex panel in VS Code, a terminal session, or anything else. The VS Code extensions for Claude Code and Codex read the same MCP config as their CLIs.
- **Workers** are background processes the hub starts. They don't need a terminal window; you watch them through the dashboard.
- **The hub** is a Node program started by each agent as its MCP server. It has no permanent background process (see §6.2).

## 5. Shared context: map + chunks

Goal: every agent knows *where* to look without reading everything. Context is loaded in layers (progressive disclosure), so a typical task costs a few thousand tokens, not hundreds of thousands.

```text
.sharelane/
  context/
    MAP.md            ← always loaded: project summary + index of chunks (~150 lines max)
    architecture.md   ← chunks, one per area, each capped in size
    ui.md
    api.md
    data.md
    conventions.md
    decisions.md      ← why things are the way they are
  tasks/
    <task-id>.md      ← live state of each task: goal, owner, claims, progress, handoff
  journal/            ← append-only raw log; never loaded by default, folded into chunks
  sharelane.db        ← SQLite: tasks, claims, usage, search index
```

**Layers**

1. **MAP.md** (always read): a one-paragraph project summary, then a table: chunk, one-line description, "read this when…", files it covers, last updated. It also includes a Mermaid diagram of how areas relate.
2. **Chunks** (read on demand): the agent reads only the ones relevant to its task.
3. **Task file** (read when working on or taking over a task).
4. **Journal + search** (only when needed): `search("why did we drop redux")` over everything using SQLite full-text search.

**Tools:** `context_map()`, `read_chunk(id)`, `search(query)`, `update_chunk(id, content)`, `log_progress(task, note)`.

**Keeping it fresh**
- When an agent finishes a task, it writes what it learned back into the relevant chunk(s). This write-back step is part of every task.
- Each chunk records which source files it covers. If those files change after the chunk was last updated, the chunk is marked **stale** in MAP.md and the dashboard.
- Chunks have a size cap. Going over it triggers a compaction step (an agent summarizes the chunk), so it never grows into a 4,000-line file.
- The journal is folded into chunks periodically, then archived.

**Visual map:** the dashboard renders the same data as a graph (areas ↔ files ↔ tasks ↔ agents). Staleness and active claims are shown on it.

*Not in v1:* embedding-based semantic search. It needs an API key or a local model; full-text search is enough to start.

## 6. Components

### 6.1 Agent adapters

Each agent is described in config. ShareLane only ever uses these fields:

```yaml
agents:
  codex:
    run:        codex exec --json -s workspace-write "{prompt}"
    resume:     codex exec resume {session} "{prompt}"
    scope_flags: ...          # how to express a permission scope for this CLI
    usage:      ...           # how to read remaining quota (§6.6)
    transcripts: ~/.codex/sessions/
    mcp_config: ~/.codex/config.toml
    instructions_file: AGENTS.md
  claude:
    run:        claude -p --output-format json "{prompt}"
    resume:     claude -p --resume {session} "{prompt}"
    transcripts: ~/.claude/projects/
    mcp_config: .mcp.json
    instructions_file: CLAUDE.md
```

`sharelane init` writes each agent's MCP config and instruction-file pointer for the project.

### 6.2 Hub process model

Each agent launches its own copy of the hub over stdio. The copies coordinate through one SQLite database (WAL mode lets several processes use it at once).

- **Pro:** nothing to start or keep alive; it can't be "down".
- **Con:** the hub can't push to an agent. It only answers when called. Alerts reach agents on their next ShareLane call (every tool response includes pending notices). The dashboard sees everything live.

### 6.3 Conflict prevention (R5)

Layered, because MCP tools are voluntary and an agent can ignore instructions:

1. **Worktrees (default for workers).** Each delegated worker runs in its own git worktree on its own branch, so workers can't overwrite each other's files. The orchestrator merges when the task is done.
2. **Claims.** `claim(paths, intent)` before editing; the hub refuses overlapping claims and says who holds them and why. Claims expire (TTL + heartbeat) so a crashed agent doesn't hold files forever. With worktrees, claims mainly prevent two agents *doing the same work* and surface merge conflicts early.
3. **Duplicate-task detection.** New tasks are compared against active ones (same files, similar goal) and flagged before starting.
4. **Hooks** where the CLI supports them (e.g. Claude Code's PreToolUse hook) block edits to files the agent hasn't claimed.
5. **Detection.** A file watcher / git diff flags edits nobody claimed; they show on the dashboard and as notices.

### 6.4 Delegation (R1, R4, R6)

- `delegate(agent, task, scope?)` → returns `task_id` immediately; the worker runs in the background.
- `status(task_id)`, `wait(task_id, timeout)`, `reply(task_id, message)` (resumes the worker's session), `cancel(task_id)`.
- Every worker gets `SHARELANE_TASK_ID`, `SHARELANE_PARENT`, `SHARELANE_DEPTH` in its environment. The hub refuses a delegation when depth exceeds the limit (default 3) or when it would loop back on its own chain.
- Output and the full transcript are captured for the dashboard.

### 6.5 Scoped permissions (R7)

`delegate("codex", "build the navbar", scope=["src/ui/**"])`:
- claims those paths for the worker,
- translates the scope into that CLI's flags (sandbox mode, allowed tools, writable dirs) via the adapter,
- is enforced again by hooks and detection where flags can't express it exactly.

### 6.6 Usage and handoffs (R8, R9)

- Every run records: agent, task, start/end, exit status, tokens (when the CLI's JSON output includes them).
- **Quota:** agents can read their own plan usage (Manthan has done this in another project for both Codex and Claude). Reading quota goes through the adapter's `usage` field so each CLI's method is isolated and easy to fix if a vendor changes it. **TODO: reuse and verify the approach from that project.**
- **Handoff policy:**
  - Agents call `log_progress` after each meaningful step, so the task file is always a usable handoff even after a sudden stop.
  - When quota crosses a threshold (e.g. 90%), the agent writes a full handoff (goal, done, in progress, next steps, gotchas) and ShareLane reassigns the task to another agent.
  - If a worker dies with a rate-limit error, the hub marks the task `needs_reassignment` and offers it to the next agent with its task file.

### 6.7 Dashboard (R10)

- **v1:** local web page (`sharelane dashboard`) reading the SQLite db: agents, active tasks, claims, usage, context map graph, and live worker output.
- **Chats:** worker transcripts are captured by the hub. Interactive chats are read from each CLI's transcript folder (adapter `transcripts` field).
- **Later:** a VS Code extension with the same views in a side panel.
- **Later, fun layer:** an animated "office" view. Each agent is a little character at a desk; you can watch them pick up tickets, walk to files they've claimed, pass handoff notes, and show a speech bubble with what they're currently doing. Same live data as the dashboard, just visual. Also good for demos and content.

## 7. Tech choices

| Choice | Decision | Why |
|---|---|---|
| Language | TypeScript on Node | Official MCP SDK is best supported in TS; users install with `npx sharelane init`; the agent CLIs' users already have Node |
| Storage | SQLite (WAL) + markdown files | SQLite for concurrent state; markdown so context is readable, diffable, and committed to git |
| Search | SQLite FTS5 | No API keys, no extra services |
| Package name | `sharelane` | Free on npm as of 2026-09-26 |

## 8. Build phases

| Phase | Build | Learn |
|---|---|---|
| 0 | Repo + "hello" MCP tool, connected to Claude and Codex | How MCP works end to end |
| 1 | Context map + chunks + search tools | Progressive disclosure, SQLite, FTS |
| 2 | Adapters + async delegation, Claude ↔ Codex both ways | Child processes, parsing JSON streams, task trees |
| 3 | Worktrees + claims + duplicate detection + hooks | Concurrency, locking, git internals |
| 4 | Scoped permissions | Each CLI's sandbox model |
| 5 | Usage, quota checks, handoffs, failover | Designing for failure |
| 6 | Web dashboard | Reading live state, simple UI |
| 7 | Gemini + more adapters, `init`, docs, npm publish | Packaging and open-source launch |
| 8 | VS Code extension | Extension API |
| 9 | Animated office view (agents as characters) | Animation driven by live data |

## 9. Open questions

1. How exactly does each CLI expose plan quota? Pull from Manthan's other project.
2. Merge strategy when a worker's worktree is done: orchestrator merges automatically, or asks you?
3. Should `.sharelane/context/` be committed to git (shared with teammates) or ignored?
4. Default delegation depth and claim TTL values.
5. Prior art to check before launch (e.g. MCP Agent Mail, Zen/PAL MCP): what they already do, and how ShareLane differs.

## 10. Decisions

All decisions, with reasons and which ones are still only proposals, live in [DECISIONS.md](DECISIONS.md).
