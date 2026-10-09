/**
 * A question that needs a deliberate answer ("发送付费生成请求？") must not be
 * answered by the gesture that opened it: the second click of a double-click
 * lands wherever the pointer is — on the backdrop, or on a button — and a
 * second or held Enter lands on the button that has the focus. So for a
 * moment after it appears the question takes no pointer input and no
 * activation key, and a key that is being held down never answers it.
 * Escape is never held back: it can only mean "no".
 */
export const DIALOG_HOLD_MS = 500;

/** Keys that activate the focused button. */
function activates(key: string): boolean {
  return key === "Enter" || key === " " || key === "Spacebar";
}

/**
 * Whether a key press on the question is ignored. `sinceOpenMs`: how long the
 * question had been on screen when the key went down.
 */
export function keyHeld(input: {
  key: string;
  repeat: boolean;
  sinceOpenMs: number;
  holdMs?: number;
}): boolean {
  if (!activates(input.key)) return false;
  return input.repeat || pointerHeld(input.sinceOpenMs, input.holdMs);
}

/** Whether pointer input is still shut out. */
export function pointerHeld(
  sinceOpenMs: number,
  holdMs: number = DIALOG_HOLD_MS,
): boolean {
  return !(sinceOpenMs >= holdMs);
}
