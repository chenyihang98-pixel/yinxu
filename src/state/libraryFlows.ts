/**
 * The library's flows: reading the list, rename, favourite, soft delete with
 * an undo window, import, damaged records, and what other tabs report. No
 * React.
 */
import { originalFormat } from "../providers";
import { sniffAudioFormat } from "../services/exporter";
import type { ProjectPatch } from "../storage";
import type { Project } from "../types";
import { BUSY, WRITE_FAILED } from "./kernel";
import type { Kernel } from "./kernel";
import { UNDO_WINDOW_MS, cleanTitle, errorText } from "./logic";
import type { StudioFlows } from "./studioFlows";
import type { SyncMessage } from "./sync";
import type { AppActions } from "./types";

const MAX_IMPORT_BYTES = 1024 * 1024;
/** The one undo notice: it lists every deletion that can still be undone. */
const UNDO_TOAST = "undo-remove";

export class LibraryFlows {
  private readonly kernel: Kernel;
  private readonly studio: StudioFlows;
  /** soft deletes whose undo window is still open, oldest first */
  private readonly removals = new Map<string, { timer: unknown }>();
  /**
   * The work that was loaded in the studio when it was deleted, with what
   * the studio looked like right after: 撤销 puts it back there as long as
   * nothing else has happened in the studio since.
   */
  private unloaded: {
    id: string;
    seq: number | null;
    text: string;
    pins: string;
  } | null = null;

  constructor(kernel: Kernel, studio: StudioFlows) {
    this.kernel = kernel;
    this.studio = studio;
  }

  /**
   * The page is going away: nobody can undo any more. The deletions still
   * waiting are marked as due at once — in the session, synchronously — and
   * then carried out; if the page dies before the database has answered, the
   * next start (of any tab) finishes them.
   */
  finishRemovals(): void {
    const ids = [...this.removals.keys()];
    if (!ids.length) return;
    for (const id of ids) this.kernel.pendingRemovals.set(id, 0);
    this.kernel.writeSession();
    for (const id of ids) void this.finishRemoval(id);
  }

  /**
   * Deletions a page asked for but could not finish: it closed inside the
   * undo window, and a database write started while a page is being torn
   * down is not guaranteed to happen. Runs before the library is read, so
   * those works never reappear. A deletion whose undo window is still open
   * belongs to a tab that is alive — it is left to that tab, which may yet
   * undo it.
   */
  async finishInterrupted(): Promise<void> {
    const now = this.kernel.deps.now();
    const due = this.kernel
      .readNotes()
      .removals.filter((note) => note.expiresAt <= now);
    if (due.length === 0) return;
    for (const { id } of due) {
      try {
        await this.kernel.remove(id);
      } catch {
        /* the library cannot be written: the work simply stays */
      }
      this.kernel.settleRemoval(id);
    }
    this.kernel.writeSession();
  }

  /* ---------------- library ---------------- */

  readonly refreshLibrary: AppActions["refreshLibrary"] = async () => {
    try {
      const { projects, damaged } =
        await this.kernel.deps.storage.listProjects();
      this.kernel.dispatch({ type: "library/loaded", projects, damaged });
    } catch (error) {
      this.kernel.dispatch({
        type: "library/failed",
        error: errorText(
          error,
          this.kernel.deps.platform.isDesktop
            ? "无法读取「我的作品」，请重新启动应用后再试。"
            : "无法读取「我的作品」，请刷新页面后再试。",
        ),
      });
    }
    await this.kernel.refreshStorage();
  };

  readonly rename: AppActions["rename"] = async (id, title) => {
    const work = this.kernel.find(id);
    const next = cleanTitle(title);
    // Nothing typed, or nothing changed: no write at all.
    if (!work || !next || next === work.title) return false;
    return this.patchAndSave(id, { title: next }, "新名称");
  };

  readonly toggleFavourite: AppActions["toggleFavourite"] = async (id) => {
    const work = this.kernel.find(id);
    if (!work) return false;
    return this.patchAndSave(id, { favorite: !work.favorite }, "收藏状态");
  };

