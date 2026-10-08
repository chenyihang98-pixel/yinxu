/**
 * What UI code imports from the state layer.
 *
 *   <AppProvider>            mount once at the root (App.tsx)
 *   useApp()                 state + actions (see AppContextValue in types.ts)
 *   useAppActions()          actions only; never re-renders
 *   usePlanPreview()         "理解预览" for the new-piece composer
 *   useLibraryFilter()       搜索 / 收藏 / 排序 for a library page
 *   useShortcuts()           global keyboard shortcuts
 *   usePlaybackTime(player)  from ../player/usePlayer — playhead consumers only
 */
export { AppProvider, useApp, useAppActions } from "./context";
export { useLibraryFilter } from "./useLibrary";
export type { LibraryFilter } from "./useLibrary";
export { usePlanPreview } from "./usePlanPreview";
export { SEEK_STEP_SECONDS, useShortcuts } from "./shortcuts";
export { DRAFT_FIELDS } from "./types";
export type * from "./types";
export type { PlanPreview } from "./plan";
export { DURATION_CHOICES } from "./plan";
export {
  COMPOSER_PLACEHOLDER,
  COMPOSER_PLACEHOLDER_SHORT,
  QUICK_PROMPTS,
  REFINE_PLACEHOLDER,
  SCENARIO_GROUPS,
  STYLE_CARDS,
  scenarioInspiration,
  styleInspiration,
} from "./content";
export type { ScenarioGroup, ScenarioPrompt } from "./content";
export * from "./format";
export {
  findVersion,
  projectDuration,
  queryProjects,
  recipeLine,
  versionLabel,
} from "./works";
export type { LibraryQuery, LibrarySort } from "./works";
