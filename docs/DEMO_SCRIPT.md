# ShareLane demo: screen-recording script

Target length: 2–3 minutes. One take per scene is fine; cut between them.

## Before recording

**Machine**

- Node 24+, Git, ShareLane installed (`npm link` until it is on npm).
- Claude Code plus at least one of Codex and Antigravity, installed and logged in. Check with `claude --version`, `codex --version`, `agy --version`.
- Antigravity: the global allow rule `mcp(sharelane/*)` is in place.
- Codex has allowance left (check `codex` `/status`), or use Antigravity as the worker.
- Close other ShareLane dashboards so port 4317 is free.

**Sample project**

- A small Git repo with a `src/ui/` folder, a `README.md`, and a `package.json` with a `test` script. `examples/calculator/` from this repo, copied into a new folder with `git init` and a first commit, works well.
- Do **not** run `init` yet; scene 1 shows it.

**Screen**

- Terminal font at 18pt or larger, one dark theme for everything.
- Layout: terminal or VS Code on the left, browser (dashboard) on the right.
- Hide your status line or notifications if they show personal details.

**Staging the handoff (scene 5)**

A real out-of-allowance moment is hard to time, so stage it. Pick one:

- **Simplest:** in the delegated task's prompt, tell the worker to reply starting with `HANDOFF:` after its first step. ShareLane treats that like running out.
- **More realistic:** record when Codex is genuinely out (its quota reader reports the weekly window at 0%). ShareLane stops it at the pre-run check.

Say on screen that it is staged if you use the first option.

**Dry run** the whole script once, then delete the test branches (`git branch -D sharelane/task-…`) and `.sharelane/` before the real take.

## Shot list

| # | Time | What you type / do | What you say | What viewers see |
|---|---|---|---|---|
| 0 | 0:00–0:12 | Title card or the README header | "I use Claude, Codex and Antigravity. They don't share notes, they step on each other's files, and they run out of allowance mid-task. ShareLane fixes that. Everything is local and uses my own subscriptions." | Project name and one-line pitch |
| 1 | 0:12–0:35 | In the sample project: `npx sharelane init` | "One command. It finds the agents I have installed and connects each one. Codex needs one extra command, which it prints for me." | `init` output listing Claude, Codex and Antigravity, the `codex mcp add …` line, and the created `.sharelane/` folder |
| 1b | 0:35–0:40 | Run the printed `codex mcp add …` (or re-run `init --yes`) | (no voice, or "done") | Success line |
| 2 | 0:40–0:50 | `npx sharelane dashboard --open` | "This is the live dashboard. It's local and read-only." | Browser opens `localhost:4317`: empty task table, agent cards with allowance meters |
| 3 | 0:50–1:20 | Start `claude` in the project and type: *"Use ShareLane to delegate to Codex: build a dark-mode toggle in src/ui. Scope it to src/ui/\*\* with a 200k token budget."* | "I stay in Claude and ask it to hand a job to Codex, limited to the UI folder, with a token budget." | Claude calls `delegate`; reply shows the task ID, `Scope: src/ui/**` |
| 3b | 1:20–1:35 | Switch to the browser, click the task | "Codex is running in the background on its own branch. Here's its output, live, and its claim on src/ui." | Task row **Running**, scope claim with countdown, budget meter, live output scrolling |
| 4 | 1:35–1:55 | Back in Claude: *"Now delegate to Antigravity: restyle the buttons in src/ui."* | "If I accidentally send a second agent into the same folder…" | ShareLane refuses: the scope overlaps Codex's claim, naming who holds it and why. The dashboard shows no second task |
| 5 | 1:55–2:20 | Show a task (staged or real) hitting the allowance check | "Codex is out of allowance. ShareLane saves its work to the branch, writes a handoff note, and Antigravity picks it up on the same branch." | Dashboard: task moves to the new agent; agent path `codex → antigravity`; handoff note visible in the detail panel; Codex meter at or below the 7% marker |
| 6 | 2:20–2:45 | In the terminal: `git branch --list "sharelane/*"`, then `git diff main...sharelane/task-<id> --stat` | "Nothing touched my main branch. The work is on a task branch for me to review. I merge it only if I like it." | Task branch listed; diff shows only `src/ui/...` files |
| 7 | 2:45–2:55 | Show the README / repo URL | "ShareLane is open source under MIT. Link below." | Repo URL, install line (marked "coming soon to npm" if not published yet) |

## Lines to avoid

- Do not say it works with "any agent". Say Claude Code, Codex and Antigravity today, with others possible through config.
- Do not imply that the handoff in scene 5 was spontaneous if it was staged.
- Do not show API keys, sign-in tokens, `~/.codex`, `~/.claude` or Antigravity settings files on screen.

## Optional extras (if time allows)

- `run_check`: ask the Antigravity worker to run the tests. It calls `run_check` and ShareLane runs `npm test` for it. "It never got a terminal; it can only run the checks I approved in `.sharelane/checks.json`."
- Context map: show `.sharelane/context/MAP.md` and the stale flag on the dashboard after editing a file a chunk covers.
