/**
 * The app core: one store and every flow of the renderer, without React.
 * Hooks subscribe to it (context.ts); tests drive it with fakes.
 *
 *   kernel.ts         store, toasts, the library write queue, the session
 *   studioFlows.ts    composer, inspector, jobs (produce / open), mixer, export
 *   libraryFlows.ts   list, rename, favourite, soft delete, import, damaged
 *   settingsFlows.ts  cloud services and the producer's language model
 *
 * `actions` is the stable object the UI calls; see AppActions in types.ts.
 */
import { Kernel } from "./kernel";
import { LibraryFlows } from "./libraryFlows";
import { NO_PLAYER } from "./ports";
import type { CoreDeps, PlayerPort } from "./ports";
import type { AppState } from "./reducer";
import { SettingsFlows } from "./settingsFlows";
import { StudioFlows } from "./studioFlows";
import { NO_SYNC } from "./sync";
import type { DesktopAPI } from "../types";
import type { AppActions } from "./types";

export type { CoreDeps, PlayerPort, StoragePort, Timers } from "./ports";

export class AppCore {
  private readonly kernel: Kernel;
  private readonly studio: StudioFlows;
  private readonly library: LibraryFlows;
  private readonly settings: SettingsFlows;
  private started: Promise<void> | null = null;
  /** start() has finished: the library is read, the last work reopened */
  private ready = false;
  /** `load` of the player that last received the current work */
  private attachedLoad: PlayerPort["load"] | null = null;
  private stopSync: (() => void) | null = null;
  /** what the desktop shell was last told about paid work at risk */
  private reportedRisk = false;

  readonly actions: AppActions;
  readonly getState: () => AppState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Pass to usePlayer: playback failures become toasts. */
  readonly onPlayerError: (message: string) => void;

  constructor(deps: CoreDeps) {
    const kernel = new Kernel(deps);
    const studio = new StudioFlows(kernel);
    const library = new LibraryFlows(kernel, studio);
    const settings = new SettingsFlows(kernel);
    this.kernel = kernel;
    this.studio = studio;
    this.library = library;
    this.settings = settings;
    this.getState = kernel.getState;
    this.subscribe = kernel.subscribe;
    // The desktop shell asks before it closes the window while the page
    // holds paid audio that is not stored (or is still receiving it).
    kernel.riskChanged = this.reportRisk;
    kernel.subscribe(this.reportRisk);
    this.onPlayerError = studio.onPlayerError;
    this.actions = {
      navigate: this.navigate,
      openModal: this.openModal,
      closeModal: this.closeModal,
      notify: this.notify,
      dismissToast: this.dismissToast,
      openLink: this.openLink,
      setMode: this.setMode,

      setComposerText: studio.setComposerText,
      setPin: studio.setPin,
      setProvider: studio.setProvider,
      setBrain: studio.setBrain,
      send: studio.send,
      startPiece: studio.startPiece,
      pickSuggestion: studio.pickSuggestion,
      answerDialog: kernel.answer,
      newPiece: studio.newPiece,
      chooseInspiration: studio.chooseInspiration,
      setDraft: studio.setDraft,
      resetDraft: studio.resetDraft,
      applyDraft: studio.applyDraft,
      variation: studio.variation,
      cancelJob: studio.cancelJob,
      setVolume: studio.setVolume,
      commitMix: studio.commitMix,
      toggleMute: studio.toggleMute,
      toggleSolo: studio.toggleSolo,
      setLoopAudition: studio.setLoopAudition,
      openProject: studio.openProject,
      exportWork: studio.exportWork,
      retrySave: studio.retrySave,
      downloadPending: studio.downloadPending,
      discardPending: studio.discardPending,
      retryStray: studio.retryStray,
      exportStray: studio.exportStray,

      rename: library.rename,
      toggleFavourite: library.toggleFavourite,
      removeProject: library.removeProject,
      undoRemove: library.undoRemove,
      importFile: library.importFile,
      exportDamaged: library.exportDamaged,
      exportDamagedAudio: library.exportDamagedAudio,
      removeDamaged: library.removeDamaged,
      refreshLibrary: library.refreshLibrary,

      refreshSettings: this.refreshSettings,
      saveProvider: settings.saveProvider,
      removeProvider: settings.removeProvider,
      saveLlm: settings.saveLlm,
      removeLlm: settings.removeLlm,
    };
  }

  /* ---------------- lifecycle ---------------- */

  /**
   * Give the core the app's player. Safe to call again with the same methods.
   * A different player — the interface was rebuilt after a render error, and
   * its player with it — knows nothing about the loaded work: it gets the
   * audio again, paused, so the work stays playable.
   */
  attachPlayer(player: PlayerPort): void {
    const fresh = player.load !== this.attachedLoad;
    this.kernel.player = player;
    this.attachedLoad = player.load;
    if (fresh) this.studio.reloadPlayer();
  }

  /**
   * The interface (and its player) is going away. Until another player is
   * attached, a job that finishes loads its audio nowhere instead of into a
   * player nobody can see or stop.
   */
  detachPlayer(): void {
    this.kernel.player = NO_PLAYER;
  }

