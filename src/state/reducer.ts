/**
 * The whole renderer state and the only code that changes it. Pure.
 *
 * Structural guarantees:
 *  - job results (`job/update`, `thread/append`, `studio/loaded`) carry the
 *    id of the job that produced them and are dropped unless that job is
 *    still the running one and has not been cancelled;
 *  - composer text, pins, provider and brain never touch draft or project;
 *  - mixer actions write the committed `project.config.volumes`;
 *  - solo changes only when a work is loaded or the user toggles it — a
 *    failed or cancelled job leaves solo, mix and audio exactly as they were;
 *  - a work replaces draft, thread, solo and audio together, in one step;
 *    inspector edits a generation did not use are carried onto its result;
 *  - a toast that offers an action (撤销) or is sticky is never pushed out
 *    by later toasts.
 */
import type { AgentTurn, BrainKind } from "../agent/types";
import { DEFAULT_CONFIG } from "../music/defaults";
import { TRACKS } from "../music/score";
import { EMPTY_PROVIDER_STATUSES } from "../providers";
import type { DamagedRecord } from "../storage";
import type {
  CloudProvider,
  DesktopSettings,
  MusicConfig,
  Project,
  Provider,
  TrackName,
} from "../types";
import {
  capThread,
  clampVolume,
  draftOf,
  editDraft,
  resetDraft,
  toggleMuteVolumes,
} from "./logic";
import { parseMode } from "./mode";
import type { UiMode } from "./mode";
import { cleanPins } from "./plan";
import { upsertProject } from "./works";
import type {
  Dialog,
  Draft,
  DraftField,
  Job,
  LibraryState,
  LoadEvent,
  LoadedAudio,
  ModalId,
  Page,
  PendingResult,
  Pins,
  SaveState,
  SettingsState,
  SettingsTab,
  StorageUsage,
  StrayResult,
  StudioState,
  Toast,
  TurnNote,
  UiState,
} from "./types";

export interface AppState {
  ui: UiState;
  studio: StudioState;
  library: LibraryState;
  settings: SettingsState;
}

export type AppAction =
  | { type: "ui/mode"; mode: UiMode }
  | { type: "ui/navigate"; page: Page }
  | {
      type: "ui/modal";
      modal: ModalId | null;
      settingsTab?: SettingsTab;
      /** which service's form to show first on the AI 音乐服务 tab */
      settingsProvider?: CloudProvider;
    }
  | { type: "toast/push"; toast: Toast }
  | { type: "toast/dismiss"; id: number }
  | { type: "toast/withdraw"; key: string }
  | { type: "ui/dialog"; dialog: Dialog | null }
  | { type: "composer/text"; text: string }
  | { type: "composer/pins"; pins: Pins }
  | { type: "composer/provider"; provider: Provider }
  | { type: "composer/brain"; brain: BrainKind }
  | { type: "draft/set"; field: DraftField; value: Draft[DraftField] }
  | { type: "draft/reset"; field?: DraftField }
  | { type: "job/start"; job: Job; pendingTurn?: AgentTurn | null }
  | {
      type: "job/update";
      job: number;
      patch: Partial<Pick<Job, "stage" | "phase" | "progress" | "cancellable">>;
    }
  | { type: "job/cancel"; job: number; phase: string }
  | { type: "job/end"; job: number }
  | {
      type: "thread/append";
      job: number;
      turns: AgentTurn[];
      notes?: Record<string, TurnNote>;
    }
  | {
      type: "studio/loaded";
      job: number;
      project: Project;
      audio: LoadedAudio | null;
      audioError: string | null;
      thread: AgentTurn[];
      notes?: Record<string, TurnNote>;
      reason: LoadEvent["reason"];
      saveState: SaveState;
      /**
       * The work is in the library. Default: what `saveState` implies —
       * "idle" (opened from the library) and "saved" are, "saving" and
       * "failed" (a fresh result) are not yet.
       */
      stored?: boolean;
      /** inspector edits to keep on top of the new work's values */
      carry?: Partial<Draft>;
      /** engine to select for the next generation, when it should follow the work */
      provider?: Provider;
      /** a new piece was made from the composer: its pins are used up */
      clearPins?: boolean;
    }
  | { type: "studio/unloaded" }
  | { type: "studio/solo"; track: TrackName | null }
  | {
      type: "studio/saveState";
      id: string;
      saveState: SaveState;
      /** the write that is reported put the whole work into the library */
      stored?: boolean;
    }
  | { type: "studio/exporting"; exporting: boolean }
  /** a paid result is waiting to be fetched (or no longer is) */
  | { type: "studio/pending"; pending: PendingResult | null }
  /** the paid results that exist only in this window, besides the loaded work */
  | { type: "studio/strays"; strays: StrayResult[] }
  /** the last generation failed (text), or that is no longer news (null) */
  | { type: "studio/failure"; text: string | null }
  /** 简单模式: a request changed nothing, and why (or null: no longer news) */
  | { type: "studio/notice"; text: string | null }
  | { type: "studio/peaks"; id: string; peaks: number[] }
  | { type: "mix/volume"; track: TrackName; value: number }
  | { type: "mix/mute"; track: TrackName; fallback: number }
  | { type: "project/patch"; id: string; patch: Partial<Project> }
  | { type: "library/loaded"; projects: Project[]; damaged: DamagedRecord[] }
  | { type: "library/failed"; error: string }
  | { type: "library/upsert"; project: Project }
  | { type: "library/hide"; id: string; expiresAt: number }
  | { type: "library/restore"; id: string }
  | { type: "library/removed"; id: string }
  /** the record no longer exists (deleted in another window) */
  | { type: "library/gone"; id: string }
  | { type: "library/damagedRemoved"; id: string }
  | { type: "library/storage"; storage: StorageUsage | null }
  | { type: "settings/loading" }
  | { type: "settings/loaded"; settings: DesktopSettings }
  | { type: "settings/failed"; error: string };

