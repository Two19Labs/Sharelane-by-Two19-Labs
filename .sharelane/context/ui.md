---
title: User interface
read-when: Changing screens, interactions, dashboard behavior, visual design, or examples/calculator.
covers-files: ["examples/calculator/**"]
updated-at: 2026-09-27T04:17:25.488Z
source-hash: 4eb446df3fcbca3238e9e4e6e23c33f1d23c4f9de6b44ff90aaa0cf12e596510
---

# User interface

ShareLane itself does not have a graphical interface yet; the local web dashboard is planned for Phase 6, with a VS Code extension and animated office view in later phases.

## Calculator learning example

`examples/calculator/` is a self-contained plain HTML/CSS/JavaScript example created by the real Claude-to-Codex delegation demonstration. It opens directly from `index.html` without a server or build step. `calculator.js` holds the pure immutable state transitions and a UMD/CommonJS export, while `app.js` maps accessible button clicks and supported keyboard input to actions. The responsive interface exposes labeled buttons, live display updates, visible hover/focus states, and a clear division-by-zero error. Run its dependency-free tests from that folder with `node --test`.

### Review status

`examples/calculator/CLAUDE_REVIEW.md` holds a review of the finished example against its README (2026-09-27, Claude). Verdict: accept — every stated requirement is implemented and the README is accurate. Eight low-severity findings are open, none of which break a requirement. The three worth knowing before touching `app.js`:

- the global `keydown` handler calls `preventDefault()` on `Enter`, which suppresses the focused button's own activation, so `Enter` always means `=` even when another key has focus;
- the handler ignores `ctrlKey`/`metaKey`/`altKey`, so browser zoom chords (`Ctrl`+`+`/`-`/`0`) are swallowed and also dispatch calculator actions; and
- arithmetic overflow can still display `Infinity`, even though divide-by-zero is guarded.

`app.js` has no automated coverage — the key-to-action mapping is only exercised manually, because neither `actionFromKey` nor `actionFromButton` is exported. That is the one requirement with no test evidence.

Note for future agents in this workspace: running the example's tests needs `node --test`, which some sessions' permission gates deny even when `node --version` is allowed. The review's pass claim for the current engine came from a hand-trace of all seven tests, not from an executed run.