  /**
   * Read the library and the desktop settings, then reopen the work of the
   * last session (without playing it). Idempotent.
   */
  start(): Promise<void> {
    this.started ??= (async () => {
      const { kernel } = this;
      // What other tabs do to the library from now on is heard here.
      this.stopSync ??= (kernel.deps.sync ?? NO_SYNC).subscribe(
        this.library.onSync,
      );
      // First what the last session left unfinished — deletions that were
      // asked for, fader moves that were not written — then the list.
      await this.library.finishInterrupted();
      await this.studio.applyNotedMixes();
      await Promise.all([
        this.library.refreshLibrary(),
        this.settings.refreshSettings(),
      ]);
      // 简单模式: the producer follows what the settings say is usable.
      this.studio.followSettings();
      const id = kernel.restoreId;
      try {
        if (
          id &&
          !kernel.busy &&
          !kernel.state.studio.project &&
          kernel.listed(id)
        )
          await this.studio.open(id, { reason: "restored", autoplay: false });
      } finally {
        // Until now a session write keeps pointing at the work to restore.
        kernel.restoreId = null;
      }
      // A paid result the shell still holds from before a reload of this
      // page: the offer to fetch it comes back (the library is read by now,
      // so the work it refines can be found).
      this.studio.syncPending();
      this.ready = true;
    })();
    return this.started;
  }

  /**
   * The page is being hidden: write what is still pending. Fader positions
   * the library has not confirmed go into the session first (a synchronous
   * write) — the database write started here may never finish.
   */
  readonly flush = (): void => {
    this.studio.noteMixes();
    this.kernel.writeSession();
    this.studio.flushMix();
  };

  /**
   * Why closing the page right now would lose something that was paid for
   * (an unsaved cloud result, a cloud request on its way), ready to show —
   * or null when it is safe. The page asks the browser to confirm
   * (beforeunload); the desktop shell can ask the same question before it
   * closes the window.
   */
  readonly closeRisk = (): string | null => this.studio.closeRisk();

  /**
   * Tell the desktop shell whenever "closing now would lose paid work"
   * starts or stops being true (DesktopAPI.setUnsavedWork). On the web there
   * is no shell; the page's own beforeunload asks instead.
   */
  private readonly reportRisk = (): void => {
    const risk = this.studio.closeRisk() !== null;
    if (risk === this.reportedRisk) return;
    this.reportedRisk = risk;
    try {
      // `?.` on the method: a stand-in bridge may not implement it.
      const bridge: Partial<DesktopAPI> | undefined = this.kernel.deps.desktop;
      void Promise.resolve(bridge?.setUnsavedWork?.(risk)).catch(() => {});
    } catch {
      /* the bridge is gone */
    }
  };

  /**
   * The page is going away. Deletions whose undo window is still open are
   * carried out — the user asked for them and cannot undo any more. A write
   * started now may not complete; the ids are in the session, and the next
   * start() finishes whatever is left (LibraryFlows.finishInterrupted).
   */
  readonly close = (): void => {
    this.flush();
    this.library.finishRemovals();
  };

  /**
   * Read the desktop settings again. They also say whether the shell holds a
   * paid result that never reached this page; the studio takes that up.
   */
  private readonly refreshSettings: AppActions["refreshSettings"] =
    async () => {
      await this.settings.refreshSettings();
      this.studio.followSettings();
      // Not before start() has read the library and reopened the last work.
      if (this.ready) this.studio.syncPending();
    };

  /* ---------------- shell ---------------- */

  private readonly navigate: AppActions["navigate"] = (page) => {
    this.kernel.dispatch({ type: "ui/navigate", page });
  };

  private readonly setMode: AppActions["setMode"] = (mode) => {
    const { kernel } = this;
    const next = mode === "pro" ? "pro" : "simple";
    if (kernel.state.ui.mode === next) return;
    kernel.dispatch({ type: "ui/mode", mode: next });
    kernel.deps.mode?.write(next);
    if (next === "simple") {
      // 简单模式 has no 灵感 page; everything else stays where it is.
      if (kernel.state.ui.page === "inspiration")
        kernel.dispatch({ type: "ui/navigate", page: "studio" });
      this.studio.enterSimple();
      kernel.toast("已切换到简单模式。");
    } else kernel.toast("已切换到专业模式，可在设置里换回简单模式。");
  };

  private readonly openModal: AppActions["openModal"] = (modal, tab) => {
    const { kernel } = this;
    if (modal === "export" && !kernel.state.studio.project) return;
    // 简单模式 opens the settings where its own choice lives: 常规.
    const settingsTab =
      tab ?? (modal === "settings" && kernel.simple ? "general" : undefined);
    kernel.dispatch({ type: "ui/modal", modal, settingsTab });
    if (modal === "settings") void this.refreshSettings();
  };

  private readonly closeModal: AppActions["closeModal"] = () => {
    this.kernel.dispatch({ type: "ui/modal", modal: null });
  };

  private readonly notify: AppActions["notify"] = (text, kind) => {
    if (typeof text === "string" && text.trim())
      this.kernel.toast(text.trim(), kind === "error" ? "error" : "info");
  };

  private readonly dismissToast: AppActions["dismissToast"] = (id) => {
    this.kernel.dispatch({ type: "toast/dismiss", id });
  };

  private readonly openLink: AppActions["openLink"] = (url) => {
    const failed = () => this.kernel.toast("无法打开这个链接。", "error");
    void this.kernel.deps.openExternal(url).then((opened) => {
      if (!opened) failed();
    }, failed);
  };
}