  readonly removeProject: AppActions["removeProject"] = (
    id,
    confirmed = false,
  ) => {
    const work = this.kernel.state.library.projects.find(
      (item) => item.id === id,
    );
    if (!work) return "refused";
    if (this.kernel.busy) {
      this.kernel.toast(BUSY);
      return "refused";
    }
    // Paid audio is never deleted by a single click.
    if (work.provider !== "local" && !confirmed) return "confirm";
    const wait = this.kernel.deps.undoMs ?? UNDO_WINDOW_MS;
    const expiresAt = this.kernel.deps.now() + wait;
    const current = this.kernel.state.studio.project?.id === id;
    if (current) {
      // Unapplied inspector edits wait with the work: 撤销 brings both back.
      this.studio.park(false);
      this.studio.flushMix();
      this.kernel.player.unload();
    }
    this.kernel.dispatch({ type: "library/hide", id, expiresAt });
    // The composer is empty again: it offers the user's own engine.
    if (current) {
      this.studio.restoreEngine();
      this.unloaded = { id, ...this.studioMark() };
    }
    const timer = this.kernel.deps.timers.set(
      () => void this.finishRemoval(id),
      wait,
    );
    this.removals.set(id, { timer });
    // Remembered at once (the session write is synchronous), with the time
    // from which another tab may finish the job.
    this.kernel.pendingRemovals.set(id, expiresAt);
    this.kernel.writeSession();
    this.showUndo();
    return "removed";
  };

  /**
   * One notice for every deletion that can still be undone. It stays for as
   * long as any undo window is open and no later toast can push it out, so
   * the fifth quick delete does not cost the first one its 撤销.
   */
  private showUndo(): void {
    const waiting = this.kernel.state.library.removing.filter((entry) =>
      this.removals.has(entry.project.id),
    );
    if (waiting.length === 0) {
      this.kernel.withdraw(UNDO_TOAST);
      return;
    }
    // 简单模式 deletes a piece with all its versions: one piece, one name.
    const onePiece =
      this.kernel.simple &&
      waiting.every(
        (entry) => entry.project.title === waiting[0].project.title,
      );
    this.kernel.toast(
      waiting.length === 1 || onePiece
        ? `已删除《${waiting[0].project.title}》`
        : `已删除 ${waiting.length} 首作品`,
      "info",
      {
        label: waiting.length === 1 || onePiece ? "撤销" : "全部撤销",
        run: () => this.undoRemove(),
      },
      undefined,
      { key: UNDO_TOAST, sticky: true },
    );
  }

  /** What tells whether the studio was used since a work was taken out of it. */
  private studioMark(): { seq: number | null; text: string; pins: string } {
    const { lastLoad, composerText, pins } = this.kernel.state.studio;
    return {
      seq: lastLoad?.seq ?? null,
      text: composerText,
      pins: JSON.stringify(pins),
    };
  }

  readonly undoRemove: AppActions["undoRemove"] = (id) => {
    const ids =
      id === undefined
        ? [...this.removals.keys()]
        : this.removals.has(id)
          ? [id]
          : [];
    if (ids.length === 0) return;
    // The work that was open when it was deleted goes back into the studio —
    // unless the studio has been used for something else in the meantime.
    const was = this.unloaded;
    let reopen: string | null = null;
    if (was && ids.includes(was.id)) {
      this.unloaded = null;
      const { studio } = this.kernel.state;
      const now = this.studioMark();
      if (
        !studio.project &&
        !studio.job &&
        !this.kernel.questioning &&
        now.seq === was.seq &&
        now.text === was.text &&
        now.pins === was.pins
      )
        reopen = was.id;
    }
    const works: Project[] = [];
    for (const item of ids) {
      const pending = this.removals.get(item);
      if (pending) this.kernel.deps.timers.clear(pending.timer);
      this.removals.delete(item);
      this.kernel.settleRemoval(item);
      const entry = this.kernel.state.library.removing.find(
        (waiting) => waiting.project.id === item,
      );
      if (entry) works.push(entry.project);
      // Shown again at once; whether it is really back is said afterwards.
      this.kernel.dispatch({ type: "library/restore", id: item });
    }
    this.kernel.writeSession();
    this.showUndo();
    void this.putBack(works, reopen);
  };

