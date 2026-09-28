# Review — calculator learning example

Reviewer: Claude (ShareLane delegated worker, task-8a385a1d)
Date: 2026-09-27
Scope: `examples/calculator/` against `README.md` and the stated requirements.
No implementation file was modified.

## Verdict

**Accept.** Every requirement in the README is implemented and the implementation
matches what the README claims. The findings below are minor polish items and
edge cases; none of them break a stated requirement.

One caveat on verification: `node --test` could not be executed in this session
(the command is blocked by a permission gate — `node --version` is permitted,
`node --test` is not). The engine was instead verified by hand-tracing all seven
tests through `calculator.js`; all seven assertions hold. See
[Test status](#test-status).

## Requirement-by-requirement evidence

| Requirement | Status | Evidence |
|---|---|---|
| Four arithmetic operations | ✅ | `calculator.js:55-60` operation table; test `calculator.test.js:27` |
| Decimal input | ✅ | `inputDecimal` guards a second `.` (`calculator.js:43`) and turns a pending replace into `"0."` (`calculator.js:40`); `toPrecision(12)` at `calculator.js:67` keeps `0.1 + 0.2` displaying `0.3` |
| Chaining, left to right | ✅ | `chooseOperator` folds the pending operation before storing the new one (`calculator.js:110`); test `calculator.test.js:39` asserts `2 + 3 * 4 = 20` |
| Clear | ✅ | `transition` `"clear"` returns a fresh state (`calculator.js:170`); `AC` button `index.html:30`, `Escape` `app.js:40` |
| Delete | ✅ | `deleteDigit` collapses a 1-char display to `"0"` (`calculator.js:154`); `⌫` button `index.html:31`, `Backspace` `app.js:41` |
| Keyboard controls | ✅ | `actionFromKey` (`app.js:33-43`) covers digits, `.`, `+ - * /`, `Enter`/`=`, `Escape`, `Backspace` — exactly the list in README lines 14–18 |
| Division-by-zero recovery | ✅ | `calculate` returns an error instead of `Infinity` (`calculator.js:51`); `errorState` (`calculator.js:71`) shows `Error`; the next digit/decimal/operator resets from the error (`calculator.js:27`, `37`, `104`) |
| Accessibility | ✅ | Real `<button type="button">` elements, per-key `aria-label`, `<output>` display with `aria-live="polite" aria-atomic="true"` (`index.html:19-26`), `role="group"` keypad with a label (`index.html:29`), visible `:focus-visible` ring (`styles.css:145`) |
| Responsive styling | ✅ | `width: min(100%, 24rem)` and `clamp()` padding/type (`styles.css:46-47`, `70`, `92`), 4-column grid, `@media (max-width: 25rem)` compaction (`styles.css:192`), `prefers-reduced-motion` opt-out (`styles.css:207`) |
| Dependency-free tests | ✅ | `package.json` declares no dependencies; the test file imports only `node:test`, `node:assert/strict`, `node:fs`, `node:vm` (`calculator.test.js:1-5`) |
| No build step / `file://` friendly | ✅ | Classic `<script>` tags, not modules (`index.html:61-62`); the UMD wrapper exports to `module.exports` or `globalThis.Calculator` (`calculator.js:1-9`), asserted by `calculator.test.js:75` |

## Test status

Not executed — `node --test` requires approval in this environment. To run it:

```sh
cd examples/calculator && node --test
```

Hand-trace of each test against the current engine (all pass):

1. `8+5=13`, `8-13=-5`, `7*6=42`, `21/3=7` — pass.
2. `1.5+2.25=3.75`; `0.1+0.2` → `0.30000000000000004` → `toPrecision(12)` → `0.3` — pass.
3. `2 + 3 * 4`: the `*` press folds `2+3=5`, then `5*4=20` — pass.
4. `clear` returns a value deep-equal to `createState()` — pass.
5. `123` → `12` → `1` → `0` (single char collapses to `"0"`, not `""`) — pass.
6. `9/0` → `display "Error"`, `error "Cannot divide by zero."`; then digit `4` → `display "4"`, `error null` — pass.
7. `vm.runInNewContext` has no `module`, so the wrapper assigns `root.Calculator`; both functions are present on the context — pass.

## Findings

All low severity. Listed most-actionable first.

1. **`Enter` on a focused key performs evaluate, not that key** — `app.js:50-56`.
   The document `keydown` handler matches `Enter` and calls `preventDefault()`,
   which suppresses the focused button's default activation. A keyboard user who
   tabs to `AC` and presses `Enter` gets `=` instead of clear. `Space` is
   unaffected (it falls through to `return null`, so the button activates
   normally), so the widget is still fully operable — but the `Enter` behavior is
   inconsistent with native button semantics. Fix: skip the global handler when
   `event.target` is one of the keypad buttons.

2. **Modifier chords are swallowed** — `app.js:51`. The handler ignores
   `ctrlKey` / `metaKey` / `altKey`, so `Ctrl`+`+`, `Ctrl`+`-`, and `Ctrl`+`0`
   (browser zoom) both dispatch a calculator action and have their default
   prevented. Fix: bail out early if any modifier other than `Shift` is held.

3. **Overflow can still display `Infinity`** — `calculator.js:66-68`. README line
   34 says dividing by zero avoids `Infinity`/`NaN`, and it does — but a chained
   multiplication that overflows (`9999999999 * 9999999999 * 9999999999 * …`)
   produces `Infinity`, which `toPrecision(12)` and `String()` pass straight
   through to the display. Consider routing non-finite results through
   `errorState` too, next to the divide-by-zero guard.

4. **No digit cap on entry** — `inputDigit` (`calculator.js:22-34`) appends
   without limit. The display degrades gracefully (`text-overflow: ellipsis`,
   `styles.css:97`) rather than breaking the layout, but the hidden digits are
   still part of the operand. A ~12–16 character cap would match the
   `toPrecision(12)` result precision.

5. **Two `aria-live` regions announce on every keystroke** — `index.html:19-26`.
   The `<output>` and the status `<p>` are both polite live regions, so most
   presses queue two announcements ("4" and "Ready"). Consider making the
   message region live only for errors, or merging the two.

6. **Digit `aria-label`s replace the numeral** — e.g. `aria-label="Seven"` on the
   `7` key (`index.html:35`). This overrides the visible text as the accessible
   name, which can break voice-control users ("click seven" works, "click 7" may
   not) and is redundant for screen readers. The labels on `÷`, `×`, `−`, and `⌫`
   are genuinely useful and should stay; the digits and `=` do not need one.

7. **`app.js` has no test coverage** — keyboard controls are a stated
   requirement, but `actionFromKey` and `actionFromButton` are only exercised
   manually. Both are pure `key → action` mappings and could be tested without a
   DOM if `app.js` exported them (or if the key table moved into
   `calculator.js`). Not a defect, but it is the one requirement with no
   automated evidence.

8. **`npm test` is not wired up** — `package.json` has no `scripts.test`. The
   README correctly says to run `node --test`, so this is consistent, not wrong;
   adding the script would just be a convenience.
