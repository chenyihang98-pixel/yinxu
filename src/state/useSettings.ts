/**
 * Desktop settings (cloud services, the producer's language model). On the
 * web `status` is "unavailable" and nothing is ever requested.
 */
import { useSyncExternalStore } from "react";
import type { AppCore } from "./core";
import type { SettingsView } from "./types";

export function useSettings(core: AppCore): SettingsView {
  return useSyncExternalStore(core.subscribe, () => core.getState().settings);
}
