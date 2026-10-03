# How ShareLane differs: prior art

ShareLane is not the first tool to run several coding agents at once, to give them a shared place to talk, or to let one agent call another. This page compares it with the closest projects we found in 2025–2026, says where they overlap, and says where they are stronger.

Everything here was checked against each project's own README or docs in early October 2026 (see [Sources](#sources)). Claims marked **(unverified)** come from third-party write-ups or could not be confirmed in the project's own material. Projects move fast; if something here is out of date, please open an issue.

## Comparison

Legend: **Yes** = documented and built in. **Partial** = some of it, or only in one direction. **No** = not found in the project's docs (it may still be possible by hand). **—** = not applicable.

| Tool | Cross-vendor delegation (agent starts another vendor's agent) | Shared project memory | File-collision protection | Per-task path scopes | Quota-aware handoff | Subscription logins, no API keys | Local dashboard | Isolated worktrees / branches |
|---|---|---|---|---|---|---|---|---|
| **ShareLane** | Yes, any direction among Claude Code, Codex, Antigravity | Yes: map + chunks, FTS5 search, freshness | Yes: expiring claims, overlap refusal, edit-guard hook, Git detection | Yes | Yes | Yes (one optional read of Claude's token for a usage check) | Yes, read-only | Yes, never auto-merged |
| [MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail) | No: agents message each other but it does not launch agents | Partial: searchable, Git-backed message archive (FTS5) | Yes: advisory leases with expiry, optional pre-commit guard | No | No | Yes | Yes (`/mail` web UI) | No |
| [PAL MCP (formerly Zen MCP)](https://github.com/BeehiveInnovations/pal-mcp-server) | Partial: `clink` lets the host agent spawn Claude, Codex, Gemini or Qwen CLIs as subagents | Partial: conversation threading across models | No | No (role presets, not path limits) | No | Partial: `clink` uses CLI logins; the other tools need provider API keys | No | No |
| [Claude Code subagents](https://code.claude.com/docs/en/sub-agents) / [agent teams](https://code.claude.com/docs/en/agent-teams) | No: Claude only | Partial: teams share a task list and mailbox | Partial: task claiming uses file locks; docs advise splitting files by hand | Partial: per-subagent tool allowlists | No | Yes | No (terminal agent panel) | Yes: `isolation: worktree` |
| [claude-squad](https://github.com/smtg-ai/claude-squad) | No: runs Claude Code, Codex, Gemini, Aider side by side, no agent-to-agent calls | No | Yes, by isolation (worktree per session) | No | No | Yes | No (terminal UI) | Yes |
| [Conductor](https://www.conductor.build/) | No (not documented) | No | Yes, by isolation (workspace + branch per task) | No | No | Yes **(unverified, third-party sources)** | Yes (Mac desktop app) | Yes |
| [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) | Partial: its MCP server lets an agent create an issue and start a workspace session with a chosen agent | Partial: kanban issues | Yes, by isolation (branch per workspace) | No | No | Yes **(unverified)** | Yes (web kanban) | Yes |
| [Crystal](https://github.com/stravu/crystal) (deprecated) | No | No | Yes, by isolation | No | No | Yes **(unverified)** | Yes (desktop app) | Yes |
| [uzi](https://github.com/devflowinc/uzi) | No: `broadcast` sends one prompt to all sessions | No | Yes, by isolation | No | No | Yes **(unverified)** | No (CLI) | Yes; `checkpoint` rebases into your branch |
| [Neohive](https://github.com/fakiho/neohive) | No: messages and tasks between running agents; does not launch them | Yes: knowledge base + per-agent storage | Partial: locks its own data files; file-edit protection not documented | No | No | Yes | Yes (localhost web UI) | No |
| [mcp-agents](https://github.com/thomaswitt/mcp-agents) | Yes: Claude Code ↔ Codex both ways, plus Antigravity | No | No (not documented) | Partial: Codex sandbox modes | No | Yes | No | No |
| [all-agents-mcp](https://github.com/Dokkabei97/all-agents-mcp) (archived) | Yes: routes to Claude Code, Codex, Gemini, Copilot CLIs | Partial: session history resources | No | No | No | Yes | No | No |

## The tools

**MCP Agent Mail.** "Gmail for your coding agents." Agents from different vendors (Claude Code, Codex, Gemini CLI, Factory Droid and others) register identities, send threaded messages, and take advisory file "leases" with expiry; conflicts are reported, and an optional pre-commit hook can block commits that break another agent's exclusive lease. Messages are stored as Markdown in Git with SQLite FTS5 search, and there is a human web UI. This is the closest match to ShareLane's claims and shared-history ideas, and it is more mature at agent-to-agent messaging. It does not launch agents, run them in worktrees, or manage quota.

**PAL MCP (formerly Zen MCP).** An MCP server that lets one agent consult many models (Gemini, OpenAI, Grok, OpenRouter, Ollama and others) for reviews, debugging, and consensus. Its `clink` tool spawns other agent CLIs (Claude, Codex, Gemini) in a fresh context, using their own logins, with role presets such as planner or code reviewer. That is cross-vendor delegation, but driven from the host agent; there is no shared project memory store, worktree isolation, or collision protection in the docs. Most of PAL's other tools need provider API keys.

**Claude Code subagents and agent teams.** Built into Claude Code. Subagents run in their own context with their own tool allowlist and can use `isolation: worktree`. Agent teams (experimental, off by default) add a lead plus teammates that share a task list and message each other directly; task claiming uses file locks. This is native, polished, and peer-to-peer in a way ShareLane is not, but it is Claude only, so it cannot hand work to Codex or Antigravity, and it has no quota-aware handoff.

**claude-squad.** A terminal app that runs several agents (Claude Code, Codex, Gemini, Aider) in separate tmux sessions and Git worktrees, each on its own branch. Simple and effective for parallel work you supervise. Agents do not talk to each other or share memory. Needs tmux; Windows is not mentioned. AGPL-3.0.

**Conductor.** A Mac app (Apple Silicon, per third-party sources) for running Claude Code, Codex, Cursor and OpenCode in parallel, each task with "its own workspace, branch, files, terminal, diff, and review path." Strong review and merge UI. No agent-to-agent delegation is documented. Not open source as far as we could tell **(unverified)**.

**Vibe Kanban.** A kanban board for planning work and running 10+ coding agents in isolated workspaces, with PR creation and inline diff review. Its MCP server exposes `create_issue` and `start_workspace`, so an agent can file a task and start another agent (for example Claude Code or Gemini) on it. That is a real form of cross-vendor delegation. The repository announces that the project is sunsetting. Apache-2.0.

**Crystal.** A desktop app that ran Codex and Claude Code sessions in parallel Git worktrees. Deprecated in February 2026 in favour of Nimbalyst. MIT.

**uzi.** A Go CLI that starts several agents (Claude, Codex, Aider, Cursor) in worktrees and tmux, can broadcast one message to all of them, and `checkpoint` commits an agent's work and rebases it into your current branch. MIT.

**Neohive.** An MCP "collaboration layer" for agents already running in different terminals and IDEs (Claude Code, Gemini CLI, Codex, Antigravity, Cursor, Copilot and others): messaging, a shared task list with dependencies, a knowledge base for decisions, and a local web dashboard with a kanban view. No API keys. It does not launch agents. Business Source License 1.1 (converts to Apache 2.0 in 2028). Overlaps strongly with ShareLane's shared memory and dashboard.

**mcp-agents.** Wraps the Claude Code and Codex CLIs (and Antigravity) as MCP servers so "Claude Code calls Codex. Use Claude Code from Codex. One MCP bridge, either direction," using the CLIs' own logins, with durable threads and background jobs. This overlaps directly with ShareLane's two-way delegation. It does not provide shared project memory, claims, worktrees or quota handoff. MIT.

**all-agents-mcp.** An MCP server that called Claude Code, Codex, Gemini CLI and Copilot CLI as child processes with their own logins, with routing, comparison and a guard against recursive calls. Archived in March 2026.

Also relevant: OpenAI removed the `codex mcp-server` command in favour of its Codex app server, so "call Codex as an MCP tool" bridges now need to use that or run `codex exec` the way ShareLane does.

## How ShareLane differs, and where others are stronger

**What ShareLane combines that we did not find in one place:**

- Any of the three agents can start any other, in the background, with a task ID, status, wait, reply (same session) and cancel, plus depth and loop limits. mcp-agents, PAL `clink`, all-agents-mcp and Vibe Kanban's MCP server each cover part of this.
- Workers run in their own Git worktree and hand back a branch for review. Nothing is merged for you.
- Collision protection in layers: expiring claims that refuse overlaps, a pre-edit hook in Claude Code and Antigravity, and Git detection for everything else. Agent Mail has leases plus a pre-commit guard; the worktree tools rely on isolation alone.
- Per-delegation path scopes (for example only `src/ui/**`), enforced with each CLI's own controls where they exist, then by a hook, then by keeping out-of-scope changes off the branch as a separate patch.
- Allowance checks before each run, a 7% hand-off threshold, and automatic save-first handoff to another vendor's agent when one runs out. We did not find this anywhere else.
- A curated, size-capped project map with chunks that go stale when their files change, rather than a message archive.

**Where others are stronger:**

- **Agent-to-agent conversation.** MCP Agent Mail, Neohive and Claude agent teams have real messaging between peers. ShareLane only has task replies and progress notes.
- **Breadth of agents and models.** Vibe Kanban, Conductor and Neohive support many more agent CLIs; PAL reaches many model providers. ShareLane ships three adapters (more are a config entry, but untested).
- **UI and review flow.** Conductor and Vibe Kanban have mature diff review and PR creation. ShareLane's dashboard is read-only, and review happens in Git.
- **Maturity.** Several of these tools have far more users. ShareLane is new and has mostly been tested on Windows.
- **Native integration.** Claude Code's subagents and teams need no extra install and are supported by Anthropic.

If you only need parallel agents in separate branches, claude-squad, Conductor or uzi are simpler. If you need agents to chat with each other, look at MCP Agent Mail. ShareLane is for when you want different vendors' agents to share one project memory, hand work to each other safely, and keep going when one runs out of allowance.

## Sources

- MCP Agent Mail: https://github.com/Dicklesworthstone/mcp_agent_mail
- PAL MCP Server (formerly Zen MCP): https://github.com/BeehiveInnovations/pal-mcp-server and the clink tool doc https://github.com/BeehiveInnovations/pal-mcp-server/blob/main/docs/tools/clink.md
- Claude Code subagents: https://code.claude.com/docs/en/sub-agents
- Claude Code agent teams: https://code.claude.com/docs/en/agent-teams
- claude-squad: https://github.com/smtg-ai/claude-squad
- Conductor: https://www.conductor.build/ and https://www.conductor.build/docs/
- Conductor platform and subscription details (third-party, unverified): https://codepick.dev/en/guides/conductor-build-intro/ and https://korben.info/en/conductor-run-ai-agents-parallel-codebase.html
- Vibe Kanban: https://github.com/BloopAI/vibe-kanban and MCP server docs https://vibekanban.com/docs/integrations/vibe-kanban-mcp-server.md
- Crystal: https://github.com/stravu/crystal
- uzi: https://github.com/devflowinc/uzi
- Neohive: https://github.com/fakiho/neohive
- mcp-agents: https://github.com/thomaswitt/mcp-agents
- all-agents-mcp: https://github.com/Dokkabei97/all-agents-mcp
- Codex MCP server removal: https://learn.chatgpt.com/docs/mcp-server
