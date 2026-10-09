/**
 * The renderer's state contract — what `useApp()` returns.
 *
 * Reading order for UI code:
 *   AppContextValue → StudioView / LibraryView / SettingsView / UiState
 *   AppActions      → every way the UI can change something
 *
 * Rules the types encode:
 *  - committed = `studio.project` (+ `studio.audio`). Title, cover, tags,
 *    mixer values, seed and export read from `project.config`.
 *  - draft = `studio.draft`: only the inspector fields. It cannot hold a
 *    seed, volumes or the description, so it can never overwrite them.
 *  - `studio.composerText` is just text: typing never changes draft or work.
 *  - solo is playback-only; export never looks at it.
 */
import type {
  AgentTurn,
  BrainKind,
  LlmSettingsInput,
  LlmStatus,
} from "../agent/types";
import type { StyleId } from "../music/catalog";
import type { ArrangementSummary } from "../music/score";
import type { Platform } from "../platform";
import type { Player } from "../player/usePlayer";
import type { DamagedRecord } from "../storage";
import type {
  CloudProvider,
  MusicConfig,
  Project,
  Provider,
  ProviderStatuses,
  TrackName,
} from "../types";

/* ------------------------------------------------------------------ */
/* shell                                                               */
/* ------------------------------------------------------------------ */

export type Page = "studio" | "library" | "inspiration";
export type ModalId = "settings" | "export" | "help";
/** data-testid: settings-tab-<id> */
export type SettingsTab = "music" | "llm" | "about";

export interface Toast {
  id: number;
  kind: "info" | "error";
  text: string;
  /** e.g. 撤销. Call `run()`, then `actions.dismissToast(id)`. */
  action?: { label: string; run: () => void };
  /**
   * A toast with a key replaces the visible toast that has the same key (the
   * one undo notice, the one "mix not saved" error) instead of stacking.
   */
  key?: string;
  /** stays until it is closed or the core withdraws it */
  sticky?: boolean;
}

/** One answer the user can give to a Dialog. data-testid: dialog-choice-<id> */
export interface DialogChoice {
  id: string;
  label: string;
  variant?: "primary" | "danger";
}

/**
 * A question the core needs answered before it goes on: a paid request, a
 * failed language model before a paid request, leaving an unsaved result.
 * Answer with `actions.answerDialog(dialog.id, choice.id, remember)`.
 * data-testid: dialog-<kind>
 */
export interface Dialog {
  id: number;
  kind: "paid" | "fallback" | "unsaved";
  title: string;
  /** paragraphs */
  body: string[];
  /** in display order */
  choices: DialogChoice[];
  /** the choice that Escape and the close button give */
  cancel: string;
  /** label of an optional checkbox, e.g. 本次会话不再提示 (data-testid dialog-remember) */
  remember?: string;
}

export interface UiState {
  page: Page;
  modal: ModalId | null;
  /** tab to show when the settings modal opens */
  settingsTab: SettingsTab;
  /**
   * AI 音乐服务 tab: the service whose form to show first — set when the user
   * picked an engine that still needs credentials. null = no preference.
   */
  settingsProvider: CloudProvider | null;
  /** newest last; the core removes them after 4 s (info) / 8 s (error, undo) */
  toasts: Toast[];
  /** the question waiting for an answer; the page behind it is inert */
  dialog: Dialog | null;
}

/* ------------------------------------------------------------------ */
/* studio                                                              */
/* ------------------------------------------------------------------ */

/** The inspector's fields, in display order. data-testid: inspector-<field> */
export const DRAFT_FIELDS = [
  "mood",
  "bpm",
  "instrument",
  "key",
  "energy",
  "complexity",
  "reverb",
  "duration",
  "loop",
] as const;
export type DraftField = (typeof DRAFT_FIELDS)[number];
/** Pending inspector edits. Deliberately not a full MusicConfig. */
export type Draft = Pick<MusicConfig, DraftField>;

/**
 * Choices made in the new-piece composer for the next send. A missing key
 * means "自动": the producer decides.
 */
