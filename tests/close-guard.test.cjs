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

/* -------------------------------------------------------------------- FQ-01 */
// The guard only knew what the page told it. After the page forgot a paid result (its notice
// was closed) the main process still held the music, and the window closed without a question.

function holding(initial) {
  const state = { pending: initial, generating: false, asked: [], left: 0 };
  const answers = [];
  const guard = createCloseGuard({
    isGenerating: () => state.generating,
    pendingResult: () => state.pending,
    ask: async (reason) => {
      state.asked.push(reason);
      return answers.length ? answers.shift() : false;
    },
  });
  return {
    state,
    guard,
    answers,
    leave: () => {
      state.left++;
    },
  };
}

test("FQ-01: a result the main process still holds is asked about, whatever the page has reported", async () => {
  for (const [held, reason] of [
    ["download", "undelivered"],
    ["task", "uncollected"],
  ]) {
    const { state, guard, answers, leave } = holding(held);
    assert.equal(guard.reason(), reason);
    // The page says nothing is at stake (or never said anything): the guard asks all the same.
    for (const flag of [undefined, false, true, false]) {
      if (flag !== undefined) guard.setUnsavedWork(flag);
      const event = closeEvent();
      assert.equal(guard.allow(event, leave), false, `${held} / ${flag}`);
      assert.equal(event.prevented, 1);
      await settle();
    }
    assert.deepEqual(state.asked, [reason, reason, reason, reason]);
    assert.equal(state.left, 0, '"返回应用" every time');
    // A page that loads afresh clears its own flag, not what the main process holds.
    guard.reset();
    assert.equal(guard.reason(), reason);
    // "仍然关闭" leaves, once.
    answers.push(true);
    guard.allow(closeEvent(), leave);
    await settle();
    assert.equal(state.left, 1);
    assert.equal(guard.allow(closeEvent(), leave), true);
    assert.equal(state.asked.length, 5);
  }
});

test("FQ-01: the held result is the reason while it is being collected, and no reason once it is gone", async () => {
  const { state, guard, leave } = holding("download");
  // 重新下载 is running: what would be lost is music that already exists, not "a generation".
  state.generating = true;
  assert.equal(guard.reason(), "undelivered");
  state.pending = "task";
  assert.equal(guard.reason(), "uncollected");
  // Collected or given up, the job over: closing is free again, without a question.
  state.pending = null;
  assert.equal(guard.reason(), "generating");
  state.generating = false;
  assert.equal(guard.reason(), null);
  const event = closeEvent();
  assert.equal(guard.allow(event, leave), true);
  assert.equal(event.prevented, 0);
  assert.deepEqual(state.asked, []);
  // The page's own flag still works as before, below both.
  guard.setUnsavedWork(true);
  assert.equal(guard.reason(), "unsaved");
  state.pending = "download";
  assert.equal(guard.reason(), "undelivered");
  // Anything but the two known kinds is not a held result.
  for (const odd of [undefined, "", "other", "toString", "__proto__", 1, {}]) {
    state.pending = odd;
    assert.equal(guard.reason(), "unsaved", String(odd));
  }
  guard.setUnsavedWork(false);
  assert.equal(guard.reason(), null);
});

test("FQ-01: the two questions say that the music is paid for, will be lost, and how to get it", () => {
  const undelivered = closePromptOptions("undelivered");
  assert.equal(undelivered.message, "有一首已经生成的音乐还没有取回");
  assert.match(undelivered.detail, /已经生成了这首音乐并计费/);
  assert.match(undelivered.detail, /再也取不回/);
  assert.match(undelivered.detail, /重新生成需要再次付费/);
  assert.match(undelivered.detail, /「重新下载」/);
  const uncollected = closePromptOptions("uncollected");
  assert.equal(uncollected.message, "有一个已经提交的生成任务还没有取回");
  assert.match(uncollected.detail, /已经提交给服务商/);
  assert.match(uncollected.detail, /可能已经生成并计费/);
  assert.match(uncollected.detail, /再也取不回/);
  assert.match(uncollected.detail, /「重新下载」/);
  for (const options of [undelivered, uncollected]) {
    assert.deepEqual(options.buttons, ["返回应用", "仍然关闭"]);
    assert.equal(options.defaultId, STAY);
    assert.equal(options.cancelId, STAY);
    assert.equal(options.type, "warning");
  }
  assert.deepEqual(Object.keys(CLOSE_PROMPTS).sort(), [
    "generating",
    "uncollected",
    "undelivered",
    "unsaved",
  ]);
  for (const inherited of ["toString", "constructor", "__proto__"])
    assert.throws(() => closePromptOptions(inherited), TypeError, inherited);
  assert.throws(
    () =>
      createCloseGuard({
        isGenerating: () => false,
        pendingResult: "download",
        ask: async () => false,
      }),
    TypeError,
  );
  // Without the option the guard is the one it was.
  const plain = createCloseGuard({
    isGenerating: () => false,
    ask: async () => false,
  });
  assert.equal(plain.reason(), null);
});
