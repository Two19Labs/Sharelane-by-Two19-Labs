# ShareLane

ShareLane is a local, open-source hub that lets coding-agent CLIs share one project memory and hand work to each other. Claude Code, Codex and Antigravity CLI (`agy`) all connect to it over MCP. From whichever agent you are chatting with, you can delegate a task to another one. It runs in the background on its own Git branch, inside the folders you allowed, and if that agent runs out of allowance another one picks up where it stopped. Everything uses your own subscription logins. There are no API keys and no cloud service.

> **Status:** early (v0.1). Tested mainly on Windows 11. Not yet published to npm; see [Quick start](#quick-start).

## Why

If you use more than one coding agent, you probably run into these problems:

- **Lost context.** Each tool keeps its own notes. When you switch from Claude to Codex, you explain the project again.
- **Collisions.** Two agents edit the same file, or redo each other's work.
- **Running out mid-task.** An agent hits its usage limit halfway through, and you have to work out what it finished and brief another agent by hand.

ShareLane gives all of them one shared notebook for the project and one place to hand off work, with guard rails.

## Features

- **Shared context, loaded in small pieces.** A short `MAP.md` plus topic chunks (architecture, API, UI…), full-text search (SQLite FTS5), and "stale" flags when the files a chunk describes have changed since it was written.
- **Delegation in any direction.** Any agent can start another in the background. You get a task ID right away, then `status`, `wait`, `reply` (continues the same session) and `cancel`. Depth and loop limits stop agents from delegating in circles.
- **Isolated branches.** Each delegated worker runs in its own Git worktree and returns a `sharelane/task-*` branch for you to review. Nothing is merged automatically.
- **Collision protection.** Agents claim files before editing. Claims expire, overlapping claims are refused, and similar duplicate tasks get a warning. An edit-guard hook blocks unclaimed edits in Claude Code and Antigravity, and Git detection catches edits from anything else.
- **Scoped tasks.** "Codex may only change `src/ui/**`." Enforced with each CLI's own permission controls where they exist, and otherwise by keeping out-of-scope changes off the branch.
- **Usage, quota and handoff.** Token use is recorded for every run. Before each run, ShareLane checks the agent's remaining allowance. At 7% or less, or when a run fails because the agent ran out, it saves the work, writes a handoff note and passes the task to another agent on the same branch. ("Could not tell" is reported, never treated as "fine", but it does not block a run on its own.)
- **Token budgets** per task.
- **Approved checks (`run_check`).** Agents can ask ShareLane to run commands you approved, such as `npm test`, without getting a terminal.
- **Right model for each task.** Whoever hands out work picks how hard it is (fast, balanced, or strong), or lets ShareLane guess from the wording, and each agent runs on the matching model: Claude Haiku, Sonnet, or Opus; Antigravity Gemini Flash or Pro; Codex at low, medium, or high effort. Edit the mapping in `agents.yaml`.
- **Live office dashboard.** A local page that shows your agents as employees in a pixel-art office: at their desk when working, at the review board when finished, in the meeting room when they need you. Click one to read its conversation and live output, and to pause, resume, stop, message, or assign it work. A Details tab has the tables: tasks, claims, allowance meters, token use, and the context map.

## How it fits together

```mermaid
flowchart LR
  you([You]) --> orch["Agent you chat with<br/>(Claude Code, Codex or Antigravity)"]
  orch <-- MCP --> hub[ShareLane]
  hub -- starts in background --> w1[Codex worker]
  hub -- starts in background --> w2[Antigravity worker]
  w1 <-- MCP --> hub
  w2 <-- MCP --> hub
  hub --> state[(".sharelane/<br/>context, tasks, claims, usage")]
  w1 --> b1["task branch<br/>(Git worktree)"]
  w2 --> b2["task branch<br/>(Git worktree)"]
  hub --> dash[Dashboard<br/>localhost only]
```

Each agent starts its own copy of the ShareLane MCP server. The copies share one SQLite database in the project's `.sharelane/` folder, so there is no background service to keep running.

## Quick start

### Requirements

- Node.js 24 or newer
- Git
- At least one of these, installed and logged in with your subscription: [Claude Code](https://code.claude.com/), [Codex CLI](https://github.com/openai/codex), Antigravity CLI (`agy`)

### 1. Install

> **Not yet published.** Once ShareLane is on npm:
>
> ```sh
> npm install --save-dev sharelane
> ```
>
> Until then, clone this repository and link it:
>
> ```sh
> git clone https://github.com/Two19Labs/Sharelane-by-Two19-Labs.git sharelane
> cd sharelane
> npm install
> npm link
> # then, in your project:
> npm link sharelane
> ```

**Windows:** if PowerShell refuses to run `npm` or `npx` ("running scripts is disabled"), use `npm.cmd` / `npx.cmd`, or run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once.

### 2. Set up your project

In your project folder:

```sh
npx sharelane init
```

`init` looks for Claude Code, Codex and Antigravity and connects each one it finds:

- **Claude Code:** writes the project `.mcp.json`, the edit-guard hook and a usage status line (which keeps showing your own status line). Claude asks you once to approve the project's MCP server. **Commit `.mcp.json`**: delegated Claude workers read it from their task branch.
- **Codex:** keeps its MCP servers in your global config, so `init` prints a `codex mcp add …` command for you to run (pass `--yes` to let `init` run it). It also prints one line to add to `~/.codex/config.toml` so Codex may call ShareLane's tools without asking: `default_tools_approval_mode = "approve"` under `[mcp_servers.sharelane]`.
- **Antigravity:** writes `.agents/mcp_config.json` and its hook. Antigravity's permission rules are global only, so add one allow rule yourself: `mcp(sharelane/*)`.

It also creates `.sharelane/` with a starter context map and `.sharelane/checks.json` (see [Configuration](#configuration)).

### 3. Delegate your first task

Open the agent you normally use and ask in plain words. For example, in Claude Code:

> Use ShareLane to delegate to Codex: "add a dark-mode toggle to the settings page". Scope it to `src/ui/**` and give it a budget of 200k tokens.

Claude calls ShareLane's `delegate` tool and gets a task ID back right away. You can keep chatting. Ask "what's the status of that task?" or "wait for it", or send a follow-up with "reply to the task: also add a test". The same works from Codex or Antigravity: any of them can delegate to any other.

To check that an agent is set up, you can also run it once from the terminal. This runs it directly in the current folder and waits for its answer; it is not a delegated task (no task branch, claims or handoff):

```sh
npx sharelane run codex "say hello and list the ShareLane tools you can see"
```

### 4. Watch it

```sh
npx sharelane dashboard --open
```

This opens `http://localhost:4317/`, showing running tasks with live output, claims and their expiry times, allowance meters, tokens per agent, and which context chunks are stale.

### 5. Review the result

When the task finishes, its work is on a branch such as `sharelane/task-1a2b…`. Review and merge it like any other branch:

```sh
git log --oneline main..sharelane/task-1a2b...
git diff main...sharelane/task-1a2b...
git merge sharelane/task-1a2b...   # only if you're happy with it
```

## How it works

**Shared context.** Agents read `.sharelane/context/MAP.md` first. It is a short index of chunks, each with a "read this when…" line. They open only the chunks they need, or use `search`. After meaningful work, an agent updates the chunks it affected with `update_chunk`. Chunks are size-capped, and a chunk is marked stale when the files it covers change. The curated Markdown is meant to be committed; the database and raw logs stay local.

**Delegation.** `delegate(agent, task, scope?, budgetTokens?)` starts the other agent's CLI in headless mode (for example `codex exec` or `claude -p`) in a fresh worktree and returns a task ID. The worker connects back to ShareLane over MCP, so it sees the same memory and claims. `reply` resumes the same worker session instead of starting over. Delegation chains are limited to depth 3, and an agent cannot delegate back into its own chain.

**Scopes.** A scope is a list of project-relative paths or globs. ShareLane claims the scope for the task (refusing if someone else holds an overlapping claim), then translates it into each CLI's strongest control. For Claude Code, edits outside the scope are not pre-approved and so are denied. For Codex, the sandbox is rooted at the scope's folder. For Claude Code and Antigravity, the edit-guard hook also rejects out-of-scope edits. Finally, when the work is saved, any change outside the scope is written to a `.patch` file, restored, and kept off the task branch.

**Handoffs.** Before every run, ShareLane asks how much allowance the agent has left. Codex is read from its local session logs. Claude is read from a status-line snapshot, with a fallback described under [Safety](#safety-model). Antigravity has no reader, so its limit errors are the signal. If the lowest window is at 7% or below, a run fails with an allowance error (out of credits, usage or rate limit), or the worker replies `HANDOFF:` after checking its own usage, ShareLane:

1. commits the work so far to the task branch,
2. writes `.sharelane/tasks/<task>.handoff.md` (the request, progress notes, files changed, last reply, reason),
3. gives the task to another agent that has not tried it yet and is not itself low, on the same branch. At most two reassignments per task; otherwise the task waits as `needs_reassignment` and you can `reassign` it by hand.

**Budgets.** `budgetTokens` caps fresh tokens (new input plus output) across all runs of a task, including replies and reassignments. You get a warning at 80%, and nothing new starts once the budget is used up. Token counts arrive when a run ends, so a single run can go over. The budget stops the next run, not the current one.

**Approved checks (`run_check`).** Delegated Claude workers get no terminal, and Antigravity cannot run commands in headless mode. They can still run tests through `run_check`, which runs only commands listed in your project's `.sharelane/checks.json`, inside the task's worktree (so it sees the worker's uncommitted edits), with a time limit, and returns the last 8 KB of output. The list is always read from your main project checkout, so a worker cannot approve new commands by editing its own copy. **It is not a sandbox:** `npm test` runs the project's test code, which an agent may have written or changed.

## Safety model

- **Local only.** All state is in your project's `.sharelane/` folder. The dashboard listens on `127.0.0.1` and answers only `localhost`. Its controls work only from the page itself: each request needs a random token that other websites cannot read, plus a matching Origin.
- **No API keys.** Agents run through their official CLIs, logged in with your own subscription. ShareLane does not store credentials.
- **One exception, optional:** when the saved Claude status-line snapshot is more than 15 minutes old, ShareLane may read Claude Code's sign-in token into memory to make one read-only call to Anthropic's usage endpoint (at most once every 5 minutes). The token is never written anywhere. Turn this off with `SHARELANE_CLAUDE_USAGE_ENDPOINT=0`; Claude's quota then shows "could not tell" when the snapshot is stale.
- **Nothing is merged for you.** Workers edit isolated worktrees and leave branches. You decide what reaches your main branch.
- **Layered collision protection.** Expiring claims, the edit-guard hook (Claude Code and Antigravity), and Git detection with notices for edits the hook cannot see (Codex, shell commands).
- **No terminal for constrained workers.** `run_check` runs only command lines you listed, taken from your own checkout. Those commands still execute project code (tests, scripts) that an agent may have edited, so it limits *which commands* run, not *what the code does*.

## Configuration

**Agent adapters: `src/adapters/agents.yaml`** (inside the installed package; point `SHARELANE_AGENTS_CONFIG` at your own copy to change it). Each agent is a config entry: the command and arguments to run and resume it, how to translate a scope into its flags, which quota reader to use, and where its MCP config lives. Adding a new agent CLI is mostly a new entry, plus a small output parser in `src/adapters/result.ts` if its output format is new.

**Approved checks: `.sharelane/checks.json`.** `init` fills this from your `package.json` `test`, `typecheck` and `lint` scripts. Edit it to add, change or remove commands. Only commands listed here can be run through `run_check`.

**Environment variables.**

| Variable | Effect |
|---|---|
| `SHARELANE_CLAUDE_USAGE_ENDPOINT=0` | Never read Claude's token for the usage fallback |
| `SHARELANE_AGENTS_CONFIG=<path>` | Use your own adapters file instead of the bundled `agents.yaml` |

## Known limitations

- **Antigravity headless cannot run terminal commands** unless its sandbox is set up (a one-time administrator approval on Windows) or you allow unsandboxed commands. Out of the box, Antigravity workers use file tools, ShareLane tools and `run_check` only.
- **The Codex sandbox is folder-level.** A file glob inside a folder is enforced by claims and by keeping out-of-scope changes off the branch, not by Codex itself.
- **Budgets are enforced between runs,** not mid-run.
- **Antigravity has no allowance reader;** ShareLane learns it is out when a run fails.
- **Windows-first.** Developed and tested on Windows 11. It is written to be portable, but macOS and Linux have had less testing.
- **No direct agent-to-agent chat.** Agents coordinate through tasks, replies, claims and shared context, not free-form messages.
- **Depends on CLI behaviour.** Scope enforcement relies on flags and hooks in each CLI; re-check after major CLI upgrades.

## How ShareLane differs

Other tools run agents in parallel (claude-squad, Conductor, Vibe Kanban), let agents message each other (MCP Agent Mail, Neohive), or let one agent call another (PAL MCP's `clink`, mcp-agents). See [docs/PRIOR_ART.md](docs/PRIOR_ART.md) for an honest comparison, including where those tools are stronger.

## Contributing

Issues and pull requests are welcome. Before a large change, open an issue to discuss it. The design is in [docs/DESIGN.md](docs/DESIGN.md) and the reasons behind decisions are in [docs/DECISIONS.md](docs/DECISIONS.md).

```sh
npm install
npm test
npm run typecheck
```

Adapters for more agent CLIs are especially welcome.

## License

[MIT](LICENSE) © Manthan Kabra
