# Calculator learning example

A small calculator built with plain HTML, CSS, and JavaScript. It has no framework,
build step, runtime dependency, or browser test dependency.

## Open it

Open `index.html` directly in a browser. The example uses ordinary scripts rather
than browser modules, so it also works from a local `file://` address without a
development server.

You can click the buttons or use the keyboard:

- digits and `.` enter numbers;
- `+`, `-`, `*`, and `/` choose an operation;
- `Enter` or `=` calculates the result;
- `Backspace` deletes the last digit; and
- `Escape` clears everything.

## How it works

`calculator.js` is the calculation engine. Its state stores the displayed value,
the saved left operand, the pending operator, whether the next number should
replace the display, and an optional error message. `transition(state, action)`
returns a new state without touching the page or changing the old state.

`app.js` is the browser adapter. Button clicks and keyboard events become actions
such as `{ type: "digit", value: "7" }`, `{ type: "operator", value: "+" }`,
or `{ type: "evaluate" }`. The resulting state is then rendered into the live
display. This split keeps DOM wiring small and makes all calculation behavior
testable in Node.

Operations are evaluated from left to right as they are chained, like a basic
handheld calculator. Dividing by zero produces a visible error instead of
`Infinity` or `NaN`; typing the next digit starts a fresh calculation.

## Run the tests

From this folder, run:

```sh
node --test
```

The tests use only Node's built-in `node:test` and `node:assert` modules. They
cover all four operations, decimals, chained operations, clear, delete, and
division-by-zero recovery.
