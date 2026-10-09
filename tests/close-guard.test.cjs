"use strict";

// MAIN-05 / RB-03: closing the window or quitting while a paid cloud generation is in flight, or
// while the renderer holds a paid result that is not stored yet, asks first. The decision logic is
// tested here; that the real window stays open is proven under Electron by scripts/desktop-smoke.cjs.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createCloseGuard,
  closePromptOptions,
  CLOSE_PROMPTS,
  STAY,
  LEAVE,
} = require("../electron/close-guard.cjs");

const closeEvent = () => ({
  prevented: 0,
  preventDefault() {
    this.prevented++;
  },
});
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fixture({ generating = false, answers = [] } = {}) {
  const state = { generating, asked: [], proceeded: 0, pending: [] };
  const guard = createCloseGuard({
    isGenerating: () => state.generating,
    ask: (reason) => {
      state.asked.push(reason);
      if (answers.length) return Promise.resolve(answers.shift());
      return new Promise((resolve) => state.pending.push(resolve)); // the dialog stays open until the test answers
    },
  });
  return {
    state,
    guard,
    proceed: () => {
      state.proceeded++;
    },
  };
}

test("nothing at stake: the event goes ahead, nobody is asked", () => {
  const { state, guard, proceed } = fixture();
  const event = closeEvent();
  assert.equal(guard.reason(), null);
  assert.equal(guard.allow(event, proceed), true);
  assert.equal(event.prevented, 0);
  assert.deepEqual(state.asked, []);
  assert.equal(state.proceeded, 0);
});

test('a generation in flight: the close is held and the user is asked; "继续等待" keeps everything running', async () => {
  const { state, guard, proceed } = fixture({ generating: true });
  const event = closeEvent();
  assert.equal(guard.allow(event, proceed), false);
  assert.equal(
    event.prevented,
    1,
    "the window must not close while the question is open",
  );
  await settle();
  assert.deepEqual(state.asked, ["generating"]);
  // Alt+F4 again, the taskbar, app.quit(): still one dialog.
  for (let again = 0; again < 3; again++) {
    const repeat = closeEvent();
    assert.equal(guard.allow(repeat, proceed), false);
    assert.equal(repeat.prevented, 1);
  }
  await settle();
  assert.equal(state.asked.length, 1, "one question at a time");
  state.pending.shift()(false);
  await settle();
  assert.equal(state.proceeded, 0);
  assert.equal(guard.confirmed, false);
  // Still generating: the next attempt asks again.
  assert.equal(guard.allow(closeEvent(), proceed), false);
  await settle();
  assert.equal(state.asked.length, 2);
});

test('"仍然关闭": the close is triggered again and then passes, for the window and for the quit that follows', async () => {
  const { state, guard, proceed } = fixture({
    generating: true,
    answers: [true],
  });
  const first = closeEvent();
  assert.equal(guard.allow(first, proceed), false);
  await settle();
  assert.equal(state.proceeded, 1, "the caller closes the window again");
  assert.equal(guard.confirmed, true);
  for (let step = 0; step < 3; step++) {
    // window "close", then "before-quit", ...
    const event = closeEvent();
    assert.equal(guard.allow(event, proceed), true);
    assert.equal(event.prevented, 0);
  }
  assert.equal(state.asked.length, 1, "never asked twice for one decision");
  assert.equal(state.proceeded, 1);
});

test("only an explicit yes leaves: a dismissed, failed or odd answer keeps the app open", async () => {
  for (const answer of [false, undefined, null, 1, "yes", {}]) {
    const { state, guard, proceed } = fixture({
      generating: true,
      answers: [answer],
    });
    guard.allow(closeEvent(), proceed);
    await settle();
    assert.equal(state.proceeded, 0, String(answer));
    assert.equal(guard.confirmed, false);
  }
  const failing = createCloseGuard({
    isGenerating: () => true,
    ask: async () => {
      throw new Error("dialog could not be shown");
    },
  });
  let proceeded = 0;
  failing.allow(closeEvent(), () => {
    proceeded++;
  });
  await settle();
  assert.equal(proceeded, 0);
  const throwing = createCloseGuard({
    isGenerating: () => true,
    ask: () => {
      throw new Error("sync failure");
    },
  });
  const event = closeEvent();
  assert.equal(
    throwing.allow(event, () => {
      proceeded++;
    }),
    false,
  );
  await settle();
  assert.equal(proceeded, 0);
  assert.equal(event.prevented, 1);
  // ... and the guard can ask again afterwards.
  const again = closeEvent();
  assert.equal(
    throwing.allow(again, () => {}),
    false,
  );
  assert.equal(again.prevented, 1);
});

