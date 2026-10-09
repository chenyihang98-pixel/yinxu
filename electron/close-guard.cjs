"use strict";

/**
 * Asks before the window closes (or the app quits) while that would lose
 * something paid for:
 *   "generating"  a cloud generation is in flight - leaving stops the wait, the
 *                 service may still finish and bill, and the music cannot be fetched;
 *   "unsaved"     the renderer has reported a paid result that only this run of the
 *                 app can still save: held in the page, or waiting to be downloaded.
 * Kept free of Electron so the decision logic can be unit tested; main.cjs
 * supplies `ask(reason)` (a native dialog) and wires the events.
 */
const CLOSE_PROMPTS = Object.freeze({
  generating: Object.freeze({
    message: "云端音乐还在生成",
    detail:
      "现在关闭会停止等待：服务商可能仍会完成这次生成并计费，而这首音乐将无法取回。",
    buttons: Object.freeze(["继续等待", "仍然关闭"]),
  }),
  unsaved: Object.freeze({
    message: "有一首付费生成的音乐还没有保存",
    detail:
      "现在关闭会丢失这首音乐，重新生成需要再次付费。请先回到应用：等它保存完成、导出原始音频，或把还没取回的音乐重新下载下来。",
    buttons: Object.freeze(["返回应用", "仍然关闭"]),
  }),
});
/** Index of the button that keeps the app open; also the answer when the dialog is dismissed. */
const STAY = 0;
const LEAVE = 1;

/** Options for dialog.showMessageBox: the safe choice is the default and what Esc selects. */
function closePromptOptions(reason) {
  const prompt = CLOSE_PROMPTS[reason];
  if (!prompt) throw new TypeError("Unknown close reason");
  return {
    type: "warning",
    title: "音序 Muse",
    message: prompt.message,
    detail: prompt.detail,
    buttons: [...prompt.buttons],
    defaultId: STAY,
    cancelId: STAY,
    noLink: true,
  };
}

function createCloseGuard({ isGenerating, ask }) {
  if (typeof isGenerating !== "function" || typeof ask !== "function")
    throw new TypeError("isGenerating and ask are required");
  let unsaved = false;
  let confirmed = false;
  let asking = false;
  const reason = () =>
    isGenerating() ? "generating" : unsaved ? "unsaved" : null;
  return {
    reason,
    get confirmed() {
      return confirmed;
    },
    /** Only an explicit `true` raises the flag; the renderer clears it with anything else. */
    setUnsavedWork(value) {
      unsaved = value === true;
    },
    /** A new window (or a reloaded page) starts without an earlier answer or flag. */
    reset() {
      unsaved = false;
      confirmed = false;
    },
    /**
     * For a window "close" or an app "before-quit" event. Returns true when the
     * event may go ahead. Otherwise the event is prevented, the user is asked
     * (one question at a time), and `proceed()` runs if they choose to leave -
     * it must trigger the same event again, which then passes.
     */
    allow(event, proceed) {
      if (confirmed) return true;
      const why = reason();
      if (!why) return true;
      event.preventDefault();
      if (asking) return false;
      asking = true;
      Promise.resolve()
        .then(() => ask(why))
        .then(
          (answer) => answer === true,
          () => false,
        )
        .then((leave) => {
          asking = false;
          if (!leave) return;
          confirmed = true;
          proceed();
        });
      return false;
    },
  };
}

module.exports = {
  createCloseGuard,
  closePromptOptions,
  CLOSE_PROMPTS,
  STAY,
  LEAVE,
};
