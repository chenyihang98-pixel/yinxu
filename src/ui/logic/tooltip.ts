/** The decisions of the tooltip layer, without the DOM. */

/** A key that moved the focus this recently makes the focus "the user's". */
export const NAVIGATION_WINDOW_MS = 400;

/**
 * Whether an element that just received focus may show its tip: only when
 * the user moved there with the keyboard (Tab, arrows) a moment ago. Focus
 * that code sets — the play button after a job, the previous control when a
 * dialog closes — comes long after any key and shows nothing, even though
 * the browser draws its focus ring.
 */
export function tipFocusAllowed(input: {
  focusVisible: boolean;
  sinceNavigationMs: number;
}): boolean {
  return (
    input.focusVisible &&
    input.sinceNavigationMs >= 0 &&
    input.sinceNavigationMs <= NAVIGATION_WINDOW_MS
  );
}

const MARGIN = 8;
const EDGE = 4;

interface Box {
  left: number;
  top: number;
  bottom: number;
  width: number;
}

export type TipSide = "top" | "bottom" | "left";

/** "left" / "bottom" from a `data-tip-side` attribute; anything else is "top". */
export function tipSide(value: string | undefined): TipSide {
  return value === "bottom" || value === "left" ? value : "top";
}

/**
 * Where the bubble goes: centred on its anchor, on the preferred side, kept
 * inside the viewport. "top" and "bottom" move to the other side only when
 * the preferred one has no room. "left" puts the bubble beside its anchor —
 * for a control with something worth reading right above it — and, where
 * there is no room beside it, below it rather than above.
 */
export function tipPlacement(
  anchor: Box,
  bubble: { width: number; height: number },
  viewport: { width: number; height: number },
  side: TipSide = "top",
): { left: number; top: number } {
  if (side === "left") {
    const beside = anchor.left - bubble.width - MARGIN;
    if (beside >= EDGE) {
      const middle = (anchor.top + anchor.bottom) / 2 - bubble.height / 2;
      const top = Math.max(
        EDGE,
        Math.min(viewport.height - bubble.height - EDGE, middle),
      );
      return { left: Math.round(beside), top: Math.round(top) };
    }
  }
  const above = anchor.top - bubble.height - MARGIN;
  const below = anchor.bottom + MARGIN;
  const fitsAbove = above >= EDGE;
  const fitsBelow = below + bubble.height <= viewport.height - EDGE;
  const top =
    side === "top"
      ? fitsAbove
        ? above
        : below
      : fitsBelow || !fitsAbove
        ? below
        : above;
  const centre = anchor.left + anchor.width / 2 - bubble.width / 2;
  const left = Math.max(
    EDGE,
    Math.min(viewport.width - bubble.width - EDGE, centre),
  );
  return { left: Math.round(left), top: Math.round(top) };
}
