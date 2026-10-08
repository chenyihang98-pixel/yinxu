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
import type { AppActions } from "./types";

export type { CoreDeps, PlayerPort, StoragePort, Timers } from "./ports";

export class AppCore {
  private readonly kernel: Kernel;
  private readonly studio: StudioFlows;
  private readonly library: LibraryFlows;
  private readonly settings: SettingsFlows;
  private started: Promise<void> | null = null;
  /** `load` of the player that last received the current work */
  private attachedLoad: PlayerPort["load"] | null = null;

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
    this.onPlayerError = studio.onPlayerError;
    this.actions = {
      navigate: this.navigate,
      openModal: this.openModal,
      closeModal: this.closeModal,
      notify: this.notify,
      dismissToast: this.dismissToast,
      openLink: this.openLink,

      setComposerText: studio.setComposerText,
      setPin: studio.setPin,
      setProvider: studio.setProvider,
      setBrain: studio.setBrain,
      send: studio.send,
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
      openProject: studio.openProject,
      exportWork: studio.exportWork,

      rename: library.rename,
      toggleFavourite: library.toggleFavourite,
      removeProject: library.removeProject,
      undoRemove: library.undoRemove,
      importFile: library.importFile,
      exportDamaged: library.exportDamaged,
      removeDamaged: library.removeDamaged,
      refreshLibrary: library.refreshLibrary,

      refreshSettings: settings.refreshSettings,
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
      // First what the last session left unfinished, then the list.
      await this.library.finishInterrupted();
      await Promise.all([
        this.library.refreshLibrary(),
        this.settings.refreshSettings(),
      ]);
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
    })();
    return this.started;
  }

  /** The page is being hidden: write what is still pending. */
  readonly flush = (): void => {
    this.studio.flushMix();
    this.kernel.writeSession();
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

  /* ---------------- shell ---------------- */

  private readonly navigate: AppActions["navigate"] = (page) => {
    this.kernel.dispatch({ type: "ui/navigate", page });
  };

  private readonly openModal: AppActions["openModal"] = (modal, tab) => {
    const { kernel } = this;
    if (modal === "export" && !kernel.state.studio.project) return;
    kernel.dispatch({ type: "ui/modal", modal, settingsTab: tab });
    if (modal === "settings") void this.settings.refreshSettings();
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