  /**
   * Undo is only reported once every record is known to be in the library:
   * each one is written back if it is missing (another tab may have carried
   * the deletion out while the window was open here).
   */
  private async putBack(
    works: Project[],
    reopen: string | null = null,
  ): Promise<void> {
    const failed: Project[] = [];
    let reason: unknown;
    for (const work of works) {
      try {
        await this.kernel.restore(work);
      } catch (error) {
        failed.push(work);
        reason = error;
      }
    }
    if (failed.length === 0) {
      this.kernel.toast(
        works.length > 1 ? `已恢复 ${works.length} 首作品` : "已恢复",
      );
      // Back where it was, paused; the page the user is on stays.
      if (reopen && !this.kernel.state.studio.project && !this.kernel.busy)
        await this.studio.open(reopen, { reason: "restored", autoplay: false });
      return;
    }
    this.kernel.toast(
      `《${failed[0].title}》${failed.length > 1 ? ` 等 ${failed.length} 首` : ""}没能放回「我的作品」：${errorText(reason, WRITE_FAILED)}`,
      "error",
    );
  }

  /** The undo window closed: now the record is really deleted. */
  private async finishRemoval(id: string): Promise<void> {
    const pending = this.removals.get(id);
    if (!pending) return;
    this.kernel.deps.timers.clear(pending.timer);
    this.removals.delete(id);
    if (this.unloaded?.id === id) this.unloaded = null;
    this.showUndo();
    try {
      await this.kernel.remove(id);
      this.kernel.settleRemoval(id);
      // nothing is kept for a work that no longer exists
      this.studio.forget(id);
      this.kernel.writeSession();
      this.kernel.dispatch({ type: "library/removed", id });
      void this.kernel.refreshStorage();
    } catch (error) {
      this.kernel.settleRemoval(id);
      this.kernel.writeSession();
      this.kernel.dispatch({ type: "library/restore", id });
      this.kernel.toast(
        `删除失败，作品仍在「我的作品」中：${errorText(error, WRITE_FAILED)}`,
        "error",
      );
    }
  }

  readonly importFile: AppActions["importFile"] = async (file) => {
    if (this.kernel.busy) {
      this.kernel.toast(BUSY);
      return false;
    }
    let project: Project;
    try {
      if (!file || !(file.size <= MAX_IMPORT_BYTES))
        throw new Error(
          "工程文件过大，请选择小于 1 MB 的 Muse 工程 JSON 文件。",
        );
      project = this.kernel.deps.storage.importProject(await file.text());
      await this.kernel.store(project);
    } catch (error) {
      this.kernel.toast(
        errorText(error, "无法导入这个文件，请选择由音序导出的工程 JSON。"),
        "error",
      );
      return false;
    }
    this.kernel.dispatch({ type: "library/upsert", project });
    this.kernel.afterSave();
    this.kernel.toast(`已导入《${project.title}》`);
    await this.studio.open(project.id, { reason: "opened", autoplay: false });
    return true;
  };

  readonly exportDamaged: AppActions["exportDamaged"] = async (id) => {
    const record = this.kernel.state.library.damaged.find(
      (item) => item.id === id,
    );
    if (!record) return false;
    try {
      const raw = await this.kernel.deps.storage.readRawRecord(id);
      if (raw === null) throw new Error("这条记录已经不存在了。");
      const result = await this.kernel.deps.exporter.saveFile({
        name: `${record.title}-原始数据`,
        data: new TextEncoder().encode(raw).buffer as ArrayBuffer,
        format: "json",
      });
      if (result.saved)
        this.kernel.toast(
          record.audio
            ? "已导出这条记录的原始数据。其中不含音频，请再导出原始音频。"
            : "已导出这条记录的原始数据",
        );
      return result.saved;
    } catch (error) {
      this.kernel.toast(errorText(error, "导出失败，请重试。"), "error");
      return false;
    }
  };

