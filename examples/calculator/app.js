(function () {
  "use strict";

  const display = document.querySelector("[data-display]");
  const message = document.querySelector("[data-message]");
  const keypad = document.querySelector("[data-keypad]");
  let state = Calculator.createState();

  function render() {
    display.value = state.display;
    display.classList.toggle("display__value--error", Boolean(state.error));
    message.textContent = state.error || "Ready";
    message.classList.toggle("display__message--error", Boolean(state.error));
  }

  function dispatch(action) {
    state = Calculator.transition(state, action);
    render();
  }

  function actionFromButton(button) {
    if (button.dataset.digit) {
      return { type: "digit", value: button.dataset.digit };
    }

    if (button.dataset.operator) {
      return { type: "operator", value: button.dataset.operator };
    }

    return { type: button.dataset.action };
  }

  function actionFromKey(key) {
    if (/^\d$/.test(key)) return { type: "digit", value: key };
    if (key === ".") return { type: "decimal" };
    if (["+", "-", "*", "/"].includes(key)) {
      return { type: "operator", value: key };
    }
    if (key === "Enter" || key === "=") return { type: "evaluate" };
    if (key === "Escape") return { type: "clear" };
    if (key === "Backspace") return { type: "delete" };
    return null;
  }

  keypad.addEventListener("click", function (event) {
    const button = event.target.closest("button");
    if (button) dispatch(actionFromButton(button));
  });

  document.addEventListener("keydown", function (event) {
    const action = actionFromKey(event.key);
    if (!action) return;

    event.preventDefault();
    dispatch(action);
  });

  render();
})();
