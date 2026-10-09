/** Derived views of the state. Pure; memoised by the hooks. */
import type { Platform } from "../platform";
import { changedFields } from "./logic";
import {
  activeBrain,
  brainOptions,
  durationRange,
  engineOptions,
} from "./options";
import {
  applyHint,
  draftInaudible,
  paidNotice,
  suggestionsFor,
  variationLabel,
} from "./plan";
import type { SettingsState, StudioState, StudioView } from "./types";

type Capabilities = Pick<Platform, "canUseCloud" | "canUseLlm">;

/** 应用调整 may run: something differs, or a v0.2 work can be redone by engine 2. */
export function canApplyDraft(studio: StudioState): boolean {
  const { project } = studio;
  if (!project) return false;
  return (
    changedFields(studio.draft, project.config).length > 0 ||
    project.config.engine === 1
  );
}

/**
 * The loaded work exists only in this window: it never reached the library
 * and the attempt to store it failed.
 */
export function isUnsaved(
  studio: Pick<StudioState, "project" | "stored" | "saveState">,
): boolean {
  return !!studio.project && !studio.stored && studio.saveState === "failed";
}

export function studioView(
  studio: StudioState,
  settings: Pick<SettingsState, "providers" | "llm">,
  platform: Capabilities,
): StudioView {
  const brains = brainOptions(platform, settings);
  return {
    ...studio,
    mode: studio.project ? "refine" : "new",
    changedFields: changedFields(studio.draft, studio.project?.config),
    canApplyDraft: canApplyDraft(studio),
    busy: studio.job !== null,
    engines: engineOptions(platform, settings),
    brains,
    activeBrain: activeBrain(studio.brain, brains),
    suggestions: suggestionsFor(studio.project, studio.provider),
    unsaved: isUnsaved(studio),
    paid: paidNotice(studio.provider, !!studio.project),
    applyHint: applyHint(studio.project, studio.provider, studio.draft),
    variationLabel: variationLabel(studio.provider),
    applyInaudible: draftInaudible(
      studio.project,
      studio.provider,
      studio.draft,
    ),
    durationRange: durationRange(studio.provider),
  };
}
