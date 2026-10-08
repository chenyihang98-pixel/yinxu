/**
 * The one context of the renderer. Mount <AppProvider> once at the root;
 * every component reads `useApp()` (state + actions) or `useAppActions()`
 * (actions only — never re-renders).
 */
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import { platform as browserPlatform } from "../platform";
import type { Platform } from "../platform";
import { usePlayer } from "../player/usePlayer";
import { appCore } from "./app";
import type { AppCore } from "./core";
import type { AppActions, AppContextValue } from "./types";
import { useLibrary } from "./useLibrary";
import { useSettings } from "./useSettings";
import { useStudio } from "./useStudio";

const AppContext = createContext<AppContextValue | null>(null);
const ActionsContext = createContext<AppActions | null>(null);

export interface AppProviderProps {
  /** tests and stories may pass their own core */
  core?: AppCore;
  platform?: Platform;
  children?: ReactNode;
}

export function AppProvider(props: AppProviderProps) {
  const core = props.core ?? appCore;
  const platform = props.platform ?? browserPlatform;
  const player = usePlayer(core.onPlayerError);
  const { load, unload, play, pause, setMix, unlock } = player;

  useEffect(() => {
    // Player methods are stable, so this runs once per mount.
    core.attachPlayer({ load, unload, play, pause, setMix, unlock });
    void core.start();
    return () => core.detachPlayer();
  }, [core, load, unload, play, pause, setMix, unlock]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const hidden = () => {
      if (document.visibilityState === "hidden") core.flush();
    };
    window.addEventListener("pagehide", core.close);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", core.close);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [core]);

  const ui = useSyncExternalStore(core.subscribe, () => core.getState().ui);
  const studio = useStudio(core, platform);
  const library = useLibrary(core);
  const settings = useSettings(core);
  const { actions } = core;

  const value = useMemo<AppContextValue>(
    () => ({ platform, ui, studio, library, settings, player, actions }),
    [platform, ui, studio, library, settings, player, actions],
  );
  return createElement(
    ActionsContext.Provider,
    { value: actions },
    createElement(AppContext.Provider, { value }, props.children),
  );
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside <AppProvider>");
  return value;
}

/** Actions only. The object never changes, so this never causes a render. */
export function useAppActions(): AppActions {
  const value = useContext(ActionsContext);
  if (!value)
    throw new Error("useAppActions must be used inside <AppProvider>");
  return value;
}