export type Pins = Partial<Pick<MusicConfig, "mood" | "duration" | "loop">>;

/** A local work: four final stems, mixed live by the player. */
export interface StemsAudio {
  kind: "stems";
  stems: Record<TrackName, AudioBuffer>;
  /** 1 = rendered by the frozen v0.2 engine (show the 旧版引擎 badge) */
  engine: 1 | 2;
  /** waveform of the mix at the committed faders, 0..1 */
  peaks: number[];
  /** waveform per stem, 0..1 relative to the loudest stem */
  stemPeaks: Record<TrackName, number[]>;
  /** exact length in seconds */
  duration: number;
  sampleRate: number;
  /** sections, chords, instruments, notes — engine 2 only */
  arrangement?: ArrangementSummary;
  /**
   * Where the samples were computed, when the engine says so: its render
   * worker, the page's own thread, or the frozen v0.2 engine. Shown as
   * data-render-path on the player card (nothing else reads it).
   */
  renderPath?: "worker" | "main" | "legacy";
}

/** A cloud work: one decoded mix, no stems. */
export interface MixAudio {
  kind: "mix";
  buffer: AudioBuffer;
  peaks: number[];
  duration: number;
  sampleRate: number;
}

export type LoadedAudio = StemsAudio | MixAudio;

export type JobKind = "generate" | "open";
/**
 * planning     the producer is reading the request (rules: instant; LLM: seconds)
 * asking       the job waits for the user's answer to a Dialog (not cancellable)
 * rendering    the local engine is composing and synthesising (progress 0..1)
 * cloud        waiting for a cloud music service (no progress; may be billed)
 * downloading  fetching a finished cloud result again (nothing is submitted)
 * saving       storing a cloud result before it is decoded
 * decoding     decoding stored or freshly generated cloud audio
 * cancelling   the user cancelled; waiting for the work in flight to stop
 */
export type JobStage =
  | "planning"
  | "asking"
  | "rendering"
  | "cloud"
  | "downloading"
  | "saving"
  | "decoding"
  | "cancelling";

/** The one running job. Shown on every page (data-testid job-progress / job-cancel). */
export interface Job {
  id: number;
  kind: JobKind;
  stage: JobStage;
  /** engine of THIS job — never read the composer's selector for a running job */
  provider: Provider;
  /** which producer is planning (generate jobs) */
  brain: BrainKind;
  /** ready-to-show Chinese status, e.g. "正在作曲与合成" */
  phase: string;
  /** 0..1, or null when the length of the wait is unknown */
  progress: number | null;
  cancellable: boolean;
  /** epoch milliseconds, for elapsed-time displays */
  startedAt: number;
}

/**
 * idle    nothing to save (no work, or a work that was only opened)
 * saving  a write is in flight
 * saved   the committed work is in the library
 * failed  the last write failed: the audio is still playable and exportable
 */
export type SaveState = "idle" | "saving" | "saved" | "failed";

/** Extra facts about agent turns of this session (not stored with the work). */
export interface TurnNote {
  /** model id that answered */
  model?: string;
  /** set when the LLM failed and the offline rules answered instead */
  fallbackReason?: string;
}

/** Why the current work was loaded; `seq` changes on every load. */
export interface LoadEvent {
  seq: number;
  /** generated: scroll the player into view and focus play (autoplay is already handled) */
  reason: "generated" | "opened" | "restored";
}

