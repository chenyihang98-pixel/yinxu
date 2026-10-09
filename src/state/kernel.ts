/**
 * What every flow of the app core shares: the store, toasts, questions to
 * the user, the one queue for library writes, what other tabs are told, and
 * the remembered session. No React.
 */
import type { ProjectPatch } from "../storage";
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
import type { PendingMixNote, PendingRemovalNote } from "./session";
import { NO_SYNC } from "./sync";
import type { SyncMessage, TabSync } from "./sync";
import type { Dialog, Toast } from "./types";

export const BUSY = "正在生成或打开作品，完成或取消后再试。";
export const WRITE_FAILED = "暂时无法写入。";

export interface Answer {
  choice: string;
  /** the dialog's checkbox was ticked */
  remember: boolean;
}

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
   * Soft-deleted works of THIS tab that are not really deleted yet, with the
   * time from which any tab may finish the job. They are written with the
   * session, so a deletion the user asked for is finished at the next launch
   * if the page goes away inside the undo window.
   */
  readonly pendingRemovals = new Map<string, number>();
  /**
   * Fader positions of this tab that may not have reached the library when
   * the page is hidden or closed; the next start applies them.
   */
  readonly pendingMixes = new Map<string, PendingMixNote>();

  /**
   * Called when what is at risk on closing may have changed for a reason the
   * store does not show (set by the core, which tells the desktop shell).
   */
  riskChanged: () => void = () => {};

  private readonly sync: TabSync;
  private readonly listeners = new Set<() => void>();
  private toastSeq = 0;
  private dialogSeq = 0;
  private asking: {
    id: number;
    choices: string[];
    resolve: (answer: Answer) => void;
  } | null = null;
  /** every library write, in order */
  private writes: Promise<unknown> = Promise.resolve();
  private persistenceAsked = false;
  private sessionSchedule: Schedule = IDLE;
  private sessionTimer: unknown = null;
  /** fields with a write of this tab in flight, by work: memory is ahead of storage there */
  private readonly writing = new Map<string, Map<string, number>>();
  /** notes this tab has dealt with: they must not survive the next merge */
  private readonly settledRemovals = new Set<string>();
  private readonly settledMixes = new Set<string>();

  constructor(deps: CoreDeps) {
    this.deps = deps;
    this.sync = deps.sync ?? NO_SYNC;
    const session = deps.session.read();
    this.restoreId = session.lastProjectId;
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

  /**
   * `key`: the toast replaces the visible one with the same key. `sticky`:
   * it stays until it is closed or withdrawn.
   */
  toast(
    text: string,
    kind: Toast["kind"] = "info",
    action?: Toast["action"],
    ms?: number,
    options: { key?: string; sticky?: boolean } = {},
  ): number {
    const id = ++this.toastSeq;
    this.dispatch({
      type: "toast/push",
      toast: {
        id,
        kind,
        text,
        ...(action ? { action } : {}),
        ...(options.key ? { key: options.key } : {}),
        ...(options.sticky ? { sticky: true } : {}),
      },
    });
    if (!options.sticky)
      this.deps.timers.set(
        () => this.dispatch({ type: "toast/dismiss", id }),
        ms ?? (kind === "error" ? TOAST_ERROR_MS : TOAST_INFO_MS),
      );
    return id;
  }

  /** Take back the toast with this key, if it is still shown. */
  withdraw(key: string): void {
    this.dispatch({ type: "toast/withdraw", key });
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

  /* ---------------- questions ---------------- */

  /** A question is on screen and has not been answered. */
  get questioning(): boolean {
    return this.asking !== null;
  }

  /**
   * Put a question to the user and wait for the answer. One question at a
   * time: while one is open, another resolves at once with its own `cancel`
   * choice — nothing that needs a yes ever goes ahead unasked.
   */
  ask(dialog: Omit<Dialog, "id">): Promise<Answer> {
    if (this.asking)
      return Promise.resolve({ choice: dialog.cancel, remember: false });
    const id = ++this.dialogSeq;
    return new Promise((resolve) => {
      this.asking = {
        id,
        choices: dialog.choices.map((choice) => choice.id),
        resolve,
      };
      this.dispatch({ type: "ui/dialog", dialog: { ...dialog, id } });
    });
  }

  readonly answer = (id: number, choice: string, remember = false): void => {
    const asking = this.asking;
    if (!asking || asking.id !== id || !asking.choices.includes(choice)) return;
    this.asking = null;
    this.dispatch({ type: "ui/dialog", dialog: null });
    asking.resolve({ choice, remember: remember === true });
  };

  /* ---------------- library writes ---------------- */

  /** One queue for every library write: an older write never lands last. */
  queue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writes.then(task);
    this.writes = run.catch(() => undefined);
    return run;
  }

  private announce(message: SyncMessage): void {
    this.sync.post(message);
  }

  /**
   * Store a whole work: a new one, or the loaded one that never reached the
   * library. A work that is already stored is changed with `patch`.
   */
  async store(project: Project): Promise<void> {
    await this.queue(() => this.deps.storage.saveProject(project));
    this.announce({ type: "saved", id: project.id });
  }

  /**
   * Put a deleted work back. Written only when its record is really gone, so
   * what another tab stored there meanwhile is kept.
   */
  async restore(project: Project): Promise<void> {
    await this.queue(() =>
      this.deps.storage.saveProject(project, { ifMissing: true }),
    );
    this.announce({ type: "saved", id: project.id });
  }

  /**
   * Change fields of a stored work, merged with what is stored now. Resolves
   * with the stored result, or null when the record no longer exists (it was
   * deleted in another tab and stays deleted).
   */
  async patch(
    id: string,
    patch: ProjectPatch,
    options?: { unlessNewer?: boolean },
  ): Promise<Project | null> {
    const stored = await this.queue(() =>
      this.deps.storage.updateProject(id, patch, options),
    );
    if (stored) this.announce({ type: "saved", id });
    return stored;
  }

  /**
   * A change to these fields is on its way to the library. Until `release`,
   * what storage answers for them (to an earlier write of this tab, or about
   * another tab) is older than what is on screen and must not replace it.
   */
  hold(id: string, fields: readonly string[]): void {
    let held = this.writing.get(id);
    if (!held) this.writing.set(id, (held = new Map()));
    for (const field of fields) held.set(field, (held.get(field) ?? 0) + 1);
  }

  release(id: string, fields: readonly string[]): void {
    const held = this.writing.get(id);
    if (!held) return;
    for (const field of fields) {
      const count = (held.get(field) ?? 0) - 1;
      if (count > 0) held.set(field, count);
      else held.delete(field);
    }
    if (held.size === 0) this.writing.delete(id);
  }

  holding(id: string, field: string): boolean {
    return this.writing.get(id)?.has(field) === true;
  }

  /** Really delete a record (also a damaged one). */
  async remove(id: string): Promise<void> {
    await this.queue(() => this.deps.storage.deleteProject(id));
    this.announce({ type: "deleted", id });
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

  /** This tab has dealt with a deletion note: forget it everywhere. */
  settleRemoval(id: string): void {
    this.pendingRemovals.delete(id);
    this.settledRemovals.add(id);
  }

  /** This tab has dealt with a fader note: forget it everywhere. */
  settleMix(id: string): void {
    this.pendingMixes.delete(id);
    this.settledMixes.add(id);
  }

  /** Notes left in the session by pages that are gone (or by other tabs). */
  readNotes(): { removals: PendingRemovalNote[]; mixes: PendingMixNote[] } {
    const session = this.deps.session.read();
    return {
      removals: session.pendingRemovals.filter(
        (note) => !this.pendingRemovals.has(note.id),
      ),
      mixes: session.pendingMixes.filter(
        (note) => !this.pendingMixes.has(note.id),
      ),
    };
  }

  /**
   * Remember now: the open work, the composer text, the preferred producer,
   * and this tab's pending deletions and fader moves. The session is shared
   * by every tab of the origin, so the two lists are merged with what is
   * stored: another tab's notes stay, this tab's settled ones go.
   */
  writeSession(): void {
    if (this.sessionTimer !== null) {
      this.deps.timers.clear(this.sessionTimer);
      this.sessionTimer = null;
    }
    this.sessionSchedule = IDLE;
    const { studio } = this.state;
    const stored = this.deps.session.read();
    const removals = new Map(
      stored.pendingRemovals
        .filter((note) => !this.settledRemovals.has(note.id))
        .map((note) => [note.id, note]),
    );
    for (const [id, expiresAt] of this.pendingRemovals)
      removals.set(id, { id, expiresAt });
    const mixes = new Map(
      stored.pendingMixes
        .filter((note) => !this.settledMixes.has(note.id))
        .map((note) => [note.id, note]),
    );
    for (const [id, note] of this.pendingMixes) mixes.set(id, note);
    this.deps.session.write({
      lastProjectId: studio.project?.id ?? this.restoreId,
      composerText: studio.composerText,
      brain: studio.brain,
      pendingRemovals: [...removals.values()],
      pendingMixes: [...mixes.values()],
    });
    this.settledRemovals.clear();
    this.settledMixes.clear();
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
