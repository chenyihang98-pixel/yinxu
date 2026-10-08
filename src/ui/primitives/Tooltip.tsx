/**
 * One tooltip for the whole app. Any element with a `data-tip` attribute
 * gets it on hover (after a short delay) and on keyboard focus. It is purely
 * visual: the element already carries an accessible name or description.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const HOVER_DELAY_MS = 450;
const MARGIN = 8;

interface Shown {
  text: string;
  anchor: DOMRect;
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
    let current: HTMLElement | null = null;
    const hide = () => {
      clearTimeout(timer);
      current = null;
      setShown(null);
    };
    const show = (target: HTMLElement, delay: number) => {
      const text = target.dataset.tip?.trim();
      if (!text) return hide();
      clearTimeout(timer);
      current = target;
      timer = setTimeout(() => {
        if (current !== target || !target.isConnected) return;
        setShown({ text, anchor: target.getBoundingClientRect() });
      }, delay);
    };
    const onOver = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const target = tipTarget(event.target);
      if (target === current) return;
      if (target) show(target, HOVER_DELAY_MS);
      else hide();
    };
    const onFocus = (event: FocusEvent) => {
      const target = tipTarget(event.target);
      if (target?.matches(":focus-visible")) show(target, 0);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", hide);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerdown", hide, true);
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
    const { anchor } = shown;
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    const above = anchor.top - height - MARGIN;
    const top = above >= 4 ? above : anchor.bottom + MARGIN;
    const centre = anchor.left + anchor.width / 2 - width / 2;
    const left = Math.max(4, Math.min(window.innerWidth - width - 4, centre));
    setPlace({ left: Math.round(left), top: Math.round(top) });
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
