const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const { createState, transition } = require("./calculator.js");

function enter(state, text) {
  return [...text].reduce(
    (current, character) =>
      transition(
        current,
        character === "."
          ? { type: "decimal" }
          : { type: "digit", value: character },
      ),
    state,
  );
}

function solve(left, operator, right) {
  let state = enter(createState(), left);
  state = transition(state, { type: "operator", value: operator });
  state = enter(state, right);
  return transition(state, { type: "evaluate" });
}

test("performs addition, subtraction, multiplication, and division", () => {
  assert.equal(solve("8", "+", "5").display, "13");
  assert.equal(solve("8", "-", "13").display, "-5");
  assert.equal(solve("7", "*", "6").display, "42");
  assert.equal(solve("21", "/", "3").display, "7");
});

test("accepts decimal input and avoids common floating-point display noise", () => {
  assert.equal(solve("1.5", "+", "2.25").display, "3.75");
  assert.equal(solve("0.1", "+", "0.2").display, "0.3");
});

test("chains operations from left to right", () => {
  let state = enter(createState(), "2");
  state = transition(state, { type: "operator", value: "+" });
  state = enter(state, "3");
  state = transition(state, { type: "operator", value: "*" });
  state = enter(state, "4");
  state = transition(state, { type: "evaluate" });

  assert.equal(state.display, "20");
});

test("clear restores the initial state", () => {
  const changed = enter(createState(), "928");
  assert.deepEqual(transition(changed, { type: "clear" }), createState());
});

test("delete removes the last entered digit", () => {
  let state = enter(createState(), "123");
  state = transition(state, { type: "delete" });
  assert.equal(state.display, "12");

  state = transition(state, { type: "delete" });
  state = transition(state, { type: "delete" });
  assert.equal(state.display, "0");
});

test("division by zero reports an error and the next number starts fresh", () => {
  let state = solve("9", "/", "0");
  assert.equal(state.display, "Error");
  assert.equal(state.error, "Cannot divide by zero.");

  state = transition(state, { type: "digit", value: "4" });
  assert.equal(state.display, "4");
  assert.equal(state.error, null);
});

test("exposes the same logic as a browser global", () => {
  const source = readFileSync(`${__dirname}/calculator.js`, "utf8");
  const browserContext = {};

  vm.runInNewContext(source, browserContext);

  assert.equal(typeof browserContext.Calculator.createState, "function");
  assert.equal(typeof browserContext.Calculator.transition, "function");
});