/** Plain notices on screen at once; toasts with an action or sticky ones do not count. */
const MAX_TOASTS = 4;

const lasting = (toast: Toast) => !!toast.action || !!toast.sticky;

/**
 * Add a toast. One with a key takes the place of the visible toast with the
 * same key; a plain one replaces an identical plain one instead of stacking.
 * Only plain toasts are ever pushed out to make room.
 */
function pushToast(toasts: readonly Toast[], toast: Toast): Toast[] {
  const slot = toasts.findIndex((item) =>
    toast.key !== undefined
      ? item.key === toast.key
      : !lasting(item) &&
        !lasting(toast) &&
        item.kind === toast.kind &&
        item.text === toast.text,
  );
  const next =
    slot >= 0 && toast.key !== undefined
      ? toasts.map((item, index) => (index === slot ? toast : item))
      : [...toasts.filter((_, index) => index !== slot), toast];
  let extra = next.filter((item) => !lasting(item)).length - MAX_TOASTS;
  return extra > 0
    ? next.filter((item) => lasting(item) || extra-- <= 0)
    : next;
}

const EMPTY_STUDIO: Pick<
  StudioState,
  | "project"
  | "audio"
  | "audioError"
  | "draft"
  | "touched"
  | "thread"
  | "pendingTurn"
  | "solo"
  | "mutedFrom"
  | "saveState"
  | "stored"
> = {
  project: null,
  audio: null,
  audioError: null,
  draft: draftOf(DEFAULT_CONFIG),
  touched: [],
  thread: [],
  pendingTurn: null,
  solo: null,
  mutedFrom: {},
  saveState: "idle",
  stored: false,
};

export function initialState(options: {
  desktop: boolean;
  version: string;
  composerText?: string;
  brain?: BrainKind;
  /** default 简单模式 */
  mode?: UiMode;
}): AppState {
  return {
    ui: {
      mode: parseMode(options.mode),
      page: "studio",
      modal: null,
      settingsTab: "music",
      settingsProvider: null,
      toasts: [],
      dialog: null,
    },
    studio: {
      ...EMPTY_STUDIO,
      pins: {},
      composerText: options.composerText ?? "",
      provider: "local",
      brain: options.brain ?? "rules",
      turnNotes: {},
      job: null,
      exporting: false,
      lastLoad: null,
      pending: null,
      strays: [],
      failure: null,
      notice: null,
    },
    library: {
      status: "loading",
      error: null,
      projects: [],
      damaged: [],
      removing: [],
      storage: null,
    },
    settings: {
      status: options.desktop ? "loading" : "unavailable",
      error: null,
      providers: EMPTY_PROVIDER_STATUSES,
      llm: { configured: false },
      dataPath: "",
      version: options.version,
      pendingResult: null,
    },
  };
}

