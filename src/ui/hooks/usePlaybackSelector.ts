import { useSyncExternalStore } from "react";
import type { Player } from "../../player/usePlayer";

/**
 * A value derived from the playhead. The component re-renders only when the
 * derived value changes (the current section, the whole second…), not on
 * every tick of the transport. `select` must return a primitive.
 */
export function usePlaybackSelector<T extends string | number | boolean>(
  player: Pick<Player, "subscribeTime" | "getTime">,
  select: (seconds: number) => T,
): T {
  return useSyncExternalStore(
    player.subscribeTime,
    () => select(player.getTime()),
    () => select(0),
  );
}