  readonly exportDamagedAudio: AppActions["exportDamagedAudio"] = async (
    id,
  ) => {
    const record = this.kernel.state.library.damaged.find(
      (item) => item.id === id,
    );
    if (!record) return false;
    try {
      const blob = await this.kernel.deps.storage.readRawAudio(id);
      if (!blob) throw new Error("这条记录里没有音频。");
      const data = await blob.arrayBuffer();
      // The record cannot be trusted: go by the type, then by the bytes.
      const known = originalFormat(blob.type) ?? sniffAudioFormat(data);
      const result = await this.kernel.deps.exporter.saveFile({
        name: `${record.title}-原始音频${known ? "" : "-未知格式"}`,
        data,
        format: known ?? "mp3",
      });
      if (result.saved)
        this.kernel.toast(
          known
            ? "已导出这条记录的原始音频"
            : "已导出这条记录的原始音频。格式无法识别，暂按 MP3 命名，内容未作改动。",
        );
      return result.saved;
    } catch (error) {
      this.kernel.toast(errorText(error, "导出失败，请重试。"), "error");
      return false;
    }
  };

  readonly removeDamaged: AppActions["removeDamaged"] = async (id) => {
    if (!this.kernel.state.library.damaged.some((item) => item.id === id))
      return false;
    try {
      await this.kernel.remove(id);
    } catch (error) {
      this.kernel.toast(`删除失败：${errorText(error, WRITE_FAILED)}`, "error");
      return false;
    }
    this.kernel.dispatch({ type: "library/damagedRemoved", id });
    this.kernel.toast("已删除这条无法读取的记录");
    void this.kernel.refreshStorage();
    return true;
  };

  /* ---------------- other tabs ---------------- */

  /** Another tab stored, changed or really deleted a work. */
  readonly onSync = (message: SyncMessage): void => {
    if (message.type === "deleted") {
      this.dropped(message.id);
      return;
    }
    void this.kernel.deps.storage.readProject(message.id).then(
      (stored) => {
        if (stored) this.studio.absorb(stored);
      },
      () => {},
    );
  };

  /** The record is gone for good, whoever deleted it. */
  private dropped(id: string): void {
    const pending = this.removals.get(id);
    if (pending) {
      // It was waiting for undo here as well: there is nothing left to undo.
      this.kernel.deps.timers.clear(pending.timer);
      this.removals.delete(id);
      this.kernel.settleRemoval(id);
      this.kernel.writeSession();
    }
    if (this.unloaded?.id === id) this.unloaded = null;
    this.studio.gone(id);
    this.kernel.dispatch({ type: "library/damagedRemoved", id });
    if (pending) this.showUndo();
  }

  /**
   * Rename / favourite: optimistic, rolled back when the write fails. Only
   * the changed field is written, merged into the stored record, so what
   * another tab changed meanwhile (the other field, the faders) survives —
   * and comes back with the answer.
   */
  private async patchAndSave(
    id: string,
    patch: Pick<ProjectPatch, "title" | "favorite">,
    what: string,
  ): Promise<boolean> {
    const before = this.kernel.find(id);
    if (!before) return false;
    const fields = Object.keys(patch) as ("title" | "favorite")[];
    const rollback: Partial<Project> = {};
    for (const key of fields) Object.assign(rollback, { [key]: before[key] });
    this.kernel.dispatch({ type: "project/patch", id, patch });
    const next = this.kernel.find(id);
    if (!next) return false;
    const { studio } = this.kernel.state;
    // Only the loaded work can be one that never reached the library.
    const stored = studio.project?.id === id ? studio.stored : true;
    this.kernel.hold(id, fields);
    try {
      if (stored) {
        const merged = await this.kernel.patch(id, patch);
        if (!merged) {
          this.dropped(id);
          return false;
        }
        this.studio.absorb(merged, fields);
      } else {
        // The work had never reached the library (an earlier save failed):
        // it goes there whole, new name included.
        await this.kernel.store(next);
        this.studio.landed(id, next);
      }
    } catch (error) {
      this.kernel.dispatch({ type: "project/patch", id, patch: rollback });
      this.kernel.toast(
        `${what}没有保存：${errorText(error, WRITE_FAILED)}`,
        "error",
      );
      return false;
    } finally {
      this.kernel.release(id, fields);
    }
    return true;
  }
}