/** The job `id` is running and may still write. */
function jobMayWrite(studio: StudioState, id: number): boolean {
  return studio.job?.id === id && studio.job.stage !== "cancelling";
}

/** Apply `change` to a work wherever it lives: the studio and the list. */
function changeProject(
  state: AppState,
  id: string,
  change: (project: Project) => Project,
): AppState {
  const current = state.studio.project;
  const inStudio = current?.id === id;
  const inList = state.library.projects.some((item) => item.id === id);
  if (!inStudio && !inList) return state;
  const next = inStudio ? change(current) : null;
  return {
    ...state,
    studio: inStudio ? { ...state.studio, project: next } : state.studio,
    library: inList
      ? {
          ...state.library,
          projects: state.library.projects.map((item) =>
            item.id === id ? (next ?? change(item)) : item,
          ),
        }
      : state.library,
  };
}

function withVolumes(
  project: Project,
  volumes: Record<TrackName, number>,
): Project {
  const config: MusicConfig = { ...project.config, volumes };
  return { ...project, config };
}

/** Faders exist only for a loaded local work. */
function mixable(
  studio: StudioState,
): studio is StudioState & { project: Project } {
  return !!studio.project && studio.audio?.kind === "stems";
}

function studioReducer(state: AppState, action: AppAction): AppState {
  const { studio } = state;
  switch (action.type) {
    case "composer/text":
      return action.text === studio.composerText
        ? state
        : { ...state, studio: { ...studio, composerText: action.text } };
    case "composer/pins":
      return { ...state, studio: { ...studio, pins: cleanPins(action.pins) } };
    case "composer/provider":
      return { ...state, studio: { ...studio, provider: action.provider } };
    case "composer/brain":
      return { ...state, studio: { ...studio, brain: action.brain } };

    case "draft/set": {
      const edited = editDraft(
        studio,
        studio.project?.config ?? null,
        action.field,
        action.value,
      );
      return { ...state, studio: { ...studio, ...edited } };
    }
    case "draft/reset": {
      if (!studio.project) return state;
      const reset = resetDraft(studio, studio.project.config, action.field);
      return { ...state, studio: { ...studio, ...reset } };
    }

    case "job/start":
      // One job at a time: a second start is dropped, not queued.
      if (studio.job) return state;
      return {
        ...state,
        studio: {
          ...studio,
          job: action.job,
          pendingTurn: action.pendingTurn ?? null,
          failure: null,
          notice: null,
        },
      };
    case "job/update":
      if (!jobMayWrite(studio, action.job) || !studio.job) return state;
      return {
        ...state,
        studio: { ...studio, job: { ...studio.job, ...action.patch } },
      };
    case "job/cancel":
      if (!jobMayWrite(studio, action.job) || !studio.job) return state;
      return {
        ...state,
        studio: {
          ...studio,
          pendingTurn: null,
          job: {
            ...studio.job,
            stage: "cancelling",
            phase: action.phase,
            progress: null,
            cancellable: false,
          },
        },
      };
    case "job/end":
      if (studio.job?.id !== action.job) return state;
      return { ...state, studio: { ...studio, job: null, pendingTurn: null } };

    case "thread/append":
      if (!jobMayWrite(studio, action.job)) return state;
      return {
        ...state,
        studio: {
          ...studio,
          thread: capThread([...studio.thread, ...action.turns]),
          pendingTurn: null,
          turnNotes: { ...studio.turnNotes, ...action.notes },
        },
      };

    case "studio/loaded": {
      if (!jobMayWrite(studio, action.job)) return state;
      const fresh = draftOf(action.project.config);
      const carried = (Object.keys(action.carry ?? {}) as DraftField[]).filter(
        (field) => fresh[field] !== action.carry?.[field],
      );
      return {
        ...state,
        studio: {
          ...studio,
          project: action.project,
          audio: action.audio,
          audioError: action.audioError,
          draft: carried.length ? { ...fresh, ...action.carry } : fresh,
          touched: carried,
          stored:
            action.stored ??
            (action.saveState === "idle" || action.saveState === "saved"),
          thread: capThread(action.thread),
          pendingTurn: null,
          turnNotes: { ...studio.turnNotes, ...action.notes },
          solo: null,
          mutedFrom: {},
          saveState: action.saveState,
          provider: action.provider ?? studio.provider,
          pins: action.clearPins ? {} : studio.pins,
          failure: null,
          notice: null,
          lastLoad: {
            seq: (studio.lastLoad?.seq ?? 0) + 1,
            reason: action.reason,
          },
        },
      };
    }
    case "studio/unloaded":
      return {
        ...state,
        studio: {
          ...studio,
          ...EMPTY_STUDIO,
          pins: {},
          composerText: "",
          failure: null,
          notice: null,
        },
      };

    case "studio/solo":
      if (!mixable(studio)) return state;
      return {
        ...state,
        studio: {
          ...studio,
          solo:
            action.track && TRACKS.includes(action.track) ? action.track : null,
        },
      };
    case "studio/saveState": {
      if (studio.project?.id !== action.id) return state;
      const stored = action.stored ?? studio.stored;
      return studio.saveState === action.saveState && studio.stored === stored
        ? state
        : {
            ...state,
            studio: { ...studio, saveState: action.saveState, stored },
          };
    }
    case "studio/exporting":
      return { ...state, studio: { ...studio, exporting: action.exporting } };
    case "studio/pending":
      return studio.pending === action.pending
        ? state
        : { ...state, studio: { ...studio, pending: action.pending } };
    case "studio/strays":
      return { ...state, studio: { ...studio, strays: action.strays } };
    case "studio/failure":
      return studio.failure === action.text
        ? state
        : { ...state, studio: { ...studio, failure: action.text } };
    case "studio/notice":
      return studio.notice === action.text
        ? state
        : { ...state, studio: { ...studio, notice: action.text } };
    case "studio/peaks":
      return studio.project?.id === action.id && studio.audio
        ? {
            ...state,
            studio: {
              ...studio,
              audio: { ...studio.audio, peaks: action.peaks },
            },
          }
        : state;

    case "mix/volume": {
      if (!mixable(studio) || !TRACKS.includes(action.track)) return state;
      const value = clampVolume(action.value);
      const volumes = {
        ...studio.project.config.volumes,
        [action.track]: value,
      };
      const { [action.track]: _forgotten, ...mutedFrom } = studio.mutedFrom;
      const next = changeProject(state, studio.project.id, (project) =>
        withVolumes(project, volumes),
      );
      return {
        ...next,
        // A fader moved off zero by hand is no longer "muted from" anything.
        studio: {
          ...next.studio,
          mutedFrom: value > 0 ? mutedFrom : studio.mutedFrom,
        },
      };
    }
    case "mix/mute": {
      if (!mixable(studio) || !TRACKS.includes(action.track)) return state;
      const toggled = toggleMuteVolumes(
        studio.project.config.volumes,
        studio.mutedFrom,
        action.track,
        action.fallback,
      );
      const next = changeProject(state, studio.project.id, (project) =>
        withVolumes(project, toggled.volumes),
      );
      return {
        ...next,
        studio: { ...next.studio, mutedFrom: toggled.mutedFrom },
      };
    }
    default:
      return state;
  }
}