export interface StudioState {
  /** the committed work, or null in the empty (new piece) state */
  project: Project | null;
  /** its audio; null with a project means the audio could not be decoded */
  audio: LoadedAudio | null;
  /** why `audio` is missing, ready to show; 导出原始音频 still works */
  audioError: string | null;
  /** pending inspector edits; equals the committed values right after a load */
  draft: Draft;
  /** inspector fields the user edited by hand since the last load */
  touched: DraftField[];
  /** new-piece composer choices for the next send */
  pins: Pins;
  /** text in the composer (hero textarea or the thread's input) */
  composerText: string;
  /** engine the next generation will use */
  provider: Provider;
  /** producer the user prefers; see StudioView.brains for what is usable */
  brain: BrainKind;
  /** the conversation of this lineage, oldest first */
  thread: AgentTurn[];
  /** the user's message a running job is working on (show it after `thread`) */
  pendingTurn: AgentTurn | null;
  /** by AgentTurn.id */
  turnNotes: Record<string, TurnNote>;
  /** stem being auditioned alone; playback only */
  solo: TrackName | null;
  /** fader positions to return to when a muted track is unmuted */
  mutedFrom: Partial<Record<TrackName, number>>;
  job: Job | null;
  saveState: SaveState;
  /**
   * The loaded work exists in the library. False for a fresh result until
   * its first save succeeds — with saveState "failed" it lives only in this
   * window (see StudioView.unsaved).
   */
  stored: boolean;
  /** an export is being prepared or written */
  exporting: boolean;
  lastLoad: LoadEvent | null;
}

export interface EngineOption {
  id: Provider;
  label: string;
  /** cloud services: shown with the label, e.g. "按服务商计费" */
  billing?: string;
  /** false: show it disabled with `hint` */
  available: boolean;
  /** why it cannot be chosen: "桌面版可用" / "需先在设置中配置" / "凭据需重新保存" */
  hint?: string;
  /** true when the web build cannot offer it at all: link to platform.downloadUrl */
  desktopOnly?: boolean;
}

export interface BrainOption {
  id: BrainKind;
  /** "离线规则" / "大模型 claude-…" */
  label: string;
  available: boolean;
  hint?: string;
  desktopOnly?: boolean;
}

/**
 * The next generation is a paid request to a cloud service. Shown wherever a
 * generation can be started, before it is started.
 * data-testid: paid-notice
 */
export interface PaidNotice {
  provider: CloudProvider;
  /** "腾讯云 TokenHub" */
  name: string;
  /** ready to show, e.g. "将向…发送一次新的生成请求，按该服务计费；…" */
  text: string;
}

/** StudioState plus everything derived from it. */
export interface StudioView extends StudioState {
  /** "new" in the empty state, "refine" with a work loaded */
  mode: "new" | "refine";
  /** inspector fields whose draft differs from the committed work (computed) */
  changedFields: DraftField[];
  /** 应用调整 is possible: something changed, or an engine-1 work can be redone */
  canApplyDraft: boolean;
  /** a job is running; generation and opening are refused while true */
  busy: boolean;
  engines: EngineOption[];
  brains: BrainOption[];
  /** the producer that will actually plan the next message */
  activeBrain: BrainKind;
  /** refinement chips that would change the current work */
  suggestions: string[];
  /**
   * The loaded work has never reached the library and its save failed: it
   * exists only in this window. Show the banner (重试保存 / 导出); leaving
   * the work asks first.
   */
  unsaved: boolean;
  /** set while the selected engine is a cloud service; null for local */
  paid: PaidNotice | null;
  /** one honest line under 应用调整: what it does to the melody and the library */
  applyHint: string;
  /** label of the 换一版旋律 button for the selected engine */
  variationLabel: string;
}

/* ------------------------------------------------------------------ */
/* library                                                             */
/* ------------------------------------------------------------------ */

export interface PendingRemoval {
  project: Project;
  /** epoch milliseconds at which the record is really deleted */
  expiresAt: number;
}

export interface StorageUsage {
  usage: number;
  quota: number;
  persisted: boolean;
}

export interface LibraryState {
  status: "loading" | "ready" | "error";
  /** why the library could not be read, ready to show */
  error: string | null;
  /** newest first; works waiting in the undo window are not in this list */
  projects: Project[];
  /** records this build cannot open: show reason + 导出原始数据 / 删除 */
  damaged: DamagedRecord[];
  /** soft-deleted works that can still be restored */
  removing: PendingRemoval[];
  /** null when the browser will not say (and on desktop before the first read) */
  storage: StorageUsage | null;
}

export type LibraryView = LibraryState;

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

