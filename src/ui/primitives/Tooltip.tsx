/**
 * One tooltip for the whole app. Any element with a `data-tip` attribute
 * gets it on hover (after a short delay) and when the keyboard moves the
 * focus onto it. It is purely visual: the element already carries an
 * accessible name or description.
 *
 * A tip never appears on its own: not when code moves the focus (a finished
 * job focuses the play button), and not again on the control that was just
 * clicked. `data-tip-side="bottom"` puts it under its anchor and
 * `data-tip-side="left"` beside it — for controls that have something worth
 * reading right above them.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { tipFocusAllowed, tipPlacement, tipSide } from "../logic/tooltip";
import type { TipSide } from "../logic/tooltip";

const HOVER_DELAY_MS = 450;
/** A tip shown for keyboard focus goes away by itself; a hovered one stays. */
const FOCUS_SHOWN_MS = 2600;

interface Shown {
  text: string;
  anchor: DOMRect;
  side: TipSide;
}

function tipTarget(node: EventTarget | null): HTMLElement | null {
  return node instanceof Element
    ? node.closest<HTMLElement>("[data-tip]")
    : null;
}

export function TooltipLayer() {
  const [shown, setShown] = useState<Shown | null>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(
    null,
  );

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let current: HTMLElement | null = null;
    /** the control that was pressed: silent until the pointer leaves it */
    let pressed: HTMLElement | null = null;
    /** when a key that moves the focus was last pressed */
    let navigatedAt = -Infinity;
    const hide = () => {
      clearTimeout(timer);
      clearTimeout(expiry);
      current = null;
      setShown(null);
    };
    const show = (target: HTMLElement, delay: number, lasts?: number) => {
      const text = target.dataset.tip?.trim();
      if (!text) return hide();
      clearTimeout(timer);
      clearTimeout(expiry);
      current = target;
      timer = setTimeout(() => {
        if (current !== target || !target.isConnected) return;
        // read again: the text may have changed while waiting
        const now = target.dataset.tip?.trim();
        if (!now) return hide();
        setShown({
          text: now,
          anchor: target.getBoundingClientRect(),
          side: tipSide(target.dataset.tipSide),
        });
        if (lasts) expiry = setTimeout(hide, lasts);
      }, delay);
    };
    const onOver = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const target = tipTarget(event.target);
      if (pressed && target !== pressed) pressed = null;
      if (target === current) return;
      // Still over the control that was just clicked: its content may have
      // been re-rendered under the pointer, which is not a new hover.
      if (target && target !== pressed) show(target, HOVER_DELAY_MS);
      else hide();
    };
    const onDown = (event: PointerEvent) => {
      pressed = tipTarget(event.target);
      hide();
    };
    const onFocus = (event: FocusEvent) => {
      const target = tipTarget(event.target);
      if (!target) return;
      // Only focus the user moved with the keyboard, a moment ago. Focus set
      // by code (after a job, when a dialog closes) shows nothing.
      if (
        tipFocusAllowed({
          focusVisible: target.matches(":focus-visible"),
          sinceNavigationMs: performance.now() - navigatedAt,
        })
      )
        show(target, 0, FOCUS_SHOWN_MS);
    };
    const onKey = (event: KeyboardEvent) => {
      const { key } = event;
      if (
        key === "Tab" ||
        key.startsWith("Arrow") ||
        key === "Home" ||
        key === "End"
      )
        navigatedAt = performance.now();
      // Any other key acts on the control (or types): the tip is in the way.
      else if (!["Shift", "Control", "Alt", "Meta"].includes(key)) hide();
    };
    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", hide);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      clearTimeout(timer);
      clearTimeout(expiry);
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  useLayoutEffect(() => {
    const node = bubble.current;
    if (!shown || !node) {
      setPlace(null);
      return;
    }
    setPlace(
      tipPlacement(
        shown.anchor,
        { width: node.offsetWidth, height: node.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
        shown.side,
      ),
    );
  }, [shown]);

  if (!shown) return null;
  return createPortal(
    <div
      ref={bubble}
      className="tooltip"
      aria-hidden
      style={
        place
          ? { left: place.left, top: place.top }
          : { left: 0, top: 0, visibility: "hidden" }
      }
    >
      {shown.text}
    </div>,
    document.body,
  );
}