function libraryReducer(state: AppState, action: AppAction): AppState {
  const { library } = state;
  switch (action.type) {
    case "project/patch":
      // The id of a work never changes.
      return changeProject(state, action.id, (project) => ({
        ...project,
        ...action.patch,
        id: project.id,
      }));
    case "library/loaded": {
      const hidden = new Set(library.removing.map((item) => item.project.id));
      return {
        ...state,
        library: {
          ...library,
          status: "ready",
          error: null,
          projects: action.projects.filter((item) => !hidden.has(item.id)),
          damaged: action.damaged,
        },
      };
    }
    case "library/failed":
      return {
        ...state,
        library: { ...library, status: "error", error: action.error },
      };
    case "library/upsert":
      return {
        ...state,
        library: {
          ...library,
          projects: upsertProject(library.projects, action.project),
        },
      };
    case "library/hide": {
      const project = library.projects.find((item) => item.id === action.id);
      if (!project) return state;
      const current = state.studio.project?.id === action.id;
      return {
        ...state,
        // A deleted work cannot stay loaded: later mixer saves would bring
        // the record back.
        studio: current ? { ...state.studio, ...EMPTY_STUDIO } : state.studio,
        library: {
          ...library,
          projects: library.projects.filter((item) => item.id !== action.id),
          removing: [
            ...library.removing.filter((item) => item.project.id !== action.id),
            { project, expiresAt: action.expiresAt },
          ],
        },
      };
    }
    case "library/restore": {
      const entry = library.removing.find(
        (item) => item.project.id === action.id,
      );
      if (!entry) return state;
      return {
        ...state,
        library: {
          ...library,
          removing: library.removing.filter((item) => item !== entry),
          projects: upsertProject(library.projects, entry.project),
        },
      };
    }
    case "library/removed":
      return {
        ...state,
        library: {
          ...library,
          removing: library.removing.filter(
            (item) => item.project.id !== action.id,
          ),
        },
      };
    case "library/gone": {
      const listed = library.projects.some((item) => item.id === action.id);
      const waiting = library.removing.some(
        (item) => item.project.id === action.id,
      );
      const current = state.studio.project?.id === action.id;
      if (!listed && !waiting && !current) return state;
      return {
        ...state,
        // As with a deletion made here: the work cannot stay loaded, or its
        // next fader save would have nowhere to go.
        studio:
          current && !state.studio.job
            ? { ...state.studio, ...EMPTY_STUDIO }
            : state.studio,
        library: {
          ...library,
          projects: library.projects.filter((item) => item.id !== action.id),
          removing: library.removing.filter(
            (item) => item.project.id !== action.id,
          ),
        },
      };
    }
    case "library/damagedRemoved":
      return {
        ...state,
        library: {
          ...library,
          damaged: library.damaged.filter((item) => item.id !== action.id),
        },
      };
    case "library/storage":
      return { ...state, library: { ...library, storage: action.storage } };
    default:
      return state;
  }
}

