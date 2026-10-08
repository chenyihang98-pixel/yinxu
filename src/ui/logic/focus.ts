/** Focus helpers for dialogs and composite widgets. */

export const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** Elements inside `container` that Tab can reach right now. */
export function focusables(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (node) =>
      !node.hidden &&
      !node.closest("[hidden],[inert]") &&
      node.getClientRects().length > 0,
  );
}

/**
 * Where Tab should go inside a trap, or null to let the browser move focus.
 * An `active` that is not in the list (focus on the dialog itself) wraps too.
 */
export function trapTarget<T>(
  items: readonly T[],
  active: T | null,
  backwards: boolean,
): T | null {
  if (!items.length) return null;
  const index = active === null ? -1 : items.indexOf(active);
  if (index === -1) return backwards ? items[items.length - 1] : items[0];
  if (backwards && index === 0) return items[items.length - 1];
  if (!backwards && index === items.length - 1) return items[0];
  return null;
}

/** Next index for arrow-key navigation in a tab list or radio group. */
export function rovingIndex(
  key: string,
  current: number,
  count: number,
): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
