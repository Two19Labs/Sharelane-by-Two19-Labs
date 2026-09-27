(function (root, factory) {
  const calculator = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = calculator;
  } else {
    root.Calculator = calculator;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function createState() {
    return {
      display: "0",
      leftOperand: null,
      operator: null,
      replaceDisplay: false,
      error: null,
    };
  }

  function inputDigit(state, digit) {
    if (!/^\d$/.test(digit)) {
      return state;
    }

    const current = state.error ? createState() : state;
    const display =
      current.replaceDisplay || current.display === "0"
        ? digit
        : current.display + digit;

    return { ...current, display, replaceDisplay: false };
  }

  function inputDecimal(state) {
    const current = state.error ? createState() : state;

    if (current.replaceDisplay) {
      return { ...current, display: "0.", replaceDisplay: false };
    }

    if (current.display.includes(".")) {
      return current;
    }

    return { ...current, display: current.display + "." };
  }

  function calculate(left, right, operator) {
    if (operator === "/" && right === 0) {
      return { error: "Cannot divide by zero." };
    }

    const operations = {
      "+": () => left + right,
      "-": () => left - right,
      "*": () => left * right,
      "/": () => left / right,
    };

    if (!operations[operator]) {
      return { error: "Unknown operation." };
    }

    const result = operations[operator]();
    const rounded = Number.parseFloat(result.toPrecision(12));
    return { value: rounded };
  }

  function errorState(message) {
    return {
      ...createState(),
      display: "Error",
      replaceDisplay: true,
      error: message,
    };
  }

  function applyPendingOperation(state) {
    const result = calculate(
      state.leftOperand,
      Number(state.display),
      state.operator,
    );

    if (result.error) {
      return errorState(result.error);
    }

    return {
      ...state,
      display: String(result.value),
      leftOperand: result.value,
      error: null,
    };
  }

  function chooseOperator(state, operator) {
    if (!["+", "-", "*", "/"].includes(operator)) {
      return state;
    }

    const current = state.error ? createState() : state;

    if (current.operator && current.replaceDisplay) {
      return { ...current, operator };
    }

    const next = current.operator ? applyPendingOperation(current) : current;
    if (next.error) {
      return next;
    }

    return {
      ...next,
      leftOperand: Number(next.display),
      operator,
      replaceDisplay: true,
    };
  }

  function evaluate(state) {
    if (state.error) {
      return createState();
    }

    if (!state.operator || state.replaceDisplay) {
      return state;
    }

    const next = applyPendingOperation(state);
    if (next.error) {
      return next;
    }

    return {
      ...next,
      leftOperand: next.leftOperand,
      operator: null,
      replaceDisplay: true,
    };
  }

  function deleteDigit(state) {
    if (state.error) {
      return createState();
    }

    if (state.replaceDisplay) {
      return state;
    }

    const display = state.display.length > 1 ? state.display.slice(0, -1) : "0";
    return { ...state, display };
  }

  function transition(state, action) {
    switch (action.type) {
      case "digit":
        return inputDigit(state, action.value);
      case "decimal":
        return inputDecimal(state);
      case "operator":
        return chooseOperator(state, action.value);
      case "evaluate":
        return evaluate(state);
      case "delete":
        return deleteDigit(state);
      case "clear":
        return createState();
      default:
        return state;
    }
  }

  return {
    calculate,
    createState,
    transition,
  };
});
