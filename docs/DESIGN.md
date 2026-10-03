# ShareLane — Design

> Status: **draft; Phases 0–6 implemented; Phase 7 code complete (publishing is the owner's step)**. This file is the source of truth for what we're building and why; update it when a decision changes.

## 1. What ShareLane is

A local, open-source hub that lets coding agents (Claude Code, Codex, Antigravity CLI, and any other agentic CLI) **share one project memory** and **delegate work to each other**, with no human relaying messages.

- **Agent-neutral.** Any supported agent can be the orchestrator; any can be a worker. Adding an agent is a config entry, not new code.
- **Subscription-only.** Agents run through their official CLIs, logged in with the user's own subscription. ShareLane never uses API keys or stores auth tokens. The one exception is an optional, read-only Claude usage check that reads Claude's sign-in token into memory to ask Anthropic how much allowance is left (decision 60).
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
| Claude Code (CLI + VS Code extension) | `.mcp.json` in the project (written by `sharelane init`), or `claude mcp add` |
| Codex (CLI + VS Code extension) | `~/.codex/config.toml` → `[mcp_servers.*]` (global; `init` prints the `codex mcp add` command, or runs it with `--yes`) |
| Antigravity CLI (`agy`, Google's successor to Gemini CLI) | `.agents/mcp_config.json` in the project, plus a global `mcp(sharelane/*)` allow rule |

Other agents with MCP client support include Cursor, Cline, GitHub Copilot agent mode, OpenCode and Goose. Not every agent has it, so ShareLane also ships a plain **CLI** (`sharelane recall "auth flow"`) that does the same things. Any agent that can run shell commands can use it. MCP is the preferred interface; the CLI is the universal fallback.

### 2.2 Headless mode: a program runs the agent

Headless mode means running an agent as a one-shot command: prompt in, result out, no chat window.

```text
claude -p "fix the failing test" --output-format json
codex exec --json "build the navbar in src/ui"
agy -p "write docs for api.ts" --output-format json --mode accept-edits
```

Here the **script is in charge and the agent is the worker**. Most support resuming a session (`codex exec resume <id>`, `claude --resume <id>`, `agy --conversation <id>`) and machine-readable output.

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
       codex     claude   antigravity  ← each worker is also connected to ShareLane
       exec       -p        agy -p        over MCP, so it sees the same memory
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

Goal: every agent knows *where* to look without reading everything. Context is loaded in layers (progressive disclosure). Agents start with the map, then open only relevant chunks or document sections; cached and fresh tokens are measured separately so a large cache count cannot hide avoidable context loading.

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
- Each chunk records which source files it covers and a fingerprint of their contents. If those contents change after the chunk is updated, it is marked **stale** in MAP.md and the dashboard. Older chunks without a fingerprint fall back to Git timestamps.
- Chunk bodies are capped at 12,000 characters. Going over the cap is refused with “compact this first,” so a chunk cannot silently grow into a giant context file.
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
    scope:                    # fills the {scopeArgs} slot in run/resume (§6.5)
      scoped:   --cd {scopeRoot} --add-dir={scopeExtraDir} ...
      unscoped: []
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
  antigravity:
    run:        agy -p "{prompt}" --output-format json --mode accept-edits
    resume:     agy -p "{prompt}" --conversation {session} ...
    workerNotes: [...]        # agent-specific lines added to a new task's instructions
    mcp_config: .agents/mcp_config.json
    instructions_file: AGENTS.md
```

Each CLI's output format needs one small parser in `src/adapters/result.ts`; everything else is configuration. On Windows, npm-installed CLIs are `.cmd` launchers, which ShareLane resolves to "node + script" so agents still start without a shell.

`sharelane init` detects which agent CLIs are installed and wires each one: the MCP config (launched as `node <installed bin> mcp`, because MCP clients start servers without a shell), the edit guard where the CLI has hooks, Claude's usage status line, the instruction-file block, and `.sharelane/checks.json`. It never edits a global configuration (Codex) unless the user passes `--yes`, and it prints what is left for the user to do.

### 6.1a Approved checks (`run_check`)

`.sharelane/checks.json` is the owner's allow-list of exact commands (prefilled from package.json `test`, `typecheck`, `lint`). The `run_check` tool lists them or runs one, without a shell, inside the caller's workspace (a delegated worker's worktree, so it sees uncommitted edits), with a timeout that stops the whole process tree and an 8 KB output tail. The list is read from the project checkout, never from a worker's editable copy. It limits *which command lines* run; the commands still execute project code an agent may have written, so it is not a sandbox.

### 6.2 Hub process model

Each agent launches its own copy of the hub over stdio. The copies coordinate through one SQLite database (WAL mode lets several processes use it at once).

- **Pro:** nothing to start or keep alive; it can't be "down".
- **Con:** the hub can't push to an agent. It only answers when called. Alerts reach agents on their next ShareLane call (every tool response includes pending notices). The dashboard sees everything live.

### 6.3 Conflict prevention (R5)

Layered, because MCP tools are voluntary and an agent can ignore instructions:

1. **Worktrees (default for workers).** Each delegated worker runs in a temporary Git worktree on a unique `sharelane/task-*` branch. ShareLane commits remaining changes, removes the temporary checkout, and hands the branch and commit back for review. It does not silently merge into the owner's branch.
2. **Claims.** `claim(paths, intent)` before editing; the hub refuses overlapping file/glob claims and says who holds them and why. Claims expire after 15 minutes by default, explicit `heartbeat` extends them, task supervisors refresh them every 30 seconds, and terminal tasks release them.
3. **Duplicate-task detection.** New prompts are compared with queued/running prompts. At 60% or greater word-set overlap, the caller receives a warning while worktree isolation and claims remain the enforcement layers.
4. **Hooks.** `sharelane init` installs a project Claude Code `PreToolUse` hook for `Edit|Write`. It checks the central claim database and blocks an unclaimed built-in edit before execution.
5. **Detection and notices.** A task watcher plus final Git diff flags changed paths that the task did not claim, and, for scoped tasks, paths outside the scope (§6.5). Pending duplicate, edit, and cleanup notices are appended to every successful MCP tool reply. This covers Codex, shell edits, and other paths a Claude hook cannot block.

### 6.4 Delegation (R1, R4, R6)

- `delegate(agent, task, scope?, budgetTokens?)` → returns `task_id` immediately; the worker runs in the background. Without `scope`, the worker may change the whole project (the Phase 3 behavior). `budgetTokens` caps fresh tokens across all of the task's runs (§6.6).
- `status(task_id)`, `wait(task_id, timeout)`, `reply(task_id, message)` (resumes the worker's session), `cancel(task_id)`.
- Every worker gets `SHARELANE_TASK_ID`, `SHARELANE_PARENT`, `SHARELANE_DEPTH` in its environment. The hub refuses a delegation when depth exceeds the limit (default 3) or when it would loop back on its own chain.
- Output and the full transcript are captured for the dashboard.
- **Efficiency gate:** the orchestrator handles simple work directly. It delegates only for useful specialization, independent review, parallelism, or an explicit user request, and reuses the same worker session for follow-ups.

### 6.5 Scoped permissions (R7)

`delegate("codex", "build the navbar", scope=["src/ui/**"])`:

1. **Normalize.** Each entry must be project-relative (no absolute paths, no `..`). `./src/ui/`, `src\ui\**`, and an existing `src/ui` folder all become `src/ui/**`. The scope is stored with the task and shown in status, wait, the task file, and notices.
2. **Claim.** ShareLane pre-checks the scope against other owners' claims, then claims it for the task in the same transaction that creates the task. An overlapping claim refuses the delegation. The worker's own later claims must stay inside the scope. Claims are refreshed while the task runs, released when it ends, and re-claimed on `reply`.
3. **Translate to CLI restrictions.** The adapter's `{scopeArgs}` slot receives the agent's strongest native control:
   - **Claude:** `--permission-mode dontAsk` (tools that are not pre-approved are denied) plus `Edit(<pattern>)`/`Write(<pattern>)` allow rules for each scope entry. Built-in edits outside the scope are refused.
   - **Codex:** the `workspace-write` sandbox is rooted at the scope's folder with `--cd` (plus `--add-dir` for further folders), and the temp-folder write allowances are removed because ShareLane worktrees live under the temp folder. The sandbox is folder-level, so a file glob inside a folder is enforced by the next two layers.
4. **Hook.** The shared `PreToolUse` guard (Claude `Edit`/`Write`; Antigravity `write_to_file`/`replace_file_content`/`multi_replace_file_content`) rejects an out-of-scope edit before its claim check, with a clear reason.
5. **Detect and keep off the branch.** The Git watcher records out-of-scope paths as `scope_violation` notices. When the task is saved, ShareLane writes those changes to `.sharelane/tasks/<task>.out-of-scope.patch`, restores the paths to the starting commit, and commits only in-scope work. An escaped write therefore never lands on the task branch.

**Antigravity** has no per-path CLI restriction, so its scope relies on layers 1, 2, 4 (`.agents/hooks.json` runs the same guard as Claude) and 5. Agents without a `scope` adapter entry still get layers 1, 2, and 5. In a folder that is not a Git repository there is no worktree, so layer 5 is unavailable and scope relies on claims, CLI flags, and the hook.

### 6.6 Usage and handoffs (R8, R9)

- **Usage accounting.** Every run of a task (first run, each reply, each reassignment) is a row in `task_runs` with its agent, times, outcome, and tokens. Status and task files show totals of **fresh input**, **cached input**, and **output**; "fresh" is normalized per CLI so the numbers compare.
- **Quota readers.** Each adapter names a built-in `quota` reader. Every reader answers the same way: windows with % remaining, and a verdict of **keep working**, **HAND OFF**, or **could not tell**.
  - **Codex:** the newest rate-limit event in its local session logs (no network, no credentials).
  - **Claude:** a status-line snapshot. ShareLane's status-line script saves Claude's `rate_limits` and then shows the user's own status line unchanged. When that snapshot is older than 15 minutes, ShareLane falls back to Anthropic's OAuth usage endpoint (token in memory only, at most one call per 5 minutes).
  - **Antigravity:** no programmatic reader; its limit errors are the signal.
- **The rule (the owner's, from Cospire):** at or below **7% remaining in the lowest window**, hand off. "Could not tell" is never "fine". A stale "plenty left" reading becomes "could not tell"; a stale "exhausted until the reset" reading still stands, because usage only rises until a reset.
- **Checkpoints, not polling.** The worker checks before every run; agents call the `usage` tool between major steps. The Claude endpoint itself rate-limits, so constant polling would break it.
- **Handoff and reassignment.**
  1. Triggers: the pre-run check says hand off; a run dies with an allowance error (out of credits, usage or rate limit, 429); or the agent replies starting `HANDOFF:`.
  2. ShareLane **saves the work to the task branch first**, then writes `.sharelane/tasks/<task>.handoff.md` (original request, later requests, progress notes, saved branch and files, last reply, reason).
  3. It reassigns to the first configured agent that is outside the delegation chain, has not tried the task, and is not at its threshold. The new agent continues **on the same branch**, with the handoff as its prompt. At most two reassignments per task.
  4. Otherwise the task waits as `needs_reassignment`, the caller gets a notice, and the `reassign` tool hands it over manually.
- **Budgets.** `delegate(..., budgetTokens)` caps fresh tokens (new input plus output) across all runs. The caller is warned at 80%; once it is used up, no further run, reply, or reassignment starts. Usage arrives when a run ends, so budgets act between runs.
- **Efficiency target.** Orchestration overhead should stay around 25% or less of a direct run. That baseline cannot be measured reliably, so it stays guidance; budgets are the enforceable control.
- Avoid repeated status polling, duplicate reviews, rereading unchanged files, full historical logs, and oversized prompt/output dumps. These are the main preventable sources of multi-agent overhead.

### 6.7 Dashboard (R10)

- **v1 (built in Phase 6):** `npm run sharelane -- dashboard [--port 4317] [--open]` serves a local, read-only page from Node's built-in `http` module. It shows:
  - headline tiles: active tasks, tasks waiting for handoff, active claims, fresh tokens;
  - agent cards with an allowance meter per usage window and the 7% handoff marker;
  - a task table (status, request, agent path, scope, tokens and budget) with a detail panel: facts, **live output**, the conversation, and any handoff note;
  - claims with expiry countdowns, notices, and progress notes;
  - tokens by agent (a stacked bar with a table view);
  - a context-map graph showing which chunk covers which files, and which chunks are stale.
- **Safety:** it listens on `127.0.0.1` only and answers only `localhost` Host headers (stopping DNS rebinding). It is GET-only, uses a strict self-only Content-Security-Policy, and builds the page from text nodes, so task text cannot inject code. Looking at it never delivers notices or changes anything, and it never uses Claude's token-based usage endpoint.
- **Live updates:** the page polls every 2 seconds and pauses while hidden; live output is read by byte offset from the task's own log. A link such as `/#task=<id>` opens a task directly.
- **Chats:** worker transcripts are captured by the hub. Reading interactive chats from each CLI's transcript folder (adapter `transcripts` field) is still to come.
- **Later:** a VS Code extension with the same views in a side panel.
- **Later, fun layer:** an animated "office" view. Each agent is a little character at a desk; you can watch them pick up tickets, walk to files they've claimed, pass handoff notes, and show a speech bubble with what they're currently doing. Same live data as the dashboard, just visual. Also good for demos and content.

## 7. Tech choices

| Choice | Decision | Why |
|---|---|---|
| Language | TypeScript on Node | Official MCP SDK is best supported in TS; users install with `npx sharelane init`; the agent CLIs' users already have Node |
| Storage | SQLite (WAL) + markdown files | SQLite for concurrent state; markdown so context is readable, diffable, and committed to git |
| Search | SQLite FTS5 | No API keys, no extra services |
| Package name | `sharelane` | Free on npm as of 2026-09-26, rechecked 2026-10-03 |
| Packaging | TypeScript source run through tsx at runtime; `bin/sharelane.mjs`; MIT license | No build step; paths resolve from the installed package (decision 68) |

## 8. Build phases

| Phase | Build | Learn |
|---|---|---|
| 0 | Repo + "hello" MCP tool, connected to Claude and Codex | How MCP works end to end |
| 1 | Context map + chunks + search tools | Progressive disclosure, SQLite, FTS |
| 2 | Adapters + async delegation, Claude ↔ Codex both ways | Child processes, parsing JSON streams, task trees |
| 3 | Worktrees + claims + duplicate detection + hooks | Concurrency, locking, git internals |
| 4 | Scoped permissions (done) | Each CLI's sandbox model |
| 5 | Usage, quota checks, handoffs, failover (done) | Designing for failure |
| 6 | Web dashboard (done) | Reading live state, simple UI |
| 7 | More adapters (Antigravity done early), `init`, `run_check`, packaging, docs (code done; publish and video pending) | Packaging and open-source launch |
| 8 | VS Code extension | Extension API |
| 9 | Animated office view (agents as characters) | Animation driven by live data |

## 9. Open questions

1. ~~How exactly does each CLI expose plan quota?~~ Resolved in Phase 5 from Manthan's Cospire checker: Claude via status line or usage endpoint, Codex via session logs, Antigravity not exposed (decisions 59–60).
2. Prior art to check before launch (e.g. MCP Agent Mail, Zen/PAL MCP): what they already do, and how ShareLane differs.

## 10. Decisions

All decisions, with reasons and which ones are still only proposals, live in [DECISIONS.md](DECISIONS.md).
