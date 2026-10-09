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

/**
 * Where the bubble goes: centred on its anchor, on the preferred side, kept
 * inside the viewport. It moves to the other side only when the preferred
 * one has no room.
 */
export function tipPlacement(
  anchor: Box,
  bubble: { width: number; height: number },
  viewport: { width: number; height: number },
  side: "top" | "bottom" = "top",
): { left: number; top: number } {
  const above = anchor.top - bubble.height - MARGIN;
  const below = anchor.bottom + MARGIN;
  const fitsAbove = above >= EDGE;
  const fitsBelow = below + bubble.height <= viewport.height - EDGE;
  const top =
    side === "bottom"
      ? fitsBelow || !fitsAbove
        ? below
        : above
      : fitsAbove
        ? above
        : below;
  const centre = anchor.left + anchor.width / 2 - bubble.width / 2;
  const left = Math.max(
    EDGE,
    Math.min(viewport.width - bubble.width - EDGE, centre),
  );
  return { left: Math.round(left), top: Math.round(top) };
}