export interface SettingsState {
  /**
   * unavailable: not the desktop app (web build) — show the explanation and
   * the download link instead of forms.
   */
  status: "unavailable" | "loading" | "ready" | "error";
  error: string | null;
  providers: ProviderStatuses;
  llm: LlmStatus;
  /** desktop: where works and settings are stored */
  dataPath: string;
  version: string;
}

export type SettingsView = SettingsState;

/* ------------------------------------------------------------------ */
/* actions                                                             */
/* ------------------------------------------------------------------ */

/** data-testid: export-option-<id> with ids mix, stem-<track>, original, project */
export type ExportRequest =
  | {
      kind: "mix";
      /** loop works only: repeat the loop this many times (default 1) */
      repeats?: 1 | 2 | 4;
      /** engine-1 and cloud works that do not loop: 1 s fade in/out */
      fade?: boolean;
    }
  | { kind: "stem"; track: TrackName }
  | { kind: "original" }
  | { kind: "project" };

export type ActionResult = { ok: true } | { ok: false; message: string };

export interface InspirationChoice {
  /**
   * Description to put into the composer. Style cards leave it empty: they
   * pin their style and nothing else, so the style's own blurb is never
   * parsed as if the user had written it.
   */
  text: string;
  /** style cards pin their style */
  mood?: StyleId;
}

/** Anything with a name, a size and text() — a File from an <input type=file>. */
export interface ImportSource {
  name?: string;
  size: number;
  text(): Promise<string>;
}

/**
 * Every function is referentially stable for the life of the app and reads
 * the current state when it runs, so it is safe in effects, timers and event
 * handlers without dependencies.
 *
 * Functions that start a job resolve true when the work was produced or
 * opened, and false otherwise: refused (another job is running, nothing to
 * do, engine not available), cancelled, failed, or — for a message — when the
 * producer answered without changing anything. The reason is always told to
 * the user through a toast and/or the thread; callers need not report it.
 */
export interface AppActions {
  /* ---- shell ---- */
  navigate(page: Page): void;
  openModal(modal: ModalId, settingsTab?: SettingsTab): void;
  closeModal(): void;
  notify(text: string, kind?: "info" | "error"): void;
  dismissToast(id: number): void;
  /** Open an http(s) page outside the app (desktop: allow-listed pages only). */
  openLink(url: string): void;

  /* ---- composer ---- */
  /** Typing. Touches nothing but the text (and the saved session). */
  setComposerText(text: string): void;
  /** Pin a style / duration / structure for the next send; undefined = 自动. */
  setPin<K extends keyof Pins>(field: K, value: Pins[K] | undefined): void;
  /** Refused (with a toast, and the settings modal on desktop) when unavailable. */
  setProvider(provider: Provider): void;
  setBrain(brain: BrainKind): void;
  /**
   * Send the composer text to the producer: a new piece in the empty state,
   * a refinement with a work loaded. Call it from the click or key handler so
   * autoplay is allowed afterwards. The composer is cleared when the job
   * starts and gets the user's text back, exactly as typed, if the job is
   * cancelled or fails.
   *
   * With `text` (a ready-made phrase) that phrase is sent instead and the
   * composer is not touched at all. In the empty state a pinned style alone
   * is enough: the message is then empty and only the pins are sent.
   *
   * A cloud engine means a paid request: the user is asked first (until they
   * tick 本次会话不再提示 for that service), see `ui.dialog`.
   */
  send(text?: string): Promise<boolean>;
  /**
   * A suggestion chip. Local engine: the phrase is sent at once and the
   * composer keeps whatever was typed. Cloud engine: nothing is sent — the
   * phrase is added to the composer, next to the billing notice, for the
   * user to send. Resolves true when a version was produced.
   */
  pickSuggestion(text: string): Promise<boolean>;
  /** Answer `ui.dialog`. Unknown ids and choices are ignored. */
  answerDialog(id: number, choice: string, remember?: boolean): void;
  /**
   * 新建创作: unload the work and return to the empty state. False while a
   * job runs, and false when the loaded work is an unsaved result — then the
   * user is asked and the work is left only after they agree.
   */
  newPiece(): boolean;
  /**
   * Pre-fill the new-piece composer (pinning the style of a style card) and
   * show it; the loaded work, if any, is left (it stays in the library).
   */
  chooseInspiration(choice: InspirationChoice): void;

