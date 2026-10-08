import { useRef } from "react";
import type { Project } from "../../types";

function sameList<T>(
  a: readonly T[],
  b: readonly T[],
  same: (x: T, y: T) => boolean,
): boolean {
  return a.length === b.length && a.every((item, index) => same(item, b[index]));
}

/**
 * Keeps the previous array while the new one holds "the same" items, so
 * lists that are rebuilt on every state change do not defeat `memo`.
 */
export function useStableList<T>(
  list: readonly T[],
  same: (a: T, b: T) => boolean = Object.is,
): readonly T[] {
  const kept = useRef(list);
  if (kept.current !== list && !sameList(kept.current, list, same))
    kept.current = list;
  return kept.current;
}

/**
 * Two versions of a work look the same in a list (navigation, version tags):
 * everything but the mix, which changes many times a second under a fader.
 */
export function sameListing(a: Project, b: Project): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.title === b.title &&
      a.revision === b.revision &&
      a.parentId === b.parentId &&
      a.favorite === b.favorite &&
      a.config.mood === b.config.mood)
  );
}
