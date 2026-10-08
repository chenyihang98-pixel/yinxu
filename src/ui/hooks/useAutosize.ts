import { useLayoutEffect } from "react";
import type { RefObject } from "react";

/** Grow a textarea with its content, between its CSS min- and max-height. */
export function useAutosize(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
): void {
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${node.scrollHeight + 2}px`;
  }, [ref, value]);
}
