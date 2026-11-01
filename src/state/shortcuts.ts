/**
 * Global keyboard shortcuts. `shortcutFor` is the pure decision; the hook
 * wires it to the window once.
 *
 *   Space        play / pause          (not while typing or on a button)
 *   ← / →        seek −5 s / +5 s      (not on sliders or while typing)
 *   L            audition loop on/off
 *   Ctrl+Enter   send the composer (简单模式: only to change a piece)
 *   Ctrl+N       新建创作
 *   Ctrl+E       导出 (简单模式: 下载音乐, the whole piece at once)
 *   Esc          close the open modal
 */
import { useEffect, useRef } from "react";
import { downloadRequest } from "./scenes";
import type { AppContextValue } from "./types";

export type Shortcut =
  | "toggle-play"
  | "seek-back"
  | "seek-forward"
  | "toggle-loop"
  | "send"
  | "new-piece"
  | "export"
  | "close";

/** What has focus: text = something you type in. */
export type FocusKind = "text" | "range" | "button" | "other";

export interface KeyInput {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  /** an input method is composing (never steal its keys) */
  composing?: boolean;
  focus: FocusKind;
  modalOpen: boolean;
}

export const SEEK_STEP_SECONDS = 5;

export function shortcutFor(input: KeyInput): Shortcut | null {
  if (input.composing) return null;
  const command = !!(input.ctrlKey || input.metaKey);
  const plain = !command && !input.altKey && !input.shiftKey;
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  if (key === "Escape") return input.modalOpen && plain ? "close" : null;
  // A modal owns the keyboard while it is open.
  if (input.modalOpen) return null;
  if (command && !input.altKey && !input.shiftKey) {
    if (key === "Enter") return "send";
    if (key === "n") return "new-piece";
    if (key === "e") return "export";
    return null;
  }
  if (!plain || input.focus === "text") return null;
  switch (key) {
    case " ":
    case "Spacebar":
      // Space already activates a focused button: do not act twice.
      return input.focus === "button" ? null : "toggle-play";
    case "ArrowLeft":
      return input.focus === "range" ? null : "seek-back";
    case "ArrowRight":
      return input.focus === "range" ? null : "seek-forward";
    case "l":
      return "toggle-loop";
    default:
      return null;
  }
}

/** Classify the element a key event was aimed at. */
export function focusKind(target: unknown): FocusKind {
  if (typeof Element === "undefined" || !(target instanceof Element))
    return "other";
  const element = target as HTMLElement;
  if (element.isContentEditable) return "text";
  const tag = element.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return "text";
  if (tag === "INPUT") {
    const type = (element as HTMLInputElement).type;
    if (type === "range") return "range";
    return ["button", "checkbox", "radio", "submit", "reset", "file"].includes(
      type,
    )
      ? "button"
      : "text";
  }
  if (
    tag === "BUTTON" ||
    tag === "A" ||
    tag === "SUMMARY" ||
    element.getAttribute("role") === "button" ||
    element.getAttribute("role") === "slider"
  )
    return element.getAttribute("role") === "slider" ? "range" : "button";
  return "other";
}

/** Install the shortcuts for the life of the calling component. */
export function useShortcuts(app: AppContextValue): void {
  const latest = useRef(app);
  useEffect(() => {
    latest.current = app;
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const { ui, studio, player, actions } = latest.current;
      const shortcut = shortcutFor({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        composing: event.isComposing || event.keyCode === 229,
        focus: focusKind(event.target),
        // A question from the core owns the keyboard like any modal.
        modalOpen: ui.modal !== null || ui.dialog !== null,
      });
      if (!shortcut) return;
      switch (shortcut) {
        case "close":
          // Escape answers a question with its cancel choice.
          if (ui.dialog) actions.answerDialog(ui.dialog.id, ui.dialog.cancel);
          else actions.closeModal();
          break;
        case "toggle-play":
          if (!player.ready) return;
          player.toggle();
          break;
        case "seek-back":
        case "seek-forward":
          if (!player.ready) return;
          player.seek(
            player.getTime() +
              (shortcut === "seek-back"
                ? -SEEK_STEP_SECONDS
                : SEEK_STEP_SECONDS),
          );
          break;
        case "toggle-loop":
          if (!player.ready) return;
          actions.setLoopAudition(!player.loop);
          break;
        case "send":
          // 简单模式's scene page starts a piece with its own button (and
          // Enter in its one box): a description there is never sent with
          // choices the page does not show.
          if (ui.mode === "simple" && !studio.project) return;
          void actions.send();
          break;
        case "new-piece":
          actions.newPiece();
          break;
        case "export":
          if (!studio.project) return;
          if (ui.mode === "simple")
            void actions.exportWork(downloadRequest(studio.project));
          else actions.openModal("export");
          break;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
