/**
 * What every flow of the app core shares: the store, toasts, the one queue
 * for library writes, and the remembered session. No React.
 */
import type { Project } from "../types";
import {
  IDLE,
  SESSION_SAVE_DELAY_MS,
  TOAST_ERROR_MS,
  TOAST_INFO_MS,
  isDue,
  scheduleChange,
  waitFor,
} from "./logic";
import type { Schedule } from "./logic";
import type { Refusal } from "./options";
import { NO_PLAYER } from "./ports";
import type { CoreDeps, PlayerPort } from "./ports";
import type { AppAction, AppState } from "./reducer";
import { initialState, reducer } from "./reducer";
import type { Toast } from "./types";

export const BUSY = "正在生成或打开作品，完成或取消后再试。";
export const WRITE_FAILED = "作品库暂时无法写入。";

export class Kernel {
  state: AppState;
  readonly deps: CoreDeps;
  player: PlayerPort = NO_PLAYER;
  /**
   * The work to reopen from the last session. It stays set until the restore
   * attempt has finished, so a session write in between does not forget it.
   */
  restoreId: string | null;
  /**
   * Ids of soft-deleted works that are not really deleted yet. They are
   * written with the session, so a deletion the user asked for is finished
   * at the next launch if the page goes away inside the undo window.
   */
  readonly pendingRemovals = new Set<string>();

  private readonly listeners = new Set<() => void>();
  private toastSeq = 0;
  /** every library write, in order */
  private writes: Promise<unknown> = Promise.resolve();
  private persistenceAsked = false;
  private sessionSchedule: Schedule = IDLE;
  private sessionTimer: unknown = null;

  constructor(deps: CoreDeps) {
    this.deps = deps;
    const session = deps.session.read();
    this.restoreId = session.lastProjectId;
    for (const id of session.pendingRemovals ?? []) this.pendingRemovals.add(id);
    this.state = initialState({
      desktop: deps.platform.isDesktop && !!deps.desktop,
      version: deps.platform.version,
      composerText: session.composerText,
      brain: session.brain,
    });
  }

  /* ---------------- store ---------------- */

  readonly getState = (): AppState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  dispatch(action: AppAction): void {
    const next = reducer(this.state, action);
    if (next === this.state) return;
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }

  /** The current time as an ISO timestamp. */
  iso(): string {
    return new Date(this.deps.now()).toISOString();
  }

  /** A job (generation or opening) is running. */
  get busy(): boolean {
    return this.state.studio.job !== null;
  }

  /* ---------------- toasts ---------------- */

  toast(
    text: string,
    kind: Toast["kind"] = "info",
    action?: Toast["action"],
    ms?: number,
  ): number {
    const id = ++this.toastSeq;
    this.dispatch({
      type: "toast/push",
      toast: { id, kind, text, ...(action ? { action } : {}) },
    });
    this.deps.timers.set(
      () => this.dispatch({ type: "toast/dismiss", id }),
      ms ?? (kind === "error" ? TOAST_ERROR_MS : TOAST_INFO_MS),
    );
    return id;
  }

  /** Say why something cannot be done and, on desktop, open where to fix it. */
  refuse(refusal: Refusal): void {
    this.toast(refusal.message, "error");
    if (refusal.settingsTab && this.deps.platform.isDesktop)
      this.dispatch({
        type: "ui/modal",
        modal: "settings",
        settingsTab: refusal.settingsTab,
        ...(refusal.provider ? { settingsProvider: refusal.provider } : {}),
      });
  }

  /* ---------------- library writes ---------------- */

  /** One queue for every library write: an older write never lands last. */
  queue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writes.then(task);
    this.writes = run.catch(() => undefined);
    return run;
  }

  store(project: Project): Promise<void> {
    return this.queue(() => this.deps.storage.saveProject(project));
  }

  /** Something reached the library: ask for persistence once, refresh usage. */
  afterSave(): void {
    if (!this.persistenceAsked && this.deps.platform.isWeb) {
      this.persistenceAsked = true;
      void this.deps.storage.requestPersistence().then(
        () => this.refreshStorage(),
        () => {},
      );
    } else void this.refreshStorage();
  }

  async refreshStorage(): Promise<void> {
    try {
      this.dispatch({
        type: "library/storage",
        storage: await this.deps.storage.storageInfo(),
      });
    } catch {
      /* usage is informational */
    }
  }

  /** The newest in-memory version of a work, wherever it lives. */
  find(id: string): Project | undefined {
    const current = this.state.studio.project;
    return current?.id === id
      ? current
      : this.state.library.projects.find((work) => work.id === id);
  }

  listed(id: string): boolean {
    return this.state.library.projects.some((work) => work.id === id);
  }

  /* ---------------- session ---------------- */

  /** Remember now: the open work, the composer text, the preferred producer. */
  writeSession(): void {
    if (this.sessionTimer !== null) {
      this.deps.timers.clear(this.sessionTimer);
      this.sessionTimer = null;
    }
    this.sessionSchedule = IDLE;
    const { studio } = this.state;
    this.deps.session.write({
      lastProjectId: studio.project?.id ?? this.restoreId,
      composerText: studio.composerText,
      brain: studio.brain,
      pendingRemovals: [...this.pendingRemovals],
    });
  }

  /** The composer text changed: remember it a moment after typing stops. */
  touchSession(): void {
    this.sessionSchedule = scheduleChange(
      this.deps.now(),
      SESSION_SAVE_DELAY_MS,
    );
    this.armSession();
  }

  private armSession(): void {
    const { timers } = this.deps;
    if (this.sessionTimer !== null) timers.clear(this.sessionTimer);
    const wait = waitFor(this.sessionSchedule, this.deps.now());
    if (wait === null) return;
    this.sessionTimer = timers.set(() => {
      this.sessionTimer = null;
      if (isDue(this.sessionSchedule, this.deps.now())) this.writeSession();
      else this.armSession();
    }, wait);
  }
}