test("the unsaved-work flag: only the boolean true raises it; it asks with its own wording", async () => {
  const { state, guard, proceed } = fixture({ answers: [false, true] });
  for (const value of ["true", 1, {}, null, undefined, false]) {
    guard.setUnsavedWork(value);
    assert.equal(guard.reason(), null, String(value));
    assert.equal(guard.allow(closeEvent(), proceed), true);
  }
  guard.setUnsavedWork(true);
  assert.equal(guard.reason(), "unsaved");
  const held = closeEvent();
  assert.equal(guard.allow(held, proceed), false);
  assert.equal(held.prevented, 1);
  await settle();
  assert.deepEqual(state.asked, ["unsaved"]);
  assert.equal(state.proceeded, 0);
  // The renderer saved it in the meantime: closing is free again, without a question.
  guard.setUnsavedWork(false);
  assert.equal(guard.allow(closeEvent(), proceed), true);
  assert.equal(state.asked.length, 1);
  // A generation in flight is the more urgent reason when both apply.
  guard.setUnsavedWork(true);
  state.generating = true;
  assert.equal(guard.reason(), "generating");
  guard.allow(closeEvent(), proceed);
  await settle();
  assert.deepEqual(state.asked, ["unsaved", "generating"]);
  assert.equal(state.proceeded, 1);
});

test("reset: a new window starts without the old answer and without the old flag", async () => {
  const { state, guard, proceed } = fixture({
    generating: true,
    answers: [true],
  });
  guard.setUnsavedWork(true);
  guard.allow(closeEvent(), proceed);
  await settle();
  assert.equal(guard.confirmed, true);
  guard.reset();
  assert.equal(guard.confirmed, false);
  state.generating = false;
  assert.equal(
    guard.reason(),
    null,
    "the flag belonged to the page that is gone",
  );
  state.generating = true;
  assert.equal(
    guard.allow(closeEvent(), proceed),
    false,
    "a later close asks again",
  );
});

test("the dialog: Chinese, two buttons, the safe one is the default and what Esc chooses", () => {
  assert.equal(STAY, 0);
  assert.equal(LEAVE, 1);
  const generating = closePromptOptions("generating");
  assert.deepEqual(generating.buttons, ["继续等待", "仍然关闭"]);
  assert.equal(generating.defaultId, STAY);
  assert.equal(
    generating.cancelId,
    STAY,
    "closing the dialog with Esc or its X does not close the app",
  );
  assert.equal(generating.type, "warning");
  assert.equal(generating.noLink, true);
  assert.match(generating.message, /还在生成/);
  assert.match(generating.detail, /计费/, "says the service may still bill");
  assert.match(generating.detail, /无法取回/, "says the result would be lost");
  const unsaved = closePromptOptions("unsaved");
  assert.deepEqual(unsaved.buttons, ["返回应用", "仍然关闭"]);
  assert.equal(unsaved.cancelId, STAY);
  assert.match(unsaved.message, /还没有保存/);
  assert.match(unsaved.detail, /丢失/);
  assert.match(unsaved.detail, /再次付费/);
  for (const prompt of Object.values(CLOSE_PROMPTS)) {
    assert.equal(prompt.buttons[LEAVE], "仍然关闭");
    assert.equal(
      /[A-Za-z]{4,}/.test(
        `${prompt.message}${prompt.detail}${prompt.buttons.join("")}`,
      ),
      false,
      "no English in the dialog",
    );
  }
  // Each call returns its own copy: a caller cannot change the texts for the next one.
  generating.buttons.push("x");
  assert.deepEqual(closePromptOptions("generating").buttons, [
    "继续等待",
    "仍然关闭",
  ]);
  assert.throws(() => closePromptOptions("other"), TypeError);
  assert.throws(() => createCloseGuard({}), TypeError);
});