/** The service the shell says it holds a result of; anything else is "none". */
function heldProvider(value: unknown): CloudProvider | null {
  const provider =
    value && typeof value === "object"
      ? (value as { provider?: unknown }).provider
      : null;
  return typeof provider === "string" &&
    Object.hasOwn(EMPTY_PROVIDER_STATUSES, provider)
    ? (provider as CloudProvider)
    : null;
}

function settingsReducer(
  settings: SettingsState,
  action: AppAction,
): SettingsState {
  switch (action.type) {
    case "settings/loading":
      return settings.status === "unavailable" || settings.status === "ready"
        ? settings
        : { ...settings, status: "loading", error: null };
    case "settings/loaded": {
      const source = action.settings;
      return {
        status: "ready",
        error: null,
        providers: { ...EMPTY_PROVIDER_STATUSES, ...source.providers },
        llm: source.llm ?? { configured: false },
        dataPath: typeof source.dataPath === "string" ? source.dataPath : "",
        version:
          typeof source.version === "string" && source.version
            ? source.version
            : settings.version,
        pendingResult: heldProvider(source.pendingResult),
      };
    }
    case "settings/failed":
      return settings.status === "unavailable"
        ? settings
        : { ...settings, status: "error", error: action.error };
    default:
      return settings;
  }
}

function uiReducer(ui: UiState, action: AppAction): UiState {
  switch (action.type) {
    case "ui/mode": {
      const mode = parseMode(action.mode);
      return ui.mode === mode ? ui : { ...ui, mode };
    }
    case "ui/navigate":
      return ui.page === action.page ? ui : { ...ui, page: action.page };
    case "ui/modal":
      return {
        ...ui,
        modal: action.modal,
        settingsTab: action.settingsTab ?? ui.settingsTab,
        // a hint lives for one opening of the modal
        settingsProvider:
          action.modal === "settings"
            ? (action.settingsProvider ?? ui.settingsProvider)
            : null,
      };
    case "toast/push":
      return { ...ui, toasts: pushToast(ui.toasts, action.toast) };
    case "toast/withdraw":
      return ui.toasts.some((toast) => toast.key === action.key)
        ? {
            ...ui,
            toasts: ui.toasts.filter((toast) => toast.key !== action.key),
          }
        : ui;
    case "ui/dialog":
      return ui.dialog === action.dialog
        ? ui
        : { ...ui, dialog: action.dialog };
    case "toast/dismiss":
      return ui.toasts.some((toast) => toast.id === action.id)
        ? { ...ui, toasts: ui.toasts.filter((toast) => toast.id !== action.id) }
        : ui;
    default:
      return ui;
  }
}

export function reducer(state: AppState, action: AppAction): AppState {
  let next = studioReducer(state, action);
  next = libraryReducer(next, action);
  const ui = uiReducer(next.ui, action);
  const settings = settingsReducer(next.settings, action);
  return ui === next.ui && settings === next.settings
    ? next
    : { ...next, ui, settings };
}
