---
title: User interface
read-when: Changing screens, interactions, dashboard behavior, visual design, or examples/calculator.
covers-files: ["examples/calculator/**"]
updated-at: 2026-09-27T03:59:08.949Z
source-hash: 8a7747c661fefeefbde70daf0a5781e3db38e477c5bd4f6a1c0aed1dfaf885e6
---

# User interface

ShareLane itself does not have a graphical interface yet; the local web dashboard is planned for Phase 6, with a VS Code extension and animated office view in later phases.

## Calculator learning example

`examples/calculator/` is a self-contained plain HTML/CSS/JavaScript example created by the real Claude-to-Codex delegation demonstration. It opens directly from `index.html` without a server or build step. `calculator.js` holds the pure immutable state transitions and a UMD/CommonJS export, while `app.js` maps accessible button clicks and supported keyboard input to actions. The responsive interface exposes labeled buttons, live display updates, visible hover/focus states, and a clear division-by-zero error. Run its dependency-free tests from that folder with `node --test`.
