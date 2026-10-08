/** The studio: committed work, draft, thread, job — plus what follows from them. */
import { useMemo, useSyncExternalStore } from "react";
import type { Platform } from "../platform";
import type { AppCore } from "./core";
import { brainOptions, engineOptions } from "./options";
import { studioView } from "./selectors";
import type { StudioView } from "./types";

export function useStudio(core: AppCore, platform: Platform): StudioView {
  const studio = useSyncExternalStore(
    core.subscribe,
    () => core.getState().studio,
  );
  const settings = useSyncExternalStore(
    core.subscribe,
    () => core.getState().settings,
  );
  // The option lists depend on the settings only. Keeping their identity
  // while the studio changes (a fader moves many times a second) lets
  // memoised selectors skip those renders.
  const engines = useMemo(
    () => engineOptions(platform, settings),
    [platform, settings],
  );
  const brains = useMemo(
    () => brainOptions(platform, settings),
    [platform, settings],
  );
  return useMemo(
    () => ({ ...studioView(studio, settings, platform), engines, brains }),
    [studio, settings, platform, engines, brains],
  );
}