  /* ---- direct controls ---- */
  /** Edit the draft. Changing the style also moves the untouched fields to its preset. */
  setDraft<K extends DraftField>(field: K, value: Draft[K]): void;
  /** 还原: one field, or the whole draft. */
  resetDraft(field?: DraftField): void;
  /** 应用调整: regenerate with the draft, same seed, as a new version. */
  applyDraft(): Promise<boolean>;
  /** 换一版旋律: regenerate the committed settings with a new seed. */
  variation(): Promise<boolean>;
  /** Cancel the running job; the toast tells the truth about cloud billing. */
  cancelJob(): void;

  /* ---- mixer (local works) ---- */
  /** Fader move: audible at once, saved ≥ 400 ms after the last change. */
  setVolume(track: TrackName, value: number): void;
  /** Pointer up / key up on a fader: save now. */
  commitMix(): void;
  toggleMute(track: TrackName): void;
  toggleSolo(track: TrackName): void;
  /**
   * 循环试听 on or off. A work loads with it on when it is a 循环片段 and off
   * when it has a 完整结尾; what the user sets here is remembered for works of
   * the same structure, not for the other one. Playback only.
   */
  setLoopAudition(loop: boolean): void;

  /* ---- works ---- */
  /**
   * Open a work from the library. `autoplay` is for quick-play buttons
   * (call from the click handler). A work that is already loaded just plays.
   */
  openProject(id: string, options?: { autoplay?: boolean }): Promise<boolean>;
  /** Unchanged or empty titles write nothing. */
  rename(id: string, title: string): Promise<boolean>;
  toggleFavourite(id: string): Promise<boolean>;
  /**
   * Soft delete with an 8 s 撤销 toast. Cloud works hold paid audio: the
   * first call returns "confirm" and deletes nothing; ask, then pass true.
   */
  removeProject(
    id: string,
    confirmed?: boolean,
  ): "removed" | "confirm" | "refused";
  /** Put back one soft-deleted work, or every one still inside its window. */
  undoRemove(id?: string): void;
  exportWork(request: ExportRequest): Promise<boolean>;
  /** 重试保存: store the loaded work whose save failed. */
  retrySave(): Promise<boolean>;
  /** Import one project JSON (local recipes), then open it. */
  importFile(file: ImportSource): Promise<boolean>;
  /** Damaged records: save the raw stored data as JSON (never contains audio). */
  exportDamaged(id: string): Promise<boolean>;
  /** Damaged records that still hold audio: save those bytes as they are. */
  exportDamagedAudio(id: string): Promise<boolean>;
  removeDamaged(id: string): Promise<boolean>;
  refreshLibrary(): Promise<void>;

  /* ---- settings (desktop) ---- */
  refreshSettings(): Promise<void>;
  /** Failures are returned for the form to show; they are not toasted. */
  saveProvider(
    provider: CloudProvider,
    credentials: Record<string, string>,
  ): Promise<ActionResult>;
  removeProvider(provider: CloudProvider): Promise<ActionResult>;
  saveLlm(settings: LlmSettingsInput): Promise<ActionResult>;
  removeLlm(): Promise<ActionResult>;
}

/* ------------------------------------------------------------------ */
/* context                                                             */
/* ------------------------------------------------------------------ */

export interface AppContextValue {
  platform: Platform;
  ui: UiState;
  studio: StudioView;
  library: LibraryView;
  settings: SettingsView;
  /**
   * Transport state and controls. The playhead is read with
   * `usePlaybackSelector(player, …)` (ui/hooks), only inside the small
   * components that show it. Faders, mute and solo go through `actions`,
   * never through `player.setMix`.
   */
  player: Player;
  actions: AppActions;
}
